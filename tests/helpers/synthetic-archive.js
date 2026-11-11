'use strict';

/**
 * Build a small synthetic archive that contains the exact code shapes the
 * patch rules target.
 *
 * The real bundle is an 80 MB minified file whose identifiers change on every
 * release. The rules are written against structure, not names, so a synthetic
 * archive with the same structure exercises them exactly as a real build does,
 * without requiring Claude Desktop to be installed.
 */

const asar = require('../../src/js/asar');

/** The pre-patch startup env sanitizer (rule 3 target). */
const ENV_SANITIZER =
  'function IM(e){let t=globalThis;e.CLAUDE_USER_DATA_DIR&&t[Rr]===void 0&&' +
  '(t[Rr]=e.CLAUDE_USER_DATA_DIR),delete e.CLAUDE_USER_DATA_DIR,' +
  'delete e.SSLKEYLOGFILE,delete e.sslkeylogfile}';

/** A provider dispatch switch with one gateway/mantle branch (rule 1 target). */
const PROVIDER_SWITCH = (fn) =>
  `function ${fn}(e){switch(e){case"anthropic":return Yt(e);case"bedrock":return Wt(e);` +
  `case"vertex":return Vt(e);case"foundry":return Kt(e);` +
  `case"gateway":case"mantle":return qt(e);default:return{ok:!1}}}`;

/** The main preload bundle: sanitizer + one dispatch site. */
const PRE_JS = ['"use strict";', ENV_SANITIZER, PROVIDER_SWITCH('_t'), 'module.exports={strip:IM,validate:_t};'].join('\n');

/** A lazily loaded chunk: second dispatch site + discovery parser + context read. */
const CHUNK_JS = [
  '"use strict";',
  PROVIDER_SWITCH('Qn'),
  'function Jt(e,t,n){return{id:e,tier:t,supports1m:n}}',
  'function Zt(e,t){return e===!0||typeof t=="number"&&t>=1e6}',
  'function Xt(e,t){return e.map(r=>{let n=Jt(r.id,r,Zt(r.supports_1m,r.max_input_tokens));',
  'return!Qt(r.id)&&!t?[]:[n]})}',
  'module.exports={parse:Xt,validate:Qn};',
].join('\n');

/** Entries every synthetic archive contains. */
function files() {
  return {
    '.vite/build/index.pre.js': PRE_JS,
    '.vite/build/index.chunk-B4M-ub9T.js': CHUNK_JS,
    'package.json': JSON.stringify({ name: 'claude', version: '0.0.0-synthetic' }),
    'assets/app.css': 'body{color:#000}',
    'compile-cache/aaaa.jsc': 'v8 bytecode (stale after patching)',
    'compile-cache/bbbb.jsc': 'v8 bytecode (stale after patching)',
    'compile-cache/cccc.jsc': 'v8 bytecode (stale after patching)',
  };
}

/** Write a synthetic archive; `overrides` replaces individual entry contents. */
function writeArchive(outPath, overrides = {}) {
  const entries = { ...files(), ...overrides };

  // Build the header tree.
  const header = { files: {} };
  for (const [filePath, contents] of Object.entries(entries)) {
    const parts = filePath.split('/');
    let dir = header.files;
    for (const part of parts.slice(0, -1)) {
      dir[part] = dir[part] || { files: {} };
      dir = dir[part].files;
    }
    dir[parts[parts.length - 1]] = { size: Buffer.byteLength(contents), offset: '0' };
  }

  // One unpacked native module: it lives outside the archive and must never be
  // read or rewritten.
  header.files['native.node'] = { size: 1024, offset: '0', unpacked: true };

  asar.writeAsar(outPath, header, (p) => entries[p]);
  return outPath;
}

/** Text of one entry in a written archive. */
function entryText(archivePath, entryPath) {
  const arc = asar.readAsar(archivePath);
  const entry = asar.flatten(arc.header).find((e) => e.path === entryPath);
  if (!entry) throw new Error(`no entry ${entryPath}`);
  return asar.entryBytes(arc, entry.node).toString('utf8');
}

module.exports = {
  CHUNK_JS,
  ENV_SANITIZER,
  PRE_JS,
  PROVIDER_SWITCH,
  entryText,
  files,
  writeArchive,
};
