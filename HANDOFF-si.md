# HANDOFF — RDP Mission Control (PR #18 අනුප්‍රාප්තිය) · 2026-10-21

**කියවන්නාට එක වಾಕ්‍යයක්:** කේත කොටස් සම්පූර්ණයි සහ සත්‍යාපනය කර ඇත, **නමුත් lab එක `VERIFIED` නොවේ**. Windows account consent එක තවමත් මිනිසෙකු විසින් ලබා දී නැත; application observer දෝෂය තවමත් **PENDING** (එම repo එකට මෙම session එකට ලිවීමට අවසර නැත).

---

## 1. නවතම මතක තබා ගත යුතු තත්ත්වය (verified, උපකල්පනය නොවේ)

| කරුණ | තත්ත්වය |
|---|---|
| මෙම branch හි කේතය පරීක්ෂා කළ commit | **`913696e`** (run 39605267051) |
| ඉන් පසු commits | `e9c1de5`, `487fdaa` — **docs පමණි**, `[skip ci]` |
| Static gate | **100 tests: 100 passed, 0 failed, 0 skipped** (pwsh 7) |
| Windows client gate (self-hosted) | **100 tests: 100 passed, 0 failed, 0 skipped** (Windows PowerShell **5.1.20348.5756**) |
| Capabilities | 7 PASS · `rdp_auto_login` **BLOCKED** · `web_desktop` **BLOCKED** |
| Verdict | **`NOT_VERIFIED`** — නිවැරදි ප්‍රතිඵලය |
| Unattended acceptance run | **නොපවතී** (bootstrap නිසා සෑදිය නොහැක) |
| Merge කළ PR | **කිසිවක් නැත** (#16–#19 සියල්ල OPEN) |

---

## 2. PR / branch / commit සහ merge තත්ත්වය

| PR | head branch | head commit | base | merge state |
|---|---|---|---|---|
| **#19** (මෙම session) | `arena/44280da4-supreme-lamp-lab` | `487fdaa` (කේතය `913696e`) | `arena/ba4f2d55-supreme-lamp-lab` (#18) | OPEN, MERGEABLE, checks **fail** |
| **#18** | `arena/ba4f2d55-supreme-lamp-lab` | `a22353a` | `arena/efe7639f-supreme-lamp-lab` (#17) | OPEN, UNSTABLE |
| **#17** | `arena/efe7639f-supreme-lamp-lab` | `9b74521` | `arena/f823d76d-supreme-lamp-lab` (#16) | OPEN, UNSTABLE |
| **#16** | `arena/f823d76d-supreme-lamp-lab` | `f45c789` | `main` | OPEN, UNSTABLE |
| application | — | `978a837` (pin) / `main` = `daf13685` | — | PR **නොමැත** (ලිවීමට අවසර නැත) |

* #19 යනු #18 මත යැපෙන, එය අනුගමනය කරන PR එකයි. #18 → #17 → #16 අනුපිළිවෙලට merge කළ යුතුය.
* **මෙම session එකට #18 හි branch එකට ලිවීමට අවසර නැත** (වෙනත් session එකකට අයත්), එබැවින් එකම එක documented repair branch එකක් (`arena/44280da4-…`) භාවිත කර #19 ලෙස ඉදිරිපත් කර ඇත.
* **Merge කිරීමක් සිදු නොවීය.** checks fail වී ඇති (හේතුව: මිනිස් consent) PR එකක් merge කිරීම තහනම් කළ prerequisite එකක් "සම්පූර්ණයි" ලෙස වාර්තා කිරීමක් වනු ඇත.

---

## 3. Bootstrap (RDP-file consent) — **තවම අවශ්‍යයි**

### 3.1 තහවුරු කළ සත්‍ය
* run **39598371464** (`a22353a`) හි `native-rdp-dialog.png` (1024x768, session 1) සහ window enum: `mstsc(...):"Remote Desktop Connection" ["You are opening an RDP file which will establish a connection to anoth" "OK" "Cancel"]` → checkbox **unchecked**, OK **disabled**.
* run **39605267051** (`913696e`) හි නැවතත් එම තත්ත්වයම: `rdp_file_consent`, `mstsc pid=7196`, `OK is disabled`.
* පරිගණක ගිණුම නැවත තහවුරු කළා: `rdp-lab-client WIN-NFU1JG4VESE\User session=1 PS=5.1.20348.5756` (13:13Z). **මෙම ගිණුම සහ session 1** සඳහා පමණක් consent අදාළයි.

### 3.2 මේ branch එකේ අලුතින් හදා ඇති දේ
1. **bounded SETUP mode** (`workflow_dispatch` → `mode=consent-setup`, `setup_timeout_ms` ≤ 900000, step timeout 16 min). මෙය **SETUP** ලෙස පමණක් ලේබල් වේ; `scripts/setup-summary.js` → `verdict: NO_VERDICT_SETUP_MODE`. SETUP run එකක් කිසිදා `VERIFIED` විය නොහැක.
2. `scripts/rdp-consent-setup.js` — production-shaped `.rdp` (UTF-8/no-BOM, CRLF, 17 directives, read-back) ලියා **එම production launch path** එකෙන්ම `mstsc.exe` වෙත භාර දෙයි; dialog එක **කියවයි** පමණි (screenshot එකක් ගනී), **කවදාවත් click කරන්නේ නැත**.
3. `scripts/lib/consent-state.js` — සත්‍යවශයෙන්ම වෙනස් කරයි:
   * `PENDING_CONSENT` (dialog එක තිබේ)
   * `CONSENT_DIALOG_CLEARED` (dialog එක ගොස්, mstsc ජීවත්)
   * `SESSION_CONNECTED` (dialog එක ගොස් **සහ** session window එකක්)
   * `CONSENT_DIALOG_CLOSED_UNCONFIRMED` (**Cancel** එකත් dialog එක එකම විදියට වහනවා → සාක්ෂියක් නොවේ)
   * `NO_DIALOG_SEEN` (දෙකෙන් එකක් විය හැක → සාක්ෂියක් නොවේ)
   * `BLOCKED_SECURITY_REVIEW` / `BLOCKED_CERTIFICATE_WARNING` / `BLOCKED_CREDENTIALS_PROMPT` / `BLOCKED_CONNECTION_ERROR` (අනෙක් dialog පවුල් 4 වෙන් වෙන්ව)
4. **bootstrap command එක දැන් ආරක්ෂිතව ධාවනය කළ හැක**: `scripts/lib/rdp-target.js` placeholder (`<server-ip>`, `${…}`, `%…%`, `TODO`), loopback, TEST-NET, link-local, URL, CIDR, bare hostname **ප්‍රතික්ෂේප කරයි**; නොදන්නා flag එකක් → exit 64 (කලින් typo එකක් නිශ්ශබ්දව target නැති `.rdp` එකක් හැදුවා). local test: 412 bytes / 17 directives, account + checkout print වේ.
5. `RUNBOOK.md §2.4` සම්පූර්ණයෙන් නැවත ලියා ඇත: CVE-2026-26151 (MSRC + NVD, CVSS 7.1, KB ලැයිස්තුව) **සත්‍යාපනය කර** සඳහන් කර ඇත; consent එක සහ per-connection publisher review එක **වෙන් කර** ඇත; නිශ්චිත ගිණුම/session/checkbox/button සහ "setup එක අවසන් වූයේ කෙසේදැයි තහවුරු කරගන්නේ කෙසේද" සඳහන් වේ.

### 3.3 කළ නොහැකි වූ දේ සහ හේතුව
* `gh workflow run capability-check.yml … -f mode=consent-setup` →
  `could not create workflow dispatch event: HTTP 403: Resource not accessible by integration`
  **එබැවින් මෙම session එකට SETUP window එක විවෘත කළ නොහැක.** SETUP mode එක unit-tested සහ mode-gating එක live ලෙස තහවුරු විය (`mode=full` run එකේ SETUP step එක **skipped** ලෙස නිවැරදිව පෙනුණි), නමුත් end-to-end ධාවනයක් තවම සිදු වී නැත.

---

## 4. Application observer දෝෂය — **PENDING (සම්පූර්ණ කර නැත)**

### 4.1 දෝෂය (source එකෙන් තහවුරු කළා)
`payloads/ghrdp-server.ps1` (`978a837`, lines 8465-8468), `/api/logon-status`:

```powershell
if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
$connected = $true
$ltSeen = [string]$Matches[1]      # මෙතනදී ප්‍රමාද වැඩියි
```

`-notmatch` එකක් pattern එක **match වූ** විට `$Matches` **නැවත ලියයි**; user filter එකේ capture group එකක් නැති නිසා `$Matches[1]` = `$null`. user filter එක සැමවිටම යෙදේ (config `rdpUser` fallback). එබැවින් **tip 10 සත්‍ය logon එකක් වුවත් `logonType` = `''`**.

### 4.2 PowerShell එකෙන් **ඔප්පු කළා** (අනුමානයක් නොවේ)
`scripts/run-regressions.js` හි නව test එක "app defect: -notmatch clobbers $Matches before LogonType is read (real PowerShell)" — order දෙකම පැත්තෙන් පැත්තට ධාවනය කරයි:

| පරිසරය | ප්‍රතිඵලය |
|---|---|
| pwsh 7 (ubuntu static job) | buggy order → `''`, patched order → `'10'` · **100/100 pass** |
| **Windows PowerShell 5.1.20348.5756** (production shell) | එලෙසම · **100/100 pass** |

> මුල් CI run (39604893843) එකේ මගේ **test harness** එකේ දෝෂයක් නිසා fail විය (PowerShell single-quoted string `\r\n\t` interpret කරන්නේ නැත). එය නිවැරදි කර නැවත ධාවනය කළා. එය claim එකේ දෝෂයක් නොවේ; වාර්තාවේ එලෙසම සඳහන් වේ.

### 4.3 fix එක සහ test එක — lab repo එකේ patch ලෙස
* `patches/supreme-lamp-978a837-logon-status-matches-clobber.patch` (2 පේළිය) — cleanly applies (`Applied patch … cleanly`).
* `patches/supreme-lamp-logon-status-matches-clobber.test.patch` + `.test.js` — **fix සමඟ 3/3 pass, නොපෙරළන ලද ගොනුව සමඟ 2/3 fail** (එනම් test එක සැබවින්ම gate එකක්).

### 4.4 ඇයි තවම PENDING
`dictationb1/supreme-lamp` සඳහා මෙම credential එකට **ලිවීමට අවසර නැත**:

```
git push → remote: Permission to dictationb1/supreme-lamp.git denied to dictationb1. (HTTP 403)
gh api POST /git/refs → {"message":"Resource not accessible by integration","status":403}
```

**එබැවින් observer දෝෂය නිවැරදි කර නැත.** lab හි same-instant XML correlation එක verifier-side workaround එකක් පමණි. staged app හි bytes කිසිවක් වෙනස් නොකළා — `978a837` ලෙසම වාර්තා වේ.

---

## 5. Logon acceptance contract audit (`scripts/lib/logon.js`)

හමු වූ සැබෑ පරතරයන් සහ නිවැරදි කිරීම්:

| අවශ්‍යතාව | පෙර | දැන් |
|---|---|---|
| නියමිත user identity | user echo **නොමැති** විටත් පිළිගැනිණි | echo එක **අනිවාර්යයි**; හිස්/වෙනත් echo → `not-observed` |
| attempt time window | යටි සීමාව පමණයි | දෙපැත්තම bounded (baseline + 30 min) |
| cross-check සම්බන්ධ කිරීම | වෙනත් ගිණුමක same-instant event එකකින් confirm විය හැකි විය | `contradicted`; collector ගිණුම වාර්තා නොකරන්නේ නම් එය **පැහැදිලිව කියයි** |

වෙනස් නොවූ (හා තහවුරු කළ) නීති: LogonType 10 **remote IP එකකින් ව්‍යුත්පන්න නොකරයි**; stale type-2 හෝ අදාළ නොවන `authLast` පිළිගැනීම නොකරයි; events දෙකක් එකතු කර success එකක් සෑදිය නොහැක.
**Application endpoint නිවැරදි භාවය සහ සැබෑ RDP session සාක්ෂිය වෙන් වෙන්ව** වාර්තා වේ.

---

## 6. Runs, attempts, SHAs සහ ප්‍රතිඵල

| run | head | attempt | ප්‍රතිඵලය |
|---|---|---|---|
| [39594245349](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/39594245349) | `1af4044` | 1 | failure — මුල් dialog classification calibration |
| [39596760458](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/39596760458) | `8c6e01d` | 1 | failure — consent නිවැරදිව classify කළ පළමු run |
| [39598371464](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/39598371464) | `a22353a` | 1 | failure — **`NOT_VERIFIED`** (7 PASS, 2 BLOCKED), gates 92/92 + 92/92 |
| [39604893843](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/39604893843) | `438c385` | 1 | failure — static gate: මගේ test harness දෝෂය (client/server skipped) |
| [39605267051](https://github.com/dictationb1/supreme-lamp-lab/actions/runs/39605267051) | **`913696e`** | 1 | failure — **`NOT_VERIFIED`**, gates **100/100** + **100/100** |

**Regression ගණන් (නවතම, 913696e):** static **100 pass / 0 fail / 0 skip**, client **100 pass / 0 fail / 0 skip**. (පෙර 92; නව tests 8ක් + skip 1ක් යනාදිය platform අනුව ධාවනය වේ.)

**අහෝ! නවතම run එකේ "skip" 0 යැයි පෙන්වන්නේ CI runner දෙකේම pwsh/Chromium තිබූ නිසාය; local Linux sandbox එකේ 8 skip (7 browser + 1 PowerShell) විය.**

### අවසන් වරට ලැබුණු capability ප්‍රතිඵල 9 (run 39605267051)

| capability | තත්ත්වය |
|---|---|
| `browser_synthetic` | **PASS** |
| `native_screenshot` | **PASS** |
| `backend_readiness_server_local` | **PASS** |
| `dashboard_server_local` | **PASS** |
| `tailnet_connectivity` | **PASS** (`100.102.112.105`, peer online) |
| `backend_readiness_remote` | **PASS** |
| `dashboard_client` | **PASS** (build `978a8375ee77`, 1366x820) |
| `rdp_auto_login` | **BLOCKED** — `RDP_FILE_CONSENT_REQUIRED` |
| `web_desktop` | **BLOCKED** — `DEPENDS_ON_RDP_SESSION` |

---

## 7. "Manual interaction රහිත" සාක්ෂිය — **නොපවතී**

* ඉහත runs වල **කිසිදු manual click එකක් හෝ credential entry එකක් සිදු නොවීය** — නමුත් ඒවා කිසිවක් session එකක් දක්වා ගියේ නැති නිසා එය **සාක්ෂියක් නොවේ**.
* **Acceptance run එකක් (9/9 PASS, manual interaction 0) තවම නොපවතී.** එය bootstrap එකෙන් පසුව පමණක් නිපදවිය හැක.
* අතින් click කරන ලද run එකක් **කිසිදා** unattended auto-login සාක්ෂියක් ලෙස භාවිත නොකෙරේ.

---

## 8. Screenshots / diagnostics

Artifacts (Actions UI එකෙන් බාගත හැක; මෙම sandbox එකට blob host එකට ප්‍රවේශය නැත):

* `client-39605267051-1` → `native-rdp-dialog.png` (consent dialog, 1024x768, session 1), `native-desktop.png`, `native-rdp-during.png`, `capabilities-remote.json`, `cleanup-postflight.json`
* `server-39605267051-1` → `rdp-diagnostics.json`, `stage-result.json`, `rdp-target.json`
* `static-39605267051-1`, `verification-report-39605267051-1`
* SETUP mode විවෘත වූ විට: `setup-consent.json` + `setup-consent-dialog.png` (තවම නිපදවා නැත)

> මෙහි උපුටා දක්වන සියලුම සාක්ෂි **check-run annotations API** සහ **repository source** වලින් ලබාගත් ඒවාය; job log blobs (`results-receiver.actions.githubusercontent.com`, Azure blob) මෙම sandbox එකෙන් ළඟා කරගත නොහැකි බව පැහැදිලිව සඳහන් කරමි.

---

## 9. VERIFIED යනු කුමකටද

* **`VERIFIED` යෙදිය හැක්කේ** "unattended run එකක් තුළ capabilities 9ම PASS වූ" පරාසයට පමණි. **එවැනි පරාසයක් තවම නොපවතී.**
* මේ branch එකේ **යන්ත්‍රණය (verifier) නිවැරදි බව** පමණක් demonstrable ලෙස තහවුරු වී ඇත (regressions 100/100, දෙපැත්තේම; mode gating; dialog classification; logon contract).
* **Pending product defects (lab checks pass වුවත් විවෘත):**
  1. application `/api/logon-status` `$Matches` clobber — **not fixed** (writes unavailable);
  2. consent persistence across re-image / වෙනත් profile — **unverified**;
  3. per-connection publisher review (unsigned `.rdp`) — තවම නිරීක්ෂණය නොවූ අවදානමක්; signed-publisher path operator තීරණයක්.

---

## 10. ඊළඟ නිශ්චිත ක්‍රියාව (හරියටම)

1. **GitHub → Actions → "Capability Check Workflow" → Run workflow**
   * Branch: `arena/44280da4-supreme-lamp-lab`
   * `mode`: **`consent-setup`**
   * `setup_timeout_ms`: `600000`
   *(මෙය මෙම session එකට 403 නිසා මා විසින් dispatch කළ නොහැක — ඔබ විසින්ම UI එකෙන් කළ යුතුය.)*
2. Dispatch කළ **මිනිත්තු 7–10කින්** පසු client job log එකේ `account` / `target` පේළි බලන්න; එවිට `WIN-NFU1JG4VESE\User` (session 1) desktop එකේ **"Opening Remote Desktop Connection"** dialog එක පෙනේ.
3. **"I understand and allow RDP files to open on this device for my account"** ✔ කර **OK** ඔබන්න (OK එක ✔ කරන තුරු disabled).
4. SETUP state එක **`CONSENT_DIALOG_CLEARED`** හෝ **`SESSION_CONNECTED`** විය යුතුය. `CONSENT_DIALOG_CLOSED_UNCONFIRMED` (Cancel) හෝ `NO_DIALOG_SEEN` නම් — **සාක්ෂියක් නැත**, නැවත කරන්න.
5. ඉන්පසු **`mode=full`** dispatch කරන්න. **manual click 0, credential entry 0** සහ capabilities **9ම PASS** විය යුතුය. එවිට පමණක් `VERIFIED`.
6. පසුව merge අනුපිළිවෙල: #19 → #18, #18 → #17, **updated #17 verify**, #17 → #16, **updated #16 verify**, #16 → `main`. ඉන්පසු `main` push run එක බලා, අවසර ඇත්නම් එක් manual `workflow_dispatch` full verification එකක්.
7. Application fix සඳහා `dictationb1/supreme-lamp` වෙත **ලිවීමට අවසර ඇති credential** එකක් අවශ්‍යයි: `patches/` දෙක apply → PR → checks → merge → `build-ui` dispatch (`ref: <merge sha>`) → `ui-dist-<sha>.zip` + `.sha256` තහවුරු කර → `config/app-source.json` pin එක එම sha ට යාවත්කාලීන කර → නැවත full verification.

**අවහිර වී ඇති හේතු (කෙටියෙන්):** (a) මිනිස් consent එක — Windows VM එකේ physical/interactive click එකක් අවශ්‍යයි; (b) මෙම session එකට `workflow_dispatch` 403; (c) application repo එකට ලිවීම 403.

---

## 11. Recovery checkpoint

සම්පූර්ණ resume විස්තරය `RECOVERY_CHECKPOINT.md` හි ඇත (branch, PR, commits, සම්පූර්ණ කළ දේ, කළ නොහැකි දේ, ඊළඟ පියවර, evidence pointers).
