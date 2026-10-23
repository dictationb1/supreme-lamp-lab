# RECOVERY CHECKPOINT — live Mission Control verification (2026-10-23)

If this session ends early, this file is the resume point. It replaces the older
PR #18 checkpoint; that history stays in git.

## Where the work is

| item | value |
|---|---|
| lab repository | `dictationb1/supreme-lamp-lab` |
| branch (this session) | `arena/00ac3814-supreme-lamp-lab` |
| PR | **#23** (labels `live-verify`, `rdp-signing-probe`) |
| HEAD at the last full verification | `3be2680` + the latency commit on top |
| application repository | `dictationb1/supreme-lamp` (`main` `c470531e` at the time of the run) |
| attached origin | **run 39899087271 / attempt 1**, sha `c470531e4739be072daea20425a1de203d0ed326` |
| last full lab run | `39913711978` (client job `120282471443`) |
| queue record | `run-records: records/dictationb1_supreme-lamp/39899087271-1.json` → `REPORTED_FAILED` (in-process report, 3/14 mandatory PASS) |
| local suite | `node scripts/run-regressions.js` → **228 tests: 220 passed, 0 failed, 8 skipped** |

## Where the evidence lives (this environment cannot download artifacts)

`gh run download` and `blob.core.windows.net` are unreachable here, and Windows
runner step logs are not retrievable either. **Everything verdict-relevant is
therefore emitted as a check-run annotation** (`GET
/repos/.../check-runs/<job id>/annotations`). Read them with:

```bash
gh api repos/dictationb1/supreme-lamp-lab/actions/runs/<run>/jobs \
  --jq '.jobs[]|select(.name|startswith("client"))|.id'          # job id
gh api repos/dictationb1/supreme-lamp-lab/check-runs/<job id>/annotations
```

## What the lab did in this session (all pushed, all with regressions)

Chain of measured defects, each one hiding the next:

1. `45752ae` the merged application publishes `mc-signal/v1` in check-run
   **output.text**, not `output.summary`.
2. `6a94924` the claim step read a record envelope instead of the record.
3. `cf1bdb0` cleanup bookkeeping killed the verification step.
4. `fe872fe` that step could not even report why (PowerShell stderr folding).
5. `33bd21d`/`0a3f2b9` the client VM had **no node** (and setup-node's 7zr failed):
   the cleanup silently no-op'd. The job now provisions node itself.
6. `49ab054`/`f350b76` a lab failure wrote `FAILED` and poisoned the queue entry;
   `retryable` is honoured from the record body and the row.
7. `3cba0b4`/`4c3640c` a claim left by a terminal lab run made the origin
   unattachable (`labRunStatus` was not exported).
8. `565d2f6` the job-level ack minted `REPORTED_VERIFIED` for a run that verified
   nothing; the verdict is now annotated and only a VERIFIED exit is green.
9. `19f0690` `acquireLock({name})` — every live run died at `LOCK_DIR_REQUIRED`;
   it now takes `registry.sessionLockDir()`.
10. `7e468da` the app's normal `creds:{fqdn,user,ip}` was called a credential
    leak; the gate now measures password fields only, and a tailnet peer's
    receipt is `tailnet-trust` (inconclusive), never a leak.
11. `98831e4`/`a4b209e`/`0db1691`/`804f693`: the server's own telemetry, the
    envelope provenance and the auth gates are on the run page.
12. `1db6f28`/`e7f730a` the instance is bound to the **process start time**, not
    just buildSha.
13. `dc26d58`/`5f67583` the strict ticket route is told apart from the
    refresh-aware routes.
14. `ba797df` the feature pass called a helper that never existed
    (`ReferenceError: summarizeToCapabilities`) — the first run that ever reached
    it died there.
15. `3be2680` every non-PASS feature is annotated with its reason; `/api/version`
    reporting `dev` is `VERSION_STAMP_ABSENT` (BLOCKED), not "another instance".
16. `7f041a0` the latency legs are measured and annotated.

## What is VERIFIED (lab side, by real runs)

| acceptance | state | evidence |
|---|---|---|
| A regressions | **PASS** | 228 tests, 0 failed, 8 platform skips (linux); Windows client job runs the same suite |
| B1 real app run attached | **PASS** | discovery `transport=check-run signalFormat=mc-signal/v1 signalLive=true heartbeatAge=8–57s keyId rsa:f5ae1689a220835e = expected alg=rsa-oaep-sha256+aes-256-gcm uiMatchesRunSha=true fallback=-` |
| B2 decryption with the lab key | **PASS** | `LAB_SIGNAL_PRIVATE_KEY` decrypts the sealed envelope in-process; keyId matches; the credential is then accepted by the app's refresh-aware routes |
| B3 exact instance | **PASS for the process** | server boot `2026-10-23T04:13:48.829Z` (route `/api/native-status`), run start `04:12:31Z`, delta −77.8 s → this run's process; `/api/config` buildSha = run head |
| B4 authenticated visible UI | **FAIL** | `nav.routes_reachable`: `overview=rendered-with-errors`; `1 route(s) did not render cleanly` |
| B5 unattended native RDP | **BLOCKED (application defect)** | see below |
| B6 web desktop / features | **FAIL/BLOCKED** | 3/14 mandatory PASS; 7 FAIL, 6 BLOCKED (reasons now annotated per feature) |
| B7 sanitized report | **PASS** | `live_credential_hygiene=PASS` (4 files scanned, 1 secret, url-key/ticket shapes clean) |
| C second app run | **NOT_RUN** | needs a fresh `mode=rdp` dispatch (the lab cannot dispatch the app workflow: 403) |
| D cancellation/expiry/superseded | **unit PASS, live NOT_RUN** | `SIGNAL_STALE_ATTEMPT`, closed-signal, `RUN_ATTEMPT_SUPERSEDED`, expired-record-skipped all covered; a live cancellation needs a fresh origin |

## The two application-side defects (proven, not inferred)

### 1. `APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE` — blocks unattended native RDP

* the server's own telemetry (`/api/diag/comprehensive` → token ring, read via
  `/api/native-status`) reports **`expectedLen=0`**, `expectedHash` ≠ published:
  `$script:Token`, read once at boot from `dash-token.txt`, was empty.
