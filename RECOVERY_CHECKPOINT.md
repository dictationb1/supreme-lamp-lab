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

## Remaining external actions (cannot be done from CI)

* Tailscale trust credential subject (above) — owner: tailnet admin.
* Secrets `TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE`, `RDP_LAB_PASSWORD` — owner: repo admin.
* Client tailnet policy for `tag:ci` TCP 7331/7332/3389 — owner: tailnet admin.

Until these are done, `report` returns `NOT_VERIFIED` with
`tailnet_connectivity = BLOCKED (EXTERNAL_TAILSCALE_JOIN_FAILED …)` and the
dependent remote capabilities `BLOCKED`; merge is correctly blocked.
