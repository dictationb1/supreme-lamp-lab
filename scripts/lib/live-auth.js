'use strict';
// CURRENT-RUN AUTHORIZATION HANDOFF (live mode).
// ---------------------------------------------------------------------------
// The application mints a FRESH dash token and a fresh local RDP account for
// every run (main.yml "Create secure random RDP account" + config.json
// `dashToken`, and the token is also written to C:\ghrdp\dash-token.txt on the
// runner). A key kept in a browser from an earlier run is therefore stale by
// design. This module is what makes a live run need no paste:
//
//   1. fetch the per-run envelope over a PROTECTED channel (the origin run's
//      own Actions artifact; see lib/verify-origin + lib/record-store),
//   2. bind it to the descriptor by sha256 fingerprint,
//   3. PROVE the token is the live server's token by exercising the server's
//      own authorization gates (a non-empty localStorage proves nothing),
//   4. hand it to the visible browser through the app's supported resolver
//      (`localStorage["ghrdp.dashToken"]`, src/lib/dashToken.ts), and
//   5. launch RDP through the PRODUCTION protocol path, where the *ticket* is
//      the only secret that ever appears in a URL (src/lib/domain/native.ts).
//
// Identity separation is preserved deliberately:
//   * Mission Control dashboard authorization  -> dashToken (bearer / ?key=)
//   * Windows RDP account + password            -> NEVER in a URL, NEVER in a
//     report: obtained by the production handler redeeming a 60-second
//     single-use ticket at POST /api/rdp-creds from the client's own tailnet IP.
//   * Tailscale identity                        -> the machine's own node;
//     this module only reads `tailscale status` for the source IP.
//   * GitHub integration identity               -> the job token, used only to
//     read origin run metadata.
//
// Nothing in here logs a secret: every returned object is redacted, values are
// held in `Buffer`s where practical and cleared, and `redact.registerSecret`
// keeps them out of annotations, logs and artifacts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { request, summarize } = require('./http');
const { redact, registerSecret: redactRegister } = require('./redact');
const { envelopeMatchesDescriptor } = require('./run-descriptor');
const { extractZip, downloadArtifact, verifyArtifactProvenance } = require('./verify-origin');

const DASH_TOKEN_STORAGE_KEY = 'ghrdp.dashToken';   // mirrors src/lib/dashToken.ts
// The mstsc target stays the tailnet MagicDNS name (the application's own rule);
// an IP or an arbitrary host must never be substituted into a launch URL. Labels
// must not be empty and must not start/end with '-'; `host.ts.net` is a valid
// MagicDNS name, so the rule must not require an extra label (an earlier version
// did, which rejected real targets).
function isCgnat(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // RFC 6598 CGNAT is the only range Tailscale assigns for peer addresses.
  // Deliberately NOT 10/8, 172.16/12 or 192.168/16: a LAN address here would
  // mean someone is steering the client off the tailnet.
  return a === 100 && b >= 64 && b <= 127;
}

const TAILNET_FQDN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const FQDN_RE = new RegExp(`^${TAILNET_FQDN_LABEL}(\\.${TAILNET_FQDN_LABEL})*\\.ts\\.net\\.?$`, 'i');

/**
 * Register a secret value so every redact() call in the process masks it.
 * Lives in lib/redact's `knownSecrets()` extension point.
 */
function registerSecret(value, label = 'LIVE_RUN_SECRET') {
  const v = String(value || '');
  if (v.length >= 4) {
    if (!Array.isArray(global.__slabLiveSecrets)) global.__slabLiveSecrets = [];
    global.__slabLiveSecrets.push(v);
    try {
      const mod = require('./redact');
      if (typeof mod.registerSecret === 'function') mod.registerSecret(v, label);
    } catch (e) { /* redact module may not expose it; the split() path still masks */ }
  }
  return { registered: v.length >= 4, label, length: v.length };
}

function fp(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/**
 * Fetch + unpack the per-run credential envelope. Two transports:
 *   artifact  — the origin run's artifact (the supported cross-run handoff:
 *               run-scoped, access-controlled, 1-day retention, never a job
 *               output, never a PR comment).
 *   inline    — a file the ORIGIN signal wrote on the same machine (used by
 *               the lab's own CI self-validation, where the server job and the
 *               client job share nothing but the repository).
 * The envelope is deleted from disk as soon as it has been consumed.
 */
/**
 * Where the credential envelope lives, per the ORIGIN's own record. Resolved in
 * one place so a runner-local path can never be mistaken for a fetchable
 * transport: `inline` is only honoured when the record was written by a CI
 * self-validation harness, and `artifact` always names repo + run + attempt.
 */
function resolveTransport(record, descriptor) {
  const t = (record && record.envelope && record.envelope.transport) || null;
  const out = { kind: 'artifact', artifactName: `live-run-${descriptor.originRunId}-${descriptor.originAttempt}-envelope`, inlinePath: null, artifactRepo: descriptor.originRepo, artifactRunId: descriptor.originRunId, artifactAttempt: descriptor.originAttempt, note: '' };
  if (!t) return out;
  if (t.kind === 'inline') {
    if (!record.selfValidation) { out.note = 'RECORD_TRANSPORT_REFUSED: an inline path is only valid for a self-validation record'; out.refused = true; return out; }
    out.kind = 'inline'; out.inlinePath = t.path || null; out.note = 'inline (self-validation only)'; return out;
  }
  if (t.kind === 'artifact') {
    if (t.repository) out.artifactRepo = t.repository;
    if (t.runId) out.artifactRunId = Number(t.runId);
    if (t.attempt) out.artifactAttempt = Number(t.attempt);
    if (t.name) out.artifactName = t.name;
    out.note = `artifact ${out.artifactRepo}#${out.artifactRunId}/${out.artifactAttempt} ${out.artifactName}`;
    return out;
  }
  out.note = `RECORD_TRANSPORT_UNKNOWN: ${String(t.kind).slice(0, 40)}`;
  out.refused = true;
  return out;
}

async function fetchEnvelope({ descriptor, originRepo, artifactName, inlinePath, originArtifactRepo = null, originArtifactRunId = null, originArtifactAttempt = null, cleanupInline = true }) {
  if (inlinePath) {
    if (!fs.existsSync(inlinePath)) return { ok: false, code: 'ENVELOPE_MISSING', detail: `no envelope file at ${inlinePath}` };
    let text = '';
    try { text = fs.readFileSync(inlinePath, 'utf8'); } catch (e) { return { ok: false, code: 'ENVELOPE_UNREADABLE', detail: e.message }; }
    if (cleanupInline) { try { fs.rmSync(inlinePath, { force: true }); } catch (e) { /* the run's workspace dies anyway */ } }
    let json = null;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, code: 'ENVELOPE_UNPARSEABLE', detail: e.message }; }
    return finishEnvelope(json, descriptor, { transport: 'inline' });
  }
  // The envelope normally lives on the ORIGIN run. A lab-hosted artifact is
  // also accepted for the CI self-validation harness only, and the run it came
  // from is recorded in the report so nobody can mistake it for an
  // application-origin handoff.
  const artRepo = originArtifactRepo || originRepo;
  const artRun = originArtifactRunId || descriptor.originRunId;
  const artAttempt = originArtifactAttempt || descriptor.originAttempt;
  if (originArtifactRepo) registerSecret('lab-artifact-transport', 'TRANSPORT_NOTE');
  const prov = await verifyArtifactProvenance({ originRepo: artRepo, originRunId: artRun, originAttempt: artAttempt, name: artifactName });
  if (!prov.ok) return prov;
  const dl = await downloadArtifact({ originRepo: artRepo, originRunId: artRun, artifactId: prov.artifact.id });
  if (!dl.ok) return dl;
  let entries;
  try { entries = extractZip(dl.bytes, { maxEntries: 4, maxEntryBytes: 512 * 1024 }); }
  catch (e) { return { ok: false, code: 'ENVELOPE_ZIP_REJECTED', detail: e.message }; }
  const want = entries.find(en => path.basename(en.name) === 'envelope.json');
  if (!want) return { ok: false, code: 'ENVELOPE_ENTRY_MISSING', detail: `entries=${entries.map(x => x.name).join(',')}` };
  let json = null;
  try { json = JSON.parse(want.data.toString('utf8')); } catch (e) { return { ok: false, code: 'ENVELOPE_UNPARSEABLE', detail: e.message }; }
  return finishEnvelope(json, descriptor, { transport: artRepo === originRepo ? 'artifact' : 'lab-artifact', artifactId: prov.artifact.id, artifactRepo: artRepo, artifactRunId: artRun, archiveSha256: dl.sha256 });
}

