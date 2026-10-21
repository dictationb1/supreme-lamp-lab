#!/usr/bin/env node
'use strict';
// Regression fixture: a PowerShell helper that never returns, used to prove
// that the lab's helper runner enforces a bounded deadline, keeps stderr and
// reports the call site instead of blocking forever (run 39548093609 attempt 2
// hung for 30s in a synchronous helper call).
//
// Used ONLY by scripts/run-regressions.js through
//   LAB_PS_EXE=<node> LAB_PS_ARGV_PREFIX='["<this file>"]'
// It never runs in a live workflow.

process.stderr.write('HANGING_HELPER: simulated wedged PowerShell helper (this is a fixture)\n');
process.stdout.write('partial-output-before-hang\n');
// keep the process alive indefinitely; ignore graceful shutdown to prove the
// runner escalates to SIGKILL
process.on('SIGTERM', () => { process.stderr.write('HANGING_HELPER: ignoring SIGTERM\n'); });
setInterval(() => { /* wedge */ }, 1000);
