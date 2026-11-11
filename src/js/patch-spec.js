'use strict';

/**
 * Declarative description of the model-unlock patch.
 *
 * Every rule is a STRUCTURAL rewrite: it matches on code shape, never on a file
 * name or a minified identifier, because Claude Desktop renames its chunks and
 * re-minifies symbols on every release. A rule is located by scanning the whole
 * archive, so it keeps working when the code moves to a different file.
 *
 * Rule shape:
 *
 *   id          stable identifier, used in reports and docs
 *   pattern     global RegExp matching the exact fragment to rewrite
 *   replacement string or (match, ...groups) => string
 *   probe       global RegExp matching the ALREADY-PATCHED form
 *   expectTotal exact number of matches required across the whole archive
 *   perFile     maximum matches allowed in any single file
 *   title       one-line summary
 *   why         what this unlocks and why it is safe
 *
 * SAFETY CONTRACT: `analyse()` requires `expectTotal` exact matches and zero
 * probes before a rule is "pending". Anything else makes the archive
 * "incompatible" and `apply()` throws without writing. Never add a heuristic
 * fallback to this file: a patch that silently misapplies to a new release
 * corrupts a working install, which is worse than refusing to patch.
 *
 * MAINTENANCE: when a release changes the code, see docs/MAINTENANCE.md.
 * Bump SPEC_VERSION whenever a pattern or replacement changes.
 */

/** Bump on every pattern/replacement change so reports identify the spec. */
const SPEC_VERSION = '1.1.0';

/**
 * Provider option values that may legitimately host an Anthropic-compatible or
 * [OI]-compatible gateway serving non-Anthropic models.
 *
 * These are the branches we relax. anthropic/bedrock/vertex/foundry are
 * deliberately excluded: they only ever serve Anthropic models, and their
 * validators must stay intact.
 */
const GATEWAY_PROVIDERS = ['gateway', 'mantle'];

/**
 * Rule 1 — provider validation dispatch.
 *
 *   case"anthropic":return ANTHROPIC_VALIDATOR(t);
 *   case"bedrock":return BEDROCK_VALIDATOR(t);
 *   case"vertex":return VERTEX_VALIDATOR(t);
 *   case"foundry":return FOUNDRY_VALIDATOR(t);
 *   case"gateway":case"mantle":return GATEWAY_VALIDATOR(t)   <-- relaxed
 *
 * GATEWAY_VALIDATOR rejects any model ID that does not look Anthropic. Relaxing
 * only the gateway/mantle branch accepts any ID the provider returns, and
 * relieves validateSessionModel(), admin inferenceModels resolution and the
 * inferenceModels config pruning in one edit, because all three dispatch
 * through this switch.
 */
const gatewayValidator = {
  id: 'gateway-validator-relaxed',
  title: 'Gateway provider accepts any model ID',
  pattern: /case"gateway":case"mantle":return\s*[A-Za-z0-9_$]+\(\s*[A-Za-z0-9_$]+\s*\)/g,
  replacement: 'case"gateway":case"mantle":return{ok:!0}',
  probe: /case"gateway":case"mantle":return\{ok:!0\}/g,
  expectTotal: 2,
  perFile: 1,
  why:
    'Lets the gateway/mantle providers accept any model ID instead of only ' +
    'IDs that look Anthropic. The anthropic, bedrock, vertex and foundry ' +
    'branches are untouched.',
};

/**
 * Rule 2 — model discovery filter.
 *
 *   return !IS_ANTHROPIC_MODEL(row.id) && !familyTier ? [] : [ {...model...} ]
 *   return !row.id ? [] : [ {...model...} ]                  <-- relaxed
 *
 * This is the /v1/models response parser. Every model the gateway returned but
 * whose ID does not look Anthropic is dropped here. The rewrite keeps the guard
 * that the ID itself is present, and drops only the Anthropic-name test.
 */