function finishEnvelope(json, descriptor, extra) {
  if (!json || typeof json !== 'object') return { ok: false, code: 'ENVELOPE_SCHEMA', detail: 'envelope is not a JSON object' };
  const bind = envelopeMatchesDescriptor(json, descriptor);
  if (!bind.ok) return { ok: false, code: bind.code, detail: bind.detail, ...extra };
  const token = String(json.dashboardToken || '');
  if (!token) return { ok: false, code: 'ENVELOPE_TOKEN_EMPTY', detail: 'the run published no dashboard authorization', ...extra };
  registerSecret(token, 'DASH_TOKEN');
  if (json.rdpPassword) registerSecret(json.rdpPassword, 'RDP_PASSWORD');
  // The envelope must not be the only place the RDP account could be guessed:
  // the password is kept for at most one purpose (fallback launch), and the
  // primary path redeems a ticket server-side.
  return {
    ok: true, code: 'ENVELOPE_OK', ...extra,
    detail: `descriptor ${descriptor.id}, transport ${extra.transport}`,
    value: {
      dashboardToken: token,
      tokenFingerprint: fp(token),
      rdpUser: String(json.rdpUser || ''),
      rdpPassword: String(json.rdpPassword || ''),
      rdpFqdn: String(json.rdpFqdn || ''),
      rdpPort: Number(json.rdpPort || 3389),
      tailnetIp: String(json.tailnetIp || ''),
      issuedAt: String(json.issuedAt || ''),
      expiresAt: String(json.expiresAt || descriptor.expiresAt)
    }
  };
}

// ---------------------------------------------------------------------------
// THE ROUTE CONTRACT, READ FROM THE APPLICATION SOURCE (not guessed).
// payloads/ghrdp-server.ps1 @24ddaa9904c92dbbba39e3cc7aba458769e6bbe4:
//
//   POST /api/rdp-token (line ~7227) — FOUR ordered gates, four different
//   answers. Each answer names exactly one layer, so a status alone is enough
//   to say which layer refused:
//     401 'dashboard authorization required'  the BEARER did not match the
//                                             strict current credential
//     403 'direct tailnet source required'    the BEARER MATCHED; the source IP
//                                             failed Test-TicketSource
//     409 'MagicDNS FQDN missing'             bearer AND source passed; the
//                                             server's config.json dnsName is
//                                             not a *.ts.net MagicDNS name
//     200 {rid:<32 hex>, ttl:60}              a ticket was actually issued
//
//   POST /api/rdp-creds (line ~7280) — ticket redemption:
//     403 'tailnet POST required'             SOURCE policy (method or source)
//     401 'ticket invalid or expired'         ticket unknown/consumed/expired
//     409 'credential config unavailable'     config prerequisite
//     200 {fqdn,user,pass}                    redemption succeeded
//
//   GET /api/config (line ~9236) — gated by Test-CredsAllowed (line 873), which
//   returns true for EITHER a matching ?key= OR a source inside the tailnet
//   CGNAT range. Remove-CredKeys (line 2021) ALWAYS rebuilds `creds` as
//   {fqdn,user,ip} — no secret — and only the password siblings
//   (windowsPass/vncPass + their *Mask forms) are attached when allowed. So
//   "a creds object exists" is NOT credential disclosure, and a client that is
//   already authorized by SOURCE cannot demonstrate the KEY gate at all.
//
//   GET /api/search/status (line ~4538) — the refresh-aware comparator
//   (Test-GhrdpDashToken = snapshot UNION dash-token.txt UNION config.json).
//   Its 403 body carries an allowlisted reason (`details.detail`) plus
//   presentedHash/expectedHash (8 hex, published by the server itself, never a
//   value). This is what separates "the credential is stale everywhere" from
//   "the credential is current but the STRICT route disagrees".
// ---------------------------------------------------------------------------
const TICKET_RE = /^[0-9a-f]{32}$/;

