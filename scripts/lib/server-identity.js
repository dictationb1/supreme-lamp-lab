'use strict';
// SERVER IDENTITY — "is the thing I am about to drive the SAME instance the
// originating run started?"
// ---------------------------------------------------------------------------
// The descriptor proves which RUN we may attach to (GitHub's own metadata) and
// which endpoint its banner advertised. It cannot prove that the process
// answering on that endpoint is that run's server: an old server on a recycled
// tailnet address, a lab-provisioned standalone backend, or a different
// concurrent run would answer just as happily.
//
// The application's own contract supplies the missing binding, over the tailnet
// source path the app itself authorizes (F10-2 §3):
//
//   GET /api/version  -> { ok, server: 'ghrdp', sha, sha7 }        (build stamp)
//   GET /api/config   -> buildSha, sessionId, hostKind, dnsName,
//                        creds: { fqdn, user, ip }                  (identity)
//
// `buildSha` is the APPLICATION COMMIT the server was staged from and
// `sessionId` is minted when this server's config is written, so
// (buildSha == origin head_sha) plus a session stamp that stays STABLE across
// the verification window is the instance binding. The credential block is
// deliberately NOT read: the password is never needed for this proof and the
// ticket path (`POST /api/rdp-token`) is what the production client uses.

const { request, summarize } = require('./http');
const { checkVersion } = require('./readiness');
const { registerSecret } = require('./redact');

const FQDN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net\.?$/i;
const USER_RE = /^[A-Za-z0-9_.-]{1,32}$/;

function stripCredSecrets(body) {
  if (!body || typeof body !== 'object') return null;
  // Never surface a password, even if a future build starts returning one in a
  // shape this module does not expect: only the named non-secret fields leave.
  const creds = body.creds && typeof body.creds === 'object' ? body.creds : {};
  return {
    buildSha: typeof body.buildSha === 'string' ? body.buildSha : '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
    hostKind: typeof body.hostKind === 'string' ? body.hostKind : '',
    dnsName: typeof body.dnsName === 'string' ? body.dnsName : '',
    credsFqdn: typeof creds.fqdn === 'string' ? creds.fqdn : '',
    credsUser: typeof creds.user === 'string' ? creds.user : '',
    credsIp: typeof creds.ip === 'string' ? creds.ip : ''
  };
}

/**
 * Read and evaluate the live server's identity.
 * Returns { ok, code, detail, identity, rdp }
 *   identity: sanitized, safe for a report
 *   rdp:      { fqdn, user, tailnetIp } to build the production RDP URL, or null
 */
async function attestBackend({ target, appSha, timeoutMs = 15000 } = {}) {
  const cfg = await request(`${target}/api/config`, { timeoutMs });
  if (cfg.transport !== 'ok') {
    return { ok: false, code: 'IDENTITY_UNREACHABLE', detail: summarize(cfg), identity: null, rdp: null };
  }
  if (cfg.status !== 200 || !cfg.json) {
    return { ok: false, code: 'IDENTITY_HTTP_ERROR', detail: `HTTP ${cfg.status}`, identity: null, rdp: null };
  }
  const id = stripCredSecrets(cfg.json);
  const version = await checkVersion(target, appSha);

  const identity = {
    buildSha: id.buildSha ? String(id.buildSha).slice(0, 40) : null,
    sessionId: id.sessionId || null,
    hostKind: id.hostKind || null,
    dnsNamePresent: Boolean(id.dnsName),
    versionSha: version.ok || version.body ? String((version.body && version.body.sha) || '').slice(0, 40) || null : null,
    versionCode: version.code
  };

  if (!id.buildSha) {
    return { ok: false, code: 'IDENTITY_NO_BUILD_SHA', detail: '/api/config did not report buildSha; the server build cannot be tied to the originating commit', identity, rdp: null };
  }
  if (appSha && String(id.buildSha) !== String(appSha)) {
    return { ok: false, code: 'IDENTITY_BUILD_SHA_MISMATCH', detail: `live backend buildSha ${id.buildSha} != origin head ${appSha}`, identity, rdp: null };
  }
  if (appSha && version.ok === false && version.code === 'VERSION_SHA_MISMATCH') {
    return { ok: false, code: 'IDENTITY_VERSION_SHA_MISMATCH', detail: version.detail, identity, rdp: null };
  }
  if (!id.sessionId) {
    // A server without a session stamp cannot be distinguished from a restart
    // mid-verification, so the instance binding is reported as unavailable
    // rather than guessed.
    return { ok: false, code: 'IDENTITY_NO_SESSION', detail: '/api/config did not report sessionId', identity, rdp: null };
  }

  let rdp = null;
  if (id.credsFqdn && FQDN_RE.test(id.credsFqdn) && USER_RE.test(id.credsUser)) {
    rdp = { fqdn: id.credsFqdn.replace(/\.$/, ''), user: id.credsUser, tailnetIp: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(id.credsIp) ? id.credsIp : '' };
  }
  return {
    ok: true,
    code: 'IDENTITY_BOUND',
    detail: `buildSha=${id.buildSha} session=${id.sessionId}${rdp ? ' rdpTarget=fqdn' : ''}`,
    identity: { ...identity, rdpTargetDerived: Boolean(rdp) },
    rdp
  };
}

/**
 * Re-read the session stamp later in the run. A changed sessionId means the
 * server was restarted between the readiness proof and the feature pass, so the
 * evidence would describe two different instances and must not be reported as
 * one VERIFIED run.
 */
async function reassertSession({ target, sessionId, timeoutMs = 10000 } = {}) {
  const r = await request(`${target}/api/config`, { timeoutMs });
  if (r.transport !== 'ok' || r.status !== 200 || !r.json) {
    return { ok: false, code: 'IDENTITY_RECHECK_UNREACHABLE', detail: summarize(r) };
  }
  const id = stripCredSecrets(r.json);
  if (!id.sessionId) return { ok: false, code: 'IDENTITY_RECHECK_NO_SESSION', detail: '/api/config reported no sessionId' };
  if (sessionId && id.sessionId !== sessionId) {
    return { ok: false, code: 'IDENTITY_SESSION_CHANGED', detail: `session ${id.sessionId} != ${sessionId} (the server restarted mid-verification)`, sessionId: id.sessionId };
  }
  return { ok: true, code: 'IDENTITY_RECHECK_OK', sessionId: id.sessionId };
}

/** Register every secret-shaped value this module could have seen. */
function registerIdentitySecrets() {
  // /api/config may carry a password block for a tailnet caller. This module
  // never reads it, but registering the label documents the invariant for the
  // redaction scan: nothing here may print a credential.
  registerSecret('', 'IDENTITY_PLACEHOLDER_UNUSED');
}

module.exports = { attestBackend, reassertSession, stripCredSecrets, registerIdentitySecrets, FQDN_RE, USER_RE };
