#!/usr/bin/env node
'use strict';
// Mission Control capability checker against the REAL supreme-lamp backend.
//
//   --scope server-local  (on the hosted server, against 127.0.0.1)
//       backend_readiness_server_local, dashboard_server_local
//   --scope remote        (on the self-hosted client, against the tailnet peer)
//       backend_readiness_remote, dashboard_client, rdp_auto_login, web_desktop
//
// Options: --target URL --expect-sha SHA40 [--expect-pid N] [--expect-port 7331]
//          [--headless] [--ready-timeout-ms N]
// Env (remote RDP): RDP_HOST, RDP_USER, RDP_LAB_PASSWORD, CLIENT_TAILNET_IP
//
// There is no mock mode. Missing configuration is BLOCKED, never PASS/SKIPPED.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFileSync } = require('child_process');
const { STATUS, CapabilitySet } = require('./lib/status');
const { request, summarize } = require('./lib/http');
const { evaluateLogonStatus, evaluateNativeCrossCheck, digestLogonBody } = require('./lib/logon');
const { classifyRdpAttempt } = require('./lib/dialogs');
const { digestRdpClientLog } = require('./lib/eventlog');
const { waitForReady, checkVersion } = require('./lib/readiness');
const { validatePngBuffer, validateJpegBuffer, validateImageFile, comparePng } = require('./lib/image');
const { deriveDashboardToken, tokenFingerprint } = require('./lib/capability-auth');
const { resolveProtocolHandler } = require('./lib/live-auth');
const { acquireLock, releaseLock } = require('./lib/lock');
const registry = require('./lib/registry');
const proc = require('./lib/proc');
const ps = require('./lib/ps');
const { writeCapabilities, artifactDir } = require('./lib/results');
const annotate = require('./lib/annotate');
const { redact, registerSecret } = require('./lib/redact');

const PS_DIR = path.join(__dirname, 'ps');

const DEFS = {
  'server-local': {
    backend_readiness_server_local: { required: true, contract: '/api/readiness ok&&status=ok&&phase=ready&&apiReadiness, pid==supervised pid, port; /api/version sha==expected' },
    dashboard_server_local: { required: true, contract: 'GET / 200 html and exact build; v2 also requires the real token dialog to clear, AUTO-LOGIN enabled, and a valid screenshot' }
  },
  remote: {
    backend_readiness_remote: { required: true, contract: 'same readiness+version contract over the tailnet' },
    dashboard_client: { required: true, contract: 'headed client browser renders the exact build; real token dialog clears; AUTO-LOGIN is enabled; valid screenshot' },
    rdp_auto_login: { required: true, contract: 'MagicDNS bound to this attempt peer; trusted NLA/cert listener; real dashboard click mints a 60 s ticket; staged production ghrdp handler emits a fresh beacon and starts mstsc at that FQDN; fresh source/user-matched LogonType 10; no blocking dialog; live window and native screenshot' },
    web_desktop: { required: true, contract: 'fresh frame plus the real dashboard WEB DESKTOP popup at the published safe URL; browser rendering; queued input acknowledged and a substantial decoded-pixel change after keyboard/pointer input; cleanup frame retained' }
  }
};

function parseArgs(argv) {
  const a = { scope: null, target: null, expectSha: null, expectBuild: null, expectPid: null, expectPort: 7331, headless: false, readyTimeoutMs: 120000, blockedReason: null, failReason: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--scope') a.scope = argv[++i];
    else if (k === '--target') a.target = (argv[++i] || '').replace(/\/+$/, '');
    else if (k === '--expect-sha') a.expectSha = argv[++i];
    else if (k === '--expect-build') a.expectBuild = argv[++i];
    else if (k === '--expect-pid') a.expectPid = Number(argv[++i]);
    else if (k === '--expect-port') a.expectPort = Number(argv[++i]);
    else if (k === '--headless') a.headless = true;
    else if (k === '--ready-timeout-ms') a.readyTimeoutMs = Number(argv[++i]);
    else if (k === '--blocked-reason') a.blockedReason = argv[++i];
    else if (k === '--fail-reason') a.failReason = argv[++i];
  }
  return a;
}

const log = (...m) => console.log(`[mc ${new Date().toISOString()}]`, ...m);

async function checkBackend(caps, name, args) {
  const ready = await waitForReady(args.target, {
    timeoutMs: args.readyTimeoutMs, expectPid: args.expectPid || null, expectPort: args.expectPort, log: m => log(`readiness ${m}`)
  });
  if (!ready.ready) {
    caps.set(name, STATUS.FAIL, `${ready.code}: ${ready.detail}`, { readinessHistory: ready.history, lastReadiness: ready.last });
    return null;
  }
  const ver = await checkVersion(args.target, args.expectSha);
  if (!ver.ok) {
    caps.set(name, STATUS.FAIL, `${ver.code}: ${ver.detail}`, { readinessHistory: ready.history, version: ver.body || null });
    return null;
  }
  caps.set(name, STATUS.PASS, `${ready.detail}; sha=${ver.detail}`, { readiness: ready.last.body, version: ver.body });
  return ready.last.body;
}

async function launchBrowser(headless) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { throw new Error(`PLAYWRIGHT_MISSING: ${e.message}`); }
  return chromium.launch({ headless });
}

// The served dashboard is either the classic v1 ui.html or (app >= F43, the default
// route) the v2 React bundle ui-v2.html. Each variant must prove the exact build:
//   v1: meta#ghrdpBuild[content] == sha, #topbar visible
//   v2: meta[name=ghrdp-build][content] == sha (vite stamp) AND the React-rendered
//       #ghrdpBuild[data-build] == sha (proves the bundle mounted), app-topbar visible
async function dashboardVariant(page, sha, pageErrors) {
  const v1 = await page.$('meta#ghrdpBuild');
  if (v1) {
    const build = await v1.getAttribute('content');
    if (build !== sha) throw new Error(`DASHBOARD_BUILD_MISMATCH: v1 meta#ghrdpBuild=${JSON.stringify(build)} expected ${sha}`);
    try { await page.waitForSelector('#topbar', { state: 'visible', timeout: 20000 }); } catch (e) { throw new Error('DASHBOARD_SHELL_NOT_VISIBLE: v1 #topbar'); }
    return { variant: 'v1', build, stamps: 'meta#ghrdpBuild', shell: '#topbar' };
  }
  const metaEl = await page.$('meta[name="ghrdp-build"]');
  const metaBuild = metaEl ? await metaEl.getAttribute('content') : null;
  if (metaBuild !== sha) throw new Error(`DASHBOARD_BUILD_MISMATCH: v2 meta[name=ghrdp-build]=${JSON.stringify(metaBuild)} expected ${sha}`);
  try { await page.waitForSelector('#ghrdpBuild[data-build]', { state: 'attached', timeout: 20000 }); } catch (e) {
    throw new Error(`DASHBOARD_V2_NOT_MOUNTED: #ghrdpBuild[data-build] never rendered${pageErrors.length ? `; page errors: ${pageErrors.slice(0, 2).join(' | ')}` : ''}`);
  }
  const build = await page.getAttribute('#ghrdpBuild', 'data-build');
  if (build !== sha) throw new Error(`DASHBOARD_BUILD_MISMATCH: v2 #ghrdpBuild[data-build]=${JSON.stringify(build)} expected ${sha}`);
  try { await page.waitForSelector('[data-testid="app-topbar"]', { state: 'visible', timeout: 20000 }); } catch (e) { throw new Error('DASHBOARD_SHELL_NOT_VISIBLE: v2 [data-testid=app-topbar]'); }
  return { variant: 'v2', build, stamps: 'meta[name=ghrdp-build] + #ghrdpBuild[data-build]', shell: 'app-topbar' };
}

