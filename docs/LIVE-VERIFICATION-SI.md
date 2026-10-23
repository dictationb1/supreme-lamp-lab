# සජීවී තහවුරු කිරීම — තත්ත්ව වාර්තාව (2026-10-23)

මෙම ලේඛනය ස්වයංපෝෂිතය. වෙනත් ලේඛනයක් නොකියවා මෙය කියවා තත්ත්වය තේරුම්
ගත හැක. එය යථාර්ථවාදීය: තහවුරු නොවූ දෙයක් තහවුරු වූ ලෙස නොකියයි.

## 1. එක් වාක්‍යයකින්

ලැබ් එක දැන් සැබෑ යෙදුම් ධාවනයක් (application run 39899087271) ස්වයංක්‍රීයව
සොයාගෙන, එහි සංකේතනය කළ (encrypted) රහස්‍ය යතුරු දිශානතිය ලැබ්ගේ
`LAB_SIGNAL_PRIVATE_KEY` මගින් විවෘත කර, එම ධාවනයේම බැකෙන්ඩ් එකට සම්බන්ධ වී,
සැබෑ තත්ත්ව වාර්තාවක් නිපදවයි. **නමුත් සම්පූර්ණ පිළිගැනීම (VERIFIED) ලැබී
නැත**: ඒ සඳහා යෙදුම් පැත්තේ දෝෂ දෙකක් තවම ඇත, සහ දෙවන ස්වාධීන ධාවනයක්
(requirement C) තවම සිදු නොවීය.

## 2. දැන් වැඩ කරන දේ (සැබෑ ධාවනයන්ගෙන් තහවුරු)

| කරුණ | තත්ත්වය | සාක්ෂිය |
|---|---|---|
| පසුබැසීම් පරීක්ෂණ (regressions) | **PASS** | `228 tests: 220 passed, 0 failed, 8 skipped` (Linux); Windows client job එකේදී එම කට්ටලයම |
| යෙදුම් ධාවනය ස්වයංක්‍රීයව සොයාගැනීම | **PASS** | `transport=check-run`, `signalFormat=mc-signal/v1`, `signalLive=true`, `heartbeatAge=8–57s`, `uiMatchesRunSha=true`, plaintext-log fallback **භාවිත නොකළා** |
| රහස්‍ය යතුරු විවෘත කිරීම | **PASS** | `keyId rsa:f5ae1689a220835e` = ලැබ් ගණනය කළ keyId; `alg=rsa-oaep-sha256+aes-256-gcm`; යතුර `LAB_SIGNAL_PRIVATE_KEY` තුළම, log/annotation/artifact වලට කිසිදා නොයයි |
| ධාවනයේම බැකෙන්ඩ් එක ද යන්න | **PASS (ක්‍රියාවලිය මට්ටමින්)** | සේවාදායක ක්‍රියාවලිය ඇරඹුණේ `2026-10-23T04:13:48.829Z`; ධාවනය ඇරඹුණේ `04:12:31Z` → එය **මේ ධාවනයේම** ක්‍රියාවලිය; `/api/config buildSha` = ධාවන head |
| රහස්‍ය තොරතුරු පිරිසිදු වාර්තාව | **PASS** | `live_credential_hygiene=PASS` (ගොනු 4, රහස් අගය 1, url-key/ticket රටා පිරිසිදු) |
| **පිළිගැනීම (VERIFIED)** | **නැත** | පහත 3, 4 කොටස් බලන්න |

## 3. යෙදුම් පැත්තේ දෝෂ 1 — RDP ටිකට් මාර්ගය කැඩී ඇත

සොයාගත් කේතය: **`APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE`**

* යෙදුමේම ටෙලිමෙට්‍රිය කියන්නේ සේවාදායකය සතු ටෝකනය **හිස්** බවයි
  (`expectedLen=0`), එහෙත් යෙදුම විදහාපෑ ටෝකනය අකුරු 32ක්.
* `POST /api/rdp-token` එම ධාවනයේම credentials සඳහා **401** දුන්නා; නම් නොකළ
  (anonymous) හා ව්‍යාජ (forged) ඉල්ලීම්වලටත් 401 — එනම් ගේට් එක සැබෑයි, එය
  සංසන්දනය කරන්නේ හිස් snapshot එකක් සමඟ.
* එම credentials යෙදුමේ **refresh-aware** මාර්ගයේ වැඩ කරයි
  (`GET /api/search/status` → 404 `UNKNOWN_SOURCE` = auth පසු; anonymous/forged → 403).
* හේතුව යෙදුමේම workflow එකේ: `F92 register user-session server` පියවර
  (`main.yml` ~903) `GHRDP-Server` කාර්යය වහාම අරඹයි (ධාවනයේ තත්පර 77කදී), එහෙත්
  ධාවනයට අදාළ ටෝකනය ලියැවෙන්නේ ඊට විනාඩි 9කට පසුව (`Stage files + write
  config.json`, ~2554; `dash-token.txt` 2831). සේවාදායකය එම ගොනුව නැවත කියවන්නේ නැත.
* අදාළ තීරණය යෙදුම් ගබඩාවේ: (අ) ටෝකනය ලියැවීමෙන් පසුව සේවාදායකය අරඹන්න,
  නැතහොත් (ආ) `/api/rdp-token` ද අනෙක් මාර්ග මෙන් `Test-GhrdpDashToken`
  (refresh-aware union) හරහා සංසන්දනය කරන්න.
