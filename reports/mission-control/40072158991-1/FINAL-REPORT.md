# Mission Control R2 repair — final report (separated scopes, honest verdicts)

Generated 2026-10-24. Writable lab repository `dictationb1/supreme-lamp-lab`,
continuation branch `arena/25db7e16-supreme-lamp-lab` (PR #29). Read-only
application repository `dictationb1/supreme-lamp` is never pushed, deployed or
forged. Authoritative machine evidence:
`evidence/real-backend-40091165292/` and the per-run narrative records beside
it. Every PASS below traces to a real measurement on the Windows client or a
real local test; nothing is simulated into a PASS.

## Headline

The R2 defect (one inline `/ws` pump stalling the single accept thread and
starving all HTTP for up to 30 minutes) is **repaired and accepted on the real
Windows client**: run **40091165292**, workflow `real-backend.yml`, evaluate
step green, **33 PASS / 0 FAIL / 5 BLOCKED** across 38 controls, with
`backendKind=actual_application`, `browserWebSocketStubbed=false` and
`browserMode=headed`. The five BLOCKED controls are pre-declared capabilities
that need infrastructure this lab does not have (a genuine interactive logon,
a staged file index, an external search backend, native RDP and Web Desktop);
they are recorded BLOCKED, never passed.

**Reproduced three times in a row** on the same Windows runner with identical
verdict counts — run 40091165292 (head `5ba3745`), run 40092088400 (head
`c76882f`) and run 40092300001 (head `aba6fa9`), each 33 PASS / 0 FAIL /
5 BLOCKED with the app's own socket carrying real frames; the later heads
changed only bundle documentation, so the green result is stable rather than a
one-off.

Four distinct runtime/instrumentation defects were found and fixed on the way,
each pinned by a structural regression and re-measured on the VM; the FAIL
history is retained run-by-run in `control-coverage.csv`.

## Scope verdicts

### 1. LAB_HARNESS — PASS

- Hosted regressions (`scripts/run-regressions.js`, Linux Node v22):
  243 tests, 235 passed, 0 failed, 8 skipped (optional browser e2e lanes).
- Application suite inside the patched tree: 108 files / **1390 tests pass**,
  including 12 LAB-R2 structural assertions (the suite fails on the pristine
  base and passes only with the repair), green on both LF and CRLF copies.
- RFC6455 framing library `scripts/lib/ws-frame.js` and its regressions green;
  the new in-page WebSocket recorder is unit-tested with a mock native
  WebSocket (native identity, `instanceof`, statics, source tagging, frame
  accounting and token redaction).
- The clean-room replay (`REPLAY=1 verify-bundle.sh`) re-downloads the pinned
  base, verifies its sha256, applies all three patches cleanly, runs the VM
  smoke gate (f201 8 + r1 3 + r2 12 = 23/23) and builds the production UI.
- Thresholds are frozen before any run (`R2_THRESHOLDS`) and were never
  adjusted after a failure.

### 2. LIVE_ORIGIN_APPLICATION — OBSERVED (read-only), signal still live

- Hyperlink TARGET run `40072158991` is observed, never re-run or modified. Its
  MC-SIGNAL check-run (120809833121) remains live and cryptographically bound;
  structural validation from the lab is documented in
  `evidence/live-origin-signal-validation.md`.
- The tailnet endpoint (100.85.153.77:7331) is reachable only on the tailnet /
  from the VM, so live end-to-end decryption stays VM-bound and is honestly
  marked unreachable from this sandbox rather than assumed.
- No endpoint, credential or ticket from any older run is reused.

### 3. PATCHED_APPLICATION_CANDIDATE — R2 PASS on real Windows

Identity on run 40091165292: application sha `832a82eb…`, lab revision
`5ba3745…`, runner `WIN-NFU1JG4VESE\User`, headed Chromium, real PowerShell
server (socket owner `powershell.exe`), fresh lab-only synthetic dash key
(never an upstream credential).

Raw-socket behavioral matrix (real RFC6455 against the actual server):

- Accept loop never blocks: `ws_accept_loop_block` PASS (101 upgrade, health
  200 in 53 ms while the socket pumps); no-WS health median 49 ms p95 53.
- Bounded admission is exact: cap 8 → held=8, only the 9th socket 503
  `"websocket capacity exhausted; retry"`, HTTP still 200 during saturation.
- Real frames and hello-ack; normal close and abrupt reconnect; idle expiry of
  a silent peer at ~8 s while interactive ponging sockets stay alive; malformed
  handshake bounded 400; ten connect/frame/close cycles with handles
  896 → 910 (+14) and threads flat (35 → 34).

Headed browser, ordinary shipped frontend, no stub — observed through the
passive native-WebSocket recorder because Playwright's context `websocket`
events are blind on this runner (proven on run 40089578561):

- The shipped **application's own** socket (`source:"app"`) reached readyState
  1, received 11 genuine frames and sent 6 (hello + pong answers).
- An in-page `/health` fetch returned 200 `{ws:true}` and a force-poll returned
  200 while that socket stayed open.
- Closing the app socket made the shipped 1/3/10/30 s reconnect ladder open a
  second real app socket that received a fresh frame.
- All eleven routed pages mounted against real backend responses; the token
  gate, authenticated shell and theme toggle passed.

Startup comparison vs the pristine baseline on the same host: baseline stalls
and hits the harness deadline (8 FAIL / 4 BLOCKED, no ready marker); the
patched candidate reports READY, stall ~3.3 s → 0.93 s, health p95 109 → 72 ms,
recovery after a held socket in 46 ms.

### 4. UPSTREAM_DEPLOYMENT — NOT_RUN

The application remote is read-only this session. There is no deploy, settings
change, push or forged signal against `dictationb1/supreme-lamp`. Rollback for
the candidate is a single `git revert` of 0003 (or removing it from
`series.txt`); F201 and R1 are independent patches and remain valid. Upstream
promotion is explicitly left to an application session/operator, keeping the
three patches in order and retaining the r2 regression.

### 5. AUTOMATIC_APPLICATION_ORIGIN_INTEGRATION — structurally PASS; live tailnet VM-bound

MC-SIGNAL publication succeeds on the live origin run and validates
structurally and cryptographically from the lab. Automatic end-to-end
integration through the live tailnet endpoint/decryption cannot be exercised
off-tailnet from this sandbox and remains a VM-bound step; it is not claimed as
a full PASS.

### Native RDP / Web Desktop — BLOCKED (not part of the green R2 set)

`real.native_rdp_connect` and `real.web_desktop_frames` stay BLOCKED: they
require a separate lab-owned Windows application server with a real test RDP
account/listener, a signed launcher and a captured interactive session
correlated to a remote-interactive LogonType 10. A loopback helper connect, a
server self-test or an image difference is not accepted as proof, and no
simulated frames are counted. `real.sessions.list`, `real.files.browse` and
`real.search.query` are likewise BLOCKED on a genuine logon, staged file index
and external search backend (404/403 observed, recorded honestly).

## Defects found and fixed (full FAIL history preserved)

1. PS 5.1 `[powershell]::Create(RunspacePool)` MethodException → parameterless
   `Create()` + settable `RunspacePool` (run 40081193119).
2. Outer request `finally` disposed the worker-owned socket before the 101
   (ECONNRESET) → `$r2Dispatched` ownership guard (run 40082655039).
3. F99 pump never observed a peer FIN without buffered bytes, leaking worker
   slots to idle timeout → non-blocking `Socket.Poll(0, SelectRead)` EOF probe
   (run 40084261133; fixed and confirmed on 40086011776/40091165292).
4. A shadowed duplicate `/health` route omitted the `ws` advertisement, and
   Playwright's WebSocket/request events were blind on the runner → single live
   `/health` route returning `ws=true`, plus a transparent native-subclass
   in-page recorder (runs 40086011776 / 40089578561; accepted 40091165292).

## Known honest limitations

- The authenticated screenshot still shows the early "No /ws endpoint" chip
  because it is captured immediately after the token gate, before the
  mount-time `/health` probe returns; later in-page evidence in the same run
  shows `ws=true` and a live frame-carrying app socket. Reported, not hidden.
- Playwright context WebSocket events remain blind on this self-hosted runner
  (`contextEvents=0` even for a provably-open socket); the native recorder is
  the trustworthy channel and cannot pass a control without a real, open,
  frame-carrying application socket.
- Evidence is sanitized (tokens redacted, no private keys/passwords); the
  synthetic dash key is lab-only and its value never appears in recorded URLs.
