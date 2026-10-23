# RDP Mission Control — ධාවනය 40022345749 (attempt 1) මනින ලද රෝග විනිශ්චය, අලුත්වැඩියා සහ භාරදීම

**අදාළ යෙදුම් මූලාශ්‍රය:** `dictationb1/supreme-lamp` @ `e432d3df4cf00a8528d574f8410f6a76e590db31`
**ධාවනය:** https://github.com/dictationb1/supreme-lamp/actions/runs/40022345749 (attempt 1, job `120650561622`, `rdp`)
**පරීක්ෂා කළ වේලාව:** 2026-10-23 21:15Z – 22:00Z
**LAB ශාඛාව:** `arena/455b72d3-supreme-lamp-lab` · **PR:** https://github.com/dictationb1/supreme-lamp-lab/pull/26

මෙම ලේඛනය මෙම සැසියේ සත්‍ය වශයෙන් ධාවනය කළ දේ පමණක් වාර්තා කරයි. කිසිදු
hostname, credential, telemetry, readiness හෝ PASS ප්‍රතිඵලයක් නිර්මාණය නොකර ඇත.

---

## 1. විනිශ්චය (verdicts)

| ක්ෂේත්‍රය | තීරණය | පදනම |
| --- | --- | --- |
| **LAB_HARNESS** | **PASS** | `mc-signal/v1` සංඥාව සැබෑ ලැබ් ධාවනයකින් අත්පත් කරගෙන, අනන්‍යතාව `RUN_*` ලෙස පරීක්ෂා කර, කේතාංකය මතකයේ විවෘත කරගෙන `ORIGIN_DISCOVERED` ලබා ගන්නා ලදී. ලැබ් පරීක්ෂණ 224 (216 pass / 0 fail / 8 skip). සාක්ෂි දැන් repository එකටම ප්‍රකාශිතයි (artifact නොවේ). |
| **LIVE_ORIGIN_APPLICATION** | **FAIL** | `http://100.99.208.107:7331` TCP පිළිගනී, 15.06 s සහ 20 s තුළ HTTP පිළිතුරු **ශුන්‍ය** (curl exit 28 / code 000). එම ධාවනයේම 7332 port එක 0.72 s තුළ HTTP 404 ලෙස පිළිතුරු දෙයි. |
| **PATCHED_APPLICATION_CANDIDATE** | **PASS (BLOCKED controls සමඟ)** | patch 0001 පිරිසිදුව යෙදේ; යෙදුමේම පරීක්ෂණ 1375/1375 සමත්; සැබෑ Windows client VM මත headed browser එකක පැච් කළ bundle එක ධාවනය කර පාලන මනින ලදී (පහත §6). |
| **UPSTREAM_DEPLOYMENT** | **NOT_RUN** | යෙදුම් repository එක මෙම සැසියේ read-only. කිසිවක් push/merge/deploy නොකළේය. |
| **AUTOMATIC_APPLICATION_ORIGIN_INTEGRATION** | **PARTIAL** | මානව සහායකින් තොරව සංඥාව සොයාගැනීම + අනන්‍යතා සත්‍යාපනය + claim සාර්ථකයි. නමුත් default branch (`main`) හි cron sweep එක තවමත් `mc-signal/v1` කියවන්නේ නැති නිසා `NO_LIVE_ORIGIN (…:LOG_UNAVAILABLE)` ලෙස අවසන් වේ — එය PR #24/#26 merge වනතුරු එසේම වේ. |

---

## 2. පළමු සැබෑ හේතුව සහ එහි ප්‍රතිවිපාක දාමය

**පළමු හේතුව (මනින ලද): Mission Control dashboard endpoint එක (7331) TCP සම්බන්ධතා පිළිගෙනත් HTTP පිළිතුරක් නොදෙයි.**

```
21:20:38Z  readiness: READINESS_TIMEOUT after 240s against http://100.99.208.107:7331
21:20:38Z  net preflight: tcp reachable=True;  http /api/ping code=000 curlExit=28
           tailscale backend=Running selfOnline=True peerFound=True peerOnline=True
           desk=rdp-lab-client tailnetIPv4=100.93.94.15
21:31:50Z  (දෙවන මිනුම, වෙනත් ලැබ් ධාවනයක්)
           port 7331: code=000 (exit=28, 15060ms, ACCEPTED_NO_HTTP)
           port 7332: code=404 (exit=0,     721ms, ANSWERING)
```

එයින් පහළට ඇති සියල්ල මෙම එක් කරුණෙන් පැන නගී:

