# Windows real-backend run 40089578561 — Playwright WebSocket instrumentation blind spot; recorder-based observation

Head lab SHA `abd4361` (shadowed-`/health` fix + the non-gating
`browserWsDiagnostic` probe). Workflow `real-backend.yml` on the
`rdp-lab-client` self-hosted Windows runner (`WIN-NFU1JG4VESE\User`,
`backendKind=actual_application`, `browserWebSocketStubbed=false`,
`browserMode=headed`). Steps 7 (23/23 smoke) and 8 (PS 5.1 parse) PASSed;
step 9 measured; step 12 FAILed only on the three headed
`real.browser_ws_*` controls (30 PASS / 3 FAIL / 5 BLOCKED). All eleven
`r2.*`/backend raw-socket controls stayed PASS, so the `/health` route change
did not regress the accept-loop repair.

## What the diagnostic proved

`report.browserWsDiagnostic` split the four candidate causes:

| Probe | Result | Meaning |
| --- | --- | --- |
| `typeof window.WebSocket` | `function` | the global exists |
| `WebSocket.toString()` | `function WebSocket() { [native code] }` | not replaced/stubbed |
| in-page `/health` fetch | `200 {ok:true, ws:true, app:"ghrdp"}` | the shadowed-route fix works; the flag is now truthful |
| stored dash token length | 21 | the browser holds the synthetic key |
| **manual in-page WebSocket** | **`constructed=true, readyState=1 (OPEN)`, events `open` + real frames `{"ok":true,"ts":...}` and `{"type":"ping"...}`** | the headed Chromium really upgrades against the PowerShell server and receives genuine RFC6455 frames |
| Playwright context `websocket` events | **0, including for the provably-open manual socket** | the high-level observation channel is blind in this environment |
| page `request`/`requestfailed`/`response` for `/ws` | all empty, including for the manual socket | page-level WS network events are blind too |
| app socket over a 7 s starter window | not observable via context events | inconclusive through the blind channel; deferred to the recorder |

Conclusion: the failure is **not** an application/transport defect — the
browser, token, server upgrade path and frame codec all work in-page. Playwright
1.49.1's `BrowserContext.on('websocket')` (and page request events for the
`ws://` upgrade) do not deliver events on this self-hosted headed Windows
runner, so a harness that relies solely on them can never observe a socket
that is in fact open. The UI screenshot still rendered "No /ws endpoint"
because it was captured before the app's mount-time `/health` probe reflected
the new `ws:true` body; the later in-page diagnostic fetch confirms the body
itself is correct.

## The fix: a transparent, non-stubbing in-page recorder

`scripts/candidate/real-backend.js` now installs, via
`context.addInitScript` (before any page script runs), a passive recorder:

- it subclasses the **native** `WebSocket` (`WsObserver.prototype =
  NativeWebSocket.prototype`, static constants copied, constructor returns the
  real native instance), so `instanceof WebSocket` holds and every property,
  `send`/`close` and event behaves natively;
- it only adds passive `addEventListener` taps recording source
  (`app` vs tagged `manual`), redacted URL (the `key=` value is never stored),
  readyState transitions, open/frame/error/close events, in/out frame counts
  and the first three frame texts;
- **no transport is intercepted or faked**: every recorded socket really
  upgrades against the real server and every frame crosses the real network.
  `browserWebSocketStubbed` stays `false` and a new
  `browserWsObservationMechanism` report field documents the method;
- the manual environment probe is tagged `manual` so it can never be mistaken
  for an app-created socket.

The three `real.browser_ws_*` controls now read the recorder as primary
evidence (a real app socket that opened and received a genuine frame; an
in-page `/health` fetch while that socket stays at readyState 1; closing the
app's real socket and observing the shipped 1/3/10/30 s ladder open a fresh
one with frames), with the Playwright context-event count retained only as a
secondary diagnostic. The acceptance logic cannot pass without a real,
open, frame-carrying native socket created by the shipped app. The recorder
logic is unit-tested on Linux with a mock native WebSocket
(`/tmp/wsrepro/test-recorder.js`: native identity, `instanceof`, statics,
source tagging, frame accounting and token redaction all pass); the lab
regression suite stays 235 pass / 0 fail / 8 skip.

## Honest status

The raw-socket R2 matrix is fully green on real Windows and the browser
environment demonstrably carries real WebSocket traffic. The next run uses
the recorder to determine whether the **shipped application's own** socket
opens and frames correctly; until the three controls genuinely pass on that
evidence, the evaluate gate remains red and R2 is not declared accepted.