// Allowlisted, non-secret body phrases -> reason codes. Only the CODE is ever
// recorded; a body is never copied into a report, an annotation or an artifact.
const TICKET_ROUTE_REASONS = [
  { match: 'dashboard authorization required', code: 'BEARER_REQUIRED', layer: 'bearer' },
  { match: 'direct tailnet source required', code: 'SOURCE_POLICY_DIRECT_TAILNET_REQUIRED', layer: 'source' },
  { match: 'MagicDNS FQDN missing', code: 'PREREQUISITE_MAGICDNS_FQDN_MISSING', layer: 'prerequisite' }
];
const REDEEM_ROUTE_REASONS = [
  { match: 'tailnet POST required', code: 'SOURCE_POLICY_TAILNET_POST_REQUIRED', layer: 'source' },
  { match: 'ticket invalid or expired', code: 'TICKET_INVALID_OR_EXPIRED', layer: 'ticket' },
  { match: 'credential config unavailable', code: 'PREREQUISITE_CREDENTIAL_CONFIG_UNAVAILABLE', layer: 'prerequisite' }
];

function reasonCode(resp, table) {
  if (!resp || resp.transport !== 'ok') return null;
  const body = String(resp.text || '').slice(0, 200);
  for (const r of table) if (body.includes(r.match)) return r.code;
  return body.trim() ? 'UNLISTED_BODY_PRESENT' : null;
}

/** One request -> one transport/bearer/source/prerequisite/issuance observation. */
function observeTicketRoute(resp, table = TICKET_ROUTE_REASONS) {
  const o = {
    status: resp ? resp.status : null,
    transport: resp ? resp.transport : 'missing',
    durationMs: resp ? resp.durationMs : null,
    reasonCode: reasonCode(resp, table),
    contentType: resp && resp.headers ? String(resp.headers['content-type'] || '').split(';')[0] : null,
    jsonParsed: Boolean(resp && resp.json),
    jsonError: resp && resp.jsonError ? String(resp.jsonError).slice(0, 80) : null
  };
  if (o.transport === 'timeout') o.layer = 'transport';
  else if (o.transport !== 'ok') o.layer = 'transport';
  else if (o.status === 401) o.layer = 'bearer';
  else if (o.status === 403) o.layer = 'source';
  else if (o.status === 409) o.layer = 'prerequisite';
  else if (o.status === 200) o.layer = 'issuance';
  else o.layer = 'unexpected';
  return o;
}

/**
 * Did the server actually ISSUE a ticket? "The credential gate was passed" is
 * not issuance: the documented success answer is 200 + rid matching
 * `^[0-9a-f]{32}$` + a numeric ttl. The value itself is never recorded.
 */
function inspectTicket(resp) {
  const j = resp && resp.json;
  const rid = j && typeof j.rid === 'string' ? j.rid : '';
  const ttl = j && j.ttl !== undefined ? Number(j.ttl) : null;
  return {
    present: rid.length > 0,
    formatOk: TICKET_RE.test(rid),
    ttl,
    ttlOk: Number.isFinite(ttl) && ttl > 0 && ttl <= 600,
    ttlIsDocumented: ttl === 60,
    value: rid // in-memory only; callers must never serialize this field
  };
}

// Password-bearing field NAMES. Only names + a masked/raw/empty classification
// are ever reported, never a value. `creds` itself is deliberately absent: the
// application rebuilds it as {fqdn,user,ip} for EVERY caller (Remove-CredKeys),
// so its presence proves nothing and previously refused every real origin.
const PASSWORD_FIELD_NAMES = ['windowsPass', 'vncPass', 'rdpPass', 'password', 'plainPassword', 'pass'];
const MASK_FIELD_NAMES = ['windowsPassMask', 'vncPassMask', 'rdpPassMask', 'passwordMask'];
const CRED_CONTAINERS = ['creds', 'rdpCreds', 'rawCreds', 'maskedCreds'];
const MASKED_SHAPE = /^\*{2,}[^\s*]{0,6}$|^\*+$/;

/**
 * Credential-disclosure observation for one /api/config answer.
 *   raw      a password-shaped field carries a real value
 *   masked   the field carries only the server's own mask (`****abcd`)
 *   empty    the field exists but carries no value
 * Presence, emptiness, masked metadata and an actual secret are FOUR different
 * observations; the lab previously treated all of them as "leaked".
 */
function credentialDisclosure(resp) {
  const out = { raw: [], masked: [], empty: [], status: resp ? resp.status : null, transport: resp ? resp.transport : 'missing' };
  const j = resp && resp.json;
  if (!j || typeof j !== 'object') return out;
  const scopes = [['', j]];
  for (const c of CRED_CONTAINERS) {
    const v = j[c];
    if (v && typeof v === 'object') scopes.push([c, v]);
  }
  for (const [prefix, obj] of scopes) {
    const name = k => (prefix ? `${prefix}.${k}` : k);
    for (const k of MASK_FIELD_NAMES) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) out.masked.push(name(k));
      else out.empty.push(name(k));
    }
    for (const k of PASSWORD_FIELD_NAMES) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (typeof v !== 'string' || v.length === 0) { out.empty.push(name(k)); continue; }
      if (MASKED_SHAPE.test(v)) out.masked.push(name(k));
      else out.raw.push(name(k));
    }
  }
  return out;
}

/**
 * The /api/config credential gate, as FIVE distinct outcomes:
 *   enforced             the password block opens only for the current-run key
 *   leaked               it opens for a caller that is neither keyed nor a peer
 *   tailnet-source-trust the caller is inside the tailnet CGNAT range, where
 *                        Test-CredsAllowed deliberately trusts the SOURCE. Not a
 *                        leak, and NOT proof of the key gate: inconclusive.
 *   masked-only          no raw password reached anybody (masks are not secrets)
 *   unsupported          this build exposes no password block at all
 */
function classifyConfigGate({ anonymous, wrongKey, ourKey, sourceIsTailnet = false } = {}) {
  const nRaw = d => ((d && d.raw) || []).length;
  const nMasked = d => ((d && d.masked) || []).length;
  const anyField = [anonymous, wrongKey, ourKey].some(d => d && (nRaw(d) + nMasked(d) + ((d && d.empty) || []).length) > 0);
  if (!anyField) return 'unsupported';
  const strangerRaw = nRaw(anonymous) + nRaw(wrongKey);
  if (strangerRaw > 0) return sourceIsTailnet ? 'tailnet-source-trust' : 'leaked';
  if (nRaw(ourKey) > 0) return 'enforced';
  if (nMasked(anonymous) + nMasked(wrongKey) + nMasked(ourKey) > 0) return 'masked-only';
  return 'unsupported';
}

/**
 * Locate the server's token-comparison ring inside /api/diag/comprehensive
 * structurally (builds nest it under different keys), never by a name a build
 * can rename. Returns booleans and lengths only - hashes stay inside.
 */
function findTokenRing(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    if (node.some(x => x && typeof x === 'object' && ('expectedHash' in x || 'presentedHash' in x))) return node;
    for (const v of node) { const r = findTokenRing(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) { const r = findTokenRing(v, depth + 1); if (r) return r; }
  }
  return null;
}

