# LAB_HARNESS defects found and repaired in this session

Scope: the lab repository only. Each entry names the measurement, the repair and
the regression that keeps it repaired. Historical defects for run 39952421153 are
in `../39952421153-1/defects/LAB-HARNESS-DEFECTS.md` and are **not** repeated.

---

## H-01 (repaired) — discovery could not read the application's signal format at all

**Measured.** Scheduled sweep on the default branch, lab run 40024055205
(2026-10-23T21:04:30Z), annotation:

```
live-run discover (nothing to attach): exit 4: NO_LIVE_ORIGIN
  — no attachable live origin (40022345749/1:LOG_UNAVAILABLE)
```

`LOG_UNAVAILABLE` was the *fallback* error, not the cause: the reader looked for
the lab's older base64 `MC-SIGNAL v1` token in `check_run.output.summary`, while
the application publisher writes `schema: "mc-signal/v1"` JSON into
`output.text` with an RSA-OAEP-256 + AES-256-GCM hybrid envelope and an identity
AAD. With no signal found, the code fell through to downloading the origin's run
log — and an `in_progress` run's log answers 403/404, so the sweep reported the
log, not the real mismatch.

**Repair.** PR #24's reader (`scripts/lib/live-signal.js` + `signal-binding.js`,
carried into this branch: every file it touches is byte-identical at its base
`c74fa38` and on this branch's base `a3eb4b7`, so the overlay is conflict-free),
plus its four regression suites.

**Proof it works now** (lab run 40026969350, annotation + report):

```
::notice title=signal key::configured AND round-trip proven
::notice title=live-run discover::verified: ORIGIN_DISCOVERED
discovery.evidence.transport = "check-run", selection = "explicit-run-id"
```

and origin identity verified check-by-check (`RUN_FETCHED`, `RUN_REPO_MATCH`,
`RUN_WORKFLOW_MATCH`, `RUN_HEAD_SHA_MATCH`, `RUN_ATTEMPT_MATCH`,
`RUN_IN_PROGRESS`).

**Regression.** `scripts/test/app-signal-regressions.js` (13 cases),
`signal-binding-regressions.js`, `workflow-yaml-regressions.js`.

---

## H-02 (repaired) — evidence existed only as an artifact, and artifacts are not retrievable

**Measured on 2026-10-23:**

```
GET /repos/.../actions/artifacts/<id>/zip   -> 302 productionresultssa9.blob.core.windows.net        -> EOF
GET /repos/.../actions/runs/<id>/logs        -> 302 results-receiver.actions.githubusercontent.com   -> EOF
```

From an automation environment whose egress allowlist is `github.com`,
`api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org`, both
redirects fail. A run whose only evidence is an artifact is therefore
**unreadable**, and the 14-day retention is not the limiting factor.

**Repair.** `scripts/publish-evidence.js` — the client VM publishes the
already-sanitized report into the branch it ran from through the contents API,
with a hard refusal on credential-shaped content and idempotent writes.
`live-run.yml` and `app-candidate.yml` both call it.

**Proof.** This bundle's `evidence/live-run-report.json` and
`evidence/cleanup-postflight.json` were published by lab run 40026969350 itself:
```
::notice title=evidence publish::2 file(s) published to arena/455b72d3-supreme-lamp-lab:reports/mission-control/40022345749-1/evidence
```

**Regression.** `scripts/test/publish-evidence-regressions.js` (6 cases: private
key, `?key=` URL, bearer/GitHub token, sealed envelope, unmasked password,
non-evidence file types).

---

## H-03 (repaired) — "TCP open, no HTTP" could not name the wedged service

The first pass reported only the claimed endpoint. The measurement
"`tcp reachable=True, /api/ping code=000`" is true and still does not tell an
operator *which* service is wedged, nor whether the other dashboard port is
alive. The preflight now classifies seven routes on both ports with a 15 s budget
and writes `listeners.json`:

```
port 7331: code=000 (exit=28, 15060ms, ACCEPTED_NO_HTTP)
port 7332: code=404 (exit=0,     721ms, ANSWERING)
```

---

## H-04 (repaired) — two interactive jobs could be dispatched onto one desktop

`capability-check.yml` triggered its 25-minute `client` job on
`pull_request: [opened, synchronize, ...]`. Every push to a PR therefore queued
it on `rdp-lab-client`, the single interactive desktop, and the live-run
verification (label `live-verify`) waited behind it. Measured: lab run
40026969358's client job took the desktop at 21:36:20Z while live-run and
app-candidate sat queued.

**Repair.** the `client` job now requires the explicit `capability-run` label.
Other capability jobs (hosted) are unchanged.

**Not repaired (noted).** A job that already started cannot be cancelled by the
automation token (`POST /actions/runs/<id>/cancel` → `403 Resource not
accessible by integration`), so the contention is only preventable, not
recoverable, from here.

---

## H-05 (repaired) — the authenticated viewer held the job open *before* the evidence upload

The `Keep the authorized viewer open` step (default 15 min) ran before
`Upload ... evidence`, so a run's report arrived 15 minutes after the work ended,
and a run that never authenticated still paid the full hold.

**Repair.** evidence is now published into the repository by a step placed
*before* the viewer hold, and the publish step runs `if: always()`. A future
session reads the report immediately and the hold no longer gates access to it.

---

## H-06 (open, measured) — `workflow_dispatch` is unavailable to the automation token

Every `gh workflow run` attempt from this environment returns
`HTTP 403: Resource not accessible by integration`. All lab runs in this session
were therefore produced by `pull_request` and `push` events (labels
`live-verify`, `candidate-run`), never by dispatch. This is a permissions fact of
the session, not a repository defect; it is recorded because it determines how
the next session must start a run.
