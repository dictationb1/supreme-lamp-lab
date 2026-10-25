# Mission Control ලැබීමේ අගය — ලැබීගැනීම (Lab Final Report) · 2026-10-25

**ලැබීගේ සංඛ්‍යාව (branch):** arena/677dde66-supreme-lamp-lab (dictationb1/supreme-lamp-lab)
**යෙදුම් කොටසය (application repository):** dictationb1/supreme-lamp (මෙය read-only; මෙම session එකෙන් මෙය ලියාපදිංචි කර නොහැක)
**පරීක්ෂා කරන ප්‍රසංග (candidate):** f66f9485649d5520a787d66496fffd43d8aa772a (application main, 2026-10-25T15:40:21Z)
**PR #88 අගය:** 5f175a6db83cdd57132f8ee36cc220e21b506f6c (squash merge; f06017fe මගේ; 2026-10-25T15:11:18Z දින වරට මිලියන කියවීමක් නොවේ)
**UI නිර්මාණය:** ui/dist/index.html · sha256 9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff · 1,312,534 bytes (application එකේ handoff අගය වෙන්ව සමාන)

---

## අගය 1: මෙම session එක අදාල දේ

1. Application එකේ current main එක full immutable SHA එක ගනුලියකර ගැනීම: f66f9485649d5520a787d66496fffd43d8aa772a. මේ 27 commits ahead එක PR #88 merge 5f175a6. 27 commits දෙකම status updates සහ docs (#89) — src/ තුළ වැඩිපෙර නැත.
2. Handoff ගැන (docs/reports/mission-control-current-handoff.json): මෙම branch `arena/046926e8-supreme-lamp`, baseRevision ae360351, baseMainRevision e067bcef. Repairs D1–D8 සඳහා state "done". PR #88 එක MERGED.
3. Deployment එක BLOCKED-403: main.yml එක dispatch කරන්නෙ API එකෙන් නොපවතී (HTTP 403 Resource not accessible by integration). Operator එක GitHub UI එකෙන් `Run workflow` කර, branch main, mode rdp, runner_target windows-latest වලංගු කරන්න. head SHA 5f175a6 (යමේ 4a91c5c2 නමුත් නොමැත).
4. Historical run 40193924876 (head 644476b) එක මෙම candidate එකේ ප්‍රමාණය නොවේ — ඒ යැයි නැත්නම් ප්‍රතිඵල නොකළ යුතුය.

## අගය 2: මෙම application එකේ repairs (D1–D8 + D9 + D10)

PR #88 අගය 5f175a6 එක current main @ f66f9485 එකට දැනටමත් ඇත (ancestor). එක් දෙක දරන්න පුළුල් නැත:

| # | Repair | ස්ථානය | තත්ත්තවය |
|---|---|---|---|
| D1 | One dispatch per intent (එකක් click, එකක් dispatch) | src/lib/domain/dispatch.ts, api.ts, sessionStore.ts | තේරුමේ ඇත (present in source) + vitest PASS |
| D2 | Cancellation/recovery correlation | src/lib/domain/native.ts, PrimaryActions.tsx | තේරුමේ ඇත |
| D3 | Native publisher warning vs cmdkey (replay guard) | payloads/ghrdp-rdp-launcher.cs | තේරුමේ ඇත; runtime පවසනවා (Windows compiler/VM නැත) |
| D4 | awesome.re redirect allowlist | payloads/ghrdp-server.ps1 | තේරුමේ ඇත |
| D5 | /api/lab/inspect mode-first, one budget | payloads/ghrdp-server.ps1, src/api/lab/index.ts | තේරුමේ ඇත |
| D6 | Single repository identity (dictationb1/supreme-lamp) | src/lib/repoIdentity.ts + 6 call sites | තේරුමේ ඇත |
| D7 | Occurred/observed/resolved timestamps | src/lib/overview/issues.ts | තේරුමේ ඇත |
| D8 | Production bundle එක demo rows නැත | devMode, devFixture, Search.tsx | තේරුමේ ඇත; artifact එක measured: කොහොමද fx-snap-01 / "Pride and Prejudice" නැත |
| D9 | /api/logon-status $Matches clobber | payloads/ghrdp-server.ps1 | තේරුමේ ඇත (යොදවා $ltM ලියන විට user filter එක පවසනවා) |
| D10 | MC-SIGNAL live publisher | .github/workflows/main.yml | තේරුමේ ඇත |

