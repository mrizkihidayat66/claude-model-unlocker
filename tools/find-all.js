'use strict';

/**
 * Dump every occurrence of a term across the JavaScript entries of an archive,
 * with configurable context and a hard cap on output.
 *
 *   node tools/find-all.js <app.asar> <term> [--before 600] [--after 900] [--max 200]
 *
 * Unlike tools/archive-search.js this walks every entry without a path filter
 * and prints the widest context, which is useful while reverse-engineering a
 * new build.
 */

const asar = require('../src/js/asar');
const { parseArgs } = require('../tests/lib/report');

const args = parseArgs(process.argv.slice(2));
const [archivePath, term] = args._;

if (!archivePath || !term) {
  console.error('usage: node tools/find-all.js <app.asar> <term> [--before n] [--after n] [--max n]');
  process.exit(2);
}

const before = Number(args.before ?? 600);
const after = Number(args.after ?? 900);
const max = Number(args.max ?? 200);

const arc = asar.readAsar(archivePath);
let shown = 0;

for (const entry of asar.flatten(arc.header)) {
  if (!/\.(js|mjs|cjs)$/.test(entry.path) || entry.node.unpacked) continue;
  const text = asar.entryBytes(arc, entry.node).toString('utf8');

  let index = text.indexOf(term);
  while (index !== -1 && shown < max) {
    shown += 1;
    console.log(`\n===== [${entry.path} @${index}] =====`);
    console.log(text.slice(Math.max(0, index - before), index + term.length + after));
    index = text.indexOf(term, index + term.length);
  }
  if (shown >= max) break;
}

console.log(`\nTOTAL shown: ${shown} (cap ${max})`);
