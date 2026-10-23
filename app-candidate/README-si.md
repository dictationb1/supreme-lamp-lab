# application candidate bundle — P001 + P002

**මෙය "verified in lab candidate" මිස "merged / deployed" නොවේ.**
Upstream `dictationb1/supreme-lamp` ට කිසිවක් push නොකර ඇත; app repository
read-only ලෙසම පවතී.

| item | value |
|---|---|
| upstream | `dictationb1/supreme-lamp` |
| baseline (pristine) | `978a8375ee77b392ce11694ccee7722fd6ca4f71` |
| baseline at recovery time (main) | `6a327168dbcdf5cabe40406ba21b726c8617fb8e` |
| patches | `0001` P001, `0002` P002 (ordered, see `patches/series.txt`) |
| lab harness | `supreme-lamp-lab` branch `arena/77adac0a-supreme-lamp-lab` |
| lab-candidate run | see `manifest.json` → `verification.windows_run` |

## 무엇이 들어있나 / what is here

```
app-candidate/
  README-si.md                 this file
  manifest.json                machine-readable identity + results (schema 1)
  baseline/                    repository + immutable base commit
  patches/                     ordered series + SHA256SUMS
  reproduction/                the measured baseline failures + exact commands
  verification/                patch / feature / windows / regression matrices
  evidence/                    sanitized probe JSON copied out of the Windows run
  replay/apply-and-verify.sh   apply to a FRESH checkout, fail visibly on drift
  rollback/README.md           how to get back to the pristine tree
```

## පරීක්ෂා කළ දේ / what was actually tested

1. **Portable replay** (`replay/apply-and-verify.sh`) on a fresh clone at the
   pinned base: checksums, `git apply --check`, apply, and the 5 pinned Node
   tests → `REPLAY_OK`.
2. **Real Windows** (lab-owned `windows-latest`, `.github/workflows/app-candidate.yml`):
   the application's OWN staging function stages the pristine tree and the
   patched tree into separate roots; each server is started the way production
   starts it (Scheduled Task: no `GHRDP_BUILD_SHA`, no `GITHUB_SHA`) with the
   dashboard token written **after** the process is listening. Both directions
   of both defects are probed.

## පරීක්ෂා නොකළ දේ / what is NOT proven here

* No application workflow was dispatched and none is required for this bundle.
* No client-VM native RDP / Web Desktop / Mission Control UI run is claimed by
  this bundle; those need a fresh application-origin run (`mode=rdp`), which the
  lab cannot dispatch (403). See `docs/APP-CANDIDATE-PARITY-si.md`.
* The two patches are **server-side only**. They do not change `src/`, the UI
  bundle, TLS/NLA, the signing identity, or any credential.

## භාවිතය / how a later session uses it

```bash
# 1. verify + apply on a fresh checkout (refuses a moved base or a bad checksum)
git clone https://github.com/dictationb1/supreme-lamp.git app && cd app
git checkout 978a8375ee77b392ce11694ccee7722fd6ca4f71
../supreme-lamp-lab/app-candidate/replay/apply-and-verify.sh "$PWD"

# 2. rebuild / rerun the application's own checks for the touched area
node --test tests/p001-p002-ticket-and-version-identity.test.js

# 3. real-Windows proof (lab-owned, no upstream write):
#    run .github/workflows/app-candidate.yml in supreme-lamp-lab
```

If upstream `main` has moved: **do not apply blind**. Compare, resolve, rerun
the affected tests, and record the new base in `manifest.json`.
