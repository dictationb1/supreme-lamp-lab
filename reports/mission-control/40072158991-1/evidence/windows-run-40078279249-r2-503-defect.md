# Windows real-backend run 40078279249 — R2 core proven, all-WS 503 defect found

Head lab SHA `015a7ae` (the step-7 test fix). Runner (read, not assumed):
`rdp-lab-client WIN-NFU1JG4VESE\User`, interactive `session=1`,
`backendKind=actual_application`, `browserWebSocketStubbed=false`, headed.
Job logs were unreadable via the API (persistent blob-store EOF), so all figures
below come from the published, sanitized evidence in this folder and the job's
check-run annotations.

## What passed

- Step 7 (app smoke gate): **3 files / 19 tests pass** on Windows — the earlier
  `[Math]` regex fix is confirmed on the real host; f201 8, r2 8, r1 3.
- Step 8: PowerShell 5.1 parses both the pristine and patched server files.
- Step 9 completed for both labels with `node exit=0` and a published report.
- Ordinary HTTP is excellent under the patched server even while WS probes run:
  `/health` median 23–54 ms, p95 ≤ 79 ms, zero timeouts; `/api/config` 200 in
  53 ms; a real `POST /api/handler-hello` writes its file (200/77 ms).

## The R2 headline control is genuinely improved

| Label | WS upgrade | /health while WS held | stall |
|---|---|---|---|
| baseline (pristine) | **wsUpgraded=true** | **blocked, 5011 ms** | 4615 ms |
| patched | wsUpgraded=false (503) | not blocked | **826 ms** (Δ 3789 ms) |

The pristine server reproduces the exact R2 defect on this host: one inline
`/ws` starves `/health` for ~5 s. The patched server keeps the accept loop
free. So the runspace-offload architecture removes the starvation mechanism —
but it currently does so by rejecting every WebSocket, which is not acceptable.

## Remaining defect: every /ws upgrade is answered 503

- `r2.capacity_limit_predictable`: `held=0 rejected=9 rejectStatuses=[503 ×9]`
  — even the **first** of nine connections is rejected on a fresh gate whose
  cap is 8, so this is not legitimate saturation.
- `r2.one_ws_health_responsive` / `r2.ws_real_frames_and_echo`:
  `upgrade did not complete: 503` / `upgrade failed: 503`.
- `r2.ws_malformed_handshake_bounded`: expects the original 400 path, gets 503.
- `r2.repeated_cycles_no_leak`: `okCycles=0`, handles 742→742 (no leak, but no
  successful worker either).
- The headed browser's real `/ws` (no stub) also receives 503; the UI honestly
  renders "No /ws endpoint". No socket is faked and no result is inflated.

There are exactly two inline 503 sources in the patched dispatcher, both after
the runspace pool reported `[LAB-R2] websocket worker pool ready max=8` with no
init exception:

1. the non-blocking admission gate `R2WsGate.Wait(0)` resolving false/throwing
   (body `websocket capacity exhausted; retry`), or
2. the worker dispatch (`[powershell]::Create(pool).BeginInvoke()`) throwing,
   which releases the slot and answers `websocket worker unavailable`.

The previous harness discarded the 503 body (`res.resume()`) and only checked for
the audit file's existence, so the branch could not be attributed from this run.

## Instrumentation added for the next run (no control-flow change)

- The server now logs, on each rejection to **both the audit file and stdout
  (captured)**: gate `CurrentCount`, `RunspacePool.GetAvailableRunspaces()`,
  pool-available flag, and any exception type/message, tagged `[LAB-R2]` with
  distinct `gate FAULT` / `saturated` / `dispatch FAULT` markers. The exact 503
  bodies and all bounded-design constructs are unchanged; the r2 static test
  stays 8/8 on LF and CRLF.
- The harness now captures the 503 body (`rejectedBody`/`httpBody`) in the
  report and collects the server's `ws`/`LAB-R2` audit lines
  (`timings.r2AuditLines`). The next run therefore attributes the 503 to a
  semaphore fault, genuine saturation (impossible on the first call) or a
  runspace-dispatch exception, with the exact .NET message.

## Honest status

R2 starvation is structurally fixed and measured (4615 ms → 826 ms, HTTP never
blocked), but the WebSocket feature is currently non-functional on the real
Windows host because of the all-503 defect. The matrix correctly reports the
dependent controls FAIL/BLOCKED and the evaluate gate correctly hard-fails; this
is **not** an R2 acceptance PASS. Native RDP / Web Desktop remain BLOCKED on a
separate lab-owned application server.
