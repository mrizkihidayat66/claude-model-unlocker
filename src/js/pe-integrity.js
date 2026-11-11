'use strict';

/**
 * Read and update the ELECTRONASAR integrity resource of a Windows PE file.
 *
 * Electron's EnableEmbeddedAsarIntegrityValidation fuse makes the browser
 * process verify each ASAR header against a digest embedded in the executable,
 * in the PE resource:
 *
 *   INTEGRITY/ELECTRONASAR/#1033 ->
 *     [{"file":"resources\\app.asar","alg":"SHA256","value":"<hex>"}, ...]
 *
 * The digest covers the ASAR header JSON bytes only (offset 16 .. end of JSON).
 *
 * A SHA-256 hex digest is always 64 characters, so a value can be rewritten in
 * place without moving any PE structure. The module refuses to write whenever
 * the serialized resource would change length, and it is only ever used on the
 * portable copy we own, never on the MSIX package.
 */

const fs = require('fs');

const RESOURCE_NAME = 'ELECTRONASAR';
const RESOURCE_TYPE = 'INTEGRITY';

/** Parse the PE headers and return the resource directory plus an RVA mapper. */
function parsePe(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('not a PE file');

  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('unexpected PE optional header magic');

  const dirOff = opt + (magic === 0x20b ? 112 : 96);
  const resRva = buf.readUInt32LE(dirOff + 2 * 8);
  const resSize = buf.readUInt32LE(dirOff + 2 * 8 + 4);

  const sections = [];
  let secOff = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    sections.push({
      name: buf.toString('ascii', secOff, secOff + 8).replace(/\0+$/, ''),
      vaddr: buf.readUInt32LE(secOff + 12),
      vsize: buf.readUInt32LE(secOff + 8),
      rawPtr: buf.readUInt32LE(secOff + 20),
      rawSize: buf.readUInt32LE(secOff + 16),
    });
    secOff += 40;
  }

  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
        return s.rawPtr + (rva - s.vaddr);
      }
    }
    return -1;
  };

  return { resRva, resSize, rvaToOff, base: rvaToOff(resRva) };
}

/** Locate the INTEGRITY/ELECTRONASAR resource and return its offset and size. */
function findIntegrityResource(buf) {
  const { base, rvaToOff } = parsePe(buf);
  if (base < 0) throw new Error('PE has no resource table');

  let found = null;
  const walk = (off, pathNames) => {
    const named = buf.readUInt16LE(off + 12);
    const ided = buf.readUInt16LE(off + 14);
    for (let i = 0; i < named + ided; i++) {
      const e = off + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const dataField = buf.readUInt32LE(e + 4);
      let name;
      if (nameField & 0x80000000) {
        const no = base + (nameField & 0x7fffffff);
        const len = buf.readUInt16LE(no);
        name = buf.toString('utf16le', no + 2, no + 2 + len * 2);
      } else {
        name = `#${nameField}`;
      }
      const p = pathNames.concat(name);
      if (dataField & 0x80000000) {
        walk(base + (dataField & 0x7fffffff), p);
      } else if (p[0] === RESOURCE_TYPE && p[1] === RESOURCE_NAME && !found) {
        const de = base + dataField;
        found = {
          offset: rvaToOff(buf.readUInt32LE(de)),
          size: buf.readUInt32LE(de + 4),
          path: p,
        };
      }
    }
  };

  walk(base, []);
  if (!found) throw new Error(`PE has no ${RESOURCE_TYPE}/${RESOURCE_NAME} resource`);
  return found;
}

/** Read the integrity table as parsed JSON. */
function readIntegrity(exePath) {
  const buf = fs.readFileSync(exePath);
  const resource = findIntegrityResource(buf);
  const raw = buf.toString('utf8', resource.offset, resource.offset + resource.size);
  return { resource, table: JSON.parse(raw), raw };
}

/** True when `file` in the integrity table names the given archive path. */
function matchesArchive(entryFile, archivePath) {
  return entryFile.replace(/\\/g, '/') === archivePath.replace(/\\/g, '/');
}

/**
 * Update one or more digests in the ELECTRONASAR resource.
 *
 * @param {string} exePath
 * @param {{file: string, value: string}[]} updates
 * @returns {{ changed: boolean, changes: object[] }}
 */
function updateIntegrity(exePath, updates) {
  const buf = fs.readFileSync(exePath);
  const resource = findIntegrityResource(buf);
  const raw = buf.toString('utf8', resource.offset, resource.offset + resource.size);
  const table = JSON.parse(raw);

  const changes = [];
  for (const { file, value } of updates) {
    const entry = table.find((t) => matchesArchive(t.file, file));
    if (!entry) throw new Error(`integrity table has no entry for ${file}`);

    const old = entry.value;
    if (old === value) {
      changes.push({ file, old, value, changed: false });
      continue;
    }
    if (old.length !== value.length) throw new Error(`digest length mismatch for ${file}`);
    entry.value = value;
    changes.push({ file, old, value, changed: true });
  }

  if (!changes.some((c) => c.changed)) return { changed: false, changes };

  const newRaw = JSON.stringify(table);
  if (newRaw.length !== raw.length) {
    throw new Error(
      `rewriting the integrity resource changed its length (${raw.length} -> ${newRaw.length}); ` +
        'this would require moving PE structures, so refusing to write.'
    );
  }

  buf.write(newRaw, resource.offset, 'utf8');
  fs.writeFileSync(exePath, buf);
  return { changed: true, changes };
}

module.exports = { readIntegrity, updateIntegrity, findIntegrityResource, matchesArchive };
