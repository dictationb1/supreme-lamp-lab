# live application run validation — 2026-10-23T10:10–10:26Z (read-only)

| field | value |
|---|---|
| URL supplied | https://github.com/dictationb1/supreme-lamp/actions/runs/39936058717 |
| repository | `dictationb1/supreme-lamp` (confirmed from the run object) |
| workflow | `.github/workflows/main.yml` — "Windows RDP - Tailscale Mission Control (6h ephemeral)" |
| event | `workflow_dispatch` |
| run / attempt | **39936058717 / 1** |
| full SHA | `15e15ab847ad8672960b1117a51ed17b47386c81` |
| status at validation | `in_progress` (created 10:01:04Z, updated 10:02:38Z) |
| jobs completed | Preflight, build-ui (x3), ensure-f59-binaries, Verify Dependencies & Authorize Launch — all `success` |
| RDP job | id `120356350557`, `windows-latest`, **in_progress**, step **50/62 "Build and deploy WebRTC server"** |
| MC-SIGNAL | **not published yet** — step 60. No check-run for this SHA carried `output.text`, so no endpoint, credential or descriptor exists to attach to |
| readiness | the server is staged (`Stage files + write config.json` completed) and the RDP listener self-probe passed, but the live signal that carries the endpoint is later in the job |

## What was deliberately NOT done

* No attachment: no endpoint, credential, descriptor, claim or IP was derived or
  reused, and the previous run's identity (`c470531e`, descriptor expiring
  10:12:31Z) was not carried over.
* No client-VM pipeline was started, so no desktop overlap was created. A
  lab live-run sweep against this UNPATCHED build would re-measure the same
  deterministic P001 failure already recorded on run 39929404780; the scope says
  not to repeat a deterministic failure without a relevant change.

## Relationship to the candidate

Different source identity: this run is **unpatched at `15e15ab8`**. The queue was
checked against that exact SHA in a clean checkout — `git apply --check` **strict
OK** for 0001, 0002 and 0003 in order, pinned tests 6/6 — so the patches are
applicable, but nothing here proves this run is fixed.
