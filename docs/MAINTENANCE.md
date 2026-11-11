# Maintenance

What to do when a Claude Desktop update breaks the patch.

## Symptom

```
.\scripts\inspect.ps1
...
    [incompatible] gateway-validator-relaxed
                   Gateway provider accepts any model ID (found 0/2)
    [ERROR] This archive is INCOMPATIBLE with the current patch rules.
```

`patch.ps1` exits with code 2 and writes nothing. The portable copy is left
holding the pristine archive for the new version, so the Store app is unaffected.

## Step 1 — find out what changed

The rules match on structure, so you need to see the new structure. Work against
the installed archive directly; it does not need to be extracted.

Find the rule that failed, then search for a fragment you expect to be nearby:

```bash
node tools/archive-search.js "C:\Program Files\WindowsApps\Claude_<ver>_x64__pzs8sxrjxfjjc\app\resources\app.asar" 'case"gateway"'
```

Other helpers:

| Command | Use |
|---|---|
| `node tools/archive-search.js <asar> <regex>` | regex search with context (`--before`, `--after`, `--max`, `--entry`, `--literal`, `--json`) |
| `node tools/find-all.js <asar> <term>` | plain-term search across every JS entry, wide context |
| `node tools/archive-slice.js <asar> <suffix> <start> <end>` | print a byte range of one entry |

For the full picture, extract once and scan:

```bash
npx @electron/asar extract app.asar extracted
node tools/scan-anchors.js extracted
node tools/scan-providers.js extracted
```

`scan-providers.js` tells you which provider option values exist. If `mantle` was
renamed or a new gateway value appeared, that is your first lead.

## Step 2 — update the rule

Edit the affected rule in `src/js/patch-spec.js`. Each rule needs all of:

| Field | Meaning |
|---|---|
| `pattern` | global regex matching the fragment to rewrite, in the **pre-patch** form |
| `replacement` | string, or `(match, ...groups) => string` |
| `probe` | global regex matching the **already-patched** form |
| `expectTotal` | exact matches required across the whole archive |
| `perFile` | max matches allowed in any one file |
| `title`, `why` | one-line summary and rationale, shown in reports |

Rules to keep:

- **Anchor on punctuation and keywords**, never on minified identifiers. Use
  `[A-Za-z0-9_$]+` for anything the minifier may rename, and back-reference the
  groups (`\2`, `\3`) so the replacement reuses whatever names exist.
- **Keep the counts exact.** `expectTotal` is the safety mechanism. If a
  fragment legitimately appears more often now, update the number *and* explain
  why in `why`.
- **Write the probe first.** Derive it from the replacement, then confirm the
  pristine archive does not match it.
- **Never relax a provider you were not asked to relax.** `anthropic`, `bedrock`,
  `vertex` and `foundry` must keep their own validators.

Then bump `SPEC_VERSION` at the top of the file.

## Step 3 — prove it

```bash
npm test
```

```powershell
.\tests\verify.ps1
```

`npm test` runs against synthetic archives and proves the rules are internally
consistent. `tests\verify.ps1` proves they match the real installed build:
byte-exact round-trip, exactly the intended substitutions, other providers
untouched, idempotency, and the fail-safe path.

Both must pass before you run the patcher.

## Step 4 — deploy and confirm

```powershell
.\scripts\patch.ps1 -Launch
```

The patcher re-seeds from the installed package, applies the rules, updates the
digest in the portable `claude.exe`, and re-verifies the result. If the build
does not start, run `.\scripts\inspect.ps1`; a digest mismatch means the patch
did not complete.

## If the ASAR format itself changed

Symptoms: `round-trip is byte-identical` fails, or the archive will not parse.

1. Dump the first 64 bytes and compare against the documented layout in
   `docs/ARCHITECTURE.md` §4.
2. Check `node_modules/asar`'s current `readArchive`/`writeArchive` to see whether
   the pickle framing or integrity scheme changed.
3. Update `src/js/asar.js` and re-run `tests/integration/roundtrip.js` against a
   real archive.

Do not "fix" the round-trip by loosening the test. Losslessness is the guarantee
that a rebuild cannot corrupt the app.

## If the integrity mechanism changed

Symptoms: the app aborts with `FATAL: ... Integrity check failed`, or
`pe-integrity.js` throws `PE has no INTEGRITY/ELECTRONASAR resource`.

- Inspect the executable's resources with any PE viewer and confirm where the
  `INTEGRITY` resource now lives.
- If Electron switched to a different fuse or algorithm, the digest length may
  change. `updateIntegrity` refuses to write when the serialized resource would
  change length, by design: rewriting a PE resource at a different length
  requires moving sections.
- Check the Electron version's `asar_util.cc` for the hashing rule. As of Claude
  Desktop 4.23118.1.0 it is SHA-256 over the header JSON bytes only.

## If profiles stop isolating

Symptoms: a second instance exits immediately, or its profile stays empty. Look
for `signed builds ignore it` or `single-instance lock` in
`<profile>\Logs\main.log`.

Rule 3 targets the exact shape of the startup sanitizer. Re-locate it with:

```bash
node tools/archive-search.js <asar> 'CLAUDE_USER_DATA_DIR'
```

Update the `pattern`/`probe` pair, and re-check that `auth-profile.txt` recovery
is still part of the replacement.

## If `claude://` sign-in stops working

The portable app must own the protocol. Confirm with:

```powershell
.\scripts\register-handler.ps1 -Status
```

`Windows UserChoice ProgId` should be `claude`, not an `AppX…` value. If the
Store package keeps winning, the MSIX manifest still claims the protocol; the
per-user Default Programs entry is the supported way to override it.

## Keeping this document current

When you change a rule, update the table in `docs/ARCHITECTURE.md` §2 as well.
When you change a layout, update §7 and `CLAUDE.md`. A maintenance document that
describes the previous design is worse than none.
