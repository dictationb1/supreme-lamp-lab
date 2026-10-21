# Pending application defects (patches for `dictationb1/supreme-lamp`)

These are **upstream application** defects found and proven from source by
this lab. The lab **never** patches the staged application in place: the app
under test is always exactly the commit reported in
`config/app-source.json` / `/api/version`, unchanged. Land these in the
application's own repository (`dictationb1/supreme-lamp`, the authorized
source repository for the observer), then re-pin
`config/app-source.json` to the fixed commit (with its commit-matched
`ui-dist-<sha>.zip` + `.sha256` in the app's `ui-dist` release).

## 1. `supreme-lamp-978a837-logon-status-matches-clobber.patch`

**Endpoint**: `/api/logon-status` in `payloads/ghrdp-server.ps1`
(pinned app `978a8375ee77b392ce11694ccee7722fd6ca4f71`, lines 8465-8468).

**Defect**: the handler reads `$Matches[1]` *after* the user filter's
`-notmatch`:

```powershell
if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
$connected = $true
$ltSeen = [string]$Matches[1]
```

Per Microsoft `about_Comparison_Operators`, `-notmatch` **overwrites
`$Matches` whenever it detects a match** (it returns `$false` in that case).
The user filter has no capture group, so `$Matches[1]` is gone by the time
it is read: with any user filter supplied - and one always is, because the
route falls back to the config's `rdpUser` when the query omits `user` -
**`logonType` is always `''`**, even for a genuine LogonType 10 event.
`connected` / `ts` / `sourceIp` / `user` are set correctly from the matched
event.

**Impact**: the app cannot report the logon type of the very event it
matched. The lab therefore proves the type from the app's own independent
XML-parsing collector (`/api/native-status` `rdpListener.authLast`,
`Get-RdpLogonEventFields`) **correlated at the same event instant**, and
never infers a type from a remote IP (see `scripts/lib/logon.js`). With
this patch landed and the pin updated, the endpoint's own `logonType`
becomes the direct proof and the correlation fallback goes quiet.

**Fix** (the patch, 2 lines): save the capture before the user filter.

**Status**: PENDING APPLICATION DEFECT - not applied to the staged app
(SHA `978a837` is reported unchanged). To land it in
`dictationb1/supreme-lamp`:

```bash
cd supreme-lamp && git checkout -b fix-logon-status-matches-clobber
git apply supreme-lamp-lab/patches/supreme-lamp-978a837-logon-status-matches-clobber.patch
# add/adjust a regression around Get-RdpLogonEventFields-style parsing, commit, push, open PR
```

After merge: publish `ui-dist-<newsha>.zip` + `.sha256` for the new commit
(the lab's staging rule requires a commit-matched bundle), then set
`config/app-source.json` `sha` to that commit here and re-run the full
verification. Until then the lab keeps exercising the pinned build and
reports `logonType=''` honestly.
