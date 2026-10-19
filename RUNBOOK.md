# Supreme Lamp Lab - Configuration & Runbook Guide (Sinhala)

මෙම ලේඛනය `supreme-lamp-lab` හි Windows පරිසරය, OIDC සහ Tailscale සකස් කිරීම පිළිබඳ විස්තර සපයයි.

---

## 1. Tailscale OIDC Federation සැකසුම (Setup Instructions)

Tailscale OIDC Workload Identity Federation භාවිත කිරීමට පහත සැකසුම් අවශ්‍ය වේ:

- **Tailscale Workload Identity Federation**: Tailscale admin console හි Custom OIDC provider එකක් සාදන්න.
  - **Issuer**: `https://token.actions.githubusercontent.com`
  - **Audience**: `https://github.com/dictationb1/supreme-lamp-lab`
  - **Permitted Tags**: `tag:ci`

- **GitHub Repository Secrets**:
  - `TS_OAUTH_CLIENT_ID`: Tailscale OIDC client ID එක GitHub Secrets හි ඇතුළත් කරන්න.

---

## 2. Windows Runner සූදානම් කිරීම (Windows Self-Hosted Runner)

- **Execution Policy**:
  - persistent LocalMachine execution policy වෙනස් කිරීමට අවශ්‍ය නැත. Workflow එක process-scoped Bypass shell භාවිත කරයි (`powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ". '{0}'"`).

- **Interactive Desktop Session**:
  - Headed browser පරීක්ෂණ සහ native `mstsc.exe` RDP පරීක්ෂණ සඳහා Session ID > 0 සහිත සක්‍රීය Windows User Desktop Session එකක් අවශ්‍ය වේ.

---

## 3. Local Verification Run (දේශීයව පරීක්ෂා කිරීම)

- **නැවත ධාවනය කිරීම**:
  ```cmd
  npm ci
  node scripts/run-regressions.js
  node scripts/browser-check.js
  ```
- **සාක්ෂි එකතු කිරීම (Evidence Artifacts)**:
  - සියලු සාක්ෂි `artifacts/run-<run_id>-<attempt>/` නාමාවලියෙහි සුරැකේ. (Screenshot `.png`, Recorded Video `.webm`, JSON Telemetry Results).