| පියවර | තත්ත්වය | සාක්ෂිය |
| --- | --- | --- |
| UI HTML | පෙර සේවා කළ නිසා browser එකේ පෙනී තිබුණි (“/v2” තනි ගොනුවකි) | MC-SIGNAL: `ui.bytes=1269742`, `stamped=true`, `matchesRunSha=true` |
| `/api/config` | පිළිතුරු නැත → `creds.fqdn` නැත → UI තුළ `(not set)` | ඔපරේටර් screenshot + 7331 නිශ්ශබ්ද |
| `/api/native-status` | පිළිතුරු නැත → `native=null` → `listenerOkFlag=false`, `runnerDnsOk=false` | ඉහත මිනුම් |
| AUTO-LOGIN බොත්තම | disabled; හේතු ලෙස “FQDN/user validation failed; runner tailnet IP did not resolve; RDP LISTENER not all green” | screenshot + පහත APP-02 |
| WEB DESKTOP / File Explorer | URL නැත / host නැත (“No runner host published yet”) | එකම මූලය |
| Search / Transfers | “No search run yet” / “Queue idle” — මේවා සැබෑ හිස් තත්ත්ව (දෝෂ නොවේ) | source: `searchStore`, fetch queue |

**එබැවින් “Live” යනු තත්ත්ව මිනුමක් නොවේ.** එය `AppShell` හි `wsLive` (WebSocket
විවෘත ද) යන්නෙන් පමණක් පැමිණේ. `/api/*` කිසිවක් පිළිතුරු නොදෙන විටත් එය කොළ පැහැයෙන්
“Live” ලෙස පෙනේ — එය මෙම සැසියේ නිවැරදි කළ දෙයකි (§4).

---

## 3. UI → frontend → API → backend → තත්ත්වය (දත්ත රේඛාව)

සම්පූර්ණ වගුව `data-lineage.csv` හි ඇත. සාරාංශය:

| UI ක්ෂේත්‍රය | frontend | ඉල්ලීම | backend | නිරීක්ෂිත අගය |
| --- | --- | --- | --- | --- |
| FQDN `(not set)` | `sessionStore.setConfig` | `GET /api/config?key=` | `ghrdp-server.ps1` /api/config (Test-CredsAllowed) | නැත (401/නිශ්ශබ්ද) |
| AUTO-LOGIN හේතු 3 | `PrimaryActions.autoOk` | `GET /api/native-status?key=` | /api/native-status | මනින ලද අගයක් නොවේ — හිස් default |
| WEB DESKTOP URL | `WebDesktopCard` | `GET /api/native-status` | `webdeskUrl` ක්ෂේත්‍රය | නැත |
| File Explorer host | `FileExplorer` | `GET /api/native-status` | `runnerResolvedIP` | නැත |
| Topbar “Live” | `AppShell` + `telemetryStore.wsLive` | `/ws` | /ws upgrade | socket පමණි |

**මූලාශ්‍රයෙන් තහවුරු වූ තාක්ෂණික ලක්ෂණය:** `src/lib/api.ts` හි `getJson()` සියලු
අසාර්ථකතා (401, 403, ජාල දෝෂය, JSON නොවන 200) එකම `null` බවට හරවයි. එබැවින් UI ට
“ඉල්ලීම ප්‍රතික්ෂේප විය” සහ “සේවාදායකය කියන දේ හිස්” අතර වෙනස දැනගත නොහැක.

---

## 4. අලුත්වැඩියාව — patch `0001-F201-probe-honesty`

| ගොනුව | වෙනස |
| --- | --- |
| `src/lib/api.ts` | `probeJson()` — HTTP තත්ත්වය සහ `unauthorized/forbidden/http/transport/schema` වර්ගය රඳවා ගනී |
| `src/hooks/useDashboardPolling.ts` | සෑම මිනුමකම ප්‍රතිඵලය `setProbe()` මගින් සටහන් කරයි |
| `src/stores/sessionStore.ts` | `probes.{config,native} = {state,status,at}` |
| `src/components/domain/PrimaryActions.tsx` | විශ්වාසදායක (200) පිළිතුරක් නැත්නම් අක්තපත්‍ර/DNS/listener චෝදනා නොකර, සැබෑ හේතුව සහ නිවැරදි කිරීම පෙන්වයි |
| `src/components/layout/AppShell.tsx` | දත්ත නොමැති විට `Live` නොව `Data unavailable` (danger) |
| `src/i18n/en.json`, `si.json` | නව පණිවිඩ දෙභාෂාවෙන්ම |
| `src/tests/smoke/f201-probe-honesty.test.tsx` | නව පරීක්ෂණ 8 |

