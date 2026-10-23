# handoff — application session (P001 + P002)

**කියවන්න: "Verified in lab candidate" ≠ "merged, deployed and verified in
`supreme-lamp` main".** This session did not push, merge or deploy anything to
`dictationb1/supreme-lamp`, and did not modify its secrets, variables or server.
Upstream status: **NOT_DEPLOYED / NOT_VERIFIED**.

You should be able to continue from this file alone.

## 1. Exact upstream base

| item | value |
|---|---|
| repository | `dictationb1/supreme-lamp` |
| base this bundle was proven on | `978a8375ee77b392ce11694ccee7722fd6ca4f71` |
| main when the lab recovered | `6a327168dbcdf5cabe40406ba21b726c8617fb8e` (2026-10-23T09:33:46Z) |
| why `978a8375` and not main | it is the newest commit with a commit-matched `ui-dist-<sha>.zip` in the `ui-dist` release; the application's staging function refuses to substitute another commit's bundle |
| does main also have the defects? | **yes** — verified by reading both revisions and by `git apply --check` + the 5 pinned tests on a clean `6a327168` checkout |

Both defects live in `payloads/ghrdp-server.ps1` and are independent of the
`main.yml` differences between the two revisions.

## 2. Ordered patches

| # | file | defect | touched |
|---|---|---|---|
| 0001 | `app-candidate/patches/0001-P001-authorize-the-ticket-route-against-the-current-.patch` | `P001 APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE` | `payloads/ghrdp-server.ps1`, new `tests/p001-p002-ticket-and-version-identity.test.js` |
| 0002 | `app-candidate/patches/0002-api-version-reads-config.json-buildSha-the-iden.patch` | `P002 VERSION_STAMP_ABSENT` | `payloads/ghrdp-server.ps1`, same test file |
| 0003 | `app-candidate/patches/0003-P001B-purge-route-current-token.patch` | `P001B` — the same gate on `/api/purge-stale-creds` | `payloads/ghrdp-server.ps1`, same test file |

Dependency: 0001 → 0002 (same file, adjacent regions) → 0003 (reuses 0001's
resolver). Checksums in `app-candidate/patches/SHA256SUMS`; ordered list in
`series.txt`. The verifier is `.github/workflows/app-candidate.yml` (lab-owned
Windows) and it must report `APP_CANDIDATE_VERIFIED` before this queue is
described as verified.

### P001 — what it changes and why that is the cause

`POST /api/rdp-token` compared the bearer against `$script:Token`, read **once**
at boot. `main.yml` kicks the `GHRDP-Server` task (~line 918) long before it
writes `dash-token.txt` (~2831) and `config.json.dashToken` (~2767). Observed on
run `39929404780`: the run's own credential got 401 on this route while the
refresh-aware routes accepted it, and `expectedLen=0` proved the snapshot was
empty. The fix authorizes against the **current** token on disk and keeps the
snapshot only as the fallback when no current token exists. Missing / empty /
forged / superseded tokens still get 401, and the constant-time compare and the
route order (401 → 403 tailnet source → 409 MagicDNS → 200 `{rid,ttl}`) are
unchanged.

**Do not "fix" this by routing the ticket route through `Test-GhrdpDashToken`.**
That validator is a UNION (snapshot ∪ file ∪ config); using it here would keep a
previous run's credential mintable — the security half of the same defect.

### P002 — what it changes and why that is the cause

`/api/version` read `GHRDP_BUILD_SHA`, then `GITHUB_SHA`, then `config.json`
**`commit`**. The workflow writes the identity as **`buildSha`** (main.yml
~2765), and the Scheduled-Task server inherits no workflow environment. The fix
consults `buildSha` (then `gitCommit`, `sourceSha`) before answering `dev`.
A config with no identity key still answers `dev` — the patch reads a real
identity, it never invents one.

## 2b. What was verified, and against which live run

* Real Windows, lab-owned runner, assembled candidate (3 patches): **run
  `39937351659` → `APP_CANDIDATE_VERIFIED`**. Pristine: current token refused,
  superseded mintable, `sha="dev"`. Patched: current token accepted, superseded/
  forged/anonymous refused on both strict routes, `sha=978a8375…`, and `dev` when
  no identity was written.
* Live application run supplied by the operator (read-only, **unpatched**):
  `https://github.com/dictationb1/supreme-lamp/actions/runs/39936058717`,
  attempt 1, SHA `15e15ab847ad8672960b1117a51ed17b47386c81`, `in_progress` at
  validation with the RDP job at step 50/62 and **MC-SIGNAL not yet published**
  (step 60). No endpoint, credential or descriptor was derived or reused.
  The queue applies **strictly** to that exact SHA and the pinned tests pass 6/6
  on a clean checkout of it — applicability only, not a fix.