async function diagTokenEvidence(target, presentedToken) {
  const r = await request(`${target}/api/diag/comprehensive`, { timeoutMs: 20000 });
  if (r.transport !== 'ok' || !r.ok || !r.json) return { ok: false, status: r.status, transport: r.transport };
  const ring = findTokenRing(r.json) || [];
  const forRoute = ring.filter(t => String((t && t.route) || '') === '/api/rdp-token');
  const last = forRoute.length ? forRoute[forRoute.length - 1] : (ring.length ? ring[ring.length - 1] : null);
  if (!last) return { ok: true, status: r.status, entries: ring.length, matched: null };
  const mine = crypto.createHash('sha256').update(String(presentedToken || ''), 'utf8').digest('hex').slice(0, 8);
  return {
    ok: true,
    entries: ring.length,
    route: last.route || null,
    valid: last.valid === true,
    presentedLen: last.presentedLen === undefined ? null : Number(last.presentedLen),
    expectedLen: last.expectedLen === undefined ? null : Number(last.expectedLen),
    serverExpectedEqualsPublished: String(last.expectedHash || '') === mine,
    myLength: String(presentedToken || '').length
  };
}

/**
 * Is the run's credential CURRENT for the application, as distinct from
 * "accepted by the STRICT ticket route"? GET /api/search/status authenticates
 * with the refresh-aware union comparator and answers with an allowlisted
 * reason, so it separates three states the strict route alone cannot:
 *   REFRESH_AWARE_CURRENT    the credential is current (200, or the post-auth
 *                            404 UNKNOWN_SOURCE for a sentinel search id)
 *   REFRESH_AWARE_REJECTED   refused for ours too -> genuinely stale/absent
 *   REFRESH_AWARE_UNENFORCED the baselines are served too -> proves nothing
 * The route REFUSES query credentials by design, so the token goes in the
 * X-Dash-Token header only, and the search id is a nonexistent sentinel: the
 * route authenticates BEFORE it validates, so a token that passes the gate
 * answers 404 UNKNOWN_SOURCE, never 200-with-data.
 */
async function probeRefreshAwareToken(target, dashboardToken, { timeoutMs = 15000 } = {}) {
  const T = String(dashboardToken || '');
  if (!T) return { ok: false, code: 'TOKEN_ABSENT' };
  const bogus = crypto.randomBytes(16).toString('hex');
  const probeId = `lab-probe-${crypto.randomBytes(6).toString('hex')}`;
  // The server lowercases query keys (Get-RequestParts) and reads
  // $parts.query['searchid'] - the lowercase spelling is the contract.
  const url = `${target}/api/search/status?searchid=${encodeURIComponent(probeId)}`;
  const mine = crypto.createHash('sha256').update(T, 'utf8').digest('hex').slice(0, 8);
  const reasonOf = r => {
    const d = r && r.json && r.json.details;
    const detail = d && typeof d === 'object' ? String(d.detail || d.reason || '') : '';
    // allowlisted reason strings only; anything else is reported as its shape
    const allow = ['token-not-presented', 'token-mismatch-after-refresh-aware-compare', 'server-has-no-dash-token', 'searchId required', 'query credential refused'];
    return allow.includes(detail) ? detail : (detail ? 'UNLISTED_REASON' : null);
  };
  const hashEq = (r, which) => {
    const d = r && r.json && r.json.details;
    const h = d && typeof d === 'object' ? String(d[which] || '') : '';
    return h ? h === mine : null;
  };
  const ours = await request(url, { timeoutMs, headers: { 'X-Dash-Token': T } });
  const anon = await request(url, { timeoutMs });
  const forged = await request(url, { timeoutMs, headers: { 'X-Dash-Token': bogus } });
  const codeOf = r => (r && r.json && r.json.code) || null;
  // The application reports 'server-has-no-dash-token' only when BOTH the
  // presented token and the server's own token are empty - so the ANONYMOUS
  // probe is what answers "does this server hold a credential at all?".
  const serverHasNoDashToken = reasonOf(anon) === 'server-has-no-dash-token' || reasonOf(ours) === 'server-has-no-dash-token';
  const results = {
    probe: 'sentinel searchid (post-auth answer expected)',
    ours: { status: ours.status, transport: ours.transport, code: codeOf(ours), reason: reasonOf(ours), expectedHashEqualsMine: hashEq(ours, 'expectedHash'), presentedHashEqualsMine: hashEq(ours, 'presentedHash') },
    anonymous: { status: anon.status, transport: anon.transport, reason: reasonOf(anon) },
    forged: { status: forged.status, transport: forged.transport, reason: reasonOf(forged) },
    serverHasNoDashToken
  };
  if (ours.transport !== 'ok') return { ok: false, code: 'REFRESH_AWARE_UNREACHABLE', results };
  const oursAccepted = ours.status === 200 || (ours.status === 404 && codeOf(ours) === 'UNKNOWN_SOURCE');
  const refusedAnon = anon.status === 401 || anon.status === 403;
  const refusedForged = forged.status === 401 || forged.status === 403;
  if (oursAccepted && refusedAnon && refusedForged) return { ok: true, code: 'REFRESH_AWARE_CURRENT', results };
  if (!oursAccepted && (ours.status === 401 || ours.status === 403)) {
    return { ok: false, code: serverHasNoDashToken ? 'REFRESH_AWARE_SERVER_HAS_NO_TOKEN' : 'REFRESH_AWARE_REJECTED', results };
  }
  if (oursAccepted && !(refusedAnon && refusedForged)) return { ok: false, code: 'REFRESH_AWARE_UNENFORCED', results };
  return { ok: false, code: 'REFRESH_AWARE_UNPROVEN', results };
}

/**
 * PROVE authorization against the live server, LAYER BY LAYER. A rendered
 * dashboard, a hidden gate, or a localStorage entry are NOT proof, and neither
 * is a single status code: the ticket route answers four different layers with
 * four different statuses, so each layer is measured and named separately.
 *
 *   transport       did the request reach a server that answered at all
 *   bearer          did the STRICT route accept this run's credential
 *   source          did the server accept this client's direct tailnet source
 *   prerequisite    is the server configured to issue (MagicDNS FQDN)
 *   issuance        was a well-formed single-use ticket actually returned
 *   configGate      the INDEPENDENT /api/config password-disclosure policy
 *
 * Two rules this classifier must never break:
 *   * a legitimate tailnet-SOURCE authorization is not proof a bearer worked,
 *     and it must not invalidate an independent successful bearer proof;
 *   * a transport timeout is not a rejection, and passing a credential gate is
 *     not successful ticket issuance.
 */
