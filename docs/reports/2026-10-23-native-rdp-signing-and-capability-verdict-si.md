# Native RDP අත්සන්/විශ්වාස පථය සහ capability verdict — 2026-10-23

මෙම වාර්තාව **මනින ලද** කරුණු පමණක් වෙන් කර දක්වයි. ප්‍රතිඵල තුනක් වෙන් වශයෙන්:

| තත්ත්වය | කුමක්ද | සාක්ෂිය |
| --- | --- | --- |
| **VERIFIED** | අත්සන් කළ `.rdp` එකකින් native RDP + Web Desktop, per-run අතුරු මුහුණතක් හෝ security review එකක් නැතිව | workflow `capability-check` ධාවනය **39879458404** — capabilities 9ම PASS, `verdict=VERIFIED` |
| **VERIFIED** | `.rdp` අත්සන් කිරීම + එක් අනන්‍යතාවකට පමණක් සීමා වූ thumbprint විශ්වාසය | workflow `rdp-signing` ධාවනය **39878430536** — bootstrap + probe PASS |
| **BLOCKED_EXTERNAL** | යෙදුමේ (application) පැත්ත: `checks: write`, publisher step, `LAB_SIGNAL_PUBKEY` variable | ලියන API/`git push` 403 — §5 |
| **NOT_VERIFIED** | සැබෑ `main.yml` `mode=rdp` ධාවනයක් ස්වයංක්‍රීයව සොයාගැනීම (end-to-end) | එවැනි ධාවනයක් මෙම වාරයේ නිපදවිය නොහැකි විය |

## 1. මනින ලද ධාවන matrix

| ධාවනය | event | head | ප්‍රතිඵලය | සටහන |
| --- | --- | --- | --- | --- |
| 39878430536 | `pull_request` | `e2859e6a` | success | `rdp-signing` — identity reuse + `value-plain` pin + probe PASS |
| 39879458347 | `pull_request` | `ebc24ff6` | success | `live-run` candidate gate (read-only, pre-merge) |
| **39879458404** | `pull_request` | `ebc24ff6` | **success** | `capability` — jobs: static, server, client, report; skipped: live-origin guard, auth-diagnostic |
| 39878430491 / 39877716229 | `pull_request` | කලින් SHAs | success | `live-run` candidate gate |

`39879458404` හි job කාලසටහන (UTC): static 00:40:33→00:49:10 · server 00:49:14→00:55:18 · client 00:49:14→00:54:52 · report 00:55:21→00:55:30.

**Verdict annotation (report job):**
`verdict=VERIFIED browser_synthetic=PASS native_screenshot=PASS backend_readiness_server_local=PASS dashboard_server_local=PASS tailnet_connectivity=PASS backend_readiness_remote=PASS dashboard_client=PASS web_desktop=PASS rdp_auto_login=PASS`

Regression: Windows client job `170 tests: 170 passed, 0 failed, 0 skipped`; static job (Linux) `170 tests: 162 passed, 0 failed, 8 skipped` (browser e2e Windows-only 8ක් skip).

## 2. `rdp_auto_login` / `web_desktop` සඳහා නිශ්චිත සාක්ෂි

* client annotation: `rdp file signing: signed slab-lab.rdp with 7434A62F998EC25ECF899848AEC0881959B7BAA0 (Valid, sha256)`.
* dialog polls (1→4): කිසිදු poll එකක `kind=rdp_file_security_review` නැත; window title `slab-lab - 100.119.156.11 - Remote Desktop Connection` (එනම් සෘජු සැසිය, review dialog නැත).
* server annotation (LogonType සෘජු සාක්ෂිය): `4624 type=10 user=runnervmdaln5\slabrdp src=100.93.94.15 rec=585144 @2026-10-23T00:53:23.1043904Z` — නව, දුරස්ථ-අන්තර්ක්‍රියාකාරී logon, **explicit LogonType 10** (console type 2 වෙනුවට).
* TS channel එකේ එම අවස්ථාවේම session events: `LocalSessionManager/Operational/21,22,24` — `user=runnervmdaln5\slabrdp sess=1 addr=100.93.94.15`.
* `web_desktop=PASS` සහ `dashboard_client=PASS` එකම ධාවනයේ; backend `sha=978a8375ee77b392ce11694ccee7722fd6ca4f71`, `pid=3484`, `port=7331`, UI build `978a8375ee77` (`meta[name=ghrdp-build]` + `#ghrdpBuild[data-build]`).

