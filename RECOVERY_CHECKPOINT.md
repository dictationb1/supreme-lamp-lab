# Recovery checkpoint

_Updated by the consolidated repair (branch `arena/3d6eff95-supreme-lamp-lab`)._

## Baseline

* lab `main` 8067e4e9b3316cbfa21115a5de112351eb67d417
* superseded PRs: #10 (5a6adce2), #11 (44479dcd, merged into the repair branch as its base), #12 (febb2197), #13 (5f9bc1cf)
* app `dictationb1/supreme-lamp`: main daf13685 (no UI bundle) → verified commit pinned in `config/app-source.json`: 978a8375ee77b392ce11694ccee7722fd6ca4f71

## Root causes found

1. **Tailscale HTTP 403** (run 39526409955, server job 118995859962): the repo's
   OIDC subject customisation is `use_immutable_subject: true`
   (`repo:dictationb1@342137832/supreme-lamp-lab@1425092794:…`); the documented
   trust-credential subject `repo:dictationb1/supreme-lamp-lab:*` cannot match.
   **Admin fix:** set the subject to
   `repo:dictationb1@342137832/supreme-lamp-lab@1425092794:*` (or narrower).
   See RUNBOOK §2.1.
2. **False PASS for Web Desktop** (any page body accepted) and **weak readiness**
   (OR-chain, missing pid/sha checks) — replaced by strict contracts.
3. **Backend on the user's machine** with untracked processes — the backend now
   runs only on the ephemeral hosted server under `backend-supervisor.js`.
4. **Non-exclusive locks / non-atomic registry / name-based cleanup** — rebuilt
   on exact `(pid, createTime)` identity (RUNBOOK §5).
5. **PR #12 regression fixture**: `execSync` while its HTTP server lived in the
   same process → blocked event loop → fake pass. Fixtures are now out of process
   and async.

## Ported from the overlapping PRs

* #10: exact-SHA source (40-hex check, no branch-archive fallback), stdout/stderr
  capture of the backend, port 7331 — **not** its OR-readiness or peer skipping.
* #11: nested fetch-cause formatting, single supervised backend step with exit
  detection and guaranteed stop, CMD `^&` escaping, `.gitignore` entries, async
  test runner with child-process fixtures.
* #12: cause-in-message diagnostics only.
* #13: `source_sha` input + exact checkout, `-Root` staging, Node in the runner
  tool cache, screenshot via a `.ps1` helper, MOCK/NOT_RUN ⇒ not success,
  `mkdir`-based lock idea.

## Evidence: PR #14, run 39542662709 attempt 1 (head a6adc76, pull_request)

Observed from check-run annotations (job logs are not retrievable from this tooling):

| Job | Result | Evidence |
|---|---|---|
| static 119033698032 | success | Node v22.23.3 win-x64 zip sha256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`, gpgv OK against nodejs/release-keys@481637f8; browser e2e required and passed; PowerShell parse of scripts + 22 workflow blocks passed; actionlint 1.7.12 (with shellcheck) passed |
| server 119034250177 | failure | OIDC `sub=repo:dictationb1@342137832/supreme-lamp-lab@1425092794:pull_request` (immutable format confirmed in CI); Tailscale join failed (exit 1) -> `tailnet_connectivity` BLOCKED; app staging step failed (statement not surfaced - fixed below) -> `backend_readiness_server_local` FAIL `STAGING_FAILED` |
| client 119034250032 | failure | runner `rdp-lab-client` `WIN-NFU1JG4VESE\User` session 1, PS 5.1.20348; `browser_synthetic` PASS (DOM asserted, 1280x720, video 64 KB); `native_screenshot` PASS (1024x768, session 1); remote capabilities BLOCKED `DEPENDS_ON_TAILNET`; 2 Windows regression failures (timing, fixed below) |
| report 119035980575 | failure | `verdict=NOT_VERIFIED`, first cause `backend_readiness_server_local: STAGING_FAILED` |

Follow-up fixes in the next commit:
- Stage-App / Install-PinnedNode / Set-RdpCredential: top-level `trap` emits the failing message and
  script:line as an `::error` annotation; the staging error is passed into the `STAGING_FAILED` reason.
- `--fail-reason`: the backend capability carries the causal FAIL, dependants are BLOCKED
  (`DEPENDS_ON_BACKEND`) instead of a second FAIL; regression test added (mutation-checked).
- Supervisor crash tests: the fixture's crash point (`CRASH_AFTER_MS`) is 12 s on Windows, because the
  PowerShell-backed identity/listener checks take seconds there and a 1.5 s crash landed in an earlier
  phase than the one asserted. Assertions now print the full phase list.
- `config/node-pin.json` records the signature-verified win-x64 hash above; the static job now
  fails if the signed SHASUMS ever disagrees with it.

## Evidence: run 39544022089 attempt 1 (head 641990d, pull_request)

- static: success (Node pin in config matched the gpgv-verified SHASUMS).
- client 119038454271: **Windows regression suite passed** on `rdp-lab-client` (timing fix confirmed);
  `browser_synthetic` PASS, `native_screenshot` PASS; remote capabilities BLOCKED `DEPENDS_ON_TAILNET`.
- server 119038454275: the new trap surfaced the staging failure:
  `[F60 stage] release ui-dist not readable @ app\scripts\f60-bootstrap.ps1:248`.
  Root cause: `Stage-F60UiBundle` is defined in BOTH app scripts with different signatures; Stage-App
  dot-sourced the transport last, so the bootstrap variant `(…, Owner, Repo, …)` was bound, `-Workspace`
  fell into `$args` (simple function), Owner was empty and the URL became `/repos//dictationb1/supreme-lamp/…`.
  Fix: transport first, stage script second, plus a `STAGE_FUNCTION_SHADOWED` signature assertion.

