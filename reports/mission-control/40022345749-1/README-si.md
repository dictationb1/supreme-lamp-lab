# Mission Control — 40022345749 / attempt 1

## සත්‍යාපිත handoff (2026-10-23)

මෙය PR #26 හි කලින් handoff එකේ අසංගත PASS claims වෙනුවට, pinned source, ලැබුණු Actions/check-run metadata, candidate reports, සහ මෙහි නැවත සිදුකළ isolated build/test වෙන්කර සටහන් කරන නිවැරදි කළ වාර්තාවයි. **App repository එකට push, merge, deploy, secret/settings වෙනස්කිරීමක් කර නැත.** පහත F201 patch එක app repository වෙත නොව, lab repository තුළ patch artifact එකක් ලෙස පමණක් ඇත.

### අවසාන verdicts

| වෙනම verdict එක | තත්ත්වය | හේතුව / සීමාව |
|---|---|---|
| `LAB_HARNESS` | **FAIL** | මෙම branch එකේ signal reader එක legacy `MC-SIGNAL v1` summary token එක පමණක් කියවයි; සැපයූ run එකේ check-run එක `mc-signal/v1` JSON `output.text` තුළ publish කර ඇත. Runner preflight dispatch එකට GitHub API 403 ලැබුණු නිසා මේ සැසියේ client VM assignment/preflight තහවුරු කළ නොහැකි විය. |
| `LIVE_ORIGIN_APPLICATION` | **BLOCKED (no fresh verdict)** | Prior Windows-client bundle reported TCP connect but no HTTP within 15–20 seconds on 7331 and a 240-second readiness timeout. Not remeasured here; listener process ownership was not confirmed. |
| `PATCHED_APPLICATION_CANDIDATE` | **BLOCKED overall** | pinned source එකේ isolated production build PASS, 106 test files / 1,375 tests PASS. නමුත් patched server production startup path, real backend, real headed client VM, හෝ actual browser UX සත්‍යාපනය කළේ නැත. |
| `UPSTREAM_DEPLOYMENT` | **NOT_RUN** | App remote read-only සීමාව පිළිපැද ඇත. |
| `AUTOMATIC_APPLICATION_ORIGIN_INTEGRATION` | **FAIL** | local harness reader සහ actual app signal encoding එක නොගැලපේ. Exact run identity fields ගැළපුණත් check-run freshness timestamp එක අනාගතයට පෙනීම/clock discrepancy නිසා freshness තහවුරු නොවේ; automatic authenticated UI attach එකක් කළේ නැත. |

මෙම verdicts එකිනෙක වෙනුවට භාවිත නොකරන්න. Actions job success එක feature success නොවේ. “Live” signal state එක application/backend connectivity proof එකක් නොවේ.

## ඉල්ලූ run සහ pinned source

- App: `dictationb1/supreme-lamp`, workflow `.github/workflows/main.yml`, run `40022345749`, attempt `1`.
- Run SHA: `e432d3df4cf00a8528d574f8410f6a76e590db31`.
- Run API එක නැවත විමසූ විට run හා signal check-run දෙකම `in_progress` විය; run update timestamp පැරණි අතර check-run publish timestamp clock observation එකට නොගැළපුණි. එබැවින් “දැන් fresh signal” හෝ VM තවමත් සජීවී බව කියා නොසිටිමු.
- Pinned app archive SHA-256: `811a5154f16208877405b18becd31b4a24cd949dfafcd30b35ae2f9908124ea5`.
- GitHub compare API අනුව pin සිට app `main` දක්වා commits 125ක් ඉදිරියෙන් තිබුණද, වෙනස් වූ file එක `docs/status.json` පමණි; UI/server source එක වෙනස් නොවීය. Patch එක pinned app tree එකට පරීක්ෂා කර ඇත; අලුත් archive එකක් මත replay එකක් මෙහි සිදුකර නැත.

## Diagnosis — වෙන්කර තබා ඇති evidence

### Prior live-client evidence (මෙහි fresh measurement නොවේ)

PR #26 snapshot එකේ Windows-client measurements අනුව 7331 TCP connect ලබාගත්තත් HTTP ප්‍රතිචාර නොලැබුණු අතර 7332 HTTP පිළිතුරු දුන්නේය; වෙනත් report එකක readiness 240 s කින් timeout විය. Listener PID/process ownership එම evidence තුළ තහවුරු කර නොමැති නිසා, “7331 හි දැන්ම මෙම app process එකයි” යන නිගමනයක් නොකරමු.

