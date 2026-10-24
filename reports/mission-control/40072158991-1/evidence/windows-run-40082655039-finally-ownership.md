# Windows real-backend run 40082655039 — second R2 defect: outer-finally socket teardown (ECONNRESET)

Head lab SHA `ae4bfad` (the PS 5.1 `Create()` fix). The one-argument
`Create(RunspacePool)` MethodException was eliminated — the captured server
stdout shows only `[LAB-R2] websocket worker pool ready max=8` with **zero**
`dispatch FAULT` / `gate FAULT` / `saturated` lines, so workers now construct
and admission never rejects. A new, distinct failure mode appeared.

## Observed: every upgrade resets before the 101

`timings.wsBlock = { wsUpgraded: false, error: "ECONNRESET" }` and every
WebSocket control reported `ECONNRESET` with an empty response body (no 400/503):
`r2.one_ws_health_responsive` BLOCKED, `r2.capacity_limit_predictable`
`held=0 rejected=9` with empty statuses, `r2.ws_real_frames_and_echo` BLOCKED,
`r2.ws_malformed_handshake_bounded` ECONNRESET, `r2.repeated_cycles_no_leak`
`okCycles=0`. Ordinary HTTP stayed fast (`/health` median 50 ms, p95 59 ms) and
the stall comparison still favoured the candidate (baseline 3818 ms vs patched
1049 ms).

## Root cause: the request handler's outer finally owns the socket

`Invoke-ClientRequest` wraps all routing in one `try` whose `finally` is:

```powershell
} finally {
    try { if ($stream) { $stream.Dispose() } } catch { }
    try { $Client.Close() } catch { }
}
```

A `finally` runs on a normal `return` too. In the pristine inline design the
`/ws` pump blocked inside that `try` for the socket's whole lifetime, so the
cleanup only ran after the pump finished. After moving the pump to an async
worker, `Invoke-R2DispatchWebSocket` returns immediately and the `/ws` branch
returns — so the outer `finally` disposed the network stream and closed the
client **before the worker runspace could write the 101**. The worker's first
write then hit a disposed socket and the client observed a TCP RST.

## The fix: explicit ownership transfer

- Initialise `$r2Dispatched = $false` at the top of `Invoke-ClientRequest`.
- The `/ws` branch sets `$r2Dispatched = $true` after dispatch and returns.
- Guard the outer cleanup: `if (-not $r2Dispatched) { …Dispose/Close… }`.

The worker's own `finally` already disposes the stream, closes the client, marks
the record done and releases the admission gate, so a dispatched socket still
has exactly one owner and is never leaked. The inline 400/503 paths inside the
dispatcher also close their socket themselves, so suppressing the outer cleanup
is safe for every `/ws` sub-path. Ordinary HTTP requests leave the flag false
and keep their original deterministic disposal.

## Observability hardening in the same patch

The worker previously had an empty `catch {}`, which is why this fault surfaced
only as a bare reset. It now logs `[LAB-R2] worker EXCEPTION: <type> <message>`
to stdout and audit, and logs when the pump returns false or the 400 send fails.
A tenth static assertion pins the ownership flag and the guarded finally, so
this regression cannot silently return.

## Verification before re-running Windows

r2 static test 10/10 on LF and CRLF; clean replay 3 files / 21 smoke tests
(f201 8 + r1 3 + r2 10); full application suite 108 files / 1388 tests;
production build OK; lab suite 235 pass / 0 fail / 8 skip. The next Windows run
is expected to show real `101` upgrades, capacity holding at eight with a 503
only on the ninth, live frames/echo, idle expiry and reconnect; the evaluate gate
still hard-fails if any r2 control fails or the socket is stubbed.
