# Mission Control අලුත්වැඩියා බණ්ඩලය — ධාවනය 40072158991 (R2 අලුත්වැඩියාව)

මෙය `dictationb1/supreme-lamp-lab` රසායනාගාරයේ නව සැසියකින් සකස් කළ, නැවත ධාවනය කළ
හැකි (replayable) සම්පූර්ණ බණ්ඩලයකි. යෙදුමේ දුරස්ථ ගබඩාව (remote) මෙම සැසියේ
කියවීමට-පමණක් (read-only) වේ; එයට කිසිදු push/deploy/setting වෙනසක් සිදු නොවේ.

- පරීක්ෂා කළ යෙදුම් සංශෝධනය: `832a82eb7c29613b0b101585c56b5011ea008a06`
  (මව් සංශෝධනය `4a91c5c2…`; නව කමිටුව වෙනස් කරන්නේ `docs/status.json` පමණි.)
- යෙදුම් zip හැෂ් (sha256): `c0de6455046c896d8cd61e8671d566a29c2aaa4aa946fd4cd4c791d1ca2d2393`
- ලැබ් ශාඛාව: `arena/25db7e16-supreme-lamp-lab` (PR #28 හි සම්පිණ්ඩිත වැඩ c7a0bf6… සිට ඉදිරියට).

## 1. ශීතල වීමට (freeze) හේතුව සහ සාක්ෂි

`payloads/ghrdp-server.ps1` සේවාදායකය පිළිගැනීමේ ලූපය (accept loop) තනි නූලකි
(single thread). එය සෑම සම්බන්ධතාවයක්ම සමමුහුර්තව (synchronously) හසුරුවයි:

```powershell
while ($listener.Pending()) {
    $client = $listener.AcceptTcpClient()
    if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
}
```

`GET /ws` ඉල්ලීම `Invoke-F99WebSocketUpgrade` දිගු-කාලීන පොම්පයක් (තත්පර 1800 දක්වා)
ලෙස එම නූලේම ධාවනය කරයි. එබැවින් එක් WebSocket එකක් විවෘත වූ සැණින් `/health`,
`/api/config`, `/api/progress`, බොත්තම් POST ආදී සියලුම සාමාන්‍ය HTTP ඉල්ලීම්
TCP පෝලිමේ සිර වේ. එය හරියටම උපකරණ පුවරුවේ දුටු stale "Live" ලාංඡනය, හිස්
FQDN/පරිශීලක/IP, අක්‍රිය බොත්තම් සහ "Launch unavailable" තත්ත්වයට හේතුවයි —
එය වෙනම UI දෝෂ රැසක් නොව එක් transport-starvation දෝෂයකි (R2).

සාක්ෂි: පෙර සත්‍ය Windows ධාවනය `40068292422`හිදී එක් සත්‍යාපිත `/ws` සම්බන්ධතාවයක්
නිසා `/health` මිලි තත්පර ~5000කින් කල් ඉකුත් වූ අතර, තත්පර 16.5කට පසුවත් යථා
තත්ත්වයට නොපැමිණියේය (මූලික සහ R1-පමණක් අපේක්ෂක දෙකේම). ධාවනය `40063545799`
බ්‍රවුසරය විවෘත කළ සැණින් මිනිත්තු 26කට අධිකව සිර විය.

## 2. R2 අලුත්වැඩියාව (0003)

කුඩාම ආරක්ෂිත වෙනස තෝරා ඇත — සම්පූර්ණ concurrency නැවත-ලිවීමක් නොවේ:

- දිගු-කාලීන `/ws` පොම්පය පමණක් වෙනම **bounded runspace pool** එකකට යවනු ලැබේ;
  සාමාන්‍ය HTTP සියල්ල පෙර මෙන් තනි accept නූලේම පවතී. එමගින් පවතින සියලුම
  `$script:` ටිකට්/credential/cache/revocation තත්ත්වවල තනි-නූල් ආරක්ෂාව නොවෙනස්ව
  පවතී (එක්-භාවිත ටිකට් එකක් දෙවරක් පරිභෝජනය විය නොහැක).
- `System.Threading.SemaphoreSlim` අවහිර-නොවන `Wait(0)` සම්බන්ධතා සීමාවක්
  (පෙරනිමිය 16, `GHRDP_WS_MAX_CLIENTS` මගින් 4..64ට සීමිත) කරයි. සීමාව ඉක්මවූ
  විට ක්ෂණික, පුරෝකථනය කළ හැකි `503` පිළිතුරක් ලැබේ; accept නූල කිසිදා නවතින්නේ
  නැත.
- worker runspace එකකට ලැබෙන්නේ පොම්පයට අවශ්‍ය කුඩා ශ්‍රිත මතුපිට පමණි
  (ආශ්‍රිත ශ්‍රිත 4ක්, F99 සුසරක 3ක්, audit මාර්ගය/lock). එය ටිකට් ගබඩාවට හෝ
  credential ලෙජරයට ළඟා නොවේ. dash token එක සම්බන්ධතාවයකට බැගින් පරීක්ෂා වේ.
- සියලුම audit ලිවීම් එක් shared `Monitor` lock එකකින් අනුක්‍රමික වේ.
- සොකට්/stream/semaphore/runspace සෑම මාර්ගයකම `finally` තුළ වැසේ; accept ලූපයේ
  reaper එකක් නිමි PowerShell handle ඉවත් කරයි; shutdown එකේදී pool සහ semaphore
  dispose වේ.
- WebSocket කිසිදා අක්‍රිය නොකරන අතර `ws=false` ව්‍යාජ අගයක් ද නොදේ.
- `GHRDP_WS_*` env සුසරක පෙරනිමි අගයන් (20/90/1800) නොවෙනස්ව තබයි; ඒවා යොදන්නේ
  රසායනාගාර කාල-සීමිත පරීක්ෂණ සඳහා පමණි.

## 3. සත්‍යාපන තත්ත්ව (කාණ්ඩ අනුව)

| කාණ්ඩය | තත්ත්ව | සටහන |
|---|---|---|
| LAB_HARNESS | PASS | සත්කාරක(regression) 235 pass / 0 fail / 8 skip; ws-frame + R2 ව්‍යුහ පරීක්ෂණ ක්‍රියාත්මක |
| PATCHED_APPLICATION_CANDIDATE | Windows නැවත-සනාථ කිරීම බලාපොරොත්තුවෙන් | smoke 1389/1389 + Windows step-7 22/22 PASS; build OK. **සත්‍ය Windows මැනුම (ධාවනය 40084261133): accept-loop starvation මැකී ඇත, සත්‍ය HTTP 101 උත්ශ්‍රේණි දැන් සිදුවේ, r2/backend පාලන 4ක් PASS (HTTP කිසිදා නොනවතී). PS-runtime දෝෂ තුනක් VM හිදී හමුවී නිවැරදි කර ඇත: (1) PS 5.1 `[powershell]::Create(runspacePool)` overload MethodException → `Create()` + `.RunspacePool=`; (2) request handler ගේ පිටත finally එක async worker ගේ socket එක 101ට පෙර වැසීම (ECONNRESET) → `$r2Dispatched` හිමිකාර-මාරු ආරක්ෂකය; (3) F99 පොම්පය දත්ත රහිත peer-viyojanයක් (EOF) නොදැකීම නිසා worker-slot කාන්දුව → `Socket.Poll(SelectRead)` ජීවන-පරීක්ෂාව. තුන්වන නිවැරදි කිරීමේ VM නැවත-සනාථ කිරීම ඊළඟ ධාවනයේදී ලැබිය යුතුය.** |
| LIVE_ORIGIN_APPLICATION | OBSERVED (in_progress, read-only) | ධාවනය 40072158991 නිරීක්ෂණය පමණි; වෙනස් නොකෙරේ |
| UPSTREAM_DEPLOYMENT | NOT_RUN | application remote read-only; deploy කිරීමක් නැත |
| AUTOMATIC_APPLICATION_ORIGIN_INTEGRATION | ව්‍යුහාත්මකව PASS / සජීව අන්ත ලක්ෂ්‍යය VM-bound | ධාවනය 40072158991 හි MC-SIGNAL check-run දැන් සජීවීව ප්‍රකාශිතයි (step 60 සාර්ථක); AAD ගුප්ත-බන්ධනය නිවැරදියි. tailnet අන්ත ලක්ෂ්‍යය (100.85.153.77:7331) sandbox එකෙන් ළඟා විය නොහැක (off-tailnet connect timeout) — විකේතනය/සජීව UI සත්‍යාපනය VM මත පමණි |
| NATIVE_RDP / WEB_DESKTOP | BLOCKED | වෙනම lab-owned Windows application server + LogonType 10 සාක්ෂි අවශ්‍යයි; කිසිදා ව්‍යාජ PASS නොවේ |

සත්කාරක (hosted) සංඛ්‍යාලේඛන: යෙදුම් smoke 108 ගොනු / 1389 පරීක්ෂණ (1378 පෙර + 11 නව R2);
ලැබ් regression 243කින් 235ක් PASS, 8ක් optional-browser skip.

### 3.1 සත්‍ය Windows මැනුමෙන් හමුවූ දෝෂය (ධාවනය 40078279249) — වංචනික PASS නැත

- පැරණි (pristine) සේවාදායකය එක් සත්‍ය `/ws` සම්බන්ධතාවයකදී `/health` මිලි තත්පර 5011ක්
  අවහිර කරයි (stall 4615ms) — R2 දෝෂය නැවත නිපදවයි. පැච් කළ සේවාදායකය එය 826ms දක්වා අඩු
  කරයි; සාමාන්‍ය HTTP කිසිදා නොනවතී (මධ්‍යනය 23–54ms). එනම් runspace වෙත ගෙනයාමේ ගෘහ නිර්මාණය
  (architecture) starvation යාන්ත්‍රණය මකා දමයි.
- නමුත් දැන් **සෑම** `/ws` උත්ශ්‍රේණියකටම `503` ලැබේ — ධාරිතාව 8ක gate එකක පළමු
  සම්බන්ධතාවය පවා ප්‍රතික්ෂේප වේ (`held=0, rejected=9`). මෙය නීත්‍යානුකූල saturation එකක් විය
  නොහැක. අන්තර්ගත 503 මාර්ග දෙකක් තිබේ: (අ) ප්‍රවේශ gate `Wait(0)` අසමත් වීම, හෝ (ආ) worker
  dispatch (`BeginInvoke`) විසි කිරීම. පෙර harness එක පිළිතුරු-සිරුර (body) ඉවත දැමූ බැවින්
  නිවැරදි මාර්ගය වෙන්කර හඳුනා ගැනීමට නොහැකි විය.
- රෝග-විනිශ්චය එක් කළ ධාවනය (40081193119) මගින් නිශ්චිත හේතුව හමුවිය:
  `System.Management.Automation.MethodException — Cannot find an overload for "Create"
  and the argument count "1"`. PS 5.1 `[powershell]` ත්වරකය (accelerator) ස්ථිතික
  `Create(RunspacePool)` එක- argument overload එක බැඳින්නේ නැත. `gate FAULT`/`saturated`
  රේඛා කිසිවක් නොතිබීම සහ `avail=8` වීමෙන් semaphore ප්‍රවේශය සහ pool නිරෝගී බව සනාථ වේ;
  බිඳෙන්නේ worker PowerShell සෑදීමේ පේළිය පමණි.
- පළමු නිවැරදි කිරීම: පරාමිති-රහිත `[powershell]::Create()` භාවිතා කර, සැකසිය හැකි
  `RunspacePool` ගුණාංගය හරහා pool එක පවරනු ලැබේ (PS 5.1 සහ PS 7 දෙකටම ගැළපේ). එමගින් 503/
  MethodException රේඛා මුළුමනින් මැකී ගියේය.
- නමුත් ධාවනය 40082655039 හිදී දෙවන වෙනස් දෝෂයක් මතු විය: 101ට පෙර සෑම සම්බන්ධතාවක්ම
  `ECONNRESET`. හේතුව — `Invoke-ClientRequest` ගේ පිටත `try/finally` එක සෑම `return` එකකදීම
  stream එක dispose කර client එක වසයි. async `/ws` dispatcher එක ක්ෂණිකව ආපසු එන බැවින්,
  worker එක 101 ලිවීමට පෙර එම finally එක socket එක වසා දැමීය (පැරණි inline පොම්පය try තුළම
  අවහිර වූ බැවින් එය මෙම ගැටලුවට මුහුණ දුන්නේ නැත).
- දෙවන නිවැරදි කිරීම (0003, දැන් 509 පේළි): `/ws` ශාඛාවේ `$r2Dispatched = $true` හිමිකාර-
  මාරු ධජයක් සකසා, පිටත cleanup එක `if (-not $r2Dispatched)` මගින් ආරක්ෂා කරයි; socket එක
  වසන/dispose කරන/ගේට්ටුව මුදන එකම හිමිකරු worker ගේ `finally` වේ. පෙර හිස් `catch {}` වෙනුවට
  `[LAB-R2] worker EXCEPTION` ලොගයක් එක් කර ඇත. දසවන ස්ථිතික පරීක්ෂණය මෙම ආරක්ෂකය අගුලු දමයි.
- පිරිසිදු replay (දෙවන නිවැරදි කිරීමෙන් පසුව): r2 10/10 (LF + CRLF), smoke 21/21,
  සම්පූර්ණ suite 1388/1388, build OK.
- evaluate gate එක සෑම දෝෂයක්ම නිවැරදිව FAIL ලෙස සලකුණු කළේය; R2 acceptance PASS ලෙස කිසි විටෙක
  උඩඟු ලෙස ප්‍රකාශ නොවේ. නිවැරදි-නොකළ builds වල මුල් matrix පේළි FAIL/BLOCKED ලෙස
  අවංකව සුරැකී ඇත.

### 3.2 ධාවනය 40084261133 — පළමු නිවැරදි දෙක තහවුරු විය; තුන්වන දෝෂයක් (slot කාන්දුව) හමුවිය

- head `a1d98f1` මත සත්‍ය Windows VM හි **පළමු දෝෂ දෙකම සනාථ විය**: සත්‍ය HTTP 101
  උත්ශ්‍රේණි දැන් සිදුවේ; `backend.ws_accept_loop_block`, `r2.no_ws_control_health`,
  `r2.one_ws_health_responsive`, `r2.multi_ws_health_and_config` යන පාලන සතරම PASS
  (5/5 සමගාමී උත්ශ්‍රේණි, /health උපරිමය 88ms, සාමාන්‍ය HTTP කිසිදා නොනවතී).
- නමුත් **තුන්වන වෙනස් දෝෂයක් — worker-slot කාන්දුවක්** — හමුවිය: ධාරිතාව 8ක gate එක
  සජීවී socket 3–5ක් තිබියදීම `count=0 avail=0` දක්වා හිස් විය (`held=3 rejected=6`,
  සියල්ල 503 `"websocket capacity exhausted; retry"`; sanitized stdout හි එවැනි පේළි 18ක්;
  `ws closed` හෝ `worker EXCEPTION` පේළි ශුන්‍යයි; චක්‍ර 5/10 පමණක් සමත්, process handles
  886→913 (+27), threads 34→34; reconnect/frames/idle/malformed පාලන FAIL හෝ BLOCKED;
  headed browser `real.browser_ws_*` තුනම FAIL — browser අදියරට පෙර pool එක හිස් වී තිබුණි).
- හේතුව: F99 පොම්පය `NetworkStream.Read` කැඳවන්නේ `Available > 0` හෝ `DataAvailable`
  විට පමණි. බෆරගත දත්ත නොමැතිව peer එකක් විසන්ධි වුවහොත් Read කිසිදා කැඳවෙන්නේ නැත;
  EOF (`Read` → 0) ශාඛාව ළඟා විය නොහැකි වී, worker එක idle-timeout එක දක්වා නිදාගෙන
  සිටිමින් තම semaphore slot එක රඳවා ගනී — විසි කිරීමක් (throw) නොමැති නිහඬ කාන්දුවකි.
- තුන්වන නිවැරදි කිරීම (0003, දැන් 537 පේළි): සෑම පොම්ප-පුනරාවර්තනයකම මුදුනේ නොඅවහිර
  `$Client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead)` ජීවන-පරීක්ෂණයක්;
  Poll සත්‍ය සහ `Available -eq 0` නම් peer FIN/reset ලෙස අර්ථ දැක්වී, පවතින worker
  `finally` වෙත break වේ (socket වැසීම, dispose, gate `Release()`, reaper එක runspace
  handle එක දැමීම). විවෘත-නිෂ්ක්‍රීය socket එකක පැරණි හැසිරීම නොවෙනස් ය; `Socket.Poll`
  .NET Framework (PS 5.1) සහ .NET (PS 7) දෙකටම ඇත; ධාරිතාව/කාල-සීමා කිසිවක් වෙනස් නොවේ.
- එකොළොස්වන ස්ථිතික පරීක්ෂණය Poll+SelectRead රටාව අගුලු දමයි (LF සහ CRLF දෙකේම 11/11).
  වත්මන් පිරිසිදු replay: r2 11/11, smoke 22/22, සම්පූර්ණ suite 1389/1389, build OK.
- **R2 සම්පූර්ණ PASS නොවේ.** ඊළඟ VM ධාවනය මේවා පෙන්විය යුතුය: socket 8ක් රඳවා 9වැන්න
  පමණක් 503 වීම, සත්‍ය frames/echo, server-side idle expiry, පිරිසිදු reconnect,
  handle වර්ධනයක් නැති 10/10 චක්‍ර, සහ headed `real.browser_ws_*` තුනම PASS.
  සියලු ධාවනවල සත්‍ය මැනුම් `control-coverage.csv` හි අවංකව සුරැකී ඇත.

## 4. පිරිසිදු නැවත-ධාවනය (clean replay)

```bash
# අඛණ්ඩතාව + patch අදාළත්වය (build නැතුව)
bash reports/mission-control/40072158991-1/verify-bundle.sh
# සම්පූර්ණ replay (pnpm install + smoke + production build)
REPLAY=1 bash reports/mission-control/40072158991-1/verify-bundle.sh
```

බණ්ඩලයේ `series.txt` අනුව පැච් 0001→0002→0003 අනුපිළිවෙලට යොදන්න.
`SHA256SUMS` මගින් සෑම ගොනුවකම අඛණ්ඩතාව පරීක්ෂා කළ හැකිය.

## 5. ඉතිරිව ඇති ක්‍රියාකාරකම්

1. `real-backend-run` label සහිත PR මගින් සත්‍ය Windows VM හි R2 matrix ධාවනය
   සම්පූර්ණ කර, `evidence/real-backend-*` ප්‍රකාශනය මත පදනම්ව මෙම README හි
   Windows තත්ත්ව යාවත්කාලීන කිරීම.
2. සම්පූර්ණ RDP candidate serverයක් (සත්‍ය test ගිණුම, listener, launcher,
   Web Desktop, capture) වෙනම lab-owned serverයක provision කර native RDP +
   Web Desktop LogonType 10 සාක්ෂි ලබා ගැනීම.
3. යෙදුම්-පමණක් සැසියකදී 0003 upstream වෙත ගෙන යාම (3ම අනුපිළිවෙලට, regression
   රඳවාගෙන). Rollback = 0003 revert පමණි; F201/R1 ස්වාධීනයි.

කිසිදු අවස්ථාවක job SUCCESS එකක් යෙදුම් PASS එකක් ලෙස ගණන් නොගන්න, පැච් කළ lab
candidate එකක් upstream ලෙස ප්‍රකාශ නොකරන්න, සහ අවශ්‍ය පාලන (controls)
පරීක්ෂා නොකර සම්පූර්ණ සත්‍යාපනයක් ප්‍රකාශ නොකරන්න.
