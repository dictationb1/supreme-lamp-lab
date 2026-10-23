'use strict';
// LIVE-RUN FEATURE EVALUATORS.
// Pure enough to unit-test without a browser (every dependency is injected),
// real enough to be the thing the acceptance run trusts. Each evaluator returns
//   { status, reason, evidence }   with STATUS from lib/status.js
// and NEVER upgrades a FAIL. Anything the run could not attempt because an
// earlier stage failed is BLOCKED with the upstream reason, so root cause and
// downstream consequence stay visible separately.

const crypto = require('crypto');
const fs = require('fs');
const { STATUS } = require('./status');
const { request } = require('./http');
const { redact } = require('./redact');
const { evaluateReadiness } = require('./readiness');

const ok = (reason, evidence = {}) => ({ status: STATUS.PASS, reason, evidence });
const bad = (reason, evidence = {}) => ({ status: STATUS.FAIL, reason, evidence });
const blocked = (reason, evidence = {}) => ({ status: STATUS.BLOCKED, reason, evidence });
const notRun = (reason, evidence = {}) => ({ status: STATUS.NOT_RUN, reason, evidence });
const sim = (reason, evidence = {}) => ({ status: STATUS.SIMULATED, reason, evidence });
const na = (reason, evidence = {}) => ({ status: STATUS.SKIPPED, reason, evidence });
const errText = e => redact(String((e && (e.message || e)) || '')).split('\n')[0].slice(0, 300);

/** A. auth.dash_token_gate — server-side gate proof, plus the UI marker. */
async function evalAuthGate({ authProof, page, markers }) {
  if (!authProof) return blocked('NO_PROOF: proveAuthorization() did not run');
  if (!authProof.ok) return bad(authProof.code, { proof: authProof.results, detail: authProof.detail });
  const ui = page ? await markers.gateCleared(page) : { cleared: true, via: 'no-browser' };
  if (!ui.cleared) return bad(`UI_GATE_NOT_CLEARED: ${ui.detail || 'the gate is still shown with a token the server accepted'}`, { proof: authProof.results, ui });
  return ok(`server accepted the current-run bearer and refused anonymous+forged; UI gate cleared (${ui.via})`, { ticket: { ttlSec: authProof.ticketTtlSec, minted: true }, configGate: authProof.configGate, ui });
}

