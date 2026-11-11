# Claude Desktop Model Unlocker

Lets **Claude Desktop for Windows** show and use **non-Anthropic model IDs**
(DeepSeek, GLM, Kimi, Qwen, or any model an Anthropic-compatible /
[OI]-compatible gateway returns from `/v1/models`) through its third-party
provider (3P / BYOK) configuration.

The installed MSIX package is **never modified** — it keeps updating through the
Microsoft Store. The tool builds a separate, self-consistent portable copy that
you launch instead.

> **Status:** the model unlock is verified statically (32 checks against a real
> install). End-to-end behaviour with a live 3P gateway — a non-Anthropic ID
> appearing in the picker and being sent unchanged — is **not yet verified**.
> See [Verification](#verification).

---

## Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 |
| App | Claude Desktop installed from the Microsoft Store (MSIX package `Claude`) |
| PowerShell | 5.1 or newer (Windows PowerShell is fine) |
| Node.js | 22 or newer on `PATH` — only for the patch engine, no `npm install` |

Disk: the portable copy is ~730 MB; `%LOCALAPPDATA%\ClaudeModelUnlocker` needs
~1.5 GB including the copy, profiles and backups.

---

## Quick start

```powershell
# 1. Check that the current Claude Desktop build is patchable.
.\scripts\inspect.ps1

# 2. Build the portable copy, apply the unlock, and launch it.
.\scripts\patch.ps1 -Launch

# 3. Later, launch the patched build again.
.\scripts\launch.ps1
```

After every Claude Desktop update, re-run `.\scripts\patch.ps1`. It is
idempotent, refreshes the copy when the package version changed, and refuses to
touch a build it does not recognise.

Then configure your gateway in Claude Desktop's third-party provider settings as
usual. No model list is hardcoded anywhere: whatever your gateway returns from
`/v1/models` is what you can pick.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/inspect.ps1` | Read-only: installed version, patch state, portable health |
| `scripts/patch.ps1` | Build/refresh the portable copy and apply the unlock |
| `scripts/launch.ps1` | Launch the patched build with an isolated profile |
| `scripts/restore.ps1` | Re-seed the portable copy, manage backups |
| `scripts/register-handler.ps1` | Per-user `claude://` registration (needed for sign-in) |
| `Claude-3P.cmd` | Double-clickable wrapper for `launch.ps1` |

Common flags:

| Flag | Script | Meaning |
|---|---|---|
| `-DryRun` | `patch.ps1` | analyse and report only; write nothing |
| `-Launch` | `patch.ps1` | launch when done |
| `-RefreshCopy` | `patch.ps1` | rebuild the portable copy from scratch |
| `-KeepBackup` | `patch.ps1` | skip the post-patch backup pruning pass |
| `-Profile <name>` | `patch.ps1`, `launch.ps1` | isolated profile to use (default `default`) |
| `-AsarPath <path>` | `inspect.ps1` | inspect an arbitrary `app.asar` |
| `-Json` | `inspect.ps1` | machine-readable output |
| `-FromBackup <id\|latest>` | `restore.ps1` | restore an earlier portable archive |
| `-ListBackups` / `-PruneBackups` | `restore.ps1` | inspect or prune the backup store |
| `-RemovePortable` | `restore.ps1` | delete the portable copy |
| `-Status` / `-Unregister` / `-OpenSettings` | `register-handler.ps1` | inspect, undo, or open Default Apps |

Set `CLAUDE_MODEL_UNLOCKER_HOME` to relocate the runtime directory (portable
copy, profiles, backups) away from `%LOCALAPPDATA%\ClaudeModelUnlocker`.

---

## What gets changed

Four structural rewrites in the Electron **main process** (the renderer has no
model filter). Five substitutions across two files.

| # | Rule | Effect |
|---|------|--------|
| 1 | `gateway-validator-relaxed` | `gateway`/`mantle` accept any model ID instead of only Anthropic-looking ones |
| 2 | `discovery-filter-relaxed` | the `/v1/models` parser stops discarding non-Anthropic IDs |
| 3 | `user-data-dir-env-preserved` | packaged builds honour `CLAUDE_USER_DATA_DIR`, enabling isolated profiles |
| 4 | `gateway-context-fields` | reads `context_length` / `max_model_len`, not just `max_input_tokens` |

**Deliberately untouched:** endpoints and base-URL handling, authentication,
the wire protocol, model IDs themselves, tier/slot mapping, request/response
transformation, tool calling, streaming, and the `anthropic` / `bedrock` /
`vertex` / `foundry` providers — those genuinely only serve Anthropic models.

Full rationale and the enforcement points: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Why the MSIX package is safe

Two things make in-place patching impossible, and both are respected:

1. `C:\Program Files\WindowsApps` is ACL-protected. Writing there would break
   Store updates and signature validation.
2. `claude.exe` enables Electron's `EnableEmbeddedAsarIntegrityValidation` fuse.
   The expected SHA-256 of the ASAR **header** is embedded in the PE resource
   `INTEGRITY/ELECTRONASAR`. A modified archive with an unchanged digest aborts
   at startup with `FATAL: ... Integrity check failed`.

So the tool copies the app to
`%LOCALAPPDATA%\ClaudeModelUnlocker\portable\app`, patches the archive there, and
updates the digest in that copy's own `claude.exe`. The two agree, so the copy
starts normally, and the original is never touched.

---

## Why it survives updates

Rules match on **code structure**, never on file names or minified identifiers,
and are located by scanning the whole archive. Claude Desktop renames chunks and
re-minifies symbols on every release; the rules do not care.

Each rule declares an exact expected match count. If a release changes the
relevant code, the count no longer lines up and the tool **stops without
modifying anything**:

```
[ERROR] The archive does not match the expected patch shape. Stopping WITHOUT modifying anything.
```

There is no heuristic fallback. That is the difference between a patch that keeps
working and one that quietly corrupts an update. When this happens, follow
[`docs/MAINTENANCE.md`](docs/MAINTENANCE.md).

---

## Isolated profiles and multiple instances

`launch.ps1` starts the patched build with a private userData directory:

```powershell
.\scripts\launch.ps1                  # profile "default"
.\scripts\launch.ps1 -Profile work    # a second, fully isolated instance
```

Each profile under `%LOCALAPPDATA%\ClaudeModelUnlocker\profiles\<name>` has its
own sign-in state, config, logs, Chromium cache and single-instance lock, so
profiles run side by side with each other and with the Store app (which keeps
using `%LOCALAPPDATA%\Claude-3p`).

### Signing in to a portable profile

Sign-in finishes through a `claude://` callback, which Windows routes to the
Store package by default. Register the portable build once:

```powershell
.\scripts\register-handler.ps1 -OpenSettings
```

Then set **CLAUDE** to **Claude (Portable)** in **Settings → Apps → Default
apps**. This is a per-user choice and is reversible with `-Unregister`.

---

## Verification

Static checks against a real install:

```powershell
.\tests\verify.ps1
```

32 checks covering: the installed archive is untouched, the ASAR writer is
byte-identical on a real archive, exactly the intended substitutions land in
exactly the matched files, other providers keep their validators, the patch is
idempotent, the portable digest matches its executable, and a simulated upstream
change makes the patcher refuse.

Dependency-free tests (run anywhere, no install needed):

```bash
npm test
```

```powershell
.\tests\powershell\backup-store.tests.ps1   # backup store, against a temp runtime root
```

Runtime profile isolation:

```powershell
.\tests\multi-instance.ps1
.\tests\multi-instance.ps1 -IncludeOfficial
```

**Not yet verified at runtime**, because it needs a live 3P gateway:

- a non-Anthropic model ID appearing in the model picker
- that ID being sent unchanged in a real request
- Anthropic model IDs still working alongside it

To run these, launch with `-Profile test`, point it at a gateway that returns a
non-Anthropic model from `/v1/models`, and select it.

---

## Repository layout

```
scripts/         entry points: inspect, patch, launch, restore, register-handler
src/js/          patch engine (Node, CommonJS, zero dependencies)
  asar.js          exact ASAR reader/writer
  pe-integrity.js  read/update the ELECTRONASAR PE resource
  patch-spec.js    THE PATCH RULES — edit this for a new release
  patch-archive.js analysis gate + rule application
  cli.js           JSON bridge for PowerShell
src/ps/          shared PowerShell module (package discovery, backups, profiles)
tests/           unit, integration, live verification, runtime profile tests
tools/           reverse-engineering helpers for inspecting a new build
docs/            architecture, maintenance, troubleshooting
```

Runtime state lives outside the repo, in `%LOCALAPPDATA%\ClaudeModelUnlocker`.

Agent guidance: [`CLAUDE.md`](CLAUDE.md).

---

## Troubleshooting

See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). The three common ones:

- **`INCOMPATIBLE`** — Claude Desktop changed the code; see `docs/MAINTENANCE.md`.
- **Portable build will not start** — run `.\scripts\inspect.ps1`; re-run `patch.ps1`.
- **Sign-in opens the Store app** — `.\scripts\register-handler.ps1 -OpenSettings`.

To get the official app back, just launch the Store-installed Claude Desktop.
It was never modified.

---

## Disclaimer

This tool modifies a **copy** of Claude Desktop's application code on your own
machine to change how it filters model IDs. It does not modify the installed
package, does not bypass authentication or licensing, and does not affect
Anthropic's servers. Use it with gateways you are entitled to use. Not
affiliated with or endorsed by Anthropic.
