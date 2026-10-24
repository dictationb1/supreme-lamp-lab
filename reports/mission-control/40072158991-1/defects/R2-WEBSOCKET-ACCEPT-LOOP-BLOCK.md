# R2 — a single WebSocket blocks the entire HTTP server (CONFIRMED on base; FIXED in 0003)

- **Class:** real application backend defect (Windows PowerShell 5.1 server), then a lab repair in this bundle.
- **Baseline source:** complete unmodified clone at `832a82eb7c29613b0b101585c56b5011ea008a06`,
  file `payloads/ghrdp-server.ps1` (the R2 structure is unchanged from the earlier
  `4a91c5c2…` base: the only upstream delta is `docs/status.json`).
- **Repair:** `app-patches/0003-R2-websocket-worker-runspace.patch`.

## 1. Structural root cause (source-confirmed, HIGH confidence)

The accept loop is a single thread and serves each connection synchronously:

```powershell
while ($listener.Pending()) {
    $client = $null
    try { $client = $listener.AcceptTcpClient() } catch { }
    if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
}
```

`Invoke-ClientRequest` handles `GET /ws` by calling `Invoke-F99WebSocketUpgrade`
**inline**. That function enters a pump loop that lives up to
`$script:F99WsMaxLifetimeSec = 1800` s (30 min) or
`$script:F99WsIdleTimeoutSec = 90` s of client silence. While it runs, the only
accept thread cannot drain any other connection, so every lightweight endpoint
(`/health`, `/api/config`, `/api/native-status`, `/api/progress`, `/ping`,
button POSTs) waits in the TCP backlog.

The shipped frontend (`src/hooks/useDashboardPolling.ts`) opens `/ws` on boot and
independently polls config (15 s), native-status (10/15 s), progress (3 s), ping
(5 s) and health (30 s). The moment the first `/ws` upgrades, all of those polls
starve — the observed stale green "Live" badge, blank FQDN/user/IP, disabled
launch gate and inert controls. This is one transport-starvation defect, not a
set of independent UI bugs.

## 2. Baseline reproduction (bounded, real Windows VM)

The harness probe `measureWsBlock()` in `scripts/candidate/real-backend.js`
opens one authenticated `/ws`, then fires `GET /health` on a separate
connection and records whether it answers within a hard bound. Historical
definitive run `40068292422` measured, on BOTH the pristine baseline and the
R1-only candidate:

- `wsUpgraded=true`, `blocked=true`;
- `/health` timed out after **5008 ms baseline / 5005 ms R1-only**;
- best-effort recovery had **not** recovered after ~16.5 s.

The earlier run `40063545799` hung 26+ minutes as soon as a real browser opened
the app — consistent with the 30-minute inline pump lifetime. The full
baseline-vs-repaired matrix in this bundle re-confirms the failure on the
pristine server and the pass on the repaired one (see `evidence/real-backend-*`
published by the `real-backend-run` workflow).

## 3. The repair (smallest supported change — no general concurrency rewrite)

Only the long-lived `/ws` pump is moved off the accept thread; **ordinary HTTP
stays inline**, so the entire existing `$script:` ticket/cache/credential/
revocation state keeps its proven single-threaded semantics.

- A `[runspacefactory]::CreateRunspacePool` pool is created once, with
  `MaxRunspaces == $script:R2WsMaxClients` (default 16, env
  `GHRDP_WS_MAX_CLIENTS`, clamped 4..64).
- A `System.Threading.SemaphoreSlim` is the bounded admission authority.
  Admission uses **non-blocking** `Wait(0)`: an over-capacity `/ws` gets an
  immediate, predictable `503` and is closed — the accept thread never parks and
  no unbounded queue can form. HTTP keeps being served while saturated.
- Each worker runspace receives only the pump's real dependency surface
  (`Invoke-F99WebSocketUpgrade`, `Test-TicketBearer`, `Test-IsLoopbackAddr`,
  `Send-ClientResponse`, the three F99 tunables, and the audit path/lock). It
  cannot reach `$script:RdpTokens`, the credential ledger or any cache, so a
  single-use ticket cannot be double-consumed and credential rotation/revocation
  cannot be revived from a stale worker snapshot. The dash token is passed
  per-connection and validated inside the pump exactly as before.
- All audit appends (inline accept thread + worker runspaces) serialize on one
  shared `[System.Threading.Monitor]` lock object.
