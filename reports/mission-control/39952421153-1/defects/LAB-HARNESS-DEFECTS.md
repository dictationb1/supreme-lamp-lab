# Lab-harness defects found and repaired this session

Every entry is a defect in `dictationb1/supreme-lamp-lab` (the verifier), not in the
application. Each was measured on the real client runner `rdp-lab-client`
(`WIN-NFU1JG4VESE\User`, interactive session 1) or on the real queue branch, is
fixed on `arena/be366866-supreme-lamp-lab` (PR #24), and carries a regression
where the defect is testable without the VM.

| id | symptom (measured) | evidence | root cause | repair | regression |
|----|--------------------|----------|-----------|--------|-----------|
| L-01 | Queue claim job printed `RECORDS_UNREADABLE` / pending=0 although the record existed | run 39956191414 claim job | pretty-printed JSON was parsed with a line-based reader; `{json,sha}` never unwrapped | `extractJsonObject()` balanced-brace extraction + `selectRecord` unwrap (`50a9253`) | 7 pick-record tests |
| L-02 | Preflight cleanup failure left NO annotation, so the reason for the aborted client job was unrecoverable | run 39956191414 step 4, run 39952421153 ack=FailED | `cleanup-lab.js` reported only on stdout, and a per-record failure crashed before the summary | outcome annotation (error/helper/survivors/counts), per-record try/catch, registry failure reported (`fce11de`, `c0ce1dd`) | cleanup suite 4/4 |
| L-03 | `NO_LIVE_ORIGIN` detail collapsed to `LOG_UNAVAILABLE`, hiding the real signal refusal | run 39956527570 discover | discovery kept only the last error code, not the signal reason | append `signal=<code>:<80-char detail>` per rejected run (`a992d9c`) | app-signal + signal-binding suites |
| L-04 | A healthy live origin was rejected `SIGNAL_TTL_TOO_LONG` | discovery on the live signal | the publisher stamps `expiresAt = publish + 6 h` (exactly the ceiling); a consumer clock a few seconds behind saw a TTL above the cap | allow `CLOCK_SKEW_MS` above `MAX_TTL_MS` on both parsers (`a992d9c`) | app-signal 13/13 |
| L-05 | Live pass aborted at `CLAIMED` with `LOCK_DIR_REQUIRED`, and the run still exited 0 | lab run 39957424394 client job | the desktop lock was acquired with `{name, owner}` while `lib/lock.js` requires `{lockDir}` | real directory lock under `LAB_LOCK_DIR` (`743752f`) | (see L-06 tests) |
| L-06 | A run that never reached the origin was written to the queue as `REPORTED_VERIFIED` | lab run 39957424394 ack | `ack-state` mapped job `success` to a PASS although the verify job exits 0 for BLOCKED too | gap-fill is `BLOCKED` and says it is not a verdict (`743752f`) | 2 inconsistent-state tests |
| L-07 | The still-live origin could never be re-attached: `NO_PICKABLE_RECORD ... already claimed` / `state=FAILED` | runs 39956837362, 39958377748 | (a) a claim held by a finished run was treated as live; (b) a FAILED record written by the gap-fill blocked selection | bounded re-queue only when provably nothing was attempted (n/3); claim liveness probed against the Actions API, unknown = live (`5281e3a`, `eccb040`) | 6 re-queue/stale-claim tests |
| L-08 | Origin verification demanded `live-run-<run>-<attempt>-envelope`, an artifact the merged application never publishes | lab run 39958377748 | `cmdLive` used the queue record's lab default transport whenever a record existed, instead of the origin's own validated MC-SIGNAL | discovery is authoritative for auto/signal/log transports; record still owns queue identity/claim (`c791d51`) | suite |
| L-09 | `BLOCKED_DESCRIPTOR_CHANGED` on a healthy origin | lab run 39958850298 | the sealed credential is a JSON object `{dashTokenQueryParam,dashToken,issuedAt,...}`; the raw plaintext (with a moving `issuedAt`) was used as the token, so the fingerprint changed every heartbeat | parse the object, verify embedded repository/runId/runAttempt/sha, return the token (`014ee8f`) | app-signal 13/13 |
| L-10 | `READINESS_TIMEOUT` carried no address and no per-attempt detail | lab run 39959782248 | readiness history kept only the first observation per code | every distinct (code, detail) kept; annotated line names the target and the last four observations (`e9f275e`) | suite |
| L-11 | The whole workflow file became unrunnable; GitHub reported a failed run with ZERO jobs and no annotation | commit 4b2d085, run 39962631679 | unquoted `: ` in a step name | YAML rule in the structure gate + quoted name (`0992104`) | 2 workflow-yaml tests |
| L-12 | The read-only net preflight failed the job and skipped the live pass | run 39963018826 step 6 | `curl` exit 28 propagated as the step exit code | diagnostic resets the code and exits 0 (`acf056d`) | suite |
| L-13 | Multi-sweep claim race aborted the verification with `HTTP 409 does not match <sha>` | lab run 39963491076 | supersede-then-claim does two PUTs; a concurrent sweep wrote in between | bounded retry with fresh sha; a claim that becomes ours = `ALREADY_MINE`; stays foreign = `CLAIM_RACE_LOST` (`a9fb8cf`) | suite |

Status of each: **fixed on the branch, regression-covered, and exercised end-to-end
on the real client VM** except L-02's original crash cause, which is still not
reproduced: the patched step now runs and exits 0 (runs 39958007407 → 39963491076
all show `cleanup preflight` annotations), but the exact 2026-10-23 failure that
started this list remains unexplained until a run reaches it again with the new
annotation in place.
