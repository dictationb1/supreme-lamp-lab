# APPLICATION defects — run 40022345749 attempt 1 (`e432d3df4cf00a8528d574f8410f6a76e590db31`)

Every entry below is either measured on the live origin or reproduced from the
pinned source in the lab. Nothing here is inferred from a job's conclusion.

---

## APP-01 (measured, live origin) — the dashboard listener on 7331 accepts TCP and never answers HTTP

| field | value |
| --- | --- |
| first observed | 2026-10-23T21:20:38Z (lab run 40025875096), reproduced 2026-10-23T21:31:50Z (lab run 40026969350) |
| observation point | self-hosted Windows client `rdp-lab-client`, account `WIN-NFU1JG4VESE\User`, interactive session 1, tailnet `100.93.94.15` |
| target | `http://100.99.208.107:7331` — the address in the run's own MC-SIGNAL (`endpoint.primary`) |
| network path | tailscale `backend=Running selfOnline=True peerFound=True peerOnline=True`; TCP to 7331 `reachable=True` |
| HTTP | `curl -m 20 -w %{http_code}` → `000`, exit `28` (timeout) after 15.06 s |
| second port | 7332 answers (`HTTP 404` on `/api/ping` in 0.72 s) — it is a different service with a different route set |
| effect | `/api/ping`, `/health`, `/api/version`, `/api/config`, `/api/native-status` on 7331 all time out; the lab's readiness gate exhausts 240 s and reports `READINESS_TIMEOUT` |
| product impact | The Mission Control UI can render (its HTML was served earlier and is a single file) while every live field is empty and every action is refused: this is exactly the operator screenshot — `Live`, `Launch unavailable`, `(not set)`, no Web Desktop URL, `No runner host published yet`. |
| category | APPLICATION (server-side stall), not lab network: the desk reaches the peer, the port accepts the connection, and the same run's other port answers |

**What is NOT claimed.** The reason the listener stalls is not visible from the
client side. Candidate causes that would be distinguishable from the server's own
logs are: the PowerShell request loop blocked in a synchronous handler; a handler
waiting on a file/registry/certificate operation that never returns; or a second
process bound to 7331 that accepts and then does nothing. The lab cannot read
that host's process list (it is the ephemeral runner of the application run), so
this report stops at the measured boundary and names it.

**Reproduction of the *class* of failure** (no live server needed): the lab's
candidate harness drives the real built bundle with `/api/config` and
`/api/native-status` answering 401 — see `candidate/control-coverage.csv`,
`overview.auto_login_gate` in mode `refuse`.

---

## APP-02 (reproduced from pinned source, repaired) — a refused status read is rendered as a measured credential/DNS/listener failure

| field | value |
| --- | --- |
| baseline | application `e432d3d`, unpatched |
| reproduction | `src/tests/smoke/repro-f201.test.tsx` (kept in `evidence/`): seed the store the way a failed probe leaves it (`native=null`, empty fqdn/user, `listenerOkFlag=false`, `runnerDnsOk=false`) and mount `Overview` |
| result on baseline | the page asserts all three of: “the FQDN/user pair failed validation”, “the runner tailnet IP did not resolve”, “the RDP LISTENER probe is not all green” — and nothing anywhere says the read was refused (test PASSES, i.e. the defect is present) |
| result on the repaired build | the same test FAILS (the wording is gone) and `f201-probe-honesty.test.tsx` PASSES (8 assertions) |
| first causal failure | `src/lib/api.ts getJson()` returns `null` for 401 / 403 / network error / non-JSON 200 alike; `useDashboardPolling` then calls `markNativeLost()` and the components render the *empty defaults* as measurements |
| why it matters | every disabled control on the Overview screen named the wrong prerequisite, which is what makes the operator report “the controls do not work” hard to act on: the page blames credentials, DNS and the RDP listener while the request itself was refused |
| repair | patch `app-patches/0001-F201-probe-honesty.patch` (see the section below) |

### The repair (patch 0001)

* `probeJson()` keeps the HTTP **status** and a stable failure class
  (`unauthorized | forbidden | http | transport | schema`) next to the data.
* `sessionStore.probes.{config,native}` records `{state,status,at}`; the poll
  writes it on every attempt.
* `PrimaryActions` derives its gates from a **trusted** probe (a 200 body, or a
  pre-existing snapshot before the first poll). With an untrusted probe the note
  names the real cause and the remediation (“the dashboard refused this page: no
  valid run key was presented… open the page with this run's `?key=`”), and the
  credential/DNS/listener wording is unreachable.
* `AppShell` puts data availability into the ONE glanceable indicator, so a live
  WebSocket can no longer display `Live` while both status probes are refused
  (it shows `Data unavailable`, tone danger).
* `en.json` + `si.json` carry the new strings (both languages, so the Sinhala UI
  is not left with English text or a missing key).

Regression coverage: `src/tests/smoke/f201-probe-honesty.test.tsx` (8 tests) —
transport classification (401/403/transport/non-JSON 200), store recording,
the three gate states, and the disabled-state invariant.

---

## APP-03 (source-level, unverified on the live origin) — the MC-SIGNAL advertises a port that is not answering, with no second-endpoint fallback

`components/mc-signal/v1` advertises exactly one `endpoint.primary`
(`http://100.99.208.107:7331`). The same run's 7332 answers HTTP. The lab's
discovery therefore has no legal alternative endpoint: it verifies the identity
of the run, then must use 7331, then times out.

This is recorded as a **design observation**, not a proven defect: the application
may intend 7332 to be WebSocket-only. What *is* measured is that a run can
complete its readiness check and publish a signal while its advertised endpoint
does not answer HTTP 10 minutes later. Recommended application-side follow-up:
publish `endpoint.probe` (`{url, at, status}`) taken immediately before
publication, and include the port that actually answered the readiness check.

---

## APP-04 (design, not repaired here) — `Live` is a socket indicator rendered as a backend verdict

`AppShell` shows `topbar.status.live` whenever `wsLive` is true. The chip has no
relationship to whether `/api/*` answers. Patch 0001 makes the worst-state rule
include data availability, which is the minimum honest fix; a fuller redesign
(splitting “socket” from “data”) was **not** attempted and would need product
input — it is recorded as remaining work, not as a claim.
