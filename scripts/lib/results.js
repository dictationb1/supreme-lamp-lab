'use strict';
// Persist capability results three ways so a verdict never depends on a
// single channel:
//   1. <ARTIFACT_DIR>/capabilities-<scope>.json  (uploaded artifact)
//   2. GitHub annotations (readable via the check-runs API)
//   3. $GITHUB_OUTPUT  caps_<scope>=<compact json>  (consumed by the report job)

const fs = require('fs');
const path = require('path');
const annotate = require('./annotate');
const { redactDeep } = require('./redact');
const { STATUS } = require('./status');

function artifactDir() {
  const base = process.env.ARTIFACT_DIR || path.join(process.env.RUNNER_TEMP || path.resolve(__dirname, '..', '..'), 'artifacts', `run-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function compact(caps) {
  const out = {};
  for (const [k, c] of Object.entries(caps)) out[k] = { s: c.status, r: c.reason ? String(c.reason).slice(0, 300) : null };
  return out;
}

/**
 * Write the capability bundle. `opts.dir` is honoured EXPLICITLY: a caller that
 * passes a directory means that directory. Before this, writeLiveEvidence()
 * took a `dir` argument and silently dropped it, so evidence always landed in
 * artifactDir() - identical in the common case, and a lie in every other case
 * (defect L-14, measured 2026-10-23: a probe run uploaded ZERO bytes because
 * nothing could say where the files were supposed to be).
 * Returns the absolute path written, so the caller can verify it exists.
 */
function writeCapabilities(scope, capSet, extra = {}, opts = {}) {
  const caps = typeof capSet.toJSON === 'function' ? capSet.toJSON() : capSet;
  // [L-14] `extra` is spread FIRST: it used to be spread last, so a caller that
  // passed its own `scope` (live-run.js passes report.scope, a sentence
  // describing the run) silently replaced the bundle's identity field. Anything
  // reading capabilities-*.json to find out WHICH bundle it holds was reading a
  // sentence instead. The caller's value is preserved as `runScope`.
  const doc = redactDeep({
    ...extra,
    scope,
    runScope: extra && extra.scope !== undefined ? String(extra.scope).slice(0, 300) : null,
    job: process.env.GITHUB_JOB || null,
    runId: process.env.GITHUB_RUN_ID || 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    runner: process.env.RUNNER_NAME || null,
    writtenAt: new Date().toISOString(),
    capabilities: caps
  });
  const base = opts.dir ? (fs.mkdirSync(opts.dir, { recursive: true }), opts.dir) : artifactDir();
  const file = path.join(base, `capabilities-${scope}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  if (!fs.existsSync(file)) throw new Error(`evidence write did not land: ${file}`);
  for (const [name, c] of Object.entries(doc.capabilities)) {
    // [L-16] `${name}=${status}` is NOT a safe message shape: for the capability
    // named live_authorization it renders as "live_authorization=BLOCKED", which
    // the redactor's Authorization-header pattern matches and masks, so the one
    // status a human reads in the run annotations came back as "[REDACTED]".
    // Measured 2026-10-23 in the L-14 regression run. Space-separated instead.
    const msg = `${name} status=${c.status}${c.reason ? ` :: ${c.reason}` : ''}`;
    if (c.status === STATUS.PASS) annotate.notice(`capability ${name}`, msg);
    else annotate.error(`capability ${name}`, msg);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `caps_${scope.replace(/[^a-z0-9]/gi, '_')}=${JSON.stringify(compact(doc.capabilities))}\n`);
  }
  return file;
}

module.exports = { artifactDir, writeCapabilities, compact };
