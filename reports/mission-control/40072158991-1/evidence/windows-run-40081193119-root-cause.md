# Windows real-backend run 40081193119 — exact root cause of the all-503 defect and its fix

Head lab SHA `747192d` (the instrumented 0003). The diagnostic instrumentation
added after run 40078279249 localised the fault on the first attempt.

## The exact fault (from captured server stdout)

Every rejected upgrade logged the same single line, repeatedly, with the pool
reporting eight available runspaces:

```
[LAB-R2] websocket worker pool ready max=8
[LAB-R2] dispatch FAULT: System.Management.Automation.MethodException
  Cannot find an overload for "Create" and the argument count: "1". avail=8
```

There were **no** `gate FAULT` or `saturated` lines, which proves the bounded
admission semaphore worked correctly: `R2WsGate.Wait(0)` admitted the
connection (count 8 → 7), and the failure happened one line later while
constructing the worker PowerShell instance:

```powershell
$r2Ps = [powershell]::Create($script:R2WsPool)   # PS 5.1: MethodException
```

The Windows PowerShell 5.1 `[powershell]` type accelerator cannot bind the
static `PowerShell.Create(RunspacePool)` one-argument overload; it reports no
matching 1-arg `Create`. The catch released the gate and returned the
`websocket worker unavailable` 503, so every upgrade — including the first —
failed while ordinary HTTP stayed fast. This is purely a PowerShell-language
binding incompatibility, not a concurrency, capacity or protocol defect.

## Why the gate and the dependency surface were already correct

- `avail=8` and the absence of gate faults confirm `SemaphoreSlim` non-blocking
  admission behaves exactly as designed; the pool opened with max runspaces 8.
- The pump's only top-level function dependencies
  (`Test-TicketBearer`, `Test-IsLoopbackAddr`, `Write-ClientAudit`,
  `Send-ClientResponse`) are all injected into the worker InitialSessionState;
  `Send-F99WsPing`/`Send-F99WsText` are nested inside
  `Invoke-F99WebSocketUpgrade` and travel with its copied definition.
- The pump references only the three `$script:F99Ws*` tunables, which the worker
  preamble sets from `$Ctx`; it never reaches the ticket/credential/cache state,
  preserving single-threaded shared-state semantics.

## The fix (0003, PS 5.1 and PS 7 compatible)

Use the parameterless constructor and assign the pool through the settable
`RunspacePool` property instead of the one-argument static overload:

```powershell
$r2Ps = [powershell]::Create()
$r2Ps.RunspacePool = $script:R2WsPool
[void]$r2Ps.AddScript($script:R2WsWorker).AddArgument($r2Ctx)
$r2Ar = $r2Ps.BeginInvoke()
```

A ninth static assertion pins this so the accelerator overload cannot return:
the source must contain `[powershell]::Create()` and
`$r2Ps.RunspacePool = $script:R2WsPool`, and must not contain
`[powershell]::Create($script:R2WsPool)`. The r2 static test is 9/9 on both LF
and CRLF; full clean replay is 3 files / 20 smoke tests and 108 files /
1387 full-suite tests passing, with the production build green.

## What remains to be proven on the next Windows run

The next labelled run must show real `101` upgrades and the r2 matrix
exercising live workers: capacity holding exactly eight with a 503 only on the
ninth, `/health` latency while sockets are held, real frames/echo, idle expiry,
close/reconnect and the no-leak handle trend. A 503 on the very first connection
must not recur. The evaluate gate continues to hard-fail on any r2 FAIL, any
stubbed socket, or a backend that is not `actual_application`.
