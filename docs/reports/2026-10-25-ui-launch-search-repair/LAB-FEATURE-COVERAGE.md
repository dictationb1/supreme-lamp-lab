# Feature coverage — requirement-to-artifact traceability (lab copy)

Source of truth for the operator's acceptance list: the application's own evidence
directory at dictationb1/supreme-lamp @ f66f9485:
docs/reports/2026-10-25-ui-launch-search-repair/ (feature-operations.md, coverage-audit.md,
REPORT-si.md, verification.md, unresolved.md, promotion.json).

This lab copy re-executes what is executable here (Node/vitest/tsc/lab regressions)
and records the rest as NOT_RUN with reasons. Nothing is inferred as PASS.

Candidate: dictationb1/supreme-lamp @ f66f9485649d5520a787d66496fffd43d8aa772a
UI build: ui/dist/index.html sha256 9315cdc8..., 1,312,534 bytes

| Requirement (operator list) | Artifact / test | Result at candidate |
|---|---|---|
| §A Single launch: one click, one attempt, one dispatch; no bounce, no iframe/anchor redispatch, no duplicate cmdkey/mstsc | src/lib/domain/dispatch.ts + src/tests/smoke/dispatch-single-attempt.test.ts (19) + launch-store-single-dispatch.test.tsx (11) | PASS (structural + unit); mstsc runtime NOT_RUN |
| §A rapid clicks / delayed responses / retries controlled | dispatch.ts attempt registry + cancelled set + TERMINAL retry gating | PASS |
| §B Cancellation: prompt dismissal, helper closure, native cancel, ticket expiry, explicit retry; no stale "wrong password"; old timers cannot overwrite | src/lib/domain/native.ts + PrimaryActions.tsx + rdp-recovery-correlation.test.ts (18) | PASS (code); browser/native dialog observation NOT_RUN |
| §C Native prompts: browser consent / unknown publisher / TLS / cmdkey fallback / credential prompt; real .rdp signature + trust | scripts/lib/dialogs.js classifyRdpAttempt + launcher-replay-contract.test.ts (4) | PASS (classification code); real .rdp signature NOT_RUN |
| §D Current-state accuracy: active vs latest vs historical; stable ages; console logons not RDP; manual Web Desktop not connectivity | src/stores/sessionStore.ts + src/lib/domain/native.ts + src/lib/launchUrl.ts + v4 incident suites | PASS (code); live session NOT_RUN |
| §E Links: Help/Actions/Secrets/docs use dictationb1/supreme-lamp; nav/back | src/lib/repoIdentity.ts + repo-identity-links.test.ts (6) | PASS |
| §F Search: awesome.re + "Programming Languages"; ChessMax/awesome-programming-languages detail; stored-source vs sourceUrl inspection; redirect/canonical host; auth/errors/empty/cancel/retry; identity after reload | src/tests/smoke/lab-inspect-endpoint.test.ts (16) + lab-inspector-2026-10-25.test.tsx (8) + src/api/lab/index.ts | PASS (contract + client HTTP); live provider smoke NOT_RUN |
| Full feature inventory: Overview, Search, Sessions, Connections, Keys & Secrets, File Explorer, Transfers, Mirror, Telemetry, Health, Collector, Settings | vitest full suite 118 files / 1535 tests | PASS (JS-operated subset); Collector real frames / RDP listener NOT_RUN |
| create/edit/save/cancel/delete, filters, refresh, pagination, previews, uploads/downloads, checksum, clipboard, diagnostic exports, settings persistence, language/theme, accessibility | vitest suite + check:contrast/check:glass-contrast/check:regression-ids/check:no-neon-green/check:bottom-bar/check:fx-ids | PASS |
| Production bundle carries no demo rows (no fx-snap-01 / Pride and Prejudice) | npm run build measured: sentinel count 0 | PASS (artifact measured) |
| Signing / NLA / TLS not weakened | No -SkipCertificateCheck, no auto-trust, no dialog automation anywhere in the diff | PASS (policy) |

Windows-only capabilities (deployment-gated, reported NOT_RUN/BLOCKED, never PASS):
- rdp_auto_login (mstsc desktop from dashboard) — NOT_RUN
- web_desktop (fresh frames + controlled interaction) — NOT_RUN
- /api/lab/inspect PowerShell runtime (both modes) — NOT_RUN (no pwsh)
- Launcher .rdp signing + unknown-publisher cause on the user's PC — NOT_RUN

Deployment: BLOCKED-403 (operator must trigger main.yml from the GitHub Actions UI; head SHA f66f9485).
