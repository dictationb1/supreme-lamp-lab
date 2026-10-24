# RDP Mission Control — run 40051974454 / attempt 1 (සිංහල සාරාංශය)

**මෙය final acceptance report එකක් නොවේ.** මෙහි ඇත්තේ නව origin run එක,
branch ඒකාබද්ධ කිරීම, isolated patched candidate එක සහ ඒවායේ සත්‍ය සාක්ෂි ය.
Hosted unit/build සාර්ථකත්වය real client-VM feature verification ලෙස නොසලකයි.
Native RDP, Web Desktop සහ සජීව origin අන්තයට-අන්තයට තහවුරු කිරීම තවම BLOCKED /
PENDING ය.

## 1. Branch ඒකාබද්ධ කිරීම (පළමුව කළ කාර්යය)

| අංගය | නිශ්චිත revision / තත්ත්වය |
|---|---|
| Lab base `main` | `a3eb4b79cdec5049781d7b2b2df7c3b880730835` |
| PR #26 reader/harness | `f41804b94…` — `mc-signal/v1` format signal reader (`parseAppSignal`, `openAppCredential`, `resolveAnySignal`) |
| F201 repair branch | `481de98ab…` — sanitized F201 patch සහ replay (legacy reader පමණි) |
| PR #27 head (superset) | `6e5fd966…` — PR #26 + F201 + capability + VM-preflight සාක්ෂි සියල්ල අඩංගුය |
| අවසර ඇති වර්තමාන branch | `arena/69b9956b-supreme-lamp-lab` — `6e5fd96` වෙත fast-forward කර, පසුව R1 + real-backend harness + regressions එකතු කළේය. කිසිදු නව repair එකක් revert කළේ නැත. |
| Application base | `4a91c5c2eadc12e5b071bc46bae7683087f56fbd` |
| Application ZIP SHA-256 | `dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378` |
| Reviewed candidate tree | `62679b8edfde8ba2180f8bb3ca86c03e00d02b31` (F201 + R1 යෙදූ පසු) |

PR-triggered discover / claim / Windows verify / report checkout සහ `lab_sha` දැන්
exact PR head SHA එකට pin කර ඇත. එමගින් `pull_request` merge commit එකකින්
candidate + පැරණි `main` code මිශ්‍රණයක් ධාවනය වීම වළක්වයි (static regression මගින් පරීක්ෂා කරයි).

## 2. සත්‍ය live origin — API සාක්ෂි

- Run: https://github.com/dictationb1/supreme-lamp/actions/runs/40051974454
- Job: https://github.com/dictationb1/supreme-lamp/actions/runs/40051974454/job/120746757792
- Workflow `.github/workflows/main.yml`; event `workflow_dispatch`; attempt `1`; SHA `4a91c5c2…`.
- **පළමු නිරීක්ෂිත fail වීම:** step 28, `Stage files + write config.json` → `failure`.
  Dashboard startup, readiness සහ `Publish live Mission Control signal (MC-SIGNAL)` steps **skipped** විය.
- 2026-10-24T06:46:23Z නැවත පරීක්ෂාවේදීත් run එක සහ `rdp` job එක `in_progress` — step 69
  `Cleanup (wipe profiles/storage, reset funnel/serve)` තුළය. Step 28 පළමු failure එක ලෙසම පවතී.
  Step 60 `Publish live Mission Control signal (MC-SIGNAL)` **skipped**; step 62 `Close live Mission Control signal`
  success වූවද එය publication එකක් **නොවේ**. Step 67 F92 smoke සහ step 68 upload-artifact පසුව fail වී ඇත.
- නිශ්චිත repository+run+attempt+SHA සඳහා MC-SIGNAL check run ගණන **0** ය. මෙය **publication නොමැතිකම** මිස
  broken publisher එකක් නොවේ — setup අතරතුර unpublished signal එක එසේ වර්ගීකරණය නොකෙරේ.