### App-repo finding (not fixed here - lab-only authorization)

`dictationb1/supreme-lamp` `scripts/f60-stage-and-start.ps1:435` (`Invoke-F60StageAndStart`) dot-sources
`f60-bootstrap.ps1` inside the function and then calls `Stage-F60UiBundle -Workspace … -Repo owner/name`;
inside that scope the bootstrap's same-named function shadows the intended one, so the cold lane hits the
same empty-owner URL. Suggested app fix: rename one of the two functions (e.g. `Stage-F60UiBundleFromRelease`)
or make both `[CmdletBinding()]` so a mismatched parameter throws.

## Evidence: run 39544601888 attempt 1 (head aa530d9, pull_request)

- server 119040265559: release read, sidecar download, bundle download and sha256 verification now pass;
  staging stopped at `app\scripts\f60-stage-and-start.ps1:232`:
  `Cannot find an overload for "ExtractToFile" and the argument count: "3"`.
  Root cause (app): `$entry = @($z.Entries | … | Select-Object -First 1)` is an `object[]`, passed to
  `[ZipFileExtensions]::ExtractToFile($entry, $idx, $true)`; overload resolution fails (worse on .NET 10, which
  adds a second 3-arg overload `(entry, string, ZipExtractionOptions)`). Same code in `f60-bootstrap.ps1:715`,
  unchanged at app HEAD daf13685.
- Lab fix: Stage-App keeps the app's `Stage-F60FromCheckout` and release transport, and stages the bundle by
  the app's PRODUCTION rule (`main.yml` ui-prebuilt step): exact `ui-dist-<sha>.zip` + sidecar ->
  `scripts/f59-verify-sha256.mjs` -> top-level `index.html` > 51200 bytes -> `ui\index.html` + `ui-v2.html`.

### App-repo finding 2 (not fixed here)

`[System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry[0], $idx, $true)` (or drop the `@()`), in
both `scripts/f60-stage-and-start.ps1` and `scripts/f60-bootstrap.ps1`.

## Evidence: run 39545219301 attempt 1 (head 51e0ac8, pull_request)

- server 119042286942: **staging succeeded** (`staged=38`, bundle `ui-dist-978a8375….zip` verified);
  **`backend_readiness_server_local` = PASS** (`pid=1276 port=7331 phase=ready; sha=978a8375…`) - the real
  backend is running the exact pinned commit. RDP target BLOCKED: `RDP_LAB_PASSWORD` not set.
- `dashboard_server_local` FAIL `page.getAttribute: Timeout 30000ms` - the check only knew the classic v1
  stamp `meta#ghrdpBuild`; at this app version `/` serves the **v2** bundle by default (server.ps1 F43
  `UiV2Default`), whose stamps are `meta[name=ghrdp-build]` and the React-rendered `#ghrdpBuild[data-build]`.
- Fix: variant-aware dashboard check (v1 or v2, each proving the exact SHA and a visible shell) and the F42
  `#uiV2MissingBanner` is a FAIL (`DASHBOARD_V2_NOT_STAGED`); 4 new browser e2e cases
  (v2 ok / never mounted / stale bundle SHA / not-staged banner).

## Evidence: run 39545919638 attempt 1 (head 33a3456, pull_request)

- static 119043941573: success, including the 4 new v2 dashboard browser e2e cases (real Chromium).
- server 119044505504: supervisor phases `okfile,listener,readiness,server-local-checks` all OK (pid 7984);
  **`backend_readiness_server_local` PASS** (`port=7331 phase=ready; sha=978a8375…`);
  **`dashboard_server_local` PASS** (`v2: title ok, build 978a8375ee77 (meta[name=ghrdp-build] +
  #ghrdpBuild[data-build]), app-topbar visible, screenshot 1366x820`). Job fails only at the explicit tailnet gate.
- client 119044505539: `The self-hosted runner lost communication with the server` before step 1
  (machine/network side; zero steps ran). Report: client capabilities `NOT_RUN` (`NO_RESULT`), verdict NOT_VERIFIED.
- Re-run (`/rerun`, `/rerun-failed-jobs`) and `workflow_dispatch` return HTTP 403 for this integration, so
  fresh evidence comes from new pushes; the post-merge `workflow_dispatch` must be started by a maintainer
  (`node scripts/dispatch-verification.js --ref main`), while the `push: main` trigger runs automatically.

## Remaining external actions (cannot be done from CI)

* Tailscale trust credential subject (above) — owner: tailnet admin.
* Secrets `TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE`, `RDP_LAB_PASSWORD` — owner: repo admin.
* Client tailnet policy for `tag:ci` TCP 7331/7332/3389 — owner: tailnet admin.

Until these are done, `report` returns `NOT_VERIFIED` with
`tailnet_connectivity = BLOCKED (EXTERNAL_TAILSCALE_JOIN_FAILED …)` and the
dependent remote capabilities `BLOCKED`; merge is correctly blocked.
