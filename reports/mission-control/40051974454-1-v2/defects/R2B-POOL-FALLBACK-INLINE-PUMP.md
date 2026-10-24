# R2b — the R2 fallback path parks the accept thread in the inline pump (SOURCE-IDENTIFIED; repair in 0004)

- **Class:** residual risk in the accepted R2 repair (lab-identified), closed
  by `app-patches/0004-R2b-pool-fallback-bounded-truth.patch`.
- **Provenance:** identified by reading the 0003-patched source on the replay
  tree — **never runtime-proven before the fault-injection lane**; the lane is
  wired (see below) and the measurement is pending the `real-backend-run`
  label run. This report never claims the defect was observed live before that
  run exists.
- **Baseline:** `832a82eb` + 0001–0003 (the R2-accepted series).

## 1. The residual risk in the accepted R2 patch

The R2 repair moved `/ws` handling into a worker runspace pool, and the accept
loop became able to drain other connections while a WebSocket lives. But the
dispatch path kept an emergency fallback for the case where the pool is not
available:

```powershell
if (-not $script:R2WsPoolAvailable) {
    # fallback: serve this one inline (the pre-R2 behavior)
    $r2Inline = Invoke-F99WebSocketUpgrade -Client $Client ...
}
```

`Invoke-F99WebSocketUpgrade` is the long-lived pump (bounded only by the
lifetime/idle caps). Invoking it **inline** hands the one accept thread to a
single connection for up to that bound — the exact R2 starvation defect
(`defects/R2-WEBSOCKET-ACCEPT-LOOP-BLOCK.md` in the prior bundle) recreated on
any host where the pool fails to initialize: constrained memory, a runspace
quota, a transient failure at startup.

The R2 acceptance runs never hit this path (the pool initialized normally),
which is why the matrix was green: the risk was untested, not absent.

## 2. The repair (0004)

- `Initialize-R2WsPool` is the only place the pool is created/opened.
- The dispatch path NEVER calls the pump inline. When the pool is unavailable:
  - at most one re-init attempt per clamped window
    (`GHRDP_WS_POOL_RETRY_SEC`, 5..300 s, default 30);
  - every `/ws` attempt gets an immediate truthful
    `503 websocket worker pool unavailable; retry` (dispatch-bound, no hang);
  - `/health` advertises `ws=false` + `wsReason` while degraded and flips back
    to `ws=true` (no `wsReason`) on successful re-init;
  - ordinary HTTP is never parked — the accept thread stays free.
- The pooled path (the accepted R2 behavior) is unchanged.

## 3. The measurement (fault injection, real Windows VM)

`scripts/candidate/r2-fault-injection.js` derives two server variants by
string-mutation at the exact init sites (sha256 of every variant recorded; the
source file is never modified):

- **Phase A — negative control (pre-0004 server, persistent fault):** the
  old fallback must REPRODUCE the starvation — `/ws` serves 101, then
  `/health` stalls past the observation bound. PASS here means the defect
  reproduced as predicted, on the PRE-REPAIR server. It is never a candidate
  PASS.
- **Phase B — 0004 server, persistent fault:** every `/ws` attempt is a
  truthful 503; `/health` p95 stays inside the responsiveness bound; `ws=false`
  + `wsReason` advertised; no starvation.
- **Phase C — transient fault (`GHRDP_WS_POOL_RETRY_SEC=8`):** the first
  `/ws` gets 503; after the retry window the pool re-initializes and `/ws`
  serves 101 with `/health ws=true` and no `wsReason`.

The verdicts land in `r2-fault-report.json` +
`r2-fault-control-coverage.csv` (`r2b.*` control ids); the workflow gates on
them and a missing report is a failure, never a skip.

## 4. Regression coverage shipped in 0004

`src/tests/smoke/r2-websocket-worker.test.ts` grows to 13 tests: the
inline-fallback expectation is replaced by bounded-truthful-degradation
assertions, and `/health` truthfulness (ws/wsReason) is pinned. Replay: full
suite 108 files / 1391 tests green; smoke 24/24.
