# Pending application defects (patches for `dictationb1/supreme-lamp`)

These are **upstream application** defects found and proven from source by
this lab. The lab **never** patches the staged application in place: the app
under test is always exactly the commit reported in
`config/app-source.json` / `/api/version`, unchanged. Land these in the
application's own repository (`dictationb1/supreme-lamp`, the authorized
source repository for the observer), then re-pin
`config/app-source.json` to the fixed commit (with its commit-matched
`ui-dist-<sha>.zip` + `.sha256` in the app's `ui-dist` release).

---

## 1. `logon-status` `$Matches` clobber — **STATUS: PENDING (writes unavailable)**

**Endpoint**: `/api/logon-status` in `payloads/ghrdp-server.ps1`
(pinned app `978a8375ee77b392ce11694ccee7722fd6ca4f71`, lines 8465-8468).
Still present on `supreme-lamp` `main` at `daf13685` — the only commits after
the pin are `docs/status.json` updates, so the payload is byte-identical.

**Defect**: the handler reads `$Matches[1]` *after* the user filter's
`-notmatch`:

```powershell
if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
$connected = $true
$ltSeen = [string]$Matches[1]
```

Per Microsoft `about_Comparison_Operators`, `-notmatch` **populates `$Matches`
whenever the pattern matches** (it returns `$false` in that case). The user
filter is a scalar `-notmatch` with no capture group, so it replaces the type
capture with a hashtable that only has key `0`. With any user filter supplied —
and one always is, because the route falls back to the config's `rdpUser` when
the query omits `user` — **`logonType` is always `''`**, even for a genuine
LogonType 10 event. `connected` / `ts` / `sourceIp` / `user` are set correctly.

**Impact**: the endpoint cannot report the logon type of the very event it
matched. The lab therefore proves the type from the app's own independent
XML-parsing collector (`/api/native-status` `rdpListener.authLast`,
`Get-RdpLogonEventFields`) **correlated at the same event instant**, and never
infers a type from a remote IP (see `scripts/lib/logon.js`). With this patch
landed and the pin updated, the endpoint's own `logonType` becomes the direct
proof and the correlation fallback goes quiet.

**Files here**

| file | what it is |
|---|---|
| `supreme-lamp-978a837-logon-status-matches-clobber.patch` | the 2-line payload fix |
| `supreme-lamp-logon-status-matches-clobber.test.patch` | the regression test, as a patch (path `tests/…`) |
| `supreme-lamp-logon-status-matches-clobber.test.js` | the same test as a plain file (for a manual copy) |
| `supreme-lamp-APP-MAIN-logon-status-matches-clobber.patch` | **the same fix re-cut against current `main` (`daf13685`)** — use this one for a new PR; the 978a837 patch stays for the standalone pin |
| `vendor/ghrdp-server.ps1` + `vendor/.basis-sha` | the exact bytes of `payloads/ghrdp-server.ps1` at the recorded application revision, so "applies cleanly" is a re-runnable fact rather than a claim |
| `live-run-app-integration.json` | machine-readable manifest of every application-side change this task delivers, with the reason each one is a patch instead of a merged fix |

**Applied and tested locally (not merged — see "Why it is still pending")**

```bash
git clone https://github.com/dictationb1/supreme-lamp && cd supreme-lamp
git checkout -b fix-logon-status-matches-clobber origin/main
git apply /path/to/supreme-lamp-lab/patches/supreme-lamp-978a837-logon-status-matches-clobber.patch
git apply /path/to/supreme-lamp-lab/patches/supreme-lamp-logon-status-matches-clobber.test.patch
node --test tests/f-logon-status-matches-clobber.test.js
```

Measured result: the payload patch applies cleanly (`Applied patch
payloads/ghrdp-server.ps1 cleanly.`); the test gives **3/3 pass with the fix**
and **2/3 fail against the unpatched file** (checked by restoring the original
`payloads/ghrdp-server.ps1` and re-running), so the test really gates the
defect rather than restating the fix. The test runs automatically in the app's
existing `launch-gates.yml` step `node --test tests/*.test.js` — no workflow
edit is needed.

**Why it is still pending**: this session's GitHub credential can read the
application repository but **cannot write to it**. Both paths were refused:

```
$ git push origin arena/44280da4-supreme-lamp:arena/44280da4-supreme-lamp
remote: Permission to dictationb1/supreme-lamp.git denied to dictationb1.
fatal: unable to access 'https://github.com/dictationb1/supreme-lamp.git/': The requested URL returned error: 403

$ gh api -X POST repos/dictationb1/supreme-lamp/git/refs -f ref=... -f sha=daf13685...
{"message":"Resource not accessible by integration", ... "status":"403"}
```

So no app branch, PR or commit exists for this fix. **The observer defect is
NOT fixed**; the lab's correlated cross-check is a verifier-side workaround,
not a repair, and the run evidence keeps reporting `logonType=''` honestly.

**To finish it** (a credential with write on `dictationb1/supreme-lamp`):

1. apply the two patches on a `fix/logon-status-matches-clobber` branch, open a PR;
2. let `launch-gates` (and the repo's other required checks) pass;
3. merge, then publish the commit-matched UI bundle:
   `workflow_dispatch` → **F59 build-ui** with `ref: <merge sha>` (this change
   does not touch `src/**`, so the `push` trigger will not fire by itself);
4. re-pin `config/app-source.json` `sha` to the merge commit **and confirm the
   `ui-dist-<sha>.zip` + `.sha256` assets exist**;
5. re-run the full verification and require `rdp_auto_login` to prove type 10
   *directly* from the endpoint (`proof=direct`), not via correlation.

Until step 4 is done the lab keeps exercising `978a837` and reporting
`logonType=''` honestly.


---

## 2. Live-run handoff (the application must self-advertise) — **STATUS: PENDING (writes unavailable)**

**Defect**: `main.yml` publishes the authenticated Mission Control URL into the job
summary and then keeps the server alive for 5h30 — but it never tells the lab. So
no independent verification can start automatically while the host still exists.
A `workflow_run`-style "the run finished" trigger cannot substitute for it: by then
the ephemeral runner is destroyed.

**Delivered here**

| file | what it is |
|---|---|
| `app-live-run-signal.snippet.yml` | the five steps, correctly indented for insertion inside the `rdp` job |
| `apply-live-run-signal.js` | anchor-based applier + checker (`--repo <app checkout> [--write]`) |
| `vendor/main.yml` | the exact bytes of `.github/workflows/main.yml` at `daf13685` (the basis the applier was tested against) |

**Why not a `.patch`**: `main.yml` is ~7.3k lines and shifts with every merged PR.
A line-number diff would rot within days and could land in the wrong job. The
applier refuses to write unless both anchors occur exactly once, the insertion
point lies between them, the handoff is not already present (idempotent), and the
result passes its structural checks. Measured on the vendored basis:

```bash
node patches/apply-live-run-signal.js --repo ../supreme-lamp            # WOULD_APPLY (159 lines)
node patches/apply-live-run-signal.js --repo ../supreme-lamp --write    # APPLIED
```
After applying, the `rdp` job step order is
`Service Readiness Check (Pre-Keepalive)` → `Prepare the live-run handoff` →
`Signal the verification lab (live run)` → `Upload the live-run credential
envelope (retention 1 day)` → `Wake the lab workflow (best effort)` →
`Await the lab verdict (bounded)` → `Keep-alive 5h30`, and the file still parses as
a workflow with 72 steps in `rdp` (67 before). The applier was run against a copy of
the application checkout; the repository itself was restored afterwards, unchanged
(`git status --porcelain` = empty).

**One-time prerequisite this needs**: a `LAB_RUN_RECORDS_TOKEN` repository secret in
the application repository (contents: write on this repository's `run-records`
branch) so the origin can publish its queue record. The wake-up dispatch and the
record publish are both best-effort by design: without them the lab's scheduled
sweep still serves the run, and the report states exactly which half was missing.
No secret value ever appears in a log, a summary, a dispatch input or `status.json`.

**What is NOT claimed**: no application run has been observed self-advertising,
because these steps are not in the application repository. Any end-to-end statement
before they are merged is out of scope for this patch bundle.
