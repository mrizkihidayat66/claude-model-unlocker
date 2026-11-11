'use strict';

/**
 * Exact reader/writer for Electron ASAR archives.
 *
 * Layout (verified against Claude Desktop 4.23118.1.0):
 *
 *   u32 @0  = 4                      pickle payload size marker
 *   u32 @4  = headerPickleSize       = 4 + jsonPaddedLen
 *   u32 @8  = jsonPaddedLen          JSON + NUL padding, multiple of 4
 *   u32 @12 = jsonActualLen
 *   JSON    @16 .. 16+jsonActualLen  NUL-padded to jsonPaddedLen
 *   DATA    @(8 + headerPickleSize)  file payloads, in header order
 *
 * Per-file header entries:
 *   { size, offset, unpacked?, integrity: { algorithm, hash, blockSize, blocks } }
 *
 * The writer preserves every header field, recomputes offsets, sizes and
 * integrity hashes, deduplicates identical payloads by content hash (asar does
 * the same), and keeps `unpacked: true` entries out of the archive body. A
 * rebuild that changes nothing is byte-identical to the input; `tests/verify.js`
 * enforces that.
 */

const fs = require('fs');
const crypto = require('crypto');

const PICKLE_HEADER_SIZE = 4;
const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;

/** @param {Buffer|string} data @returns {string} lowercase hex SHA-256 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Split a buffer into asar-style per-block hashes. */
function blockHashes(buf, blockSize) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += blockSize) {
    blocks.push(sha256(buf.subarray(off, Math.min(off + blockSize, buf.length))));
  }
  return blocks.length ? blocks : [sha256(Buffer.alloc(0))];
}

/** Build the integrity object for a payload, mirroring asar's own scheme. */
function integrityFor(buf, template) {
  const blockSize =
    template && template.integrity && template.integrity.blockSize
      ? template.integrity.blockSize
      : DEFAULT_BLOCK_SIZE;
  return {
    algorithm: 'SHA256',
    hash: sha256(buf),
    blockSize,
    blocks: blockHashes(buf, blockSize),
  };
}

/**
 * Locate the end of the header JSON.
 *
 * The declared `jsonActualLen` is authoritative; the byte scan is only a
 * fallback for archives whose length word is inconsistent.
 */
function findJsonEnd(buf) {
  const declared = buf.readUInt32LE(12);
  const declaredEnd = 16 + declared;
  if (declared > 0 && declaredEnd <= buf.length) {
    try {
      JSON.parse(buf.toString('utf8', 16, declaredEnd));
      return declaredEnd;
    } catch (_) {
      /* fall through to the scan */
    }
  }
  for (let i = 16; i < buf.length; i++) {
    if (buf[i] !== 0x7d) continue;
    try {
      JSON.parse(buf.toString('utf8', 16, i + 1));
      return i + 1;
    } catch (_) {
      /* keep scanning */
    }
  }
  throw new Error('asar: could not locate end of header JSON');
}

/** Read and parse an ASAR archive. */
function readAsar(file) {
  const buf = fs.readFileSync(file);
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonPaddedLen = buf.readUInt32LE(8);
  const jsonActualLen = buf.readUInt32LE(12);
  const jsonEnd = findJsonEnd(buf);
  const header = JSON.parse(buf.toString('utf8', 16, jsonEnd));

  return {
    file,
    buf,
    headerPickleSize,
    jsonPaddedLen,
    jsonActualLen,
    header,
    dataStart: 8 + headerPickleSize,
  };
}

/** Flatten the header tree into an ordered list of { path, node }. */
function flatten(node, prefix = '', out = []) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) flatten(child, p, out);
    else out.push({ path: p, node: child });
  }
  return out;
}

/** Return the bytes of one archive entry. */
function readFileBytes(arc, arcPath) {
  const entry = flatten(arc.header).find((e) => e.path === arcPath);
  if (!entry) throw new Error(`asar: no such entry: ${arcPath}`);
  if (entry.node.unpacked) {
    throw new Error(`asar: entry is unpacked (lives outside the archive): ${arcPath}`);
  }
  return entryBytes(arc, entry.node);
}

