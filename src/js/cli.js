'use strict';

/**
 * JSON bridge between the PowerShell scripts and the patch engine.
 *
 * Every subcommand prints exactly one JSON object on stdout and uses a
 * non-zero exit code on failure, so PowerShell can consume it with
 * ConvertFrom-Json. Diagnostics go to stderr only.
 *
 *   cli.js analyse          <asar>                     -> { ok, status, rules, counts }
 *   cli.js patch            <asar> <out>               -> { ok, changed, modifications, ... }
 *   cli.js verify           <asar> <exe> [rel]         -> { ok, consistent, expected, actual }
 *   cli.js integrity        <exe>                      -> { ok, table }
 *   cli.js update-integrity <exe> <asar> [rel]         -> { ok, changed, changes }
 *   cli.js hash             <asar>                     -> { ok, headerHash }
 *   cli.js version                                     -> { ok, specVersion }
 */

const fs = require('fs');

const asar = require('./asar');
const patcher = require('./patch-archive');
const pe = require('./pe-integrity');
const spec = require('./patch-spec');

const DEFAULT_ARCHIVE_ENTRY = 'resources/app.asar';

const USAGE = [
  'usage: node src/js/cli.js <command> [args]',
  '',
  '  analyse          <asar>',
  '  patch            <asar> <out>',
  '  verify           <asar> <exe> [archiveEntry]',
  '  integrity        <exe>',
  '  update-integrity <exe> <asar> [archiveEntry]',
  '  hash             <asar>',
  '  version',
].join('\n');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2));
}

function fail(message, detail) {
  emit({ ok: false, error: message, detail: detail || null });
  process.exit(1);
}

/** Read the digest Electron will compute for `asarPath` and the one in `exePath`. */
function digestState(asarPath, exePath, archiveEntry) {
  const actual = asar.headerHash(asarPath);
  const table = pe.readIntegrity(exePath).table;
  const entry = table.find((t) => pe.matchesArchive(t.file, archiveEntry));
  return { actual, expected: entry ? entry.value : null, table };
}

const commands = {
  analyse(asarPath) {
    const analysis = patcher.analyse(asarPath);
    return {
      ok: true,
      specVersion: spec.SPEC_VERSION,
      status: analysis.status,
      counts: analysis.counts,
      rules: analysis.rules,
    };
  },

  patch(asarPath, outPath) {
    const result = patcher.apply(asarPath, outPath);
    return {
      ok: true,
      changed: result.changed,
      status: result.status,
      modifications: result.modifications,
      droppedCache: result.droppedCache,
      built: result.built || null,
      outPath: result.outPath,
    };
  },

  verify(asarPath, exePath, archiveEntry = DEFAULT_ARCHIVE_ENTRY) {
    const { actual, expected, table } = digestState(asarPath, exePath, archiveEntry);
    return {
      ok: true,
      consistent: expected === actual,
      expected,
      actual,
      table,
      archiveSize: fs.statSync(asarPath).size,
      archiveSha256: asar.sha256(fs.readFileSync(asarPath)),
    };
  },

  integrity(exePath) {
    return { ok: true, table: pe.readIntegrity(exePath).table };
  },

  'update-integrity'(exePath, asarPath, archiveEntry = DEFAULT_ARCHIVE_ENTRY) {
    const headerHash = asar.headerHash(asarPath);
    const result = pe.updateIntegrity(exePath, [{ file: archiveEntry, value: headerHash }]);
    return { ok: true, changed: result.changed, changes: result.changes, headerHash };
  },

  hash(asarPath) {
    return { ok: true, headerHash: asar.headerHash(asarPath) };
  },

  version() {
    return { ok: true, specVersion: spec.SPEC_VERSION, rules: spec.rules.map((r) => r.id) };
  },
};

function main(argv) {
  const [command, ...args] = argv;

  if (!command || !Object.prototype.hasOwnProperty.call(commands, command)) {
    process.stderr.write(USAGE + '\n');
    process.exit(2);
  }

  try {
    emit(commands[command](...args));
  } catch (err) {
    fail(err.message, err.stack || null);
  }
}

main(process.argv.slice(2));
