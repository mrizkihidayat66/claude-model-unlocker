'use strict';

/**
 * Apply the patch spec to an ASAR archive.
 *
 * The archive is edited in memory and rebuilt with `asar.writeAsar`, so the
 * result is minimal and self-consistent:
 *
 *   - untouched entries keep their exact bytes
 *   - rewritten entries get new offsets, sizes and integrity hashes
 *   - V8 compile-cache entries are dropped, because they hold bytecode compiled
 *     from the PRE-patch sources (Node rejects a mismatched cache and recompiles,
 *     but dropping them makes the output deterministic)
 *
 * `analyse()` is the gate: it reports `applicable`, `patched`, `partial` or
 * `incompatible`. `apply()` refuses to write anything unless the archive is
 * patchable, so a changed upstream release can never be patched by guesswork.
 */

const asar = require('./asar');
const spec = require('./patch-spec');

/** Archive paths that hold JavaScript we may rewrite. */
const JS_ENTRY = /\.(js|mjs|cjs)$/;

/** Load an archive and index its entries by path. */
function loadArchive(asarPath) {
  const arc = asar.readAsar(asarPath);
  const entries = asar.flatten(arc.header);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const contents = (entryPath, node) => asar.entryBytes(arc, node);
  const text = (entry) => contents(entry.path, entry.node).toString('utf8');

  return { arc, entries, byPath, contents, text };
}

/** JavaScript entries stored inside the archive (unpacked entries excluded). */
function jsEntries(archive) {
  return archive.entries.filter((e) => JS_ENTRY.test(e.path) && !e.node.unpacked);
}

/** Match a rule's pattern across the archive: [{ path, count }]. */
function matchLocations(archive, pattern) {
  const hits = [];
  for (const entry of jsEntries(archive)) {
    const found = archive.text(entry).match(pattern);
    if (found) hits.push({ path: entry.path, count: found.length });
  }
  return hits;
}

/** Total matches of a rule's probe (the already-patched form). */
function countProbes(archive, rule) {
  return jsEntries(archive).reduce((total, entry) => {
    const found = archive.text(entry).match(rule.probe);
    return total + (found ? found.length : 0);
  }, 0);
}

/**
 * Classify one rule against an archive.
 *
 *   applied      - probe present the expected number of times, pattern gone
 *   pending      - pattern present exactly as expected, no probe
 *   partial      - both present (a previous run was interrupted)
 *   incompatible - anything else; the upstream code changed
 */
function classifyRule(archive, rule) {
  const locations = matchLocations(archive, rule.pattern);
  const found = locations.reduce((a, loc) => a + loc.count, 0);
  const probes = countProbes(archive, rule);
  const perFileOk = locations.every((loc) => loc.count <= rule.perFile);

  let state;
  if (found === 0 && probes === rule.expectTotal) state = 'applied';
  else if (found === rule.expectTotal && perFileOk && probes === 0) state = 'pending';
  else if (probes > 0 && found > 0 && perFileOk) state = 'partial';
  else state = 'incompatible';

  return {
    id: rule.id,
    title: rule.title,
    state,
    found,
    expected: rule.expectTotal,
    probes,
    perFileOk,
    locations,
    why: rule.why,
  };
}

/**
 * Analyse an archive against the spec.
 *
 * @returns {{status: 'patched'|'applicable'|'partial'|'incompatible',
 *            rules: object[], counts: object, archive: object}}
 */
function analyse(asarPath) {
  const archive = loadArchive(asarPath);
  const rules = spec.rules.map((rule) => classifyRule(archive, rule));

  const counts = {
    applied: rules.filter((r) => r.state === 'applied').length,
    pending: rules.filter((r) => r.state === 'pending').length,
    incompatible: rules.filter((r) => r.state === 'incompatible').length,
    total: rules.length,
  };

  let status;
  if (counts.incompatible > 0) status = 'incompatible';
  else if (counts.applied === counts.total) status = 'patched';
  else if (counts.pending === counts.total) status = 'applicable';
  else status = 'partial';

  return { status, rules, counts, archive };
}

/** Remove the given paths from the header tree. */
function dropEntries(header, paths) {
  const drop = new Set(paths);
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else if (drop.has(p)) delete node.files[name];
    }
  };
  walk(header, '');
}

/** Archive paths of V8 compile-cache entries that must be discarded. */
function staleCacheEntries(archive) {
  return archive.entries
    .filter((e) => e.path.startsWith(spec.STALE_CACHE_DIR) && e.path.endsWith('.jsc'))
    .map((e) => e.path);
}

/**
 * Apply the patch, writing the result to `outPath`.
 *
 * @param {string} asarPath source archive (never modified)
 * @param {string} outPath  destination archive
 * @param {{force?: boolean}} [opts]
 * @returns {{changed: boolean, status: string, modifications: object[],
 *            droppedCache: string[], built?: object, outPath: string}}
 */
function apply(asarPath, outPath, opts = {}) {
  const analysis = analyse(asarPath);
  if (analysis.status === 'incompatible') {
    const err = new Error('archive is not in a safely patchable state');
    err.analysis = analysis;
    throw err;
  }
  if (analysis.status === 'patched' && !opts.force) {
    return { changed: false, status: analysis.status, modifications: [], droppedCache: [], outPath };
  }

  const archive = analysis.archive;
  const modifications = [];

  // Several rules may target the same file, so each file's text is carried
  // forward from the previous rule instead of being re-read from the archive.
  const patchedFiles = new Map(); // path -> Buffer
  const currentText = (entryPath) => {
    if (patchedFiles.has(entryPath)) return patchedFiles.get(entryPath).toString('utf8');
    return archive.text(archive.byPath.get(entryPath));
  };

  for (const rule of spec.rules) {
    const result = analysis.rules.find((r) => r.id === rule.id);
    if (result.state !== 'pending') continue;

    for (const loc of result.locations) {
      const original = currentText(loc.path);
      let applied = 0;
      const updated = original.replace(rule.pattern, (...args) => {
        applied += 1;
        const replacement = rule.replacement;
        return typeof replacement === 'function' ? replacement(...args) : replacement;
      });
      if (applied !== loc.count) {
        throw new Error(
          `rule ${rule.id}: expected ${loc.count} replacement(s) in ${loc.path}, made ${applied}`
        );
      }
      patchedFiles.set(loc.path, Buffer.from(updated, 'utf8'));
      modifications.push({
        file: loc.path,
        rule: rule.id,
        replacements: applied,
        beforeBytes: Buffer.byteLength(original),
        afterBytes: Buffer.byteLength(updated),
      });
    }
  }

  const droppedCache = staleCacheEntries(archive);

  // Rebuild from a deep copy so the caller's header is untouched.
  const header = JSON.parse(JSON.stringify(archive.arc.header));
  dropEntries(header, droppedCache);

  const contents = (entryPath, node) => {
    if (patchedFiles.has(entryPath)) return patchedFiles.get(entryPath);
    const original = archive.byPath.get(entryPath);
    if (!original) throw new Error(`asar: lost entry ${entryPath}`);
    return archive.contents(entryPath, original.node);
  };

  const built = asar.writeAsar(outPath, header, contents);

  return { changed: true, status: 'patched', modifications, droppedCache, built, outPath };
}

module.exports = {
  analyse,
  apply,
  loadArchive,
  staleCacheEntries,
  JS_ENTRY,
};