async function proveAuthorization({ target, dashboardToken, log = () => {}, clientIsTailnetPeer = null, corroborate = true, timeoutMs = 15000 } = {}) {
  const results = {};
  const T = String(dashboardToken || '');
  if (!T) return { ok: false, code: 'TOKEN_ABSENT', subcode: 'TOKEN_ABSENT', detail: 'no current-run token to prove', results, layers: null };
  registerSecret(T, 'DASH_TOKEN');

  // Is this client a tailnet peer? That single fact decides whether an
  // anonymous /api/config answer is the application's documented SOURCE trust
  // or a genuine disclosure. Measured with `tailscale ip -4` unless injected.
  let sourceIsTailnet = false;
  let sourceDeterminedBy = 'unresolved';
  if (clientIsTailnetPeer === true || clientIsTailnetPeer === false) {
    sourceIsTailnet = clientIsTailnetPeer; sourceDeterminedBy = 'injected';
  } else {
    const ipRes = clientTailnetIp();
    sourceIsTailnet = Boolean(ipRes.ok);
    sourceDeterminedBy = ipRes.ok ? 'measured-tailscale-cli' : `unresolved(${ipRes.code})`;
  }
  results.source = { isTailnetPeer: sourceIsTailnet, determinedBy: sourceDeterminedBy };

  // --- A. the strict ticket route: three bearers, four possible answers -----
  const a1 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs, body: '{}' });
  const bogus = crypto.randomBytes(16).toString('hex');
  const a2 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs, headers: { Authorization: `Bearer ${bogus}`, 'Content-Type': 'application/json' }, body: '{}' });
  const a3 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs, headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: '{}' });
  results.noBearer = observeTicketRoute(a1);
  results.wrongBearer = observeTicketRoute(a2);
  const ticket = inspectTicket(a3);
  results.ourBearer = { ...observeTicketRoute(a3), ticketPresent: ticket.present, ticketFormatOk: ticket.formatOk, ticketTtl: ticket.ttl, ticketTtlOk: ticket.ttlOk };

  // --- B. the INDEPENDENT /api/config password-disclosure policy ------------
  const b1 = await request(`${target}/api/config`, { timeoutMs });
  const b2 = await request(`${target}/api/config?key=${encodeURIComponent(bogus)}`, { timeoutMs });
  const b3 = await request(`${target}/api/config?key=${encodeURIComponent(T)}`, { timeoutMs });
  const d1 = credentialDisclosure(b1), d2 = credentialDisclosure(b2), d3 = credentialDisclosure(b3);
  const configGate = classifyConfigGate({ anonymous: d1, wrongKey: d2, ourKey: d3, sourceIsTailnet });
  // field NAMES + classification only; no value of any kind is recorded
  results.config = {
    gate: configGate,
    sourceIsTailnet,
    anonymous: { ...d1 }, wrongKey: { ...d2 }, ourKey: { ...d3 },
    statuses: [b1.status, b2.status, b3.status],
    transports: [b1.transport, b2.transport, b3.transport]
  };

  const findings = [];
  if (configGate === 'tailnet-source-trust') {
    findings.push('APP-POLICY-01: /api/config discloses its password block to ANY source inside the tailnet CGNAT range without a key (Test-CredsAllowed, payloads/ghrdp-server.ps1:873). This client is such a peer, so the KEY gate cannot be isolated from here. Reported as inconclusive for that one gate - never as a leak, and never as proof the key worked.');
  }
  if (configGate === 'masked-only') {
    findings.push('APP-POLICY-03: /api/config served only masked password metadata (the server\'s own ****last4 form). Masked metadata is not a disclosed secret.');
  }

  const all = [a1, a2, a3, b1, b2, b3];
  const allServersDown = all.every(r => r.transport !== 'ok' || (r.status && r.status >= 500));
  const finish = (ok, code, subcode, detail, extra = {}) => ({
    ok, code, subcode: subcode || code, detail: redact(String(detail || '')).slice(0, 500),
    results, findings, layers: {
      transport: results.ourBearer.transport === 'ok' ? 'REACHABLE' : String(results.ourBearer.transport).toUpperCase(),
      bearer: extra.bearerLayer || null,
      source: extra.sourceLayer || null,
      prerequisite: extra.prerequisiteLayer || null,
      issuance: extra.issuanceLayer || null,
      configGate
    },
    configGate, configGateProven: configGate === 'enforced',
    ...(extra.out || {})
  });

  if (allServersDown) {
    return finish(false, 'LIVE_BACKEND_UNREACHABLE', all.some(r => r.transport === 'timeout') ? 'TRANSPORT_TIMEOUT_ALL' : 'NO_ANSWER_ALL', `no answer from ${target}: ${summarize(a3)}`);
  }

  const refusedNoBearer = a1.transport === 'ok' && a1.status === 401;
  const refusedWrong = a2.transport === 'ok' && a2.status === 401;
  const negativeIncomplete = [results.noBearer, results.wrongBearer].some(o => o.transport !== 'ok');
  const negativeAccepted = [a1, a2].some(r => r.transport === 'ok' && r.status === 200 && inspectTicket(r).formatOk);
  const issued = a3.transport === 'ok' && a3.status === 200 && ticket.formatOk && ticket.ttlOk;

  log(`auth proof: noBearer=${a1.status}/${a1.transport} wrongBearer=${a2.status}/${a2.transport} ourBearer=${a3.status}/${a3.transport}${issued ? ' +ticket' : ''} configGate=${configGate} tailnetPeer=${sourceIsTailnet}`);

  // 1. transport first: a timeout is NOT a rejection.
  if (a3.transport !== 'ok') {
    return finish(false, 'LIVE_TRANSPORT_INCOMPLETE', a3.transport === 'timeout' ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_ERROR',
      `POST /api/rdp-token never produced an HTTP answer (${a3.transport}: ${summarize(a3)}). This is NOT an authorization rejection: no gate was reached.`,
      { bearerLayer: 'UNMEASURED', out: { transportOnly: true } });
  }

  // 2. bearer layer: 401 is the ONLY "the credential did not match" answer.
  if (a3.status === 401) {
    let corr = null;
    if (corroborate) {
      try { corr = await probeRefreshAwareToken(target, T, { timeoutMs }); } catch (e) { corr = { ok: false, code: 'REFRESH_AWARE_ERROR' }; }
      if (corr) results.refreshAware = { code: corr.code, ok: Boolean(corr.ok), probes: corr.results || null };
      try { const dg = await diagTokenEvidence(target, T); if (dg) results.diag = dg; } catch (e) { /* telemetry is optional */ }
    }
    const rc = corr && corr.code;
    let sub = 'BEARER_REJECTED_TOKEN_NOT_CURRENT';
    let why = 'the strict ticket route compared this credential against its current value and refused it';
    if (rc === 'REFRESH_AWARE_CURRENT') {
      sub = 'STRICT_ROUTE_CREDENTIAL_DIVERGENCE';
      why = 'the credential IS current for the refresh-aware comparator (GET /api/search/status accepted it and refused anonymous+forged) but the STRICT /api/rdp-token resolver refuses it - the application published a credential its own strict route does not accept';
    } else if (rc === 'REFRESH_AWARE_SERVER_HAS_NO_TOKEN') {
      sub = 'SERVER_HAS_NO_DASH_TOKEN';
      why = 'the server reports it has NO dash token at all (server-has-no-dash-token), so no credential can be accepted';
    } else if (rc === 'REFRESH_AWARE_REJECTED') {
      sub = 'BEARER_REJECTED_TOKEN_NOT_CURRENT';
      why = 'both the strict ticket route and the refresh-aware comparator refused this credential - it is not the current run authorization';
    } else if (rc && String(rc).startsWith('REFRESH_AWARE_UN')) {
      sub = 'BEARER_REJECTED_CORROBORATION_INCONCLUSIVE';
      why = `the strict route refused this credential and the corroborating lane was inconclusive (${rc})`;
    }
    return finish(false, 'BEARER_REJECTED', sub, `${why} (POST /api/rdp-token -> 401${results.ourBearer.reasonCode ? ', reason=' + results.ourBearer.reasonCode : ''})`,
      { bearerLayer: 'REJECTED', sourceLayer: 'UNMEASURED', prerequisiteLayer: 'UNMEASURED', issuanceLayer: 'NOT_REACHED' });
  }

  // 3. source layer: 403 means the BEARER WAS ACCEPTED and the source was not.
  //    Reporting this as a stale credential is exactly the misdiagnosis that
  //    made every earlier live pass unreadable.
  if (a3.status === 403) {
    return finish(false, 'SOURCE_POLICY_REJECTED', 'BEARER_ACCEPTED_SOURCE_NOT_TAILNET',
      `the bearer credential WAS accepted (the route validated it before checking the source), but the server refused the direct source: POST /api/rdp-token -> 403${results.ourBearer.reasonCode ? ' (' + results.ourBearer.reasonCode + ')' : ''}. Test-TicketSource requires a CGNAT 100.64.0.0/10 or fd7a:115c:a1e0::/48 source. This is a ROUTING/identity problem, not a stale credential.`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'REJECTED', prerequisiteLayer: 'UNMEASURED', issuanceLayer: 'NOT_REACHED', out: { bearerAccepted: true } });
  }

  // 4. prerequisite layer: 409 means bearer AND source passed.
  if (a3.status === 409) {
    return finish(false, 'CONFIG_PREREQUISITE_MISSING', results.ourBearer.reasonCode || 'PREREQUISITE_MISSING',
      `bearer AND direct tailnet source were accepted, but the server cannot issue a ticket because its own configuration prerequisite is missing: POST /api/rdp-token -> 409${results.ourBearer.reasonCode ? ' (' + results.ourBearer.reasonCode + ')' : ''}. Authorization is proven; ticket issuance is blocked by server configuration.`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'MISSING', issuanceLayer: 'NOT_REACHED', out: { bearerAccepted: true } });
  }

  // 5. issuance layer: 200 alone is not issuance - the documented success
  //    answer is 200 + a 32-hex rid + a numeric ttl.
  if (a3.status === 200 && !issued) {
    return finish(false, 'TICKET_ISSUANCE_MALFORMED', ticket.present ? 'TICKET_FORMAT_UNEXPECTED' : 'TICKET_ABSENT_IN_200',
      `POST /api/rdp-token answered 200 but did not issue a usable ticket (present=${ticket.present} formatOk=${ticket.formatOk} ttl=${ticket.ttl} ttlOk=${ticket.ttlOk}). Passing the credential gate is NOT successful ticket issuance.`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'MALFORMED', out: { bearerAccepted: true } });
  }

  if (a3.status !== 200) {
    return finish(false, 'TICKET_ROUTE_UNEXPECTED_STATUS', `HTTP_${a3.status}`,
      `POST /api/rdp-token answered ${a3.status}, which is not one of the four documented outcomes (401 bearer / 403 source / 409 prerequisite / 200 issuance).`,
      { bearerLayer: 'UNMEASURED', issuanceLayer: 'NOT_REACHED' });
  }

  // 6. issuance happened: now the negative controls decide whether the BEARER
  //    gate is what protected it.
  if (negativeAccepted) {
    return finish(false, 'BEARER_GATE_UNENFORCED', 'ANONYMOUS_OR_FORGED_BEARER_ACCEPTED',
      `the server issued a ticket for an anonymous or forged bearer as well (noBearer=${a1.status} wrongBearer=${a2.status}) - the run is not provably authorized, it merely happens to work`,
      { bearerLayer: 'UNENFORCED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'ISSUED', out: { ticket: ticket.value, ticketTtlSec: ticket.ttl } });
  }
  if (negativeIncomplete) {
    return finish(false, 'NEGATIVE_CONTROLS_INCOMPLETE',
      [results.noBearer, results.wrongBearer].every(o => o.transport !== 'ok') ? 'BOTH_NEGATIVES_TRANSPORT_FAILED' : 'ONE_NEGATIVE_TRANSPORT_FAILED',
      `the server issued a ticket for the current-run bearer, but the negative control(s) never produced an HTTP answer (noBearer=${a1.status}/${a1.transport} wrongBearer=${a2.status}/${a2.transport}). A transport timeout is not a rejection, so the gate is not demonstrated - and it is not disproved either.`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'ISSUED', out: { ticket: ticket.value, ticketTtlSec: ticket.ttl, bearerAccepted: true, partial: true } });
  }
  if (!(refusedNoBearer && refusedWrong)) {
    return finish(false, 'NEGATIVE_CONTROLS_UNEXPECTED', `noBearer=${a1.status},wrongBearer=${a2.status}`,
      `the current-run bearer was accepted, but the negative controls answered ${a1.status}/${a2.status} instead of the documented 401`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'ISSUED', out: { ticket: ticket.value, ticketTtlSec: ticket.ttl, bearerAccepted: true } });
  }

  // 7. bearer proof stands on its own. A genuine non-tailnet disclosure is
  //    still reported as a failure - but it no longer erases the bearer result.
  const bearerDetail = `the live server validated this run's bearer, accepted the direct tailnet source, met its MagicDNS prerequisite and issued a single-use ticket (ttl=${ticket.ttl}s); anonymous and forged bearers were refused with 401`;
  if (configGate === 'leaked') {
    return finish(false, 'CREDENTIAL_GATE_LEAKED', 'PASSWORD_DISCLOSED_TO_UNAUTHORIZED_CALLER',
      `/api/config disclosed raw password field(s) (${d1.raw.concat(d2.raw).join(', ')}) to an anonymous or forged caller that is NOT a tailnet peer - authorization is not enforced on this build. Independent bearer result: PROVEN (${bearerDetail}).`,
      { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'ISSUED', out: { bearerProof: 'PROVEN', bearerDetail, ticket: ticket.value, ticketTtlSec: ticket.ttl } });
  }

  const gateNote = configGate === 'enforced' ? ' (+ the /api/config password block opened only for the current-run key)'
    : configGate === 'tailnet-source-trust' ? ' (the /api/config key gate is INCONCLUSIVE from this client: the build also trusts any tailnet source - APP-POLICY-01)'
      : configGate === 'masked-only' ? ' (only masked password metadata was served to anybody)'
        : ' (this build exposes no key-gated password block)';
  return finish(true, 'AUTHORIZATION_PROVEN', 'BEARER_SOURCE_PREREQUISITE_ISSUANCE_ALL_PASS',
    bearerDetail + gateNote,
    { bearerLayer: 'ACCEPTED', sourceLayer: 'ACCEPTED', prerequisiteLayer: 'ACCEPTED', issuanceLayer: 'ISSUED', out: { ticket: ticket.value, ticketTtlSec: ticket.ttl, bearerAccepted: true } });
}