const discoveryFilter = {
  id: 'discovery-filter-relaxed',
  title: '/v1/models parser keeps non-Anthropic IDs',
  pattern: /return!([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.id\)&&!([A-Za-z0-9_$]+)\?\[\]:\[/g,
  replacement: (_match, _fn, obj) => `return!${obj}.id?[]:[`,
  probe: /return!([A-Za-z0-9_$]+)\.id\?\[\]:\[/g,
  expectTotal: 1,
  perFile: 1,
  why:
    'Stops the /v1/models response parser from discarding model IDs that do ' +
    'not look Anthropic.',
};

/**
 * Rule 3 — keep CLAUDE_USER_DATA_DIR in packaged builds.
 *
 *   function ENV_STRIP(env) {
 *     let g = globalThis;
 *     env.CLAUDE_USER_DATA_DIR && g[SLOT] === void 0 && (g[SLOT] = env.CLAUDE_USER_DATA_DIR),
 *     delete env.CLAUDE_USER_DATA_DIR,
 *     delete env.SSLKEYLOGFILE,
 *     delete env.sslkeylogfile
 *   }
 *
 * Packaged builds call ENV_STRIP(process.env) at startup unless a signed CDP
 * token is present, which deletes CLAUDE_USER_DATA_DIR before the
 * `app.setPath("userData", ...)` branch runs. The launch then silently falls
 * back to the shared default data folder and loses the single-instance lock.
 *
 * The rewrite drops the removal of CLAUDE_USER_DATA_DIR (and the now-pointless
 * global slot assignment) while keeping the SSLKEYLOGFILE cleanup. It also
 * teaches the sanitizer to recover the last profile from auth-profile.txt when
 * the variable is absent, because claude:// protocol launches (the browser
 * sign-in callback) cannot inherit our environment.
 *
 * Not a model change: this rule exists so a portable instance can own its
 * profile (separate userData, logs, cache and single-instance lock).
 */
const userDataDirPreserved = {
  id: 'user-data-dir-env-preserved',
  title: 'Packaged build honours CLAUDE_USER_DATA_DIR',
  pattern:
    /function\s+([A-Za-z0-9_$]+)\(\s*([A-Za-z0-9_$]+)\s*\)\{let\s+([A-Za-z0-9_$]+)\s*=\s*globalThis;\2\.CLAUDE_USER_DATA_DIR&&\3\[[A-Za-z0-9_$]+\]===void 0&&\(\3\[[A-Za-z0-9_$]+\]=\2\.CLAUDE_USER_DATA_DIR\),delete\s+\2\.CLAUDE_USER_DATA_DIR,delete\s+\2\.SSLKEYLOGFILE,delete\s+\2\.sslkeylogfile\}/g,
  replacement: (_match, fn, env) =>
    `function ${fn}(${env}){delete ${env}.SSLKEYLOGFILE,delete ${env}.sslkeylogfile;` +
    `if(!${env}.CLAUDE_USER_DATA_DIR)try{` +
    `const f=require("fs"),p=require("path"),d=p.join(p.dirname(process.execPath),"..","..","auth-profile.txt");` +
    `if(f.existsSync(d)){const v=f.readFileSync(d,"utf8").trim();if(v)${env}.CLAUDE_USER_DATA_DIR=v}` +
    `}catch{}}`,
  probe:
    /function\s+[A-Za-z0-9_$]+\(\s*([A-Za-z0-9_$]+)\s*\)\{delete\s+\1\.SSLKEYLOGFILE,delete\s+\1\.sslkeylogfile;if\(!\1\.CLAUDE_USER_DATA_DIR\)try\{const f=require\("fs"\),p=require\("path"\),d=p\.join\(p\.dirname\(process\.execPath\),"\.\.","\.\.","auth-profile\.txt"\)/g,
  expectTotal: 1,
  perFile: 1,
  why:
    'Keeps CLAUDE_USER_DATA_DIR visible to the app so a portable instance can ' +
    'use its own profile directory (separate userData, logs, cache and ' +
    'single-instance lock) instead of the shared default data folder, and ' +
    'restores the last profile for claude:// callback launches that cannot ' +
    'inherit the environment.',
};

/**
 * Rule 4 — read the gateway's real context size at the /v1/models parser.
 *
 *   MODEL_ENTRY(row.id, row, CONTEXT_HELPER(row.supports_1m, row.max_input_tokens))
 *   MODEL_ENTRY(row.id, row, CONTEXT_HELPER(row.supports_1m,
 *                row.max_input_tokens ?? row.context_length ?? row.max_model_len))
 *                                                             <-- extended
 *
 * The parser already accepts a numeric context size, but only under the exact
 * field name max_input_tokens. Gateways commonly report the same number as
 * context_length or max_model_len, and those rows silently default to 200K.
 *
 * Extending the read is deliberately preferred over forcing the 1M flag on
 * every model: forcing it would mislabel smaller-context models as 1M. With
 * this rule the value the gateway actually reports decides the context size, so
 * a model that genuinely reports < 1e6 keeps its real size.
 *
 * If the app then appends the [1m] suffix to a session model, the gateway must
 * tolerate or strip it.
 */
const gatewayContextFields = {
  id: 'gateway-context-fields',
  title: 'Read context size from the fields gateways actually send',
  pattern:
    /([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.id,([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\(\3\.supports_1m,\3\.max_input_tokens\)\)/g,
  replacement: (_match, fn, idSrc, row, helper) =>
    `${fn}(${idSrc}.id,${row},${helper}(${row}.supports_1m,${row}.max_input_tokens??${row}.context_length??${row}.max_model_len))`,
  probe:
    /([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+)\.id,([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\(\3\.supports_1m,\3\.max_input_tokens\?\?\3\.context_length\?\?\3\.max_model_len\)\)/g,
  expectTotal: 1,
  perFile: 1,
  why:
    'Lets the gateway /v1/models parser read the real context size from the ' +
    'field names gateways actually use (context_length, max_model_len) in ' +
    'addition to max_input_tokens. Models whose reported context is >= 1M ' +
    'get the 1M context; smaller models keep their real size.',
};

/** Archive entries that hold V8 bytecode compiled from the pre-patch sources. */
const STALE_CACHE_DIR = 'compile-cache/';

const rules = [gatewayValidator, discoveryFilter, userDataDirPreserved, gatewayContextFields];

module.exports = {
  SPEC_VERSION,
  GATEWAY_PROVIDERS,
  STALE_CACHE_DIR,
  rules,
};