### App source වලින් හඳුනාගත් ප්‍රබල, තවමත් runtime-තහවුරු නොකළ හේතුව

Pinned `payloads/ghrdp-server.ps1` තුළ server එක `TcpListener.Start()` කර `LISTENING` sentinel එක ලියූ පසු, client accept loop එකට යාමට පෙර Security/RDP event-log scan තුන synchronous ලෙස ධාවනය කරයි (`Update-RdpLogonAuthLast`, `Update-RdpConnLog`, `Update-RdpListenerTelescope`). එම loop එක පසුව `AcceptTcpClient()` කරයි. ඒ නිසා kernel-level TCP handshake එකක් ලැබී තිබියදී app එක HTTP bytes කියවීමට/පිළිතුරු දීමට තවමත් event-log scans තුළ රැඳී සිටීම source මට්ටමින් විශ්වාසනීය පැහැදිලි කිරීමකි. `/api/native-status` route එකේද Schannel cache miss එකකදී `Get-F31cSchannelWindow` හරහා `Get-WinEvent` inline විය හැක.

මෙය **source-supported hypothesis**, live process trace එකෙන් තහවුරු කළ root cause එකක් නොවේ. Server worker/thread වෙනසක් Windows VM එකේ replay/latency test නොමැතිව යෙදීමෙන් auth, event evidence, හෝ server lifecycle බිඳිය හැකි නිසා මේ patch set එකට backend rewrite එකක් ඇතුළත් කර නැත. සත්‍යාපනයට අවශ්‍ය වන්නේ process-owner snapshot, startup log timestamps, event-scan durations, `/health` සහ `/api/native-status` request/response timings ය.

## යෙදූ app patch (lab artifact පමණි)

`app-patches/0001-F201-probe-honesty.patch` pinned `e432d3d` UI එකේ `/api/config` සහ `/api/native-status` probe trust state පැහැදිලි කරයි. Probe එක transport/HTTP/schema/authorization මට්ටමේ අසාර්ථක වූ විට UI එක එය credentials, DNS හෝ RDP listener මිනුමක් ලෙස නොපෙන්වයි; පසුගිය සත්‍ය snapshot එකක් තිබේ නම් එය අහෝසි නොකරයි; status trust තහවුරු නොවන විට auto-login gate එක ආරක්ෂිතව disabled තබා blocker එක පෙන්වයි.

- Patch එකට tests 8ක් ඇතුළත්ය; සියල්ල PASS.
- Baseline reproduction test unpatched tree එකේ 1/1 PASS (පැරණි misleading text එක හඳුනා ගත්තේය); patched tree එකේ පැරණි ප්‍රතිඵලයම assert කරන එම test එක expected ලෙස FAIL විය.
- Full pinned-tree suite: **106 files / 1,375 tests PASS**.
- Clean replay production build: PASS; single-file `ui/dist/index.html`, 1,273,547 bytes, SHA-256 `23719b3539ffbb311772fdf1a112016a66f9fc617688c562ed127814d54b5b4a`. Build hash includes the replay's `VITE_BUILD_SHA` value.
- Existing build/test warnings (Vite CJS deprecation, Tailwind invalid theme value, jsdom canvas/React warnings) remained; tests/build still exited successfully.

මෙය **UI data-honesty repair** එකකි; `/7331` HTTP hang එක නිවැරදි කළ බවක් හෝ live backend/real browser success එකක් නොවේ.

## Candidate report එකේ වැදගත් නිවැරදි කිරීම්

PR #26 හි පෙර `healthy-candidate-report.json` එක 14 PASS / 2 FAIL / 9 BLOCKED ලෙසම වාර්තා කරයි. README එකේ candidate success claim එක ඒ ප්‍රතිඵල සමඟ ගැටේ. තවද:

