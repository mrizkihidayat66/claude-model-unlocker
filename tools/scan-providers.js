'use strict';

/**
 * List the provider option values declared in an extracted Claude Desktop tree.
 *
 * Confirms which provider branches exist before a rule is written against them
 * (the gateway branches are `gateway` and `mantle` today, but that can change).
 *
 *   node tools/scan-providers.js <extracted-app-dir>
 */

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/scan-providers.js <extracted-app-dir>');
  process.exit(2);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const bundles = walk(root, []).filter((file) => /[\\/]\.vite[\\/]build[\\/]/.test(file));
const seen = new Set();

for (const file of bundles) {
  const text = fs.readFileSync(file, 'utf8');
  const pattern = /provider:N\("([a-z]+)"\)/g;
  const found = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  if (found.size) {
    console.log(`${path.basename(file)} -> ${[...found].join(', ')}`);
    for (const value of found) seen.add(value);
  }
}

console.log(`\nprovider values: ${[...seen].sort().join(', ') || '(none found)'}`);
