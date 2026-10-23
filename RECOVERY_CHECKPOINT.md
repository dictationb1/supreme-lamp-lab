# RECOVERY CHECKPOINT — application patch candidate (2026-10-23, LAB phase)

Replaces the PR #18/#23 live-verification checkpoint. That history stays in git.

## Where the work is

| item | value |
|---|---|
| lab repository | `dictationb1/supreme-lamp-lab` |
| branch (this session) | `arena/77adac0a-supreme-lamp-lab` (descendant of PR #23 head `171e7cf`) |
| lab PR | **#23** (open, unchanged by this phase) |
| application repository | `dictationb1/supreme-lamp` — **read-only**, zero writes |
| application baseline | `978a8375ee77b392ce11694ccee7722fd6ca4f71` |
| application main at recovery | `6a327168dbcdf5cabe40406ba21b726c8617fb8e` |
| patch queue | `app-candidate/patches/` — `0001` P001, `0002` P002, `0003` P001B |
| real-Windows verdict | **run 39937351659 → `APP_CANDIDATE_VERIFIED`** |
| upstream status | **NOT_DEPLOYED / NOT_VERIFIED** |

## Verdict in one line

On a real Windows host, with the application's own staging and a production-shaped
start (Scheduled-Task environment, token written after the process is listening),
the **pristine tree** refuses the current run's dashboard token, accepts a
superseded one on **both** strict routes, and answers `/api/version` `sha="dev"`;
the **patched candidate** accepts the current token, refuses superseded/forged/
anonymous on both routes, reports the real 40-hex `buildSha`, and still answers
`dev` when no identity was written.

## The three defects (all measured, none inferred)

| id | route | symptom | root cause |
|---|---|---|---|
| P001 | `POST /api/rdp-token` | current token 401, previous token mintable | compared `$script:Token` (boot snapshot) only |
| P002 | `GET /api/version` | `sha="dev"` | read config `commit`; workflow writes `buildSha`; Scheduled Task inherits no `GHRDP_BUILD_SHA` |
| P001B | `GET /api/purge-stale-creds` | same as P001 on a credential-deleting route | same gate |

Lab-harness defects found and fixed on the way (never reported as application
defects): **L001** an unanswered stale-key probe was published as
`STALE_KEY_ACCEPTED`; **L002** the probe watched an env-named listen marker the
payload never writes; **L003** an inverted purge assertion.

## Live application run (read-only, supplied by the operator)

| field | value |
|---|---|
| URL | https://github.com/dictationb1/supreme-lamp/actions/runs/39936058717 |
| run / attempt | 39936058717 / 1 |
| SHA | `15e15ab847ad8672960b1117a51ed17b47386c81` |
| status at validation (`2026-10-23T10:19:23Z`) | `in_progress`, RDP job `120356350557` in **keep-alive (step 61/62)** with a live signal |
| MC-SIGNAL | **live**: check-run `120362814048`, state `live`, heartbeat 43.7 s, expires `2026-10-23T16:18:39.554Z`, `uiMatchesRunSha=true`, keyId `rsa:f5ae1689a220835e` (existing pair, not rotated); not decrypted, not attached |
| queue applicability to that SHA | **strict OK** for 0001+0002+0003; pinned tests 6/6 |
| relationship | **unpatched** source identity; a candidate PASS is not its fix |

Previous origin `39899087271` (sha `c470531e…`): terminal `completed/failure` at
09:51:22Z; record `FAILED` (retryable); its stale claim (owner lab run
`39929404780`) was **released** at 2026-10-23T10:12Z. Nothing was reused.

## Resume checklist

```bash
cd /home/user/supreme-lamp-lab
git log --oneline -3
node scripts/run-regressions.js                                   # 241: 233 pass, 8 platform skips
./app-candidate/replay/apply-and-verify.sh <fresh checkout @ 978a8375>   # REPLAY_OK, 3 patches
gh run view 39937351659 --log-failed 2>/dev/null | head            # logs on a blob host; use annotations
gh api repos/dictationb1/supreme-lamp-lab/check-runs/<job>/annotations
```

Read `app-candidate/manifest.json` first: it carries the patch checksums, the
candidate/baseline server hashes, the applied-diff hash, the run ids and the
explicit list of unverified claims.

## What is still owed (needs an application deployment, not this lab)

1. A fresh application-origin run where `POST /api/rdp-token` mints `200 {rid,ttl}`
   for that run's own credential **from a real tailnet peer**.
2. A previous run's credential refused on both strict routes in production.
3. `/api/version.sha` equal to the dispatched commit on the deployed server.
4. Mission Control UI, native RDP through the intended launcher (LogonType 10),
   Web Desktop frames, and the feature inventory on the real build.
5. Fresh-run lifecycle: cancellation, superseded attempt, short-TTL expiry.

None of these is blocked on lab permissions. They are blocked on the patches
being deployed upstream, which this phase must not do.
