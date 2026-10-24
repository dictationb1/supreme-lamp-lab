# MAIN-REPOSITORY HANDOFF — RDP Mission Control repair bundle

This bundle is the **independent, replayable** record of the RDP Mission Control
verification and repair for application run `40051974454` / attempt `1`. It is
stored in the **lab** repository (`dictationb1/supreme-lamp-lab`) because the
application remote (`dictationb1/supreme-lamp`) was **read-only** in the lab
session. Nothing here was pushed, merged or deployed to the application remote.

A future session with **main-repository-only** write access must be able to:
download this bundle, verify it, apply the ordered application patches without
reverting newer work, run the regressions and full suite, build the correct
frontend/backend, and know exactly which live acceptance checks remain.

---

## 1. Immutable download (pin the commit, not `main`)

Replace `<COMMIT>` with the pinned commit SHA reported in the final Sinhala
handoff (the `[skip ci]` bundle-finalisation commit on
`arena/69b9956b-supreme-lamp-lab`). Every URL below is immutable once pinned.

```bash
LAB=dictationb1/supreme-lamp-lab
COMMIT=<COMMIT>                      # 40-hex, from the final handoff
DIR=reports/mission-control/40051974454-1

# (1) Pinned repository folder (browse)
echo "https://github.com/$LAB/tree/$COMMIT/$DIR"

# (2) Raw manifest
echo "https://raw.githubusercontent.com/$LAB/$COMMIT/$DIR/manifest.json"

# (3) Raw handoff (this file)
echo "https://raw.githubusercontent.com/$LAB/$COMMIT/$DIR/MAIN-REPOSITORY-HANDOFF.md"

# (4) Downloadable ZIP containing the WHOLE repo at that commit (bundle path $DIR inside)
echo "https://codeload.github.com/$LAB/zip/$COMMIT"

# (5) SHA-256 checksums of the reproducibility artifacts
echo "https://raw.githubusercontent.com/$LAB/$COMMIT/$DIR/SHA256SUMS"

# (6) Supplemental workflow evidence (retention-limited; NOT required)
echo "https://github.com/$LAB/actions/workflows/real-backend.yml"
```

Verify the download:

```bash
curl -fsSL "https://codeload.github.com/$LAB/zip/$COMMIT" -o lab.zip
# optional: compare to any recorded ZIP digest in the final handoff
unzip -q lab.zip
cd "supreme-lamp-lab-$COMMIT/$DIR"     # archive root name may vary; use: cd */$DIR
sha256sum -c SHA256SUMS
```

`SHA256SUMS` covers the reproducibility artifacts (patches, series, replay
script, regressions copied into the patches, this handoff, manifest, defect
records, README, coverage/lineage CSVs). Evidence files (logs/screenshots) are
covered instead by the pinned commit hash itself.

---

## 2. Application base identity (verify before applying anything)

| Field | Value |
|---|---|
| Repository | `dictationb1/supreme-lamp` |
| Base commit | `4a91c5c2eadc12e5b071bc46bae7683087f56fbd` |
| Source archive | `https://codeload.github.com/dictationb1/supreme-lamp/zip/4a91c5c2eadc12e5b071bc46bae7683087f56fbd` |
| Archive SHA-256 | `dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378` |
| Origin run | `40051974454` attempt `1`, workflow `.github/workflows/main.yml` |
| Origin outcome | **step 28 staging failed** before any served UI/signal; MC-SIGNAL not published (not a broken publisher). See `defects/ORIGIN-STAGING.md`. |

```bash
curl -fsSL "https://codeload.github.com/dictationb1/supreme-lamp/zip/4a91c5c2eadc12e5b071bc46bae7683087f56fbd" -o app.zip
echo "dadee74430ca5ee1645d3631f033f17d7d04ae4a8bebadafd39c07c2c44aa378  app.zip" | sha256sum -c -
```

---

## 3. Ordered patches (apply at the application root, in this order)

`series.txt` is the canonical order:

1. `app-patches/0001-F201-probe-honesty.patch` — SHA-256 `692246ffe3642a355fd72f3e95e5f84f333cbab1ab658199c8273a3ef0657398`
   - Frontend probe honesty: a refused/empty backend probe must not be shown as
     a confirmed credential/DNS/listener failure. Adds
     `src/tests/smoke/f201-probe-honesty.test.tsx` (8 tests).
2. `app-patches/0002-R1-server-startup-readiness.patch` — SHA-256 `eb9d7efeb001ea536a7e99a4e80289856c93fa71a6f8445b77abce0eebf70b33`
   - `payloads/ghrdp-server.ps1`: remove the three synchronous pre-accept-loop
     event-log scans, publish `server-ready.txt` from inside the accept loop,
     bound periodic inline ticks to one scan per iteration. Adds
     `src/tests/smoke/r1-server-readiness.test.ts` (3 tests).

