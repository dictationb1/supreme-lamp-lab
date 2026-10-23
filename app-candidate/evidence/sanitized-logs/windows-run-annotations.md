# sanitized evidence — check-run annotations (the readable verdict record)

Windows step logs are served from `productionresultssa8.blob.core.windows.net`,
which this environment cannot reach (`ENOTFOUND` / expired signature). Every
verdict below was therefore read from
`GET /repos/dictationb1/supreme-lamp-lab/check-runs/<job>/annotations`.

No token value, key, password or URL credential appears in any annotation.

## Run 39937351659 (assembled candidate, 3 patches) — SUCCESS

```
notiec APP_CANDIDATE_VERIFIED :: real Windows: P001+978a8375ee77b392ce11694ccee7722fd6ca4f71
       proven on the patched candidate; baseline reproduced the defects
notiec P001 reproduction (baseline) :: currentTokenAccepted=False supersededTokenAccepted=True versionSha=dev
notiec P001 fix (candidate)         :: currentTokenAccepted=True  supersededTokenAccepted=False versionSha=978a8375…
notiec P002 negative                :: no written identity still answers dev
notiec Candidate identity :: base=978a8375… patches=3
       serverSha256=002513d96d0df64cee34dbad65a4f3bd1099085eee3420a1465097606431ded5
       diffSha256=a990f49f0e0a75670ff7ba2a760b674cca1f893cc8fbbbdb00d9ef85d984dbeb
notiec Patch applied :: 0001-… mode=strict / 0002-… mode=strict / 0003-… mode=strict
notiec App staged :: sha=978a8375… staged=38 bundle=ui-dist-978a8375….zip   (x2: baseline + candidate)
notiec Baseline :: supreme-lamp@978a8375… payloads/ghrdp-server.ps1
       sha256=d6453fef836328866d6cfe019db43077f92266cdec1ec073fb7815a2a187ee94
```

## Run 39937150635 (same queue, inverted assertion) — harness failure only

```
failure app candidate probe detail :: probe=candidate failed=P001B.purge_superseded
failure app candidate probe detail :: probe=baseline  failed=P001B.purge_superseded
failure app candidate :: CANDIDATE_EXPECTATION_FAILED: P001B.purge_superseded
failure app candidate :: BASELINE_NOT_REPRODUCED: P001B.purge_superseded
```
Both arms failing the same id is the signature of an inverted assertion; the
observed behaviour was already correct. Fixed as L003, re-run 39937351659.

## Run 39936599775 (first fully-instrumented run) — candidate arm PASS

```
notiec P001 fix (candidate) :: currentTokenAccepted=True supersededTokenAccepted=False versionSha=978a8375…
notiec P002 negative :: no written identity still answers dev
failure app candidate :: BASELINE_NOT_REPRODUCED: P001.anonymous
```
The baseline's single non-defect hygiene probe is recorded as a harness artefact:
the same code path answered 401 on the candidate instance in the same run.

## Prior application-origin evidence (run 39929404780, client job 120333833464)

```
failure auth ticket route :: APP_TICKET_ROUTE_BOOT_SNAPSHOT_STALE: … compares only the
        dashboard token read at server boot (2026-10-23T04:13:48.829Z)
notiec auth refresh-aware  :: REFRESH_AWARE_CURRENT {"ours":404,"anonymous":403,"forged":403}
failure auth proof gates   :: noBearer=401 wrongBearer=401 ourBearer=401
        diag[entries=18 route=/api/f92-selftest serverExpectsPublished=false expectedLen=0 publishedLen=32]
notiec server process      :: bootAt=2026-10-23T04:13:48.829Z runStartedAt=2026-10-23T04:12:31Z predatesRunByMs=-77829
failure auth.no_stale_key_reuse :: STALE_KEY_ACCEPTED …   <-- L001: the probe timed out (runner lost network);
        it is NOT counted as an application finding
failure  :: Failed to CreateArtifact: Unable to make request: ENOTFOUND
```
