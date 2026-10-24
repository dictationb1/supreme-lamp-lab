# Mission Control continuation handoff — run 40072158991 / candidate @ 832a82eb

Audience: the next **application-only** session that can push to
`dictationb1/supreme-lamp`. This lab (`supreme-lamp-lab`) never pushes to the
application remote; it produces a replayable, integrity-checked patch series.

- Application revision under repair: `832a82eb7c29613b0b101585c56b5011ea008a06`
  (parent `4a91c5c2eadc12e5b071bc46bae7683087f56fbd`; the only new commit changes
  `docs/status.json`, so the earlier 4a91c5c2-based series still applies).
- Application codeload zip sha256:
  `c0de6455046c896d8cd61e8671d566a29c2aaa4aa946fd4cd4c791d1ca2d2393`
  (identical across two independent downloads).
- Lab continuation branch: `arena/25db7e16-supreme-lamp-lab`, consolidated by
  fast-forwarding PR #28 head `c7a0bf6…` (all prior reader/harness/signing/
  authorization/UI repairs are preserved, nothing older was restarted).

## 1. What this bundle adds

Ordered application patches in `app-patches/` (apply in `series.txt` order):

1. `0001-F201-probe-honesty.patch` — preserved unchanged. A refused/empty probe
   must never render as a confirmed credential/DNS/listener failure.
2. `0002-R1-server-startup-readiness.patch` — preserved unchanged. Removes the
   three synchronous pre-accept `Get-WinEvent` scans, publishes HTTP readiness
   from inside the accept loop, and bounds inline ticks to one scan/iteration.
3. `0003-R2-websocket-worker-runspace.patch` — **new**. The R2 accept-loop
   starvation repair plus `src/tests/smoke/r2-websocket-worker.test.ts`.

### R2 repair summary (see defects/R2-WEBSOCKET-ACCEPT-LOOP-BLOCK.md)

The single accept thread used to run the long-lived `/ws` pump inline, so one
WebSocket starved all HTTP for up to 30 minutes. The repair moves **only** the
`/ws` pump onto a bounded runspace pool behind a non-blocking
`SemaphoreSlim`; ordinary HTTP stays inline, so every existing
`$script:` ticket/cache/credential/revocation state keeps single-threaded
semantics. Over-capacity `/ws` gets an immediate 503; audits serialize on a
shared `Monitor` lock; sockets/streams/gate/runspaces are disposed on close and
shutdown; an inline fallback keeps the feature available if a pool cannot be
created. WebSockets are never disabled and `ws` is never faked.

## 2. How to verify from a clean download

```bash
# integrity + applicability (no build), safe anywhere with curl/git/python3
bash reports/mission-control/40072158991-1/verify-bundle.sh
# full replay including pnpm install, smoke tests and the production build
REPLAY=1 bash reports/mission-control/40072158991-1/verify-bundle.sh
# equivalent standalone helper
bash reports/mission-control/40072158991-1/replay-candidate.sh
```

Already executed in this lab (Linux, Node v22):

- Patch series applies cleanly on a fresh `832a82eb` download; output is
  byte-identical to the hand-built candidate.
- Application smoke tests: **108 files / 1388 tests pass** (1378 historical +
  10 new R2 structural tests; the R2 test fails on the pristine base and passes
  on the repaired file).
- Production build `pnpm run build` (tsc + vite single-file) succeeds.
- Lab hosted regressions `node scripts/run-regressions.js`: **235 pass /
  0 fail / 8 skip** (the skips are optional browser lanes).

## 3. Windows behavioral verification (the authoritative R2 gate)

`.github/workflows/real-backend.yml` runs on the interactive client VM
(`[self-hosted, Windows, X64, rdp-lab-client]`) for a same-repo PR carrying the
`real-backend-run` label. It checks out the immutable pinned revision, applies
the three patches, parses both server files with the real PowerShell 5.1
parser, builds the UI, and runs `scripts/candidate/real-backend.js` for the
pristine baseline and the repaired candidate with identical fixtures. The
browser drives the **ordinary shipped frontend with no WebSocket stub**
(`backendKind=actual_application`, `browserWebSocketStubbed=false`, headed).

Frozen thresholds live in `R2_THRESHOLDS` in the harness and are never adjusted
after a failure. The matrix records median/p95/max, timeouts and recovery for:
no-WS control, one held socket, five sockets, the 503 capacity limit, a real
state-changing POST while sockets are held, genuine frames/hello-ack,
normal/abrupt close + reconnect, server-side idle expiry, malformed handshake,
and ten cycles with a process-handle trend. Results publish to
`evidence/real-backend-<runId>/` and the workflow's evaluate step hard-fails if
the patched server still blocks, any `r2.*` control fails, the backend is not
`actual_application`, or the browser is stubbed.

