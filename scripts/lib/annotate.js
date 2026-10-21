'use strict';
// GitHub workflow-command annotations. Job logs and artifacts live on the
// results blob host, which some driving tools cannot reach; annotations are
// readable through api.github.com (GET /check-runs/{id}/annotations), so every
// verdict-relevant observation is also emitted here. Values are redacted.

const { redact, knownSecrets, truncate } = require('./redact');

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function emit(level, title, message) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const msg = truncate(redact(message, knownSecrets()), 3500);
  if (inActions) {
    const t = title ? ` title=${escapeProp(redact(title))}` : '';
    process.stdout.write(`::${level}${t}::${escapeData(msg)}\n`);
  } else {
    process.stdout.write(`[${level.toUpperCase()}]${title ? ' ' + title + ':' : ''} ${msg}\n`);
  }
}

module.exports = {
  notice: (title, msg) => emit('notice', title, msg),
  warning: (title, msg) => emit('warning', title, msg),
  error: (title, msg) => emit('error', title, msg),
  escapeData
};
