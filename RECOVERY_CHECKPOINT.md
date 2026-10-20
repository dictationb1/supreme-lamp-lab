# RECOVERY_CHECKPOINT.md

## Current Repository & PR State
- **Repository**: dictationb1/supreme-lamp-lab
- **Branch**: `jules-16259370363028725758-2a035898`
- **Head Commit**: `b8c189b7b73703d269be45ea9c4445652990e238` (plus local commits)
- **Base Branch**: `main` (`bdb70404ee9c0fbcdca5d68ce93e1cb1c71bcdf4`)
- **Status**: BLOCKED_EXTERNAL (Tailscale OIDC token exchange failing with 403 on temporary server job)

## Diagnosed Root Causes & Implemented Scoped Repairs
1. **Misleading Mission Control Mock Fallback**:
   - `scripts/mission-control-check.js` automatically started a mock server and assigned synthetic PASS when backend was unreachable.
   - Fixed to disable mock fallback by default. Require `MISSION_CONTROL_URL` and `RDP_TARGET`.
   - Separate status reporting for `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, and `SIMULATED`.

2. **Process Cleanup & Registry Metadata Safety**:
   - `scripts/registry-utils.js` and `scripts/cleanup-lab.ps1` updated with atomic writes, creation-time checking, and process tree protection.

3. **Tailscale OIDC HTTP 403 Rejection**:
   - Temporary Windows server job fails with "failed to exchange JWT for access token: token exchange failed with status 403".
   - Non-empty client ID and audience check passed.
   - Action revision `tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd` is pinned.
   - The issue requires Tailscale Admin Console Custom OIDC Trust alignment (Issuer, Audience, Permitted Tags, Custom Claims).

## Local Regression Results
- Executed `node scripts/run-regressions.js`:
  - Total tests: 9
  - Passed: 6
  - Skipped (win32 specific on Linux environment): 3
  - Failed: 0

## Reproduction Commands
```bash
npm ci
node scripts/run-regressions.js
ALLOW_MOCK_MISSION_CONTROL=true node scripts/mission-control-check.js
```
