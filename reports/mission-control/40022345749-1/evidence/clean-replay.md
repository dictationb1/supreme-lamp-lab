# Clean replay result

- Date: 2026-10-23 UTC.
- Command: `bash reports/mission-control/40022345749-1/replay-candidate.sh`.
- Exit: `0`.
- App archive identity: pinned SHA `e432d3df4cf00a8528d574f8410f6a76e590db31`; archive SHA-256 is in `manifest.json`.
- Baseline reproduction: 1 file / 1 assertion passed before patch. The same old-copy assertion failed after patch for the expected reason.
- F201 regression suite: 1 file / 8 tests passed.
- Full smoke suite: 106 files / 1,375 tests passed.
- Production single-file build: passed; output is 1,273,547 bytes, SHA-256 `23719b3539ffbb311772fdf1a112016a66f9fc617688c562ed127814d54b5b4a`.
- Patch application, JSON manifest validation, and shell syntax check passed. The repository whitespace scan reports only blank-context markers required by the unified patch format; all other handoff files pass `git diff --check`.
- Existing output warnings are documented in the README. Raw console logs were not copied; they contain lengthy jsdom stack traces and are unnecessary to reproduce.
- This replay did not run the Windows server, connect to any live endpoint, authorize a backend request, or create native RDP/Web Desktop sessions.