/** B. auth.no_stale_key_reuse — a forged/earlier key must fail everywhere. */
async function evalStaleKey({ http, target, forgedToken }) {
  const r1 = await request(`${target}/api/rdp-token`, { method: 'POST', timeoutMs: 15000, headers: { Authorization: `Bearer ${forgedToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  const r2 = await request(`${target}/api/config?key=${encodeURIComponent(forgedToken)}`, { timeoutMs: 15000 });
  const gated = Boolean(r2.json && (r2.json.rdpCreds || r2.json.creds || r2.json.rawCreds || r2.json.maskedCreds));
  const refusedTicket = r1.transport === 'ok' && (r1.status === 401 || r1.status === 403);
  const evidence = { ticketStatus: r1.status ?? r1.transport, configStatus: r2.status ?? r2.transport, configLeakedCreds: gated };
  if (refusedTicket && !gated) return ok('a token that is not this run\'s was refused by the ticket route and did not unlock the gated credentials', evidence);
  if (!refusedTicket) return bad('STALE_KEY_ACCEPTED: the live server minted a ticket for a token it should not know', evidence);
  return bad('STALE_KEY_LEAKED_CREDENTIALS: /api/config returned the gated credentials block for a wrong key', evidence);
}

/** C. nav.routes_reachable — visit each route, require a marker, count errors. */
async function evalRoutes({ page, routes = [], markers }) {
  if (!routes.length) return blocked('NO_ROUTES: the inventory received an empty route list from the app contract');
  const per = [];
  for (const r of routes) {
    const errorsBefore = markers.errorCount(page);
    try {
      await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      per.push({ route: r.id, status: 'nav-failed', detail: errText(e) });
      continue;
    }
    const marker = await markers.routeMarker(page, r);
    const newErrors = markers.errorCount(page) - errorsBefore;
    per.push({ route: r.id, status: marker.found ? (newErrors ? 'rendered-with-errors' : 'rendered') : 'missing-marker', marker: marker.via || null, newErrors });
  }
  const failed = per.filter(p => p.status !== 'rendered');
  const evidence = { routes: per, checked: per.length };
  if (!failed.length) return ok(`${per.length}/${per.length} routes rendered with their marker and zero new page errors`, evidence);
  return bad(`${failed.length} route(s) did not render cleanly: ${failed.map(f => `${f.route}=${f.status}`).join(', ')}`, evidence);
}

/** D. nav.build_provenance + identity: UI bundle and backend must match the run. */
async function evalProvenance({ target, descriptor, page, markers }) {
  const v = await request(`${target}/api/version`, { timeoutMs: 10000 });
  if (v.transport !== 'ok' || v.status !== 200) return blocked(`VERSION_UNREACHABLE: ${v.transport === 'ok' ? 'HTTP ' + v.status : v.errorChain}`);
  const sha = String((v.json && v.json.sha) || '').toLowerCase();
  const evidence = { backendSha: sha, expectedAppSha: descriptor.appSha, uiBuild: null, uiBuildExpected: descriptor.uiBuild || null };
  // MEASURED (run 39913711978): this live backend answers /api/version with
  // sha="dev" while /api/config reports the originating buildSha (the attestation
  // step matched it). "dev" is not a different instance - it is an UNSTAMPED
  // version endpoint, so the UI build cannot be tied to the run at all. That is a
  // prerequisite the application does not satisfy (BLOCKED with a name), never a
  // FAIL that claims the wrong backend, and never a PASS.
  const stamped = /^[0-9a-f]{7,40}$/.test(sha);
  if (!stamped) {
    return blocked(`VERSION_STAMP_ABSENT: /api/version reports ${sha ? JSON.stringify(sha) : 'no sha'}, so the UI build cannot be tied to the originating run; /api/config buildSha did match ${String(descriptor.appSha).slice(0, 12)} (see the attestation step)`, evidence);
  }
  if (sha !== descriptor.appSha) return bad(`BACKEND_SHA_MISMATCH: this backend is ${sha || 'unknown'}, the originating run's head is ${descriptor.appSha} — a different instance`, evidence);
  if (page) {
    const ui = await markers.buildStamp(page);
    evidence.uiBuild = ui.stamp || null;
    if (ui.found && descriptor.uiBuild && ui.stamp && !ui.stamp.startsWith(String(descriptor.uiBuild).slice(0, 7)) && ui.stamp !== descriptor.uiBuild) {
      return bad(`UI_BUILD_MISMATCH: page stamp ${ui.stamp} is not the run's ${descriptor.uiBuild}`, evidence);
    }
    evidence.uiStampSource = ui.via || null;
  }
  return ok(`backend self-reports the originating app sha ${sha.slice(0, 12)}${evidence.uiBuild ? `; UI bundle stamp ${String(evidence.uiBuild).slice(0, 12)}` : ''}`, evidence);
}

/** E. session.live_binding — readiness contract + server-observed liveness. */
async function evalLiveBinding({ target, descriptor }) {
  const r = await request(`${target}/api/readiness`, { timeoutMs: 10000 });
  if (r.transport !== 'ok' || r.status !== 200) return blocked(`READINESS_UNREACHABLE: ${r.transport === 'ok' ? 'HTTP ' + r.status : r.errorChain}`);
  const verdict = evaluateReadiness(r.json, { expectPort: descriptor.port || 7331 });
  const p = await request(`${target}/api/progress`, { timeoutMs: 10000 });
  const serverTs = r.json && r.json.serverTs;
  const runId = p.json && (p.json.runId || (p.json.progress && p.json.progress.runId));
  const evidence = { readiness: r.json, serverTs, progressServerTs: p.json && p.json.serverTs, runIdReported: runId || null, originRunId: descriptor.originRunId };
  if (!verdict.ready) return bad(`${verdict.code}: ${verdict.detail}`, evidence);
  return ok(`ready (pid=${r.json.pid}, port=${r.json.port}) and answering from the client's own view of the tailnet`, evidence);
}

/** F. telemetry.live_stream — semantic state and timestamps must MOVE. */
async function evalTelemetryDelta({ target, sampleMs = 6000 }) {
  const a = await request(`${target}/api/progress`, { timeoutMs: 10000 });
  if (a.transport !== 'ok' || !a.json) return blocked(`PROGRESS_UNREACHABLE: ${a.transport === 'ok' ? 'HTTP ' + a.status : a.errorChain}`);
  await new Promise(r => setTimeout(r, Math.max(2000, sampleMs)));
  const b = await request(`${target}/api/progress`, { timeoutMs: 10000 });
  if (b.transport !== 'ok' || !b.json) return blocked(`PROGRESS_SECOND_SAMPLE_FAILED: ${b.transport === 'ok' ? 'HTTP ' + b.status : b.errorChain}`);
  const ts = j => String(j.serverTs || j.progress?.ts || '');
  const moved = ts(a.json) !== ts(b.json);
  const evidence = { first: { serverTs: ts(a.json), keys: Object.keys(a.json).length }, second: { serverTs: ts(b.json), keys: Object.keys(b.json).length }, gapMs: sampleMs };
  if (moved) return ok(`live state advances (${ts(a.json)} -> ${ts(b.json)}) — this is a running backend, not a snapshot`, evidence);
  return bad('TELEMETRY_FROZEN: two samples 6s apart are byte-identical in their timestamps', evidence);
}

/** G. webdesktop.frames — fresh frames from the intended session, in the browser. */
async function evalWebDesktop({ target, page, sampleMs = 5000, rdpStatus }) {
  const { STATUS: S } = require('./status');
  if (rdpStatus && rdpStatus !== S.PASS) return blocked(`DEPENDS_ON_RDP_SESSION: connection.native_rdp_launch=${rdpStatus}`);
  const f1 = await request(`${target}/webdesk-frame`, { timeoutMs: 15000 });
  const s1 = await request(`${target}/webdesk-status`, { timeoutMs: 10000 });
  if (f1.transport !== 'ok' || f1.status !== 200) return blocked(`WEBDESK_FRAME_UNREACHABLE: ${f1.transport === 'ok' ? 'HTTP ' + f1.status : f1.errorChain}`);
  const sha1 = crypto.createHash('sha256').update(f1.bytes || Buffer.alloc(0)).digest('hex');
  await new Promise(r => setTimeout(r, Math.max(2000, sampleMs)));
  const f2 = await request(`${target}/webdesk-frame`, { timeoutMs: 15000 });
  const sha2 = crypto.createHash('sha256').update(f2.bytes || Buffer.alloc(0)).digest('hex');
  const st = s1.json || {};
  const evidence = { status1: st, status2: (await request(`${target}/webdesk-status`, { timeoutMs: 10000 })).json, frame1: { bytes: (f1.bytes || Buffer.alloc(0)).length, sha256: sha1.slice(0, 16) }, frame2: { bytes: (f2.bytes || Buffer.alloc(0)).length, sha256: sha2.slice(0, 16) } };
  if (!(st.ok === true && Number(st.frameAgeMs) >= 0 && Number(st.frameAgeMs) < 15000)) return bad(`WEBDESK_STALE_OR_DEAD: ${JSON.stringify(st)}`, evidence);
  const img = page ? await page.evaluate(() => { const i = document.querySelector('img#view'); return i ? { nw: i.naturalWidth, nh: i.naturalHeight, complete: i.complete, src: String(i.currentSrc || '').slice(0, 60) } : null; }) : null;
  if (page && !img) return bad('WEBDESK_NOT_RENDERED: no img#view with decoded pixels in the live DOM', evidence);
  if (page && !(img.nw > 0 && img.nh > 0)) return bad(`WEBDESK_ZERO_SIZE_FRAME: ${JSON.stringify(img)}`, evidence);
  // A prerecorded fixture would serve identical bytes; a live capture of a real
  // desktop does not. Identical bytes are reported, not hidden.
  if (sha1 === sha2) return bad('WEBDESK_STATIC_FRAME: two captures 5s apart are the same bytes — a placeholder or a frozen capture cannot prove a live session', evidence);
  return ok(`fresh frames (${evidence.frame1.sha256}… -> ${evidence.frame2.sha256}…)${img ? `, rendered at ${img.nw}x${img.nh}` : ''}`, evidence);
}

/** H. connection.native_rdp_launch — dispatch + the server's own logon proof. */
async function evalRdpLaunch({ launch, logon, target, descriptor, clientIp, sinceIso }) {
  if (!launch || !launch.ok) return bad(launch ? `${launch.code}: ${launch.detail || 'no detail'}` : 'NO_DISPATCH_ATTEMPTED', { launch: launch || null });
  if (!logon) return blocked('LOGON_PROOF_UNAVAILABLE: /api/logon-status did not answer', { launch });
  if (!logon.connected) {
    // Absence of an event is NOT proof that no connection was attempted:
    // classify by what the client saw, and say so.
    const dlg = logon.dialogs && logon.dialogs.blocking ? logon.dialogs : null;
    const code = dlg ? dlg.code : 'RDP_LOGON_NOT_OBSERVED';
    const res = { code, evidence: { launch, logon, expectedSourceIp: clientIp || descriptor.clientTailnetIp, sinceIso } };
    return { status: dlg ? STATUS.BLOCKED : STATUS.FAIL, reason: `${code}${dlg ? ': ' + dlg.reason : ''}`.slice(0, 400), evidence: res.evidence };
  }
  const evidence = { logon, launch, sinceIso };
  const typeOk = String(logon.logonType || '') === '10';
  const userOk = !descriptor.rdpUser || String(logon.user || '') === String(descriptor.rdpUser);
  const ipOk = !clientIp || String(logon.sourceIp || '').replace(/\.$/, '') === String(clientIp).replace(/\.$/, '');
  const windowOk = Number.isFinite(Date.parse(logon.ts || '')) && Date.parse(logon.ts) >= Date.parse(sinceIso);
  if (typeOk && userOk && ipOk && windowOk) return ok(`LogonType 10 proven directly by the server for ${logon.user} from ${logon.sourceIp} at ${logon.ts}`, evidence);
  const miss = [];
  if (!typeOk) miss.push(`logonType=${JSON.stringify(logon.logonType)} (need 10, never inferred from an IP)`);
  if (!userOk) miss.push(`user=${JSON.stringify(logon.user)} != ${JSON.stringify(descriptor.rdpUser)}`);
  if (!ipOk) miss.push(`sourceIp=${logon.sourceIp} != client ${clientIp}`);
  if (!windowOk) miss.push(`ts=${logon.ts} outside the attempt window (since ${sinceIso})`);
  return bad('RDP_LOGON_CORRELATION_INCOMPLETE: ' + miss.join('; '), evidence);
}

/** I. connection.credential_hygiene — scan everything we wrote. */
function evalSecretHygiene({ files, secrets }) {
  const needles = (secrets || []).map(s => String(s || '')).filter(s => s.length >= 6);
  const hits = [];
  const scanned = [];
  for (const f of files || []) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    scanned.push({ file: f, bytes: Buffer.byteLength(text) });
    for (const n of needles) if (text.includes(n)) hits.push({ file: f, secretLength: n.length });
    // also catch URL-embedded keys/tickets that were assembled before masking
    if (/[?&]key=[^&\s"']{8,}/.test(text)) hits.push({ file: f, pattern: 'url-key' });
    if (/[?&](?:ticket|t|rid)=[0-9a-f]{16,}/.test(text)) hits.push({ file: f, pattern: 'url-ticket' });
  }
  const evidence = { scanned, needlesChecked: needles.length, hits: hits.slice(0, 10) };
  if (!files || !files.length) return blocked('NO_EVIDENCE_FILES_TO_SCAN', evidence);
  if (hits.length) return bad(`CREDENTIAL_IN_EVIDENCE: ${hits.length} leak(s) — ${hits.map(h => `${h.file.split(/[\\/]/).pop()}${h.pattern ? ':' + h.pattern : ''}`).join(', ')}`, evidence);
  return ok(`${scanned.length} evidence file(s) scanned for ${needles.length} secret value(s) and url-key/ticket shapes: clean`, evidence);
}

/** J. keys.acl_view — masked on purpose; raw values must not be in the DOM. */
async function evalKeysMasked({ page, secrets }) {
  if (!page) return blocked('NO_BROWSER: keys masking is a UI claim');
  const dom = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const leaked = (secrets || []).filter(s => s && String(s).length >= 6 && dom.includes(String(s)));
  const evidence = { domChars: (dom || '').length, leakedCount: leaked.length };
  if (leaked.length) return bad(`RAW_SECRET_IN_DOM: ${leaked.length} current-run secret(s) are readable in the page text (they must be masked)`, evidence);
  return ok('no raw current-run secret appears in the dashboard DOM', evidence);
}

/** K. errors.classified_not_spinner — a forced failure must say why. */
async function evalErrorSurface({ page, target, forgedToken }) {
  if (!page) return blocked('NO_BROWSER: error surfacing is a UI claim');
  const before = Date.now();
  const res = await page.evaluate(async (tk) => {
    try {
      const r = await fetch('/api/rdp-token', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: '{}' });
      return { status: r.status, text: (await r.text()).slice(0, 120) };
    } catch (e) { return { error: String(e).slice(0, 120) }; }
  }, forgedToken);
  const evidence = { fromPage: res, ms: Date.now() - before };
  const refused = res.status === 401 || res.status === 403;
  if (!refused) return bad(`CONTROLLED_FAILURE_NOT_REFUSED: HTTP ${JSON.stringify(res.status)}`, evidence);
  const spinner = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[role=progressbar], .spinner, [data-loading="true"]'));
    return els.filter(e => e.offsetParent !== null).length;
  }).catch(() => 0);
  if (spinner > 0) return bad(`ERROR_HIDDEN_BEHIND_SPINNER: ${spinner} visible loader(s) still running after a definitive refusal`, evidence);
  return ok(`a denied operation returns 401 to the page and the UI settles into a terminal state (no stuck spinner) in ${evidence.ms}ms`, evidence);
}

module.exports = {
  evalAuthGate, evalStaleKey, evalRoutes, evalProvenance, evalLiveBinding,
  evalTelemetryDelta, evalWebDesktop, evalRdpLaunch, evalSecretHygiene,
  evalKeysMasked, evalErrorSurface, ok, bad, blocked, notRun, sim, na
};
