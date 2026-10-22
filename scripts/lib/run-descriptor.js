'use strict';
// LIVE-RUN DESCRIPTOR (protocol `slab-live-run/1`)
// ---------------------------------------------------------------------------
// A *versioned, non-secret* description of one live application run that the
// lab must attach to. It is the only object that decides "which backend is
// mine", so every field that later stages depend on is validated HERE, once,
// and never re-guessed downstream. There is deliberately no "find the latest
// running server" path anywhere in this file: a lookup that can attach to a
// different concurrent run is the exact failure mode this descriptor exists to
// prevent.
//
// Trust model (what each field is later checked against):
//   originRepo / originWorkflow / originRunId / originAttempt
//       -> GitHub's own run metadata for that exact run (lib/verify-origin)
//   appSha
//       -> GitHub's run head_sha, AND the live backend's /api/version stamp
//   backend.* / authorizedEndpoint
//       -> the live backend must answer on it with the matching sha
//   dashTokenFingerprint (sha256, NOT the token)
//       -> the secret is never here; it only lets a reader detect that the
//          envelope it fetched matches the descriptor it was handed
//   expiresAt
//       -> hard deadline; the lab refuses to start past it and the app's
//          server is gone by then anyway
//   correlationId
//       -> dedup key together with (originRunId, originAttempt)
//   labRevision
//       -> the lab code the origin expected to be paired with; a run launched
//          against a newer lab revision re-publishes, an older one is refused
//
// `claimant` is NOT part of the signed payload: it is the lab's own
// bookkeeping (who took this run) and lives in the claim record instead, so a
// claim can never be forged by the publisher of a descriptor.

const crypto = require('crypto');

const PROTOCOL = 'slab-live-run/1';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TTL_MS = 8 * 60 * 60 * 1000;   // a run's server is ephemeral (6h)
const MIN_TTL_MS = 60 * 1000;            // below this the queue cannot drain fairly
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CORRELATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,80}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Identity-ish tokens (backend instance, UI build, lab revision). `@` `:` `.`
// are allowed because a backend identity is intentionally composed as
// `<run>-<attempt>:<pid>@<host>` and a UI build as `ui-dist-<sha>`; shell-ish
// and path-ish characters are not.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,96}$/;

// Fields that participate in the canonical hash. Order is fixed by this array;
// adding a field is a protocol change (bump PROTOCOL).
const SIGN_FIELDS = [
  'protocol', 'originRepo', 'originWorkflow', 'originRunId', 'originAttempt',
  'appSha', 'uiBuild', 'backendIdentity', 'authorizedEndpoint', 'issuedAt',
  'expiresAt', 'labRevision', 'correlationId', 'dashTokenFingerprint',
  'clientTailnetIp', 'mode'
];

const REQUIRED = SIGN_FIELDS.slice();
// Optional signing fields: they participate in the canonical form (so a value
// cannot be swapped in transit without changing the descriptor id) but an
// absent value is legitimate — the origin does not always know the client's
// tailnet address when it advertises, and the RDP user is discovered from the
// live server instead.
const OPTIONAL = ['clientTailnetIp', 'rdpUser', 'port'];

class DescriptorError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

/** Canonical JSON: fixed key order over SIGN_FIELDS + exact string encoding. */
function canonicalize(d) {
  const parts = [];
  for (const k of SIGN_FIELDS) {
    const v = d[k];
    parts.push(`${k}=${typeof v === 'number' ? String(v) : str(v)}`);
  }
  return parts.join('|');
}

/** Deterministic fingerprint of the descriptor itself (for logs/links). */
function descriptorId(d) {
  return crypto.createHash('sha256').update(canonicalize(d)).digest('hex').slice(0, 16);
}

/** sha256 hex of a dash token. The token value is never stored or returned. */
function fingerprintToken(token) {
  const t = str(token);
  if (!t) throw new DescriptorError('TOKEN_MISSING', 'cannot fingerprint an empty token');
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex');
}