මෙය **අත්සන්/විශ්වාස පථයේ** සාක්ෂියකි. එය **application `mode=rdp` ධාවනයක** සාක්ෂියක් නොවේ: server job එකේ annotation එකම කියයි —
`Provisioning=standalone: backend=slab-srv-39879458404-1 account=slabrdp (lab secret) - NOT an application main run; for that use live-run.yml`.

## 3. ස්ථාපිත කළ අනන්‍යතාව සහ policy shape (rollback සමඟ)

| අංගය | මනින ලද අගය |
| --- | --- |
| Signing identity | `7434A62F998EC25ECF899848AEC0881959B7BAA0`, `CN=supreme-lamp RDP file signing (lab client)`, notAfter `2028-10-23T00:09:01Z` |
| Key store | `Cert:\CurrentUser\My` (runner account `WIN-NFU1JG4VESE\User`) — `LocalMachine\My` පමණක් වූ විට `rdpsign` `0x80092004` |
| Public cert | `Cert:\LocalMachine\Root` — එක් thumbprint එකකට පමණි |
| Policy | `TrustedCertThumbprints` REG_SZ (SHA-256, 64 hex) `HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services` — `value-plain` |
| ADMX | `admxPolicyFound=True` නමුත් `admxKey=""`, `valuePrefix=""` (මෙම VM හි ADMX template එකෙන් key එකක් නොලැබේ) |
| Rollback | `powershell -File scripts\ps\Initialize-RdpFileSigning.ps1 -Mode Rollback` |

විස්තරය සහ අතුරු-ඵල දෙක (BOM, Status crash) — `RUNBOOK.md` §2.5.

## 4. නිවැරදි කළ දෝෂ (A–D) සහ ඒවා සනාථ කළ ධාවන

| # | දෝෂය | තත්ත්වය | සාක්ෂිය |
| --- | --- | --- | --- |
| A | CRLF-සංවේදී concurrency regression (`scripts/test/origin-discovery-regressions.js`) | **ස්ථිර** | Linux static 170/162/0/8, Windows 170/170/0/0 |
| B | Windows LIVE VERIFICATION step එකේ `LAB_SIGNAL_PRIVATE_KEY` නොතිබීම | **ස්ථිර** | `.github/workflows/live-run.yml:525-538` — step env එකේ දැන් key එක ඇත; candidate gate එක `signal-status` ධාවනය කරයි |
| C | `public-log` ලෙස වැරදි transport වාර්තා කිරීම | **ස්ථිර** | `--origin-transport auto` (`live-run.yml:554+`), alias `public-log→auto` (`scripts/live-run.js:131-138`) |
| D | Native RDP per-connection security review | **ස්ථිර හා මනින ලද** | ධාවන 39878430536 (probe) + 39879458404 (capability) |

## 5. BLOCKED_EXTERNAL — යෙදුම් පැත්ත (නිශ්චිතව)

මෙම පරිසරයේ token එකට යෙදුම් repo එකේ ලිවීමට අවසර නැත. නැවත-නොඋත්සාහ කළ යුතු, මනින ලද ප්‍රතික්ෂේප:

* `git push origin arena/probe-write-test-app` (app repo) → **403 `Permission to dictationb1/supreme-lamp.git denied to dictationb1`**;
* `gh workflow run live-run.yml` (lab repo පවා) → **403 Resource not accessible by integration** (`.../actions/workflows/391835993/dispatches`);
* `GET .../actions/secrets`, `.../actions/variables`, `.../actions/runners` (repo දෙකේම) → **403**.

එබැවින් මේවා **කළ නොහැකි** විය (කේත දෝෂ නොවේ):

1. යෙදුමේ `.github/workflows/main.yml` එකට `checks: write` එකතු කිරීම (පවතින `contents/actions/pages/id-token` ඉවත් නොකර);
2. publisher step (`patches/app-live-signal-publisher.js` → `scripts/live-signal-publisher.js`) backend ආරම්භයෙන් පසු, keep-alive ට පෙර ඇතුළත් කිරීම;
3. `/api/logon-status` `$Matches` clobber patch එක යෙදීම (patch + test `patches/` තුළ සූදානම්; fix සමඟ 3/3 pass, නොපෙරළන ලද ගොනුව සමඟ 2/3 fail);
4. `mode=rdp` සහිත සැබෑ ධාවනයක් dispatch කිරීම;
5. `LAB_SIGNAL_PUBKEY` variable එකේ පැවැත්ම/ගැළපීම API එකෙන් තහවුරු කිරීම (කියවීම 403).

