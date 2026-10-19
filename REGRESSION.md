# Supreme Lamp Lab - Compact Regression Catalogue

This catalogue documents reproduced defect triggers, root causes, regression tests, expected verdicts, time limits, and evidence files for the supreme-lamp lab.

---

### Defect 1: Restricted PowerShell Execution Policy Startup
- **Trigger**: Step execution failed on self-hosted Windows runner because script execution was disabled (`Restricted` policy).
- **Root Cause**: Reliance on default PowerShell shell without process-scoped `-ExecutionPolicy Bypass`.
- **Regression Test**: `scripts/run-regressions.js` -> `PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy`.
- **Expected Verdict**: `PASS` (Job executes inline commands via process-scoped Bypass without altering persistent system policy).
- **Time Limit**: 10 seconds.
- **Evidence Files**: Workflow execution logs, `Get-ExecutionPolicy -List` diagnostic output.

---

### Defect 2: Native Command Failure Masking
- **Trigger**: Non-zero exit code in native CLI commands (npm, git, tailscale) did not fail the PowerShell step.
- **Root Cause**: Missing explicit `$LASTEXITCODE` checks in PowerShell steps.
- **Regression Test**: `scripts/run-regressions.js` -> `Native Command Non-Zero Exit Code Propagation`.
- **Expected Verdict**: `PASS` (Throws error and fails step when `$LASTEXITCODE -ne 0`).
- **Time Limit**: 5 seconds.
- **Evidence Files**: Diagnostic exit code logs.

---

### Defect 3: Silent Headless Fallback in Interactive Profile
- **Trigger**: Headed launch failure silently fell back to headless Chromium, masking broken interactive desktop sessions.
- **Root Cause**: Catch block in `browser-check.js` launching headless browser on error.
- **Regression Test**: `scripts/run-regressions.js` -> `Browser Check Strictly Fails on Headed Launch Failure`.
- **Expected Verdict**: `PASS` (Fails interactive capability check with `HEADED_LAUNCH_FAILED`).
- **Time Limit**: 5 seconds.
- **Evidence Files**: `artifacts/run-<id>-<attempt>/results.json`.

---

### Defect 4: Stale Artifact Overwrite / Lack of Run Isolation
- **Trigger**: Evidence from previous runs contaminated new runs.
- **Root Cause**: Output directory `artifacts/` was shared without run/attempt isolation.
- **Regression Test**: `scripts/run-regressions.js` -> `Per-Run Output Directory Isolation`.
- **Expected Verdict**: `PASS` (Outputs saved under `artifacts/run-${env:GITHUB_RUN_ID}-${env:GITHUB_RUN_ATTEMPT}`).
- **Time Limit**: 2 seconds.
- **Evidence Files**: `artifacts/run-<id>-<attempt>/screenshot.png`, `results.json`, `videos/*.webm`.

---

### Defect 5: Session 0 Windows Service Execution Masking Desktop Failure
- **Trigger**: Runner executed under Windows Service (Session 0) without interactive desktop session, leading to headed browser / RDP failure.
- **Root Cause**: Windows Service mode lacks GUI desktop context.
- **Regression Test**: `scripts/run-regressions.js` -> `Session 0 Service Execution Gate Enforcement`.
- **Expected Verdict**: `PASS` (Explicitly blocks execution in Session 0 and requires interactive user session).
- **Time Limit**: 5 seconds.
- **Evidence Files**: Diagnostic preflight logs under `RUNNER_TEMP`.

---

### Defect 6: Invented Mission Control Contract Defaults & Global Process Termination
- **Trigger**: Mission Control test invented identity and commit defaults when API response fields were missing, and used global `taskkill /IM mstsc.exe`.
- **Root Cause**: Fallback values masking broken API contracts and indiscriminate process termination.
- **Regression Test**: `scripts/run-regressions.js` -> `Mission Control Strict Contract & Target Process Tracking`.
- **Expected Verdict**: `PASS` (Fails on missing contract fields and targets process PIDs specifically).
- **Time Limit**: 5 seconds.
- **Evidence Files**: `artifacts/run-<id>-<attempt>/mission-control-results.json`.
