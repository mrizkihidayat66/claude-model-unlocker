'use strict';

/**
 * End-to-end flow on a synthetic archive: analyse -> apply -> verify -> refuse.
 *
 * These tests need no Claude Desktop install, so they run in CI and on any
 * machine. The live install is covered by tests/verify.ps1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const asar = require('../../src/js/asar');
const patcher = require('../../src/js/patch-archive');
const spec = require('../../src/js/patch-spec');
const synthetic = require('../helpers/synthetic-archive');

const PRE = '.vite/build/index.pre.js';
const CHUNK = '.vite/build/index.chunk-B4M-ub9T.js';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlocker-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'app.asar');
  synthetic.writeArchive(source);
  return { dir, source };
}

test('a synthetic pristine archive is applicable', (t) => {
  const { source } = workspace(t);
  const analysis = patcher.analyse(source);

  assert.equal(analysis.status, 'applicable');
  assert.equal(analysis.counts.pending, spec.rules.length);
  assert.equal(analysis.rules.every((r) => r.state === 'pending'), true);
});

test('apply produces a patched, idempotent archive', (t) => {
  const { dir, source } = workspace(t);
  const patched = path.join(dir, 'patched.asar');

  const result = patcher.apply(source, patched);
  assert.equal(result.changed, true);
  assert.equal(result.status, 'patched');

  // 5 sites: rule 1 x2, rule 2 x1, rule 3 x1, rule 4 x1
  const substitutions = result.modifications.reduce((sum, m) => sum + m.replacements, 0);
  assert.equal(substitutions, 5);
  assert.equal(new Set(result.modifications.map((m) => m.file)).size, 2);

  assert.equal(patcher.analyse(patched).status, 'patched');
  assert.equal(patcher.apply(patched, path.join(dir, 'again.asar')).changed, false);
});

test('apply leaves the source archive untouched', (t) => {
  const { dir, source } = workspace(t);
  const before = asar.sha256(fs.readFileSync(source));

  patcher.apply(source, path.join(dir, 'patched.asar'));

  assert.equal(asar.sha256(fs.readFileSync(source)), before);
});

test('only the two bundles differ, and only in the intended ways', (t) => {
  const { dir, source } = workspace(t);
  const patched = path.join(dir, 'patched.asar');
  patcher.apply(source, patched);

  const before = asar.readAsar(source);
  const after = asar.readAsar(patched);
  const afterByPath = new Map(asar.flatten(after.header).map((e) => [e.path, e]));

  const changed = [];
  for (const entry of asar.flatten(before.header)) {
    if (entry.node.unpacked || entry.path.startsWith('compile-cache/')) continue;
    const next = afterByPath.get(entry.path);
    assert.ok(next, `${entry.path} must survive`);
    if (!asar.entryBytes(before, entry.node).equals(asar.entryBytes(after, next.node))) {
      changed.push(entry.path);
    }
  }
  assert.deepEqual(changed.sort(), [CHUNK, PRE].sort());

  const pre = synthetic.entryText(patched, PRE);
  const chunk = synthetic.entryText(patched, CHUNK);

  // Gateway branch relaxed, other providers intact.
  assert.match(pre, /case"gateway":case"mantle":return\{ok:!0\}/);
  assert.match(chunk, /case"gateway":case"mantle":return\{ok:!0\}/);
  for (const provider of ['anthropic', 'bedrock', 'vertex', 'foundry']) {
    assert.match(pre, new RegExp(`case"${provider}":return Yt|Wt|Vt|Kt\\(e\\)`));
    assert.match(chunk, new RegExp(`case"${provider}":return Yt|Wt|Vt|Kt\\(e\\)`));
  }

  // Discovery filter keeps only the "id present" guard.
  assert.match(chunk, /return!r\.id\?\[\]:\[/);
  assert.doesNotMatch(chunk, /Qt\(r\.id\)/);

  // Context size reads the gateway's real field names.
  assert.match(
    chunk,
    /Zt\(r\.supports_1m,r\.max_input_tokens\?\?r\.context_length\?\?r\.max_model_len\)/
  );

  // Sanitizer keeps SSLKEYLOGFILE cleanup, preserves the profile variable and
  // adds the auth-profile fallback.
  assert.doesNotMatch(pre, /delete e\.CLAUDE_USER_DATA_DIR/);
  assert.match(pre, /delete e\.SSLKEYLOGFILE,delete e\.sslkeylogfile/);
  assert.match(pre, /auth-profile\.txt/);
});

test('stale compile-cache entries are dropped', (t) => {
  const { dir, source } = workspace(t);
  const patched = path.join(dir, 'patched.asar');
  const result = patcher.apply(source, patched);

  assert.equal(result.droppedCache.length, 3);
  const remaining = asar.flatten(asar.readAsar(patched).header).map((e) => e.path);
  assert.equal(remaining.some((p) => p.startsWith('compile-cache/')), false);
});

test('a changed upstream build is reported incompatible and never written', (t) => {
  const { dir, source } = workspace(t);
  const future = path.join(dir, 'future.asar');
  synthetic.writeArchive(future, {
    [PRE]: synthetic.PRE_JS.replace(
      'case"gateway":case"mantle":return qt(e)',
      'case"gateway":case"mantle":return validateGatewayModel(e,t)'
    ),
  });

  const analysis = patcher.analyse(future);
  assert.equal(analysis.status, 'incompatible');
  assert.ok(analysis.rules.find((r) => r.id === 'gateway-validator-relaxed').state === 'incompatible');

  const out = path.join(dir, 'never.asar');
  assert.throws(() => patcher.apply(future, out), /not in a safely patchable state/);
  assert.equal(fs.existsSync(out), false);
});

test('a partially patched archive is reported partial', (t) => {
  const { dir, source } = workspace(t);
  const patched = path.join(dir, 'patched.asar');
  patcher.apply(source, patched);

  // Revert one rule by hand: probe present for three rules, pattern for one.
  const arc = asar.readAsar(patched);
  const mixed = path.join(dir, 'mixed.asar');
  asar.writeAsar(mixed, JSON.parse(JSON.stringify(arc.header)), (p, node) =>
    p === PRE ? synthetic.PRE_JS : asar.entryBytes(arc, node)
  );

  assert.equal(patcher.analyse(mixed).status, 'partial');
});

test('the CLI emits one JSON object per command', (t) => {
  const { dir, source } = workspace(t);
  const cli = path.join(__dirname, '..', '..', 'src', 'js', 'cli.js');

  const analyse = JSON.parse(execFileSync(process.execPath, [cli, 'analyse', source], { encoding: 'utf8' }));
  assert.equal(analyse.ok, true);
  assert.equal(analyse.status, 'applicable');
  assert.equal(analyse.specVersion, spec.SPEC_VERSION);
  assert.equal(analyse.rules.length, spec.rules.length);

  const patched = path.join(dir, 'cli-patched.asar');
  const patch = JSON.parse(execFileSync(process.execPath, [cli, 'patch', source, patched], { encoding: 'utf8' }));
  assert.equal(patch.ok, true);
  assert.equal(patch.changed, true);

  const version = JSON.parse(execFileSync(process.execPath, [cli, 'version'], { encoding: 'utf8' }));
  assert.equal(version.ok, true);
  assert.deepEqual(version.rules, spec.rules.map((r) => r.id));
});

test('the CLI fails with JSON and a non-zero exit on a bad archive', () => {
  const cli = path.join(__dirname, '..', '..', 'src', 'js', 'cli.js');
  const missing = path.join(os.tmpdir(), 'definitely-not-an-archive.asar');

  let stdout = '';
  try {
    execFileSync(process.execPath, [cli, 'analyse', missing], { encoding: 'utf8' });
  } catch (err) {
    assert.notEqual(err.status, 0);
    stdout = err.stdout;
  }
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /ENOENT|no such file/i);
});
