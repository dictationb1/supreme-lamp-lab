# Lab harness consolidation and repairs

## H-NEW-01 — split reader and repair branches

PR #26 (`f41804b…`) contained the application-format signal reader and current harness work. Repair branch `481de98…` contained the sanitized F201 patch and replay material but only the legacy signal reader. The session branch fast-forwarded to the PR #26 head and then added the useful repair files without replacing newer harness code.

## H-NEW-02 — PR merge revision could mix candidate and old main

`pull_request` exposes a merge SHA through `github.sha`, and default checkout uses the merge ref. That does not satisfy the requirement that discovery, claim, Windows verification, and reporting execute the intended candidate revision. Every checkout in `live-run.yml` and `app-candidate.yml` is now explicitly pinned to `github.event.pull_request.head.sha || github.sha`; `claim.outputs.lab_sha` uses the same identity. A static regression rejects an unpinned checkout.

## H-NEW-03 — candidate binding was stale

The candidate workflow pointed at the previous application base and previous run directory. It now uses application SHA `4a91c5c2eadc12e5b071bc46bae7683087f56fbd` and `reports/mission-control/40051974454-1/`.

## H-NEW-04 — no short independent client preflight

A bounded preflight now measures the real client VM and performs a sanitized headed-browser interaction under the same `rdp-lab-desktop` lock used by live verification. Run `40053842579` passed that VM-only preflight. The capability server/client now resolve that same production lock; test-owned `LAB_STATE_DIR` remains isolated. Its VM verdict is independent of origin readiness/signal prerequisites. It does not claim automatic discovery, application authentication, RDP, or Web Desktop proof.

## Validation

The consolidated hosted harness suite passed 222 tests with 8 environment-dependent skips (230 total). Workflow structure validation passed. Local actionlint download was blocked by its non-allowlisted release-asset redirect; the trusted PR candidate gate remains the authoritative actionlint execution.