- Step logs / artifact ZIP authenticated redirect මගින් sandbox-allowlist නොවන hosts වෙත යන නිසා step 28 ඇතුළේ
  නිශ්චිත exception එක කියවිය නොහැකි විය. එය fabricate කර නැත.
- සාක්ෂි: `evidence/origin-run.json`, `evidence/origin-rdp-job.json`, `evidence/origin-signal-publication.json`,
  සහ නැවුම් `evidence/origin-rdp-recheck-20261024T064623Z.json`.

## 3. Isolated baseline (B) සහ patched candidate (C)

`replay-candidate.sh` **clean codeload download** එකකින් සම්පූර්ණයෙන්ම replay කර සත්‍යාපනය කළේය
(2026-10-24): archive SHA verify, **baseline හි regressions fail**, ordered patches යෙදීම,
**candidate හි regressions pass**, tree `62679b8e…` ගැළපීම, 1,378 smoke tests / 107 files, production build.

| පරිසරය | ප්‍රතිඵලය | සාක්ෂි |
|---|---|---|
| A — සත්‍ය live origin | **FAIL (staging)**; UI/API/signal publish නොවීය | Origin API JSON |
| B — වෙනස් නොකළ isolated baseline | F201 **8/8 FAIL** + R1 **3/3 FAIL** (අපේක්ෂිත reproduction) | replay baseline log |
| C — F201+R1 patched isolated candidate | F201 **8/8 PASS** + R1 **3/3 PASS**; 1,378/1,378 smoke; build PASS | `replay-candidate.sh` |
| D — lab stub (control sweep only) | **NOT the application backend**; stub PASSes are never live acceptance; backend-dependent controls stay BLOCKED | `scripts/candidate/stub-server.js`, candidate sweep evidence |
| Lab hosted regressions | **229 PASS / 0 FAIL / 8 SKIP**, total 237 | `node scripts/run-regressions.js` |

**F201** — missing/refused backend probe එකක් measured credentials/DNS/listener failure එකක් ලෙස පෙන්වීම නවත්වයි.
**R1** — PowerShell server එකේ accept loop එකට පෙර ධාවනය වූ synchronous `Get-WinEvent` scans තුන ඉවත් කර,
`server-ready.txt` accept loop එක ඇතුළේ සිට publish කර, periodic scans එක iteration එකකට එකකට සීමා කරයි.
මේවා functional RDP/Web Desktop verification එකක් **නොවේ**.

## 4. Backend stall hypothesis — දැන් source-මට්ටමින් තහවුරු

`payloads/ghrdp-server.ps1` හි `$listener.Start()` + `LISTENING` marker එකට පසු,
**accept loop එකට පෙර** synchronous `Get-WinEvent` scans තුනක් ධාවනය වේ. එම කාලයේ TCP connect
kernel backlog එකට පිළිගැනුණත් කිසිදු thread එකක් ඒවා drain නොකරන නිසා `/health` පිළිතුරු නොදේ.
30s/30s/60s ticks ද එම scans accept thread එකේම inline ධාවනය කරයි.
මෙය **ව්‍යුහාත්මකව source එකෙන් තහවුරු** ය (static invariant regression මගින් pin කර ඇත);
සංඛ්‍යාත්මක ප්‍රමාදය load මත රඳා පවතින අතර Windows client VM එකේ සත්‍යව මනිනු ලැබේ (පහත §5).

### R2 — වඩා බරපතල මූල හේතුව (තහවුරු; මෙම session එකේ fix නොකළේය)

Accept loop එක **එකම thread** එකකි. `GET /ws` එක `Invoke-F99WebSocketUpgrade` **inline** ලෙස එම thread
එකේම ධාවනය කර, එහි loop එක විනාඩි 30ක් (හෝ idle තත්පර 90ක්) දක්වා ජීවත් වේ. එක් `/ws`
සම්බන්ධතාවයක් සම්පූර්ණ HTTP server එකම අවහිර කරයි — `/health`, `/api/config`, `/api/native-status`,
`/api/progress` සියල්ල පිළිතුරු නොදේ. Dashboard එකේ `useDashboardPolling` `/health` හි `ws=true`
දුටු වහාම `/ws` විවෘත කරන නිසා, පරිශීලකයා දකින **"Live" බැනරය සමඟ නිශ්චල UI, හිස්
FQDN/user/IP, අක්‍රීය Launch සහ පාලන** යන සියල්ල එකම transport-starvation ගැටලුවක ප්‍රතිඵලයක් වීමට
බොහෝ දුරට ඉඩ ඇත (වෙන වෙන UI bugs අටක් නොවේ).

