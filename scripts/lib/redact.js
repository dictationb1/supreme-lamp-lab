'use strict';
// Sanitisation helpers. Everything that may end up in a log, an annotation or
// an uploaded artifact goes through redact() first.

// Values handed to registerSecret() at runtime (a live run's dash token, an
// RDP password, a one-time ticket). Declared before redact() because redact()
// consults them by default.
const RUNTIME_SECRETS = new Set();
const RUNTIME = RUNTIME_SECRETS;

// Registered values are masked EVERYWHERE redact()/redactDeep() is used, i.e.
// every log line, annotation and artifact this lab writes; they are never in
// the environment, so a pattern list alone cannot catch them.

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
  [/((?:password|passwd|secret|token)\s*[=:]\s*)[^\s"',;]+/gi, '$1[REDACTED]'],
  // Live-run URL shapes. These are the only places a per-run dash token or a
  // single-use RDP ticket can legitimately appear in a string this lab logs, so
  // the value is masked even when it was never registered (e.g. it reached a log
  // line before registerSecret() ran).
  [/([?&#](?:key|dashToken|token)=)[^&#\s"']+/gi, '$1[REDACTED_KEY]'],
  [/([?&#](?:ticket|rid|t)=)[0-9a-f]{16,}/gi, '$1[REDACTED_TICKET]'],
  // and any `ghrdp://` verb's ticket/user pair
  [/(ghrdp:\/\/[^\s"'`]*?[?&](?:ticket|rid)=)[0-9a-f]{16,}/gi, '$1[REDACTED_TICKET]']
];

function redact(value, extraSecrets) {
  if (value === null || value === undefined) return value;
  let s = typeof value === 'string' ? value : String(value);
  // Default to the process-wide secret list (env + runtime-registered per-run
  // values). Callers must not have to remember to pass it: a single log line
  // that forgot is exactly how a per-run token ends up in a public annotation.
  const list = (Array.isArray(extraSecrets) ? extraSecrets : knownSecrets())
    .concat(Array.isArray(extraSecrets) ? extraSecrets.filter(x => !RUNTIME.has(x)) : []);
  for (const secret of list) {
    if (secret && typeof secret === 'string' && secret.length >= 4) {
      s = s.split(secret).join('[REDACTED_SECRET]');
    }
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function registerSecret(value, label = 'RUNTIME_SECRET') {
  const v = typeof value === 'string' ? value : String(value ?? '');
  if (v.length < 4) return { registered: false, reason: 'too_short', label };
  RUNTIME_SECRETS.add(v);
  return { registered: true, label, length: v.length, tracked: RUNTIME_SECRETS.size };
}
function clearRegisteredSecrets() {
  const n = RUNTIME_SECRETS.size;
  RUNTIME_SECRETS.clear();
  return n;
}
function registeredSecretCount() { return RUNTIME_SECRETS.size; }

function knownSecrets() {
  const names = ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'RDP_LAB_PASSWORD', 'TS_AUDIENCE', 'TS_OAUTH_CLIENT_ID'];
  return [...names.map(n => process.env[n]).filter(Boolean), ...RUNTIME_SECRETS];
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

module.exports = { redact, redactDeep, knownSecrets, truncate, registerSecret, clearRegisteredSecrets, registeredSecretCount };
