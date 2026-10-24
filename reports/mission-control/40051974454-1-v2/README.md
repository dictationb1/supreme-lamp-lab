# Repair Bundle 40051974454-1-v2 — the COMPLETE candidate series (0001–0004)

Successor to `reports/mission-control/40072158991-1` (R2 accepted, 3 consecutive
green Windows real-backend runs). This bundle carries the full candidate:
patches 0001–0003 are **byte-identical** to the accepted bundle; **0004 is new**
and closes the residual risk the R2 acceptance left open.

- **Schema:** `slab-mission-control-repair-bundle/3` (`manifest.json`).
- **Application base:** `832a82eb7c29613b0b101585c56b5011ea008a06`
  (archive sha256 `c0de6455…`, pinned; current app `main` differs only in
  `docs/status.json`, verified — the series applies unchanged to both).
- **Origin run 40051974454 is historical/cancelled.** Its credentials,
  endpoints and tickets are never reused. Live-origin acceptance stays
  BLOCKED/NOT_RUN in this lab-only session.

## The series

| # | Patch | What it does | Status |
|---|-------|--------------|--------|
| 1 | `0001-F201-probe-honesty.patch` | frontend probe honesty (refusals name the refused read) | accepted with R2 runs |
| 2 | `0002-R1-server-startup-readiness.patch` | server startup readiness file + contract | accepted with R2 runs |
| 3 | `0003-R2-websocket-worker-runspace.patch` | bounded WebSocket worker runspace (the R2 repair) | **accepted**: runs 40091165292 / 40092088400 / 40092300001, each 33 PASS / 0 FAIL / 5 BLOCKED |
| 4 | `0004-R2b-pool-fallback-bounded-truth.patch` | bounded truthful pool-unavailable degradation | **wired for runtime proof; NOT yet runtime proven** (see below) |

## What 0004 fixes (see `defects/R2B-POOL-FALLBACK-INLINE-PUMP.md`)

The accepted R2 patch had a residual risk: if the runspace pool failed to
initialize, the dispatch path fell back to invoking the long-lived WebSocket
pump **inline on the accept thread** — recreating the R2 starvation defect on
a constrained host. 0004 removes the inline pump from the dispatch path
entirely:

- one bounded pool re-init attempt per clamped window
  (`GHRDP_WS_POOL_RETRY_SEC`, 5..300 s, default 30);
- while degraded, every `/ws` attempt gets an immediate truthful
  `503 websocket worker pool unavailable; retry`;
- `/health` advertises `ws=false` + `wsReason` while unavailable and flips
  back on successful re-init;
- ordinary HTTP is never parked; the pooled path is unchanged.

## Replay verification (this session, `manifest.json` for the full record)

- archive sha256 match; series 0001→0004 applies cleanly on `832a82eb`;
- smoke gate 24/24 after 0004 (13 r2 tests, +1 for the bounded degradation);
- full app suite 108 files / 1391 tests;
- production build OK (single-file `ui/dist/index.html`).

## Runtime proof status (measured, never inferred)

- **Fault-injection lane (wired, pending the `real-backend-run` label run):**
  `scripts/candidate/r2-fault-injection.js` runs three phases on the real
  Windows VM — (A) negative control: the pre-0004 server + a persistent
  pool-init fault must REPRODUCE the `/health` starvation; (B) the 0004
  server + the same fault must serve truthful 503s with `/health` p95 inside
  the bound and no starvation; (C) a transient fault with a 8 s retry window
  must recover to a served 101 and `/health ws=true`. The workflow gates on
  the verdicts and publishes `r2-fault-report.json`; a missing report is a
  failure, never a skip.
- **Patched-candidate capability lane (staging proven this session):**
  `capability-check.yml` now checks out the pinned app, applies 0001–0004
  (LF-normalized, with the CRLF checkout guard — see
  `lab-harness/CAPABILITY-LANE-NOTES.md`), runs the patch-carried smoke gate,
  builds the UI with `VITE_BUILD_SHA=cand-<pr-head-sha>`, stages it as
  `local-patched-build` and verifies the candidate identity end to end.
- **Cert bind (runtime-proven):** run 40106229135 bound the Tailscale/Let's
  Encrypt certificate via the registry fallback (the lab VM's WMI lacks
  `SetSSLCertificateSHA1Hash`; the readback is the truth gate —
  `evidence/capability-40106229135/server/capability-certificate.json`,
  schema `/2`, `bindPath` recorded truthfully).

## Directory layout

- `app-patches/` + `series.txt` — the ordered series.
- `manifest.json` — the machine-readable bundle record.
- `defects/` — defect reports (R2b residual risk).
- `lab-harness/` — lab-side harness deltas vs the prior bundle.
- `evidence/` — append-only run evidence published by CI. It grows with every
  run and is deliberately OUTSIDE the pinned `SHA256SUMS` set, which covers
  the durable bundle files only.

## Honesty ledger

- R2 (accept-loop starvation) — runtime-proven accepted (prior bundle, 3 runs).
- R2b (inline-pump fallback) — source-identified; fault-injection lane wired;
  **not yet runtime proven**. Never claimed otherwise.
- Native RDP / Web Desktop / live origin / external gofile delivery — remain
  BLOCKED with prerequisites, as in the prior bundle.
