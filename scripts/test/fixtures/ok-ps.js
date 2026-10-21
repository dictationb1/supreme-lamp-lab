#!/usr/bin/env node
'use strict';
// Regression fixture: a helper that succeeds and emits a snapshot-shaped JSON
// document, used to prove stdout is retained and parsed.
// Used ONLY by scripts/run-regressions.js.
process.stdout.write(`${JSON.stringify({ platform: 'win32', currentPid: process.pid, currentSessionId: 1, processes: [], listeners: [], listenersError: null, processQueryError: null })}\n`);
