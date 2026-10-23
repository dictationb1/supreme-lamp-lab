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

/**
 * PROVE authorization against the live server. A rendered dashboard, a hidden
 * gate, or a localStorage entry are NOT proof. Two independent server-side
 * gates are exercised:
 *
 *   A. POST /api/rdp-token            (Test-ClientAllowed-free; constant-time
 *      bearer comparison against $Token)  no/bogus bearer -> 401, ours -> 200 {rid}
 *   B. GET /api/config?key=…          (Test-CredsAllowed)  no/bogus key -> the
 *      config WITHOUT the gated credentials block, ours -> WITH it.
 *
 * Failure classes are distinct so an operator can tell a stale key
 * (AUTHORIZATION_REJECTED) from a dead server (LIVE_BACKEND_UNREACHABLE).
 */
async function proveAuthorization({ target, dashboardToken, log = () => {} } = {}) {
  const negative = { ok: false, code: 'PROOF_INCONCLUSIVE' };
  const results = {};
  const T = String(dashboardToken || '');
  if (!T) return { ok: false, code: 'TOKEN_ABSENT', detail: 'no current-run token to prove', results };
  registerSecret(T, 'DASH_TOKEN');

  // A1: no bearer at all -> must be refused
  const a1 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs: 15000, body: '{}' });
  results.noBearer = { status: a1.status, transport: a1.transport };
  // A2: a deliberately wrong bearer -> must be refused (proves the comparison
  // is real and not "any bearer accepted")
  const bogus = crypto.randomBytes(16).toString('hex');
  const a2 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs: 15000, headers: { Authorization: `Bearer ${bogus}`, 'Content-Type': 'application/json' }, body: '{}' });
  results.wrongBearer = { status: a2.status, transport: a2.transport };
  // A3: the current-run token -> must be accepted and mint a ticket
  const a3 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs: 15000, headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: '{}' });
  results.ourBearer = { status: a3.status, transport: a3.transport, hasRid: Boolean(a3.json && a3.json.rid), ttl: a3.json && a3.json.ttl };

  // B1/B2: gated /api/config
  const b1 = await request(`${target}/api/config`, { timeoutMs: 15000 });
  const b2 = await request(`${target}/api/config?key=${encodeURIComponent(bogus)}`, { timeoutMs: 15000 });
  const b3 = await request(`${target}/api/config?key=${encodeURIComponent(T)}`, { timeoutMs: 15000 });
  const gated = r => Boolean(r && r.json && (r.json.rdpCreds || r.json.creds || r.json.rawCreds || r.json.maskedCreds));
  const hasField = r => Boolean(r && r.json && ('rdpCreds' in r.json || 'creds' in r.json || 'rawCreds' in r.json || 'maskedCreds' in r.json));
  // Three outcomes, deliberately distinct:
  //   enforced     the creds block exists and opens ONLY for the current key
  //   leaked       the creds block is served to an anonymous or forged caller
  //   unsupported  this server build does not expose the gated block at all
  const configGate = (!hasField(b1) && !hasField(b2) && !hasField(b3)) ? 'unsupported'
    : (gated(b3) && !gated(b1) && !gated(b2)) ? 'enforced' : 'leaked';
  results.config = { anonymous: gated(b1), wrongKey: gated(b2), ourKey: gated(b3), gate: configGate, statuses: [b1.status, b2.status, b3.status] };

  const allServersDown = [a1, a2, a3, b1, b2, b3].every(r => r.transport !== 'ok' || (r.status && r.status >= 500));
  if (allServersDown) {
    return { ok: false, code: 'LIVE_BACKEND_UNREACHABLE', detail: `no answer from ${target}: ${redact(summarize(a3))}`, results };
  }

  const refusedNoBearer = a1.transport === 'ok' && (a1.status === 401 || a1.status === 403);
  const refusedWrong = a2.transport === 'ok' && (a2.status === 401 || a2.status === 403);
  const accepted = a3.transport === 'ok' && a3.status === 200 && results.ourBearer.hasRid;
  const configGated = configGate === 'enforced';
  // A second gate that LEAKS is not a partial success: an anonymous caller
  // obtaining the credentials block means the run's authorization is not what
  // protects them, and a "proof" built on that would be a lie.
  const gateLeaked = configGate === 'leaked';

  log(`auth proof: noBearer=${a1.status} wrongBearer=${a2.status} ourBearer=${a3.status}${accepted ? ' +ticket' : ''} configGate=${gated(b3) ? 'gated-ok' : 'gated-miss'}`);

  if (gateLeaked) {
    return { ok: false, code: 'CREDENTIAL_GATE_LEAKED', detail: `/api/config served its gated credentials block to an anonymous or forged caller — authorization is not enforced on this build`, results };
  }
  if (accepted && refusedNoBearer && refusedWrong) {
    return {
      ok: true, code: 'AUTHORIZATION_PROVEN', results,
      detail: `the live server minted a single-use ticket for this token and refused both anonymous and forged bearers` + (configGated ? ' (+ /api/config credential gate opened only for the current-run key)' : ''),
      ticket: a3.json.rid, ticketTtlSec: Number(a3.json.ttl || 60), configGate, configGateProven: configGated
    };
  }
  if (a3.transport === 'ok' && (a3.status === 401 || a3.status === 403)) {
    return { ok: false, code: 'AUTHORIZATION_REJECTED', detail: 'the live server refused this token — it is not this run\'s dashboard authorization (stale envelope, wrong run, or rotated key)', results };
  }
  if (accepted && !(refusedNoBearer && refusedWrong)) {
    return { ok: false, code: 'AUTHORIZATION_GATE_UNENFORCED', detail: `the server's authorization gate cannot be demonstrated (noBearer=${a1.status} wrongBearer=${a2.status}) — the run is not provably authorized, it merely happens to work`, results };
  }
  return { ok: false, code: 'AUTHORIZATION_UNPROVEN', detail: `unexpected gate outcome (noBearer=${a1.status} wrong=${a2.status} ours=${a3.status})`, results };
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
  storageInitScript, clearBrowserToken, resolveProtocolHandler,
  productionRdpUrl, mintTraceId, launchProductionHandler, clientTailnetIp, fp
};