### පෙර/පසු සාක්ෂිය (offline, පුනරාවර්තනය කළ හැක)

`evidence/repro-f201.test.tsx` යනු **දෝෂය විස්තර කරන** පරීක්ෂණයකි:

* නොපැච් කළ `e432d3d` මත → **PASS** (එනම් චෝදනා තුනම තිබුණි, “refused” පණිවිඩයක් නොතිබුණි)
* පැච් කළ ගස මත → **FAIL** (චෝදනා තුන නැත)
* `f201-probe-honesty.test.tsx` → **8/8 PASS**

---

## 5. LAB_HARNESS අලුත්වැඩියා (මෙම සැසියේ මනින ලද)

| # | දෝෂය | අලුත්වැඩියාව | සාක්ෂිය |
| --- | --- | --- | --- |
| H-01 | default branch discovery එකට `mc-signal/v1` කියවිය නොහැකි විය → `NO_LIVE_ORIGIN (40022345749/1:LOG_UNAVAILABLE)` | PR #24 හි කියවන්නා (conflict-free ලෙස මෙම ශාඛාවට) + පරීක්ෂණ 4 කට්ටල | lab run 40026969350: `signal key … round-trip proven`, `discover: verified: ORIGIN_DISCOVERED` |
| H-02 | artifact ZIP සහ step log `blob.core.windows.net` / `results-receiver…` වෙත redirect වී **EOF** → සාක්ෂි කියවිය නොහැක | `scripts/publish-evidence.js` — sanitized වාර්තාව ශාඛාවටම ප්‍රකාශයට පත් කරයි (රහස් තහනම්, idempotent) | run 40026969350: `2 file(s) published …:reports/mission-control/40022345749-1/evidence` |
| H-03 | “TCP open, no HTTP” කුමන සේවාවද යන්න නොකීවේ | port දෙකේම මාර්ග 7ක් 15 s සීමාවෙන් වර්ග කර `listeners.json` | `7331 ACCEPTED_NO_HTTP`, `7332 ANSWERING` |
| H-04 | `capability-check` හි මිනිත්තු 25 client job එක සෑම push එකකදීම එකම desktop එකට | `capability-run` label අවශ්‍ය කෙරිණි | run 40026969358 client job එක desktop එක ගත් අයුරු |
| H-05 | සාක්ෂි publish කළේ මිනිත්තු 15 viewer hold එකට පසුව | publish step එක live step එකට පසුව, hold එකට පෙරට | `workflow-ownership-regressions` පරීක්ෂණ |
| H-06 | `workflow_dispatch` → 403 | ලේබල් මගින් trigger කිරීම (`live-verify`, `candidate-run`) | `gh workflow run … 403` |

---

## 6. පැච් කළ යෙදුම (candidate) — build සහ සැබෑ browser මත මිනුම

* **මූලාශ්‍ර පදනම:** `e432d3d` (codeload zip) + patch 0001
* **පරීක්ෂණ:** යෙදුමේම suite — **1375 / 1375 pass** (පදනම 1367 + නව 8)
* **build:** `npx vite build` → `ui/dist/index.html` (single-file). සජීවී ලෙස සේවා කළ bundle එක 1,269,742 B; පැච් කළ bundle එක **CANDIDATE_BUNDLE_BYTES** B, sha256 `CANDIDATE_BUNDLE_SHA`.
* **ධාවනය:** සැබෑ Windows client VM (`rdp-lab-client`, `WIN-NFU1JG4VESE\User`, session 1) මත headed Chromium, `127.0.0.1:7331`.
* **backend:** `scripts/candidate/stub-server.js` — **ලැබ් stub එකකි (යෙදුමේ සේවාදායකය නොවේ)**. එය මනින ලද තත්ත්ව තුනක් නිරූපණය කරයි: `refuse` (401), `empty` (200 {}), `healthy` (සම්පූර්ණ, කොළ පැහැති listener).

**ප්‍රතිඵල:** `candidate/control-coverage.csv` සහ `candidate/candidate-report.json`.

CANDIDATE_RESULTS_TABLE

**BLOCKED (සත්‍ය පූර්ව අවශ්‍යතා නොමැති නිසා — PASS ලෙස නොගැණේ):**
Sessions, Connections connect, Keys reveal, File Explorer browse, Mirror,
Telemetry samples, Health service checks, Collector run, සහ native RDP logon —
මේවාට යෙදුමේ සැබෑ backend එක අවශ්‍යයි; සජීවී origin එකේ එය පිළිතුරු නොදෙයි.

