# Baseline failures — what the pristine tree actually does

Two independent defects, both still present at upstream `main`
`6a327168dbcdf5cabe40406ba21b726c8617fb8e` on 2026-10-23.

## Evidence A — the real application-origin run (read-only, not re-run)

Run `39929404780` attempt 1, client job `120333833464` (self-hosted
`rdp-lab-client`), completed 2026-10-23T09:27:37Z, conclusion `failure`.
Retrieved from `GET /repos/dictationb1/supreme-lamp-lab/check-runs/120333833464/annotations`
(the Windows step logs live on a blob host this environment cannot reach; the
annotations are the readable verdict record).

| annotation | content (verbatim, trimmed) |
|---|---|
| `auth ticket route` | `APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE: the application accepts this run's credential on its refresh-aware routes (REFRESH_AWARE_CURRENT) and refuses it on its strict POST /api/rdp-token route, which compares only the dashboard token read at server boot (2026-10-23T04:13:48.829Z).` |
| `auth refresh-aware` | `REFRESH_AWARE_CURRENT {"ours":{"status":404,"code":"UNKNOWN_SOURCE"},"anonymous":{"status":403},"forged":{"status":403}}` |
| `auth proof gates` | `noBearer=401 wrongBearer=401 ourBearer=401 ... diag[entries=18 route=/api/f92-selftest serverExpectsPublished=false expectedLen=0 publishedLen=32]` |
| `server process` | `bootAt=2026-10-23T04:13:48.829Z route=/api/native-status ... runStartedAt=2026-10-23T04:12:31Z predatesRunByMs=-77829` |
| `envelope` | `transport=inline ... expiresAt=2026-10-23T10:12:31.000Z` |

Root cause, read from the shipped source (not inferred): `payloads/ghrdp-server.ps1`
assigns `$script:Token` **once** at boot (`if (Test-Path … 'dash-token.txt')`)
and `POST /api/rdp-token` compared the bearer against exactly that snapshot.
`.github/workflows/main.yml` kicks `GHRDP-Server` in *F92 register user-session
server* (~line 918) and writes `dashToken` (~2767) and `dash-token.txt` (~2831)
in *Stage files + write config.json* (~2554) — far later. `expectedLen=0` is the
empty snapshot; a previous run's token in the file would instead be a stale but
non-empty snapshot (the same mechanism, the security direction).

## Evidence B — the same job's own infrastructure failures (NOT app defects)

Same job, same window: `nav.routes_reachable: page.goto: Timeout 30000ms exceeded`,
`VERSION_UNREACHABLE`/`PROGRESS_UNREACHABLE`/`READINESS_UNREACHABLE` (TimeoutError
code=23, six evaluators), and `Failed to CreateArtifact: Unable to make request:
ENOTFOUND`. The runner lost GitHub/network connectivity mid-run.

Consequence: `auth.no_stale_key_reuse` published
`STALE_KEY_ACCEPTED: the live server minted a ticket for a token it should not know`
from a probe that never got an answer (`refusedTicket = transport === 'ok' && …`
fell through to FAIL on `transport='timeout'`). That is a **lab-harness defect**
(L001), fixed separately in `scripts/lib/live-features.js`; it is *not* counted
as an application finding and the application is not blamed for it.

## Evidence C — controlled reproduction, real Windows (this bundle)

`.github/workflows/app-candidate.yml` starts the staged backend exactly as the
production Scheduled Task does (no `GHRDP_BUILD_SHA`, no `GITHUB_SHA`), writes a
*previous run's* token, waits for `LISTENING`, then writes the *current* token to
`dash-token.txt` and `config.json` `dashToken` — the real ordering.

Baseline expectations (recorded in `verification/windows-results.json`):

| probe | pristine baseline | patched candidate |
|---|---|---|
| `POST /api/rdp-token` anonymous | 401 | 401 |
| `POST /api/rdp-token` forged bearer | 401 | 401 |
| `POST /api/rdp-token` **current** token | **401 (refused — P001)** | 200 / 403 past the gate |
| `POST /api/rdp-token` **superseded** token | **mintable (P001, security direction)** | 401 |
| `GET /api/version` | **`sha="dev"` (P002)** | 40-hex `buildSha` |
| `GET /api/version`, no identity written | `dev` | `dev` (never invented) |

Route order in the shipped server is credential gate → tailnet source → MagicDNS
→ mint, so **403 is positive proof the credential passed the gate**; only 401
means the credential was refused. The probe records which discriminator applied
instead of pretending a 403 is a failure.

## P002 root cause (separate cause, separate patch)

`/api/version` reads `$env:GHRDP_BUILD_SHA`, then `$env:GITHUB_SHA`, then
`config.json` **`commit`**. `main.yml` writes the identity as **`buildSha`**
(line 2765), and the server is started by a Scheduled Task that does not inherit
the workflow step's environment. So a server whose exact identity is on disk
answers `dev`. This is an application defect in the read path, not missing
metadata: the metadata is written, under a key the route never reads.