`LAB_SIGNAL_PRIVATE_KEY` secret එක lab repo එකේ **පවතීද යන්න මෙම පරිසරයෙන් තහවුරු කළ නොහැක**; එය candidate gate එකේ `signal-status` පියවරෙන් (ධාවනයේදී, key එක නොපෙන්වා fingerprint පමණක්) තහවුරු වේ. එය ප්‍රකාශ නොකළ තත්ත්වයකි — එබැවින් "key එක සකසා ඇත" ලෙස මෙහි නොලියැවේ.

## 6. Transport සහ latency (මනින ලද දේ / නොමනින ලද දේ)

* **මනින ලද**: public check-run `output.summary` එකෙන් `MC-SIGNAL v1` envelope එක සජීවීව කියවා decrypt කිරීම — **ප්‍රමාදය තත්පර 12** (ධාවනය 39810624203, publisher job එවිටත් `in_progress`). Key එක plaintext ලෙස කිසිම තැනක නොතිබිණි.
* **Fallback**: cron `*/10` → **තත්පර 600ක්** දක්වා ප්‍රමාදය. මෙය "immediate" නොවේ; event-driven wake-up (`repository_dispatch: mission-control.live-run`) යෙදුමෙන් එවිය යුතුය — එය යෙදුම් පැත්තේ 403 නිසා **මනින ලද නැත**.
* Viewer ආයුෂ: `keep_viewer_open_minutes` — දැන් `workflow_dispatch` default `'15'`, `0` = වහාම වැසේ; job එක `inputs.*` මත රඳා පවතින බව (`schedule`/`pull_request` ධාවනවලදී 0) එහිම සටහන් වේ.
* Publisher skip වූ ධාවනයක් සාර්ථක ලෙස නොගැනේ: publisher නැති විට path එක `SIGNAL_NO_PRIVATE_KEY` → log fallback ලෙස **පැහැදිලිව** වාර්තා වේ.

## 7. Not verified (ප්‍රකාශ නොකරන දේ)

* සැබෑ application `main.yml` `mode=rdp` ධාවනයක් ස්වයංක්‍රීයව සොයාගැනීම සහ එහි current credentials වලින් UI විවෘත කිරීම — යෙදුම් පැත්ත නොසැලසුම් නිසා **NOT_VERIFIED**.
* දෙවන ස්වාධීන ධාවනයක් ස්වයංක්‍රීයව සාර්ථක වීම; cancellation/expiry/superseded අවස්ථා — **NOT_VERIFIED** (ඒවාට සජීවී යෙදුම් ධාවන අවශ්‍යයි).
* Standalone staging pin: `config/app-source.json` = `978a8375ee77…` (app main `daf13685…` නොවේ) — හේතුව ගොනුවේම ලියා ඇත: `daf1368` සතුව commit-matched `ui-dist-<sha>.zip` නැති නිසා `Stage-F60UiBundle` එය ප්‍රතික්ෂේප කරයි; වෙනස `docs/status.json` පමණි.

## 8. මෙහෙයුම්කරුගේ ඊළඟ පියවර (යෙදුම් repo එකට ලිවීමට අවසර ඇති අයෙක්)

1. `patches/app-live-signal-publisher.js` → `scripts/live-signal-publisher.js`; `main.yml` permissions වලට `checks: write` (පවතින ඒවා රඳවා); publisher step එක backend start ට පසු, keep-alive ට පෙර; `LAB_SIGNAL_PUBKEY` variable එක (Actions variable).
2. `/api/logon-status` patch + test එක යෙදීම.
3. `mode=rdp` සමඟ `main.yml` dispatch කිරීම; ඉන්පසු ලැබ් sweep එක තත්පර 600ක් තුළ එය අල්ලාගනී (හෝ `repository_dispatch` — තත්පර 12ක් මනින ලද path එක).
4. එම ධාවනය `VERIFIED` ලෙස පිළිගැනීමට නම්: `discover` → `claim` → client VM → `report` සියල්ල සාර්ථක වී, `verdict=VERIFIED` annotation එකේ capabilities 9ම PASS විය යුතුය. Publisher skip වූවා නම් එය VERIFIED නොවේ.