- The worker closes its stream/socket and releases the semaphore in `finally`
  on every path (normal close, idle/max-lifetime expiry, abrupt peer, shutdown).
  A non-blocking reaper inside the accept loop disposes finished PowerShell
  handles; `Stop-R2WebSocketPool` closes live sockets and disposes the pool and
  semaphore at shutdown.
- If a pool cannot be created (a constrained host), the dispatcher falls back to
  the legacy inline pump rather than disabling WebSockets; the condition is
  audited. WebSockets are never turned off and `ws` is never faked.
- Test/ops env tunables `GHRDP_WS_PING_INTERVAL_SEC`, `GHRDP_WS_IDLE_TIMEOUT_SEC`
  and `GHRDP_WS_MAX_LIFETIME_SEC` default to the original 20/90/1800 when unset,
  so production behavior is unchanged; they only let a lab bound the
  idle/lifetime tests.

## 4. Acceptance (real sockets, real server, real browser)

`scripts/candidate/real-backend.js` now runs a pre-declared finite matrix
(`R2_THRESHOLDS`, fixed before any run): no-WS control; one held socket with
concurrent `/health`; five simultaneous sockets with `/health` + authenticated
`/api/config`; the connection cap with a 503 on the excess; a real state-changing
`POST /api/handler-hello` while sockets are held; genuine frames + hello-ack;
normal close / abrupt disconnect / reconnect; server-side idle expiry; a bounded
malformed handshake; and ten connect/close cycles with a process-handle trend.
The browser phase drives the **ordinary shipped frontend with no WebSocket
stub** (`browserWebSocketStubbed=false`, `backendKind=actual_application`,
headed), observing the real `/ws` upgrade and frames, proving HTTP polling and a
button request continue beside the live socket, and that the app's reconnect
ladder re-establishes the bridge after a controlled interruption.

- Static structure (no Windows): `src/tests/smoke/r2-websocket-worker.test.ts`
  (vitest, 11 tests; fails on the pristine base, passes on the repaired file) and
  `scripts/test/ws-frame-regressions.js` (framing + patch invariants).
- Behavioral timing (Windows client VM): the `real-backend-run` labelled
  workflow, baseline vs repaired with identical fixtures. Thresholds are frozen
  in the harness and never adjusted after a failure.

## 5. Confidence and measured runtime status

HIGH for the structural defect and its UI consequence (source + prior VM
timing). HIGH for the repair's structural correctness (static tests + clean
replay + full 1386-test frontend suite + production build).

Measured on the real Windows client (run 40078279249): the starvation itself is
fixed — pristine blocks `/health` 5011 ms under one `/ws` (stall 4615 ms), the
patched server keeps HTTP responsive (stall 826 ms, median health 23–54 ms).
However every `/ws` upgrade returned 503 even for the first connection on a
fresh cap=8 gate. Instrumented run 40081193119 root-caused that to a PowerShell
5.1 accelerator binding fault —
`System.Management.Automation.MethodException: Cannot find an overload for
"Create" and the argument count "1"` from `[powershell]::Create($pool)` — while
the admission semaphore and runspace pool were healthy (`avail=8`, no gate
fault). That first runtime fix (parameterless `[powershell]::Create()` plus the settable
`RunspacePool` property) removed every 503, and run 40082655039 then exposed a
second, distinct defect as `ECONNRESET` before the 101: `Invoke-ClientRequest`'s
outer `try/finally` disposed the stream and closed the client on every return,
which for an async-dispatched `/ws` tore the socket down before the worker could
write. It is fixed with an `$r2Dispatched` ownership flag that suppresses the
outer cleanup for dispatched sockets (the worker `finally` is now the single
owner), and the previously-empty worker `catch` logs `[LAB-R2] worker
EXCEPTION`. Ten static assertions pin both fixes; clean replay is 10/10 r2,
1388/1388 full suite, build OK. Do not claim R2 acceptance until the next Windows
run shows real `/ws` 101 upgrades and a passing r2 matrix; see
`evidence/windows-run-40081193119-root-cause.md` and
`evidence/windows-run-40082655039-finally-ownership.md`.

## 6. Third runtime defect (run 40084261133): pump EOF blind spot leaks worker slots

