'use strict';

/**
 * Prove the ASAR writer is lossless on a real archive.
 *
 * Reads an archive and writes it back with the original payloads. A
 * byte-identical result proves the writer reproduces asar's header
 * serialization, offset layout, padding, deduplication and integrity scheme.
 * If this fails, the patcher must not be trusted with a real install.
 *
 *   node tests/integration/roundtrip.js <app.asar> [out.asar]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const asar = require('../../src/js/asar');

const source = process.argv[2];
if (!source) {
  console.error('usage: node tests/integration/roundtrip.js <app.asar> [out.asar]');
  process.exit(2);
}

const out = process.argv[3] || path.join(os.tmpdir(), `asar-roundtrip-${process.pid}.asar`);
const arc = asar.readAsar(source);

console.log('source      :', source);
console.log('size        :', fs.statSync(source).size);
console.log('dataStart   :', arc.dataStart);
console.log('header JSON :', arc.jsonActualLen, 'bytes (padded', arc.jsonPaddedLen + ')');
console.log('entries     :', asar.flatten(arc.header).length);

asar.writeAsar(out, JSON.parse(JSON.stringify(arc.header)), (p, node) => asar.entryBytes(arc, node));

const before = fs.readFileSync(source);
const after = fs.readFileSync(out);

console.log('\noriginal sha256:', asar.sha256(before));
console.log('rebuilt  sha256:', asar.sha256(after));

let exitCode = 0;
if (before.length !== after.length) {
  console.log(`\nFAIL: length differs (${before.length} vs ${after.length})`);
  exitCode = 1;
} else {
  let firstDiff = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) {
    console.log('\nPASS: byte-identical round-trip');
  } else {
    console.log(`\nFAIL: first difference at offset ${firstDiff}`);
    console.log('  original:', before.subarray(Math.max(0, firstDiff - 16), firstDiff + 48).toString('hex'));
    console.log('  rebuilt :', after.subarray(Math.max(0, firstDiff - 16), firstDiff + 48).toString('hex'));
    exitCode = 1;
  }
}

if (!process.argv[3]) fs.rmSync(out, { force: true });
process.exit(exitCode);
