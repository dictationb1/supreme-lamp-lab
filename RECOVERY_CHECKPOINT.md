# Recovery checkpoint

_Updated by the consolidated repair (branch `arena/3d6eff95-supreme-lamp-lab`)._

## Baseline

* lab `main` 8067e4e9b3316cbfa21115a5de112351eb67d417
* superseded PRs: #10 (5a6adce2), #11 (44479dcd, merged into the repair branch as its base), #12 (febb2197), #13 (5f9bc1cf)
* app `dictationb1/supreme-lamp`: main daf13685 (no UI bundle) → verified commit pinned in `config/app-source.json`: 978a8375ee77b392ce11694ccee7722fd6ca4f71

## Root causes found

1. **Tailscale HTTP 403** (run 39526409955, server job 118995859962): the repo's
   OIDC subject customisation is `use_immutable_subject: true`
   (`repo:dictationb1@342137832/supreme-lamp-lab@1425092794:…`); the documented
   trust-credential subject `repo:dictationb1/supreme-lamp-lab:*` cannot match.
   **Admin fix:** set the subject to
   `repo:dictationb1@342137832/supreme-lamp-lab@1425092794:*` (or narrower).
   See RUNBOOK §2.1.
2. **False PASS for Web Desktop** (any page body accepted) and **weak readiness**
   (OR-chain, missing pid/sha checks) — replaced by strict contracts.
3. **Backend on the user's machine** with untracked processes — the backend now
   runs only on the ephemeral hosted server under `backend-supervisor.js`.
4. **Non-exclusive locks / non-atomic registry / name-based cleanup** — rebuilt
   on exact `(pid, createTime)` identity (RUNBOOK §5).
5. **PR #12 regression fixture**: `execSync` while its HTTP server lived in the
   same process → blocked event loop → fake pass. Fixtures are now out of process
   and async.

## Ported from the overlapping PRs

* #10: exact-SHA source (40-hex check, no branch-archive fallback), stdout/stderr
  capture of the backend, port 7331 — **not** its OR-readiness or peer skipping.
* #11: nested fetch-cause formatting, single supervised backend step with exit
  detection and guaranteed stop, CMD `^&` escaping, `.gitignore` entries, async
  test runner with child-process fixtures.
* #12: cause-in-message diagnostics only.
* #13: `source_sha` input + exact checkout, `-Root` staging, Node in the runner
  tool cache, screenshot via a `.ps1` helper, MOCK/NOT_RUN ⇒ not success,
  `mkdir`-based lock idea.

## Evidence: PR #14, run 39542662709 attempt 1 (head a6adc76, pull_request)

Observed from check-run annotations (job logs are not retrievable from this tooling):

| Job | Result | Evidence |
|---|---|---|
| static 119033698032 | success | Node v22.23.3 win-x64 zip sha256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`, gpgv OK against nodejs/release-keys@481637f8; browser e2e required and passed; PowerShell parse of scripts + 22 workflow blocks passed; actionlint 1.7.12 (with shellcheck) passed |
| server 119034250177 | failure | OIDC `sub=repo:dictationb1@342137832/supreme-lamp-lab@1425092794:pull_request` (immutable format confirmed in CI); Tailscale join failed (exit 1) -> `tailnet_connectivity` BLOCKED; app staging step failed (statement not surfaced - fixed below) -> `backend_readiness_server_local` FAIL `STAGING_FAILED` |
| client 119034250032 | failure | runner `rdp-lab-client` `WIN-NFU1JG4VESE\User` session 1, PS 5.1.20348; `browser_synthetic` PASS (DOM asserted, 1280x720, video 64 KB); `native_screenshot` PASS (1024x768, session 1); remote capabilities BLOCKED `DEPENDS_ON_TAILNET`; 2 Windows regression failures (timing, fixed below) |
| report 119035980575 | failure | `verdict=NOT_VERIFIED`, first cause `backend_readiness_server_local: STAGING_FAILED` |

Follow-up fixes in the next commit:
- Stage-App / Install-PinnedNode / Set-RdpCredential: top-level `trap` emits the failing message and
  script:line as an `::error` annotation; the staging error is passed into the `STAGING_FAILED` reason.
- `--fail-reason`: the backend capability carries the causal FAIL, dependants are BLOCKED
  (`DEPENDS_ON_BACKEND`) instead of a second FAIL; regression test added (mutation-checked).
- Supervisor crash tests: the fixture's crash point (`CRASH_AFTER_MS`) is 12 s on Windows, because the
  PowerShell-backed identity/listener checks take seconds there and a 1.5 s crash landed in an earlier
  phase than the one asserted. Assertions now print the full phase list.
- `config/node-pin.json` records the signature-verified win-x64 hash above; the static job now
  fails if the signed SHASUMS ever disagrees with it.

## Remaining external actions (cannot be done from CI)

* Tailscale trust credential subject (above) — owner: tailnet admin.
* Secrets `TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE`, `RDP_LAB_PASSWORD` — owner: repo admin.
* Client tailnet policy for `tag:ci` TCP 7331/7332/3389 — owner: tailnet admin.

Until these are done, `report` returns `NOT_VERIFIED` with
`tailnet_connectivity = BLOCKED (EXTERNAL_TAILSCALE_JOIN_FAILED …)` and the
dependent remote capabilities `BLOCKED`; merge is correctly blocked.