Run 40084261133 (head `a1d98f1`) proved the first two fixes on the real Windows
VM: genuine HTTP 101 upgrades occur and `backend.ws_accept_loop_block`,
`r2.no_ws_control_health`, `r2.one_ws_health_responsive` and
`r2.multi_ws_health_and_config` all PASS with HTTP never blocked. It exposed a
third, distinct defect: with `GHRDP_WS_MAX_CLIENTS=8` the gate drained to
`count=0 avail=0` while only 3–5 sockets were actually held — capacity control
reached only `held=3` then issued six 503s, cycles passed only 5/10 with handle
growth 886 → 913, and reconnect/frames/idle/malformed controls failed or were
blocked. The sanitized stdout has 18 `ws 503 saturated count=0 avail=0` lines,
zero `ws closed` lines and zero `worker EXCEPTION` lines.

Root cause: the F99 pump only calls `NetworkStream.Read` when
`$Client.Client.Available -gt 0 -or $Stream.DataAvailable`. A peer disconnect
with no buffered bytes therefore never issues a Read, the EOF (`Read` → 0)
branch is unreachable, and the worker sleeps until `F99WsIdleTimeoutSec`
instead of releasing its semaphore slot — a silent slot leak, not a throw.

Fix: a non-blocking liveness probe at the top of each pump iteration —
`$Client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead)` returning
true together with `Available -eq 0` means the peer half-closed/reset, so the
loop breaks with status 1006 into the existing worker `finally`
(close/dispose/`Release()`, reaper disposes the runspace handle). An idle open
socket returns false and keeps the prior behavior; `Socket.Poll` is available on
both .NET Framework (PS 5.1) and .NET (PS 7). No capacity or timeout value was
changed and the `Wait(0)` gate is untouched. An 11th static assertion pins the
Poll pattern; the r2 suite passes 11/11 on LF and CRLF, full application suite
1389/1389, build OK. R2 acceptance still requires the next Windows run to show
8 held with 503 only on the 9th socket, frames/echo, idle expiry, clean
reconnect, 10/10 leak-free cycles and the three headed `real.browser_ws_*`
controls; see `evidence/windows-run-40084261133-slot-leak.md`.

## 7. Run 40086011776: raw-socket R2 matrix fully green; browser socket still open

The `Socket.Poll` fix was confirmed on the real Windows VM at head `20df25a`:
all ten `r2.*` behavioral controls plus `backend.ws_accept_loop_block` PASS
(30 PASS / 3 FAIL / 5 BLOCKED overall). Capacity behaves exactly as designed
(held=8, only the deliberate 9th socket 503s), genuine frames arrive
(opcodes `[1,11,14,9]`, hello-ack true), normal and abrupt reconnects pass,
idle expiry fires at 8191 ms, malformed handshakes get a bounded 400, and 10/10
cycles complete with only +11 handles and flat threads. The sanitized stdout
has one saturated-503 line (the capacity probe itself) and zero EXCEPTION
lines: the slot leak is gone.

The three remaining FAILs are all headed-browser controls:
`real.browser_ws_real_frames`, `real.browser_ws_http_concurrent` and
`real.browser_ws_reconnect`, with Playwright `totalObservations=0` — the page
never calls the `WebSocket` constructor (a blocked handshake would still emit
the context event). The server upgrade path is proven healthy by the raw-socket
matrix against the same process, so this is a browser-lane defect, not another
accept-loop defect.

### Defect #4 (fixed): shadowed `/health` route hid the ws advertisement

`Invoke-ClientRequest` contained two `if ($path -eq '/health')` branches. The
first (F45-R readiness) returns first and omitted `ws`; the second
(`ws = [bool]$script:F96WsUpgradeSupported`) was unreachable. The browser's
`probeHealth` therefore always set `wsAvailable=false` and rendered a false
"No /ws endpoint" chip (see `patched-authenticated-patched.png`). The single
live route now includes `ws = [bool]$script:F96WsUpgradeSupported`, the dead
duplicate is removed, and static assertion 12 pins one `/health` route carrying
the flag. The current client does not gate construction on `wsAvailable` (F94
removed that precondition), so a separate harness-only
`report.browserWsDiagnostic` field was added (global shape, in-page `/health`
body, page-level `/ws` request/failure/response events, a manual in-page
socket, context-observer visibility and a 7 s app-starter window) to attribute
the zero-construction symptom on the next Windows run without any gate
weakening. r2 structural 12/12 LF+CRLF; full suite 1390/1390; build OK.
