'use strict';

/**
 * Scan an extracted Claude Desktop tree for the patch anchors.
 *
 * This is how the structural patterns in src/js/patch-spec.js were discovered:
 * it shows every place a pattern occurs, so a rule can be written against code
 * shape rather than a file name (file names are hashed and change per release).
 *
 *   node tools/scan-anchors.js <extracted-app-dir>
 *
 * Extract first, for example:
 *   npx @electron/asar extract app.asar extracted
 */

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/scan-anchors.js <extracted-app-dir>');
  process.exit(2);
}

const PATTERNS = {
  'discovery filter': /return!([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.id\)&&!([A-Za-z0-9_$]+)\?\[\]:\[/g,
  'gateway/mantle branch': /case"gateway":case"mantle":return\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*\)/g,
  'env sanitizer': /delete\s+[A-Za-z0-9_$]+\.CLAUDE_USER_DATA_DIR/g,
  'context size read': /\([A-Za-z0-9_$]+\.supports_1m,[A-Za-z0-9_$]+\.max_input_tokens\)/g,
  '1m group key': /function\s*[A-Za-z0-9_$]+\s*\(\s*e\s*\)\s*\{\s*return\s*[A-Za-z0-9_$]+\(\s*e\.id\s*\)\s*&&\s*!e\.id\.endsWith\(\s*"\[1m\]"\s*\)\s*\?/g,
};

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(root, []);
console.log(`scanning ${files.length} JS files under ${root}\n`);

for (const [name, pattern] of Object.entries(PATTERNS)) {
  let total = 0;
  console.log(`=== ${name}`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    pattern.lastIndex = 0;
    const found = text.match(pattern);
    if (!found) continue;
    total += found.length;
    for (const hit of found) {
      console.log(`   ${path.relative(root, file)}`);
      console.log(`      ${hit}`);
    }
  }
  console.log(`   TOTAL: ${total}\n`);
}
