# RECOVERY CHECKPOINT — PR #18 follow-up (2026-10-21)

If this session ends early, this file is the resume point.

## Where the work is

| item | value |
|---|---|
| lab repository | `dictationb1/supreme-lamp-lab` |
| session branch (this work) | `arena/44280da4-supreme-lamp-lab`, based on PR #18's head `a22353a` |
| PR #18 branch (other session, **not writable from here**) | `arena/ba4f2d55-supreme-lamp-lab` @ `a22353a` |
| stack | #16 (`arena/f823d76d`) → #17 (`arena/efe7639f`) → #18 (`arena/ba4f2d55`) → this branch |
| application repository | `dictationb1/supreme-lamp` @ `978a837` pinned; `main` `daf13685` differs only in `docs/status.json` |

## What is DONE in this branch

1. **SETUP procedure for the one-time RDP-file consent** (bounded, explicitly not
   a verification run): `workflow_dispatch` `mode=consent-setup`,
   `setup_timeout_ms` ≤ 900000, step `timeout-minutes: 16`,
   `scripts/rdp-consent-setup.js`, `scripts/lib/consent-state.js`,
   `scripts/setup-summary.js` (`verdict: NO_VERDICT_SETUP_MODE` — a SETUP run can
   never be reported as `VERIFIED`).
2. **Bootstrap made safely executable**: `scripts/lib/rdp-target.js` refuses
   placeholders/loopback/documentation/URL/CIDR/bare-hostname targets, strict
   argument parsing (unknown flag ⇒ exit 64), and the operator text prints the
   account, session, checkout directory and target. `lib/dialogs.js` no longer
   ships a `<server-ip>` placeholder.
3. **Logon contract tightened**: intended-user echo required, attempt window
   bounded at both ends, cross-check cannot confirm through another account's
   event (`scripts/lib/logon.js`, verified by new tests).
4. **RUNBOOK §2.4 rewritten**: verified CVE-2026-26151 attribution (MSRC + NVD),
   the two dialog families kept separate, exact account/session, checkout
   directory, checkbox/button, how to confirm the setup finished, bounded SETUP
   vs manual fallback, and the honest limits (Cancel == OK cosmetically;
   `NO_DIALOG_SEEN` is not consent; consent persistence across re-image is
   unverified).
5. **Regression suite 100 tests** (was 92): 92 pass / 0 fail / 8 platform-skips on
   Linux (7 browser-e2e need Chromium; 1 is the real-PowerShell test that runs
   on the Windows client job). New gates cover target validation, bootstrap
   strictness, the consent state machine, SETUP-verdict separation, the user-echo
   / time-window / cross-check identity rules, and a real-PowerShell
   reproduction of the `$Matches` clobber (Windows-only).
6. **Application defect: patch + test delivered, still PENDING.**
   `patches/` holds the 2-line fix and the test; measured locally
   (3/3 pass with the fix, 2/3 fail unpatched). **It could not be landed**: this
   credential can read `dictationb1/supreme-lamp` but not write to it
   (`git push` → 403, API ref creation → `Resource not accessible by
   integration`). The observer defect is **not fixed**.

## What is NOT done (and why)

- **The account consent itself.** Run 39598371464 (attempt 1, `a22353a`)
  conclusively shows the dialog on screen, ungranted, for
  `WIN-NFU1JG4VESE\User` (session 1). Only a human at that desktop can check the
  box. Until then `rdp_auto_login=BLOCKED / RDP_FILE_CONSENT_REQUIRED`,
  `web_desktop=BLOCKED` behind it, verdict `NOT_VERIFIED` — correctly.
- **A fresh unattended acceptance run** (all nine capabilities) — needs the
  consent first. Do not launch repeated full runs against this known block.
- **Merging the stack** — requires a passing candidate; see above.

## Next concrete action

1. Dispatch **`mode=consent-setup`** on this branch (bounded, ≤15 min).
2. While it is open, on `WIN-NFU1JG4VESE\User` session 1: check
   *"I understand and allow RDP files to open on this device for my account"*,
   press **OK**.
3. Confirm the SETUP state is `CONSENT_DIALOG_CLEARED` / `SESSION_CONNECTED`
   (**not** `…CLOSED_UNCONFIRMED`, which is what Cancel produces, and **not**
   `NO_DIALOG_SEEN`, which proves nothing).
4. Dispatch **`mode=full`**. It must pass with no manual clicks and no
   credential entry. Only that run can be `VERIFIED`.
5. If a *publisher/security-review* dialog (Caution: Unknown remote connection)
   blocks it instead: that is `RDP_FILE_SECURITY_REVIEW_BLOCKING`, a different
   protection. Documented scope: an organization-trusted `.rdp` publisher
   (signed `.rdp` + trusted-publisher policy) — an operator decision, not a lab
   change, and never a global warning suppression.
6. With a passing candidate: integrate #18 → #17's branch, verify updated #17,
   integrate → #16's branch, verify updated #16, then merge #16 to `main`; then
   inspect the `main` push run and, if permitted, one manual `workflow_dispatch`
   full verification.

## Evidence pointers

- run 39598371464 (`a22353a`): `rdp_auto_login=BLOCKED RDP_FILE_CONSENT_REQUIRED`,
  `web_desktop=BLOCKED DEPENDS_ON_RDP_SESSION`, 7 capabilities PASS, both
  regression gates 92/92, `native-rdp-dialog.png` captured, `verdict=NOT_VERIFIED`.
- run 39596760458 (`8c6e01d`): same classification (first run to name the dialog).
- run 39594245349 (`1af4044`): initial dialog classification calibration.
- Job logs/artifacts are on the Actions results blob host, which this session's
  sandbox cannot reach; everything quoted above comes from the check-run
  annotations API and repository source.
