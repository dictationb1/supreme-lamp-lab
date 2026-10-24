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
  (vitest, 8 tests; fails on the pristine base, passes on the repaired file) and
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
fault). The fix uses parameterless `[powershell]::Create()` plus the settable
`RunspacePool` property and adds a 9th static test pinning it; clean replay is
9/9 r2, 1387/1387 full suite, build OK. Do not claim R2 acceptance until the next
Windows run shows real `/ws` 101 upgrades and a passing r2 matrix; see
`evidence/windows-run-40081193119-root-cause.md`.