සාක්ෂි: lab run `40063545799` හි සැබෑ browser එක app එක විවෘත කළ වහාම measurement step එක විනාඩි
26+ ඇලුණේය (30-min inline WS lifetime ට අනුකූලයි). `scripts/candidate/real-backend.js :: measureWsBlock()`
දැන් එක් `/ws` එකක් විවෘත කර `/health` අවහිර වේදැයි **සීමිත (~7s) පරීක්ෂණයකින්** මනී;
browser phase එකේ WS stub කර ඇත (recorded `browserWsStubbed=true`) එවිට අනෙකුත් controls සත්‍යව පරීක්ෂා කළ හැක.

**Fix නොකළේ ඇයි:** නිවැරදි පිළියම වන්නේ සෑම client එකක්ම background runspace/thread pool එකකට
යැවීමයි (accept loop එක drain වෙමින් පවතී). එය socket/stream lifetime, `$script:` shared state සහ
F99/F101 keepalive හරහා ~9,800-පේළි PS 5.1 file එක ස්පර්ශ කරයි; මෙහි local PowerShell නැති අතර
එකම සත්‍යාපන මාර්ගය මන්දගාමී client-VM runs ය. ඉක්මන් async rewrite එකකින් audit/logon සාක්ෂි
හෝ sockets නිහඬව බිඳ වැටිය හැක. එබැවින් R2 **තහවුරු, ඉහළ-බරපතල, fix-නොකළ** defect එකක් ලෙස
`defects/R2-WEBSOCKET-ACCEPT-LOOP-BLOCK.md` හි නිශ්චිත පිළියම් ස්ථානය සමඟ සටහන් කර ඇත.
ඒ අනුව **PATCHED_APPLICATION_CANDIDATE = PARTIAL** මිස සම්පූර්ණ verified නොවේ.

## 5. සත්‍ය Windows client VM සහ REAL backend සත්‍යාපනය

- VM preflight (run `40054869099`) **PASS**: `WIN-NFU1JG4VESE\User`, interactive session 1,
  responsive runner, native `mstsc`, online tailnet, sanitized headed-browser click.
  එය live application verdict එකෙන් වෙනම ය. සාක්ෂි: `evidence/vm-preflight-40054869099/`.
- **නව** `.github/workflows/real-backend.yml` + `scripts/candidate/real-backend.js`:
  same-repo PR එකක `real-backend-run` label එක ඇති විට interactive VM එකේ ධාවනය වේ
  (exclusive `rdp-lab-desktop` lock එක live-run/preflight සමඟ බෙදා ගනී).
  එය **සැබෑ** `payloads/ghrdp-server.ps1` එක lab-only synthetic Root එකක (නව key, synthetic creds, lab identity)
  start කර, **baseline සහ patched** දෙකටම `connect → first /health` latency, `/health` tick sampling,
  concurrent inline-scan request, redacted endpoint schemas සහ listening socket PID/exe මනී.
  ඉන්පසු සැබෑ headed browser එකකින් UI එකේ auth gate, සෑම route එකකම page-specific marker,
  theme toggle සහ සැබෑ endpoints ධාවනය කරයි.
- Native RDP / Web Desktop / සැබෑ 4624 logon / external mirror මෙම loopback lab candidate එකේ
  **BLOCKED** ලෙස නම් කර ඇත (signed launcher + සැබෑ session අවශ්‍යයි); simulated PASS නොකෙරේ.
