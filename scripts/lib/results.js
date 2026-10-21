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

function writeCapabilities(scope, capSet, extra = {}) {
  const caps = typeof capSet.toJSON === 'function' ? capSet.toJSON() : capSet;
  const doc = redactDeep({
    scope,
    job: process.env.GITHUB_JOB || null,
    runId: process.env.GITHUB_RUN_ID || 'local',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    runner: process.env.RUNNER_NAME || null,
    writtenAt: new Date().toISOString(),
    capabilities: caps,
    ...extra
  });
  const file = path.join(artifactDir(), `capabilities-${scope}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  for (const [name, c] of Object.entries(doc.capabilities)) {
    const msg = `${name}=${c.status}${c.reason ? ` :: ${c.reason}` : ''}`;
    if (c.status === STATUS.PASS) annotate.notice(`capability ${name}`, msg);
    else annotate.error(`capability ${name}`, msg);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `caps_${scope.replace(/[^a-z0-9]/gi, '_')}=${JSON.stringify(compact(doc.capabilities))}\n`);
  }
  return file;
}

module.exports = { artifactDir, writeCapabilities, compact };
