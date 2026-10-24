# Live-origin MC-SIGNAL validation — read-only, run 40072158991

Observed 2026-10-24 (UTC) from the lab sandbox via the public GitHub check-runs
API against `dictationb1/supreme-lamp`. No application setting, run or endpoint
was modified. The check carries **no plaintext credential, RDP password or key
material**; the dashboard key is only present as a sealed envelope.

## 1. A live signal now exists where the prior run had none

The earlier run `40051974454` failed at rdp step 28 ("Stage files + write
config.json") and never reached publication. In run `40072158991` step 28
**succeeds**, and step 60 "Publish live Mission Control signal (MC-SIGNAL)" is
**success**. A check-run named `mission-control-live-signal` is live:

- check-run id: `120809833121`
- external_id: `dictationb1/supreme-lamp#40072158991.1` (repository `#` run `.`
  attempt — the required run/attempt binding, machine-discoverable)
- status `in_progress`, state `live`, schema `mc-signal/v1`

## 2. Field validation (all read from the check-run output JSON)

| Field | Observed | Expected | Result |
|---|---|---|---|
| repository | dictationb1/supreme-lamp | run repository | PASS |
| runId / runAttempt | 40072158991 / 1 | target run / attempt | PASS |
| sha | 832a82eb…a008a06 | run head SHA | PASS |
| ref | main | run ref | PASS |
| ui.sha | 832a82eb…a008a06 | matches run SHA | PASS |
| ui.matchesRunSha / stamped | true / true | true | PASS |
| ui.file / bytes | ui-v2.html / 1269742 | stamped single file | PASS |
| endpoint.primary | http://100.85.153.77:7331 | tailnet IP, port 7331 | PASS |
| endpoint.transport | tailnet-ip | non-public tailnet transport | PASS |
| authPathTemplate | /?key={credential} | key appended as query param | PASS |
| heartbeatSec / maxAge | 60 / 180 | fresh < 180s required | PASS |
| publishedAt / expiresAt | 08:07:19Z / 14:07:19Z | 6h ephemeral window | PASS |
| credential kind | dash-token (query `key`) | dashboard token | PASS |
| envelope alg | rsa-oaep-sha256+aes-256-gcm | hybrid RSA-OAEP + AES-GCM | PASS |
| keyId (top-level, envelope, credentialEnvelope, AAD) | rsa:f5ae1689a220835e — identical in all four | single consistent fingerprint | PASS |
| plaintext secret present | none | sealed only | PASS |

## 3. Cryptographic binding (AAD of the AES-GCM envelope, decoded)

`aadB64` decodes to:

```json
{
  "keyId": "rsa:f5ae1689a220835e",
  "repository": "dictationb1/supreme-lamp",
  "runAttempt": 1,
  "runId": "40072158991",
  "schema": "mc-signal/v1",
  "sha": "832a82eb7c29613b0b101585c56b5011ea008a06"
}
```

The GCM `tag` authenticates this AAD together with the ciphertext, so the
sealed credential is cryptographically bound to the exact repository, run,
attempt and SHA and cannot be replayed against another run. The keyId has the
expected `rsa:` + sha256(SPKI DER)[0:32] fingerprint shape produced by
`scripts/lib/live-signal.js#keyFingerprint`.

## 4. Honest boundary — what is NOT proven from this sandbox

- The integration token cannot read the application repository variable
  `LAB_SIGNAL_PUBKEY` (HTTP 403, same permission class as the self-hosted
  runner registry), so the fingerprint is validated for shape and cross-field
  consistency here, not recomputed from the registered public key.
- Decrypting the envelope (proof of possession of the matching
  `LAB_SIGNAL_PRIVATE_KEY`) requires the lab secret and is performed by the
  Windows verification path, not this sandbox.
- The endpoint `100.85.153.77:7331` is Tailscale-only. A bounded
  `curl --connect-timeout 5` from the sandbox fails with curl 28 (no route), as
  expected off-tailnet. Live endpoint reachability, token append (`?key=`) and
  the authenticated UI therefore must be observed on the tailnet-connected
  Windows client; they are recorded as **BLOCKED from the sandbox / verified on
  the VM**, never simulated.
