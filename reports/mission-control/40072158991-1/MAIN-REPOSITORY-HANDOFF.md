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
- Application smoke tests: **108 files / 1386 tests pass** (1378 historical +
  8 new R2 structural tests; the R2 test fails on the pristine base and passes
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

Current status of that run is recorded in `manifest.json → windowsVerification`
and the Sinhala README; do not assume PASS without the published evidence.

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