```bash
cd <application-worktree-at-the-base-sha>
for p in 0001-F201-probe-honesty.patch 0002-R1-server-startup-readiness.patch; do
  git -c core.autocrlf=false -c core.eol=lf apply --check "$DIR/app-patches/$p" || \
    { echo "PATCH DOES NOT APPLY CLEANLY: $p — the application moved; rebase, do NOT revert newer work"; exit 1; }
  git -c core.autocrlf=false -c core.eol=lf apply "$DIR/app-patches/$p"
done
```

**Detect already-applied / superseded patches.** Both patches are idempotency-
checkable by their marker content, not by blind `git apply`:

```bash
# F201 already applied if the store has probe state and the repair copy exists:
grep -q "setProbe" src/stores/sessionStore.ts && echo "F201 present"
# R1 already applied if server-ready.txt is written inside the accept loop:
grep -q "LAB-R1" payloads/ghrdp-server.ps1 && echo "R1 present"
```

If a `--check` fails, **inspect**: a newer application commit may have already
fixed the issue (in which case skip that patch and record it) or moved the code
(in which case rebase the hunk onto the new context). Never `git apply -R`
newer application work to force an old patch to fit. `git apply --3way` is
acceptable when the exact base blob is available.

The reviewed candidate tree after both patches (on the clean base, deps/build
ignored) is `62679b8edfde8ba2180f8bb3ca86c03e00d02b31` — a future session can
`git write-tree` to confirm an unchanged reconstruction, but must NOT treat a
different tree as failure if the application base itself has advanced.

---

## 4. Reproduce baseline, apply, test, build (one script)

`replay-candidate.sh` does all of this from a clean download and was executed
successfully for this bundle:

```bash
cd "$DIR"
bash replay-candidate.sh
```

It proves: archive SHA; both regressions **FAIL** on the pristine baseline;
ordered patches apply; both regressions **PASS** on the candidate; the full
smoke suite (**1,378 tests / 107 files**) and the production frontend build
pass. Manual equivalent:

```bash
cd <application-worktree>
npx --yes pnpm@9.15.9 install --frozen-lockfile
# baseline reproduction (copy the two tests out FIRST, before patching):
#   both tests fail on the unpatched source.
# after applying patches:
npx --yes vitest run src/tests/smoke/f201-probe-honesty.test.tsx src/tests/smoke/r1-server-readiness.test.ts --reporter=dot
npx --yes pnpm@9.15.9 test:smoke                 # 1378 tests
VITE_BUILD_SHA="candidate-4a91c5c2eadc-40051974454-1" npx --yes pnpm@9.15.9 build
# frontend artifact: ui/dist/index.html (single-file, ~1.27 MB)
```

---

## 5. Backend staging / startup (Windows PowerShell 5.1)

The backend is `payloads/ghrdp-server.ps1`. Production staging is performed by
`.github/workflows/main.yml` step "Stage files + write config.json" into
`C:\ghrdp` with: `config.json`, `dash-token.txt`, `ui-v2.html` (the built
`ui/dist/index.html`), the rest of `payloads/*`, fonts, and the launcher kit.
Environment-parity notes for an isolated reproduction:

