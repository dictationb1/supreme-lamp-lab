# Live signal — why the automatic link is a check run, not a log scrape

Measured 2026-10-22 against the real application repository (`dictationb1/supreme-lamp`).

| Transport | While the run is alive | After the job completes |
|---|---|---|
| `GET /repos/{o}/{r}/actions/runs/{id}/logs` | **HTTP 404** (run 39806929005, in progress) | readable zip, but the server is gone |
| `GET /repos/{o}/{r}/actions/jobs/{jobId}/logs` | **302 → `productionresultssa*.blob.core.windows.net` → HTTP 404**, six attempts, queued *and* in progress, from inside a GitHub runner (runs 39808737164, 39808861040) | readable for successful jobs (11–27 KB measured) |
| Public check-run `output.summary` | **readable live** — sentinel visible after 12 s, production reader decrypted the envelope while the publisher job was `in_progress` (run 39810624203) | readable, but marked `completed` |

Therefore zero-application-change log discovery **cannot** attach to a live run. The
lab-side implementation keeps log parsing as a fallback for finished/archival
evidence, and uses the check-run signal as the primary transport.

## Signal format

```
MC-SIGNAL v1 <base64url(JSON)>
```

```jsonc
{
  "v": 1,
  "repo": "dictationb1/supreme-lamp",
  "runId": 123456, "attempt": 2,
  "appSha": "<40 hex>", "uiBuild": "ui-dist-<sha>",
  "endpoint": "http://100.x.y.z:7331/",
  "issuedAt": "…", "expiresAt": "…",            // hard-capped at 6 h
  "enc": { "alg": "RSA-OAEP-256", "keyId": "<sha256(pubkey)[0:32]>", "ciphertext": "<base64>" }
}
```

* Identity fields are public facts; the dashboard key exists **only** as RSA-OAEP
  ciphertext under the lab public key (`LAB_SIGNAL_PUBKEY`, an app repo variable).
* The lab decrypts with `LAB_SIGNAL_PRIVATE_KEY` (lab secret) in memory; the key
  is never written to a descriptor, evidence object, annotation or report.
* `scripts/lib/live-signal.js` refuses, by name: wrong repo, wrong run, wrong
  attempt, wrong app sha, expired, TTL > 6 h, issued in the future, non-tailnet
  endpoint, unknown key id, undecryptable ciphertext.

## Publisher (application side)

`patches/app-live-signal-publisher.js` + `patches/app-live-signal-check-run.snippet.yml`.
It needs `checks: write` on the app workflow and no PAT: it uses the job's own
`GITHUB_TOKEN`. It waits up to 15 min for the server's key, republishes every
20 s, republishes again if the app rotates its dashboard key, and never fails
the RDP job.

## Lab side

* `node scripts/live-run.js signal-keygen` → prints the public key (app variable)
  and the private key (lab secret).
* `node scripts/live-run.js signal --origin-run <id>` → read/validate/decrypt one
  run's signal (sanitized output).
* `discoverOrigin()` tries the signal first, falls back to logs, and records
  `evidence.transport` + `evidence.signalFallback`.

## Status

The transport, the envelope, the publisher and the reader are implemented and
covered by regressions (155-test suite). The end-to-end **application** proof is
still missing because the app-side patch has not been merged (this token gets
HTTP 403 on writes to `dictationb1/supreme-lamp`).