/**
 * Mint a FRESH single-use ticket at the moment it is needed.
 *
 * The authorization proof deliberately mints its own ticket, and that ticket is
 * a 60-second single-use value: by the time a feature pass reaches the native
 * launch it has expired, and redeeming it would produce a 401 that says nothing
 * about the launch path. So every consumer mints its own, labelled with the
 * purpose it was minted for. The ticket value is never logged.
 */
async function mintTicket(target, dashboardToken, { timeoutMs = 15000, purpose = 'unspecified' } = {}) {
  const T = String(dashboardToken || '');
  if (!T) return { ok: false, code: 'TOKEN_ABSENT', purpose };
  registerSecret(T, 'DASH_TOKEN');
  const r = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs, headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: '{}' });
  const o = observeTicketRoute(r);
  const t = inspectTicket(r);
  const mintedAt = new Date().toISOString();
  if (r.transport !== 'ok') return { ok: false, code: 'TICKET_MINT_TRANSPORT_FAILED', subcode: String(r.transport).toUpperCase(), purpose, observation: o, mintedAt };
  if (r.status !== 200 || !t.formatOk || !t.ttlOk) {
    const sub = r.status === 401 ? 'BEARER_REJECTED' : r.status === 403 ? 'SOURCE_POLICY_REJECTED' : r.status === 409 ? 'CONFIG_PREREQUISITE_MISSING' : 'TICKET_MALFORMED';
    return { ok: false, code: 'TICKET_NOT_ISSUED', subcode: sub, purpose, observation: o, mintedAt };
  }
  registerSecret(t.value, 'RDP_TICKET');
  return { ok: true, code: 'TICKET_ISSUED', purpose, ticket: t.value, ttlSec: t.ttl, mintedAt, observation: o, expiresAtEpochMs: Date.now() + (t.ttl * 1000) };
}

