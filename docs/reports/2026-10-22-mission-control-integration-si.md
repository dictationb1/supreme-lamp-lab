# Mission Control — ස්වයංක්‍රීය ඒකාබද්ධතාවය: තත්ත්ව වාර්තාව (2026-10-22)

**කෙටි නිගමනය:** ලැබ් (lab) පැත්තේ සම්පූර්ණ යාන්ත්‍රණය — සජීවී ධාවනය සොයාගැනීම, අනන්‍යතා සත්‍යාපනය, එක් ඩෙස්ක්ටොප් එකක් claim කිරීම, විශේෂාංග ඉන්වෙන්ටරිය සහ වාර්තාව — ක්‍රියාත්මක කර ඇත. නමුත් **සම්පූර්ණ ස්වයංක්‍රීය සම්බන්ධය තවම සත්‍යාපනය කර නැත**, මන්ද මෙම පරිසරයෙන් යෙදුම් (app) ධාවනයක් ආරම්භ කළ නොහැකි අතර (HTTP 403), යෙදුම් ගබඩාවට ලිවීමද 403 වේ. මෙම වාර්තාවේ 4 වන කොටසේ සියලුම අසමත්/අසත්‍යාපිත කරුණු නිශ්චිතව ලැයිස්තුගත කර ඇත.

---

## 1. එක් එක් ගබඩාවේ (repo) ක්‍රියාත්මක කළ දේ

### 1.1 ලැබ් ගබඩාව — `dictationb1/supreme-lamp-lab`

| ගොනුව | කාර්යය |
|---|---|
| `scripts/lib/origin-discovery.js` | ධාවනය තෝරාගැනීම (පැහැදිලි id එකක් ඇත්නම් එය; නැත්නම් පැරණිම in-progress ධාවනය), attempt/sha/workflow/විදේශීය repo සත්‍යාපනය, job-log → archive fallback, descriptor ගොඩනැගීම, `resolveOriginSource()` — **පළමුව signal, දෙවනුව logs** |
| `scripts/lib/live-signal.js` | `MC-SIGNAL v1` ලියමිතිය: repo/run/attempt/appSha/endpoint පැහැදිලිව, dashboard key එක **RSA-OAEP-256** සංකේතනයක් ලෙස පමණක්; වැරදි attempt/run/sha, කල් ඉකුත්, TTL > 6h, අනාගත issuedAt, tailnet නොවන endpoint, නොදන්නා key id, decrypt නොවන ciphertext — සියල්ල නමින් ප්‍රතික්ෂේප වේ |
| `scripts/live-run.js` | `discover`, `probe`, `signal`, `signal-keygen` විධාන; sanitized annotations; `--descriptor-identity` |
| `scripts/inventory-doc.js`, `docs/feature-inventory.md` | යෙදුමේ වර්තමාන කොන්ත්‍රාත්තුවෙන් ජනිත 20-විශේෂාංග වගුව (requirement/පූර්ව කොන්දේසි/ක්‍රියාව/අපේක්ෂිත UI/අපේක්ෂිත server effect/මෙහෙයුම්කරු/තත්ත්වය) |
| `scripts/lib/live-inventory.js` | `NOT_APPLICABLE` සඳහා හේතුව අනිවාර්ය; mandatory non-PASS එකක් VERIFIED තීරණය අවලංගු කරයි |
| `scripts/test/origin-discovery-regressions.js` | 15 regression (signal roundtrip, live attach, වැරදි attempt fallback, publisher→reader round-trip, per-job logs, archive fallback, stale attempt, descriptor…) |
| `scripts/inventory-doc.js`, `docs/live-signal.md` | මිනුම්, ආකෘතිය, තර්ජන ආකෘතිය සහ නිශ්චිත app වෙනස |
| `patches/app-live-signal-publisher.js` | **යෙදුමට එකතු කළ යුතු** ප්‍රකාශකය (publisher) — PAT අවශ්‍ය නැත, `checks: write` පමණි, key එක සඳහා තත්පර 20කට වරක් republish, key rotation නම් නැවත publish, RDP job එක කිසිදා අසාර්ථක නොකරයි |
| `patches/app-live-signal-check-run.snippet.yml` | යෙදුමේ කළ යුතු **එකම** වෙනස: step එක + `checks: write` permission + `LAB_SIGNAL_PUBKEY` variable |
| `patches/supreme-lamp-APP-MAIN-logon-status-matches-clobber.patch` | `/api/logon-status` හි `$Matches` clobber දෝෂයට නිවැරදි කිරීම — වර්තමාන app main (`daf13685`) මතට පිරිසිදුව apply වේ |