- එම candidate run එක hosted Windows/headless browser මතය; `rdp-lab-client` VM එක නොවේ. VM candidate run එකක් build/patch fetch අදියරේ අසාර්ථක වී තිබේ.
- 11 navigation checks route-specific assertion වෙනුවට page body එක non-empty බව පමණක් පරීක්ෂා කරයි; ඒවා route success ලෙස පිළිගත නොහැක. මෙහි coverage CSV එකේ එම routes `NOT_RUN` ලෙස නැවත වර්ගීකරණය කර ඇත.
- Theme toggle සහ text scale check දෙකම `FAIL` (before/after අගයන් එකම බව report එකේ ඇත).
- Search-with-backend-absent check එක hosted stub context එකේ පමණක් සීමිත UI response; production backend proof නොවේ.
- Candidate screenshot 18ක් contact sheet එකෙන් දෘශ්‍ය පරීක්ෂා කළා. ඒවායේ overlay/modal එක සෑම screen එකකම දිස්වන අතර `theme-toggle-healthy.png` නමින් ඇති එක single state shot එකක් නොව montage එකක් වැනිය. Contact-sheet මට්ටමේ credential පැහැදිලිව කියවිය නොහැකි වුවද, screenshots public evidence ලෙස මෙහි නැවත ප්‍රකාශ නොකළෙමු.
- Candidate workflow Actions success එක source tree, server startup, real VM, හෝ සෑම control එකක්ම PASS බව තහවුරු නොකරයි.

## සුරක්ෂිත redaction

පෙර snapshot හි `data-lineage.csv` සහ `defects/AUTHORIZATION-NOT-RUN.md` තුළ තිබූ query-key patterns 4ටම value-bearing text පොදු report එකට ගෙන නොඑන ලෙස ආරක්ෂිතව සකස් කළා (CSV එකේ 3 locations, markdown එකේ 1). එම original files හෝ candidate screenshots මේ patch bundle එකට පිටපත් කර නැත. Values, URL, ciphertext, key material, cookies, HAR, හෝ authenticated screenshots මෙහි ඇතුළත් නොවේ.

## Coverage පිළිබඳ අවංක සීමාව

`coverage.csv` තුළ පෙර candidate report එකේ controls 25ට අදාළ per-control verdicts නැවත සලකුණු කර ඇත: 11 generic navigation checks `NOT_RUN`; theme/text-scale `FAIL`; stub-only UI checks production evidence ලෙස නොගණන් කරයි. Sessions, connection/RDP, credentials, files, mirror, telemetry, health service probes, collector, native RDP logon සහ Web Desktop වැනි backend-dependent controls `BLOCKED`. Candidate control 25ට අමතරව production-server startup සහ real Web Desktop session අවශ්‍යතා දෙකක්ද වෙනම සටහන් කර ඇත. Native RDP / Web Desktop real-session proof **නැත**. සම්පූර්ණ UI-control inventory හා actual served DOM සත්‍යාපනය නොමැති නිසා coverage 100% නොවේ.

## Replay

Pinned app checkout එකක් සහ patch එක `/` අසල තබා නැවත build/test කිරීම සඳහා `replay-candidate.sh` භාවිත කරන්න. එය app archive SHA verify කර pnpm 9.15.9 lockfile install, patch apply, 8-case F201 regression, full smoke suite සහ production build ධාවනය කරයි. Windows VM, live credentials/backend, candidate UI real-browser sweep හෝ upstream deploy එය **simulation නොකරයි**; ඒවාට වෙනම authorized `main.yml mode=rdp` run අවශ්‍යය.

## ඊළඟ පියවර / external dependency

1. Lab harness එකේ `mc-signal/v1` `output.text` parser/identity/freshness handling එක authorized current branch එකට bounded compare/update ලෙස port කර එහි regression tests ධාවනය කරන්න; success signal එක stale/future timestamp එකෙන් අනුමාන නොකරන්න.
2. App live origin එක `main.yml mode=rdp` run එකකින් fresh ලෙස සක්‍රිය කර, run URL ලබාදෙන්න. VM owner එකක් පමණක් test කළ යුතුය; identity/session/preflight, 7331 port owner, TCP + HTTP `/health`, UI, native-status timings එකම run/attempt/SHA එකට bind කළ යුතුය.
3. Backend startup scan latency repair එක production startup path එකෙන් Windows VM මත පරීක්ෂා කළ පසු පමණක් PASS/FAIL දක්වන්න; Web Desktop/RDP proof එක සැබෑ session/correlation evidence තිබේ නම් පමණක් වාර්තා කරන්න.
