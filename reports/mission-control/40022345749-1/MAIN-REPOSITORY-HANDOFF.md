# MAIN-REPOSITORY-HANDOFF — Mission Control repairs for a session with application-repository write access

**Application base:** `dictationb1/supreme-lamp` @ `e432d3df4cf00a8528d574f8410f6a76e590db31`
(run 40022345749 attempt 1, workflow `.github/workflows/main.yml`, mode `rdp`).
**Lab evidence:** `dictationb1/supreme-lamp-lab`, this directory.
**Nothing here requires the lab's private workspace, this conversation, or an
Actions artifact.**

---

## 1. What to apply

| # | patch | purpose | prerequisites | affected files |
| --- | --- | --- | --- | --- |
| 0001 | `app-patches/0001-F201-probe-honesty.patch` | A refused/unreachable status read must not be rendered as a measured credential/DNS/listener failure; `Live` must not stand in for backend data | none (source-only; no new dependency, no config, no schema change on the wire) | `src/lib/api.ts`, `src/hooks/useDashboardPolling.ts`, `src/stores/sessionStore.ts`, `src/components/domain/PrimaryActions.tsx`, `src/components/layout/AppShell.tsx`, `src/i18n/en.json`, `src/i18n/si.json`, `src/tests/smoke/f201-probe-honesty.test.tsx` (new) |

Apply order: 0001 only. It is self-contained and idempotent-checkable (see §2).

**Compatibility.** Written against `e432d3d`. The touched regions are stable in
this file set; a newer `main` should be checked with `git apply --3way` and the
new regression suite is the acceptance criterion, not textual cleanliness.

**Do not** apply `patches/*.patch` from the repository root (P001/P001B, logon
status clobber): those were already merged upstream before `e432d3d` and are
reported here for provenance only.

---

## 2. Reproduce the defect and verify the fix (offline, no Windows needed)

```bash
# pinned base
curl -sSL -o app.zip https://codeload.github.com/dictationb1/supreme-lamp/zip/e432d3df4cf00a8528d574f8410f6a76e590db31
unzip -q app.zip && cd supreme-lamp-e432d3df4cf00a8528d574f8410f6a76e590db31
npm ci

# 1) baseline: the defect is PRESENT (this test is written to pass on the buggy build)
cp <bundle>/evidence/repro-f201.test.tsx src/tests/smoke/
npx vitest run src/tests/smoke/repro-f201.test.tsx        # expect: 1 passed
rm src/tests/smoke/repro-f201.test.tsx

# 2) apply the repair
git apply <bundle>/app-patches/0001-F201-probe-honesty.patch
# (or: patch -p1 < <bundle>/app-patches/0001-F201-probe-honesty.patch)

# 3) the same scenario now FAILS (the misleading wording is gone) — this is the fix
cp <bundle>/evidence/repro-f201.test.tsx src/tests/smoke/
npx vitest run src/tests/smoke/repro-f201.test.tsx        # expect: 1 failed
rm src/tests/smoke/repro-f201.test.tsx

# 4) the new regression suite + the whole app suite
npx vitest run src/tests/smoke/f201-probe-honesty.test.tsx  # expect: 8 passed
npx vitest run                                             # expect: 1375 passed (106 files)
```

No network, no Windows and no live server are involved in §2: the baseline
defect is a rendering decision driven by a `null` from `getJson()`, and the
regression drives it with a stubbed `fetch`.

---

## 3. Build and deploy

```bash
# the production build path (unchanged)
VITE_BUILD_SHA=<deployed-app-sha> npx vite build     # -> ui/dist/index.html (single file)
```
* `ui/dist/index.html` is the bundle the runner serves (`ui/index.html` +
  `ui-v2.html` at the staged root; see `scripts/server/Stage-App.ps1` in the lab
  for the exact staging layout the run uses).
* The backend (`payloads/ghrdp-server.ps1`) is unchanged by patch 0001: no route,
  no response field, no schema changes. Only the client's interpretation of a
  failed read changes, so an old backend and the new bundle are compatible, and
  a new backend with an old bundle simply loses the improvement.
* Nothing in patch 0001 changes authorization behaviour. `probeJson()` sends the
  same request as `getJson()` did, with the same `?key=` resolution chain.

---

## 4. What the evidence in this bundle is (and is not)

| evidence | kind | location |
| --- | --- | --- |
| Origin identity checks (`RUN_*`), verdict, discovery transport | **real Windows client VM**, live origin metadata via `api.github.com` | `evidence/live-run-report.json` |
| Dashboard listener measurements on 7331 / 7332 | **real Windows client VM → live origin over the tailnet** | `evidence/live-run-report.json`, `evidence/listeners.json` (published by a later sweep; the first pass carries the same numbers in its annotations, quoted in `defects/`) |
| Baseline defect + repair behaviour | **lab, jsdom, pinned source** — reproducible offline | `evidence/repro-f201.test.tsx`, `app-patches/0001-*` |
| Candidate UI controls in a real headed browser | **lab-owned candidate bundle + LAB STUB backend** on the real client VM | `candidate/control-coverage.csv`, `candidate/candidate-report.json`, `candidate/*.png` |
| Feature verdicts for Search/Sessions/Keys/Files/Mirror/Telemetry/Health/Collector against the LIVE origin | **NOT RUN** — the live backend never answered HTTP | `control-coverage.csv` (verdict column) |

**Not claimed:** that the web-desktop or native RDP flow works on the live origin
(the backend never answered, so no ticket could be minted and no logon could be
correlated); that the nine-item capability inventory proves all UI features (it
does not — see `control-coverage.csv` for the actual per-control outcomes).

---

## 5. Remaining operator actions (exactly two)

1. **Restart/inspect the dashboard listener on 7331 inside the application run.**
   The lab can measure "TCP accepted, no HTTP for 15 s on 7331, while 7332
   answers" but cannot see that host's processes. Until it answers, no live UI
   feature can be exercised by anyone, and no verdict beyond BLOCKED is honest.
2. **Publish a second MC-SIGNAL heartbeat after the dashboard has answered at
   least one `/health`** (or include the port that answered readiness in
   `endpoint`). This prevents a run from advertising an endpoint that has already
   stopped serving (APP-03).

---

## 6. Verifying the bundle itself

```bash
sha256sum -c SHA256SUMS
bash verify.sh          # re-derives the patch digest, re-checks the series order
bash reproduce.sh       # downloads the pinned base into ./out and applies the series
```