/**
 * Redeem a ticket ONCE and classify the answer by layer. The success body
 * carries the RDP password, so this function returns NO body, NO field values
 * and NO lengths of secrets - only the layer classification the report needs.
 */
async function redeemTicket(target, ticket, { timeoutMs = 20000 } = {}) {
  const tk = String(ticket || '');
  if (!TICKET_RE.test(tk)) return { ok: false, code: 'TICKET_SHAPE_INVALID', observation: { status: null, transport: 'not-sent' } };
  registerSecret(tk, 'RDP_TICKET');
  const r = await request(`${target}/api/rdp-creds`, { method: 'POST', timeoutMs, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tk }) });
  const o = observeTicketRoute(r, REDEEM_ROUTE_REASONS);
  if (r.transport !== 'ok') return { ok: false, code: 'REDEEM_TRANSPORT_FAILED', subcode: String(r.transport).toUpperCase(), observation: o };
  if (r.status === 200) {
    // Never record the body. Register the returned password so redact() masks it
    // if it ever reaches a log by another path.
    try { if (r.json && typeof r.json.pass === 'string' && r.json.pass) registerSecret(r.json.pass, 'RDP_PASSWORD_REDEEMED'); } catch (e) { /* nothing to register */ }
    return { ok: true, code: 'TICKET_REDEEMED', observation: o, bodySuppressed: true };
  }
  if (r.status === 403) return { ok: false, code: 'REDEEM_SOURCE_POLICY_REJECTED', subcode: o.reasonCode || 'SOURCE_POLICY', observation: o };
  if (r.status === 401) return { ok: false, code: 'REDEEM_TICKET_REFUSED', subcode: o.reasonCode || 'TICKET_INVALID_OR_EXPIRED', observation: o };
  if (r.status === 409) return { ok: false, code: 'REDEEM_PREREQUISITE_MISSING', subcode: o.reasonCode || 'PREREQUISITE', observation: o };
  return { ok: false, code: 'REDEEM_UNEXPECTED_STATUS', subcode: `HTTP_${r.status}`, observation: o };
}

/**
 * The browser-side half of the handoff. The app persists a successful token in
 * `localStorage["ghrdp.dashToken"]` (src/lib/dashToken.ts §3.1), so the run can
 * be authenticated WITHOUT putting the key in the address bar. A fresh
 * per-run Chromium profile is used: no personal browser data is read or
 * copied, and the profile (which holds the token) is deleted at cleanup.
 */
function storageInitScript(token) {
  return `try { localStorage.setItem(${JSON.stringify(DASH_TOKEN_STORAGE_KEY)}, ${JSON.stringify(String(token || ''))}); } catch (e) { /* storage locked */ }`;
}