function randomCorrelationId(prefix = 'lr') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Validate a candidate descriptor. Returns a normalised copy; throws
 * DescriptorError with a machine-readable code on every rejection so the
 * caller can report WHY the run was refused instead of silently waiting.
 */
function validateDescriptor(input, { now = Date.now(), allowExpired = false, expectedProtocol = PROTOCOL } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DescriptorError('SCHEMA_INVALID', 'descriptor must be a JSON object');
  }
  const d = {};
  const errors = [];
  for (const k of REQUIRED) {
    if (OPTIONAL.includes(k)) continue;
    if (input[k] === undefined || input[k] === null || input[k] === '') errors.push(`missing ${k}`);
  }
  for (const k of OPTIONAL) if (input[k] === undefined || input[k] === null) input[k] = '';
  if (errors.length) throw new DescriptorError('SCHEMA_INCOMPLETE', errors.join('; '));

  d.protocol = str(input.protocol);
  if (d.protocol !== expectedProtocol) {
    throw new DescriptorError('PROTOCOL_UNSUPPORTED', `got ${JSON.stringify(d.protocol)}, expected ${expectedProtocol}`);
  }

  d.originRepo = str(input.originRepo);
  if (!REPO_RE.test(d.originRepo)) throw new DescriptorError('FIELD_INVALID', `originRepo=${JSON.stringify(d.originRepo)} is not owner/name`);
  for (const k of ['labRevision', 'backendIdentity', 'uiBuild']) {
    d[k] = str(input[k]);
    if (!ID_RE.test(d[k])) {
      throw new DescriptorError('FIELD_INVALID', `${k}=${JSON.stringify(d[k])} has an unsafe shape`);
    }
  }
  if (d.labRevision !== 'unknown' && !/^[0-9a-f]{40}$/.test(d.labRevision)) {
    throw new DescriptorError('LAB_REVISION_INVALID', `labRevision=${JSON.stringify(d.labRevision)} must be a 40-hex commit (the origin must name the lab code it expects to be paired with)`);
  }

  d.originWorkflow = str(input.originWorkflow);
  // Either a bare workflow file name (`main.yml`, what GITHUB_WORKFLOW gives the
  // application job) or the repository-relative path GitHub reports as
  // `run.path` (`.github/workflows/main.yml`). The trust anchor compares the
  // full path when the descriptor has one and the basename otherwise, so a
  // descriptor produced by either producer binds to the same run.
  if (!/^(?:[\w.-]+\/)*[\w .()-]{1,100}\.ya?ml$/.test(d.originWorkflow)) {
    throw new DescriptorError('FIELD_INVALID', `originWorkflow=${JSON.stringify(d.originWorkflow)}`);
  }

  d.originRunId = Number(input.originRunId);
  if (input.port !== undefined && input.port !== '') {
    d.port = Number(input.port);
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) throw new DescriptorError('FIELD_INVALID', `port=${JSON.stringify(input.port)}`);
  } else d.port = 7331;
  d.rdpUser = str(input.rdpUser);
  if (d.rdpUser && !/^[A-Za-z0-9_.-]{1,32}$/.test(d.rdpUser)) throw new DescriptorError('FIELD_INVALID', 'rdpUser has an unsafe shape');
  if (!Number.isSafeInteger(d.originRunId) || d.originRunId <= 0) {
    throw new DescriptorError('FIELD_INVALID', `originRunId=${JSON.stringify(input.originRunId)} must be a positive integer`);
  }
  d.originAttempt = Number(input.originAttempt);
  if (!Number.isInteger(d.originAttempt) || d.originAttempt < 1) {
    throw new DescriptorError('FIELD_INVALID', `originAttempt=${JSON.stringify(input.originAttempt)} must be >= 1`);
  }

  d.appSha = str(input.appSha).toLowerCase();
  if (!HEX40.test(d.appSha)) throw new DescriptorError('FIELD_INVALID', `appSha=${JSON.stringify(d.appSha)} must be 40 hex`);

  // The allowlist gate runs FIRST: an unrelated repository must be refused
  // before any of its other (possibly well-formed) fields are inspected, so a
  // forged descriptor can never reach a code path that trusts the endpoint.
  if (!Array.isArray(validateDescriptor.allowedOriginRepos) || !validateDescriptor.allowedOriginRepos.includes(str(input.originRepo))) {
    throw new DescriptorError('ORIGIN_REPO_UNTRUSTED', `originRepo=${JSON.stringify(str(input.originRepo))} is not in the allowlist`);
  }
  d.authorizedEndpoint = str(input.authorizedEndpoint);
  let url = null;
  try { url = new URL(d.authorizedEndpoint); } catch (e) { /* handled below */ }
  if (!url) throw new DescriptorError('ENDPOINT_INVALID', `authorizedEndpoint=${JSON.stringify(d.authorizedEndpoint)} is not an absolute URL`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DescriptorError('ENDPOINT_INVALID', `scheme ${url.protocol} is not supported`);
  }
  if (url.username || url.password) throw new DescriptorError('ENDPOINT_INVALID', 'endpoint must not carry userinfo');
  if (url.search || url.hash) throw new DescriptorError('ENDPOINT_INVALID', 'endpoint must not carry a query or fragment (a key must never be pre-attached)');
  // Loopback / link-local / unspecified hosts can never be reached by the
  // client VM, so a descriptor pointing at one is always a forgery or a bug —
  // and the check must NOT be relaxed later to make a local test pass.
  if (/^(localhost$|127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|\[?::1\]?$|0\.0\.0\.0$|169\.254\.\d{1,3}\.\d{1,3}$|\[?::\]?$)/i.test(url.hostname)) {
    throw new DescriptorError('ENDPOINT_LOCAL', `endpoint host ${url.hostname} is loopback/unspecified - a live run must be reachable by the client`);
  }
  d.authorizedEndpoint = `${url.protocol}//${url.host}`;

  d.issuedAt = str(input.issuedAt);
  d.expiresAt = str(input.expiresAt);
  const issuedMs = Date.parse(d.issuedAt);
  const expiresMs = Date.parse(d.expiresAt);
  if (!Number.isFinite(issuedMs)) throw new DescriptorError('FIELD_INVALID', `issuedAt=${JSON.stringify(d.issuedAt)} is not an ISO timestamp`);
  if (!Number.isFinite(expiresMs)) throw new DescriptorError('FIELD_INVALID', `expiresAt=${JSON.stringify(d.expiresAt)} is not an ISO timestamp`);
  const ttl = expiresMs - issuedMs;
  if (ttl < MIN_TTL_MS) throw new DescriptorError('TTL_TOO_SHORT', `ttl=${ttl}ms < ${MIN_TTL_MS}ms; the queue could not drain within it`);
  if (ttl > MAX_TTL_MS) throw new DescriptorError('TTL_TOO_LONG', `ttl=${ttl}ms > ${MAX_TTL_MS}ms (the origin server is ephemeral)`);
  if (expiresMs <= now) throw new DescriptorError('DESCRIPTOR_EXPIRED', `expired ${new Date(expiresMs).toISOString()} (now ${new Date(now).toISOString()})`);
  if (issuedMs > now + 120000) throw new DescriptorError('DESCRIPTOR_FROM_FUTURE', `issuedAt is >2min ahead of the verifier clock`);
  d._ttlMs = ttl;
  d._expiresMs = expiresMs;

  d.dashTokenFingerprint = str(input.dashTokenFingerprint).toLowerCase();
  if (!HEX64.test(d.dashTokenFingerprint)) {
    throw new DescriptorError('FIELD_INVALID', 'dashTokenFingerprint must be a 64-hex sha256 (the token itself must never appear in a descriptor)');
  }

  d.clientTailnetIp = str(input.clientTailnetIp);
  if (d.clientTailnetIp && !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(d.clientTailnetIp)) {
    throw new DescriptorError('FIELD_INVALID', `clientTailnetIp=${JSON.stringify(d.clientTailnetIp)}`);
  }
  if (d.clientTailnetIp && /^127\.|^(::1|\[::1\])$/.test(d.clientTailnetIp)) {
    throw new DescriptorError('FIELD_INVALID', 'clientTailnetIp must be a tailnet address, not loopback');
  }

  d.mode = str(input.mode);
  if (!['live-origin', 'origin-selftest'].includes(d.mode)) {
    throw new DescriptorError('MODE_INVALID', `mode=${JSON.stringify(d.mode)} must be live-origin or origin-selftest`);
  }

  d.correlationId = str(input.correlationId);
  if (!CORRELATION_RE.test(d.correlationId)) throw new DescriptorError('FIELD_INVALID', `correlationId=${JSON.stringify(d.correlationId)}`);

  d.id = descriptorId(d);
  delete d._ttlMs_unused;
  return d;
}

