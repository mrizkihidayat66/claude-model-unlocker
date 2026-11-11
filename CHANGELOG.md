# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`SPEC_VERSION` in `src/js/patch-spec.js` versions the patch rules themselves; it
changes whenever a pattern, replacement or expected count changes.

## [1.0.0] - 2026-11-11

Repository restructure and correctness fixes. No change to what the patch does
to Claude Desktop.

### Added

- `CLAUDE.md` with project constraints, safety rules, code style and the
  procedure for a new Claude Desktop release.
- `docs/ARCHITECTURE.md`, `docs/MAINTENANCE.md`, `docs/TROUBLESHOOTING.md`.
- Content-addressed backup store with deduplication, verification before restore,
  retention pruning and `restore.ps1 -ListBackups` / `-PruneBackups`.
- `tests/unit` (ASAR writer, patch-spec contract) and `tests/integration`
  (synthetic end-to-end flow) using the Node test runner. No install required.
- `tests/integration/verify.js`: version-independent verification, replacing the
  suite that hardcoded a build number, an absolute `WindowsApps` path and a
  chunk file name.
- `tools/archive-search.js`, `tools/find-all.js`, `tools/archive-slice.js` for
  inspecting a new build without extracting it.
- `package.json` scripts, `.gitignore`, `.gitattributes`, `.editorconfig`.
- `-Json` output on `inspect.ps1`, and meaningful exit codes
  (`0` ok, `2` incompatible).

### Changed

- Layout: entry points in `scripts/`, engine in `src/js/`, PowerShell module in
  `src/ps/`, tests in `tests/`, helpers in `tools/`. Backups moved out of the
  repository entirely.
- `launch-3p.ps1` → `scripts/launch.ps1`; every script now uses the shared
  `Common.ps1` instead of duplicating paths.
- `restore.ps1` re-seeds from the installed package by default, which always
  yields a build matching the installed version. `-FromBackup` is now the opt-in
  path for restoring an earlier archive.
- `inspect.ps1` reports rule titles and per-file locations.
- `patch.ps1` refreshes the portable copy automatically when the installed
  package version changes (`.source-version` marker).

### Fixed

- `patch.ps1` backed up the portable archive **after** overwriting it with the
  pristine one, so every "prepatch" backup was a second copy of the unpatched
  archive. All 11 legacy backups were confirmed byte-identical to the installed
  `app.asar`.
- `patch.ps1 -KeepBackup` was accepted but did nothing.
- `restore.ps1` could copy a stale `claude.exe` from an old backup over the
  current build, producing a mismatched digest.
- The Node bridge merged stderr into stdout, so any Node warning broke JSON
  parsing.
- `restore.ps1` resolved backup paths from the recorded source path, which could
  point outside the portable copy.
- `patch-spec.js` rule 4 comment contained a mojibake sequence.
- `backups/` held 3.4 GB of near-duplicate archives inside the repository.

### Removed

- `HANDOVER.md` (superseded by `CLAUDE.md` and `docs/`).
- `lib/verify-all.js`, `lib/roundtrip-test.js`, `lib/future-update-test.js`
  (replaced by `tests/`), and the `lib/` layout.
- `work/` scratch directory.

## [0.9.0] - 2026-11-10

- Rule 4 (`gateway-context-fields`): read `context_length` / `max_model_len` at
  the `/v1/models` parser instead of forcing the 1M flag on every model.
- Multi-instance support via isolated `CLAUDE_USER_DATA_DIR` profiles.
- `claude://` per-user handler registration for portable sign-in.