- **නිශ්චිත සත්‍ය Windows client-VM ප්‍රතිඵල** — job
  [`40068292422`](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/40068292422)
  **SUCCESS**, head `704fc5d0e7c525dd9fd1d9dc7079f21c95d91b04`:
  - `connect → first /health` stall: **baseline 3474 ms → R1-patched 841 ms**
    (**2633 ms / ~76% අඩුවීම**).
  - `server-ready.txt` accept loop එක ඇතුළේ සිට **patched හි පමණක්** publish විය
    (`READY pid=7932 port=7331 …`); baseline හි `readyText=null`.
  - Listening socket හිමිකරු සත්‍ය `powershell.exe` (baseline pid=5428, patched pid=7932) — stub එකක් නොවේ.
  - `/api/config`, `/api/native-status`, `/api/progress`, `/api/version`, `/ping`, `/health`, `/` සියල්ල **200**.
  - **R2 තහවුරු:** `/ws` open කළ විට `/health` 5008 ms (baseline) / 5005 ms (patched) timeout විය —
    **දෙකේම**. Socket එක වැසූ පසුවත් recovery probe එක 16558/16555 ms දක්වා ප්‍රතිචාරයක් නොලැබුණි.
  - එකම definitive run එකේම සැබෑ controls **18 PASS, 6 BLOCKED, 1 FAIL** (`backend.ws_accept_loop_block`).
    PASS අතර authenticated shell, status-chip/F201 note, routes 11ම, theme toggle සහ සැබෑ config/mirror/telemetry/health
    endpoints ඇත. BLOCKED අතර auth gate (පළමු nav timeout), sessions/files/search prerequisites, native RDP, Web Desktop ඇත.
  - සාක්ෂි: `evidence/real-backend-40068292422/` — baseline/patched reports, `comparison.json`,
    `patched-server-ready.txt`, sanitized stdout/stderr, සහ `patched-authenticated-patched.png`.
    එම screenshot එක පරිශීලකයාගේ `Live` + `Launch unavailable` + missing Web Desktop URL තත්ත්වය ප්‍රතිනිර්මාණය කරයි.
  - Browser WS එක **stub** කර ඇත (`browserWsStubbed=true`) — R2 නිසා විනාඩි 30ක් ඇලීම වළක්වා අනෙකුත් controls
    සත්‍යව පරීක්ෂා කිරීමට පමණි. එහි `"Live"` කියවීම ස්වාධීන සම්බන්ධතා සාක්ෂියක් ලෙස නොගනී.
  - `40068292422` JSON reports හි `identity.headless=true` යනු historical metadata inversion එකකි.
    Workflow එකේ `CANDIDATE_HEADLESS=0` සහ `chromium.launch({ headless:false })` නිසා actual browser එක interactive VM එකේ
    **headed** විය. Historical evidence එක වෙනස් නොකළේය; source එක සහ regression එක නිවැරදි කර ඇත (`defects/LAB-HARNESS.md`).
  - සහායක/පෙර runs: `40067304717` (SUCCESS; 3225→719 ms corroboration, browser deferred),
    `40066357848` (18 controls PASS, job failed on nav timeout), `40063545799` (26-min inline-WS freeze),
    `40062592553` (spawn fault; honest fatal). Definitive numbers ලෙස ගන්නේ `40068292422` පමණි.

**"Live" බැනරයේ අර්ථය (source එකෙන් තීරණය කළේය):** `AppShell.tsx` හි "Live" වන්නේ
`wsLive` සත්‍ය වූ විටය — එනම් dashboard එකේම `/ws` socket එක `onopen` වූ විටය. එය RDP session
එකක් හෝ backend සෞඛ්‍යය ගැන නොව **WS transport එක විවෘත බව** පමණි. පරිශීලකයාගේ "green Live + frozen UI"
තත්ත්වයේදී WS එක ඇත්තටම විවෘත වී, පසුව R2 නිසා සියලු `/api/*` polls කුසගින්නේ තැබීම බොහෝ දුරට සිදු වේ.
(අපගේ stubbed browser run එකේ "Live" කියවීම stub එක නිසා බැවින් ස්වාධීන සම්බන්ධතා සාක්ෂියක් ලෙස නොගනී.)

