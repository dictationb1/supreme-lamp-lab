# F201 — missing probe must not become a measured connection failure

- **Class:** application UI truthfulness defect.
- **Baseline:** complete unmodified clone at `4a91c5c2eadc12e5b071bc46bae7683087f56fbd`.
- **Reproduction:** the new `f201-probe-honesty.test.tsx` regression was copied into the baseline without the repair; all 8 tests failed. The first setup failure was `useSessionStore.getState(...).setProbe is not a function`, because probe state did not exist before the patch.
- **Candidate:** the ordered F201 patch was applied to a separate worktree; all 8 regression tests passed.
- **Root-cause confidence:** HIGH for the UI state/consumer defect, because the same source-only regression changes from 8/8 failing to 8/8 passing and the patch adds explicit probe status plus distinct unavailable copy.
- **Repair:** preserve measured empty-object failures, but represent refused/missing probes as unavailable evidence rather than confirmed credential, DNS, or listener failures. Keep guarded launch actions disabled when prerequisites are not proven.
- **Hosted confirmation:** 1,375 smoke tests across 106 files and the production frontend build passed.
- **Not proven:** real PowerShell backend behavior, native RDP, Web Desktop, or live-origin deployment.
- **Patch:** `../app-patches/0001-F201-probe-honesty.patch`, SHA-256 `6d84cd954cf4b6a476c117dc92fe05e2a438ca4d7ba664a17b02813bc640f57f`.
