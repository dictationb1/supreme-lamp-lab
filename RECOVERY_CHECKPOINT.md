# RECOVERY CHECKPOINT - RDP Mission Control Integration Repair

## Branch & Commit State
- **Repository**: `dictationb1/supreme-lamp-lab`
- **Application Repository**: `dictationb1/supreme-lamp`
- **Active Repair Branch**: `jules-16823803619084176279-227f4aae` (Primary consolidated repair PR #11)
- **Lab Commit SHA**: Current HEAD on repair branch
- **Application Commit SHA**: Verifiable 40-character commit SHA (e.g. from `dictationb1/supreme-lamp` HEAD)

## Integration & Capability Contracts
1. **Browser Capability**: Synthetic local Playwright browser verification (`scripts/browser-check.js`).
2. **Backend Readiness**: Real `ghrdp-server.ps1` service readiness on port 7331 (`/api/readiness`) returning structured JSON (`ok`, `status`, `phase`, `liveness`, `apiReadiness`, `dependencyHealth`).
3. **Dashboard & Web Desktop**: Playwright mission control profile validating explicit remote desktop frame/canvas (`#web-desktop-frame`, `canvas`, `[data-testid="web-desktop"]`).
4. **Native RDP Auto-Login**: Windows native `mstsc.exe` execution and valid desktop screenshot capture (`scripts/mission-control-check.js`).
5. **Process Lifecycle & Locking**: Exclusive atomic directory locks (`fs.mkdirSync`) and process-creation-time verified registry tracking (`scripts/registry-utils.js`, `scripts/cleanup-lab.ps1`).

## OIDC Configuration Specifications
Tailscale Workload Identity Federation requires exact matching claims between GitHub Actions JWT and Tailscale Admin Console:
1. **Issuer**: `https://token.actions.githubusercontent.com`
2. **Audience**: Exact value passed in `audience:` / `TS_AUDIENCE` secret (e.g., `https://login.tailscale.com/v2/oauth`).
3. **Repository**: `dictationb1/supreme-lamp-lab`
4. **Subject (`sub`)**: `repo:dictationb1/supreme-lamp-lab:ref:refs/heads/<branch>` or `repo:dictationb1/supreme-lamp-lab:pull_request`
5. **Tags**: `tag:ci`

## Immediate Administrative Action Required (Sinhala)
Tailscale HTTP 403 දෝෂය (Token Exchange Failure) නිරාකරණය සඳහා Tailscale Admin Console (https://login.tailscale.com/admin/settings/oauth) හි පහත සැකසුම් තහවුරු කරන්න:
1. **OIDC Provider Configuration**:
   - Provider / Issuer: `https://token.actions.githubusercontent.com`
   - Client ID: `TS_OAUTH_CLIENT_ID` හි ඇති අගය
   - Audience: `TS_AUDIENCE` හි ඇති අගය (උදා: `https://login.tailscale.com/v2/oauth`)
   - Permitted Tags: `tag:ci`
2. **Repository Trust Rules**:
   - Subject String match: `repo:dictationb1/supreme-lamp-lab:*`
