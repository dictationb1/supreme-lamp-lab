# Live signal — the automatic link between an application run and the lab

Measured against the **merged** application publisher (`dictationb1/supreme-lamp`,
`scripts/live-signal-publisher.js`, F200) on 2026-10-23, application run
`39899087271` / attempt 1 / sha `c470531e4739be072daea20425a1de203d0ed326`.

## Where the payload actually is (this was the defect)

| Question | Answer (measured from the real check run) |
| --- | --- |
| check-run name | `mission-control-live-signal` |
| machine payload | **`output.text`** — a fenced ` ```json ` block (`schema: "mc-signal/v1"`) |
| human summary | `output.summary` — Markdown, **no** machine payload |
| endpoint | an **object**: `endpoint.primary = "http://100.124.43.82:7331"` (transport `tailnet-ip`) |
| credential | `credential.envelope` (mirrored as `credentialEnvelope`) — sealed, never plaintext |
| envelope algorithm | `rsa-oaep-sha256+aes-256-gcm` (the configured pair) **or** `x25519-hkdf-sha256+aes-256-gcm` |
| keyId | `rsa:<sha256(SPKI DER) hex[0:16]>` / `x25519:<sha256(raw32) hex[0:16]>` — measured `rsa:f5ae1689a220835e` |
| AAD | canonical JSON `{schema,repository,runId(string),runAttempt(number),sha,keyId}` with **sorted keys** |
| liveness | `state:"live"`, `publishedAt`, `heartbeatSec:60`, `heartbeatMaxAgeSec:180`, `expiresAt` (6 h) |
| UI identity | `ui.sha` + `ui.matchesRunSha` (measured `true` for the run SHA) |

The lab reader previously looked for its own `MC-SIGNAL v1 <base64url>` prefix in
`output.summary`. Against these real bytes that could only ever answer
`SIGNAL_NOT_FOUND`, after which discovery fell back to the run log — a transport
that cannot see a live run at all. `scripts/lib/live-signal.js` now reads the
application format from `output.text` first, and keeps the legacy lab prefix as a
documented backwards-compatible second format for the CI self-validation harness.

## Reader rules (`scripts/lib/live-signal.js`)

Accepted, in order: `mc-signal/v1` fenced JSON in `output.text`, then in
`output.summary`; then the legacy `MC-SIGNAL v1` text. Every refusal has a name:

| code | meaning |
| --- | --- |
| `APP_SIGNAL_NOT_FOUND` / `APP_SIGNAL_SCHEMA` | no fenced JSON / wrong `schema` |
| `APP_SIGNAL_NOT_LIVE` | `state` is `closed`/`failed` (a cancelled or expired run) |
| `APP_SIGNAL_STALE` | heartbeat older than `heartbeatMaxAgeSec` (dead publisher) |
| `SIGNAL_EXPIRED` / `SIGNAL_TTL_TOO_LONG` | expiry in the past / TTL beyond the ephemeral window |
| `SIGNAL_FOREIGN_REPO` / `SIGNAL_STALE_RUN` / `SIGNAL_STALE_ATTEMPT` / `SIGNAL_SHA_MISMATCH` | identity disagrees with GitHub's run metadata for the exact run+attempt |
| `SIGNAL_ENDPOINT_NOT_TAILNET` | endpoint is not CGNAT `100.64.0.0/10` or `*.ts.net` |
| `SIGNAL_UNKNOWN_KEY` | envelope `keyId` is not the configured private key's fingerprint |
| `APP_SIGNAL_AAD_MISMATCH` | the published AAD is not the canonical identity of this run |
| `APP_SIGNAL_CREDENTIAL_BINDING` | the decrypted credential's own run/sha fields disagree with the signal |
| `APP_SIGNAL_UNDECRYPTABLE` | AEAD authentication failed (wrong key or tampered envelope) |
| `SIGNAL_KEY_ALG_MISMATCH` | envelope algorithm does not match the configured key type |
| `SIGNAL_NO_PRIVATE_KEY` | `LAB_SIGNAL_PRIVATE_KEY` is not configured for this step |

Duplicate / closed / superseded check runs are tried newest-first until one
resolves; an older signal for a superseded attempt fails `SIGNAL_STALE_ATTEMPT`,
so a re-run cannot be served with attempt 1's credential.

## Keys (never rotated by the lab)

* App repository **VARIABLE** `LAB_SIGNAL_PUBKEY` — public, encryption only.
* Lab repository **SECRET** `LAB_SIGNAL_PRIVATE_KEY` — decrypt only, read from the
  environment in every step that decrypts (`discover`, `claim`,
  `candidate`, and the Windows `live` step).
* Neither is the per-run dashboard token, the RDP password or the `.rdp` signing
  certificate. The private key is never passed on a command line and never
  written to a descriptor, annotation, artifact or report.

`node scripts/live-run.js signal-status` prints presence, key type, the lab
32-hex fingerprint and the app-form `keyId`, and (when an application signal is
live) whether that `keyId` matched and the envelope decrypted — without printing
either key.

## Wake-up, honestly

* The guaranteed path is the `*/10` cron on the default branch: **up to ~10
  minutes** from publication to a queued claim, plus runner pickup. It is not
  immediate and no maximum of exactly 600 s is promised (GitHub delays scheduled
  runs under load).
* `repository_dispatch` (`mission-control.live-run`) is supported by the workflow
  but only fires if the application sets `LAB_SIGNAL_LAB_REPO` **and** a
  cross-repo secret `LAB_SIGNAL_DISPATCH_TOKEN`; an application `GITHUB_TOKEN`
  cannot write to this repository, and an Actions-created check run does not
  trigger another workflow. When those are absent the publisher logs
  `wake-up: skipped` and the schedule remains the mechanism.
* `workflow_run` is deliberately not used: by then the ephemeral server is gone.

## Lab side

* `node scripts/live-run.js discover --origin-repo dictationb1/supreme-lamp` →
  publishes one queue entry per (run, attempt).
* `node scripts/live-run.js probe --origin-run <id>` → read-only diagnostics.
* `node scripts/live-run.js live ...` runs on the interactive Windows client and
  re-derives the credential **in process** (no job output, no artifact).
