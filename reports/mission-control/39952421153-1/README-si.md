# Mission Control පරීක්ෂණය — තත්ත්ව වාර්තාව (2026-10-23)

මෙය **අතරමැදි** වාර්තාවකි. කිසිදු පාලකයක් තවම `PASS` ලෙස සටහන් නොවේ; හේතුව පහත
"අවහිරය" කොටසේ ඇත. සියලු සංඛ්‍යා මෙම වාර්තාව ලියන විට ලබාගත් සැබෑ දත්තවලින් ය.

## 1. මූලාශ්‍ර (origin) තත්ත්වය

| කරුණ | අගය |
|------|------|
| ධාවනය | `dictationb1/supreme-lamp` #39952421153, attempt 1 |
| SHA | `24ddaa9904c92dbbba39e3cc7aba458769e6bbe4` (app `main` ඉන් පසු `8cb65120` දක්වා ගියත්, මෙම ධාවනයේ SHA වෙනස් නොවේ) |
| තත්ත්වය | `in_progress` (13:48Z ට නැවත පරීක්ෂා කළා) |
| `docs/status.json` | `ts 13:48:48Z`, `watcherAlive true`, MC `http://100.87.91.3:7332/`, tailnet `:7331` |
| signal | `mc-signal/v1`, check run `120415090302` (අවසන් වශයෙන් `in_progress`), TTL සීමාව 18:19:13Z |
| queue record | `records/dictationb1_supreme-lamp/39952421153-1.json` = `BLOCKED` (job-level gap-fill) |

## 2. ප්‍රතිඵල (වෙන් වෙන්ව)

| අංශය | තත්ත්වය | සාක්ෂි |
|------|---------|--------|
| **LAB_HARNESS** | නිවැරදි කිරීම් සම්පූර්ණයි (13 දෝෂ), regression 213/205/0/8 | `defects/LAB-HARNESS-DEFECTS.md`, `evidence/sanitized-logs/` |
| **LIVE_APPLICATION** | **BLOCKED** — backend HTTP ප්‍රතිචාර දෙන්නේ නැත | lab run 39963491076 net preflight |
| **PATCHED_APPLICATION_CANDIDATE** | **NOT_RUN** | පැච් එකක් තවම සකස් නොකළ අතර, offline clone එකේ build එකද තවම සිදු නොවීය |
| **UPSTREAM DEPLOYMENT** | **NOT_VERIFIED** | live origin එකේ ප්‍රතිඵලයක් නැති තුරු කිසිවක් නොකියයි |

### අවහිරය (මෙය නිශ්චිත මිනුමකි)

`rdp-lab-client` යන පරිගණකය (tailnet `100.93.94.15`, session 1) සිට:

- tailscale: `backend=Running`, `selfOnline=True`, පියර් `100.87.91.3` `online`
- TCP `100.87.91.3:7331`: **reachable=True**
- HTTP `GET /api/ping`: **code=000, curlExit=28** (තත්පර 20ක් තුළ පිළිතුරක් නැත)

එනම්: ජාලය අවහිර නොවේ; port එක විවෘතය; **API පිළිතුරු නොදෙයි**. මේ නිසා
`/api/readiness` කිසිදා `ready` නොවන අතර සෑම live pass එකක්ම `READINESS_TIMEOUT`
වෙත යයි. මෙය *භාණ්ඩයේ* (application) සංඥාවක් මිස ජාල දෝෂයක් නොවේ — එහෙත්
තවම එය ප්‍රමාණවත් සාක්ෂියකින් තහවුරු කර නැත (app run log එක ධාවනය අවසන් වන
තෙක් කියවිය නොහැක).

## 3. මෙම වාරයේ නිවැරදි කළ lab-harness දෝෂ

L-01 … L-13 සියල්ල `defects/LAB-HARNESS-DEFECTS.md` හි සවිස්තරව ඇත. වැදගත්ම:

- desktop lock එක `{name, owner}` සමඟ ලබාගෙන තිබීම → `LOCK_DIR_REQUIRED` (L-05)
- job `success` එක `REPORTED_VERIFIED` ලෙස ලිවීම → වැරදි "pass" (L-06)
- MC-SIGNAL එකේ seal කළ JSON එක token ලෙස නොකියවීම → සෑම heartbeat එකකම fingerprint වෙනස් වී `BLOCKED_DESCRIPTOR_CHANGED` (L-09)
- queue record එකේ lab-default artifact එක භාවිතා කිරීම → `ARTIFACT_NOT_FOUND` (L-08)
- claim ගොනුවේ 409 තරඟය → verification abort (L-13)
- workflow ගොනුවේ unquoted `: ` → මුළු workflow එකම ක්‍රියා විරහිත (L-11)

## 4. ඊළඟ පියවර

1. **එකම නිශ්චිත ක්‍රියාවක්:** නව application run එකක් (`workflow_dispatch` → `main.yml`) ආරම්භ කර එහි URL එක දෙන්න, නැතහොත් පවතින server එක නැවත සෞඛ්‍ය සම්පන්න කරන්න.
2. ඒ අතර: `24ddaa9` මූලාශ්‍රයෙන් feature inventory එක (IDs + prerequisites + expected UI/backend effects) සකස් කිරීම.
3. Isolated clone එකේ build/stage/start සහ baseline reproduce.
4. Live pass එක සාර්ථක වූ පසුව පමණක් ඕනෑම පාලකයක් `PASS` ලෙස සටහන් කිරීම.

## 5. නොකළ / නොදන්නා දේ (විනිවිදභාවය)

- කිසිදු UI පාලකයක් තවම ධාවනය කර නැත → සියල්ල `NOT_RUN`
- RDP handoff, Web Desktop, upload/download, search, diagnostics: `NOT_RUN`
- cleanup root cause (L-02 හි මුල් බිඳවැටීම): තවම නොදනී; patch කළ පියවර දැන් exit 0 දෙයි
