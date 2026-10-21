# Supreme Lamp Lab - Compact Regression Catalogue

This catalogue documents reproduced defect triggers, root causes, regression tests, expected verdicts, time limits, and evidence files for the supreme-lamp lab.

---

### Defect 1: Restricted PowerShell Execution Policy Startup
- **Trigger**: Step execution failed on self-hosted Windows runner because script execution was disabled (`Restricted` policy).
- **Root Cause**: Reliance on default PowerShell shell without process-scoped `-ExecutionPolicy Bypass`.
- **Regression Test**: `scripts/run-regressions.js` -> `PowerShell Process-Scoped Bypass Execution Under Restricted Child Policy`.
- **Expected Verdict**: `PASS` (Job executes inline commands via process-scoped Bypass without altering persistent system policy).
- **Time Limit**: 10 seconds.
- **Evidence Files**: Workflow execution logs.

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

### Defect 5: Unpinned Playwright Dependency & Dynamic `npm init`
- **Trigger**: CI workflow dynamically executed `npm init -y` and `npm install playwright` without lockfiles, causing version drift and slow runs.
- **Root Cause**: Missing committed `package.json` and `package-lock.json`.
- **Regression Test**: Local syntax and dependency lock check (`npm ci`).
- **Expected Verdict**: `PASS` (Deterministic installation via `npm ci`).
- **Time Limit**: 30 seconds.
- **Evidence Files**: `package.json`, `package-lock.json`.

---

### Defect 6: Non-Linux Incompatible Tailscale Action & OAuth Parameter Mismatch
- **Trigger**: Tailscale job failed on Windows or attempted OIDC federation with incompatible action version or secret mismatch.
- **Root Cause**: Unpinned action version or missing explicit audience/client ID parameters.
- **Regression Test**: Workflow YAML validation for pinned `tailscale/github-action` release with `id-token: write` and OIDC parameter configuration.
- **Expected Verdict**: `PASS`.
- **Time Limit**: 30 seconds.
- **Evidence Files**: `.github/workflows/capability-check.yml`.

---

### Defect 7: Mission Control Verification & Native Desktop Auto-Login
- **Trigger**: Lack of verification for backend readiness JSON, Web Desktop frame/canvas, and native mstsc RDP client.
- **Root Cause**: False PASS on generic body element, missing desktop screenshot error propagation, destroyed PowerShell statement boundaries in screenshot command.
- **Regression Test**: `scripts/mission-control-check.js`.
- **Expected Verdict**: `PASS` (Verifies readiness JSON, dashboard telemetry, Web Desktop canvas/frame, and captures valid native desktop screenshot).
- **Time Limit**: 15 seconds.
- **Evidence Files**: `artifacts/run-<id>-<attempt>/mc-dashboard.png`, `native-desktop-mstsc.png`, `mission-control-results.json`.

---

### Defect 8: Process Cleanup Safety & Atomic Lock Race Conditions
- **Trigger**: TOCTOU race conditions in lock acquisition and killing unrelated processes on recycled PIDs.
- **Root Cause**: `existsSync` check before `mkdirSync`, missing creation time verification in cleanup.
- **Regression Test**: `scripts/run-regressions.js` -> `Safe Lock Acquisition & Recovery Under Isolated Harness`.
- **Expected Verdict**: `PASS`.
- **Time Limit**: 5 seconds.
- **Evidence Files**: `scripts/registry-utils.js`, `scripts/cleanup-lab.ps1`.

---

### Defect 9: Web Desktop False PASS Rejection
- **Trigger**: Web Desktop capability marked PASS when page contained only generic `body` or `#app`.
- **Root Cause**: Fallback to `#app` or `body` in Web Desktop check.
- **Regression Test**: `scripts/run-regressions.js` -> `Web Desktop Verification Rejects Generic Body-Only HTML Page`.
- **Expected Verdict**: `PASS`.
- **Time Limit**: 2 seconds.
- **Evidence Files**: `scripts/mission-control-check.js`.

---

### Defect 10: Invalid Readiness Schema Rejection
- **Trigger**: Unverified or invalid backend readiness responses passed capability check.
- **Root Cause**: Synthesizing fallback identity/commit values on missing readiness schema fields.
- **Regression Test**: `scripts/run-regressions.js` -> `Mission Control Rejects Invalid Readiness Schema Without Identity or Commit`.
- **Expected Verdict**: `PASS`.
- **Time Limit**: 2 seconds.
- **Evidence Files**: `scripts/mission-control-check.js`.
