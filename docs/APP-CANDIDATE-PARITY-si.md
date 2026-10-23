# parity — lab candidate vs the real application run

What the lab reuses unchanged, what it adapts, and what those adaptations
forbid us from claiming. Read this before quoting any verdict from
`app-candidate/`.

## 1. Execution identity ≠ source identity

| identity | value |
|---|---|
| execution | `dictationb1/supreme-lamp-lab`, workflow `app-candidate.yml`, run recorded in `app-candidate/manifest.json` |
| source | `dictationb1/supreme-lamp` @ `978a8375ee77b392ce11694ccee7722fd6ca4f71` **plus** the ordered patch queue (`0001` P001, `0002` P002) |

A run of the lab workflow is **not** a `supreme-lamp` main run. It must never be
reported with an application run id, and the upstream main SHA must never be
quoted as "what ran" — what ran is the base SHA plus patches, whose checksums are
in `patches/SHA256SUMS` and whose applied-diff hash is in
`verification/windows-results.json` (`candidateIdentity.appliedDiffSha256`).

## 2. Reused unchanged (no lab edit)

* `payloads/ghrdp-server.ps1` — the real server, byte-identical to the base
  except the two patched hunks (and byte-identical for the baseline probe).
* The application's own staging function: `scripts/f60-stage-and-start.ps1`
  (`Stage-F60FromCheckout`) via `scripts/server/Stage-App.ps1`, including the
  commit-matched `ui-dist-<sha>.zip` + `.sha256` verification.
* The route contracts under test: `POST /api/rdp-token` gate order
  (credential → tailnet source → MagicDNS → mint) and `GET /api/version`.
* The startup shape of the defect: the dashboard token is written **after** the
  process is already listening, exactly as `main.yml` F92 → staging does.

## 3. Lab-specific adaptations (every one is deliberate)

| # | adaptation | why | what it prevents us from claiming |
|---|---|---|---|
| A1 | Server started directly (`pwsh -File ghrdp-server.ps1 -Port -Root`) instead of by the `GHRDP-Server` Scheduled Task | the lab does not run the application workflow, and the defect is precisely about a process that does not inherit the workflow environment | a claim about Task Scheduler semantics; A1 reproduces the *observable* condition (no `GHRDP_BUILD_SHA`/`GITHUB_SHA`) |
| A2 | `GHRDP_BUILD_SHA` and `GITHUB_SHA` are deleted from the child environment | GitHub Actions sets `GITHUB_SHA` in every step; the Scheduled Task does not see it | nothing about `/api/version` in the lab-standalone path (`backend-supervisor.js` *does* set `GHRDP_BUILD_SHA`, which is why the standalone capability runs never saw `dev`) |
| A3 | `config.json` written by the probe (`dnsName`, `rdpUser`, `rdpPass` placeholder, `dashToken`, `buildSha`) | the lab does not run the account-creation step; only the routes under test read it | anything about credential issuance, ACLs or the real RDP account |
| A4 | `dnsName = slab-srv-lab.example.ts.net` | route requires a MagicDNS-shaped name before minting | that a real MagicDNS name resolves |
| A5 | Probes originate from the runner itself (`127.0.0.1`) | the ephemeral runner is not a tailnet peer for this workflow | a `200 {rid}` mint. The gate order makes `403` proof that the credential passed; the probe records `PASSED_GATE_403` rather than pretending |
| A6 | Two stage roots `C:\ghrdp-base` / `C:\ghrdp-cand` | baseline and candidate must not share a staged tree | nothing; this is stricter than production (production has one root) |
| A7 | Base SHA is `978a8375…` (not current main) | it is the newest commit with a commit-matched `ui-dist` bundle, which staging refuses to substitute | a claim that current main `6a327168…` was executed. It was *checked*: same two code sites, `git apply --check` OK, pinned tests 5/5 |

## 4. Differences in credentials, permissions, scheduling, hosting

* **Credentials**: the lab never uses the application's per-run RDP account or
  dashboard token. Probe tokens are generated per run and only their
  `sha256[0:8]` + length are recorded; no token value appears in any artifact.
* **Permissions**: the lab has no write access to the application repository in
  this phase and needs none — the queue is applied to a lab-owned copy.
* **Scheduling**: no cron/queue/lock path is exercised here; the lab's
  `live-run.yml` sweep is a different pipeline and is not claimed by this bundle.
* **Hosting**: an ephemeral `windows-latest` runner, not the application's RDP
  server; no tailnet join, no interactive desktop, no `mstsc`.

## 5. What therefore remains unproven (and must be proven after deployment)

1. That the application workflow, running the patched server from the Scheduled
   Task, now mints a ticket for a **fresh application-origin run** with a real
   tailnet source, real MagicDNS name and real per-run credential.
2. That Mission Control's authenticated UI, native RDP through the intended
   launcher (LogonType 10), and the Web Desktop frames behave — these need a
   fresh `mode=rdp` application run, which the lab cannot dispatch (HTTP 403).
3. That no production consumer depends on the old boot-snapshot semantics
   (the patch keeps the snapshot as the fallback when no current token exists).
4. Expiry/rotation grace: the patch accepts the **current** token and refuses a
   superseded one; it does not implement a grace window, and no grace window is
   documented in the application.

## 6. Honest status vocabulary

`LAB_CANDIDATE_VERIFIED` (this bundle) means: the patch queue replays cleanly on
the pinned base and the two defects are fixed on a real Windows host running the
real server and the application's own staging. It does **not** mean
`MERGED`, `DEPLOYED`, or `VERIFIED IN supreme-lamp`. Upstream status stays
`NOT_DEPLOYED / NOT_VERIFIED`.
