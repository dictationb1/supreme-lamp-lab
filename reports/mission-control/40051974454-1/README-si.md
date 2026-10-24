# RDP Mission Control — run 40051974454 / attempt 1

**මෙය තවම අවසන් acceptance report එක නොවේ.** මෙහි දැක්වෙන්නේ නව run එකට සහ isolated candidate එකට දැන් ලබාගත් සාක්ෂි පමණි. Hosted unit/build සාර්ථකභාවය real client-VM feature verification ලෙස සලකන්නේ නැහැ.

## 1. Branch consolidation

| අංගය | Exact revision / තත්ත්වය |
|---|---|
| Lab base `main` | `a3eb4b79cdec5049781d7b2b2df7c3b880730835` |
| PR #26 reader/harness | `f41804b9446134a606d9f205a470c45bae2ee91e`; current session branch එකට fast-forward කර ඇත |
| F201 repair source | `481de98ab036091e01dab26e1b0b31a60035743d`; useful replay/coverage files සහ sanitized F201 patch එක ඒකාබද්ධ කර ඇත |
| Allowed current branch | `arena/daf94107-supreme-lamp-lab` |
| Application base | `4a91c5c2eadc12e5b071bc46bae7683087f56fbd` |
| Application ZIP SHA-256 | `dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378` |
| F201-only local candidate | commit `9bfe9946a2ca779085babaedc040e68dff95c233`, tree `06dce4388261f272ef2e45644bfb13f9b619a34b` |

PR #26 හි පැරණි F201 fixture එකේ තිබූ stale run IP එක භාවිත නොකර, recorded repair patch එකම තෝරා ඇත. එහි SHA-256 `6d84cd954cf4b6a476c117dc92fe05e2a438ca4d7ba664a17b02813bc640f57f` වේ. එය නව application base එකට `git apply --check` වැරදීමකින් තොරව apply වේ.

PR-triggered discover / claim / Windows verify / report checkout සහ `lab_sha` දැන් exact PR head SHA එකට pin කර ඇත. එමගින් `pull_request` merge commit එකක candidate + පැරණි `main` code mixture එකක් ධාවනය වීම වළක්වයි.

## 2. Actual live origin — API evidence

- Run: https://github.com/dictationb1/supreme-lamp/actions/runs/40051974454
- Job: https://github.com/dictationb1/supreme-lamp/actions/runs/40051974454/job/120746757792
- Workflow: `.github/workflows/main.yml`; event `workflow_dispatch`; attempt `1`.
- Recheck අවස්ථාවේ run එක `in_progress` වුවත් `rdp` job එක cleanup වෙත ගොස් ඇත.
- **පළමු observed failure:** step 28, `Stage files + write config.json (UTF8 no BOM, Rentry secrets + provided edit code, token, ACLs)` → `failure`.
- Dashboard startup, readiness සහ `Publish live Mission Control signal (MC-SIGNAL)` steps **skipped** වී ඇත.
- Exact repository + run + attempt + SHA සඳහා `mission-control-live-signal` check run එකක් නැත. මෙය **publication නොමැතිභාවය** වේ; setup අතරතුර unpublished signal එකක් broken publisher ලෙස වර්ගීකරණය කර නැත.
- පසුව දක්නට ලැබෙන `F92 smoke` failure එක පළමු cause එක ලෙස සලකන්නේ නැත.
- Step logs සහ artifact ZIP downloads authenticated redirect මගින් sandbox-allowed නොවන hosts වෙත යන නිසා ලබාගත නොහැකි විය. ඒ නිසා step 28 තුළින් සිදුවූ exact exception එක තවම unknown; එය fabricate කර නැත.

සාක්ෂි: `evidence/origin-run.json`, `evidence/origin-rdp-job.json`, `evidence/origin-signal-publication.json`.

## 3. Isolated F201 before/after

| Environment | Result | Evidence |
|---|---|---|
| A — actual live origin | **FAIL (staging)**; UI/API service එකක් publish වී නැත | Origin API JSON |
| B — unmodified isolated baseline | F201 regression **8/8 FAIL** (expected reproduction) | `evidence/baseline-f201.log` |
| C — F201 patched isolated candidate | F201 **8/8 PASS** | `evidence/candidate-f201.log` |
| C — full hosted smoke | **1,375 / 1,375 PASS, 106 files** | `evidence/candidate-full-smoke.log` |
| C — production frontend build | PASS; `ui/dist/index.html`, 1,273,547 bytes | `evidence/candidate-build.log`, `evidence/candidate-ui-sha256.txt` |
| Lab harness hosted regressions | **221 PASS / 0 FAIL / 8 environment SKIP**, total 229 | lab test execution on Linux Node 22 |

F201 repair එක missing/refused backend probe එකක් measured credentials/DNS/listener failure එකක් ලෙස පෙන්වීම නවත්වයි. එය functional RDP, Web Desktop, හෝ real backend verification එකක් **නොවේ**.

## 4. Backend stall hypothesis

Current `payloads/ghrdp-server.ps1` source එකේ TCP bind සහ `LISTENING` marker එකට පසුව, HTTP accept loop එකට පෙර synchronous `Get-WinEvent` scans තුනක් ඇත. Source comments ද requests backlog එකේ රැඳී සිටිය හැකි බව සඳහන් කරයි. මෙය plausible hypothesis එකක් පමණි; නව run එකේ listening PID, TCP-connect-to-first-byte timing, හෝ event-query duration measurements නොමැති නිසා එය confirmed root cause ලෙස සටහන් කර නැත.

## 5. Real client VM සහ ඉතිරි වැඩ

`candidate-run` label path එකට කෙටි, exclusive-desktop preflight එකක් එකතු කර ඇත. එය OS/account/session, runner responsiveness, resources, browsers, native launcher presence, tailnet state, exact origin metadata සහ sanitized headed-browser click එකක් වාර්තා කරයි. එහි verdict එක live application verdict එකෙන් වෙනම තැබීරීය.

Real VM job, full served-DOM control inventory, production backend candidate, native RDP/Web Desktop proof, complete clean-clone replay සහ final coverage totals මෙම checkpoint එකේදී **NOT_RUN / pending** වේ. Mock/stub results ඒ වෙනුවට substitute නොකෙරේ.