/** Slice an entry's payload out of an already-read archive buffer. */
function entryBytes(arc, node) {
  const off = Number(node.offset);
  return arc.buf.subarray(arc.dataStart + off, arc.dataStart + off + node.size);
}

/**
 * Rebuild an archive from an in-memory header tree.
 *
 * @param {string} outFile        destination path
 * @param {object} header         header tree (mutated in place)
 * @param {(path: string, node: object) => Buffer|string} contents payload resolver
 * @returns {{ size: number, dataStart: number, fileCount: number }}
 */
function writeAsar(outFile, header, contents) {
  const entries = flatten(header);

  // Collect payloads; identical content is stored once and shares an offset,
  // exactly as asar does when packaging. Payload order follows the original
  // offset order so an unchanged rebuild reproduces the archive exactly.
  const byDigest = new Map(); // sha256 -> { buf, offset, integrity }
  const ordered = [];

  for (const e of entries) {
    if (e.node.unpacked) continue; // lives in app.asar.unpacked
    const data = contents(e.path, e.node);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const digest = sha256(buf);
    const duplicate = byDigest.has(digest);
    if (!duplicate) byDigest.set(digest, { buf, offset: 0, integrity: null });
    ordered.push({ entry: e, digest, duplicate });
  }

  const originalOffset = (item) => {
    const o = item.entry.node.offset;
    return o === undefined ? Number.MAX_SAFE_INTEGER : Number(o);
  };
  const unique = ordered.filter((x) => !x.duplicate).sort((a, b) => originalOffset(a) - originalOffset(b));

  let offset = 0;
  for (const item of unique) {
    const rec = byDigest.get(item.digest);
    rec.offset = offset;
    rec.integrity = integrityFor(rec.buf, item.entry.node);
    offset += rec.buf.length;
  }

  for (const item of ordered) {
    const rec = byDigest.get(item.digest);
    item.entry.node.size = rec.buf.length;
    item.entry.node.offset = String(rec.offset);
    item.entry.node.integrity = rec.integrity;
  }

  // Serialize the header the way asar does: the pickle payload begins with a
  // 4-byte length word, so the padded length covers 4 + JSON bytes.
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonPaddedLen = Math.ceil((PICKLE_HEADER_SIZE + jsonBuf.length) / 4) * 4;
  const padded = Buffer.alloc(jsonPaddedLen);
  jsonBuf.copy(padded);

  const headerPickleSize = PICKLE_HEADER_SIZE + jsonPaddedLen;
  const dataStart = 8 + headerPickleSize;

  const out = Buffer.alloc(dataStart + offset);
  out.writeUInt32LE(PICKLE_HEADER_SIZE, 0);
  out.writeUInt32LE(headerPickleSize, 4);
  out.writeUInt32LE(jsonPaddedLen, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  padded.copy(out, 16);

  let writeAt = dataStart;
  for (const item of unique) {
    const rec = byDigest.get(item.digest);
    rec.buf.copy(out, writeAt);
    writeAt += rec.buf.length;
  }

  fs.writeFileSync(outFile, out);
  return { size: out.length, dataStart, fileCount: entries.length };
}

/**
 * The bytes Electron hashes for EnableEmbeddedAsarIntegrityValidation:
 * the header JSON only (offset 16 .. end of JSON), not the whole archive.
 */
function headerHashBytes(file) {
  const buf = fs.readFileSync(file);
  return buf.subarray(16, findJsonEnd(buf));
}

/** SHA-256 of the header JSON bytes. */
function headerHash(file) {
  return sha256(headerHashBytes(file));
}

module.exports = {
  readAsar,
  readFileBytes,
  entryBytes,
  writeAsar,
  flatten,
  headerHash,
  headerHashBytes,
  sha256,
  integrityFor,
};