// Configured in the workflow entry point from repository settings/env, so the
// module itself never hardcodes a single tenant.
validateDescriptor.allowedOriginRepos = ['dictationb1/supreme-lamp'];
validateDescriptor.setAllowedOriginRepos = list => setAllowedOriginRepos(list);
function setAllowedOriginRepos(list) {
  validateDescriptor.allowedOriginRepos = (Array.isArray(list) ? list : str(list).split(',')).map(s => s.trim()).filter(Boolean);
  return validateDescriptor.allowedOriginRepos;
}

/** Serialise for transport (drops derived fields, keeps signing fields). */
function serializeDescriptor(d) {
  const out = {};
  for (const k of SIGN_FIELDS) out[k] = d[k];
  out.descriptorId = d.id;
  out.canonicalForm = undefined;
  delete out.canonicalForm;
  const json = JSON.stringify(out, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw new DescriptorError('SCHEMA_TOO_LARGE', `${Buffer.byteLength(json)} bytes`);
  return json;
}

/**
 * Guard that a credential envelope matches the descriptor it was fetched for.
 * The envelope holds the live secret; the descriptor holds its fingerprint.
 */
function envelopeMatchesDescriptor(envelope, descriptor) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, code: 'ENVELOPE_MISSING', detail: 'no envelope object' };
  const env = str(envelope.descriptorId);
  if (env && env !== descriptor.id) return { ok: false, code: 'ENVELOPE_DESCRIPTOR_MISMATCH', detail: `envelope descriptorId ${env} != ${descriptor.id}` };
  const fp = str(envelope.dashTokenFingerprint).toLowerCase();
  if (!fp) return { ok: false, code: 'ENVELOPE_UNFINGERPRINTED', detail: 'envelope carries no token fingerprint' };
  if (fp !== descriptor.dashTokenFingerprint) return { ok: false, code: 'ENVELOPE_TOKEN_FINGERPRINT_MISMATCH', detail: 'the envelope token is not the token this run advertised' };
  if (Number(envelope.originRunId) !== descriptor.originRunId || Number(envelope.originAttempt) !== descriptor.originAttempt) {
    return { ok: false, code: 'ENVELOPE_RUN_MISMATCH', detail: `envelope run ${envelope.originRunId}/${envelope.originAttempt}` };
  }
  return { ok: true, code: 'ENVELOPE_MATCHES', detail: descriptor.id };
}

module.exports = {
  PROTOCOL, SIGN_FIELDS, DescriptorError, validateDescriptor, serializeDescriptor,
  canonicalize, descriptorId, fingerprintToken, randomCorrelationId,
  envelopeMatchesDescriptor, setAllowedOriginRepos, MAX_TTL_MS, MIN_TTL_MS
};
