# RECOVERY CHECKPOINT

## Branch & commits
- **Repository**: `dictationb1/supreme-lamp-lab`
- **Application**: `dictationb1/supreme-lamp` (pinned in `config/app-source.json` = `978a8375ee77b392ce11694ccee7722fd6ca4f71`, recorded per run)
- **Working branch (this session)**: `arena/ba4f2d55-supreme-lamp-lab`, fast-forwarded onto PR #17 head `9b74521`, carrying the increment below.
- **Stacked PRs (verify bases before any merge)**:
  - PR #15 `arena/32a8931c-...` -> `main` (open)
  - PR #16 `arena/f823d76d-...` -> `main` (open)
  - PR #17 `arena/efe7639f-...` -> **PR #16's branch** (open) — head `9b74521`
  - This session's PR: `arena/ba4f2d55-...` -> **PR #17's branch** (continues the stack). PR #17's head branch is not writable from this session (only `arena/ba4f2d55-supreme-lamp-lab` is), exactly as #16/#17 were stacked over their predecessors. A passing follow-up does not remove the need to verify #16 (and #17) after integration.

### Run history (same-attempt server + client, `capability-check.yml`)
| run | head | Windows client suite | verdict |
|---|---|---|---|
| 39560693766 attempt 2 (PR #16) | `f45c789` | 80/80 both gates; 7/9 PASS | `NOT_VERIFIED` — `rdp_auto_login` FAIL `RDP_LOGON_NOT_OBSERVED`, `web_desktop` BLOCKED behind it |
| 39569844830 (PR #17) | `89c702a` | **86/86 both gates**; 7/9 PASS | `NOT_VERIFIED` — same RDP failure, proven client-local/pre-dial (no socket to 3389 was opened) |
| 39572563363 (PR #17) | `963e584` | static 86/86; **client runner lost communication before any step reported** | `NOT_VERIFIED` — runner/infrastructure loss, no client evidence |
| 39575343527 attempt 2 (PR #17) | `9b74521` | **86/86 both gates**; 7/9 PASS | `NOT_VERIFIED` — `rdp_auto_login` FAIL `RDP_LOGON_NOT_OBSERVED` **with the RDP-file consent dialog on screen** (`mstsc` alive, `hasWindow=false`, `mstsc tcp: none`, `rdpClient` zero-match reported as "unreadable", `authLast` = stale type-2 `10:32:32` before the `10:38:40` baseline). See findings 5-8. |
| 39594245349 (PR #18) | `1af4044` | **92/92 both gates**; 7/9 PASS | `NOT_VERIFIED` — first live run of the dialog diagnostics: the consent dialog IS enumerated (owned, body text, OK/Cancel) but its XAML checkbox label is unreadable to `WM_GETTEXT`, so it classified `unknown` and the verdict stayed the generic timeout. The body-sentence rule + checkbox-style fix land next; manual consent (§2.4) still required. |

Every push triggers a full run, including documentation-only commits; the report job fails whenever the verdict is not `VERIFIED`, so a red `report` check alone is not a regression. Always read the annotations of the **newest** run for the current head SHA rather than a cached earlier run.

## Confirmed findings (evidence, not inference)
1-4. (historical, still true: lock defects fixed + reproduced; tailnet join `JOIN_OK` since 39560693766 after the operator fixed the trust credential; job logs live on a blob host this sandbox cannot reach — read **check-runs annotations** instead).
5. **Run 39569844830 proved the RDP failure is client-local/pre-dial**: server Security/TS logs show no 4624/4625 for `slabrdp` and every RemoteConnectionManager 261 on the app's 60 s self-probe cadence, while mstsc idled 90 s. Authentication was never attempted.
6. **Run 39575343527 named the client-local blocker**: a window enumeration found `mstsc(4672):"Remote Desktop Connection"` — the one-time **RDP-file consent** dialog (April 2026 Windows protection, CVE-2026-26151: "Opening Remote Desktop Connection" / "I understand and allow RDP files to open on this device for my account", unchecked, OK disabled), captured in the supplied screenshot. `Get-Process.MainWindowHandle` reported `hasWindow=false` for the same process (its heuristic only tracks unowned top-level windows — an owned/modal dialog is invisible to it).
7. **The `/api/logon-status` `$Matches` clobber is real** (verified against app source @978a837 lines 8465-8468): with any user filter (always present — the route falls back to config `rdpUser`) `logonType` is always `''`. The former "derived" workaround (type inferred from the remote source IP) is **removed**; the lab now requires the type to be proven at the same event instant by the app's XML-parsing collector (`authLast`) or reported directly. Precise app-side patch in `patches/` (**pending application defect** — the staged app is never modified while its SHA is reported unchanged).
8. **`authLast type="2" @10:32:32`** is the runner's own console logon from before the attempt baseline — never evidence of a fresh RemoteInteractive logon. "No events were found that match the specified selection criteria" is a **zero-match** result, not an unreadable channel (now kept apart in `scripts/lib/eventlog.js`).
9. **Run 39594245349 calibrated the dialog classifier live**: the consent dialog enumerates as an *owned* window (`owner=own pid`, `#32770`, title "Remote Desktop Connection") carrying a body Static ("You are opening an RDP file which will establish a connection to another computer…") + OK/Cancel; its check-box **label** is XAML and `WM_GETTEXT` returns "" for it. Classification therefore keys on the unique body sentence too, and `BM_GETCHECK` is only queried for real check-box/radio styles (plain push buttons were reported "unchecked").

## State of the work on this branch
- `scripts/lib/dialogs.js` (new): classifies enumerated windows into RDP-file consent / publisher review / certificate warning / credentials prompt / connection error; consent ⇒ `status=BLOCKED reason=RDP_FILE_CONSENT_REQUIRED` with the exact manual action and Windows account; unidentified dialog-like windows are evidence only.
- `scripts/ps/Get-RdpDialogState.ps1` (new): top-level + owned/modal windows of the launched tree in the correct session, with identifiable control texts/checked states (Edit content never read).
- `scripts/ps/Get-RdpClientDiagnostics.ps1`: event channel states (readable/zero-matches vs channel-missing vs access-denied vs query-error), dialog windows, sockets, policy facts.
- `scripts/lib/logon.js`: direct proof **or** same-instant XML correlation; `needs-type-proof` / `RDP_LOGON_TYPE_UNKNOWN`; stale/type-2/unrelated `authLast` records rejected.
- `scripts/mission-control-check.js`: dialog observation during the attempt (early abort — no 90 s generic timeout behind a known dialog), correlated per-tick type proof, `native-rdp-dialog.png` capture before cleanup.
- `scripts/rdp-consent-bootstrap.js` + RUNBOOK §2.4: one-time **manual** consent bootstrap for the client-runner account (never automated, never registry-written).
- `patches/` + REGRESSION.md defects 10-12; `scripts/run-regressions.js` now 92 tests.

## Next concrete action
1. **Operator: one-time RDP-file consent bootstrap** (RUNBOOK §2.4) on the client-runner machine **as the account that runs the client runner** (`WIN-NFU1JG4VESE\User`, session 1 in run 39575343527): `node scripts\rdp-consent-bootstrap.js --host <ip> --user slabrdp --open`, check "I understand and allow RDP files to open on this device for my account", press OK. Per-account: a different account must redo it.
2. **Fresh full run after the bootstrap, with no manual clicks/credential entry.** Expected honest outcomes: `rdp_auto_login` PASS (correlated type proof) + `web_desktop` PASS + `VERIFIED`; OR a named dialog/blocker (`RDP_FILE_SECURITY_REVIEW_BLOCKING` for the per-connection publisher review, `RDP_CREDENTIALS_PROMPT_UNATTENDED`, `RDP_LOGON_TYPE_UNKNOWN`, ...) keeping `NOT_VERIFIED` — do not label any of these as fixed.
3. **Land the app-side patch** (`patches/supreme-lamp-978a837-logon-status-matches-clobber.patch`) in `dictationb1/supreme-lamp` when its maintainers accept it (the lab token can push there, but this session only pushes its own lab branch; the patch is ready to apply), publish `ui-dist-<newsha>.zip` + `.sha256`, re-pin `config/app-source.json`.
4. Merge is **not** permitted while the required checks are red; no check may be bypassed. Merge `--merge` only after a run returns `VERIFIED` (all nine capabilities PASS in one attempt), and verify the stack order (#17's base is #16's branch; #16 still needs verification after integration).
