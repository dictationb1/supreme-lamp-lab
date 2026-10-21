# Regression catalogue

Every defect below has a test in `scripts/run-regressions.js` (test name in
quotes). Server-like fixtures run **out of process**
(`scripts/test/fixtures/fake-backend.js`) and every child is awaited
asynchronously, so a blocked event loop can never turn a failure into a pass
(the defect in PR #12's `execSync` fixture). The suite runs on Linux (`static`
job, browser e2e mandatory) and on the Windows client (real Windows process
identity, locks, cleanup).

The safety-critical checks were mutation-tested: each of these deliberate
breakages makes the suite fail — ignoring the run attempt in cleanup, a
recursive (non-atomic) lock `mkdir`, accepting contradictory readiness,
killing on PID reuse, skipping lock-recovery re-verification, lock failure as
warning, accepting non-PASS capabilities in the verdict, and not monitoring
backend liveness.

Live-mode defects 16–22 were found by the suite itself while building the
originating-run handoff (see the section at the end of this file): a required
optional field, an unreachable repository gate, an anchored loopback regex,
advisory masking, an unreadable envelope transport, tailnet rules wrong in both
directions, and source greps that matched their own comments.

| # | defect (where seen) | root cause | test(s) | expected |
|---|---|---|---|---|
| 1 | Web Desktop PASS on any page body (main, PR #11/#13) | `#app \|\| body` selector accepted | "browser e2e mc-check server-local: *", web_desktop contract in `mission-control-check.js` | frame freshness + JPEG + rendered `img#view` required |
| 2 | Readiness OR-chain / "good enough" (PR #10) | partial signals accepted | "readiness: strict contract table", "fixture readiness: contradictory / missing-fields / string-booleans" | `READINESS_CONTRADICTORY` / `READINESS_SCHEMA_INVALID` |
| 3 | Wrong process answering the port | pid never compared | "fixture readiness: wrong-listener…", "supervisor: readiness pid of another process…", "supervisor: port owned by a foreign process…" | `READINESS_WRONG_PROCESS`, `BACKEND_PORT_OWNED_BY_OTHER` |
| 4 | Backend crash hidden / died between steps (#11 run) | unsupervised `Start-Process` | "supervisor: startup crash…", "supervisor: crash while initializing…", "supervisor hold: backend dying during hold is a failure", "supervisor hold: keeps backend alive until the client job completes" | `BACKEND_EXITED*`, `BACKEND_DIED_DURING_HOLD` |
| 5 | "fetch failed" with no cause (run 39537803154) | cause chain dropped | "http: connection refused keeps nested cause…", "fixture readiness: crash-after-ready…", "mc-check CLI: unreachable backend reports the cause chain" | `… <- caused by: … ECONNREFUSED` |
| 6 | Version `dev`/`unknown`/`main.zip` accepted | fallback SHA | "version: exact sha, no dev/unknown fallback", "fixture version: wrong-sha / dev-sha" | `VERSION_SHA_INVALID` / `VERSION_SHA_MISMATCH` |
| 7 | Missing config reported as SKIPPED/PASS | permissive defaults | "mc-check CLI: missing --expect-sha is BLOCKED…", "mc-check CLI: --blocked-reason…" | `BLOCKED` with reason |
| 8 | MOCK / NOT_RUN / SIMULATED counted as success | aggregate too lax | "status: only all-required-PASS is accepted", "report: VERIFIED only when…" | `NOT_VERIFIED` |
| 9 | Later PASS masking first failure | status overwritten | "status: a FAIL is never overwritten by a later PASS" | first cause kept |
| 10 | Lock failure → warn and continue (browser-check) | warning only | "session lock held -> browser-check FAILs both capabilities…" | `FAIL: LOCK_ACQUISITION_FAILED` |
| 11 | Lock not exclusive / stale lock stolen from a live owner | recursive mkdir, no identity | "lock: live holder blocks…", "lock: N concurrent processes x M increments…", "lock: recovery race…", "lock: release by a non-owner handle is refused" | exact counter, no steal |
| 12 | Stale lock never recovered | no owner identity | "lock: dead owner…", "lock: PID reuse…", "lock: owner-less dir…grace period" | `STALE_LOCK_RECOVERED` only when owner provably gone |
| 13 | Registry lost updates / non-atomic copy fallback / corrupt overwrite | unlocked RMW, copy fallback | "registry: 5 concurrent registrations…", "registry: corrupt file is refused and preserved…" | 5 records, no tmp, `REGISTRY_CORRUPT` |
| 14 | Cleanup killed by name / other attempt / PID reuse | no exact identity, run-only scope | "cleanup.decide: …", "cleanup: postflight kills only this run+attempt…", "cleanup: PID-reuse record…" | only exact-identity, in-scope, abandoned processes die |
| 15 | Tailscale 403 with no diagnosis (run 39526409955) | immutable OIDC `sub` vs name-only pattern | "oidc: immutable subject cannot match documented name-only pattern" | recommended subject printed |
| 16 | Peer of another attempt matched | prefix match | "peer: exact hostname / -N suffix…" | exact label only |
| 17 | Screenshot "exists" counted as evidence | no decoding | "image: PNG validation…", "image: JPEG validation…" | truncated/tiny/uniform rejected |
| 18 | Secrets in evidence | no sanitisation | "redact: tokens, auth headers, URL creds, cmdkey /pass" | all masked |
| 19 | PowerShell quoting broke steps | no parse gate | `static` job: `Test-PowerShellSyntax.ps1` over `scripts/**/*.ps1` + extracted workflow `run:` blocks | 0 parse errors |

---

### Defect 8: Windows lock contention starvation and orphaned live-owner locks
- **Trigger**: `lock: 4 concurrent processes x 5 increments = mutual exclusion (no lost update)` on the self-hosted Windows client (`rdp-lab-client`), run 39555536075 attempt 1. `LOCK_ACQUISITION_FAILED` after 60000 ms, stack `scripts/lib/lock.js:120`, holder `run 39555536075/1 role=unknown pid=6712`, directory `%TEMP%\slab-reg-...\t7\state\c.lock.d`.
- **Root cause (source + reproduction)**: `acquireLock()` ran a full `(pid, createTime)` identity query for a live owner on *every* contender poll. On Windows that query spawns `powershell.exe` + CIM (~0.7–3 s under load), so four contenders polling at 5 ms spent the acquisition deadline inside diagnostics instead of waiting on the lock. Independently, `releaseLock()` swallowed the directory-rename error (Windows sharing violation: a peer reading `owner.json`, virus scanner on a fresh file) and returned `false`, which every caller ignored; the releasing process kept running and its *next* acquisition then waited on its own orphaned lock until the deadline. Both defects produce the same observed signature (a live pid in the holder field), so the surviving annotations cannot apportion the original failure between them.
- **Controlled reproduction of both mechanisms** (pre-fix tree `3442e83`, archived with `git archive`, simulated on Linux by injecting the identity-query cost; 4 processes x 5 increments):
  - *Starvation*: the maximum acquisition wait scaled with the per-poll identity query — 700 ms query -> 2147 ms wait, 1500 ms -> 4514 ms, 20000 ms -> **60014 ms**. At the last setting the worker spent its entire 60 000 ms budget in diagnostics, which is the production signature `LOCK_ACQUISITION_FAILED after 60000ms`. The shared counter stayed correct (20/20) in every run: mutual exclusion was never broken, only the deadline.
  - *Orphaned live-owner lock*: every `.lock.d` -> `.released-*` rename was made to fail with `EPERM` (a Windows sharing violation). The pre-fix tree acquired iteration 0, reported a silent release, then blocked iteration 1 on its own orphan and failed at the deadline (`held by run local/1 role=worker-1 pid=<self>`). The fixed tree reported `{released:false, relinquished:true, errorCode:EPERM}` after 152 ms and the next acquisition succeeded in the same process — 344 ms total, exit 0.
  - Neither mechanism is reproducible on the fixed tree, and the production annotations (which carry only a live pid in the holder field) cannot apportion run 39555536075 between them; both are covered by the regressions above.
- **Fix**: cheap `process.kill(pid, 0)` liveness on every poll; identity re-verification retained (throttled, cached, and always applied to stale/foreign owners); bounded release retries with an owner-token-bound `relinquish.json` fallback so peers can take over without weakening the identity check; self-orphan detection; `withLock()` now reports an incomplete release instead of hiding it.
- **Regression tests**: multi-process mutual exclusion with a merged per-worker timeline (3 rounds on Windows, 2 elsewhere); simulated slow identity query (bounded query count and wall clock); injected release-rename failures ⇒ retry + relinquish + takeover by the next process; live holder never stolen even when the lock looks old; crashed owner recovered while an unrelated process survives.
- **Expected verdict**: `PASS`.
- **Time limit**: 60 s per acquisition (unchanged — the timeout is not the fix), whole suite < 8 min on Windows.
- **Evidence files**: `artifacts/run-<id>-<attempt>/lock-timeline.json`, `.../regressions-summary.json`, workflow annotations.

### Defect 9: the tailnet gate reported a guess instead of the actual join error
- **Trigger**: `Join tailnet (workload identity)` failed while the token-exchange probe returned HTTP 200, so the gate asserted an OIDC subject mismatch that was never observed.
- **Observed (run 39557365420 attempt 1)**: token exchange HTTP 200; `tailscaled` reported `unexpected error while creating authkey: Status: 404, Message: "not found"` on `POST /api/v2/tailnet/-/keys`; CLI 1.94.2, service RUNNING, `backendState=NeedsLogin`. The OIDC subject and audience already match.
- **Fix**: capture and annotate the first client error line, record the failed operation/CLI version/service state, and probe the exchanged token's scopes with **read-only** `GET` requests (no keys are created or deleted). New category `CREDENTIAL_CANNOT_CREATE_AUTH_KEYS` (the trust credential is not authorized to mint an auth key) is kept distinct from `TAG_NOT_PERMITTED` (HTTP 400 with a tag message), `MISSING_AUTH_KEYS_PERMISSION` (HTTP 403), `TAILSCALE_SERVICE_NOT_READY` and `CLIENT_VERSION_UNSUPPORTED`.
- **Expected verdict**: reported as `BLOCKED` (external credential configuration), never as a subject mismatch.
- **Evidence files**: `tailnet-diagnostic.json`, `tailnet first error` annotation, `verification-report.json` (`diagnostics.tailnetFirstError`).

### Defect 10: RDP auto-login could never be *observed* (and mstsc may never have connected)
- **Trigger**: run 39560693766 attempt 2 (PR #16 head f45c789, app 978a837): seven capabilities PASS, `rdp_auto_login` FAIL `RDP_LOGON_NOT_OBSERVED: no LogonType 10 for slabrdp from 100.93.94.15 since 2026-10-21T07:59:45.000Z within 90000ms`, `web_desktop` BLOCKED `DEPENDS_ON_RDP_SESSION`. The report also named the downstream `web_desktop` BLOCKED as "first cause" and counted it as a second independent cause.
- **Root cause 1 — the observer (app, proven from source + Microsoft docs)**: the app's `/api/logon-status` (supreme-lamp `payloads/ghrdp-server.ps1` @978a837, lines 8465-8468) runs `$msg -notmatch 'Logon Type:\s+(2|10|11)\b'` and then `$msg -notmatch [regex]::Escape($userQ)` before reading `$Matches[1]` into `logonType`. Per `about_Comparison_Operators`, `-notmatch` overwrites `$Matches` whenever it detects a match, so the second operator (no capture group) clobbers the first: **`logonType` is always `''` when a user filter is supplied**, even for a genuine type-10 logon. This lab's verifier required `logonType === '10'`, so the capability could never pass. `connected`/`ts`/`sourceIp` are set correctly from the matched event. App-side fix (for the app repo): save `$Matches[1]` before the user `-notmatch`, or parse the event XML `<Data Name="LogonType">` like the app's own F28 collector (`Get-RdpLogonEventFields`) already does.
- **Root cause 2 — the .rdp file (lab, proven by hexdump)**: `writeRdpFile` wrote UTF-16LE **without a BOM** (`66 00 75 00 ...`); read as ANSI the content truncates at the first NUL, so mstsc loses every directive. The app's production launcher writes UTF-8/no-BOM on this same client and reads the file back before launching (its F30 rule). The lab now does both.
- **Alignment — credentials (lab)**: the lab wrote only `CRED_TYPE_GENERIC`; the production launcher converged on `CRED_TYPE_DOMAIN_PASSWORD` primary (F30, after mixed stale entries broke auto-login). The lab now writes both kinds for the fresh `TERMSRV/<ip>` target from one blob and removes both at cleanup.
- **Evidence gaps closed**: TCP 3389 is probed from the client before mstsc (7331 proves nothing about 3389); mstsc window title is sampled and a screenshot is taken *during* the attempt; the FAIL reason carries the last logon-status digest; the server asserts the account is enabled/in-group and that **Audit Logon = Success and Failure** before any logon (disposable hosted host); after the client job, `Collect-RdpDiagnostics.ps1` records bounded server ground truth (4624/4625 XML fields with record ids, TerminalServices session/connection rows, quser/qwinsta, TermService/listener/firewall, capture-task state) as annotations + `rdp-diagnostics.json`.
- **Verifier contract (tightened after run 39575343527)**: a fresh server-side 4624 for the intended user from this run's client tailnet IP, at/after the server-clock baseline, with the **actual LogonType 10 proven directly or by same-instant correlation** — the earlier "derived" workaround (type inferred from the remote Source Network Address) is **removed**: a remote IP is not a logon type. At the pinned app SHA (`logonType` always `''` with a user filter) the type is taken from the app's independent XML-parsing collector (`/api/native-status` `authLast`, `Get-RdpLogonEventFields`) **only when its latest success IS the candidate event instant and is type 10**; a stale type-2 record, an unrelated `authLast` record, or no record at all never counts (and a scanned-past contradiction fails as `RDP_LOGON_TYPE_MISMATCH`; type that cannot be proven at the instant is `RDP_LOGON_TYPE_UNKNOWN`). The app-side one-line fix is written down in `patches/` (PENDING APPLICATION DEFECT — the staged app is never modified while its SHA is reported unchanged). Stale, wrong-source and console logons are rejected by name in the tests.
- **Reporting**: `firstCause` is the first *root* cause; downstream BLOCKED capabilities are listed with `dependsOn` (e.g. `web_desktop <- rdp_auto_login`) and counted separately (`counts.blockedDownstream`); genuinely independent failures remain root causes.
- **Regression tests**: "logon: type 10 is proven directly or by same-instant XML correlation, never inferred from a remote IP", "logon: stale type-2 / unrelated authLast records are rejected (run 39575343527 shape)", "logon: native-status cross-check confirms, contradicts, or stays unavailable", "rdp file: utf8/no-BOM, CRLF, carries the target directives (production launcher shape)", "tcp probe: listening loopback ok, closed port fails bounded", "report: rdp FAIL is first cause; web_desktop BLOCKED is downstream of it (run 39560693766 shape)", "report: an independent web_desktop FAIL stays a root cause next to an rdp FAIL".
- **Attempt-2 evidence that remains unreachable from the driving sandbox**: client/server artifacts and job logs (results blob host), including `capabilities-remote.json`'s last logon-status body and `native-rdp-session.png`. Whether authentication *also* failed in that attempt is therefore unknown; the next attempt's annotations now carry the distinguishing evidence.

- **Status update (2026-10-21, PR #18 follow-up)**: the fix is written, applies cleanly and is now covered by `tests/f-logon-status-matches-clobber.test.js` in the app tree (**3/3 pass with the fix, 2/3 fail on the unpatched file**). It is **still PENDING in the application repository**: this session's credential can read `dictationb1/supreme-lamp` but cannot write to it (`git push` → HTTP 403 `Permission ... denied`; API ref creation → `Resource not accessible by integration`). See `patches/README.md` for the exact patches, the measured test result and the completion steps. The observer defect is **not fixed**, and the lab's same-instant XML correlation remains a verifier-side workaround, not a repair.

### Defect 11: a known blocking dialog burned the whole budget on a generic timeout
- **Trigger**: run 39575343527 attempt 2 (PR #17 head `9b74521`, app `978a837`): seven capabilities PASS (both regression gates 86/86), `rdp_auto_login` FAIL `RDP_LOGON_NOT_OBSERVED ... within 90000ms`, `web_desktop` BLOCKED. Client evidence: `mstsc` alive, `responding=true`, `sessionId=1`, `title="" hasWindow=false` at every sample, `mstsc tcp: none` (never dialed) — while a window enumeration found `mstsc(4672):"Remote Desktop Connection"`, and a screenshot shows the one-time **RDP-file consent** dialog ("Opening Remote Desktop Connection" / "I understand and allow RDP files to open on this device for my account", unchecked, OK disabled) — the April 2026 RDP-file protection (CVE-2026-26151). The 90 s budget ended in a generic logon timeout with the known blocker on screen.
- **Root cause**: no window/owned-dialog enumeration for the launched process tree during the attempt, and `Get-Process.MainWindowHandle`'s "main window" heuristic (unowned top-level only) reported `hasWindow=false` for the very process hosting the owned/modal dialog. Process liveness, main-window state and connection progress were conflated.
- **Fix**: `Get-RdpDialogState.ps1` enumerates top-level **and owned/modal** windows of the launched tree in the correct session with identifiable control texts/checked states (Edit content is never read); `scripts/lib/dialogs.js` classifies them into RDP-file consent / publisher review / certificate warning / credentials prompt / connection error. A confirmed **consent** dialog ends the poll early with `status=BLOCKED reason=RDP_FILE_CONSENT_REQUIRED` (exact manual action + Windows account), captures a during-attempt screenshot, and keeps the aggregate `NOT_VERIFIED` with `web_desktop` downstream-BLOCKED. Other dialogs FAIL with their own codes. Unidentified dialog-like windows are evidence only — never a fabricated verdict.
- **Manual prerequisite** (RUNBOOK §2.4, `scripts/rdp-consent-bootstrap.js`): one-time operator consent in the dialog, per Windows account, using a trusted lab-generated `.rdp` file. The lab never clicks it, never writes `RdpLaunchConsentAccepted`, never sets `RedirectionWarningDialogVersion`, and never claims a manually assisted run proves unattended auto-login.
- **Regression tests**: "dialogs: an owned/modal RDP-file consent dialog with no main window is BLOCKED / RDP_FILE_CONSENT_REQUIRED", "dialogs: publisher review / certificate warning / credentials prompt / connection error are distinguished", "dialogs: a live session window or the plain mstsc surface is never a blocking dialog", "report: RDP_FILE_CONSENT_REQUIRED is a BLOCKED root cause, web_desktop stays downstream, verdict NOT_VERIFIED".
- **Live calibration (run 39594245349, PR #18 head `1af4044`)**: the new enumerator captured the owned dialog with its body static ("You are opening an RDP file which will establish a connection to another computer…") and OK/Cancel; the modern dialog's check-box **label** is a XAML element `WM_GETTEXT` cannot read, so classification now also keys on the unique body sentence (and `BM_GETCHECK` is only asked of real check-box/radio styles - plain push buttons were being reported as "unchecked"). Event honesty is live too: `rdpClient channel=readable events=0 (zero matching events - the query executed and matched nothing)`, and `hasWindow=false` is labelled "main-window heuristic only".
- **Expected verdict**: until the account consent is granted: `NOT_VERIFIED` with `rdp_auto_login=BLOCKED (RDP_FILE_CONSENT_REQUIRED)` naming the account; after a clean unattended run, all nine PASS.

### Defect 12: "no events matched" was reported as an unreadable event channel
- **Trigger**: run 39575343527 attempt 2 client diagnostics: `rdpClient readable=false count=undefined err="No events were found that match the specified selection criteria."` — Get-WinEvent's **zero-match** exception presented as if the RDPClient/Operational channel were unreadable. Missing events are not proof that no connection was attempted, and a readable-but-empty query is not an error.
- **Root cause**: one try/catch flattened four different facts into a single boolean: zero matching events (the exact message above, `NoMatchingLogsFound`), channel absent ("There is not an event log ... that matches"), access denied, and genuine query failures.
- **Fix**: `Get-RdpClientDiagnostics.ps1` records the raw `ListLog`/query outcome (message, FullyQualifiedErrorId, exception type) and `scripts/lib/eventlog.js` classifies it into `channelState: readable | channel-missing | access-denied | query-error` with `zeroMatchingEvents` kept separate; the digest says "zero matching events - the query executed and matched nothing" vs "channel unavailable" vs "query refused - access denied" vs "query failed".
- **Regression tests**: "eventlog: zero matching events vs channel-missing vs access-denied vs query failure" (drives the recorded run-39575343527 message through the classifier).
- **Expected verdict**: `PASS` (classification correctness; the underlying logon verdict is governed by defects 10/11).

### Defect 13: the bootstrap instruction was not safely executable by an operator
- **Trigger**: RUNBOOK §2.4 and the `RDP_FILE_CONSENT_REQUIRED` manual action both told the operator to run `node scripts/rdp-consent-bootstrap.js --host <server-ip> --user slabrdp --open`. Two ways that goes wrong, both possible with the helper as shipped:
  1. the placeholder copied literally → `.rdp` with `full address:s:<server-ip>`, an `mstsc` window that proves nothing about the lab path;
  2. an address reused from an older run's logs → the lab server is ephemeral (`slab-srv-<run_id>-<attempt>`, released with the server job), so that target is expired;
  3. a typo (`--hots 100.x.y.z`) was **silently ignored** because unknown flags were dropped, producing an `.rdp` with no target while the operator believed it was fine.
- **Root cause**: no target validation and non-strict argument parsing in the helper; operator text shipped a copy-pasteable placeholder instead of naming the procedure that prints a live target.
- **Fix**: `scripts/lib/rdp-target.js` refuses placeholders (`<...>`, `${...}`, `%...%`, `server-ip`, `TODO`), loopback, unspecified/broadcast, TEST-NET/documentation, link-local, URLs, CIDR, bare hostnames and reserved domains; it normalises `host:port`, keeps tailnet CGNAT (`100.64/10`) intact, and *warns* (does not silently accept) about a non-tailnet address. The helper and the SETUP script both parse arguments strictly (unknown flag = exit 64) and print the account, session, checkout directory and target. `scripts/lib/dialogs.js` no longer ships a `<server-ip>` placeholder: the manual action names the bounded SETUP procedure.
- **Regression tests**: "rdp target: placeholders, loopback, documentation and expired shapes are refused", "consent bootstrap: unknown flags / placeholder hosts are refused instead of writing a useless .rdp", "dialogs: the consent manual action names the SETUP procedure, not an unexplained placeholder".
- **Expected verdict**: `PASS` (a refusal, not a silently wrong `.rdp`).

### Defect 14: the consent bootstrap had no usable window (normal CI cleaned up in seconds)
- **Trigger**: run 39598371464 (PR #18 head `a22353a`): `rdp_auto_login=BLOCKED RDP_FILE_CONSENT_REQUIRED` was decisive on the **first** poll (`native-rdp-dialog.png`, 1024x768) and the client job cleaned up immediately. That is the correct unattended behaviour, but it means the manual prerequisite has no practical window, and a human who opens the dialog during a verification run is racing cleanup.
- **Root cause**: one mode served two incompatible purposes — unattended acceptance and a human-in-the-loop prerequisite.
- **Fix**: a separate, **bounded** SETUP mode (`workflow_dispatch` `mode=consent-setup`, `setup_timeout_ms` ≤ 900000, step `timeout-minutes: 16`) labelled SETUP everywhere (run name, step name, annotations, artifact, summary). `scripts/rdp-consent-setup.js` writes the production-shaped `.rdp`, launches `mstsc.exe` on it, only **reads** dialog state and screenshots, and ends at its deadline. `scripts/lib/consent-state.js` derives the state honestly: a closed dialog is `CONSENT_DIALOG_CLEARED`/`CONSENT_DIALOG_CLOSED_UNCONFIRMED` (Cancel closes it exactly like OK), never "granted"; `NO_DIALOG_SEEN` is ambiguous, never a grant; a connected session window is `SESSION_CONNECTED`. `scripts/setup-summary.js` writes `verdict: NO_VERDICT_SETUP_MODE` — a SETUP run cannot be reported as `VERIFIED`. The verification path is unchanged and still aborts on first sight.
- **Regression tests**: "consent setup: the state machine never turns \"dialog closed\" or \"no dialog\" into a consent claim", "consent setup CLI: bounded window enforced, placeholder target refused, non-Windows refused", "SETUP runs can never emit a verification verdict".
- **Expected verdict**: `PASS` (state machine + bounds); the consent itself remains an operator action.

### Defect 15: the logon acceptance contract did not require user identity or a bounded attempt window
- **Trigger**: contract review of `scripts/lib/logon.js` against the acceptance requirement "actual LogonType 10 + intended user + matching source + correct attempt time window + correlation of cross-checks to the same event".
  * `evaluateLogonStatus` accepted a body whose `user` echo was missing entirely (only a *differing* echo was rejected), so an endpoint that did not report which filter it applied could still contribute to acceptance;
  * the attempt window had a lower bound only: an event timestamp far after the baseline (clock skew / foreign event) was accepted;
  * `evaluateNativeCrossCheck` could not reject a same-instant record belonging to a **different account** — the app's `Get-RdpLogonEventFields` parses `TargetUserName`, but the pinned build's `Get-RdpLogonAuthLast` does not surface it, so the gap was invisible rather than impossible.
- **Fix**: intended-user echo is required when an expected user is supplied (empty or foreign echo ⇒ `not-observed` with the reason); the window is bounded at both ends (default 30 min after baseline, `DEFAULT_MAX_AFTER_BASELINE_MS`); the cross-check takes `expectedUser` and returns `contradicted` for a same-instant success for another account, states when the collector does not report the account (so identity is not implied), and confirms with the account when it does. `pollLogon` passes the intended user to the cross-check.
- **Regression tests**: "logon: intended identity must be proven (empty/foreign user echo) and the attempt window is bounded at both ends" plus the existing positive/negative logon tests.
- **Expected verdict**: `PASS` (verifier correctness). The application endpoint defect stays separate — see defect 10 / `patches/`.

---

## Live-run integration defects found while building the origin handoff (2026-10-21)

These were found by the live-mode regression suite in this repository, not in CI.
Each one is a verifier-correctness defect: had it shipped unnoticed it would have
turned a *missing* proof into a *wrong* statement about the originating run.

### Defect 16: a legitimately-unknown descriptor field was required, so `origin-signal` could never fire
- **Trigger**: `validateDescriptor` built `REQUIRED` straight from `SIGN_FIELDS`, which
  includes `clientTailnetIp`. The application does not know the client's tailnet address
  when it advertises (the client connects later), and the RDP user is discovered from the
  live server — so the very first `origin-signal` call died with
  `SCHEMA_INCOMPLETE: missing clientTailnetIp`.
- **Root cause**: conflating "participates in the canonical signature" with "must be
  non-empty at advertisement time". A signed field that is absent must still hash
  consistently, or a value could be swapped in transit.
- **Fix**: `OPTIONAL = ['clientTailnetIp','rdpUser','port']` — absent fields are normalised
  to `''` before canonicalisation, so they are signed (a swap changes the descriptor id)
  without being required; `port` is range-checked when present.
- **Regression test**: "live-run descriptor: a well-formed descriptor validates and
  round-trips through serialize" (round-trip through `serializeDescriptor` must keep the id).

### Defect 17: the origin-repository gate was unreachable, and a typo made every identity field unvalidated
- **Trigger**: two bugs in one block. The old loop tested `if (!ID_RE.test(d[k]) && k ===
  'originRepo' && !REPO_RE.test(d[k]))` — for `originRepo` the first clause is always false,
  so `ORIGIN_REPO_UNTRUSTED` could not be reached from there; and the `''` assignments that
  validated `uiBuild`/`backendIdentity` were later overwritten, so `d.originWorkflow` was
  read from `d` instead of `input` (always `''`).
- **Root cause**: field validation reordered by an edit that left both the dead branch and a
  self-assignment behind.
- **Fix**: one assignment per field from `input`, repository allowlisting performed
  **before** endpoint validation, and `labRevision` now requires a 40-hex commit or the
  explicit `'unknown'` (the app job must not accidentally sign the *app* sha as a lab revision).
- **Regression tests**: "unrelated repositories and unsafe endpoints are rejected, never
  warned"; "protocol version is exact".

### Defect 18: a loopback endpoint shaped like `127.0.0.1` was accepted
- **Trigger**: `/^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)$/i` requires the whole host to be the
  literal `127.`, so `http://127.0.0.1:7331` validated cleanly while being unreachable by
  the client VM.
- **Fix**: loopback/link-local/unspecified/empty-host forms are matched as complete addresses
  (`127.x.x.x`, `169.254.x.x`, `::`, `[::]`, `0.0.0.0`, `localhost`). The check is annotated
  as non-relaxable, because a live run that advertises a loopback endpoint is by definition not
  the run being verified.
- **Regression test**: same as defect 17.

### Defect 19: masking depended on every call site remembering to pass the secret list
- **Trigger**: `redact(text, extraSecrets = [])` masked only what a caller handed it, while
  `redactDeep` defaulted to `knownSecrets()`. `scripts/lib/proc.js`, `live-features.js` and
  `live-auth.js` all call `redact(x)` with one argument, so a per-run dash token reached a
  step log or an artifact whenever `registerSecret()` had not run yet — including tokens that
  appear in `?key=` URLs, which no pattern covered at all.
- **Root cause**: the runtime secret registry was advisory instead of the default.
- **Fix**: `redact()` now defaults to `knownSecrets()` (env + registered runtime values) and
  adds `?key=`/`&ticket=`/`&rid=`/`&t=` URL masks so the value is hidden even when it was never
  registered. The registry is still released after the run, so masking does not grow forever.
- **Regression tests**: "credential hygiene: a key/ticket in a URL is masked in every log,
  annotation and artifact"; "orchestration: the report never carries a secret and always
  carries the run identity" (the Markdown report is sanitized at construction, not scrubbed
  afterwards).

### Defect 20: a record could point the lab at a path only the origin can read
- **Trigger**: `publishRecord` wrote `transport.path = C:\ghrdp\…\envelope.json` for the
  inline case, and `fetchEnvelope` honoured any `inline` transport. On a real origin handoff
  that path exists only on the ephemeral runner, so the lab would report a confusing
  `ENVELOPE_MISSING` (or, worse, trust a same-named file it made itself).
- **Fix**: `live-auth.resolveTransport(record, descriptor)` is the single resolver — `inline`
  is valid **only** for a `selfValidation` record, `artifact` always names
  repo + run id + **attempt** (the attempt is now propagated to artifact provenance instead of
  silently falling back), and any other kind (`job-output`, …) is refused. The origin-side
  artifact name is `live-run-<run>-<attempt>-envelope` on both sides.
- **Regression tests**: "live-run envelope transport: a record can never hand the lab a
  runner-local path or an unknown kind"; "live-run envelope: it must bind to the descriptor AND
  to the run that advertised it".

### Defect 21: the tailnet rules were wrong in both directions
- **Trigger**: `FQDN_RE` required an extra label before `.ts.net`, so the valid MagicDNS name
  `a.ts.net` was rejected (a test caught it); and the direct-source hint accepted *any*
  IPv4, so `&ip=8.8.8.8` was injected into a launch URL.
- **Root cause**: "looks like a hostname" was implemented as a shape that rejected real
  hostnames, and the IP guard was written as "not loopback" instead of "is a tailnet address".
- **Fix**: label-validated `*.ts.net` matching (empty labels and `-label` rejected, IPs and
  foreign domains still refused) plus `isCgnat()` restricted to `100.64.0.0/10`; anything else
  is dropped rather than passed through, with the rationale that a LAN or public address in
  that field means someone is steering the client off the tailnet.
- **Regression test**: "production RDP URL: built exactly as the app builds it, and refuses a
  non-FQDN target".

### Defect 22: `assert`-style source greps were matching prose in comments
- **Trigger**: the anti-pattern guards ("must not wait for a workflow to finish", "must not
  contain a *latest server* lookup") tested the whole file text. My own comments describing
  the forbidden patterns made the tests fail, which is the wrong reason to fail — and would
  have taught the next editor to delete the comments.
- **Fix**: those two checks run against the **code** (comment lines stripped), so the comments
  can stay as documentation while the prohibition remains enforced.
- **Regression tests**: "no circular dependency: the origin waits on its own live server, not on
  the lab workflow finishing"; "live-run queue: a queued request can never be re-attached to a
  different server".

| 16 | `origin-signal` refused to publish (`SCHEMA_INCOMPLETE: missing clientTailnetIp`) | a signed field was treated as required | "live-run descriptor: a well-formed descriptor validates and round-trips through serialize" | optional signed fields, still canonical |
| 17 | `ORIGIN_REPO_UNTRUSTED` unreachable; `d.originWorkflow` read from `d` | reordered validation left a dead branch + self-assignment | "unrelated repositories and unsafe endpoints are rejected, never warned" | allowlist runs before endpoint checks |
| 18 | `http://127.0.0.1:7331` accepted as a live endpoint | anchored loopback regex | same test | loopback/link-local always refused |
| 19 | registered per-run secrets could reach a log via `redact()` | masking depended on each call site passing the list | "credential hygiene: a key/ticket in a URL is masked…", "the report never carries a secret…" | `redact()` defaults to the secret registry |
| 20 | a record could hand the lab a runner-local envelope path | transport resolved ad hoc per caller | "a record can never hand the lab a runner-local path or an unknown kind" | one resolver, selftest-only inline |
| 21 | `a.ts.net` rejected; `&ip=8.8.8.8` injected | shape-guess regex + "not loopback" guard | "production RDP URL: built exactly as the app builds it…" | label-valid `*.ts.net`, CGNAT-only hint |
| 22 | anti-pattern tests failed on their own comments | whole-file source greps | "no circular dependency…", "a queued request can never be re-attached…" | checks run on code, comments may document |
