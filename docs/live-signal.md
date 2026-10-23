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

## Signal formats (TWO are implemented)

The reader accepts both; the writer in this lab emits the first, the merged
application publisher emits the second. **Measured 2026-10-23 (run 39952421153):
reading only the first format reported `SIGNAL_NOT_FOUND` for a correct, live
signal**, because the application's `mc-signal/v1` document sits in the check
run's `output.text` and not in `output.summary`. That is why
`lib/live-signal.js#resolveAnySignal` tries both, and why
`scripts/verify-signal-binding.js` audits either.

### A. Lab patch format — `MC-SIGNAL v1 <base64url(JSON)>` (in `output.summary`)

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

### B. Application format — `mc-signal/v1` fenced JSON (in `output.text`)

```jsonc
{
  "schema": "mc-signal/v1", "state": "live",
  "repository": "dictationb1/supreme-lamp",
  "runId": "39952421153", "runAttempt": 1,
  "sha": "<40 hex>", "ref": "main",
  "ui": { "sha": "<40 hex>", "stamped": true, "matchesRunSha": true },
  "endpoint": { "primary": "http://100.x.y.z:7331", "transport": "tailnet-ip" },
  "publishedAt": "…", "expiresAt": "…",            // hard cap 6 h
  "keyId": "rsa:<16 hex>",
  "credential": { "envelope": {
      "v": 1, "alg": "rsa-oaep-sha256+aes-256-gcm",
      "wrappedKey": "<base64>", "nonce": "<base64 12B>",
      "aadB64": "<base64 stable-stringified identity>",
      "ct": "<base64>", "tag": "<base64 16B>" } }
}
```

* The AAD is the sealed identity (`schema, repository, runId, runAttempt, sha,
  keyId`). The reader proves the published AAD really names the run it is
  auditing — a credential sealed for another run/attempt/sha is refused as
  `APP_SIGNAL_AAD_MISMATCH`.
* Decryption is RSA-OAEP-SHA256 (unwrap the CEK) + AES-256-GCM (nonce/AAD/tag).
  `x25519-hkdf-sha256+aes-256-gcm` is a **named refusal** (`APP_SIGNAL_UNSUPPORTED_ALG`)
  for the lab's RSA key, never a silent "undecryptable".
* Identity is still compared to the **run API**, never to another field of the
  document; the AAD check is an additional binding, not the source of truth.

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

## Status (measured 2026-10-23, run 39952421153)

* The application repository's **merged** publisher is
  `scripts/live-signal-publisher.js` (app commit `10cd512a`, deployed by run
  `39952421153` @ `24ddaa99`). It emits **format B** and only writes it to
  `output.text`, refreshed every 60 s, `expiresAt` = publish + 6 h.
* The lab reader used to read only `output.summary` and only format A. On a
  live, correct signal it therefore answered `SIGNAL_NOT_FOUND` — measured on
  the real check run (`mission-control-live-signal`, started 12:31:37Z,
  `external_id = dictationb1/supreme-lamp#39952421153.1`).
  `resolveAnySignal()` now accepts either format; the app's format is validated
  (identity vs the run API, published AAD vs identity, tailnet endpoint, 6 h
  cap) and decrypted with the lab key.
* `scripts/verify-signal-binding.js` audits the public binding **without** a
  private key (shape only): on this run it returned `SIGNAL_BOUND`
  (`run 39952421153/1`, sha `24ddaa99`, endpoint `http://100.87.91.3:7331`,
  `keyId rsa:f5ae1689a220835e`, AAD bound, expires 18:33:39Z).
* Regression suite: **194 tests** — 186 pass, 0 fail, 8 platform skips (Linux:
  7 browser e2e + 1 real-PowerShell); the Windows client job runs all 194.
