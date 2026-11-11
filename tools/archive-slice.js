'use strict';

/**
 * Print a byte range of one file inside an ASAR archive.
 *
 *   node tools/archive-slice.js <app.asar> <entry-suffix> <start> <end>
 *
 * <entry-suffix> is matched with endsWith, so the hashed chunk file name can be
 * given as a stable suffix such as "index.pre.js".
 */

const asar = require('../src/js/asar');

const [archivePath, suffix, start, end] = process.argv.slice(2);

if (!archivePath || !suffix || start === undefined) {
  console.error('usage: node tools/archive-slice.js <app.asar> <entry-suffix> <start> <end>');
  process.exit(2);
}

const arc = asar.readAsar(archivePath);
const entry = asar.flatten(arc.header).find((e) => e.path.endsWith(suffix));

if (!entry) {
  console.error(`no archive entry ends with "${suffix}"`);
  process.exit(1);
}

const text = asar.entryBytes(arc, entry.node).toString('utf8');
console.log('file:', entry.path, `(${text.length} chars)`);
console.log(text.slice(Number(start), end === undefined ? undefined : Number(end)));