/** Clear the run's browser-local authorization (stale per-run keys must not survive). */
async function clearBrowserToken(context, target) {
  const out = { cleared: false, origin: null };
  try {
    const page = context.pages()[0] || await context.newPage();
    const origin = new URL(target).origin;
    out.origin = origin;
    // Storage access requires the origin to be loaded in this profile.
    try { await page.goto(`${origin}/favicon.ico`, { timeoutMs: 10000, waitUntil: 'domcontentloaded' }); } catch (e) { /* a 404 page still grants origin access */ }
    await page.evaluate(() => { try { localStorage.removeItem('ghrdp.dashToken'); } catch (e) { } });
    out.cleared = true;
  } catch (e) { out.error = e.message.split('\n')[0]; }
  return out;
}

/** Resolve the registered ghrdp:// handler command for THIS Windows user. */
function resolveProtocolHandler() {
  if (process.platform !== 'win32') return { registered: false, code: 'PLATFORM_NOT_WINDOWS' };
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command', '/ve'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const line = String(out).split(/\r?\n/).map(s => s.trim()).filter(s => s.includes('REG_SZ'))[0] || '';
    const cmd = line.replace(/^.*REG_SZ\s*/, '').trim();
    if (!cmd) return { registered: false, code: 'HANDLER_COMMAND_EMPTY' };
    return { registered: true, command: cmd, code: 'HANDLER_REGISTERED', bytes: Buffer.byteLength(cmd) };
  } catch (e) {
    return { registered: false, code: 'HANDLER_NOT_REGISTERED', detail: String(e.message || e).split('\n')[0] };
  }
}

/** `ghrdp://rdp?server=<fqdn>&user=<u>[&ip=<tailnetIp>]&trace=<t>&ticket=<rid>` — exactly
 *  what src/lib/domain/native.ts + sessionStore.fireAutoLogin build. */
function productionRdpUrl({ fqdn, user, tailnetIp, trace, ticket }) {
  if (!FQDN_RE.test(String(fqdn || ''))) throw new Error(`RDP_TARGET_FQDN_INVALID: ${JSON.stringify(String(fqdn).slice(0, 80))}`);
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(String(user || ''))) throw new Error('RDP_USER_INVALID');
  let u = `ghrdp://rdp?server=${encodeURIComponent(fqdn)}&user=${encodeURIComponent(user)}`;
  // Only the Tailscale CGNAT range 100.64.0.0/10 may be injected as the direct
  // source hint; anything else (a public IP, a loopback, a LAN address) is
  // dropped rather than passed through, so a forged descriptor cannot steer the
  // client's connection to an arbitrary host.
  if (tailnetIp && isCgnat(tailnetIp)) u += `&ip=${encodeURIComponent(tailnetIp)}`;
  if (trace) u += `&trace=${encodeURIComponent(trace)}`;
  if (ticket) u += `&ticket=${encodeURIComponent(ticket)}`;
  return u;
}

function mintTraceId(src = 'lab') {
  const r = crypto.randomBytes(4).toString('hex');
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);
  return `t${t}-${src}-${r}`;
}

/**
 * Launch the production protocol verb. `start` hands the URL to the registered
 * handler in the CURRENT interactive session — the same handler the dashboard
 * button invokes via window.location.href, so ticket redemption, CredWrite and
 * the mstsc spawn are the application's own code.
 *
 * mode:
 *   handler        - require the registered handler; refuse otherwise (default
 *                    for a live acceptance run: no lab-side substitution)
 *   handler-only   - same, but do not pre-mint a ticket (the handler mints its
 *                    own from the dashboard's bearer flow in production; here it
 *                    redeems the ticket we passed)
 *   lab-equivalent - the lab replicates the handler's documented sequence
 *                    (redeem -> CredWrite TERMSRV -> mstsc) so a missing
 *                    enrollment never blocks DIAGNOSIS. Reported as
 *                    SIMULATED-NOT-PRODUCTION and never as a production pass.
 */
function launchProductionHandler({ url, mode = 'handler', timeoutMs = 25000 }) {
  const handler = resolveProtocolHandler();
  if (mode === 'handler' || mode === 'handler-only') {
    if (!handler.registered) {
      return { ok: false, code: 'RDP_HANDLER_NOT_ENROLLED', detail: `${handler.code}${handler.detail ? ': ' + handler.detail : ''} — enroll with the app's production client installer (payloads/ghrdp-install.template.ps1) for this Windows account`, handler };
    }
    try {
      const r = execFileSync('cmd.exe', ['/d', '/c', 'start', '', url], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      return { ok: true, code: 'PROTOCOL_DISPATCHED', handler, detail: redact(String(r || '')).slice(0, 200) };
    } catch (e) {
      return { ok: false, code: 'PROTOCOL_DISPATCH_FAILED', detail: String(e.message || e).split('\n')[0], handler };
    }
  }
  return { ok: true, code: 'LAB_EQUIVALENT_SELECTED', handler, simulated: true, detail: 'handler path not used; the lab drives mstsc directly' };
}

/** The client's own tailnet address, read-only, for source-binding evidence. */
function clientTailnetIp() {
  const exe = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    : 'tailscale';
  try {
    const out = execFileSync(exe, ['ip', '-4'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const ip = String(out).split(/\r?\n/).map(s => s.trim()).find(s => /^(\d{1,3}\.){3}\d{1,3}$/.test(s));
    if (!ip) return { ok: false, code: 'TAILNET_IP_UNRESOLVED' };
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return { ok: false, code: 'TAILNET_IP_UNEXPECTED', detail: `${ip} is not in the CGNAT tailnet range`, ip };
    return { ok: true, ip, code: 'CLIENT_TAILNET_IP' };
  } catch (e) {
    return { ok: false, code: 'TAILSCALE_CLI_UNAVAILABLE', detail: String(e.message || e).split('\n')[0] };
  }
}

module.exports = {
  DASH_TOKEN_STORAGE_KEY, registerSecret, isCgnat, resolveTransport, fetchEnvelope, proveAuthorization,
  // the layered classifier's units, exported so regressions can pin each one
  observeTicketRoute, inspectTicket, credentialDisclosure, classifyConfigGate,
  reasonCode, findTokenRing, diagTokenEvidence, probeRefreshAwareToken,
  mintTicket, redeemTicket, TICKET_RE, TICKET_ROUTE_REASONS, REDEEM_ROUTE_REASONS,
  storageInitScript, clearBrowserToken, resolveProtocolHandler,
  productionRdpUrl, mintTraceId, launchProductionHandler, clientTailnetIp, fp
};
