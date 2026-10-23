# rollback

The patch queue is additive and touches **one** shipped file
(`payloads/ghrdp-server.ps1`) plus one new test file. There is no migration, no
schema change, no credential rotation and no UI rebuild.

## Undo an applied queue (local candidate / lab checkout)

```bash
# reverse the queue in reverse order
git apply -R app-candidate/patches/0002-*.patch
git apply -R app-candidate/patches/0001-*.patch
# or, if the tree is disposable:
git checkout -- payloads/ghrdp-server.ps1 && rm -f tests/p001-p002-ticket-and-version-identity.test.js
```

Verify the rollback restored the pristine bytes:

```bash
git -C <checkout> status --porcelain     # must be empty
sha256sum payloads/ghrdp-server.ps1      # must equal the baseline hash in manifest.json
```

## Undo after a future deployment (application session)

1. `git revert` the merge commit in the application repository (never force-push).
2. Restart the dashboard server process so the reverted `ghrdp-server.ps1` is the
   one listening: a running process does not reload its own file.
3. Re-run the two affected checks: `POST /api/rdp-token` with the current run
   token, and `GET /api/version` `sha`.
4. Rollback is safe for consumers: the route contracts (`401`/`403`/`409`/`200`
   ordering, `{rid,ttl}` body, `{ok,server,sha,sha7}` body) are unchanged by the
   patches — only **which** token is accepted and **which** config key is read.

## What rollback does NOT do

* It does not restore a superseded dashboard token's validity. That token was
  writable by the previous run only; after rollback the boot snapshot becomes
  authoritative again, which is the pre-patch behaviour including its defect.
* It does not touch `dash-token.txt`, `config.json`, certificates or the RDP
  account.