* Previous origin `39899087271` (`c470531e…`) is terminal (`completed/failure`
  09:51:22Z); its stale claim was released. Nothing from it is current.

## 3. How to retrieve and verify the bundle

Everything durable is in the lab repository (an artifact link alone is not
enough, and artifacts expire):

* `app-candidate/` — patches, checksums, baseline record, reproduction, replay
  script, rollback, manifest with run ids and hashes.
* `app-candidate/manifest.json` — schema, base SHA, patch order + checksums,
  applied-diff hash, lab run ids, verdicts, parity differences, unverified claims.
* `docs/APP-CANDIDATE-PARITY-si.md` — what the lab reused, what it adapted, and
  what those adaptations forbid claiming.
* `docs/reports/2026-10-23-app-candidate-p001-p002-si.md` — the defect report.

Verify the queue without trusting the lab filesystem:

```bash
git clone https://github.com/dictationb1/supreme-lamp.git app && cd app
git checkout 978a8375ee77b392ce11694ccee7722fd6ca4f71
/path/to/supreme-lamp-lab/app-candidate/replay/apply-and-verify.sh "$PWD"
```

The script refuses a moved base, refuses a checksum mismatch, and stops at the
first conflict. It prints `REPLAY_OK` only when the queue applied and the 5
pinned tests passed.

## 4. Replaying the tests

| layer | command | expected |
|---|---|---|
| portable replay | `app-candidate/replay/apply-and-verify.sh <checkout>` | `REPLAY_OK` |
| app unit pins | `node --test tests/p001-p002-ticket-and-version-identity.test.js` | 5/5 pass |
| lab regressions | `node scripts/run-regressions.js` (lab repo) | 241 tests, 233 pass, 0 fail, 8 platform skips |
| real Windows | `.github/workflows/app-candidate.yml` (lab repo) | `APP_CANDIDATE_VERIFIED` annotation |

## 5. If upstream main has moved

**Do not apply blind.**

1. `git log --oneline <base>..origin/main -- payloads/ghrdp-server.ps1 .github/workflows/main.yml`
2. Re-read the two sites: the `POST /api/rdp-token` credential gate and the
   `GET /api/version` identity chain. If either now uses the current token /
   `buildSha`, the corresponding patch is **already fixed** — drop it and record
   `NOT_APPLICABLE (fixed upstream)`.
3. Otherwise rebase the queue onto the new base, resolve by hand, and re-run the
   pinned tests **plus** the real-Windows workflow with `base_sha` set to the new
   commit (workflow_dispatch input).
4. Re-record base SHA, patch checksums, applied-diff hash and run ids in
   `manifest.json`. Never reuse the old numbers for a new base.

## 6. Build / release / configuration requirements

* The server payload is shipped from `payloads/ghrdp-server.ps1`; the UI bundle
  must remain the commit-matched `ui-dist-<sha>.zip` (the patches change no UI
  source — asserted by the workflow).
* No new secrets, no key rotation, no certificate change, no new dependency.
* `MC-SIGNAL` key pair and the RDP signing identity are untouched: the patches do
  not read, write or transport keys.
* After deployment the server process must be **restarted** (a running process
  does not reload its file).

## 7. Rollback

`app-candidate/rollback/README.md`. Short form: reverse-apply 0002 then 0001
(or `git revert` after merge), restart the dashboard process, re-check
`POST /api/rdp-token` and `/api/version`.

## 8. Production checks still owed after deployment

These are **not** satisfied by this bundle:

1. A fresh application-origin run (`mode=rdp`): `POST /api/rdp-token` from a real
   tailnet peer returns `200 {rid,ttl}` for the run's own credential.
2. A **previous** run's credential returns 401 (the security half of P001).
3. `/api/version.sha` equals the dispatched commit on the running server, and
   `sha7` agrees.
3b. `GET /api/purge-stale-creds` accepts the current run's token and refuses a
   previous run's token (do not execute the returned command).
4. Mission Control UI authenticates and renders; native RDP through the intended
   launcher reaches LogonType 10 with the intended user; the Web Desktop shows
   fresh frames; the feature inventory is exercised on the real build.
5. Expiry/rotation behaviour on a real token rotation (the patch has no grace
   window; none is documented).
6. Cancellation/superseded-attempt behaviour of the run queue is unaffected by
   these patches but is still only unit-proven.

A missing application workflow dispatch permission in the lab (HTTP 403) is the
reason items 1–5 are owed; it is not a reason to weaken any assertion.
