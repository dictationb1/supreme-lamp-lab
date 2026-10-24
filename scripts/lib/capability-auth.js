'use strict';

const crypto = require('crypto');

const PURPOSE = 'supreme-lamp-lab/capability-dashboard/v1';

/**
 * Derive a run/attempt-bound token without sending it through job outputs,
 * artifacts, branch evidence, or logs. The repository secret stays on each
 * GitHub-provided job; only the derived value is written to the disposable
 * server's protected config/token files or used in the client's browser.
 */
function deriveDashboardToken({ secret, runId, runAttempt }) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('MISSING_CONFIG: capability token derivation secret');
  if (!/^\d{1,20}$/.test(String(runId || '')) || !/^\d{1,4}$/.test(String(runAttempt || ''))) {
    throw new Error('MISSING_CONFIG: numeric run id and attempt are required');
  }
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${PURPOSE}\0${runId}\0${runAttempt}`, 'utf8')
    .digest('hex');
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex').slice(0, 16);
}

module.exports = { PURPOSE, deriveDashboardToken, tokenFingerprint };
