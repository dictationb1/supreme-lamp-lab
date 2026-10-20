# Supreme Lamp Lab - Configuration & Runbook Guide (Sinhala)

මෙම ලේඛනය `supreme-lamp-lab` හි Windows පරිසරය, OIDC සහ Tailscale සකස් කිරීම පිළිබඳ විස්තර සපයයි.

---

## 1. Tailscale OIDC Federation සැකසුම (Setup Instructions & Trust Configuration)

Tailscale OIDC Workload Identity Federation හි HTTP 403 (token exchange failed) දෝෂය විසඳීමට පහත පරිදි Tailscale Admin Console හි Custom OIDC Provider එක සකස් කළ යුතුය:

- **Tailscale Admin Console Settings**:
  - **Issuer**: `https://token.actions.githubusercontent.com`
  - **Audience**: `https://github.com/dictationb1/supreme-lamp-lab` (හෝ `TS_AUDIENCE` හි සකසා ඇති exact Value එක)
  - **Permitted Tags**: `tag:ci`

- **OIDC Claims matching**:
  - `repository`: `dictationb1/supreme-lamp-lab`
  - `job_workflow_ref`: `dictationb1/supreme-lamp-lab/.github/workflows/capability-check.yml@refs/heads/jules-16259370363028725758-2a035898`
  - `actor`: GitHub user/bot identity
  - `ref`: `refs/heads/jules-16259370363028725758-2a035898` (හෝ `refs/pull/*/merge`)

- **GitHub Repository Secrets**:
  - `TS_OAUTH_CLIENT_ID`: Tailscale OIDC client ID එක GitHub Secrets හි ඇතුළත් කරන්න.
  - `TS_AUDIENCE`: Target OIDC audience string එක.

---

## 2. Windows Runner සූදානම් කිරීම (Windows Self-Hosted Runner)

- **Execution Policy**:
  - Persistent LocalMachine execution policy වෙනස් කිරීමට අවශ්‍ය නැත. Workflow එක process-scoped Bypass shell භාවිත කරයි (`powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ". '{0}'"`).

- **Interactive Desktop Session**:
  - Headed browser පරීක්ෂණ සහ native `mstsc.exe` RDP පරීක්ෂණ සඳහා Session ID > 0 සහිත සක්‍රීය Windows User Desktop Session එකක් අවශ්‍ය වේ.

- **Migration to Interactive Scheduled Task (VM එක මත ක්‍රියාත්මක කළ යුතු පියවර)**:
  - CI ක්‍රියාවලියක ඇතුළත සිට මෙය ස්වයංක්‍රීයව සිදු කළ නොහැක. VM එකට login වී Administrator PowerShell එකක් විවෘත කර පහත විධානය ක්‍රියාත්මක කරන්න:
  ```powershell
  .\scripts\migrate-runner.ps1 -RunnerPath "C:\actions-runner" -TargetUser "ඔබේ_භාවිතා_කරන්නාගේ_නම"
  ```
  - ඉන්පසු Windows එකෙන් ලොග් අවුට් වී (Log out) නැවත ලොග් ඉන් (Log in) වන්න. එවිට At Logon trigger එක මගින් interactive runner එක ආරම්භ වේ.

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
