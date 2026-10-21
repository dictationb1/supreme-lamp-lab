# RECOVERY CHECKPOINT

## Branch & commits
- **Repository**: `dictationb1/supreme-lamp-lab`
- **Application**: `dictationb1/supreme-lamp` (pinned in `config/app-source.json`, recorded per run)
- **Working branch (this session)**: `arena/f823d76d-supreme-lamp-lab`
- **Base**: PR #15 head `1beca6ffa2ee974e89cf07d1cbfc13ef94cf0122` (PR #15's own head branch `arena/32a8931c-...` is not writable from this session, so this branch carries the increment and is proposed as a follow-up PR)
- **PR #15**: https://github.com/dictationb1/supreme-lamp-lab/pull/15 — the *observed* failing run is 39555536075 attempt 1 (`capability pull_request PR #15`, head `3442e835`, base `8067e4e9`).
- **PR #16 (open)**: https://github.com/dictationb1/supreme-lamp-lab/pull/16 — this branch -> `main`.

### Run history (same-attempt server + client, `capability-check.yml`)
| run | head | Windows client suite | verdict |
|---|---|---|---|
| 39555536075 (PR #15) | `3442e83` | 74 tests: 73 passed, **1 failed** (`LOCK_ACQUISITION_FAILED` after 60 s) | `NOT_VERIFIED` |
| 39557365420 | `1beca6f` | lock test pass; tailnet 404 captured | `NOT_VERIFIED` |
| 39558818002 | `3f27c8e` | **80 tests: 80 passed, 0 failed, 0 skipped** | `NOT_VERIFIED` (external only) |
| 39559894221 | `f1437f8` | **80 tests: 80 passed, 0 failed, 0 skipped** | `NOT_VERIFIED` (external only) |

Every push triggers a full run, including documentation-only commits; the report job fails whenever the verdict is not `VERIFIED`, so a red `report` check alone is not a regression. Always read the annotations of the **newest** run for the current head SHA rather than a cached earlier run.

## Confirmed findings (evidence, not inference)
1. **Failing Windows regression**: `lock: 4 concurrent processes x 5 increments = mutual exclusion (no lost update)`, `AssertionError [ERR_ASSERTION] ... scripts\lib\lock.js:120`, holder `run 39555536075/1 role=unknown pid=6712`, dir `%TEMP%\slab-reg-...\t7\state\c.lock.d`. `role=unknown` is simply the default because the worker passes no role. The holder pid was live in the last observed owner snapshot; the surviving annotations cannot prove whether it was starved or had failed to release.
2. **Both lock defects are real and reproduced**: per-poll PowerShell/CIM identity queries under 4-way contention, and a swallowed release-rename failure that leaves a live process owning an orphaned lock. Controlled reproductions on the pre-fix tree (`3442e83`): a 20 s simulated identity query produced a **60014 ms** acquisition wait with the counter still 20/20 (starvation, not corruption); a forced `EPERM` on the release rename made the pre-fix process deadlock on its own orphan, while the fixed tree relinquished in 152 ms and re-acquired in the same process (344 ms total). Both now have regression coverage (including fault injection). **Windows is green**: `lock: 4 concurrent processes x 5 increments` passes in the win32 suite (80 passed, 0 failed, 0 skipped, run 39558818002).
3. **Actual Tailscale join error** (run 39557365420 attempt 1, head `1beca6f`): token exchange HTTP 200, `audMatchesConfigured=true`, then
   `unexpected error while creating authkey: Status: 404, Message: "not found"` on `POST /api/v2/tailnet/-/keys`;
   CLI 1.94.2, `service=RUNNING`, `backendState=NeedsLogin`. Not a subject/audience problem, not a client-version problem, not a local service problem.
4. **Log availability**: job logs and artifacts are served from `productionresultssa3.blob.core.windows.net` / `results-receiver.actions.githubusercontent.com`, which this environment cannot reach. Evidence is therefore read from the **check-runs annotations API** (the workflow already mirrors every verdict-relevant fact into annotations).

## State of the work on this branch
- `scripts/lib/lock.js`: bounded event timeline (`LAB_LOCK_EVENTS`), precise timeout diagnostics (holder state, poll/query counters), throttled identity verification, retried release with `relinquish.json` fallback, self-orphan recovery, `releaseLockEx`, `withLock` surfacing an incomplete release.
- `scripts/run-regressions.js`: merged multi-process timeline + `lock-timeline.json`; new lock regressions (live holder, crashed owner + bystander, failed release + takeover, slow-identity bound); regression summary (`caps_regressions`) written to `$GITHUB_OUTPUT`.
- `scripts/tailnet-token-exchange-diagnostic.js`: read-only credential scope probes (no key creation), `firstErrorLine`, `CREDENTIAL_CANNOT_CREATE_AUTH_KEYS`, first-error/CLI/service/operation outputs + annotations.
- `scripts/verification-report.js`: regression gates are part of the verdict (`regressions` block, `REGRESSION_GATE_FAILED`/`_MISSING`), tailnet first error in `diagnostics`, sanitized PR comment publication.
- `.github/workflows/capability-check.yml`: `caps_regressions` outputs for static/client, `ARTIFACT_DIR` for client evidence, `tailnet_first_error`/`tailnet_cli_version`/`tailnet_service_state`/`tailnet_failed_operation` outputs, `pull-requests: write` for the report comment.

## Next concrete action
1. **Re-establish the evidence at the current head.** Run 39558818002 validated `3f27c8e` (win32 80/80, verdict `NOT_VERIFIED` for the external Tailscale cause only). After any further commit, wait for the new `capability-check.yml` run and re-read `GET /repos/{repo}/check-runs/{job}/annotations` for **that** head: client `regression summary: 80 tests: 80 passed, 0 failed, 0 skipped (win32, browser e2e required)`, static green, `tailnet_connectivity=BLOCKED :: ... category=CREDENTIAL_CANNOT_CREATE_AUTH_KEYS`.
2. **Do not re-run unchanged code against the confirmed external blocker** — the only thing to add for another pass is the trust-credential fix below.
3. Merge is **not** permitted while the required checks are red; no check may be bypassed. Merge `--merge` only after a run returns `VERIFIED`.
4. Remaining administrative action is on the Tailscale trust credential (writable `auth_keys` scope + `tag:ci` in its tags), not on the OIDC subject/audience.

## Administrative action required (Sinhala, unchanged in substance)
Tailscale Admin Console → **Trust credentials** → මෙම federated identity (Client ID) සඳහා:
1. **Scopes**: `Keys / Auth keys` සඳහා **Write** (`auth_keys`) අවසරය ලබා දෙන්න.
2. **Tags**: `tag:ci` ඇතුළත් කරන්න (එය tailnet policy `tagOwners` තුළ ද තිබිය යුතුය).
OIDC subject හෝ audience වෙනස් නොකරන්න — token exchange දැනටමත් HTTP 200 ලෙස සාර්ථක වේ.
