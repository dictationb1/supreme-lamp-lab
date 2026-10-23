#!/usr/bin/env node
'use strict';
// Regression fixture: a helper that fails fast with a non-zero exit and a
// diagnostic on stderr, used to prove stderr/exit retention.
// Used ONLY by scripts/run-regressions.js.
process.stderr.write('SIMULATED_HELPER_FAILURE: CIM provider unavailable (this is a fixture)\n');
process.exit(7);
