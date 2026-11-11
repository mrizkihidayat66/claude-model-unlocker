# Architecture

How the unlock works, why it is built this way, and where each mechanism lives.

## 1. The restriction

Claude Desktop enforces an "Anthropic-only" rule on third-party-provider model
IDs in the **Electron main process**, not the renderer. One predicate decides
whether an ID looks Anthropic:

```js
// .vite/build/index.chunk-<hash>.js
function isAnthropicModel(e){
  let t = e.toLowerCase();
  return NON_ANTHROPIC_BLOCKLIST.test(t) ? false
       : /^(sonnet|opus|haiku|fable|mythos)(-[0-9.]+)?$/.test(t)
       || ["claude","sonnet","opus","haiku","fable","mythos","anthropic"].some(x => t.includes(x));
}
```

Four call sites route through it:

| Enforcement point | Effect | Relieved by |
|---|---|---|
| `/v1/models` response parser | drops non-Anthropic IDs from discovery | rule 2 |
| `validateSessionModel()` | refuses to start a session with such an ID | rule 1 |
| admin `inferenceModels` resolution | drops them from the resolved list | rule 1 |
| `inferenceModels` config pruning | removes them from config | rule 1 |

The renderer has no model filter, so no renderer change is needed.

## 2. The patch

Four structural rewrites, five substitutions, two files. All rules live in
[`src/js/patch-spec.js`](../src/js/patch-spec.js).

| # | Rule id | What it changes |
|---|---------|-----------------|
| 1 | `gateway-validator-relaxed` | `case"gateway":case"mantle":return VALIDATOR(t)` → `return{ok:!0}` (2 sites) |
| 2 | `discovery-filter-relaxed` | drops the Anthropic-name test from the `/v1/models` parser (1 site) |
| 3 | `user-data-dir-env-preserved` | stops the startup sanitizer deleting `CLAUDE_USER_DATA_DIR`; adds the `auth-profile.txt` fallback (1 site) |
| 4 | `gateway-context-fields` | reads `context_length` / `max_model_len` in addition to `max_input_tokens` (1 site) |

Rules 1, 2 and 4 are the unlock. Rule 3 is what makes isolated profiles
possible; it does not change model behaviour.

### Why structural patterns

Claude Desktop renames chunks (`index.chunk-B4M-ub9T.js`) and re-minifies
identifiers (`jo` → `IM` → …) on every release. Rules therefore match on code
*shape* and are located by scanning the whole archive, never by file name.

Each rule declares `expectTotal` (exact matches required) and `perFile` (max per
file), and carries a `probe` matching the already-patched form. The analysis
gate is:

| Condition | State |
|---|---|
| pattern 0, probe = `expectTotal` | `applied` |
| pattern = `expectTotal`, probe 0, per-file bounds ok | `pending` |
| both present, bounds ok | `partial` |
| anything else | `incompatible` |

`apply()` throws on `incompatible` and writes nothing. There is no heuristic
fallback and no blind text replacement: a patch that quietly misfires on a new
release is worse than one that refuses.

## 3. Deployment: why the MSIX package stays untouched

The installed package under `C:\Program Files\WindowsApps` is ACL-protected and
managed by MSIX. Two independent reasons rule out in-place patching:

1. **ACL.** Writing there requires taking ownership and disabling package
   protections, which breaks Store updates and signature validation.
2. **Electron's asar-integrity fuse.** `claude.exe` enables
   `EnableEmbeddedAsarIntegrityValidation`, and the expected SHA-256 of each ASAR
   header is embedded in the PE resource:

   ```
   INTEGRITY/ELECTRONASAR ->
     [{"file":"resources\\app.asar","alg":"SHA256","value":"79c5f83a…"},
      {"file":"resources\\ion-dist.asar","alg":"SHA256","value":"08b1433d…"}]
   ```

   A mismatch is fatal at startup:
   `FATAL:electron\shell\common\asar\asar_util.cc:314] Integrity check failed`.

Instead:

```
installed MSIX package  (read-only source of truth)
        |
        |  robocopy (excluding app.asar)
        v
%LOCALAPPDATA%\ClaudeModelUnlocker\portable\app\
        |-- claude.exe            (copy; its embedded digest is updated)
        |-- .source-version       (package version the copy was seeded from)
        |-- resources\app.asar    (patched)
        `-- resources\app.asar.unpacked\  (native modules, copied as-is)
