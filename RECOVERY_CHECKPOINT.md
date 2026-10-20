# RECOVERY CHECKPOINT

## Branch & Commit State
- **Repository**: `dictationb1/supreme-lamp-lab`
- **Application Repository**: `dictationb1/supreme-lamp`
- **Active Repair Branch**: `jules-3479390123389068831-e11be303`
- **Base Main SHA**: `8067e4e9b3316cbfa21115a5de112351eb67d417`

## OIDC Configuration Specifications
Tailscale Workload Identity Federation requires exact matching claims between GitHub Actions JWT and Tailscale Admin Console:
1. **Issuer**: `https://token.actions.githubusercontent.com`
2. **Audience**: Exact value passed in `audience:` / `TS_AUDIENCE` secret (e.g., `https://login.tailscale.com/v2/oauth` or configured custom audience).
3. **Repository**: `dictationb1/supreme-lamp-lab`
4. **Subject (`sub`)**: `repo:dictationb1/supreme-lamp-lab:ref:refs/heads/<branch>` or `repo:dictationb1/supreme-lamp-lab:pull_request`
5. **Tags**: `tag:ci`

## Immediate Administrative Action Required (Sinhala)
Tailscale HTTP 403 දෝෂය විසඳීම සඳහා Tailscale Admin Console (https://login.tailscale.com/admin/settings/oauth) හි පහත සැකසුම් තහවුරු කරන්න:
1. **OIDC Provider Configuration**:
   - Provider / Issuer: `https://token.actions.githubusercontent.com`
   - Client ID: `TS_OAUTH_CLIENT_ID` හි ඇති Value එක
   - Audience: `TS_AUDIENCE` හි ඇති Value එක (Repository URL එකක් ලෙස අනුමාන නොකරන්න)
   - Permitted Tags: `tag:ci`
2. **Repository Trust Rules**:
   - Subject String match: `repo:dictationb1/supreme-lamp-lab:*` (හෝ Pull Request/Push සාමාන්‍ය ref වලට අවසර දෙන්න).
