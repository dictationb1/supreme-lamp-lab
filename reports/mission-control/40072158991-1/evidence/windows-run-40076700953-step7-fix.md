# Windows real-backend run 40076700953 — step-7 failure and test-only fix

- Workflow: `.github/workflows/real-backend.yml`, PR #29, branch
  `arena/25db7e16-supreme-lamp-lab`, head lab SHA `1feb0eb0`.
- Runner (read from the job, not assumed): `rdp-lab-client WIN-NFU1JG4VESE\User`,
  interactive `session=1`.
- The GitHub job-log blob for this run returned a persistent EOF from the
  results store, so the diagnosis below uses the job's check-run **annotations**
  (the workflow emits `::notice/::error::` markers) plus a local reproduction.

## What passed before the failure

Annotations show, in order:

1. codeload download of app `832a82eb…` with the expected
   `zipSha256=c0de6455…393`.
2. All three patches applied cleanly on Windows: 0001, 0002, **0003**.
3. pnpm install completed (the job advanced to the vitest step).

## The failure (step 7, before any R2 measurement)

Annotation `app regressions FAIL: exit 1` — the command

```
npx vitest run src/tests/smoke/f201-probe-honesty.test.tsx \
  src/tests/smoke/r1-server-readiness.test.ts \
  src/tests/smoke/r2-websocket-worker.test.ts
```

exited 1, so steps 8 (PowerShell parse) and 9 (the real R2 measurement) were
skipped. This is a **lab test defect, not an R2 behavior result and not a
production-code failure**.

### Root cause (reproduced on Linux, fails identically on LF and CRLF)

The new 8th LAB-R2 assertion in `r2-websocket-worker.test.ts` used

```js
expect(server).toMatch(/Math::Max\(5,\s*\[Math\]::Min\(300/);
```

PowerShell's actual source is `[Math]::Max(5, [Math]::Min(300, …))`. The regex
omitted the leading `[Math]` qualifier (`Math::Max` is not a substring of
`[Math]::Max` because the `]` sits between `Math` and `::Max`), so the
expectation could never match. A standalone reproduction confirmed 1 failed /
7 passed with the old assertion and **8 passed / 8 failed-to-none** after the
fix, on both LF and CRLF copies of the server.

The production server already implements the correct clamp
(`payloads/ghrdp-server.ps1`, idle-timeout line
`[Math]::Max(5, [Math]::Min(300, [int]$env:GHRDP_WS_IDLE_TIMEOUT_SEC))`); no
production source was changed. The sibling MaxClients assertion already used the
correct `\[Math\]::Max\(4,…)` form and passed.

## Fix and re-verification

- One-line test correction to `/\[Math\]::Max\(5,\s*\[Math\]::Min\(300/`.
- 0003 regenerated (still 423 lines; one in-place test line; production server
  byte-identical). 0001/0002 are unchanged (same SHA-256 as the prior bundle).
- Clean-download replay (`REPLAY=1 verify-bundle.sh`) on a fresh `832a82eb`
  tree: patches apply, the exact VM vitest command is **3 files / 19 tests
  pass** (f201 8, r2 8, r1 3), and `tsc && vite build` succeeds.
- Full application suite in a consistent tree: **108 files / 1386 tests pass**
  (1378 historical + 8 R2), exit 0.
- Lab hosted regressions unchanged: 243 tests, 235 pass / 0 fail / 8 skip.

The next Windows run therefore re-enters at step 7 and, once green, proceeds to
the PowerShell parse gate and the real baseline-vs-patched R2 measurement.