* `POST /api/rdp-token` answered **401** for the run's own credential, and 401 for
  anonymous and forged bearers (the gate is real; the snapshot is what it compares).
* the same credential was **accepted** on the refresh-aware route
  (`GET /api/search/status` → 404 `UNKNOWN_SOURCE` past the gate;
  anonymous/forged → 403), i.e. the credential is current.
* cause in the application workflow: `F92 register user-session server`
  (`main.yml` ~line 903) registers `GHRDP-Server` and **kicks it immediately**,
  77 s into the run, while the per-run dashboard token is written much later by
  `Stage files + write config.json` (~line 2554; `dash-token.txt` at 2831,
  `dashToken` at 2767). The server never re-reads the file.
* fix belongs to the application: either start the server after the token exists
  (and restart it when config changes), or make `/api/rdp-token` compare through
  `Test-GhrdpDashToken` (the refresh-aware union the other routes already use).

### 2. `VERSION_STAMP_ABSENT` — the UI build cannot be tied to the run

`/api/version` answers `sha:"dev"` while `/api/config.buildSha` matches the run.
The lab reports BLOCKED (prerequisite), not "a different instance".

## Operator actions, in order

1. **Fix the application boot order** (defect 1). Until then *every* run reports
   `live_authorization=BLOCKED` and unattended native RDP cannot be verified —
   the lab will not fake it.
2. **Start a fresh application run** with `mode=rdp` (Actions → *Windows RDP -
   Tailscale Mission Control* → Run workflow). This is requirement C: a new run
   with a new identity. The lab's `*/10` sweep attaches automatically (≤10 min),
   or add the `live-verify` label to PR #23 for an immediate sweep.
3. Nothing else. Do not cancel runs; the queue is FIFO and one claim per origin.

## Resume checklist

```bash
cd /home/user/supreme-lamp-lab
git log --oneline -3
node scripts/run-regressions.js                       # 228 tests
gh run list --workflow live-run.yml -L 3              # find the sweep
gh api repos/dictationb1/supreme-lamp-lab/contents/records/dictationb1_supreme-lamp/39899087271-1.json?ref=run-records --jq .content | base64 -d | jq .state
```
