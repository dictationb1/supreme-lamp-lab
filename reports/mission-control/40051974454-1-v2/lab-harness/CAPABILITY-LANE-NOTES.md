# Lab harness deltas in this bundle (vs 40072158991-1)

Everything here is lab-side only; the application changes live in
`app-patches/`. These notes exist so a reviewer can see exactly what the lab
changed to verify the complete candidate — and what each change fixed.

## 1. Patched-candidate staging (capability-check.yml, server job)

The capability lane no longer stages the unmodified app: it stages the
COMPLETE candidate. Order matters — patch BEFORE build, build BEFORE stage:

1. `actions/checkout` the pinned `APP_SHA`.
2. **CRLF checkout guard** (fix for run 40102291995): the checkout may
   materialize CRLF working files while the bundle patches are
   LF-normalized, which made `git apply` fail on every touched file. The
   guard derives the target set from the patches' `+++ b/` headers and
   rewrites every EXISTING target byte-exactly to LF (Latin-1 round-trip —
   no UTF-8 corruption risk). Patch-created files are counted, not touched.
3. Apply 0001–0004 in `series.txt` order; semantic markers verified
   (0004's `GHRDP_WS_POOL_RETRY_SEC`, the r2 regression test), HEAD pinned.
4. Patch-carried smoke gate (3 test files), then
   `VITE_BUILD_SHA=$CANDIDATE_BUILD vite build`.
5. `Stage-App.ps1 -LabLocalUi` + `-LabUiIdentity` (fix for run 40106229135:
   `uiBundleSource='local-patched-build'`; the served build stamp is the
   candidate identity `cand-<pr-head-sha>`, and `backend-supervisor.js
   --expect-build` forwards it to the server-local dashboard check — the
   app-sha fallback for upstream-UI lanes is preserved).
6. `Stage-FxFixtures.ps1`: 4 disposable fixtures through the production
   RDP-Storage root + `fx-index.json` v2 (ids = SHA-1(root+path)), readback
   verified, per-file sha256 in the stage report.

## 2. Cert-bind observability + the registry fallback

- `Bind-RdpCertificate.ps1` was rewritten first for OBSERVABILITY (per-stage
  `Save-Diag`, per-attempt raw output, redacted). That made run 40103527914
  the first run where the 16-times-invisible failure had a cause:
  `Method "SetSSLCertificateSHA1Hash" not found` — the lab VM's WMI does not
  expose the method, `Invoke-CimMethod` THROWS, and the old code only handled
  a non-throw ReturnValue, so the registry fallback was dead code.
- Fix (run 40106229135 → PASS): the WMI call is wrapped in try/catch and the
  registry write runs in BOTH paths — the same pattern as the application's
  `main.yml` reference. The READBACK is the truth gate (schema
  `slab-capability-certificate/2` records `bindPath` truthfully).

## 3. R2b fault-injection lane (real-backend.yml, `real-backend-run` label)

`scripts/candidate/r2-fault-injection.js` + workflow wiring:

- a second isolated tree is staged from the pinned zip with the full
  0001–0004 series (`--server-new`); the existing patched lane stays 0001–0003
  (`--server-old`) so its history stays comparable with the accepted R2
  evidence;
- three phases (negative control / persistent-fault repair / transient
  recovery) on a dedicated port, verdicts in `r2-fault-report.json`;
- the fault report is published with the lane evidence (`r2b-` prefix) and
  the evaluate step gates: missing report = failure; any FAIL = failure;
  BLOCKED verdicts warn.

## 4. Functional sweep (capability-check.yml, client job)

`scripts/candidate/functional-sweep.js` runs after the remote capability
check succeeds, against the live staged candidate:

- fx: list contract (ids recomputed), three-way download verify (pinned
  bytes / index checksum / served bytes), Range 206 + 416, preview errors,
  op guardrails (403/400s incl. the refused `hard` flag), op lifecycle with
  exact repeat-skip reasons + move-mints-new-id, upload-queue contract
  (external delivery NOT claimed);
- search: create/status-to-terminal/cancel + validation negatives with exact
  codes;
- core: native-status (Sessions/Keys source), config, rdp-token issue
  (consumption NOT claimed), purge command, health/diag.

Exit discipline: the report is written first, then any FAIL or fatal exits 1.

## 5. Lab regression suite

263 tests = 255 pass / 0 fail / 8 skip (browser-e2e optional / pwsh-dependent
lanes), including new pins for: the CRLF guard, the build-identity
forwarding, the cert registry-fallback catch path, the fault-injection
harness (variant derivation, thresholds, workflow gating, patch-site
preservation in 0003/0004), and the functional sweep (fixture pins matched
against `Stage-FxFixtures.ps1`, no-claim discipline, workflow wiring).
