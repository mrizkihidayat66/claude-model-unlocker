'use strict';

/**
 * Unit tests for the ASAR reader/writer. These build a synthetic archive, so
 * they run anywhere and do not need Claude Desktop installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const asar = require('../../src/js/asar');

/** Write a minimal archive and return its path. */
function buildArchive(dir, files) {
  const header = { files: {} };
  for (const [name, contents] of Object.entries(files)) {
    const [first, ...rest] = name.split('/');
    let node = header.files;
    if (rest.length === 0) {
      node[first] = { size: Buffer.byteLength(contents), offset: '0' };
      continue;
    }
    node[first] = node[first] || { files: {} };
    let cursor = node[first].files;
    for (let i = 0; i < rest.length - 1; i++) {
      cursor[rest[i]] = cursor[rest[i]] || { files: {} };
      cursor = cursor[rest[i]].files;
    }
    cursor[rest[rest.length - 1]] = { size: Buffer.byteLength(contents), offset: '0' };
  }

  const out = path.join(dir, 'built.asar');
  asar.writeAsar(out, header, (p) => files[p]);
  return out;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asar-test-'));
}

test('round-trip is byte-identical', () => {
  const dir = tempDir();
  try {
    const files = {
      'a.js': 'const a = 1;\n',
      'nested/b.js': 'module.exports = 2;\n',
    };
    const source = buildArchive(dir, files);
    const arc = asar.readAsar(source);

    const rebuilt = path.join(dir, 'rebuilt.asar');
    asar.writeAsar(rebuilt, JSON.parse(JSON.stringify(arc.header)), (p, node) =>
      asar.entryBytes(arc, node)
    );

    assert.deepEqual(fs.readFileSync(rebuilt), fs.readFileSync(source));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identical payloads are stored once', () => {
  const dir = tempDir();
  try {
    const shared = 'shared payload\n';
    const source = buildArchive(dir, { 'x.txt': shared, 'y.txt': shared });
    const arc = asar.readAsar(source);
    const entries = asar.flatten(arc.header);

    const offsets = new Set(entries.map((e) => e.node.offset));
    assert.equal(offsets.size, 1, 'both entries must share one offset');
    assert.equal(fs.statSync(source).size, arc.dataStart + Buffer.byteLength(shared));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('header hash covers the header JSON only', () => {
  const dir = tempDir();
  try {
    const source = buildArchive(dir, { 'a.js': 'x' });
    const buf = fs.readFileSync(source);
    const jsonEnd = 16 + buf.readUInt32LE(12);

    assert.equal(asar.headerHash(source), asar.sha256(buf.subarray(16, jsonEnd)));
    assert.notEqual(asar.headerHash(source), asar.sha256(buf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unpacked entries stay out of the archive body', () => {
  const dir = tempDir();
  try {
    const header = {
      files: {
        'native.node': { size: 1234, offset: '0', unpacked: true },
        'index.js': { size: 2, offset: '0' },
      },
    };
    const out = path.join(dir, 'unpacked.asar');
    asar.writeAsar(out, header, () => 'ok');

    const arc = asar.readAsar(out);
    const entries = asar.flatten(arc.header);
    const native = entries.find((e) => e.path === 'native.node');

    assert.equal(native.node.unpacked, true);
    assert.equal(native.node.size, 1234, 'unpacked size must be preserved');
    assert.equal(arc.buf.length, arc.dataStart + 2, 'only index.js is in the body');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFileBytes rejects unpacked entries', () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, 'unpacked.asar');
    asar.writeAsar(
      out,
      { files: { 'native.node': { size: 4, offset: '0', unpacked: true } } },
      () => 'ok'
    );
    const arc = asar.readAsar(out);
    assert.throws(() => asar.readFileBytes(arc, 'native.node'), /unpacked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
