# RECOVERY CHECKPOINT

## Branch & Commit State
- **Repository**: `dictationb1/supreme-lamp-lab`
- **Application Repository**: `dictationb1/supreme-lamp`
- **Active Repair Branch**: `jules-16259370363028725758-2a035898-11709498459080838121`
- **Pull Request**: #8

## OIDC Configuration Specifications
Tailscale Workload Identity Federation requires exact matching claims between GitHub Actions JWT and Tailscale Admin Console:
1. **Issuer**: `https://token.actions.githubusercontent.com`
2. **Audience**: Exact value passed in `audience:` / `TS_AUDIENCE` secret (e.g., `https://login.tailscale.com/v2/oauth` or configured custom audience).
3. **Repository**: `dictationb1/supreme-lamp-lab`
4. **Subject (`sub`)**: `repo:dictationb1/supreme-lamp-lab:ref:refs/heads/<branch>` or `repo:dictationb1/supreme-lamp-lab:pull_request`
5. **Tags**: `tag:ci`

## Immediate Administrative Action Required (Sinhala)
Tailscale HTTP 403 දෝෂය (Token exchange rejection / unauthorized trust) විසඳීම සඳහා Tailscale Admin Console (https://login.tailscale.com/admin/settings/oauth) හි පහත සැකසුම් තහවුරු කර යාවත්කාලීන කරන්න:

1. **OIDC Provider & Client Configuration**:
   - **Issuer**: `https://token.actions.githubusercontent.com`
   - **Client ID**: GitHub Secrets හි `TS_OAUTH_CLIENT_ID` ලෙස ගබඩා කර ඇති අගය.
   - **Audience**: GitHub Secrets හි `TS_AUDIENCE` ලෙස ගබඩා කර ඇති exact audience string එක (උදාහරණයක් ලෙස: `https://login.tailscale.com/v2/oauth` හෝ Admin Console හි නිර්මාණය කරන ලද custom audience අගය; repository URL එක audience එක ලෙස අනුමාන නොකරන්න).
   - **Permitted Tags**: `tag:ci`

2. **Repository Trust & Claim Matching Rules**:
   - **Repository Claim**: `dictationb1/supreme-lamp-lab`
   - **Subject String (`sub`) Pattern**: `repo:dictationb1/supreme-lamp-lab:*` (හෝ `repo:dictationb1/supreme-lamp-lab:ref:refs/heads/*` සහ `repo:dictationb1/supreme-lamp-lab:pull_request` සඳහා අවසර දෙන්න).
   - **Event / Workflow Restrictions**: Pull Request සහ Workflow Dispatch ඉල්ලීම් සඳහා ID Token නිකුත් කිරීමට `id-token: write` අවසර ලබා දී ඇත.

3. **පරීක්ෂා කිරීමේ අනුක්‍රමය**:
   - Admin Console හි Trust Rules යාවත්කාලීන කිරීමෙන් පසු `.github/workflows/capability-check.yml` workflow එක re-run කිරීම මගින් OIDC connection සාර්ථකව සිදු වන්නේදැයි තහවුරු කරගත හැක.
