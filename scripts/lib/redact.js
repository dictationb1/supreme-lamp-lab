'use strict';
// Sanitisation helpers. Everything that may end up in a log, an annotation or
// an uploaded artifact goes through redact() first.

const PATTERNS = [
  // JWTs (three base64url segments, first one starts with eyJ)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  // GitHub tokens
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GH_TOKEN]'],
  // Tailscale keys / client secrets
  [/\btskey-[A-Za-z0-9-]{8,}\b/g, '[REDACTED_TS_KEY]'],
  // Authorization headers
  [/(authorization\s*[:=]\s*)(bearer|token|basic)?\s*[^\s"',]+/gi, '$1[REDACTED]'],
  // credentials embedded in URLs
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // common secret-bearing CLI args
  [/(--(?:authkey|id-token|client-id|client-secret|password|pass)[= ])[^\s"']+/gi, '$1[REDACTED]'],
  [/(\/pass:)[^\s"']+/gi, '$1[REDACTED]'],
  [/((?:password|passwd|secret|token)\s*[=:]\s*)[^\s"',;]+/gi, '$1[REDACTED]']
];

function redact(value, extraSecrets = []) {
  if (value === null || value === undefined) return value;
  let s = typeof value === 'string' ? value : String(value);
  for (const secret of extraSecrets) {
    if (secret && typeof secret === 'string' && secret.length >= 4) {
      s = s.split(secret).join('[REDACTED_SECRET]');
    }
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function knownSecrets() {
  const names = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'RDP_LAB_PASSWORD', 'TS_AUDIENCE', 'TS_OAUTH_CLIENT_ID'];
  return names.map(n => process.env[n]).filter(Boolean);
}

function redactDeep(obj, extraSecrets = knownSecrets()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redact(obj, extraSecrets);
  if (Array.isArray(obj)) return obj.map(v => redactDeep(v, extraSecrets));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactDeep(v, extraSecrets);
    return out;
  }
  return obj;
}

function truncate(s, max = 4000) {
  if (s === null || s === undefined) return s;
  s = String(s);
  return s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max} chars]` : s;
}

module.exports = { redact, redactDeep, knownSecrets, truncate };
