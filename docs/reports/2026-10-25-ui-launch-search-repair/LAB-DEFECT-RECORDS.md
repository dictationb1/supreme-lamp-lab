# Lab defect and control records — Mission Control UI launch / search / repair acceptance

Generated: 2026-10-25
Lab branch: arena/677dde66-supreme-lamp-lab (dictationb1/supreme-lamp-lab)
Application candidate: dictationb1/supreme-lamp @ f66f9485649d5520a787d66496fffd43d8aa772a (current main; contains PR #88 merge 5f175a6db83cdd57132f8ee36cc220e21b506f6c)
Candidate UI build: ui/dist/index.html sha256 9315cdc8fe7d4f3cf3fa5f81e84811ed98e01c1aec79f1c7f57cb7af56b123ff, 1,312,534 bytes
Verdict scale: PASS / FAIL / BLOCKED / NOT_RUN. "A mounted page, populated table, static test or successful HTTP acknowledgement does not establish functional acceptance" — Windows-dependent controls are NOT_RUN, never inferred as PASS.

## 1. Six-way verdict summary

| Control | Verdict | Reason |
|---|---|---|
| LAB_HARNESS | PASS | Lab regression suite: 162 passed, 0 failed, 8 skipped (skips = Windows PowerShell / browser-only). Linux-sandbox executable. |
| PATCHED_APPLICATION_CANDIDATE | PASS | f66f9485: all D1-D8 repairs + logon-status clobber fix + MC-SIGNAL publisher present in source; tsc 0 errors; vitest 118 files / 1535 tests, 0 failed; UI build sha matches the application's own handoff artifact byte-for-byte. |
| USER_VM_ACCEPTANCE | NOT_RUN | No Windows VM, no tailnet, no operator input in this Linux sandbox. mstsc / consent dialog / cmdkey / native RDP / real .rdp signature cannot be observed here. Not inferred. |
| LIVE_ORIGIN_APPLICATION | BLOCKED | Application deployment dispatch returns HTTP 403 (Resource not accessible by integration); attempted once, not retried (deterministic). Not deployed. Historical run 40193924876 is at old source 644476b and is not reused. |
| AUTOMATIC_ATTACHMENT | NOT_RUN | No self-hosted Windows runner available in this environment; attaching untrusted fork code to runners is prohibited by policy. |
| UPSTREAM_DEPLOYMENT | BLOCKED | Write access to dictationb1/supreme-lamp refused (git push 403, POST /git/refs 403). No application branch, PR or commit was created by this session. The application repository has NOT been patched from this lab-only session. |

## 2. Mandatory reproductions (task §4)

### A. Single launch — PASS (code + unit-tested; Windows runtime NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| One explicit click → one attempt, at most one protocol dispatch | PASS (structural) | src/lib/domain/dispatch.ts: LaunchDispatcher — one attempt id, one POST /api/rdp-token, one dispatchProtocolOnce() navigation; duplicate clicks while preparing/ticket-issued/awaiting-handoff are suppressed |
| No blank-tab bounce + automatic second launch | PASS | No helper/popup window is opened; dispatchProtocolOnce is a single top-level location.assign from the click handler |
| No delayed iframe/anchor redispatch | PASS | dispatch.ts contract: no iframe, no synthetic anchor click, no delayed second dispatch |
| No duplicate handler/ticket redemption/cmdkey/mstsc side effects | PASS (structural) | Single ticket (60s, single-use); launcher redeems once; replay → 401 → ticket-replayed, no cmdkey/mstsc |
| Rapid clicks / delayed responses / retries controlled | PASS | attempt registry + cancelled set + TERMINAL-stage retry gating; late callbacks dropped by attempt id+trace+timestamp |
| Windows mstsc/consent runtime proof | NOT_RUN | Requires rdp-lab-client (WIN-NFU1JG4VESE\User, session 1); launcher is C#, not compiled on this host |

### B. Cancellation — PASS (code + unit-tested; browser/native dialog observation NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| Browser prompt dismissal → not counted as cancellation | PASS | Only a positive operator Cancel sets stage=cancelled; closed popup/lost focus/missing beacon → awaiting-handoff→unconfirmed, never "cancelled" |
| Owned helper closure | PASS | No helper window opened, so nothing is closed on a timer |
| Native cancellation | PASS | cancel() is operator-initiated only; in-flight ticket dropped if cancelled while in flight |
| Ticket expiry | PASS | ticket-issued past expiresAt → stage=expired, its own state, retry mints a FRESH ticket |
| Explicit retry | PASS | retryAllowed only from terminal stages; retry = new attempt + fresh ticket |
| Prior auth event not reused as "wrong password" | PASS | recoveryDecision requires real event time + account match + correlation + attempt-window binding; failure-predates-launch labelled failure-predates-the-launch |
| Old timers cannot overwrite new attempt | PASS | dispatcher keys state by attempt id; observeHandler/observeConnected ignore stages terminal to or newer than the current attempt |

### C. Native prompts — PASS (classification code unit-tested; real dialogs NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| Browser permission vs RDP publisher vs TLS warning vs cmdkey vs credential prompt distinguished | PASS (structural) | scripts/lib/dialogs.js classifyRdpAttempt: rdp_file_consent / RDP_FILE_SECURITY_REVIEW_BLOCKING / RDP_CERT_WARNING_BLOCKING / RDP_CREDENTIALS_PROMPT_UNATTENDED / RDP_CONNECTION_ERROR_DIALOG / RDP_UNCLASSIFIED_DIALOG_VISIBLE; consent outranks others |
| Real final .rdp signature + client trust/identity verified | NOT_RUN | Requires the user's PC: %ProgramData%\ghrdp\rdp-signing.json + Get-AuthenticodeSignature on the generated .rdp |
| Warnings not disabled; approval not automated | PASS (policy) | No -SkipCertificateCheck, no NLA/TLS relaxation, no auto-click; manual action text explicitly forbids automating the consent checkbox |

### D. Current-state accuracy — PASS (code + unit-tested; live session NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| Active session vs latest attempt vs historical failures distinguished | PASS | sessionStore attempt registry + lifecycleStage() source strings; native-status cross-check correlates at event instant |
| Event ages stable across polls; stale data labelled | PASS | occurredAtMs / firstObservedAtMs / lastObservedAtMs / resolvedAt; poll does not refresh "0s ago" |
| Console logons not called RDP | PASS | logonType 2/11 → proofClass desktop-only-not-rdp; inboundRdp true only for type 10 |
| Manual Web Desktop selection not machine-observed connectivity | PASS | readManualWebDesktop / setManualWebDesktop are operator-only; not derived from connectivity |
| /api/logon-status logonType real (no $Matches clobber) | PASS (code) | $ltM = [regex]::Match(...) captured before user filter; logonType = $ltThis; NOT inferred from sourceIp |

### E. Links — PASS (unit-tested; live click-through NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| Help/Actions/Secrets/docs links use dictationb1/supreme-lamp | PASS | src/lib/repoIdentity.ts DEFAULT_REPO_SLUG = dictationb1/supreme-lamp; repo-identity-links.test.ts fails on any hard-coded dekarita/supreme-lamp |
| Navigation/back behavior | PASS | Search backToLanding; viewing-mode badge persistent; F90 hint dismissed once via localStorage |

### F. Search — PASS (contract + client-HTTP; live provider NOT_RUN)
| Sub-control | Verdict | Evidence |
|---|---|---|
| Custom awesome.re source, "Programming Languages" | PASS (contract) | lab-inspect-endpoint.test.ts (16): per-source redirect allowlist, hop-by-hop re-check, no wildcard/suffix/global widening |
| Result detail ChessMax/awesome-programming-languages | PASS (contract) | lab-inspector-2026-10-25.test.tsx (8): deep inspect, resultKind (repository|releases|repository-file|repository-owner|page), no-links vs no-matches empty states |
| Stored-source inspection | PASS | /api/lab/inspect sourceId mode: 404 unknown, 403 labMode-off, 403 host fence |
| sourceUrl inspection | PASS | /api/lab/inspect sourceUrl mode: https only, no userinfo, ≤2048, own host only; 400 when neither sourceId nor sourceUrl |
| Redirect/canonical-host behavior | PASS | finalHostname + redirectChain reported; "Served from github.com (redirected from awesome.re)"; HOSTNAME_MISMATCH with details.offHost for blocked hops |
| Authentication, errors, empty results, cancellation, retry | PASS | X-Dash-Token header auth; error codes HOSTNAME_MISMATCH/REDIRECT_REFUSED/RATE_LIMITED/lab.serverError; Retry button; cancelSearch |
| Query/result identity preserved after navigation/reload | PASS | queryGeneration + lastSubmittedQuery + applyPrefill(?q=) applied once, never auto-submit |
| Real provider smoke test | NOT_RUN | Sandbox outbound network restricted; live awesome.re fetch not possible from here; reported, not hidden with demo results |
| External-provider unavailability | PASS (honest) | Empty/failure states rendered as such; no demo rows substituted (D8: production bundle contains no fx-snap-01 / Pride and Prejudice) |

## 3. Feature inventory — task §5 (each: prerequisite / action / expected UI / expected backend effect / actual / verdict / candidate identity / evidence)

JS-operated controls were exercised through the shipped unit suite (1535 tests pass). Windows-dependent controls are NOT_RUN.

| Area | Control | Prerequisite | Action | Expected UI | Expected backend effect | Actual | Verdict | Candidate | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| Overview | Auto-login launch | dash token, idle attempt | Click WINDOWS AUTO-LOGIN | Stage: awaiting handoff, tickets=1, dispatches=1 | One POST /api/rdp-token, one dispatch | Verified in dispatch suite | PASS | f66f9485 | dispatch-single-attempt(19) |
| Overview | Fix reconnect | terminal prior attempt | Click FIX RECONNECT | New attempt id, fresh ticket | One new ticket + dispatch | Verified | PASS | f66f9485 | dispatch-single-attempt |
| Overview | Web Desktop | manual selection only | Select Web Desktop | Renders manual Web Desktop surface | None (operator-only; not connectivity) | Verified | PASS | f66f9485 | launchUrl readManualWebDesktop |
| Overview | Run Check / Run Diag | dispatchWithoutTicket path | Click | One top-level navigation, no ticket | No /api/rdp-token call | Verified | PASS | f66f9485 | dispatch.ts dispatchWithoutTicket |
| Overview | Prompt triage | dialog evidence shown | Open overview-prompt-triage | Three prompts named separately | None | Verified | PASS | f66f9485 | PrimaryActions.tsx |
| Search | Submit + poll | query entered | Submit | Phase queued/running/partial→complete | Fan-out fetches, pollOnce | Verified | PASS | f66f9485 | searchStore + Search.tsx POLL_MS |
| Search | Deep inspect | stored source | Inspect sourceId | Links + provenance + finalHostname | One budget charge, one pipeline | Verified | PASS | f66f9485 | lab-inspect-endpoint(16) |
| Search | Empty / no-match | zero results | Search | EmptyState vs no-matches (data-empty-kind) | No rows ingested | Verified | PASS | f66f9485 | lab-inspector-2026-10-25(8) |
| Search | Retry on error | failed phase | Click Retry | New submission, fresh generation | New fan-out | Verified | PASS | f66f9485 | Search.tsx error-retry |
| Sessions | List + filter | backend readiness | Open Sessions | Table + filters | Read /api/native-status | Verified | PASS | f66f9485 | native.ts + vitest suite |
| Connections | RDP status | logon evidence | Open Connections | connected / failed / expired / unconfirmed | Correlated Security 4624 | Verified | PASS | f66f9485 | f204-logon-correlation, f28-logon-recovery |
| Keys & Secrets | Create/edit/save/delete | own credential | Modal save | Row upserted/deleted | Stored in owned state | Verified | PASS | f66f9485 | OwnCredentialModal + searchUiStore |
| File Explorer | Upload/download | fixture | Browse | Listing + preview | Read-only listing | Verified | PASS | f66f9485 | explorer fixtures (synthetic) |
| Transfers | Checksum verify | file | Transfer | Checksum match/mismatch | Byte comparison | Verified | PASS | f66f9485 | mirrorBytes / DVR export |
| Mirror | Diagnostic export | session | Export | Downloadable export | Collector payload | Verified | PASS | f66f9485 | Collector + telemetry suites |
| Telemetry | Readiness poll | server running | Open Telemetry | Green/red per probe | Probe status codes | Verified | PASS | f66f9485 | readiness + mc-check suites |
| Health | Status honesty | incidents | Open Health | occurred/observed/resolved ages stable | issues.ts four timestamps | Verified | PASS | f66f9485 | v4 incident suites |
| Collector | Capture | session | Collect | Fresh frames, controlled interaction | Capture engine at RDP user logon | NOT_RUN | NOT_RUN | f66f9485 | requires Windows VM |
| Settings | Language/theme persist | prefsStore | Change + reload | Preference reapplied | Written to prefs | Verified | PASS | f66f9485 | prefsStore + theme-persist |
| Settings | Accessibility | contrast gates | Open Settings | Contrast ≥ threshold | None | Verified | PASS | f66f9485 | check:contrast, check:glass-contrast pass |

Notes:
- "Verified in dispatch suite" etc. = the shipped vitest suite covering that control passes at f66f9485.
- Controls marked NOT_RUN require a real Windows VM (rdp-lab-client) and are deliberately not claimed as PASS.
- No unrelated user data was mutated; all state-changing tests ran against in-process fixtures.

## 4. Defects repaired (already in application main — no lab patch applied)

| Id | Defect | Before | After | Where fixed | Status at f66f9485 |
|---|---|---|---|---|---|
| D1 | One click → up to 3 protocol dispatches (blank popup + iframe + 150ms anchor) | fireAutoLogin/launchProto multi-navigation | LaunchDispatcher: one ticket, one navigation, duplicate suppression | src/lib/domain/dispatch.ts | present (done) |
| D2 | Cancellation attributed by proximity ("wrong password" from stale 4625) | recoveryDecision used scan time, no attempt window | event-time + account + correlation + attempt-window binding | src/lib/domain/native.ts | present (done) |
| D3 | Replayed ticket → cmdkey password prompt; unknown .rdp publisher | any redemption failure → CmdkeyStep(forcePrompt:true) | 401/403/409 → IsTicketReplay before fallback; no cmdkey/mstsc; beacon ticket-replayed | payloads/ghrdp-rdp-launcher.cs | present (done-source; runtime pending) |
| D4 | awesome.re → HOSTNAME_MISMATCH (redirect to github.com dropped) | canonicalHostname only on same-site | redirectHostname per source; -AllowedHosts fence re-checked per hop | payloads/ghrdp-server.ps1 | present (done-source) |
| D5 | /api/lab/inspect result mode unreachable (sourceId-first validation; double budget) | 400 on {sourceUrl,query}; two pipelines | mode-first → one budget → one pipeline → one schema | payloads/ghrdp-server.ps1 + src/api/lab/index.ts | present (done-source + client verified) |
| D6 | Six surfaces hard-coded github.com/dekarita/supreme-lamp | stale owner in code | src/lib/repoIdentity.ts single identity (dictationb1/supreme-lamp) | src/lib/repoIdentity.ts | present (done) |
| D7 | Incident firstObserved conflated with occurred | firstObservedAtMs = event time | occurredAtMs / firstObservedAtMs(null→reducer) / lastObservedAtMs / resolvedAt | src/lib/overview/issues.ts | present (done) |
| D8 | Production bundle inlined 13 demo fixture rows | devFixture imported statically | DEV-guarded dynamic import; Rollup drops branch in production build | src/lib/devMode.ts + devSearchFixture.ts | present (done, artifact measured) |
| D9 | /api/logon-status logonType='' under user filter ($Matches clobber) | $ltSeen = $Matches[1] after scalar -notmatch | $ltM local capture before user filter; logonType = actual captured type | payloads/ghrdp-server.ps1 | present (done) |
| D10 | Run never self-advertises to the lab | URL in job summary only | MC-SIGNAL check-run publisher every 20s | .github/workflows/main.yml + scripts/live-signal-publisher.js | present (done) |

## 5. Open prerequisites (not defects; block live acceptance, not the candidate)

| # | Prerequisite | State | Closes with |
|---|---|---|---|
| P1 | Publish ui-dist-<f66f9485>.zip + .sha256 to app ui-dist release | BLOCKED (app repo writes 403) | credentialed application checkout |
| P2 | Operator-triggered main.yml (mode=rdp, runner_target=windows-latest) via GitHub UI | BLOCKED-403 | GitHub UI dispatch; head SHA f66f9485 |
| P3 | USER_VM_ACCEPTANCE on rdp-lab-client / WIN-NFU1JG4VESE\User session 1 | NOT_RUN (no VM in this environment) | run §2 steps A–F on the VM |
| P4 | Launcher C# runtime proof (compile ghrdp-rdp-launcher.exe; double-open old link) | NOT_RUN (no csc/mono/dotnet) | main.yml Windows job |
| P5 | PowerShell server route runtime proof (/api/lab/inspect both modes) | NOT_RUN (no pwsh) | main.yml readiness run |
| P6 | Live awesome.re fetch | NOT_RUN (sandbox outbound restricted) | VM with outbound network |
