# Authorization contract — what was measured, and what was NOT

**Verdict for the authorization contract on the live origin: NOT_RUN.**

Reason (measured, not assumed): the live dashboard on `100.99.208.107:7331`
accepted the TCP connection and returned no HTTP bytes within 15 s (curl exit 28,
code 000) in two independent client-VM passes 11 minutes apart. `POST /api/rdp-token`
therefore never produced a status code, so none of the contract's positive or
negative cases could be evaluated.

| case | live origin | why |
| --- | --- | --- |
| anonymous `POST /api/rdp-token` → expected 401 | NOT_RUN | no HTTP response |
| forged bearer of the same shape → expected 401 | NOT_RUN | same |
| current-run key → expected 200 `{rid}` | NOT_RUN | same |
| `/api/config?key=forged` must not return the gated creds block | NOT_RUN | same |
| tailnet-source policy (`Test-CredsAllowed`) | NOT_RUN | same |

**No claim is made that authorization is weak, strong, leaked or correct.** This
session did not observe it in either direction. Historical classifications from
run 39952421153 are NOT reused: they describe a different run, different
credentials and a different code revision.

## What was verified about identity instead (this is not authorization)

* The lab's signal reader validated `repository`, `runId`, `runAttempt`, `sha`,
  `expiresAt` (≤ 6 h + clock skew), `state == live`, a tailnet-scoped endpoint,
  the envelope algorithm (RSA-OAEP-256 + AES-256-GCM) and the AAD binding, and it
  decrypted the credential **in memory only**.
* The lab's origin verification compared the signal's identity against the
  GitHub run API six ways (`RUN_FETCHED`, `RUN_REPO_MATCH`, `RUN_WORKFLOW_MATCH`,
  `RUN_HEAD_SHA_MATCH`, `RUN_ATTEMPT_MATCH`, `RUN_IN_PROGRESS`) — all true for
  40022345749/1 at 21:31:44Z.
* The credential itself, its fingerprint, and every authenticated URL are absent
  from this bundle by construction (`publish-evidence.js` refuses them).

## Consequence for the next session

The moment the dashboard answers HTTP, re-run with the `live-verify` label; the
same harness will then execute the authorization matrix (it is implemented in
`scripts/lib/live-features.js`) and the report will carry real status codes. Do
not "fix" authorization before that measurement exists.