**මෙම session එක application එකක navara patch එකක් ලබා ගැනීමේ අපි නැත** — සියල්ල දැනටමත් main එකේ ඇත. patches/series.txt එක මේ සදහා ලියාපදිංචි කර ඇත.

## අගය 3: පරීක්ෂණ අගය

- `npx tsc --noEmit -p tsconfig.build.json` → 0 දෝෂ (PASS)
- `npx vitest run` → 118 files / 1535 tests, 0 දෝෂ (PASS). Handoff එක සමාන (118/1535/0).
- `npm run build` → 9315cdc8... (1,312,534 bytes) — handoff artifact වගේ සමාන.
- Lab regressions (`node scripts/run-regressions.js`) → 162 pass, 0 fail, 8 skip (skip දෙක Windows PowerShell / browser වලට පහර දීම).

## අගය 4: දැන් තත්ත්වය (verdicts)

| Control | තත්ත්වය | හේතු |
|---|---|---|
| LAB_HARNESS | PASS | 162 pass / 0 fail / 8 skip |
| PATCHED_APPLICATION_CANDIDATE | PASS | f66f9485; සියල්ල repairs ඇත; 1535/1535; tsc PASS; build sha සමාන |
| USER_VM_ACCEPTANCE | NOT_RUN | මෙම Linux sandbox එකේ Windows VM එකක් නැත (mstsc, consent dialog, cmdkey, .rdp අගය පරීක්ෂා නොවේ) |
| LIVE_ORIGIN_APPLICATION | BLOCKED | Deployment 403; අවසරයක් උත්සාහ කර, නැවත නැත |
| AUTOMATIC_ATTACHMENT | NOT_RUN | Windows self-hosted runner එක නැත; untrusted fork code එකට attach කරන්නේ policy අනුව නොමැත |
| UPSTREAM_DEPLOYMENT | BLOCKED | dictationb1/supreme-lamp එක write නොමැත (403). Application repository එක මෙම session එකෙන් patch කර නැයි. |

## අගය 5: සියල්ල නොකළ දේ (remaining prerequisites)

1. ui-dist-<f66f9485>.zip + .sha256 එක application එකේ ui-dist release එකට publish කරන්න — යමෙන් 403 මගේ අවසරය.
2. main.yml (mode=rdp, runner_target=windows-latest) එක GitHub UI එකෙන් dispatch කර (operator action).
3. rdp-lab-client (WIN-NFU1JG4VESE\User, session 1) එකේ USER_VM_ACCEPTANCE — launch, cancel, native prompts, search, links.
4. Launcher C# runtime proof (ghrdp-rdp-launcher.exe එක compile කර double-open කරන්න).
5. PowerShell /api/lab-එක එකතු පරීක්ෂණය (pwsh එක මෙම host එකේ නැත).
6. Live awesome.re fetch (sandbox outbound network restricted).

## අගය 6: අවසන් විමසීම

Application එක (f66f9485) සඳහා අපි ගොඩනැගූ සියල්ල දැනටමත් තේරුමේ ඇත: single-dispatch launch, cancellation correlation, native prompt classification, search result inspection, honest links, no-demo production bundle. 1535/1535 පරීක්ෂණ සමත්, tsc දෝෂ 0.

පහරිම අගය: යමෙන් අපි Windows VM එකෙන් පවසන්න නෑ (USER_VM_ACCEPTANCE = NOT_RUN), deployment එක 403 මගේ අවසරය (BLOCKED). ඒවා අපි "PASS" ලෙස නොසැලකේ — සත්‍ය භාවිතය නොකරන්න.

ඊට අදාළ: MAIN-PROMOTION-PROMPT.md එක — එක main-only session එකක remaining application repairs (ම᷅යෙ මේ කිසිදා නැත) apply කර, tests එක run කර, promote කරන්න අපි දැනට තේරුම් දක්වයි.

## Immutable links

- Application candidate: https://github.com/dictationb1/supreme-lamp/tree/f66f9485649d5520a787d66496fffd43d8aa772a
- PR #88: https://github.com/dictationb1/supreme-lamp/pull/88
- Handoff JSON: https://raw.githubusercontent.com/dictationb1/supreme-lamp/f66f9485649d5520a787d66496fffd43d8aa772a/docs/reports/mission-control-current-handoff.json
- Lab bundle tree: https://github.com/dictationb1/supreme-lamp-lab/tree/arena/677dde66-supreme-lamp-lab
