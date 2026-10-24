# Windows real-backend run 40091165292 — R2 ACCEPTED on the real Windows client (headed, actual application, no stub)

Head lab SHA `5ba3745` (the transparent native-WebSocket recorder). Workflow
`real-backend.yml` on the `rdp-lab-client` self-hosted Windows runner
(`WIN-NFU1JG4VESE\User`). Identity flags required for acceptance, all present
in the report: `backendKind=actual_application`,
`browserWebSocketStubbed=false`, `browserMode=headed`, scope
REAL_APPLICATION_POWERSHELL_SERVER_ON_WINDOWS. The workflow's evaluate step
**passed**: overall counts **33 PASS / 0 FAIL / 5 BLOCKED / 0 PENDING**, and
the five BLOCKED controls are the pre-declared design-BLOCKED capabilities
(real logon rows, staged filesystem index, an external search backend, native
RDP and Web Desktop) — none is a WebSocket/accept-loop failure.

## All R2 controls pass on the real PowerShell server

Raw-socket behavioral matrix (real RFC6455 against the actual server):

| Control | Verdict | Measured detail |
| --- | --- | --- |
| `backend.ws_accept_loop_block` | PASS | `wsUpgraded=true blocked=false healthDuringWsMs=53` |
| `r2.no_ws_control_health` | PASS | median 49 ms, p95 53 ms, 0 timeouts |
| `r2.one_ws_health_responsive` | PASS | upgraded, 5/6 health ok, median 22 ms |
| `r2.multi_ws_health_and_config` | PASS | 5/5 upgrades, health max 80 ms, config 200/53 ms |
| `r2.capacity_limit_predictable` | PASS | held=8, only the 9th socket 503, health 200/26 ms |
| `r2.state_change_while_ws_open` | PASS | socketsHeld=2, real POST 200/73, heartbeat file written |
| `r2.ws_real_frames_and_echo` | PASS | frames=3 opcodes `[1,9]`, helloAck=true, real F99 payload |
| `r2.ws_close_abrupt_reconnect` | PASS | normalClose=true, abruptReconnect=true |
| `r2.ws_idle_expiry` | PASS | expired=true, waitedMs=8050 (8 s configured) |
| `r2.ws_malformed_handshake_bounded` | PASS | status 400 in 63 ms |
| `r2.repeated_cycles_no_leak` | PASS | okCycles=10, handles 896 → 910 (+14), threads 35 → 34, health 200/23 ms |

The headed browser, ordinary shipped frontend, no WebSocket stub — observed via
the passive native-subclass recorder (`browserWsObservationMechanism`
documented in the report; the Playwright context event channel stayed blind at
`contextEvents=0`, confirming why the recorder is required on this runner):

| Control | Verdict | Measured detail |
| --- | --- | --- |
| `real.browser_ws_real_frames` | PASS | **app** socket open, readyState 1, framesIn=11 framesOut=6, real F99 heartbeat/ping frames |
| `real.browser_ws_http_concurrent` | PASS | in-page `/health` 200 `{ws:true}`, force-poll 200, socket still open |
| `real.browser_ws_reconnect` | PASS | closing the app socket made the shipped 1/3/10/30 s ladder open a fresh app socket (appSockets=2) with a new frame |

`browserWsDiagnostic` distinguishes the two socket sources cleanly: the
shipped app's socket (`source:"app"`, readyState 1, 11 frames in, 6 out — hello
plus pong answers) and the harness manual probe (`source:"manual"`, tagged so
it can never count as app traffic). The recorder holds real native WebSocket
instances only; every recorded frame crossed the real network. Token values
are redacted in every recorded URL (`key=<redacted>`); the sanitized stdout and
audit contain only one saturated-503 line (the deliberate capacity probe) and
zero worker exceptions.

## What this proves, and its boundaries

- The original R2 defect — one inline `/ws` pump stalling the single accept
  thread and starving all HTTP for up to 30 minutes — is repaired on the actual
  Windows PowerShell server: bounded runspace workers behind a non-blocking
  semaphore keep ordinary HTTP inline and always responsive, with exact
  capacity behavior, prompt disconnect/slot reclaim (`Socket.Poll`), idle
  reaping, bounded malformed handling and no handle accumulation.
- The shipped, unstubbed frontend opens its own real WebSocket, exchanges
  genuine protocol frames, keeps HTTP polling alive concurrently and
  reconnects automatically — observed truthfully despite the runner's
  Playwright event blind spot.
- The authenticated screenshot still renders the early "No /ws endpoint" chip
  because it is captured immediately after the token gate, before the mount-time
  `/health` probe returns; the later in-page diagnostic fetch and the recorder
  both show `ws:true` and a live frame-carrying app socket, so this is a
  screenshot-timing artifact, not a runtime defect. It is reported, not hidden.
- Boundaries unchanged: this is LAB_HARNESS + PATCHED_APPLICATION_CANDIDATE
  evidence on a lab-runner identity. Native RDP and Web Desktop remain
  BLOCKED (no separate lab application server / real interactive listener /
  LogonType 10 correlation), and the read-only application upstream is neither
  deployed nor pushed to.

See the prior records for the four defects fixed along the way:
`windows-run-40081193119-root-cause.md` (PS 5.1 `Create` overload),
`windows-run-40082655039-finally-ownership.md` (outer-finally socket ownership),
`windows-run-40084261133-slot-leak.md` (pump EOF slot leak, `Socket.Poll`) and
`windows-run-40089578561-instrumentation-blind-spot.md` (Playwright event blind
spot + recorder), plus the shadowed-`/health` route fix in 0003.