- Start: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ghrdp-server.ps1 -Port 7331 -Bind 0.0.0.0 -Root <root> -LimitMinutes 350`.
- `dash-token.txt` is the authoritative dashboard key; `config.json` `dashToken` is a fallback. Use a **fresh synthetic key** for a lab candidate; never reuse the origin's.
- Lab-only tuning env (production carries none of these): `GHRDP_LAB_TEL_INTERVAL_SEC` (5..600) shortens the telescope tick; `GHRDP_SCAN_DELAY_MS` (5..1000) paces the accept loop. Neither changes production behaviour.
- Readiness: wait for `server-ready.txt` (R1) or poll `GET /health` for `{ok,app,pid,listenerBound,scans}`. `server-ok.txt` (`LISTENING …`) means only *socket bound* on the baseline and must not be treated as HTTP readiness.
- Ports discovered at the pinned source: **7331** = the PowerShell dashboard/API server (serves `ui-v2.html`, `/api/*`, `/health`, `/ws`); **7332** is referenced by diagnostics/secondary lanes — discover its current role in the source before use; do not guess or substitute ports.
- Known residual (F45-B, tracked, NOT claimed fixed): a periodic inline scan still briefly occupies the accept thread; R1 bounds it to one scan per iteration. A fully isolated background scan worker remains future work.

`.github/workflows/real-backend.yml` + `scripts/candidate/real-backend.js` in this
lab repo implement the isolated Windows verification: they stage a lab-only Root,
run the **actual** server for baseline and patched, measure `connect → first
/health`, sample `/health` across a tick, fire a concurrent inline-scan request,
capture redacted endpoint schemas and the listening socket owner, and drive a
real headed browser. Copy these into the application repo if you want the same
verification there; they are lab-side and do not modify the application.

---

## 6. Regression → defect map

| Regression (fails on base / passes on candidate) | Defect | Root-cause confidence |
|---|---|---|
| `f201-probe-honesty.test.tsx` (8) | `defects/F201-PROBE-HONESTY.md` | HIGH (UI state/consumer) |
| `r1-server-readiness.test.ts` (3) | `defects/R1-SERVER-STARTUP-READINESS.md` | HIGH structural; numeric timing proven on Windows |
| Lab: nav weak-check (body-nonempty → page marker) | `defects/R1-SERVER-STARTUP-READINESS.md` §Nav | HIGH |
| Lab: origin staging vs broken-publisher misclassification | `defects/ORIGIN-STAGING.md` | HIGH first-failure; inner exception UNKNOWN (logs blocked) |

---

## 7. What is NOT proven here — remaining live acceptance for the future session

These were honestly BLOCKED / NOT_RUN in the lab and must be re-checked against
a **fresh, actually-running** `main.yml mode=rdp` origin before the application
is declared healthy:

1. **Live origin UI** — run `40051974454` never served a UI or published a signal
   (staging failed). Re-run `main.yml` with `mode=rdp`; capture the exact
   run/attempt/job/SHA and the published `mc-signal/v1` check-run.
2. **Signal/authorization chain** — publisher → reader → discovery → claim →
   Windows decryption → authentication → visible UI. `LAB_SIGNAL_PUBKEY` (app
   variable) / `LAB_SIGNAL_PRIVATE_KEY` (lab secret) were NOT verified live;
   heartbeat/expiry/supersession/randomized-ciphertext-stable-identity were not
   exercised against a real published signal.
3. **Native RDP via the real Mission Control button** — needs the signed
   production launcher/handoff, the intended configured signing identity
   (historically `7434A62F998EC25ECF899848AEC0881959B7BAA0`, re-inspect current
   trust), a real `.rdp`, no manual credential entry, and a fresh LogonType 10
   4624 correlated to the intended client/user/host/session/interval.
4. **Web Desktop** — render the intended session, make a controlled visible
   change, verify fresh frames + a real input effect, correlate session identity.
   Image-hash differences alone are insufficient.
5. **Full feature acceptance** on the live backend — Sessions, Connections,
   Keys & Secrets (authorized reveal/copy/deny), File Explorer (browse/create/
   upload+hash/download+hash/rename/delete in a dedicated temp dir), Mirror
   (real authorized source/destination operations), Telemetry (real samples),
   Health (real service checks + recovery on test-owned services), Collector
   (start/stop/export/content/sanitization/cleanup), Settings (persistence +
   reload + effect + restoration). The lab candidate sweep (`scripts/candidate/
   sweep.js`) uses a **lab stub** for these and marks backend-dependent items
   BLOCKED — do not copy those stub PASSes as live acceptance.
6. **Automation latency & lifecycle** — readiness, signal publication, discovery,
   queue delay, client startup, visible authenticated UI, session establishment;
   plus expiry/cancellation/superseded/duplicate/claim-recovery/owned-process
   cleanup on test-owned runs.

Do **not** mark `REPORTED_VERIFIED` or write a successful proof description when
any of these is untested. A workflow/job success is not feature verification.

---

## 8. Rollback

- The application remote was never modified, so there is nothing to roll back upstream.
- To drop a patch locally: `git -c core.autocrlf=false -c core.eol=lf apply -R <patch>` in reverse series order (`0002` then `0001`), on a tree that has no newer conflicting edits.
- For the lab candidate server, stop only the owned process tree (the real-backend harness reaps by its own Root path); never kill the user's live origin.

---

## 9. Provenance

- Branch consolidation: allowed branch `arena/69b9956b-supreme-lamp-lab` fast-forwarded to the PR #27 head `6e5fd96` (a superset of PR #26 reader/harness `f41804b` and the F201 repair `481de98`), then extended with R1 + real-backend harness + regressions. See `defects/LAB-HARNESS.md`.
- Clean replay executed 2026-10-24: archive verified, baseline failure reproduced, 2 ordered patches, tree `62679b8e…`, 1378 smoke tests, production build. See `evidence/local-*`, `evidence/candidate-*` and `manifest.json`.
- All published text passes the `publish-evidence.js` credential-shape gate; the lab repository is public. No passwords, private keys, cookies, authenticated URLs, browser profiles or raw secret field values are committed.
