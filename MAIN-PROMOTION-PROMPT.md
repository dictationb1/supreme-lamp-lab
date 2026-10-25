# MAIN promotion prompt — Mission Control application (dictationb1/supreme-lamp)

**Purpose.** Allow a later main-only session to apply ONLY the remaining
application repairs, preserve newer code, run their tests, and promote safely.
**Nothing in this prompt claims the application repository has been patched by
the lab.** The lab session (arena/677dde66-supreme-lamp-lab) is read-only on
dictationb1/supreme-lamp (git push and POST /git/refs both return HTTP 403).
No application branch, PR or commit was created by the lab.

---

## 1. What this session found (read-only discovery, immutable links)

Lab bundle (this repo): https://github.com/dictationb1/supreme-lamp-lab/commit/811ba63
Lab bundle tree: https://github.com/dictationb1/supreme-lamp-lab/tree/arena/677dde66-supreme-lamp-lab

Application candidate tested (read-only clone, full immutable SHA):
- https://github.com/dictationb1/supreme-lamp/tree/f66f9485649d5520a787d66496fffd43d8aa772a
- Raw: https://raw.githubusercontent.com/dictationb1/supreme-lamp/f66f9485649d5520a787d66496fffd43d8aa772a
- UI build evidence: ui/dist/index.html sha256
  9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff,
  1,312,534 bytes (matches the application's own handoff artifact)

Handoff (application repo):
- https://raw.githubusercontent.com/dictationb1/supreme-lamp/f66f9485649d5520a787d66496fffd43d8aa772a/docs/reports/mission-control-current-handoff.json

## 2. Remaining application repairs: NONE

Every defect found during discovery (D1–D8 plus the /api/logon-status
`$Matches` clobber and the MC-SIGNAL live publisher) is ALREADY MERGED into
application main at f66f9485 via PR #88:

- PR #88: https://github.com/dictationb1/supreme-lamp/pull/88
- Merge commit: https://github.com/dictationb1/supreme-lamp/commit/5f175a6db83cdd57132f8ee36cc220e21b506f6c
- Merged: 2026-10-25T15:11:18Z; head f06017fe598fbff0408ee963f2e6c21c815f216a
- 5f175a6 is an ancestor of f66f9485 (27 intervening commits are status updates +
  docs #89 only; src/ is identical between 5f175a6 and f66f9485)

Therefore **this main-only session must NOT apply any application patch**. The
lab's patches/series.txt explicitly records "no additional application patch
required". Applying the historical patches cut against the OLD pins (978a837 /
daf13685) to current main would be wrong — they were already superseded by PR
#88.

If a later session discovers a genuinely new, unmerged application defect, cut
the patch against f66f9485 (current main), preserve newer code, and apply only
that one patch. Do not apply patches twice.

## 3. Exact tested identities

| Item | Value |
|---|---|
| Application base pin before session | 978a8375ee77b392ce11694ccee7722fd6ca4f71 |
| Application main when branch cut | e067bcef5ff97287bbc79345fa6a55cd8f3fcf31 |
| Application candidate tested | f66f9485649d5520a787d66496fffd43d8aa772a |
| PR #88 merge (already in candidate) | 5f175a6db83cdd57132f8ee36cc220e21b506f6c |
| UI build artifact sha256 | 9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff |
| UI build bytes | 1,312,534 |
| Lab bundle commit | 811ba63 |

## 4. Verification to run (main-only session)

From a fresh clone of dictationb1/supreme-lamp at f66f9485 (or current main if
newer; confirm 5f175a6 is still an ancestor):

```bash
git clone https://github.com/dictationb1/supreme-lamp.git
cd supreme-lamp
git checkout f66f9485649d5520a787d66496fffd43d8aa772a   # or current main
npm install --no-audit --no-fund
npx tsc --noEmit -p tsconfig.build.json              # expect 0 errors
npm run build                                        # ui/dist/index.html
npx vitest run                                       # expect 118 files / 1535 tests / 0 failed
sha256sum ui/dist/index.html                         # expect 9315cdc8... (1,312,534 bytes)
```

Acceptance gate: all three commands must pass. If any fails, STOP — do not
promote. Record the failure and do not treat it as the lab's result.

## 5. What the lab already proved (do not re-derive as "new")

- Single dispatch per intent: LaunchDispatcher — one ticket, one navigation,
  duplicate suppression (dispatch-single-attempt 19, launch-store 11).
- Cancellation/recovery correlation: event-time + account + correlation +
  attempt-window binding; no stale "wrong password" (rdp-recovery-correlation 18).
- Native prompt classification: browser consent / unknown publisher / TLS /
  cmdkey fallback / credential prompt distinguished; no auto-approve.
- Search: awesome.re per-source redirect allowlist; /api/lab/inspect mode-first,
  one budget, one pipeline; stored-source vs sourceUrl inspection.
- Links: single repository identity dictationb1/supreme-lamp (repo-identity-links 6).
- Production bundle: no demo rows (artifact measured, sentinel count 0).
- /api/logon-status logonType real (no $Matches clobber).
- MC-SIGNAL live publisher present.

All proven at f66f9485: 118 vitest files / 1535 tests, 0 failed; tsc 0 errors.

## 6. What remains NOT proven by this session (honest scoping)

| Control | State | What closes it |
|---|---|---|
| USER_VM_ACCEPTANCE (real mstsc/consent/cmdkey/.rdp signature on rdp-lab-client) | NOT_RUN | Windows VM + operator; lab §2 steps A–F |
| Launcher C# runtime (ghrdp-rdp-launcher.exe compile + double-open old link) | STRUCT-PASS only | main.yml Windows job |
| PowerShell /api/lab-route runtime (both inspect modes) | NOT_RUN | pwsh + main.yml readiness run |
| Live awesome.re fetch | NOT_RUN | VM with outbound network |
| Deployment (main.yml mode=rdp, runner_target=windows-latest) | BLOCKED-403 | GitHub UI dispatch, head SHA f66f9485 |

These are prerequisites, not defects. Do not label them PASS.

## 7. Deployment (operator action only — not automatable from API)

The dispatch API returns HTTP 403 (Resource not accessible by integration) for
this session's credential. Attempted once, not retried (deterministic).

Operator must open the GitHub Actions UI:
https://github.com/dictationb1/supreme-lamp/actions/workflows/main.yml
1. Click "Run workflow" (right side)
2. Branch: main | mode: rdp | runner_target: windows-latest | other inputs default
3. Click "Run workflow"
4. The new run's head SHA must start with `5f175a6` (the PR #88 merge) — any
   other SHA is an older revision.
5. The dashboard URL the run publishes is the USER_VM_ACCEPTANCE surface.

## 8. Rollback

Application base before this session: 978a8375ee77b392ce11694ccee7722fd6ca4f71.
No application repository was written by the lab (read-only). Rolling back the
lab means reverting commit 811ba63 on arena/677dde66-supreme-lamp-lab; the
application remains at f66f9485 untouched.

## 9. Ready-to-paste summary for the main-only session

> Test dictationb1/supreme-lamp @ f66f9485649d5520a787d66496fffd43d8aa772a
> (current main; contains PR #88 merge 5f175a6). Run: npm install,
> npx tsc --noEmit -p tsconfig.build.json (0 errors), npm run build,
> npx vitest run (118 files / 1535 tests / 0 failed), sha256sum ui/dist/index.html
> = 9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff
> (1,312,534 bytes). No application patch remains to apply — all repairs are
> already merged. Then operator-triggers main.yml (mode=rdp,
> runner_target=windows-latest) from the GitHub Actions UI (dispatch API returns
> 403 for this credential). USER_VM_ACCEPTANCE on rdp-lab-client remains
> NOT_RUN pending a Windows VM.

---

## References

- Lab bundle: https://github.com/dictationb1/supreme-lamp-lab/commit/811ba63
- Application candidate: https://github.com/dictationb1/supreme-lamp/tree/f66f9485649d5520a787d66496fffd43d8aa772a
- PR #88: https://github.com/dictationb1/supreme-lamp/pull/88
- Handoff JSON: https://raw.githubusercontent.com/dictationb1/supreme-lamp/f66f9485649d5520a787d66496fffd43d8aa772a/docs/reports/mission-control-current-handoff.json