* **ප්‍රතිඵලය:** මෙය නොවෙනස්ව ඇති තාක්, **ස්වයංක්‍රීය ස්වදේශීය RDP (native RDP)
  තහවුරු කළ නොහැක**. ලැබ් එය ව්‍යාජ ලෙස සමත් නොකරයි.

## 4. යෙදුම් පැත්තේ දෝෂ 2 — UI build stamp නැත

`/api/version` `sha:"dev"` ලෙස පිළිතුරු දෙයි; `/api/config.buildSha` පමණක් ධාවන
head එකට ගැලපේ. ලැබ් එය **`VERSION_STAMP_ABSENT` → BLOCKED** ලෙස වාර්තා කරයි
("වෙනත් instance එකක්" ලෙස අසත්‍ය ලෙස නොකියයි). මේ නිසා UI බිල්ඩ් එක ධාවනයට
බැඳීම තහවුරු කළ නොහැක.

## 5. අවසන් සම්පූර්ණ ධාවනයේ ප්‍රතිඵලය

ලැබ් ධාවනය `39913711978` (client job `120282471443`), origin 39899087271/1:

* `live_origin_verified = PASS`
* `live_credential_hygiene = PASS`
* `live_authorization = BLOCKED` — `APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE`
* `live_identity = BLOCKED` — `VERSION_STAMP_ABSENT`
* `live_ui_rendered = FAIL` — `overview=rendered-with-errors`
* `live_features = FAIL` — **අනිවාර්ය 14න් 3ක් පමණි PASS**;
  මුළු ගණන: PASS 3, FAIL 7, BLOCKED 6, SKIPPED 4
* අවසන් තීරණය: `FEATURES_VETOED`, `accepted=false` → queue record `REPORTED_FAILED`
  (එය නැවත ධාවනය නොකෙරේ; අලුත් ධාවනයක් අවශ්‍යයි)

## 6. තවම NOT_RUN / BLOCKED

| අයිතමය | තත්ත්වය | හේතුව |
|---|---|---|
| C: දෙවන ස්වාධීන යෙදුම් ධාවනය (නව අනන්‍යතාව, ප්‍රතිබාහනයක් නැති බව) | **NOT_RUN** | යෙදුම් workflow එක ලැබ් එකෙන් dispatch කළ නොහැක (403); මෙය operator ක්‍රියාවකි |
| D: සජීවී cancel/expiry/superseded | **ඒකක මට්ටමින් PASS, සජීවීව NOT_RUN** | `SIGNAL_STALE_ATTEMPT`, closed-signal, `RUN_ATTEMPT_SUPERSEDED`, කල් ඉකුත් වූ වාර්තා skip කිරීම — පරීක්ෂණ ඇත; සජීවී අවලංගු කිරීමක් සඳහා නව origin එකක් අවශ්‍ය |
| ස්වයංක්‍රීය native RDP | **BLOCKED** | §3 දෝෂය |
| Web Desktop / සම්පූර්ණ විශේෂාංග ලැයිස්තුව | **FAIL/BLOCKED** | ඉහත ප්‍රතිඵලය; සෑම අසමත් විශේෂාංගයකටම දැන් run page එකේ annotation එකක් ඇත |
| සූදානම → දෘශ්‍ය UI ප්‍රමාදය මැනීම | **මනිනු ලැබේ** | `latency` annotation: `runStartToAuthMs`, `authToBrowserMs`, `browserToFirstRouteMs`, `totalMs`; `*/10` cron ප්‍රමාදය මේ ගණනට ඇතුළත් නොවේ |

## 7. ඊළඟ පියවර (අනුපිළිවෙලින්)

1. යෙදුමේ boot-order දෝෂය (§3) නිවැරදි කරන්න. එය නොකළහොත් සෑම ධාවනයක්ම
   `live_authorization=BLOCKED` ලෙසම නිවැරදිව වාර්තා වේ.
2. `mode=rdp` සමඟ **නව යෙදුම් ධාවනයක්** අරඹන්න (requirement C).
   ලැබ්ගේ `*/10` ස්වීපය එය ස්වයංක්‍රීයව (විනාඩි 10ක් ඇතුළත) අල්ලා ගනී.
   ක්ෂණික ධාවනයක් අවශ්‍ය නම් PR #23 ට `live-verify` label එක එක් කරන්න.
3. ඉන් පසු: දෙවන ධාවනයේ නව endpoint/ටෝකනය ඇති බව (ප්‍රතිබාහනයක් නැති බව)
   සහ cancel/expiry පරීක්ෂණ සජීවීව තහවුරු කරන්න.

## 8. මූලධර්ම (කිසිදා නොඉවත් කරන්න)

* සැබෑ ධාවනයක් නොමැතිව "VERIFIED" කිසිවිටෙක නොකියයි; ලැබ්-තනි පරීක්ෂණ
  පමණක් සාක්ෂි නොවේ.
* BLOCKED ≠ FAIL ≠ NOT_RUN. පූර්ව අවශ්‍යතාවක් නැති වීම BLOCKED; යෙදුම වැරදි
  ලෙස හැසිරීම FAIL.
* රහස්‍ය යතුරු, dashboard ටෝකන, authenticated URL — log, annotation, artifact,
  වාර්තා JSON තුළට නොයයි. ලැබ් කියවන්නේ ෆීල්ඩ් නම් හා ෂෝර්ට් hash පමණි.
* NLA/TLS හෝ සහතික සත්‍යාපනය දුර්වල නොකරයි; console logon RDP සාක්ෂියක් නොවේ.
