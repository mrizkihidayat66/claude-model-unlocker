'use strict';

/**
 * Static verification suite for the model unlock.
 *
 * Everything here is derived from the archive and the patch spec, so it works
 * against any Claude Desktop version. Nothing is hardcoded to a build number,
 * a chunk file name, or an expected digest.
 *
 *   node tests/integration/verify.js <source-app.asar>
 *        [--portable-asar <path>] [--portable-exe <path>] [--installed-asar <path>]
 *
 * <source-app.asar> is the pristine archive to test against: normally the one
 * inside the installed MSIX package. `tests/verify.ps1` resolves it for you.
 *
 * Exit code 0 only when every check passes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const asar = require('../../src/js/asar');
const patcher = require('../../src/js/patch-archive');
const spec = require('../../src/js/patch-spec');
const pe = require('../../src/js/pe-integrity');
const { createReport, parseArgs } = require('../lib/report');

const args = parseArgs(process.argv.slice(2));
const sourceAsar = args._[0];

if (!sourceAsar) {
  console.error('usage: node tests/integration/verify.js <source-app.asar> [options]');
  process.exit(2);
}
if (!fs.existsSync(sourceAsar)) {
  console.error(`source archive not found: ${sourceAsar}`);
  process.exit(2);
}

const report = createReport('Claude Desktop model unlock - static verification');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlocker-verify-'));
const cleanup = [];

function tempPath(name) {
  const p = path.join(workDir, name);
  cleanup.push(p);
  return p;
}

function entryText(arc, entryPath) {
  const entry = asar.flatten(arc.header).find((e) => e.path === entryPath);
  if (!entry) throw new Error(`no entry ${entryPath}`);
  return asar.entryBytes(arc, entry.node).toString('utf8');
}

/** Every archive entry whose bytes differ between two archives. */
function changedEntries(before, after) {
  const afterByPath = new Map(asar.flatten(after.header).map((e) => [e.path, e]));
  const changed = [];
  for (const entry of asar.flatten(before.header)) {
    const next = afterByPath.get(entry.path);
    if (!next) continue; // removed
    if (entry.node.unpacked) continue;
    if (!asar.entryBytes(before, entry.node).equals(asar.entryBytes(after, next.node))) {
      changed.push(entry.path);
    }
  }
  return changed;
}