## 6. PR checks සහ වෙන් කර ඇති verdicts

`40068292422` head එකේම PR gates කිහිපයක් එකවර ධාවනය විය. **Real Backend Verification `40068292422` SUCCESS** සහ read-only live-run gate
`40068292411` SUCCESS වේ. **App Candidate `40068292398` FAIL** වූයේ එහි lab-stub sweep එකේ BLOCKED controls
96ක් ඇති නිසා එම gate එක BLOCKED/FAIL එක PASS ලෙස නොගන්නා නිසාය. **Capability Check `40068292407` FAIL** වූයේ
standalone identity/TLS certificate step එකේදී server-local capabilities **BLOCKED** වී downstream client checks **NOT_RUN** වූ නිසාය
(`evidence/capability-40068292407/`). මේවා සැබෑ RDP/Web Desktop acceptance ලෙස හංගා නැත; definitive real-backend job එකට අමතරව ඇති
අසම්පූර්ණතා ලෙස වෙනම සටහන් කරයි.

| Verdict | අගය |
|---|---|
| **LAB_HARNESS** | **PASS** — consolidated; 229 pass/0 fail/8 skip hosted; clean replay PASS; definitive real-backend VM job `40068292422` SUCCESS. අනෙකුත් PR acceptance gates තවම green නොවන බව ඉහත වෙනම සඳහන්ය. |
| **LIVE_ORIGIN_APPLICATION** | **FAIL** — staging step 28 fail වී UI/signal publish නොවීය; broken publisher එකක් නොවේ |
| **PATCHED_APPLICATION_CANDIDATE** | **PARTIAL** — hosted PASS (F201+R1, 1378 smoke, build, replay) + සත්‍ය Windows client-VM මත backend verify (18 PASS / 6 BLOCKED / 1 real FAIL, stall 3474→841ms, server-ready.txt). **R2 inline-WS stall තහවුරු, fix නොකළේය** (පරිශීලක UI-freeze මූල හේතුව වීමට බොහෝ ඉඩ ඇත). Native RDP/Web Desktop/real-logon BLOCKED — සම්පූර්ණ acceptance නොවේ. |
| **UPSTREAM_DEPLOYMENT** | **NOT_RUN** — application remote මෙම session එකේ read-only; push/merge/deploy නැත |
| **AUTOMATIC_APPLICATION_ORIGIN_INTEGRATION** | **BLOCKED** — නිශ්චිත run+attempt MC-SIGNAL එකක් publish නොවීය; lab harness path එක සූදානම් ය |

## 7. ඉතිරි ක්‍රියාකරු ක්‍රියාවන් සහ replay

සජීව origin අන්තයට-අන්තයට තහවුරු කිරීමට **නැවුම් `main.yml mode=rdp` run URL එකක්** අවශ්‍යය
(පැරණි run එක staging හි අවසන් විය). එක් වරක් පමණක් ඉල්ලා ඇත.

- සම්පූර්ණ replay: `bash replay-candidate.sh` (clean download → baseline fail → candidate pass → build).
- Bundle verify: `bash verify-bundle.sh` (checksums + pinned base + ordered patch applicability).
- Main-repository handoff (නව session එකට): **`MAIN-REPOSITORY-HANDOFF.md`**.
- සියලු control සහ data lineage: `control-coverage.csv`, `data-lineage.csv`.
- Defect වාර්තා: `defects/`. Checksums: `SHA256SUMS`. Patch order: `series.txt`.

Mock/stub PASS කිසිවක් සැබෑ application behavior ලෙස ඉදිරිපත් නොකෙරේ.
Ports 7331/7332 භූමිකාවන් උපකල්පනය නොකර source එකෙන් සොයා ගත යුතුය.
Identity stamps සංසන්දනය පහසු කිරීමට පමණක් නැවත ලියා නැත.
