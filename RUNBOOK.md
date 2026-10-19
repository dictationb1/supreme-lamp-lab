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

## 2. Windows Self-Hosted Runner Migration & Desktop Session Guide

### Runner Status & Session 0 Isolation
Windows Runner එක Background Windows Service එකක් ලෙස ක්‍රියාත්මක වන විට (Session 0), interactive GUI desktop (Headed browser execution / Native RDP) ලබා ගත නොහැක. Headed browser testing සක්‍රීය කිරීමට runner එක **Interactive Desktop Session (Session ID > 0)** තුළ ධාවනය විය යුතුය.

### Console Migration Instructions (එක් වරක් සිදුකළ යුතු VM Console පියවර)
VM Console (RDP / Physical Desktop) වෙත පිවිස පහත පියවර අනුගමනය කරන්න:

1. **Administrator PowerShell Console එකක් විවෘත කරන්න**:
2. **Migration Helper Script එක ධාවනය කරන්න**:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-runner.ps1
   ```
3. **Desktop Logon සහ Foreground Runner පරීක්ෂාව**:
   - `C:\actions-runner\run.cmd` මගින් interactive desktop session එකක් තුළ runner එක සාර්ථකව ආරම්භ වන බව තහවුරු කරගන්න.
   - persistent **At Logon scheduled task** එක මගින් පරිශීලකයා ලොග් වූ පසු runner එක සක්‍රීය වේ.

> **වැදගත්**: "At Logon" scheduled task එක මගින් සිදුකරන්නේ user log in වූ පසු runner එක ආරම්භ කිරීම පමණි. එය ස්වයංක්‍රීයව Windows ලොග් වීම හෝ screen unlock කිරීම සිදු නොකරයි.

### Safety Constraints (ආරක්ෂණ නීති)
- Windows මුරපද scripts, task arguments, registry `AutoAdminLogon` හි ගබඩා නොකරන්න.
- UAC, Windows Defender, screen-lock policy, හෝ Session 0 isolation අක්‍රිය නොකරන්න.
- System system32 / Windows නාමාවලිවල permissions වෙනස් නොකරන්න.

### Rollback Procedure (පෙර තත්වයට පත් කිරීම)
මයිග්‍රේෂන් එක නැවත හරවා යැවීමට (Rollback) පහත command එක ධාවනය කරන්න:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-runner.ps1 -Rollback
```

---

## 3. Local Verification Run (දේශීයව පරීක්ෂා කිරීම)

- **නැවත ධාවනය කිරීම**:
  ```cmd
  npm ci
  node scripts/run-regressions.js
  node scripts/browser-check.js
  node scripts/mission-control-check.js
  ```
- **සාක්ෂි එකතු කිරීම (Evidence Artifacts)**:
  - සියලු සාක්ෂි `artifacts/run-<run_id>-<attempt>/` නාමාවලියෙහි සුරැකේ. (Screenshot `.png`, Recorded Video `.webm`, JSON Telemetry Results).