let exitCode = 1;
try {
  const sourceSha = asar.sha256(fs.readFileSync(sourceAsar));
  const source = asar.readAsar(sourceAsar);
  const expectedSubstitutions = spec.rules.reduce((sum, r) => sum + r.expectTotal, 0);

  // ---------------------------------------------------------------- 1
  report.section('1. The source archive is intact and analysable');
  report.check('source archive parses', source.header && typeof source.header === 'object');
  const initial = patcher.analyse(sourceAsar);
  report.check(
    'source is applicable or already patched',
    initial.status === 'applicable' || initial.status === 'patched',
    initial.status
  );
  for (const rule of initial.rules) {
    if (rule.state === 'incompatible') {
      report.fail(`rule ${rule.id} does not match this build`, `found ${rule.found}, expected ${rule.expected}`);
    }
  }

  // ---------------------------------------------------------------- 2
  report.section('2. The ASAR writer is lossless');
  const roundtrip = tempPath('roundtrip.asar');
  asar.writeAsar(roundtrip, JSON.parse(JSON.stringify(source.header)), (p, node) =>
    asar.entryBytes(source, node)
  );
  report.check(
    'round-trip is byte-identical',
    asar.sha256(fs.readFileSync(roundtrip)) === sourceSha,
    asar.sha256(fs.readFileSync(roundtrip))
  );
  report.check(
    'entry count survives the round-trip',
    asar.flatten(asar.readAsar(roundtrip).header).length === asar.flatten(source.header).length
  );

  // ---------------------------------------------------------------- 3
  report.section('3. The patch applies only the intended edits');
  const pristine = initial.status === 'patched' ? roundtrip : sourceAsar;
  const patchedPath = tempPath('patched.asar');
  const result = patcher.apply(pristine, patchedPath);

  const touchedFiles = [...new Set(result.modifications.map((m) => m.file))].sort();
  report.check(
    `exactly ${expectedSubstitutions} substitutions`,
    result.modifications.reduce((sum, m) => sum + m.replacements, 0) === expectedSubstitutions,
    String(result.modifications.reduce((sum, m) => sum + m.replacements, 0))
  );
  report.check(
    'substitutions land in the files the rules matched',
    touchedFiles.length === new Set(initial.rules.flatMap((r) => r.locations.map((l) => l.path))).size
  );

  const cacheEntries = asar
    .flatten(source.header)
    .filter((e) => e.path.startsWith(spec.STALE_CACHE_DIR) && e.path.endsWith('.jsc'));
  report.check(
    'stale compile-cache entries are dropped',
    result.droppedCache.length === cacheEntries.length,
    `${result.droppedCache.length}/${cacheEntries.length}`
  );

  // ---------------------------------------------------------------- 4
  report.section('4. Only the matched bundles changed');
  const patchedArc = asar.readAsar(patchedPath);
  const changed = changedEntries(source, patchedArc);
  report.check(
    'no unexpected file differs',
    changed.length === touchedFiles.length && changed.every((p) => touchedFiles.includes(p)),
    changed.join(', ')
  );

  // ---------------------------------------------------------------- 5
  report.section('5. Providers outside the gateway branch are untouched');
  for (const file of touchedFiles) {
    const text = entryText(patchedArc, file);
    for (const provider of ['anthropic', 'bedrock', 'vertex', 'foundry']) {
      report.check(
        `"${provider}" keeps its own validator in ${path.basename(file)}`,
        new RegExp(`case"${provider}":return\\s*[A-Za-z0-9_$]+\\(\\s*[A-Za-z0-9_$]+\\s*\\)`).test(text)
      );
    }
    report.check(
      `gateway branch is relaxed in ${path.basename(file)}`,
      /case"gateway":case"mantle":return\{ok:!0\}/.test(text)
    );
  }

  // ---------------------------------------------------------------- 6
  report.section('6. Every rule has its patched form in place');
  for (const rule of spec.rules) {
    const probeHits = touchedFiles.reduce(
      (sum, file) => sum + (entryText(patchedArc, file).match(rule.probe) || []).length,
      0
    );
    report.check(`${rule.id} applied`, probeHits === rule.expectTotal, `${probeHits}/${rule.expectTotal}`);
  }
  const preText = touchedFiles
    .map((f) => entryText(patchedArc, f))
    .join('\n');
  report.check(
    'CLAUDE_USER_DATA_DIR is no longer deleted',
    !/delete\s+[A-Za-z0-9_$]+\.CLAUDE_USER_DATA_DIR/.test(preText)
  );
  report.check(
    'SSLKEYLOGFILE is still deleted',
    /delete\s+[A-Za-z0-9_$]+\.SSLKEYLOGFILE,delete\s+[A-Za-z0-9_$]+\.sslkeylogfile/.test(preText)
  );
  report.check('protocol launches can recover the active profile', /auth-profile\.txt/.test(preText));

  // ---------------------------------------------------------------- 7
  report.section('7. Re-analysis and idempotency');
  report.check('patched archive is detected as patched', patcher.analyse(patchedPath).status === 'patched');
  const second = patcher.apply(patchedPath, tempPath('patched-twice.asar'));
  report.check('a second apply is a no-op', second.changed === false);

  // ---------------------------------------------------------------- 8
  report.section('8. A changed upstream build fails safely');
  const mutatedPath = tempPath('future.asar');
  {
    const mutable = JSON.parse(JSON.stringify(source.header));
    const target = asar
      .flatten(mutable)
      .find((e) => /case"gateway":case"mantle":return\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*\)/.test(entryText(source, e.path)));
    if (!target) {
      report.skip('future-release simulation', 'no gateway branch in this build to mutate');
    } else {
      const mutated = entryText(source, target.path).replace(
        /case"gateway":case"mantle":return\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*\)/,
        'case"gateway":case"mantle":return validateGatewayModel(t,e)'
      );
      asar.writeAsar(mutatedPath, mutable, (p, node) =>
        p === target.path ? mutated : asar.entryBytes(source, node)
      );
      report.check('mutated build is reported incompatible', patcher.analyse(mutatedPath).status === 'incompatible');
      let refused = false;
      try {
        patcher.apply(mutatedPath, tempPath('future-out.asar'));
      } catch {
        refused = true;
      }
      report.check('apply() refuses to write it', refused);
    }
  }

  // ---------------------------------------------------------------- 9
  report.section('9. The deployed portable build is consistent');
  const portableAsar = args['portable-asar'];
  const portableExe = args['portable-exe'];
  if (portableAsar && portableExe && fs.existsSync(portableAsar) && fs.existsSync(portableExe)) {
    const actual = asar.headerHash(portableAsar);
    const table = pe.readIntegrity(portableExe).table;
    const entry = table.find((t) => pe.matchesArchive(t.file, 'resources/app.asar'));
    report.check(
      'asar digest matches the one embedded in claude.exe',
      Boolean(entry) && entry.value === actual,
      entry ? `${entry.value} vs ${actual}` : 'no integrity entry'
    );
    report.check(
      'portable archive is patched',
      patcher.analyse(portableAsar).status === 'patched'
    );
  } else {
    report.skip('portable build consistency', 'no portable copy (run scripts/patch.ps1 first)');
  }

  // ---------------------------------------------------------------- 10
  report.section('10. The installed package was not modified');
  const installedAsar = args['installed-asar'];
  if (installedAsar) {
    if (fs.existsSync(installedAsar)) {
      report.check(
        'installed app.asar bytes are unchanged',
        asar.sha256(fs.readFileSync(installedAsar)) === sourceSha
      );
    } else {
      report.skip('installed package check', 'installed app.asar not readable');
    }
  } else {
    report.skip('installed package check', '--installed-asar not given');
  }

  exitCode = report.finish();
} catch (err) {
  console.error('\nverification aborted:', err.message);
  console.error(err.stack);
  exitCode = 1;
} finally {
  for (const p of cleanup) fs.rmSync(p, { force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
