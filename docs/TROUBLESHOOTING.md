# Troubleshooting

## `patch.ps1` says INCOMPATIBLE

Claude Desktop changed the code the rules target. The patch refuses rather than
guessing, and nothing was modified. Follow `docs/MAINTENANCE.md`.

Quick look at what the new build contains:

```bash
node tools/archive-search.js <path-to-app.asar> 'case"gateway"'
```

## The portable build will not start

```powershell
.\scripts\inspect.ps1
```

It verifies that the portable archive's digest matches the digest embedded in the
portable `claude.exe`. If the state is `inconsistent`, re-run
`.\scripts\patch.ps1`.

If it still fails, check the app's own log at
`%LOCALAPPDATA%\ClaudeModelUnlocker\profiles\<name>\Logs\main.log`.

## A second instance exits immediately, or its profile stays empty

1. Confirm the portable build was patched by the current version:
   `.\scripts\inspect.ps1` should report `patched` for the portable copy.
2. Launch through `.\scripts\launch.ps1 -Profile <name>`. Two launches with the
   *same* profile name are expected to share one instance.
3. Look for `CLAUDE_USER_DATA_DIR is set and signed builds ignore it` in
   `<profile>\Logs\main.log`. If present, rule 3 is not applied.

## Sign-in opens the Store app

The portable log shows `desktop_login_callback_evicted`.

```powershell
.\scripts\register-handler.ps1 -OpenSettings
```

Then choose **Claude (Portable)** for **CLAUDE** in Default Apps. Verify:

```powershell
.\scripts\register-handler.ps1 -Status
```

`Windows UserChoice ProgId` must be `claude`, not an `AppX…` value. The Store
package itself is untouched.

## `node.exe was not found on PATH`

Install Node.js 22 or newer. No `npm install` is needed: the patch engine has no
dependencies.

## `PE has no INTEGRITY/ELECTRONASAR resource`

The executable you pointed at is not the Claude Desktop build, or the integrity
mechanism changed. `inspect.ps1` always uses the installed package and the
portable copy, so this usually means a hand-built path. See
`docs/MAINTENANCE.md` → "If the integrity mechanism changed".

## Backups are taking too much space

Backups are content-addressed and deduplicated, and only `app.asar` is stored
(`claude.exe` is re-derivable). Inspect and prune:

```powershell
.\scripts\restore.ps1 -ListBackups
.\scripts\restore.ps1 -PruneBackups -KeepDays 14 -KeepLast 5
```

## I want the official app back

Just launch the Store-installed Claude Desktop. It was never touched.

To remove the portable side entirely:

```powershell
.\scripts\restore.ps1 -RemovePortable
.\scripts\register-handler.ps1 -Unregister
```

Then change the CLAUDE link default back in Default Apps if you had changed it.