```

The copy is self-consistent: the patched archive and the digest in its own
`claude.exe` agree, so Electron starts it normally. When the installed package
version changes, the next `patch.ps1` rebuilds the copy automatically.

## 4. ASAR handling

`src/js/asar.js` is a purpose-built reader/writer. Layout:

```
u32 @0  = 4                      pickle payload size marker
u32 @4  = headerPickleSize       = 4 + jsonPaddedLen
u32 @8  = jsonPaddedLen          JSON + NUL padding, multiple of 4
u32 @12 = jsonActualLen
JSON    @16 .. 16+jsonActualLen
DATA    @(8 + headerPickleSize)
```

Three properties matter:

- **Losslessness.** Rebuilding an unmodified archive must reproduce it byte for
  byte. That requires reproducing asar's exact header serialization, offset
  order, NUL padding and integrity scheme.
- **Deduplication.** asar stores identical payloads once and lets entries share
  an offset. The writer hashes payloads and does the same.
- **`unpacked` entries** live in `app.asar.unpacked/` and must be preserved in
  the header but never read or rewritten.

`tests/integration/roundtrip.js` enforces the first property on a real archive.

The patch engine additionally drops `compile-cache/*.jsc`, which hold V8 bytecode
compiled from the pre-patch sources. Node would reject a mismatched cache and
recompile anyway; dropping them makes the output deterministic.

## 5. Integrity digest

The digest Electron checks is **SHA-256 of the header JSON bytes only** — offset
16 to the end of the JSON, not the whole file. `pe-integrity.js` locates the
`INTEGRITY/ELECTRONASAR` resource by walking the PE resource directory and
rewrites the 64-character hex value in place. Because a SHA-256 hex digest has a
fixed length, no PE structure moves; the module refuses to write if the
serialized resource would change length.

## 6. Isolated profiles

Two mechanisms are needed.

**`CLAUDE_USER_DATA_DIR`.** Packaged builds run
`app.isPackaged && !HAS_SIGNED_CDP_TOKEN && stripEnv(process.env)` at startup,
and `stripEnv` deletes `CLAUDE_USER_DATA_DIR`. The app then falls back to
`%LOCALAPPDATA%\Claude-3p`, loses the single-instance lock, and exits:

```
[warn] [user-data-dir] CLAUDE_USER_DATA_DIR is set and signed builds ignore it
[info] [custom-3p] this process does not hold the single-instance lock and is quitting
```

Rule 3 keeps the variable, so the app's existing branch runs:

```js
if (process.env.CLAUDE_USER_DATA_DIR) {
  app.setPath("userData", e);
  app.setPath("logs", path.resolve(e, "Logs"));
}
```

The single-instance lock is keyed on `userData`, so each profile gets its own
lock, logs and Chromium `sessionData`/cache.

**`claude://` callback ownership.** Sign-in finishes through
`claude://login-callback?...`, and Windows routes that URI to the Store package
because the MSIX manifest declares the protocol — the portable app's own
`HKCU\Software\Classes\claude` key is not enough. `scripts/register-handler.ps1`
adds a per-user Default Programs registration so the user can select
**Claude (Portable)** for CLAUDE links. Protocol launches cannot inherit
environment variables, so `launch.ps1` records the active profile in
`auth-profile.txt` and rule 3's fallback reads it back.

## 7. Runtime state

Everything mutable lives outside the repository:

```
%LOCALAPPDATA%\ClaudeModelUnlocker\
  portable\app\            patched copy
  profiles\<name>\         isolated userData directories
  backups\objects\<sha>    deduplicated backup payloads (app.asar only)
  backups\index.json       backup manifest
  backups\registry-*\      exported .reg files from register-handler.ps1
  auth-profile.txt         last profile, for claude:// launches
  work\                    scratch space for reverse engineering
```

`claude.exe` is never backed up: it is a byte copy of the installed executable
apart from the digest, so it is always re-derivable.

## 8. Module map

| Path | Responsibility |
|---|---|
| `src/js/asar.js` | exact ASAR reader/writer, header hashing |
| `src/js/pe-integrity.js` | read/update the `ELECTRONASAR` PE resource |
| `src/js/patch-spec.js` | **the patch rules** — the file to edit for a new release |
| `src/js/patch-archive.js` | analysis gate and rule application |
| `src/js/cli.js` | JSON bridge used by PowerShell |
| `src/ps/Common.ps1` | package discovery, portable layout, Node bridge, backup store |
| `scripts/*.ps1` | user-facing entry points |
| `tests/unit` | dependency-free tests (ASAR, spec contract) |
| `tests/integration` | synthetic end-to-end flow, live archive verification |
| `tools/*.js` | archive search/inspection helpers for new builds |