### 1.2 යෙදුම් ගබඩාව — `dictationb1/supreme-lamp`

**කිසිදු වෙනසක් සිදු නොවීය.** මෙම token එකට ලිවීම `HTTP 403`. අවශ්‍ය වෙනස්කම් දෙක patch ලෙස ලැබ් ගබඩාවේ ඇත:
1. `scripts/live-signal-publisher.js` එකතු කිරීම + `checks: write` + `LAB_SIGNAL_PUBKEY`,
2. `/api/logon-status` `$Matches` නිවැරදි කිරීම.

---

## 2. ස්වයංක්‍රීය ද, තවම මිනිස් ද?

### දැනටමත් ස්වයංක්‍රීය (ලැබ් පැත්ත)
- තත්පර 600කට වරක් (cron `*/10`) මූලාශ්‍ර ධාවනය පරීක්ෂා කිරීම.
- ධාවනය තෝරාගැනීම සහ GitHub run API එකට එරෙහිව අනන්‍යතා සත්‍යාපනය (run id, attempt, head sha, workflow path, repo allowlist).
- key එක මතකයේ පමණක් තබාගෙන `/api/rdp-token` Bearer gate එකෙන් ticket ලබාගැනීම; key කිසිදු descriptor/evidence/annotation/report එකකට නොයයි.
- එක් ඩෙස්ක්ටොප් එකක් claim කිරීම, ලොක් එක, dedupe (run+attempt), timeout/expiry.
- විශේෂාංග 20 ඉන්වෙන්ටරිය + VERIFIED තීරණය + වාර්තාව (JSON/Markdown) + cleanup.

### තවම මිනිස් (එක් වරක් පමණි)
1. යෙදුම් patch එක merge කිරීම (publisher + `checks: write` + `LAB_SIGNAL_PUBKEY`).
2. ලැබ් secret `LAB_SIGNAL_PRIVATE_KEY` සැකසීම (`node scripts/live-run.js signal-keygen` මගින් ජෝඩුව ජනිත වේ; private key කිසිවිටෙක chat එකේ නොදෙන්න).
3. `mode=rdp` සමඟ යෙදුමේ `main.yml` එකක් dispatch කිරීම — dispatch කළ හැකි token එකකින් හෝ Actions UI එකෙන්.

මිනිස් පියවර 3න් පසු, නැවත dispatch එකක්වත්, key paste එකක්වත්, URL open එකක්වත් අවශ්‍ය නොවේ.

---

## 3. සත්‍යාපනය: මිනුම් සහ ධාවන

### 3.1 ප්‍රවාහන මිනුම (මෙය මුළු සැලසුමම වෙනස් කළ සොයාගැනීම)

| ප්‍රවාහනය | ධාවනය සජීවීව ඇති විට | job එක අවසන් වූ පසු |
|---|---|---|
| `GET /repos/{o}/{r}/actions/runs/{id}/logs` | **HTTP 404** (ධාවනය 39806929005) | zip එකක්, නමුත් server එක එවිට නැත |
| `GET /repos/{o}/{r}/actions/jobs/{jobId}/logs` | **302 → `productionresultssa*.blob.core.windows.net` → HTTP 404**, උත්සාහ 6/6, queued සහ in_progress යන දෙකෙහිම, GitHub runner එකක් **ඇතුළු සිට** (ධාවන 39808737164, 39808861040) | සාර්ථක jobs සඳහා කියවිය හැක (11–27 KB මනින ලදී) |
| public check-run `output.summary` | **සජීවීව කියවිය හැක** — තත්පර 12කින් production reader එක envelope එක decrypt කළේය; publisher job එක එවිටත් `in_progress` (ධාවනය 39810624203) | කියවිය හැක, නමුත් `completed` ලෙස |

