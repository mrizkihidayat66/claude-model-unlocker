'use strict';

/**
 * Search a JavaScript file inside an ASAR archive, with context.
 *
 * Use this when a patch rule stops matching after a Claude Desktop update and
 * you need to see what the minified code looks like now.
 *
 *   node tools/archive-search.js <app.asar> <term> [--before 600] [--after 900]
 *                                          [--max 40] [--entry <path>] [--literal]
 *
 * --entry   restrict to entries whose path contains this substring
 * --literal treat the term as a plain string instead of a regular expression
 * --json    emit matches as JSON
 */

const asar = require('../src/js/asar');
const { parseArgs } = require('../tests/lib/report');

const args = parseArgs(process.argv.slice(2));
const [archivePath, term] = args._;

if (!archivePath || !term) {
  console.error('usage: node tools/archive-search.js <app.asar> <term> [options]');
  process.exit(2);
}

const before = Number(args.before ?? 600);
const after = Number(args.after ?? 900);
const max = Number(args.max ?? 40);
const entryFilter = args.entry;
const pattern = args.literal ? null : new RegExp(term, 'g');

const arc = asar.readAsar(archivePath);
const entries = asar.flatten(arc.header).filter(
  (e) => /\.(js|mjs|cjs)$/.test(e.path) && !e.node.unpacked && (!entryFilter || e.path.includes(entryFilter))
);

const matches = [];
for (const entry of entries) {
  const text = asar.entryBytes(arc, entry.node).toString('utf8');

  if (pattern) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null && matches.length < max) {
      matches.push({ path: entry.path, index: match.index, snippet: snippet(text, match.index, match[0].length) });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  } else {
    let index = text.indexOf(term);
    while (index !== -1 && matches.length < max) {
      matches.push({ path: entry.path, index, snippet: snippet(text, index, term.length) });
      index = text.indexOf(term, index + term.length);
    }
  }
  if (matches.length >= max) break;
}

function snippet(text, index, length) {
  const start = Math.max(0, index - before);
  return text.slice(start, index + length + after);
}

if (args.json) {
  process.stdout.write(JSON.stringify({ archivePath, term, matches }, null, 2));
} else {
  for (const match of matches) {
    console.log(`\n===== [${match.path} @${match.index}] =====`);
    console.log(match.snippet);
  }
  console.log(`\n${matches.length} match(es)${matches.length >= max ? ` (capped at ${max})` : ''}`);
}