async function unlockDashboard(page) {
  const gate = page.getByTestId('dash-token-gate');
  await gate.waitFor({ state: 'visible', timeout: 15000 });
  const secret = String(process.env.RDP_LAB_PASSWORD || '');
  const token = deriveDashboardToken({ secret, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1' });
  registerSecret(token, 'CAPABILITY_DASH_TOKEN');
  await page.getByTestId('dash-token-enter').click();
  await page.getByTestId('dash-token-input').fill(token);
  await page.getByTestId('dash-token-save').click();
  await gate.waitFor({ state: 'hidden', timeout: 15000 });
  const tokenPresent = await page.evaluate(() => { try { return Boolean(localStorage.getItem('ghrdp.dashToken')); } catch (e) { return false; } });
  if (!tokenPresent || await gate.isVisible().catch(() => false)) throw new Error('DASHBOARD_AUTH_NOT_OPERABLE: token gate did not clear through the real dialog');
  return { dialogUsed: true, initiallyVisible: true, tokenPresent: true };
}

async function checkDashboard(caps, name, browser, args, outDir) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, recordVideo: { dir: path.join(outDir, `video-${name}`) } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(redact(String(e && e.message || e)).slice(0, 300)));
  const shot = path.join(outDir, `${name}.png`);
  try {
    const resp = await page.goto(`${args.target}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp) throw new Error('DASHBOARD_NO_RESPONSE');
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (resp.status() !== 200 || !ct.includes('text/html')) throw new Error(`DASHBOARD_HTTP: status=${resp.status()} content-type=${ct}`);
    const body = await page.content();
    if (body.includes('Mission Control UI file missing')) throw new Error('DASHBOARD_UI_FILE_MISSING: backend served the missing-ui placeholder (staging failed)');
    // server.ps1 [F42]: v2 requested but ui-v2.html not staged -> v1 + red banner. Fail-visible, never a pass.
    const banner = await page.$('#uiV2MissingBanner');
    if (banner) throw new Error(`DASHBOARD_V2_NOT_STAGED: ${((await banner.textContent()) || '').trim().slice(0, 160)}`);
    const title = await page.title();
    if (title !== 'RDP Mission Control') throw new Error(`DASHBOARD_WRONG_TITLE: ${JSON.stringify(title)}`);
    const v = await dashboardVariant(page, args.expectBuild || args.expectSha, pageErrors);
    let auth = { notApplicable: 'v1' };
    if (v.variant === 'v2') {
      auth = await unlockDashboard(page);
      await page.waitForFunction(() => {
        const b = document.querySelector('[data-testid="overview-auto-login"]');
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      }, null, { timeout: 20000 });
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
    const img = validatePngBuffer(fs.readFileSync(shot), { minWidth: 640, minHeight: 400 });
    if (!img.valid) throw new Error(`DASHBOARD_SCREENSHOT_INVALID: ${img.reason}`);
    caps.set(name, STATUS.PASS, `${v.variant}: title ok, build ${v.build.slice(0, 12)} (${v.stamps}), ${v.shell} visible, ${v.variant === 'v2' ? 'token gate cleared and AUTO-LOGIN enabled' : 'legacy shell contract only'}, screenshot ${img.width}x${img.height}`, { screenshot: shot, pageErrors, variant: v.variant, authentication: auth, autoLoginEnabled: v.variant === 'v2' ? true : null });
  } catch (e) {
    try { await page.screenshot({ path: shot }); } catch (e2) { /* ignore */ }
    caps.set(name, STATUS.FAIL, redact(e.message).split('\n')[0], { screenshot: fs.existsSync(shot) ? shot : null, pageErrors });
  } finally {
    if (pageErrors.length) annotate.warning(`${name} page errors`, pageErrors.slice(0, 5).join(' | '));
    await ctx.close().catch(() => {});
  }
}

// Async, bounded PowerShell helper. A helper timeout is reported as its own
// failure category with the stderr retained, never as a silent empty result.
async function runPs(script, psArgs, { env = {}, timeoutMs = 60000, operation = script } = {}) {
  const r = await ps.runPowerShell({
    script: path.join(PS_DIR, script), args: psArgs, timeoutMs, env, operation, site: `mission-control-check.js:${operation}`
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (!r.ok) {
    const code = r.errorCode === 'POWERSHELL_TIMEOUT' ? 124 : (r.code === null ? 125 : r.code);
    return { code, out: `${r.errorCode}: ${out || r.errorMessage}`, diagnostic: ps.describe(r), timedOut: Boolean(r.timedOut) };
  }
  return { code: 0, out, diagnostic: null, timedOut: false };
}

/**
 * Parse the single JSON object a PS helper emits, tolerating any non-JSON
 * noise that leaked onto stdout/stderr around it (runPs concatenates both).
 */
function parseJsonLoose(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

function writeRdpFile(file, host, user) {
  // authentication level 2: fail closed on an untrusted/mismatched server cert
  // prompt for credentials 0: use the stored TERMSRV/<host> credential
  const lines = [
    `full address:s:${host}`, `username:s:${user}`, 'prompt for credentials:i:0', 'promptcredentialonce:i:0',
    'authentication level:i:2', 'enablecredsspsupport:i:1', 'negotiate security layer:i:1',
    'screen mode id:i:1', 'desktopwidth:i:1280', 'desktopheight:i:800', 'session bpp:i:32',
    'redirectclipboard:i:0', 'redirectprinters:i:0', 'redirectdrives:i:0', 'redirectsmartcards:i:0',
    'autoreconnection enabled:i:0', 'administrative session:i:0'
  ];
  // UTF-8 without BOM, CRLF - byte-for-byte the shape the app's production
  // launcher writes on this client (ghrdp-rdp-launcher.cs WriteAllText with
  // UTF8Encoding(false)) and reads back before launching mstsc. The previous
  // lab encoding was UTF-16LE *without* a BOM (66 00 75 00 ...), which an
  // ANSI-reading parser truncates at the first NUL: every directive is lost
  // and mstsc never targets the host. Read back and refuse to launch on a
  // file that does not provably carry the target (the launcher's F30 rule).
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8' });
  const back = fs.readFileSync(file);
  const text = back.toString('utf8');
  if (back.length < 200 || back.includes(0) ||
      !text.includes(`full address:s:${host}`) || !text.includes(`username:s:${user}`) ||
      !text.includes('prompt for credentials:i:0') || !text.includes('authentication level:i:2')) {
    throw new Error(`RDP_FILE_INVALID: read-back failed (${back.length} bytes) for ${file}`);
  }
  return { bytes: back.length, directives: lines.length };
}

/** Bounded TCP connect probe. Result only; never throws. */
function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* already gone */ }
      resolve({ ok, host, port, ms: Date.now() - t0, error: error || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, `timeout after ${timeoutMs}ms`));
    sock.once('error', e => finish(false, (e && (e.code || e.message)) || 'error'));
    try { sock.connect(port, host); } catch (e) { finish(false, e.message); }
  });
}

/**
 * One bounded read of the app's observer/collector state. Used before the
 * attempt (is the Security-log observer even able to read, i.e. probeError?)
 * and after a failure (connLog names pre-LSA drops - TLS/cert - that never
 * produce a 4624/4625). Never throws; shape is extracted defensively.
 */
async function configIdentitySnapshot(target) {
  const token = deriveDashboardToken({ secret: process.env.RDP_LAB_PASSWORD || '', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1' });
  registerSecret(token, 'CAPABILITY_DASH_TOKEN');
  const r = await request(`${target}/api/config`, { timeoutMs: 10000, headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok || !r.json) return { error: summarize(r) };
  // /api/config is credentialed and may contain password fields. Extract only
  // this safe identity shape; never return or attach the response object.
  const j = r.json, c = j.creds || {};
  return {
    fqdn: String(c.fqdn || j.dnsName || ''), user: String(c.user || j.rdpUser || ''),
    ip: String(c.ip || j.rdpIp || ''), buildSha: String(j.buildSha || '')
  };
}

async function nativeStatusSnapshot(target) {
  const r = await request(`${target}/api/native-status`, { timeoutMs: 10000 });
  if (r.transport !== 'ok' || !r.json) return { error: summarize(r) };
  const rl = r.json.rdpListener || {};
  const a = rl.authLast || r.json.authLast || null;
  const coll = r.json.logonCollector || rl.logonCollector || null;
  const conn = Array.isArray(rl.connLog) ? rl.connLog.slice(0, 3).map(e => ({
    ts: (e && (e.ts || e.timeUtc || e.when)) || '',
    log: (e && (e.log || e.src)) || '',
    id: (e && e.id) || '',
    reason: (e && (e.reason || e.code || e.why)) || ''
  })) : [];
  const hello = r.json.lastHandlerVerb || null;
  return {
    fqdn: String(r.json.fqdn || (r.json.creds && r.json.creds.fqdn) || ''),
    runnerResolvedIP: String(r.json.runnerResolvedIP || (r.json.creds && r.json.creds.ip) || ''),
    user: String((r.json.creds && r.json.creds.user) || ''),
    webdeskUrl: String(r.json.webdeskUrl || ''),
    listener: {
      listening: rl.listening === true, fwRule: rl.fwRule === true, certOk: rl.certOk === true,
      nla: rl.nla === true, credsspStatus: rl.credsspLive || rl.credsspStatus || '', certThumb: rl.certThumb || ''
    },
    handler: hello ? { verb: hello.verb || '', ok: hello.ok === true, ts: hello.ts || '' } : null,
    authLast: a ? {
      result: a.result, logonType: a.logonType == null ? '' : String(a.logonType), logonKind: a.logonKind || '', eventTs: a.eventTs || '',
      scanTs: a.scanTs || '', count4624: a.count4624, count4625: a.count4625,
      probeError: a.probeError || '', sub: a.sub || '', subMeaning: a.subMeaning || ''
    } : null,
    collector: coll ? { alive: coll.alive, scans: coll.scans, probeError: coll.probeError || '', lastScanAgeSec: coll.lastScanAgeSec } : null,
    connLog: conn
  };
}

function digestNative(snap) {
  if (!snap) return 'native-status: not fetched';
  if (snap.error) return `native-status: ${String(snap.error).slice(0, 120)}`;
  const a = snap.authLast || {};
  const c = snap.collector || {};
  const cl = (snap.connLog || []).map(e => `${e.ts || '?'} ${e.log}/${e.id} ${e.reason}`).join(' | ') || 'none';
  return `authLast result=${a.result} type=${JSON.stringify(a.logonType)} kind=${a.logonKind || ''} eventTs=${a.eventTs} scanTs=${a.scanTs} ` +
    `4624=${a.count4624} 4625=${a.count4625} probeError=${JSON.stringify(a.probeError || '')} sub=${a.sub} ${a.subMeaning}; ` +
    `collector alive=${c.alive} scans=${c.scans}; connLog: ${cl}`.slice(0, 600);
}

function digestClientDiagnostics(d) {
  if (!d) return 'client diagnostics: not collected';
  const ev = digestRdpClientLog(d.rdpClientLog);
  const win = (d.windows || []).map(w => {
    const ctrl = (w.controls || []).map(c => `${c.state ? c.state + ' ' : ''}${JSON.stringify(String(c.text || '').slice(0, 70))}`).filter(s => s && s !== '\"\"').slice(0, 5).join(' ');
    return `${w.process}(${w.pid}${w.ownerPid ? ' owner=' + w.ownerPid : ''} sess=${w.sessionId}):${JSON.stringify(String(w.title || '').slice(0, 80))}${ctrl ? ` [${ctrl}]` : ''}`;
  }).join(' | ') || 'none';
  const tcp = (d.tcpConnections || []).map(t => `${t.remote}=${t.state}`).join(' | ') || 'none';
  const p = d.policy || {};
  const pol = `disablePwSave(M=${p.disablePasswordSavingMachine} U=${p.disablePasswordSavingUser}) promptPw=${p.promptForPasswordMachine} ` +
    `allowSaved=${JSON.stringify(p.allowSavedCredentials || {})} allowSavedNtlm=${JSON.stringify(p.allowSavedCredentialsNtlm || {})}`;
  return {
    events: `rdpClient ${ev}${d.windowEnumError ? ` windowEnumErr=${d.windowEnumError}` : ''}: ${(d.rdpClientLog && d.rdpClientLog.events ? d.rdpClientLog.events : []).map(e => `${e.id}@${e.timeUtc} ${String(e.message || '').slice(0, 90)}`).join(' | ') || 'no rows'}`.slice(0, 1400),
    windows: `windows: ${win}; mstsc tcp: ${tcp}; policy: ${pol}`.slice(0, 1400)
  };
}

/**
 * Poll /api/logon-status (user-filtered) and /api/native-status until a
 * candidate is proven or the budget expires. Evidence rules (see
 * scripts/lib/logon.js): the logon type is NEVER inferred from a remote IP.
 *   - 'candidate/direct'  : the endpoint itself reports LogonType 10 for the
 *     fresh event (a fixed app build lands here); the XML collector may veto
 *     on a time-correlated contradiction.
 *   - 'needs-type-proof'  : user + source proven on a fresh event, type
 *     missing (the pinned app's $Matches clobber). The XML collector must
 *     then confirm LogonType 10 AT THE SAME EVENT INSTANT; a stale type-2
 *     record, an unrelated authLast record or no record at all never counts.
 * onTick may return { abort: { code, status, detail, evidence } } to end the
 * poll early (e.g. a known blocking dialog is visible - never burn the whole
 * budget on a generic timeout then).
 */
async function pollLogon(target, baselineIso, user, clientIp, timeoutMs, onTick = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let polls = 0;
  let sawTypeProofGap = null;
  let lastCross = null;
  while (Date.now() < deadline) {
    polls++;
    const r = await request(`${target}/api/logon-status?since=${encodeURIComponent(baselineIso)}&user=${encodeURIComponent(user)}`, { timeoutMs: 8000 });
    if (r.transport === 'ok' && r.json) {
      last = r.json;
      const ev = evaluateLogonStatus(r.json, { baselineIso, clientIp, expectedUser: user });
      if (ev.state === 'wrong-source') return { ok: false, code: 'RDP_LOGON_WRONG_SOURCE', body: last, polls, detail: ev.detail };
      if (ev.state === 'type-mismatch') return { ok: false, code: 'RDP_LOGON_TYPE_MISMATCH', body: last, polls, detail: ev.detail };
      if (ev.state === 'candidate' || ev.state === 'needs-type-proof') {
        const nat = await nativeStatusSnapshot(target);
        const cross = evaluateNativeCrossCheck(nat.authLast, r.json.ts, { baselineIso, expectedUser: user });
        lastCross = cross;
        if (ev.state === 'candidate') {
          log(`logon candidate (${ev.proof}): ${ev.detail}; cross-check ${cross.state} - ${cross.detail}`);
          if (cross.state === 'contradicted') {
            return {
              ok: false, code: 'RDP_LOGON_TYPE_MISMATCH', body: last, polls, proof: ev.proof,
              crossCheck: { state: cross.state, detail: cross.detail },
              detail: `native-status collector contradicts the logon-status candidate: ${cross.detail}`
            };
          }
          return {
            ok: true, body: last, polls, proof: ev.proof, proofDetail: ev.detail,
            crossCheck: { state: cross.state, detail: cross.detail }
          };
        }
        // needs-type-proof: the type must be proven at THIS event instant
        sawTypeProofGap = { ts: r.json.ts, detail: ev.detail };
        log(`logon user+source matched at ${r.json.ts}; type proof: ${cross.state} - ${cross.detail}`);
        if (cross.state === 'confirmed') {
          return {
            ok: true, body: last, polls, proof: 'correlated',
            proofDetail: `fresh 4624 for ${user} from ${clientIp} at ${r.json.ts}; LogonType 10 proven at the same event instant by the XML-parsing collector (${cross.detail})`,
            crossCheck: { state: cross.state, detail: cross.detail }
          };
        }
        if (cross.state === 'contradicted') {
          return {
            ok: false, code: 'RDP_LOGON_TYPE_MISMATCH', body: last, polls,
            crossCheck: { state: cross.state, detail: cross.detail },
            detail: `the event at ${r.json.ts} matched ${user} from ${clientIp} but the XML-parsing collector contradicts it: ${cross.detail}`
          };
        }
      }
    } else {
      last = { error: summarize(r) };
    }
    if (onTick) {
      let abort = null;
      try { abort = await onTick(polls, last); } catch (e) { annotate.warning('rdp observation', e.message); }
      if (abort && abort.abort) {
        return {
          ok: false, aborted: true, code: abort.abort.code, status: abort.abort.status || STATUS.FAIL,
          body: last, polls, detail: abort.abort.detail, dialog: abort.abort.dialog || null, evidence: abort.abort.evidence || null
        };
      }
    }
    await new Promise(res => setTimeout(res, 3000));
  }
  if (sawTypeProofGap) {
    return {
      ok: false, code: 'RDP_LOGON_TYPE_UNKNOWN', body: last, polls,
      crossCheck: lastCross ? { state: lastCross.state, detail: lastCross.detail } : null,
      detail: `a fresh 4624 for ${user} from ${clientIp} matched at ${sawTypeProofGap.ts}, but the actual logon type was never proven at that event instant ` +
        `(pinned app /api/logon-status \$Matches clobber - pending app fix, see patches/; collector: ${lastCross ? lastCross.detail : 'not fetched'}); ` +
        'LogonType 10 is not inferred from a remote IP, and a stale type-2 / unrelated authLast record is not accepted'
    };
  }
  return {
    ok: false, code: 'RDP_LOGON_NOT_OBSERVED', body: last, polls,
    detail: `no LogonType 10 for ${user} from ${clientIp} since ${baselineIso} within ${timeoutMs}ms; last ${digestLogonBody(last)}`
  };
}

function snapshotTree(root) {
  const snap = { root, exists: fs.existsSync(root), files: new Set(), dirs: new Set() };
  if (!snap.exists) return snap;
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { snap.dirs.add(r); walk(full, r); }
      else snap.files.add(r);
    }
  };
  walk(root);
  return snap;
}

function removeTreeAdditions(snap) {
  const errors = [];
  if (!fs.existsSync(snap.root)) return { errors };
  const files = [], dirs = [];
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, r); dirs.push({ full, rel: r }); }
      else files.push({ full, rel: r });
    }
  };
  walk(snap.root);
  for (const f of files) {
    if (snap.files.has(f.rel)) continue;
    try { fs.unlinkSync(f.full); } catch (e) { errors.push(`file cleanup failed: ${f.rel}`); }
  }
  for (const d of dirs.sort((a, b) => b.rel.length - a.rel.length)) {
    if (snap.dirs.has(d.rel)) continue;
    try { fs.rmdirSync(d.full); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') errors.push(`directory cleanup failed: ${d.rel}`); }
  }
  if (!snap.exists) { try { fs.rmdirSync(snap.root); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') errors.push('root directory cleanup failed'); } }
  return { errors };
}

async function mstscProcessSnapshot(notBeforeIso) {
  const r = await runPs('Get-MstscProcesses.ps1', ['-NotBeforeUtc', notBeforeIso], { operation: 'mstsc-production-discovery', timeoutMs: 20000 });
  if (r.code !== 0) throw new Error(`MSTSC_DISCOVERY_FAILED: ${r.out}`);
  const doc = parseJsonLoose(r.out);
  if (!doc || !Array.isArray(doc.processes)) throw new Error('MSTSC_DISCOVERY_UNPARSEABLE');
  return doc;
}

function newRdpHandle() {
  return {
    peerIp: process.env.RDP_HOST || '', host: '', credSet: false, mstsc: null, enrollment: null,
    uiContext: null, uiPage: null, launch: { mechanism: 'dashboard overview-auto-login -> ghrdp://rdp -> production handler' }
  };
}

/** Returns an owned-mstsc handle (or null). Caller must call cleanupRdp(). */
async function checkRdp(caps, browser, args, outDir, readinessBody, ownership = null) {
  const name = 'rdp_auto_login';
  const peerIp = process.env.RDP_HOST;
  const user = process.env.RDP_USER;
  const pass = process.env.RDP_LAB_PASSWORD;
  const clientIp = process.env.CLIENT_TAILNET_IP;
  if (process.platform !== 'win32') { caps.set(name, STATUS.BLOCKED, 'PLATFORM: native mstsc requires a Windows client'); return null; }
  const missing = [['RDP_HOST', peerIp], ['RDP_USER', user], ['RDP_LAB_PASSWORD', pass], ['CLIENT_TAILNET_IP', clientIp]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { caps.set(name, STATUS.BLOCKED, `MISSING_CONFIG: ${missing.join(', ')}`); return null; }
  const mstscExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
  if (!fs.existsSync(mstscExe)) { caps.set(name, STATUS.FAIL, `MSTSC_NOT_FOUND: ${mstscExe}`); return null; }

  const baselineIso = new Date(Date.parse(readinessBody.serverTs) - 2000).toISOString();
  const handle = ownership || newRdpHandle();
  const nativePre = await nativeStatusSnapshot(args.target);
  const host = String(nativePre.fqdn || '');
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\.ts\.net$/.test(host)) {
    caps.set(name, STATUS.FAIL, `RDP_MAGICDNS_INVALID: native-status did not advertise a valid FQDN (${JSON.stringify(host)})`, { nativePre });
    return handle;
  }
  handle.host = host;
  const identity = await configIdentitySnapshot(args.target);
  handle.launch.configIdentity = identity;
  const normalizeUser = v => String(v || '').replace(/^\.\\/, '').toLowerCase();
  if (identity.error || identity.fqdn !== host || identity.ip !== peerIp || nativePre.runnerResolvedIP !== peerIp || identity.buildSha !== args.expectSha || normalizeUser(identity.user) !== normalizeUser(user)) {
    caps.set(name, STATUS.FAIL, `RDP_SERVER_IDENTITY_MISMATCH: config fqdn/ip/user/build or native peer does not match this attempt (config=${JSON.stringify(identity)} nativePeer=${nativePre.runnerResolvedIP} expectedPeer=${peerIp} intendedUser=${JSON.stringify(user)})`, { nativePre, configIdentity: identity });
    return handle;
  }
  try {
    const resolved = await dns.lookup(host);
    handle.launch.dns = { fqdn: host, address: resolved.address, expectedPeer: peerIp, boundToThisAttempt: resolved.address === peerIp };
    if (resolved.address !== peerIp) {
      caps.set(name, STATUS.FAIL, `RDP_FQDN_PEER_MISMATCH: ${host} resolved to ${resolved.address}, expected this attempt's ${peerIp}`, { nativePre, dns: handle.launch.dns });
      return handle;
    }
  } catch (e) {
    caps.set(name, STATUS.FAIL, `RDP_FQDN_RESOLUTION_FAILED: ${host}: ${redact(e.message)}`, { nativePre });
    return handle;
  }
  const listener = nativePre.listener || {};
  if (!(listener.listening && listener.fwRule && listener.certOk && listener.nla && listener.credsspStatus === 'ok')) {
    caps.set(name, STATUS.FAIL, `RDP_LISTENER_TRUST_INCOMPLETE: ${JSON.stringify(listener)}`, { nativePre, dns: handle.launch.dns });
    return handle;
  }

  const trust = await runPs('Get-RdpClientTrustPosture.ps1', [], { operation: 'rdp-client-trust-posture', timeoutMs: 30000 });
  handle.launch.clientTrust = parseJsonLoose(trust.out) || { ok: false, diagnostic: trust.diagnostic || 'unparseable posture' };
  if (trust.code !== 0 || handle.launch.clientTrust.ok !== true) {
    caps.set(name, STATUS.BLOCKED, `RDP_CLIENT_CERT_VALIDATION_NOT_GUARANTEED: read-only AuthenticationLevelOverride probe found an unsafe or unverifiable mstsc default; no setting was changed`, { clientTrust: handle.launch.clientTrust, nativePre, dns: handle.launch.dns });
    return handle;
  }

  const tcp = await tcpProbe(host, 3389, 6000);
  log(`tcp 3389 probe -> ${host} (${peerIp}): ok=${tcp.ok} ms=${tcp.ms}${tcp.error ? ` error=${tcp.error}` : ''}`);
  if (!tcp.ok) {
    caps.set(name, STATUS.FAIL, `RDP_TCP_3389_UNREACHABLE: ${host}:3389 ${tcp.error}`, { tcp3389: tcp, baselineIso, nativePre });
    return handle;
  }
  const cred = await runPs('Set-RdpCredential.ps1', ['-Action', 'set', '-TargetHost', host, '-User', user], { operation: 'rdp-credential-set' });
  if (cred.code !== 0) {
    caps.set(name, cred.code === 3 ? STATUS.BLOCKED : STATUS.FAIL, `CREDENTIAL_SET_FAILED: ${cred.out}`, { diagnostic: cred.diagnostic, tcp3389: tcp });
    return handle;
  }
  handle.credSet = true;
  annotate.notice('rdp attempt setup', `${cred.out}; production UI/handler required; baseline ${baselineIso}`);

  // Install the exact staged production handler only into a registration and
  // helper paths that were absent. File snapshots make partial-install cleanup
  // possible without deleting anything that predated this attempt.
  const installer = await request(`${args.target}/install.ps1`, { timeoutMs: 15000 });
  if (installer.status !== 200 || !installer.bytes || installer.bytes.length < 1000 || installer.text.includes('__HELPER_B64__')) {
    caps.set(name, STATUS.FAIL, `PRODUCTION_INSTALLER_UNAVAILABLE: ${summarize(installer)}`, { tcp3389: tcp, nativePre });
    return handle;
  }
  const oldDir = path.join(process.env.LOCALAPPDATA || '', 'ghrdp');
  const newDir = path.join(process.env.LOCALAPPDATA || '', 'GhrdpLauncher');
  const oldHelper = path.join(oldDir, 'ghrdp-connect.ps1');
  const newHelper = path.join(newDir, 'launch.ps1');
  const registrationBefore = resolveProtocolHandler();
  handle.enrollment = {
    attempted: false, registrationBefore, oldTree: snapshotTree(oldDir), newTree: snapshotTree(newDir),
    installerSha256: crypto.createHash('sha256').update(installer.bytes).digest('hex')
  };
  if (registrationBefore.registered || fs.existsSync(oldHelper) || fs.existsSync(newHelper)) {
    caps.set(name, STATUS.BLOCKED, 'HANDLER_PREEXISTING: refusing to overwrite an existing user registration/helper', { registrationBefore, tcp3389: tcp });
    return handle;
  }
  const installerPath = path.join(outDir, 'production-install.ps1');
  fs.writeFileSync(installerPath, installer.bytes);
  handle.enrollment.attempted = true;
  const install = await runPs('Install-ProductionHandler.ps1', ['-InstallerPath', installerPath, '-ExpectedSha256', handle.enrollment.installerSha256], { operation: 'production-handler-install', timeoutMs: 90000 });
  handle.enrollment.result = parseJsonLoose(install.out);
  if (install.code !== 0 || !handle.enrollment.result || handle.enrollment.result.registered !== true) {
    const st = /PREEXISTING|PROCESS_CONFLICT/.test(install.out) ? STATUS.BLOCKED : STATUS.FAIL;
    caps.set(name, st, `PRODUCTION_HANDLER_INSTALL_FAILED: ${redact(install.out).slice(0, 500)}`, { diagnostic: install.diagnostic, tcp3389: tcp });
    return handle;
  }
  handle.launch.installer = {
    sha256: handle.enrollment.result.installerSha256,
    helperSha256: handle.enrollment.result.helperSha256,
    commandVerified: handle.enrollment.result.commandVerified === true
  };

  // Real visible dashboard + real token dialog. No storage injection and no
  // lab-side ticket minting: the click must create the ticket and protocol
  // navigation, and the installed application handler must do the rest.
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  handle.uiContext = ctx;
  const page = await ctx.newPage();
  handle.uiPage = page;
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(redact(String(e && e.message || e)).slice(0, 300)));
  try {
    await page.goto(`${args.target}/v2#/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-testid="app-topbar"]', { state: 'visible', timeout: 20000 });
    handle.launch.authentication = await unlockDashboard(page);
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="overview-auto-login"]');
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, null, { timeout: 20000 });
    await page.screenshot({ path: path.join(outDir, 'dashboard-production-launch.png') });
  } catch (e) {
    try { await page.screenshot({ path: path.join(outDir, 'production-rdp-failure.png') }); } catch (e2) {}
    caps.set(name, STATUS.FAIL, `PRODUCTION_DASHBOARD_NOT_OPERABLE: ${redact(e.message).split('\n')[0]}`, { pageErrors, nativePre, launch: handle.launch });
    return handle;
  }

  const mstscStartedIso = new Date(Date.now() - 5000).toISOString();
  let beforeProcesses = { processes: [] };
  try { beforeProcesses = await mstscProcessSnapshot(mstscStartedIso); } catch (e) { annotate.warning('mstsc baseline', redact(e.message)); }
  const beforeIds = new Set((beforeProcesses.processes || []).map(p => p.pid));
  handle.launch.mstscBaselineCount = beforeIds.size;
  handle.launch.clickedAt = new Date().toISOString();
  const ticketPromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/rdp-token' && r.request().method() === 'POST', { timeout: 15000 });
  await page.getByTestId('overview-auto-login').click({ noWaitAfter: true });
  try {
    const response = await ticketPromise;
    const body = await response.json().catch(() => null);
    handle.launch.ticket = {
      status: response.status(), ridPresent: Boolean(body && typeof body.rid === 'string' && body.rid.length >= 16),
      ttlSeconds: body && Number.isFinite(Number(body.ttl)) ? Number(body.ttl) : null,
      tokenFingerprint: tokenFingerprint(deriveDashboardToken({ secret: pass, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1' }))
    };
  } catch (e) {
    handle.launch.ticket = { status: null, error: 'NO_RDP_TOKEN_RESPONSE' };
  }
  if (!handle.launch.ticket || handle.launch.ticket.status !== 200 || !handle.launch.ticket.ridPresent || handle.launch.ticket.ttlSeconds !== 60) {
    try { await page.screenshot({ path: path.join(outDir, 'production-rdp-failure.png') }); } catch (e2) {}
    caps.set(name, STATUS.FAIL, `PRODUCTION_TICKET_FAILED: ${JSON.stringify(handle.launch.ticket)}`, { nativePre, launch: handle.launch, pageErrors });
    return handle;
  }

  log('whoami/session for credential identity: see Set-RdpCredential output; ' + `credential=${cred.out}; dashboard ticket accepted; waiting for production handler + mstsc`);
  annotate.notice('rdp observer (pre)', digestNative(nativePre));
  const windowSamples = [];
  const dialogSamples = [];
  const clientAccount = (process.env.COMPUTERNAME ? `${process.env.COMPUTERNAME}\\` : '') + (process.env.USERNAME || (os.userInfo() && os.userInfo().username) || 'the client-runner account');
  const dialogSightings = {};
  let handlerSeen = false;
  const observe = async poll => {
    try {
      const processes = await mstscProcessSnapshot(mstscStartedIso);
      if (!handle.mstsc) {
        const candidates = (processes.processes || []).filter(p => !beforeIds.has(p.pid) && p.newerThanBaseline && p.sessionId === processes.currentSessionId);
        if (candidates.length) {
          const p = candidates[0];
          handle.mstsc = { pid: p.pid, createTime: p.createTime };
          handle.launch.mstscTargetInCommandLine = String(p.commandLine || '').toLowerCase().includes(host.toLowerCase());
          handle.launch.mstscDiscoveredAtPoll = poll;
          try { registry.registerProcess({ pid: p.pid, role: 'mstsc-production-ui-check', createTime: p.createTime }); } catch (e) { annotate.warning('registry', `mstsc registration failed: ${e.message}`); }
        }
      }
    } catch (e) { annotate.warning('mstsc discovery', redact(e.message)); }
    try {
      const current = await nativeStatusSnapshot(args.target);
      const h = current.handler;
      if (h && h.ok && Date.parse(h.ts) >= Date.parse(mstscStartedIso) - 10000) {
        if (!handlerSeen) annotate.notice('production handler beacon', `verb=${h.verb} ok=true ts=${h.ts}`);
        handlerSeen = true;
        handle.launch.handler = h;
      }
    } catch (e) { annotate.warning('handler beacon', redact(e.message)); }
    if (poll === 2 && !handle.mstsc) {
      const cap = await runPs('Capture-Desktop.ps1', ['-Path', path.join(outDir, 'native-production-launch.png')], { operation: 'production-launch-capture', timeoutMs: 30000 });
      handle.launch.earlyCapture = cap.out;
    }
    if (!handle.mstsc) {
      if (poll >= 4 && !handlerSeen) return { abort: { code: 'PRODUCTION_HANDLER_NOT_OBSERVED', status: STATUS.FAIL, detail: 'the dashboard ticket was issued but no fresh handler beacon or mstsc process appeared; inspect native-production-launch.png for browser protocol consent', evidence: { launch: handle.launch } } };
      return null;
    }
    if (poll === 1 || poll === 2 || poll === 4 || poll === 8 || poll === 14) {
      const ws = await runPs('Get-WindowState.ps1', ['-ProcessId', String(handle.mstsc.pid)], { operation: 'mstsc-window-state', timeoutMs: 30000 });
      let parsed = parseJsonLoose(ws.out);
      if (!parsed) parsed = { raw: ws.out.slice(0, 200) };
      windowSamples.push({ poll, ...parsed });
      const ds = await runPs('Get-RdpDialogState.ps1', ['-ProcessId', String(handle.mstsc.pid)], { operation: 'rdp-dialog-state', timeoutMs: 40000 });
      let dlg = parseJsonLoose(ds.out);
      if (!dlg) dlg = { parseError: ds.out.slice(0, 200) };
      const cls = classifyRdpAttempt({ windows: (dlg && dlg.windows) || [], account: clientAccount, sessionId: (parsed && parsed.sessionId) != null ? parsed.sessionId : null });
      dialogSamples.push({ poll, kind: cls.kind || null, status: cls.status || null, code: cls.code || null, evidenceDigest: cls.evidenceDigest, windows: cls.windows, parseError: dlg && dlg.parseError || dlg && dlg.enumError || null });
      if (cls.blocking) {
        const dlgShot = path.join(outDir, 'native-rdp-dialog.png');
        const capDlg = await runPs('Capture-Desktop.ps1', ['-Path', dlgShot], { operation: 'rdp-dialog-capture', timeoutMs: 30000 });
        dialogSamples.push({ poll, dialogScreenshot: dlgShot, capture: capDlg.out });
        dialogSightings[cls.kind] = (dialogSightings[cls.kind] || 0) + 1;
        if (cls.kind === 'rdp_file_consent' || dialogSightings[cls.kind] >= 2) {
          return { abort: { code: cls.code, status: cls.status, detail: `${cls.reason}${cls.manualAction ? ` Manual action: ${cls.manualAction}` : ''}`, dialog: { kind: cls.kind, windows: cls.windows, evidenceDigest: cls.evidenceDigest, dialogScreenshot: dlgShot }, evidence: { dialogSamples } } };
        }
      }
    }
    if (poll === 4) {
      const during = path.join(outDir, 'native-rdp-during.png');
      const capD = await runPs('Capture-Desktop.ps1', ['-Path', during], { operation: 'rdp-during-capture', timeoutMs: 30000 });
      windowSamples.push({ poll, duringCapture: capD.out, duringScreenshot: during });
    }
    return null;
  };

  const logon = await pollLogon(args.target, baselineIso, user, clientIp, 90000, observe);
  await new Promise(res => setTimeout(res, 4000));
  const shot = path.join(outDir, 'native-rdp-session.png');
  const cap = await runPs('Capture-Desktop.ps1', ['-Path', shot], { operation: 'rdp-native-capture' });
  const img = validateImageFile(shot, { minWidth: 640, minHeight: 400 });
  const stillAlive = handle.mstsc ? await (async () => { const p = await proc.getProcessAsync(handle.mstsc.pid, { timeoutMs: 20000, operation: 'mstsc-liveness' }); return Boolean(p && p.createTime === handle.mstsc.createTime); })() : false;
  let clientDiag = null;
  if (handle.mstsc) {
    try {
      const cd = await runPs('Get-RdpClientDiagnostics.ps1', ['-ProcessId', String(handle.mstsc.pid), '-SinceUtc', mstscStartedIso], { operation: 'rdp-client-diagnostics', timeoutMs: 60000 });
      clientDiag = parseJsonLoose(cd.out) || { parseError: cd.out.slice(0, 300) };
    } catch (e) { clientDiag = { error: redact(e.message) }; }
  }
  const nativePost = logon.ok ? null : await nativeStatusSnapshot(args.target);
  const lastTitle = [...windowSamples].reverse().find(s => s.title !== undefined);
  const lastDialog = [...dialogSamples].reverse().find(s => s.kind) || null;
  handle.launch.handlerObserved = handlerSeen;
  const evidence = {
    logon: logon.body, logonPolls: logon.polls || null, proof: logon.proof || null, proofDetail: logon.proofDetail || null,
    crossCheck: logon.crossCheck ? { state: logon.crossCheck.state, detail: logon.crossCheck.detail } : null,
    baselineIso, tcp3389: tcp, credential: cred.out, nativePre, nativePost, launch: handle.launch,
    windowSamples, dialogSamples, dialog: logon.dialog || (lastDialog ? { kind: lastDialog.kind, code: lastDialog.code, evidenceDigest: lastDialog.evidenceDigest } : null),
    clientDiagnostics: clientDiag, mstscPid: handle.mstsc && handle.mstsc.pid, mstscAlive: stillAlive,
    screenshot: img.valid ? shot : null, capture: cap.out, pageErrors
  };
  const productionComplete = handlerSeen && handle.mstsc && handle.launch.mstscTargetInCommandLine === true;
  if (!logon.ok) {
    const st = logon.status === STATUS.BLOCKED ? STATUS.BLOCKED : STATUS.FAIL;
    caps.set(name, st, `${logon.code || 'RDP_LOGON_FAILED'}: ${logon.detail || 'no fresh type-10 logon'}; productionHandler=${handlerSeen} mstscAlive=${stillAlive} title=${JSON.stringify(lastTitle ? lastTitle.title : null)}`, evidence);
  } else if (!productionComplete) {
    caps.set(name, STATUS.FAIL, `PRODUCTION_CHAIN_INCOMPLETE: handler=${handlerSeen} mstsc=${Boolean(handle.mstsc)} targetInCommandLine=${handle.launch.mstscTargetInCommandLine}`, evidence);
  } else if (!stillAlive) caps.set(name, STATUS.FAIL, 'MSTSC_NOT_ALIVE_AFTER_LOGON', evidence);
  else if (!img.valid) caps.set(name, STATUS.FAIL, `NATIVE_SCREENSHOT_INVALID: ${img.reason} (${cap.out})`, evidence);
  else if (img.nearUniform) caps.set(name, STATUS.FAIL, 'NATIVE_SCREENSHOT_UNIFORM: captured desktop is a single colour', evidence);
  else {
    const proofLabel = logon.proof === 'direct' ? 'type 10 (reported by the endpoint)' : 'type 10 (XML collector, correlated at the event instant)';
    caps.set(name, STATUS.PASS, `production dashboard + handler; 4624 ${proofLabel} ${logon.body.user}@${logon.body.ts} from ${logon.body.sourceIp}; mstsc alive; screenshot ${img.width}x${img.height}`, evidence);
  }
  return handle;
}

async function cleanupRdp(handle) {
  const report = { errors: [], credentialRemoved: false, registrationRemoved: false, browserClosed: false, mstscAbsentOrStopped: false };
  if (!handle) return report;
  if (handle.mstsc) {
    try {
      const p = await proc.getProcessAsync(handle.mstsc.pid, { timeoutMs: 15000, operation: 'mstsc-cleanup-identity' });
      if (!p) report.mstscAbsentOrStopped = true;
      else if (p.createTime === handle.mstsc.createTime) {
        const stopped = proc.terminate(p.pid);
        if (stopped === true || stopped === 'gone') report.mstscAbsentOrStopped = true;
        else report.errors.push('mstsc termination was not confirmed');
      } else report.errors.push('mstsc PID reuse detected during cleanup; the unrelated process was left running');
    } catch (e) { report.errors.push(`mstsc cleanup failed: ${redact(e.message)}`); }
    try { registry.unregisterProcess({ pid: handle.mstsc.pid, createTime: handle.mstsc.createTime }); } catch (e) { /* postflight will retry */ }
  }
  if (handle.credSet) {
    try {
      const r = await runPs('Set-RdpCredential.ps1', ['-Action', 'remove', '-TargetHost', handle.host], { operation: 'rdp-credential-remove' });
      report.credentialRemoved = r.code === 0;
      if (r.code !== 0) report.errors.push(`credential cleanup failed: ${redact(r.out).slice(0, 200)}`);
    } catch (e) { report.errors.push(`credential cleanup failed: ${redact(e.message)}`); }
  }
  if (handle.enrollment && handle.enrollment.attempted) {
    if (!handle.enrollment.registrationBefore.registered) {
      try {
        if (!resolveProtocolHandler().registered) report.registrationRemoved = true;
        else { execFileSync('reg.exe', ['delete', 'HKCU\\Software\\Classes\\ghrdp', '/f'], { stdio: 'pipe', timeout: 15000, windowsHide: true }); report.registrationRemoved = true; }
      } catch (e) { report.errors.push(`handler registry cleanup failed (exit ${e.status === undefined ? 'unknown' : e.status})`); }
    }
    for (const tree of [handle.enrollment.oldTree, handle.enrollment.newTree]) {
      if (!tree) continue;
      try { const r = removeTreeAdditions(tree); report.errors.push(...r.errors); }
      catch (e) { report.errors.push(`handler file cleanup failed: ${redact(e.message)}`); }
    }
  }
  if (handle.uiContext) {
    try { await handle.uiContext.close(); report.browserClosed = true; } catch (e) { report.errors.push(`browser context cleanup failed: ${redact(e.message)}`); }
  }
  return report;
}

async function checkWebDesktop(caps, browser, args, outDir, rdpHandle) {
  const name = 'web_desktop';
  const rdp = caps.get('rdp_auto_login');
  if (rdp.status !== STATUS.PASS) {
    caps.set(name, STATUS.BLOCKED, `DEPENDS_ON_RDP_SESSION: capture engine runs at logon of the RDP user; rdp_auto_login=${rdp.status}`);
    return;
  }
  if (!rdpHandle || !rdpHandle.uiPage || !rdpHandle.uiContext) {
    caps.set(name, STATUS.FAIL, 'PRODUCTION_DASHBOARD_CONTEXT_MISSING: the Web Desktop button cannot be tested after a direct/non-UI RDP path');
    return;
  }
  const deadline = Date.now() + 75000;
  let status = null;
  while (Date.now() < deadline) {
    const r = await request(`${args.target}/webdesk-status`, { timeoutMs: 5000 });
    status = r.json || { error: summarize(r) };
    if (r.json && r.json.ok === true && Number.isFinite(r.json.frameAgeMs) && r.json.frameAgeMs >= 0 && r.json.frameAgeMs < 15000) break;
    await new Promise(res => setTimeout(res, 3000));
  }
  if (!(status && status.ok === true && status.frameAgeMs >= 0 && status.frameAgeMs < 15000)) {
    const probe = await request(`${args.target}/webdesk-probe`, { timeoutMs: 8000 });
    const p = probe.json || {};
    caps.set(name, STATUS.FAIL, `WEBDESK_NO_FRESH_FRAME: status=${JSON.stringify(status)} task=${p.taskState} taskLastRun=${p.taskLastRun} session=${p.sessionState} capture=${p.captureProcAlive}`, { webdeskStatus: status, probe: probe.json });
    return;
  }
  const frame = await request(`${args.target}/webdesk-frame?t=${Date.now()}`, { timeoutMs: 8000 });
  const jpg = frame.transport === 'ok' && frame.status === 200 ? validateJpegBuffer(frame.bytes, { minWidth: 320, minHeight: 200 }) : { valid: false, reason: summarize(frame) };
  if (!jpg.valid) { caps.set(name, STATUS.FAIL, `WEBDESK_FRAME_INVALID: ${jpg.reason}`, { webdeskStatus: status }); return; }
  fs.writeFileSync(path.join(outDir, 'webdesk-frame.jpg'), frame.bytes);

  const dashboard = rdpHandle.uiPage;
  const native = await nativeStatusSnapshot(args.target);
  let expected;
  try { expected = new URL(native.webdeskUrl); } catch (e) { expected = null; }
  if (!expected || !['https:', 'http:'].includes(expected.protocol) || /[?&](key|token|rid|t)=/i.test(expected.search)) {
    caps.set(name, STATUS.BLOCKED, `WEBDESK_URL_NOT_PUBLISHED: native-status has no safe Web Desktop URL`, { webdeskStatus: status });
    return;
  }
  const shot = path.join(outDir, 'web-desktop.png');
  const beforePath = path.join(outDir, 'webdesk-before-input.png');
  const cleanupPath = path.join(outDir, 'webdesk-after-cleanup.png');
  let popup = null;
  const inputResponses = [];
  try {
    await dashboard.bringToFront();
    const button = dashboard.getByTestId('overview-web-desktop');
    await button.waitFor({ state: 'visible', timeout: 15000 });
    await dashboard.waitForFunction(() => {
      const b = document.querySelector('[data-testid="overview-web-desktop"]');
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, null, { timeout: 15000 });
    const popupPromise = rdpHandle.uiContext.waitForEvent('page', { timeout: 15000 });
    await button.click({ noWaitAfter: true });
    try { popup = await popupPromise; }
    catch (e) {
      const fallback = await dashboard.getByTestId('webdesk-blocked').isVisible().catch(() => false);
      await dashboard.screenshot({ path: path.join(outDir, 'webdesk-popup-blocked.png') });
      caps.set(name, fallback ? STATUS.BLOCKED : STATUS.FAIL, fallback ? 'WEBDESK_POPUP_BLOCKED: the dashboard showed its copy/manual fallback; no rendering/input PASS' : 'WEBDESK_POPUP_NOT_OBSERVED', { webdeskStatus: status, fallbackVisible: fallback });
      return;
    }
    popup.on('response', r => {
      try {
        if (new URL(r.url()).pathname !== '/webdesk-input' || r.request().method() !== 'POST') return;
        const row = { status: r.status(), ok: null };
        inputResponses.push(row);
        r.text().then(t => { try { row.ok = JSON.parse(t).ok === true; } catch (e) { row.ok = false; } }).catch(() => { row.ok = false; });
      } catch (e) {}
    });
    const resp = await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).then(() => popup.url());
    const actual = new URL(resp);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw new Error(`WEBDESK_POPUP_ORIGIN_MISMATCH: ${actual.origin}${actual.pathname} != ${expected.origin}${expected.pathname}`);
    if (/[?&](key|token|rid|t)=/i.test(actual.search)) throw new Error('WEBDESK_POPUP_CREDENTIAL_QUERY');
    if (await popup.title() !== 'GHRDP Web Desktop') throw new Error('WEBDESK_WRONG_TITLE');
    await popup.waitForFunction(() => { const i = document.getElementById('view'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
    const image = popup.locator('#view');
    const dims = await popup.evaluate(() => { const i = document.getElementById('view'); return { w: i.naturalWidth, h: i.naturalHeight }; });
    const before = await image.screenshot({ path: beforePath });
    const beforeValid = validatePngBuffer(before, { minWidth: 320, minHeight: 200 });
    if (!beforeValid.valid) throw new Error(`WEBDESK_BROWSER_FRAME_INVALID: ${beforeValid.reason}`);
    const box = await image.boundingBox();
    if (!box || box.width < 320 || box.height < 200) throw new Error('WEBDESK_IMAGE_LAYOUT_INVALID');
    await image.click({ position: { x: Math.floor(box.width / 2), y: Math.floor(box.height / 2) } });
    await popup.keyboard.press('Meta+r');
    await popup.waitForTimeout(1200);
    await popup.keyboard.type('notepad.exe', { delay: 45 });
    await popup.keyboard.press('Enter');
    await popup.waitForTimeout(5500);
    const after = await image.screenshot({ path: shot });
    const diff = comparePng(before, after);
    await popup.waitForTimeout(500);
    const responsesAccepted = inputResponses.length > 0 && inputResponses.every(r => r.status === 200 && r.ok === true);
    const evidence = {
      webdeskStatus: status, popup: { origin: actual.origin, pathname: actual.pathname, credentialQuery: false },
      frame: jpg, browserFrame: dims, input: {
        sequence: 'pointer focus -> Meta+R -> notepad.exe -> Enter', responses: inputResponses.length,
        responsesAccepted, pixelDiff: diff, before: beforePath, after: shot
      }
    };
    if (!diff.comparable) {
      caps.set(name, STATUS.FAIL, `WEBDESK_INPUT_FRAME_COMPARISON_FAILED: ${diff.reason}`, evidence);
    } else if (inputResponses.length < 3 || !responsesAccepted) {
      caps.set(name, STATUS.FAIL, `WEBDESK_INPUT_QUEUE_NOT_ACCEPTED: responses=${inputResponses.length} accepted=${responsesAccepted}`, evidence);
    } else if (diff.changedRatio < 0.05 || diff.meanChannelDelta < 4) {
      caps.set(name, STATUS.FAIL, `WEBDESK_INPUT_NO_VISIBLE_EFFECT: changedRatio=${diff.changedRatio} meanDelta=${diff.meanChannelDelta}; queued input alone is not a PASS`, evidence);
    } else {
      caps.set(name, STATUS.PASS, `production dashboard popup ${actual.origin}${actual.pathname}; frame ${jpg.width}x${jpg.height}; input responses=${inputResponses.length}; changedPixels=${(diff.changedRatio * 100).toFixed(1)}% meanDelta=${diff.meanChannelDelta.toFixed(1)}`, evidence);
    }
    // The disposable Notepad has no typed content, so Alt+F4 closes it without
    // a save prompt. Retain the cleanup frame but never infer cleanup from HTTP.
    await popup.keyboard.press('Alt+F4').catch(() => {});
    await popup.waitForTimeout(1500);
    await image.screenshot({ path: cleanupPath }).catch(() => {});
  } catch (e) {
    try { if (popup) await popup.screenshot({ path: shot }); } catch (e2) {}
    caps.set(name, STATUS.FAIL, redact(e.message).split('\n')[0], { webdeskStatus: status, screenshot: fs.existsSync(shot) ? shot : null, inputResponses });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!DEFS[args.scope]) { console.error(`--scope must be one of ${Object.keys(DEFS).join(', ')}`); process.exit(64); }
  const caps = new CapabilitySet(DEFS[args.scope]);
  const outDir = artifactDir();
  const names = Object.keys(DEFS[args.scope]);
  let lock = null; let browser = null; let rdpHandle = null;
  try {
    // a prerequisite (e.g. the tailnet peer) is missing: record WHY, check nothing
    if (args.blockedReason) throw Object.assign(new Error(args.blockedReason), { blocked: true });
    // an upstream step of the system under test failed (e.g. staging): FAIL with that cause
    if (args.failReason) throw new Error(args.failReason);
    if (!args.target) throw Object.assign(new Error('MISSING_CONFIG: --target is required'), { blocked: true });
    if (!/^[0-9a-f]{40}$/.test(args.expectSha || '')) throw Object.assign(new Error(`MISSING_CONFIG: --expect-sha must be a 40-char commit SHA (got ${JSON.stringify(args.expectSha)})`), { blocked: true });
    try {
      lock = acquireLock({ lockDir: registry.sessionLockDir(), role: `mission-control-${args.scope}`, timeoutMs: Number(process.env.SESSION_LOCK_TIMEOUT_MS || 120000) });
    } catch (e) {
      throw new Error(`LOCK_ACQUISITION_FAILED: ${e.message}`);
    }
    try { registry.registerProcess({ pid: process.pid, role: `mission-control-${args.scope}` }); } catch (e) { annotate.warning('registry', e.message); }

    const backendName = args.scope === 'server-local' ? 'backend_readiness_server_local' : 'backend_readiness_remote';
    const dashName = args.scope === 'server-local' ? 'dashboard_server_local' : 'dashboard_client';
    const readiness = await checkBackend(caps, backendName, args);
    if (readiness && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `backend_pid_${args.scope.replace(/-/g, '_')}=${readiness.pid}\n`);
    }
    if (!readiness) {
      for (const n of names) if (n !== backendName) caps.set(n, STATUS.BLOCKED, `DEPENDS_ON_BACKEND: ${caps.get(backendName).reason}`);
    } else {
      try {
        browser = await launchBrowser(args.headless);
      } catch (e) {
        throw new Error(`BROWSER_LAUNCH_FAILED (${args.headless ? 'headless' : 'headed'}): ${e.message.split('\n')[0]}`);
      }
      await checkDashboard(caps, dashName, browser, args, outDir);
      if (args.scope === 'remote') {
        if (caps.get(dashName).status === STATUS.PASS) {
          rdpHandle = newRdpHandle();
          const result = await checkRdp(caps, browser, args, outDir, readiness, rdpHandle);
          if (!result) rdpHandle = null;
        } else caps.set('rdp_auto_login', STATUS.BLOCKED, `DEPENDS_ON_OPERABLE_DASHBOARD: ${caps.get(dashName).reason}`);
        await checkWebDesktop(caps, browser, args, outDir, rdpHandle);
      }
    }
  } catch (e) {
    const status = e.blocked ? STATUS.BLOCKED : STATUS.FAIL;
    const backendName = args.scope === 'server-local' ? 'backend_readiness_server_local' : 'backend_readiness_remote';
    for (const n of names) {
      if (caps.get(n).status !== STATUS.NOT_RUN) continue;
      // Preserve causal status: an RDP exception is not an independently
      // executed Web Desktop failure, and staging failure blocks dependants.
      if (args.scope === 'remote' && n === 'web_desktop' && caps.get('rdp_auto_login').status !== STATUS.PASS) caps.set(n, STATUS.BLOCKED, `DEPENDS_ON_RDP_SESSION: ${caps.get('rdp_auto_login').reason || e.message}`);
      else if (status === STATUS.FAIL && args.failReason && n !== backendName) caps.set(n, STATUS.BLOCKED, `DEPENDS_ON_BACKEND: ${e.message}`);
      else caps.set(n, status, e.message);
    }
  } finally {
    if (rdpHandle) {
      let cleanup = null;
      try { cleanup = await cleanupRdp(rdpHandle); } catch (e) { cleanup = { errors: [redact(e.message)] }; }
      try { fs.writeFileSync(path.join(outDir, 'production-rdp-cleanup.json'), JSON.stringify(cleanup, null, 2)); } catch (e) { annotate.warning('rdp cleanup evidence', redact(e.message)); }
      if (cleanup && cleanup.errors && cleanup.errors.length) {
        annotate.error('rdp cleanup', cleanup.errors.join(' | ').slice(0, 800));
        const previous = caps.get('rdp_auto_login');
        if (previous.status === STATUS.PASS) caps.set('rdp_auto_login', STATUS.FAIL, `CLEANUP_FAILED after functional PASS: ${cleanup.errors.join(' | ').slice(0, 400)}`, { ...previous.evidence, cleanup });
      }
    }
    if (browser) await browser.close().catch(() => {});
    try { registry.unregisterProcess({ pid: process.pid }); } catch (e) { /* postflight */ }
    if (lock) releaseLock(lock);
  }
  caps.finalizeUnrun('NOT_EXECUTED');
  const agg = caps.aggregate();
  const file = writeCapabilities(args.scope, caps, { target: args.target, expectSha: args.expectSha, aggregate: agg });
  log(`scope=${args.scope} aggregate=${agg.status} -> ${file}`);
  process.exit(agg.accepted ? 0 : 1);
}

if (require.main === module) main();
module.exports = { parseArgs, DEFS, writeRdpFile, tcpProbe };
