# Windows real-backend run 40084261133 — third R2 defect: F99 pump EOF blind spot leaks worker slots

Head lab SHA `a1d98f1` (PS 5.1 `Create()` fix plus the `r2Dispatched`
outer-finally ownership guard). Workflow `real-backend.yml` on the
`rdp-lab-client` self-hosted Windows runner (`WIN-NFU1JG4VESE\User`,
`backendKind=actual_application`, `browserWebSocketStubbed=false`,
`browserMode=headed`). Steps 7 (smoke gate) and 9 (measurement) succeeded;
step 12 (hard evaluate gate) honestly FAILed. Bot-committed machine evidence
lives under `evidence/real-backend-40084261133/`.

## Defects #1 and #2 are confirmed fixed on the real VM

Real HTTP `101 Switching Protocols` upgrades now happen, which was impossible
in the two prior runs:

| Control | Verdict | Measured detail |
| --- | --- | --- |
| `backend.ws_accept_loop_block` | PASS | `wsUpgraded=true blocked=false healthDuringWsMs=55` |
| `r2.no_ws_control_health` | PASS | median 53 ms, p95 58 ms, 0 timeouts |
| `r2.one_ws_health_responsive` | PASS | upgraded=true, 5/6 health ok, median 30 ms |
| `r2.multi_ws_health_and_config` | PASS | 5/5 upgrades, health 6/6 max 88 ms, `/api/config` 200/39 ms |

Ordinary HTTP never blocks while WebSocket workers pump — the core R2
accept-loop starvation is gone on the actual PowerShell server.

## Observed: the bounded gate drains while few sockets are live

The remaining r2 matrix did not pass:

- `r2.capacity_limit_predictable` FAIL: cap `GHRDP_WS_MAX_CLIENTS=8`, but only
  **held=3** before **rejected=6**, every rejection status **503** with body
  `"websocket capacity exhausted; retry"`; `/health` during saturation still
  200/33 ms (admission itself behaves correctly — the capacity accounting is
  wrong).
- `r2.repeated_cycles_no_leak` FAIL: `okCycles=5/10`, process handles
  **886 → 913 (+27)** while threads stay flat at 34, health 200/55 ms.
- `r2.ws_close_abrupt_reconnect` FAIL: `normalClose=false abruptReconnect=false`.
- `r2.ws_idle_expiry` BLOCKED (`expired=false`),
  `r2.ws_real_frames_and_echo` BLOCKED (`503 websocket capacity exhausted`),
  `r2.ws_malformed_handshake_bounded` FAIL (503 instead of the inline 400
  path), `r2.state_change_while_ws_open` FAIL with `socketsHeld=0`.
- `real.browser_ws_real_frames`, `real.browser_ws_http_concurrent`,
  `real.browser_ws_reconnect` all FAIL: the pool was already exhausted before
  the browser phase, so the shipped app never obtained a socket.

The sanitized server stdout contains one
`[LAB-R2] websocket worker pool ready max=8` line and exactly **18**
`[LAB-R2] ws 503 saturated count=0 avail=0 max=8` lines — **all at
`count=0 avail=0`**. There are **zero** `ws closed` lines and **zero**
`[LAB-R2] worker EXCEPTION` lines, i.e. no worker is throwing; the slots are
held by workers that are silently sleeping.

## Root cause: a guarded Read can never observe a peer FIN

The F99 WebSocket pump in `payloads/ghrdp-server.ps1` only issues a read when
bytes are already buffered:

```powershell
while (...lifetime... -and ...idle...) {
    try {
        if ($Client.Client.Available -gt 0 -or $Stream.DataAvailable) {
            $n = 0; try { $n = $Stream.Read($buf,0,$buf.Length) } catch { break }
            if ($n -le 0) { $f99CloseStatus = 1006; break }
            ...
```

When the peer drops a connection that has no pending frame, `Available` is 0
and `DataAvailable` is false, so no `Read` is ever issued and the
end-of-stream signal (`Read` returning 0) is unreachable. The worker keeps
pumping (sleeping) until `F99WsIdleTimeoutSec` expires — 8 s in the test
environment, longer than the whole capacity/cycle phase — while still holding
its `SemaphoreSlim` gate slot. Eight slots therefore drain to `avail=0` even
though only three to five sockets are actually open, producing the premature
503s, failed reconnect/frames controls and the handle growth (the accept-loop
reaper can only dispose the `PowerShell` handle once the worker finally exits).

This is consistent with the absence of exception lines: it is a silent
idle-pump path, not a fault.

## Fix: non-blocking `Socket.Poll` liveness probe

At the top of every pump iteration, before the data-availability check:

```powershell
if ($Client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and
    $Client.Client.Available -eq 0) {
    $f99CloseStatus = 1006
    break
}
```

`Poll(0, SelectRead)` returns immediately (non-blocking) and is signalled both
for readable data **and** for a half-close/reset with zero bytes available.
Poll-true plus zero `Available` therefore means the peer has gone away, so the
loop breaks into the existing worker `finally`, which closes the socket,
disposes the stream, releases the gate slot and lets the accept-loop reaper
dispose the runspace handle — all within one loop tick instead of an idle
timeout. An idle, healthy socket returns false from `Poll` and keeps the
original wait behavior; the writable/ping paths are untouched.

Compatibility and invariants:

- `System.Net.Sockets.Socket.Poll` exists on .NET Framework (Windows
  PowerShell 5.1, the runner's runtime) and on .NET (PowerShell 7).
- No timeout inflation, no `GHRDP_WS_MAX_CLIENTS` increase, no weakening of the
  `Wait(0)` non-blocking gate; single-use ticket atomicity and the
  `r2Dispatched` ownership guard are unchanged.
- An 11th static assertion in
  `src/tests/smoke/r2-websocket-worker.test.ts` pins the
  `Poll(0, SelectRead)` + `Available -eq 0` → 1006 pattern; the r2 structural
  suite passes 11/11 on both LF and CRLF copies of the server script.

## Local verification of the fix (Windows re-confirmation still pending)

- r2 structural test: 11/11 on LF and 11/11 on CRLF.
- Clean bundle replay: 3 files / 22 smoke tests (f201 8 + r1 3 + r2 11),
  production build OK, `verify-bundle.sh` VERIFY OK.
- Full patched application suite: 108 files / 1389 tests, all passing.

The next `real-backend.yml` run must show, for R2 acceptance: exactly 8 held
sockets with 503 only on the 9th, real frames/echo, server-side idle expiry,
a clean abrupt-close reconnect, `okCycles=10/10` with no handle growth, and
the three `real.browser_ws_*` controls passing in the headed browser. Until
then the evaluate gate stays red by design.
