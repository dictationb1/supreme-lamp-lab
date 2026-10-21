# Regression catalogue

Every defect below has a test in `scripts/run-regressions.js` (test name in
quotes). Server-like fixtures run **out of process**
(`scripts/test/fixtures/fake-backend.js`) and every child is awaited
asynchronously, so a blocked event loop can never turn a failure into a pass
(the defect in PR #12's `execSync` fixture). The suite runs on Linux (`static`
job, browser e2e mandatory) and on the Windows client (real Windows process
identity, locks, cleanup).

The safety-critical checks were mutation-tested: each of these deliberate
breakages makes the suite fail — ignoring the run attempt in cleanup, a
recursive (non-atomic) lock `mkdir`, accepting contradictory readiness,
killing on PID reuse, skipping lock-recovery re-verification, lock failure as
warning, accepting non-PASS capabilities in the verdict, and not monitoring
backend liveness.

| # | defect (where seen) | root cause | test(s) | expected |
|---|---|---|---|---|
| 1 | Web Desktop PASS on any page body (main, PR #11/#13) | `#app \|\| body` selector accepted | "browser e2e mc-check server-local: *", web_desktop contract in `mission-control-check.js` | frame freshness + JPEG + rendered `img#view` required |
| 2 | Readiness OR-chain / "good enough" (PR #10) | partial signals accepted | "readiness: strict contract table", "fixture readiness: contradictory / missing-fields / string-booleans" | `READINESS_CONTRADICTORY` / `READINESS_SCHEMA_INVALID` |
| 3 | Wrong process answering the port | pid never compared | "fixture readiness: wrong-listener…", "supervisor: readiness pid of another process…", "supervisor: port owned by a foreign process…" | `READINESS_WRONG_PROCESS`, `BACKEND_PORT_OWNED_BY_OTHER` |
| 4 | Backend crash hidden / died between steps (#11 run) | unsupervised `Start-Process` | "supervisor: startup crash…", "supervisor: crash while initializing…", "supervisor hold: backend dying during hold is a failure", "supervisor hold: keeps backend alive until the client job completes" | `BACKEND_EXITED*`, `BACKEND_DIED_DURING_HOLD` |
| 5 | "fetch failed" with no cause (run 39537803154) | cause chain dropped | "http: connection refused keeps nested cause…", "fixture readiness: crash-after-ready…", "mc-check CLI: unreachable backend reports the cause chain" | `… <- caused by: … ECONNREFUSED` |
| 6 | Version `dev`/`unknown`/`main.zip` accepted | fallback SHA | "version: exact sha, no dev/unknown fallback", "fixture version: wrong-sha / dev-sha" | `VERSION_SHA_INVALID` / `VERSION_SHA_MISMATCH` |
| 7 | Missing config reported as SKIPPED/PASS | permissive defaults | "mc-check CLI: missing --expect-sha is BLOCKED…", "mc-check CLI: --blocked-reason…" | `BLOCKED` with reason |
| 8 | MOCK / NOT_RUN / SIMULATED counted as success | aggregate too lax | "status: only all-required-PASS is accepted", "report: VERIFIED only when…" | `NOT_VERIFIED` |
| 9 | Later PASS masking first failure | status overwritten | "status: a FAIL is never overwritten by a later PASS" | first cause kept |
| 10 | Lock failure → warn and continue (browser-check) | warning only | "session lock held -> browser-check FAILs both capabilities…" | `FAIL: LOCK_ACQUISITION_FAILED` |
| 11 | Lock not exclusive / stale lock stolen from a live owner | recursive mkdir, no identity | "lock: live holder blocks…", "lock: N concurrent processes x M increments…", "lock: recovery race…", "lock: release by a non-owner handle is refused" | exact counter, no steal |
| 12 | Stale lock never recovered | no owner identity | "lock: dead owner…", "lock: PID reuse…", "lock: owner-less dir…grace period" | `STALE_LOCK_RECOVERED` only when owner provably gone |
| 13 | Registry lost updates / non-atomic copy fallback / corrupt overwrite | unlocked RMW, copy fallback | "registry: 5 concurrent registrations…", "registry: corrupt file is refused and preserved…" | 5 records, no tmp, `REGISTRY_CORRUPT` |
| 14 | Cleanup killed by name / other attempt / PID reuse | no exact identity, run-only scope | "cleanup.decide: …", "cleanup: postflight kills only this run+attempt…", "cleanup: PID-reuse record…" | only exact-identity, in-scope, abandoned processes die |
| 15 | Tailscale 403 with no diagnosis (run 39526409955) | immutable OIDC `sub` vs name-only pattern | "oidc: immutable subject cannot match documented name-only pattern" | recommended subject printed |
| 16 | Peer of another attempt matched | prefix match | "peer: exact hostname / -N suffix…" | exact label only |
| 17 | Screenshot "exists" counted as evidence | no decoding | "image: PNG validation…", "image: JPEG validation…" | truncated/tiny/uniform rejected |
| 18 | Secrets in evidence | no sanitisation | "redact: tokens, auth headers, URL creds, cmdkey /pass" | all masked |
| 19 | PowerShell quoting broke steps | no parse gate | `static` job: `Test-PowerShellSyntax.ps1` over `scripts/**/*.ps1` + extracted workflow `run:` blocks | 0 parse errors |

---

### Defect 8: Windows lock contention starvation and orphaned live-owner locks
- **Trigger**: `lock: 4 concurrent processes x 5 increments = mutual exclusion (no lost update)` on the self-hosted Windows client (`rdp-lab-client`), run 39555536075 attempt 1. `LOCK_ACQUISITION_FAILED` after 60000 ms, stack `scripts/lib/lock.js:120`, holder `run 39555536075/1 role=unknown pid=6712`, directory `%TEMP%\slab-reg-...\t7\state\c.lock.d`.
- **Root cause (source + reproduction)**: `acquireLock()` ran a full `(pid, createTime)` identity query for a live owner on *every* contender poll. On Windows that query spawns `powershell.exe` + CIM (~0.7–3 s under load), so four contenders polling at 5 ms spent the acquisition deadline inside diagnostics instead of waiting on the lock. Independently, `releaseLock()` swallowed the directory-rename error (Windows sharing violation: a peer reading `owner.json`, virus scanner on a fresh file) and returned `false`, which every caller ignored; the releasing process kept running and its *next* acquisition then waited on its own orphaned lock until the deadline. Both defects produce the same observed signature (a live pid in the holder field), so the surviving annotations cannot apportion the original failure between them.
- **Fix**: cheap `process.kill(pid, 0)` liveness on every poll; identity re-verification retained (throttled, cached, and always applied to stale/foreign owners); bounded release retries with an owner-token-bound `relinquish.json` fallback so peers can take over without weakening the identity check; self-orphan detection; `withLock()` now reports an incomplete release instead of hiding it.
- **Regression tests**: multi-process mutual exclusion with a merged per-worker timeline (3 rounds on Windows, 2 elsewhere); simulated slow identity query (bounded query count and wall clock); injected release-rename failures ⇒ retry + relinquish + takeover by the next process; live holder never stolen even when the lock looks old; crashed owner recovered while an unrelated process survives.
- **Expected verdict**: `PASS`.
- **Time limit**: 60 s per acquisition (unchanged — the timeout is not the fix), whole suite < 8 min on Windows.
- **Evidence files**: `artifacts/run-<id>-<attempt>/lock-timeline.json`, `.../regressions-summary.json`, workflow annotations.

### Defect 9: the tailnet gate reported a guess instead of the actual join error
- **Trigger**: `Join tailnet (workload identity)` failed while the token-exchange probe returned HTTP 200, so the gate asserted an OIDC subject mismatch that was never observed.
- **Observed (run 39557365420 attempt 1)**: token exchange HTTP 200; `tailscaled` reported `unexpected error while creating authkey: Status: 404, Message: "not found"` on `POST /api/v2/tailnet/-/keys`; CLI 1.94.2, service RUNNING, `backendState=NeedsLogin`. The OIDC subject and audience already match.
- **Fix**: capture and annotate the first client error line, record the failed operation/CLI version/service state, and probe the exchanged token's scopes with **read-only** `GET` requests (no keys are created or deleted). New category `CREDENTIAL_CANNOT_CREATE_AUTH_KEYS` (the trust credential is not authorized to mint an auth key) is kept distinct from `TAG_NOT_PERMITTED` (HTTP 400 with a tag message), `MISSING_AUTH_KEYS_PERMISSION` (HTTP 403), `TAILSCALE_SERVICE_NOT_READY` and `CLIENT_VERSION_UNSUPPORTED`.
- **Expected verdict**: reported as `BLOCKED` (external credential configuration), never as a subject mismatch.
- **Evidence files**: `tailnet-diagnostic.json`, `tailnet first error` annotation, `verification-report.json` (`diagnostics.tailnetFirstError`).
