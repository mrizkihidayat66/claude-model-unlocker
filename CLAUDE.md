# CLAUDE.md

Guidance for agents working in this repository.

## What this project is

A patch tool for **Claude Desktop for Windows** (MSIX). The app refuses to list
or use third-party-provider model IDs that do not look Anthropic. This tool
builds a **separate, portable copy** of the installed app with that restriction
relaxed, and launches that copy. The installed MSIX package is never modified,
so official updates keep working.

Read `docs/ARCHITECTURE.md` before changing anything that touches the archive or
the executable.

## Non-negotiable constraints

These come from the original requirements. Violating one of them makes the tool
unsafe, not merely non-ideal.

1. **Never write inside `C:\Program Files\WindowsApps`.** Do not take ownership,
   change ACLs, or disable package protections. All mutation happens in
   `%LOCALAPPDATA%\ClaudeModelUnlocker`.
2. **Never fork, downgrade, or pin Claude Desktop.** The official app must keep
   updating normally.
3. **Never patch by text replacement alone.** Every rewrite is a declarative
   rule in `src/js/patch-spec.js` with an exact expected match count and a probe
   for the already-patched form. If the counts do not line up, the tool must
   **refuse and explain**, never guess.
4. **Do not hardcode third-party model names or build an allowlist.** Any valid
   ID the provider returns must be accepted.
5. **Do not touch** endpoints, authentication, the wire protocol, model IDs,
   tier/slot mapping, request/response transformation, tool calling, streaming,
   or the `anthropic` / `bedrock` / `vertex` / `foundry` provider branches.
6. **Preserve the ASAR writer's losslessness.** `tests/integration/roundtrip.js`
   must stay byte-identical; it is the proof that a rebuild cannot corrupt an
   archive.
7. **Never claim success without evidence.** Run `tests/verify.ps1` and report
   its actual output. Separate confirmed facts from hypotheses.

## Safety rules for this machine

The agent harness runs as `claude.exe` under
`%LOCALAPPDATA%\Claude-3p\claude-code\<version>\<hash>\claude.exe`.

- **Never** run `Get-Process claude | Stop-Process`, `taskkill /IM claude.exe`,
  or any unfiltered kill of `claude.exe`. That kills the harness (it has
  happened twice).
- Only stop processes whose `ExecutablePath` is under
  `%LOCALAPPDATA%\ClaudeModelUnlocker\portable\`, or which descend from a PID
  this script started. `tests/multi-instance.ps1` already does this correctly;
  copy its `Get-DescendantIds` / `Stop-TrackedProcesses` pattern.
- Electron spawns many `claude.exe` children (`--type=renderer`,
  `--type=gpu-process`, `--type=utility`, `--type=crashpad-handler`). When
  counting instances, filter out `--type=` and restrict to the portable path.

## Layout

```
scripts/         user-facing PowerShell entry points (run these)
src/js/          patch engine (Node, CommonJS, no dependencies)
src/ps/          shared PowerShell module, dot-sourced by every script
tests/           unit + integration tests, live verification, runtime tests
tools/           reverse-engineering helpers for inspecting a new build
docs/            architecture, maintenance and troubleshooting
```

## How to run things

```powershell
.\scripts\inspect.ps1          # read-only: version, patch state, compatibility
.\scripts\patch.ps1 -DryRun    # analyse only; writes nothing
.\scripts\patch.ps1 -Launch    # rebuild the portable copy and apply the patch
.\scripts\launch.ps1           # start the patched build with an isolated profile
.\scripts\restore.ps1          # re-seed the portable copy from the package
.\tests\verify.ps1             # static verification against the installed build
```

```bash
npm test                       # unit + synthetic-archive tests (no install needed)
```

```powershell
.\tests\powershell\backup-store.tests.ps1   # backup store, against a temp runtime root
```

`CLAUDE_MODEL_UNLOCKER_HOME` relocates the runtime directory; use it for any
test that must not touch the real deployment.

## When a Claude Desktop update breaks the patch

`.\scripts\inspect.ps1` reports `incompatible`. Follow `docs/MAINTENANCE.md`.
The short version:

1. Locate what changed with `tools/archive-search.js` (the archive does not need
   to be extracted).
2. Update the affected rule in `src/js/patch-spec.js`: `pattern`, `probe`,
   `expectTotal`, `replacement`.
3. Bump `SPEC_VERSION` in that file.
4. Run `npm test`, then `.\tests\verify.ps1`.
5. Re-run `.\scripts\patch.ps1` and confirm the portable build launches.

## Code style

- **Node**: CommonJS, `'use strict'`, two-space indent, single quotes, semicolons,
  no external dependencies, Node 22+ built-ins only. Every module starts with a
  block comment stating its contract.
- **PowerShell**: `[CmdletBinding()]` on every script and function, approved verb
  names, 4-space indent, `$ErrorActionPreference = 'Stop'` at the top, and
  comment-based help (`.SYNOPSIS` / `.DESCRIPTION` / `.PARAMETER` / `.EXAMPLE`).
  Use the `Write-Step` / `Write-Info` / `Write-Ok` / `Write-Warn` / `Write-Fail`
  helpers from `src/ps/Common.ps1` instead of raw `Write-Host` colour calls.
- **Docs**: short declarative sentences, no marketing tone, commands in fenced
  blocks tagged `powershell` or `bash`.

## Things that are easy to get wrong

- **The ASAR digest covers the header JSON only** (bytes 16 .. end of JSON), not
  the whole file. See `src/js/asar.js`.
- **The integrity resource is length-fixed.** A SHA-256 hex digest is 64 chars,
  so it can be rewritten in place; the writer refuses if the serialized resource
  would change length.
- **`compile-cache/*.jsc` entries hold bytecode compiled from the pre-patch
  sources** and must be dropped, otherwise the app runs stale code.
- **The portable `claude.exe` must be re-digested**, or Electron aborts at
  startup with `FATAL: Integrity check failed`.
- **`CLAUDE_USER_DATA_DIR` is deleted by the app's own startup sanitizer** in
  packaged builds, which is why profiles need rule 3.
- **`claude://` callbacks cannot carry environment variables**, hence
  `auth-profile.txt`.