**ප්‍රතිඵලය:** "යෙදුමේ කිසිදු වෙනසක් නොමැතිව, log එකෙන් සජීවී ධාවනයක් සොයාගැනීම" කළ නොහැකි බව මනින ලදී. එබැවින් සැලසුම check-run signal එකක් වෙත වෙනස් කරන ලදී; log parser එක අවසන් ධාවන සඳහා fallback එකක් ලෙස පමණක් ඉතිරි විය.

### 3.2 සාර්ථකව ධාවනය වූ සත්‍යාපන
- **ධාවනය 39810624203** (`_log-api-probe` harness, පසුව ඉවත් කරන ලදී): ephemeral RSA ජෝඩුවක්, publisher එකක් check-run output එකට `MC-SIGNAL v1` එක publish කළේය; **production reader** (`scripts/lib/live-signal.js`) එය සජීවීව කියවා, අනන්‍යතාව සත්‍යාපනය කර, private key එකෙන් decrypt කළේය. ප්‍රතිඵලය: `ok:true`, key එක publisherගේ අගයට සමාන, **ප්‍රමාදය තත්පර 12**. Key එක plaintext ලෙස public text එකේ නොතිබිණි.
- **`node scripts/run-regressions.js`: පරීක්ෂණ 155 — 147 PASS, 0 FAIL, 8 SKIP.**
  - SKIP 7: browser e2e (chromium ස්ථාපිත නැත).
  - SKIP 1: `$Matches` clobber reproduction "real PowerShell" — මෙම host එකේ `pwsh` නැත; එය Windows client job එකේ ධාවනය වේ. එබැවින් **එය මෙහි ධාවනය කර නොමැත**.
- Publisher→reader round-trip: **සැබෑ publisher ගොනුව** fake GitHub API එකකට spawn කර, එහි publication එක සැබෑ reader එකකින් parse/validate/decrypt කරන regression එකක් සාර්ථකව ධාවනය වේ.

### 3.3 යෙදුම් ධාවන පිළිබඳ සත්‍ය තත්ත්වය
| ධාවනය | ප්‍රතිඵලය |
|---|---|
| 39190219092, 39105168267, 39099640314, 39088969906, 39057917289, 39048550432, 39039841413, 39039075051, 39038759338 | `rdp` job **cancelled** (තත්පර 3–133 ක් පවතී) |
| 39005381921, 39005411068 | ධාවනය `success` නමුත් `rdp` job **skipped** (`mode != 'rdp'`) |
| වෙනත් | — |

**යෙදුමේ `main.yml` හි `rdp` job එක කිසිදා සම්පූර්ණ වී නැත.** එබැවින් Mission Control server එකක් කිසිදා සජීවීව පවතිනු දකින ලද්දේ නැත; ලැබ් එකට attach වීමට ධාවනයක් නොමැත.

---

## 4. ඉතිරි වන අසමත් / අසත්‍යාපිත කරුණු (සම්පූර්ණ ලැයිස්තුව)

1. **App-originated සජීවී ධාවනයක් නොමැත.** `gh workflow run` → 403; app ධාවන සියල්ල cancelled හෝ `rdp` skipped. → descriptor එකක් සැබෑ ධාවනයකින් කිසිදා ගොඩනැගී නැත.
2. **App patch එක merge වී නැත** (app ලිවීම් 403). Signal එක publish නොවේ නම් discovery log fallback එකට වැටේ — එය සජීවී ධාවනයක් දැකිය නොහැක.
3. **Windows client VM එක කිසිදා steer වී නැත**: RDP සහ Web Desktop, ticket redemption, LogonType-10 සාක්ෂි, 20-විශේෂාංග PASS — සියල්ල `NOT_RUN`.
4. **දෙවන ස්වාධීන ධාවනය** (fresh credentials) — `NOT_RUN`.
5. **Cancellation/expiry/duplicate-event** හැසිරවීම code එකේ ඇත; සජීවී ධාවනයකින් සත්‍යාපනය කර නැත.
6. **`$Matches` patch එක**: වර්තමාන app main (`daf13685`) මතට cleanly apply වේ; real-PowerShell reproduction මෙම host එකේ skip විය (pwsh නැත). එබැවින් "නිවැරදි කරන ලදී" ලෙස නොකියවේ — **tested patch එකක් ලෙස පමණක්** භාර දෙයි.
7. **`docs/feature-inventory.md` හි සියලු පේළි `NOT_RUN`** — ඒවා කොන්ත්‍රාත්තු ලැයිස්තුවක් මිස සත්‍යාපන ප්‍රකාශයක් නොවේ.
8. මෙම sandbox එකට `*.blob.core.windows.net` හෝ app repo write ප්‍රවේශය නැති බැවින්, සම්පූර්ණ app log එකක් කිසිදා කියවා නැත; සියලු නිගමන GitHub API metadata, runner-side මිනුම් සහ sanitized tail වලින් පමණි.