### Measured outcome (real Windows client, run 40078279249)

The hard gate did its job and caught a real remaining defect — this is **not**
an R2 PASS yet:

- The starvation mechanism is gone: the pristine server reproduces R2 exactly
  (one `/ws` holds the accept thread, `/health` blocked 5011 ms, stall 4615 ms),
  while the patched server never blocks HTTP (stall 826 ms, `/health` median
  23–54 ms, zero timeouts, real POST file writes succeed).
- But every `/ws` upgrade is answered **503**, including the first connection on
  a fresh `GHRDP_WS_MAX_CLIENTS=8` gate (`held=0, rejected=9`), so the worker
  never runs and WebSockets are currently non-functional. The browser (real,
  unstubbed, headed) honestly shows "No /ws endpoint".
- Two inline 503 branches exist: admission `SemaphoreSlim.Wait(0)` vs the
  `[powershell]::Create(pool).BeginInvoke()` dispatch catch. The earlier harness
  discarded the response body, so the branch was not attributable.
- The instrumentation then pinpointed the exact fault on run 40081193119:
  `System.Management.Automation.MethodException: Cannot find an overload for
  "Create" and the argument count "1"` from `[powershell]::Create($pool)`. The
  PS 5.1 `[powershell]` accelerator cannot bind the static
  `Create(RunspacePool)` 1-arg overload. The fix uses parameterless
  `[powershell]::Create()` plus the settable `RunspacePool` property (works on
  PS 5.1 and PS 7); a static test pins the pattern and forbids the 1-arg call.
- That removed all 503/MethodException lines, and run 40082655039 exposed a
  second, distinct defect as `ECONNRESET` before any 101:
  `Invoke-ClientRequest`'s outer `try/finally` disposes the stream and closes
  the client on every return. The async `/ws` dispatcher returns immediately, so
  the finally tore the socket down before the worker wrote 101 (the inline
  baseline never hit this because its pump blocked inside the `try`). The fix
  is an `$r2Dispatched` ownership flag set on the `/ws` branch, guarding the
  outer cleanup; the worker `finally` remains the single owner that closes,
  disposes and releases the gate. The worker's previously-empty `catch` now logs
  `[LAB-R2] worker EXCEPTION` so a fault can never again appear as a bare reset.
- 0003 is now 509 lines with ten static assertions (all green on LF and CRLF).
  The next labelled run must show real 101 upgrades, capacity holding at eight
  with a 503 only on the ninth, live frames/echo, idle expiry and reconnect.
  Earlier matrix honesty (7 PASS / 9 FAIL / 6 BLOCKED on the unfixed builds) is
  preserved in `control-coverage.csv` and the `evidence/windows-run-*.md`
  records; the passing re-run's evidence supersedes those rows. Native RDP/Web
  Desktop remain separately BLOCKED.

## 4. Remaining work that an application session / operator must own

- **Native RDP and Web Desktop acceptance remain BLOCKED**, not passed. They
  need a separate lab-owned Windows application server (real test RDP account,
  listener, network identity, launcher handoff, capture/session prerequisites)
  and a fresh remote-interactive LogonType 10 correlated to client/user/server.
  A server self-test or console logon is not client-login proof; an image
  difference is not Web Desktop proof.
- The live origin run `40072158991` is observed read-only. The earlier run's
  first failure was step 28 ("Stage files + write config.json"); the exact
  internal exception was not retrievable from this sandbox. If staging fails
  again, capture the first real error before treating later steps as root
  cause. Do not relax freshness checks or reuse old endpoints/credentials.
- When promoting 0003 upstream, keep the three patches in order and retain the
  `r2-websocket-worker.test.ts` regression. Do not replace the runspace design
  with a global thread-pool rewrite without re-proving every shared-state
  invariant (tickets, revocation, audit, device tokens, caches).

## 5. Rollback

The repair is confined to `payloads/ghrdp-server.ps1` plus one new test file.
Rollback is `git revert` of the 0003 commit (or dropping
`app-patches/0003-*.patch` from `series.txt`); F201/R1 are independent and
remain valid. No schema, config, credential or wire-protocol change is
introduced, and the env tunables default to the original 20/90/1800 values when
unset.