---

## 7. සජීවී origin එකේ UI පාලන — මොනවාද සත්‍ය වශයෙන් මැනිය හැකි වූයේ

`control-coverage.csv` හි `live-origin` පේළි බලන්න. සත්‍ය තත්ත්වය:

* **මැනිය හැකි වූයේ:** run/sha/build අනන්‍යතාව (MC-SIGNAL + GitHub run API),
  endpoint එකේ ජාල/සේවා තත්ත්වය, ලැබ්-පැත්තේ discovery සහ claim.
* **මැනිය නොහැකි වූයේ:** UI එකේ කිසිදු පාලනයක් (button, form, tab) — මක්නිසාද
  dashboard එක HTTP පිළිතුරු නොදෙන බැවිනි. ඒවා `NOT_RUN` ලෙසම වාර්තා වේ;
  screenshot එකක් හෝ HTTP 200ක් මතින් PASS ලෙස නොසළකන ලදී.

---

## 8. නැවත ධාවනය කරන ආකාරය (clean clone replay)

```bash
git clone https://github.com/dictationb1/supreme-lamp-lab.git
cd supreme-lamp-lab && git checkout <PINNED_LAB_COMMIT>
cd reports/mission-control/40022345749-1
bash verify.sh          # checksums + series + required files
bash reproduce.sh       # downloads e432d3d, applies patch 0001 into ./out
cd out/supreme-lamp-e432d3d… && npm ci && npx vitest run      # 1375 pass
```

ලැබ් පරීක්ෂණ: `node scripts/run-regressions.js` → 224 (216 pass / 0 fail / 8 skip).

---

## 9. නොවිසඳුන / ඉතිරි කටයුතු

1. **7331 listener එක නතර වූයේ ඇයිද යන්න ලැබ් එකට දැකිය නොහැක** (එය යෙදුම් ධාවනයේ
   තාවකාලික host එකකි). මනින ලද මායිම: TCP පිළිගැනීම + HTTP ශුන්‍ය.
2. **AUTH පරීක්ෂණ (401/403/forged/superseded):** `NOT_RUN` — backend පිළිතුරු නොදෙන බැවින්.
   මෙම සැසියේ authorization තත්ත්වයක් ගැන කිසිදු නිගමනයක් නොකෙරේ.
3. **Native RDP සහ Web Desktop:** `NOT_RUN` — ticket mint කළ නොහැකි විය; type-10 4624
   සහසම්බන්ධයක් නොමැති බැවින් “සම්බන්ධ විය” යැයි නොකියමු.
4. **`Live` chip එකේ සම්පූර්ණ නිර්මාණය** (socket සහ දත්ත වෙන් කිරීම) — patch 0001
   worst-state රීතිය නිවැරදි කරයි; සම්පූර්ණ නැවත නිර්මාණය product තීරණයකි.
5. **`endpoint.primary` එකට පමණක් වීම** — APP-03; යෝජනාව: publish කිරීමට පෙර
   `/health` ට පිළිතුරු දුන් port එක සංඥාවට ඇතුළත් කරන්න.

---

## 10. ඔපරේටර් කළ යුතු දේ (හරියටම දෙකක්)

1. යෙදුම් ධාවනය තුළ **7331 dashboard listener එක නැවත අරඹන්න / පරීක්ෂා කරන්න.**
   එය පිළිතුරු දෙන තුරු කිසිදු සජීවී UI පාලනයක් පරීක්ෂා කළ නොහැක; BLOCKED හැර
   වෙනත් අවංක තීරණයක් නොමැත.
2. **PR #26 merge කර** default branch sweep එකට `mc-signal/v1` කියවීම ලබා දෙන්න
   (එසේ නොමැති නම් ස්වයංක්‍රීය සොයාගැනීම තවදුරටත් `LOG_UNAVAILABLE` ලෙස අසාර්ථක වේ).

---

## 11. ස්ථිර සබැඳි සහ checksums

* මෙම ෆෝල්ඩරය (pinned): `PINNED_FOLDER_URL`
* `manifest.json`: `PINNED_MANIFEST_URL`
* `MAIN-REPOSITORY-HANDOFF.md`: `PINNED_HANDOFF_URL`
* සම්පූර්ණ ZIP: `PINNED_ZIP_URL`
* `SHA256SUMS`: `PINNED_SUMS_URL`

Checksums සත්‍යාපනය: `sha256sum -c SHA256SUMS` (මෙම ෆෝල්ඩරය තුළ).