---

## 5. PR / branch / commit සහ merge තත්ත්වය

| අයිතමය | තත්ත්වය |
|---|---|
| ලැබ් branch | `arena/428ccc99-supreme-lamp-lab` — tip `b6431b2` |
| ලැබ් PR | **#21 (OPEN, mergeable)** — body එක සම්පූර්ණ තත්ත්වයෙන් යාවත්කාලීන කර ඇත |
| ලැබ් main | `8067e4e9b3316cbfa21115a5de112351eb67d417` (මෙම වැඩ තවම merge වී නැත) |
| යෙදුම් main | `daf13685d051abf8dea304a2ade82522ae8733ba` |
| යෙදුම් PR | **නොමැත** — ලිවීමට අවසර නැත (403) |
| ප්‍රධාන commits | `b6431b2` (publisher+snippet+docs+cleanup), `aaa30ac` (check-run discovery), `8824636` (live-signal lib+harness), `3a2babd`, `7aec38a` (transport measurements) |
| CI (PR) | `static` job එකේ `actionlint` දෝෂයක් තිබුණි (SC2016: single-quoted `node -e`). එය quoted heredoc එකකට වෙනස් කර, `_actionlint-report` ධාවනයේදී **`actionlint exit=0, findings=0`** ලෙස තහවුරු කරන ලදී (ධාවනය 39817024937); එම තාවකාලික workflow එක ඉවත් කර ඇත. සම්පූර්ණ PR ධාවනය නැවත පරීක්ෂා කරමින් පවතී |
| Deployment | කිසිවක් deploy කර නැත; lab main වෙනස් වී නැත |

---

## 6. නිශ්චිත ඊළඟ පියවර (බාධක සඳහා පමණි)

1. **යෙදුම් patch එක merge කරන්න** (එකම වෙනස): `patches/app-live-signal-publisher.js` → `scripts/live-signal-publisher.js`; `patches/app-live-signal-check-run.snippet.yml` හි step + `checks: write`; repo variable `LAB_SIGNAL_PUBKEY`.
2. **ලැබ් secret එක සකසන්න:** `node scripts/live-run.js signal-keygen` → public key (app variable), private key (lab secret `LAB_SIGNAL_PRIVATE_KEY`). Key කිසිවිටෙක chat/PR/report එකට නොදමන්න.
3. **`mode=rdp` සමඟ app `main.yml` එකක් dispatch කරන්න** (dispatch කළ හැකි token එකක් හෝ Actions UI). ඉන් පසු ලැබ් sweep එක තත්පර 600ක් තුළ එය ස්වයංක්‍රීයව අල්ලාගනී.
4. එම ධාවනයේදී **Windows client job එකේ** `$Matches` PowerShell reproduction ධාවනය වේ — එය සමත් වුවහොත් පමණක් app දෝෂය "නිවැරදි කරන ලදී" ලෙස සලකන්න.
5. දෙවන ස්වාධීන ධාවනයක් (fresh credentials) සහ cancellation/expiry අත්හදා බැලීම — පළමු ධාවනය VERIFIED වූ පසු පමණි.

**කිසිදු රහස් අගයක්** මෙම වාර්තාවේ, PR එකේ, artifact එකේ හෝ log එකේ නොමැත; key fingerprint පමණක් සටහන් වේ.
