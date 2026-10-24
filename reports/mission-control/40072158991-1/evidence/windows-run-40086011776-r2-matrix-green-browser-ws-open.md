# Windows real-backend run 40086011776 — R2 matrix fully green; browser socket lane still open

Head lab SHA `20df25a` (the `Socket.Poll` slot-reclaim fix plus the two earlier
R2 runtime fixes). Workflow `real-backend.yml` on the `rdp-lab-client`
self-hosted Windows runner (`WIN-NFU1JG4VESE\User`,
`backendKind=actual_application`, `browserWebSocketStubbed=false`,
`browserMode=headed`). Step 7 smoke (22/22 at that revision) and step 8 PS 5.1
parse PASSed; step 9 measured; step 12 hard gate honestly FAILed on the three
headed browser WebSocket controls only. Bot machine evidence:
`evidence/real-backend-40086011776/`. Overall counts **30 PASS / 3 FAIL /
5 BLOCKED / 0 PENDING**.

## The Socket.Poll fix worked: every raw-socket R2 control now passes

| Control | Verdict | Measured detail |
| --- | --- | --- |
| `backend.ws_accept_loop_block` | PASS | `wsUpgraded=true blocked=false healthDuringWsMs=21` |
| `r2.no_ws_control_health` | PASS | median 21 ms, p95 61 ms, 0 timeouts |
| `r2.one_ws_health_responsive` | PASS | upgraded=true, 5/6 health ok, median 23 ms |
| `r2.multi_ws_health_and_config` | PASS | 5/5 upgrades, health 6/6 max 71 ms, config 200/32 ms |
| `r2.capacity_limit_predictable` | PASS | **held=8 rejected=1**, only the 9th socket 503, health 200/25 ms |
| `r2.state_change_while_ws_open` | PASS | socketsHeld=2, real POST 200/81, heartbeat file written |
| `r2.ws_real_frames_and_echo` | PASS | frames=4 opcodes `[1,11,14,9]`, helloAck=true |
| `r2.ws_close_abrupt_reconnect` | PASS | normalClose=true, abruptReconnect=true |
| `r2.ws_idle_expiry` | PASS | expired=true, waitedMs=8191 (8 s configured) |
| `r2.ws_malformed_handshake_bounded` | PASS | status 400 in 69 ms |
| `r2.repeated_cycles_no_leak` | PASS | okCycles=10/10, handles 890 → 901 (+11), threads 35 → 34, health 200/45 ms |

The sanitized stdout shows one `pool ready max=8`, exactly one
`ws 503 saturated count=0 avail=0` line (the capacity test's deliberate 9th
socket) and **zero** worker EXCEPTION lines — the slot leak from run
40084261133 is gone: workers now observe a peer FIN within one pump tick via
`Socket.Poll(0, SelectRead)` and release their gate slot in the worker finally.

## Remaining failure: the shipped browser never constructs a WebSocket

All three headed browser controls failed with `totalObservations=0` —
Playwright's context-level `websocket` event never fired across the whole
browser session, meaning the page's JavaScript never called the
`WebSocket` constructor (a rejected/blocked handshake would still emit the
event followed by a close):

- `real.browser_ws_real_frames` FAIL: `wsOpened=false framesIn=0 framesOut=0`
- `real.browser_ws_http_concurrent` FAIL: `health error="no-ws"`, force-poll 200
- `real.browser_ws_reconnect` FAIL: `reconnected=false totalObservations=0`

Static analysis of the production single-file bundle (built locally from the
same patched source) shows the lane is present and unconditional on mount:
`new WebSocket(...)` with the immediate bootstrap `k()` and a 5 s starter
interval, no `wsAvailable`/`wsLive` precondition (the F94 deadlock fix), no CSP,
no WebSocket override, no worker proxy. The authenticated shell renders and all
11 routed pages mount, so React itself is healthy.

### Root-cause candidate found and fixed in this revision: shadowed `/health`

The request chain contains two `if ($path -eq '/health')` branches. The first
(F45-R readiness probe, ~line 2797) always returns first and its body carried
**no `ws` field**; the second (F99, ~line 9277) that computed
`ws = [bool]$script:F96WsUpgradeSupported` was unreachable dead code. The
browser's `probeHealth` therefore always wrote `wsAvailable=false`, rendering
the false chip "No /ws endpoint" visible in
`patched-authenticated-patched.png`. Current source does not gate socket
construction on that flag, so this alone does not explain zero constructions —
but it is a real truthfulness defect and is fixed: the single live `/health`
route now advertises `ws = [bool]$script:F96WsUpgradeSupported`, the dead
duplicate is removed, and a 12th static assertion pins exactly one `/health`
route carrying the flag (12/12 r2 structural tests on LF and CRLF; full app
suite 108 files / 1390 tests).

### Harness diagnostic added for the next run (never a gate control)

Because no local browser is available in the lab sandbox, the cause of
"constructor never called vs called but unobservable vs environment-blocked"
can only be split on the Windows VM. `scripts/candidate/real-backend.js` now
collects `report.browserWsDiagnostic` (a report field, **not** a PASS/FAIL
control, so it cannot trip step 12):

- `typeof window.WebSocket` and its `toString` (detect a replaced/missing global);
- origin and the stored dash-token length (no token value is recorded);
- the `/health` JSON as fetched inside the page (must now show `ws:true`);
- page-level `request` / `requestfailed` / `response` events for `/ws`, which
  are independent of Playwright's `websocket` event and survive navigations;
- a manually constructed in-page WebSocket using the same
  `ws(s)://host/ws?key=…` URL shape, with open/frame/error/close events and
  readyState, plus whether the context observer saw it;
- a 7 s window for the app's own 5 s starter interval, and any console line
  mentioning ws/WebSocket.

The next run's diagnostic distinguishes: (a) global missing/replaced,
(b) app logic never reaching the constructor, (c) Playwright/Chromium
instrumentation blind spot (manual socket visible, app socket absent), or
(d) policy/proxy block (requestfailed with the cause). No threshold, identity
or stubbing rule is weakened; the evaluate gate stays red until the three
browser controls genuinely pass.
