# exact commands

Every command below was executed in this session unless marked otherwise.

## 1. Recover + pin

```bash
git fetch origin 'refs/pull/23/head:refs/remotes/pull/23'
git rev-parse 171e7cf696b67b3fd690aee525cf18e41ef61338      # PR #23 head
git clone https://github.com/dictationb1/supreme-lamp.git app-pristine
git -C app-pristine rev-parse HEAD                            # 6a327168… (main at recovery)
git -C app-pristine checkout 978a8375ee77b392ce11694ccee7722fd6ca4f71
```

## 2. Build the candidate (isolated, local only)

```bash
cp -a app-pristine app-candidate && cd app-candidate
git checkout 978a8375ee77b392ce11694ccee7722fd6ca4f71
# edit payloads/ghrdp-server.ps1 + add tests/p001-p002-ticket-and-version-identity.test.js
node --test tests/p001-p002-ticket-and-version-identity.test.js     # 3/3 then 5/5
git format-patch -o /tmp/series --no-signature 978a8375..HEAD
```

## 3. Prove the queue applies to current main too

```bash
git -C app-pristine worktree add --detach /tmp/applytest 6a327168
cd /tmp/applytest && for f in /tmp/series/*.patch; do git apply --check "$f" && git apply "$f"; done
node --test tests/p001-p002-ticket-and-version-identity.test.js     # 5/5 on 6a327168
```

## 4. Portable replay (fresh clone, checksums + tests)

```bash
git clone /home/user/app-pristine /tmp/replaytest
git -C /tmp/replaytest checkout 978a8375ee77b392ce11694ccee7722fd6ca4f71
./app-candidate/replay/apply-and-verify.sh /tmp/replaytest
# -> applied 0001 / applied 0002 / 5 tests pass / REPLAY_OK base=978a8375… patches=2
```

## 5. Lab regressions

```bash
node scripts/run-regressions.js
# -> 241 tests: 233 passed, 0 failed, 8 skipped (linux, browser e2e optional)
```

## 6. Real Windows (lab-owned runner, application source read-only)

```bash
# triggered by pushing the queue/probe; workflow_dispatch also exists but the
# file is not on the default branch, so a push to the lab branch is the trigger
gh run list --workflow app-candidate.yml --limit 3
gh api repos/dictationb1/supreme-lamp-lab/check-runs/<job id>/annotations
```

Read the check-run annotations, not the job log: the Windows step log is served
from `productionresultssa8.blob.core.windows.net`, which this environment cannot
reach (`ENOTFOUND`/expired signature).

## 7. Narrowed paths (what did NOT work, kept for the next session)

| attempt | result | cause |
|---|---|---|
| `gh workflow run app-candidate.yml --ref <lab branch>` | HTTP 404 | a workflow file that is not on the default branch is not registered for dispatch; a filtered `push` trigger is the way |
| `git -C app-cand apply <relative path>` | patch step failed in 45 s | `-C` makes git resolve the patch path inside `app-cand`; use absolute paths |
| probe waited for `${OK_FILE}` | 240 s LISTEN_TIMEOUT with a healthy server | the payload writes `$Root\server-ok.txt` and never reads `OK_FILE` |
