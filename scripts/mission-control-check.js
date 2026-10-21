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
const path = require('path');
const { spawn } = require('child_process');
const { STATUS, CapabilitySet } = require('./lib/status');
const { request, summarize } = require('./lib/http');
const { evaluateLogonStatus, evaluateNativeCrossCheck, digestLogonBody } = require('./lib/logon');
const { waitForReady, checkVersion } = require('./lib/readiness');
const { validatePngBuffer, validateJpegBuffer, validateImageFile } = require('./lib/image');
const { acquireLock, releaseLock } = require('./lib/lock');
const registry = require('./lib/registry');
const proc = require('./lib/proc');
const ps = require('./lib/ps');
const { writeCapabilities, artifactDir } = require('./lib/results');
const annotate = require('./lib/annotate');

const PS_DIR = path.join(__dirname, 'ps');

const DEFS = {
  'server-local': {
    backend_readiness_server_local: { required: true, contract: '/api/readiness ok&&status=ok&&phase=ready&&apiReadiness, pid==supervised pid, port; /api/version sha==expected' },
    dashboard_server_local: { required: true, contract: 'GET / 200 html, title "RDP Mission Control", meta#ghrdpBuild==expected sha, #topbar visible, valid screenshot' }
  },
  remote: {
    backend_readiness_remote: { required: true, contract: 'same readiness+version contract over the tailnet' },
    dashboard_client: { required: true, contract: 'headed browser on client renders the real dashboard (title, build meta, #topbar), valid screenshot' },
    rdp_auto_login: { required: true, contract: 'TCP 3389 reachable; mstsc with stored TERMSRV credential; server 4624 for user newer than baseline with sourceIp==client tailnet IP and LogonType 10 (reported directly, or derived - endpoint accepts only 2/10/11 and only 10 carries a remote source - and cross-checked against /api/native-status authLast); mstsc alive; valid native screenshot' },
    web_desktop: { required: true, contract: '/webdesk-status ok&&0<=frameAgeMs<15000; /webdesk-frame valid JPEG; /webdesk renders img#view with naturalWidth>0' }
  }
};

function parseArgs(argv) {
  const a = { scope: null, target: null, expectSha: null, expectPid: null, expectPort: 7331, headless: false, readyTimeoutMs: 120000, blockedReason: null, failReason: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--scope') a.scope = argv[++i];
    else if (k === '--target') a.target = (argv[++i] || '').replace(/\/+$/, '');
    else if (k === '--expect-sha') a.expectSha = argv[++i];
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

async function checkDashboard(caps, name, browser, args, outDir) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, recordVideo: { dir: path.join(outDir, `video-${name}`) } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e).slice(0, 300)));
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
    const v = await dashboardVariant(page, args.expectSha, pageErrors);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
    const img = validatePngBuffer(fs.readFileSync(shot), { minWidth: 640, minHeight: 400 });
    if (!img.valid) throw new Error(`DASHBOARD_SCREENSHOT_INVALID: ${img.reason}`);
    caps.set(name, STATUS.PASS, `${v.variant}: title ok, build ${v.build.slice(0, 12)} (${v.stamps}), ${v.shell} visible, screenshot ${img.width}x${img.height}`, { screenshot: shot, pageErrors, variant: v.variant });
  } catch (e) {
    try { await page.screenshot({ path: shot }); } catch (e2) { /* ignore */ }
    caps.set(name, STATUS.FAIL, e.message.split('\n')[0], { screenshot: fs.existsSync(shot) ? shot : null, pageErrors });
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

function writeRdpFile(file, host, user) {
  // authentication level 0: do not block on the lab server's self-signed cert
  // prompt for credentials 0: use the stored TERMSRV/<host> credential
  const lines = [
    `full address:s:${host}`, `username:s:${user}`, 'prompt for credentials:i:0', 'promptcredentialonce:i:0',
    'authentication level:i:0', 'enablecredsspsupport:i:1', 'negotiate security layer:i:1',
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
      !text.includes('prompt for credentials:i:0')) {
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
 * Ask the app's F28 collector (XML-parsing, /api/native-status) about the
 * candidate event. Bounded: the collector ticks every 30s, so allow one
 * tick + margin. A contradiction vetoes the candidate; "unavailable" is
 * recorded in evidence and the logon-status proof decides on its own.
 */
async function crossCheckLogon(target, candidateTsIso, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = { state: 'unavailable', detail: 'native-status not fetched' };
  let lastAuth = null;
  for (;;) {
    const r = await request(`${target}/api/native-status`, { timeoutMs: 10000 });
    if (r.transport === 'ok' && r.json) {
      lastAuth = (r.json.rdpListener && r.json.rdpListener.authLast) || r.json.authLast || null;
      last = evaluateNativeCrossCheck(lastAuth, candidateTsIso);
      if (last.state !== 'unavailable') return { ...last, authLast: lastAuth };
    } else {
      last = { state: 'unavailable', detail: `native-status ${summarize(r)}` };
    }
    if (Date.now() >= deadline) return { ...last, authLast: lastAuth };
    await new Promise(res => setTimeout(res, 5000));
  }
}

/**
 * One bounded read of the app's observer/collector state. Used before the
 * attempt (is the Security-log observer even able to read, i.e. probeError?)
 * and after a failure (connLog names pre-LSA drops - TLS/cert - that never
 * produce a 4624/4625). Never throws; shape is extracted defensively.
 */
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
  return {
    authLast: a ? {
      result: a.result, logonType: a.logonType == null ? '' : String(a.logonType), eventTs: a.eventTs || '',
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
  return `authLast result=${a.result} type=${JSON.stringify(a.logonType)} eventTs=${a.eventTs} scanTs=${a.scanTs} ` +
    `4624=${a.count4624} 4625=${a.count4625} probeError=${JSON.stringify(a.probeError || '')} sub=${a.sub} ${a.subMeaning}; ` +
    `collector alive=${c.alive} scans=${c.scans}; connLog: ${cl}`.slice(0, 600);
}

function digestClientDiagnostics(d) {
  if (!d) return 'client diagnostics: not collected';
  const ev = (d.rdpClientEvents || []).map(e => `${e.id}@${e.timeUtc} ${String(e.message || '').slice(0, 110)}`).join(' | ') || 'none';
  const win = (d.windows || []).map(w => `${w.process}(${w.pid}):${JSON.stringify(w.title)}`).join(' | ') || 'none';
  const tcp = (d.tcpConnections || []).map(t => `${t.remote}=${t.state}`).join(' | ') || 'none';
  const p = d.policy || {};
  const pol = `disablePwSave(M=${p.disablePasswordSavingMachine} U=${p.disablePasswordSavingUser}) promptPw=${p.promptForPasswordMachine} ` +
    `allowSaved=${JSON.stringify(p.allowSavedCredentials || {})} allowSavedNtlm=${JSON.stringify(p.allowSavedCredentialsNtlm || {})}`;
  return {
    events: `rdpClient readable=${d.rdpClientLogReadable} count=${d.rdpClientCount} err=${d.rdpClientError || ''}: ${ev}`.slice(0, 1300),
    windows: `windows: ${win}; mstsc tcp: ${tcp}; policy: ${pol}`.slice(0, 1300)
  };
}

async function pollLogon(target, baselineIso, user, clientIp, timeoutMs, onTick = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const r = await request(`${target}/api/logon-status?since=${encodeURIComponent(baselineIso)}&user=${encodeURIComponent(user)}`, { timeoutMs: 8000 });
    if (r.transport === 'ok' && r.json) {
      last = r.json;
      const ev = evaluateLogonStatus(r.json, { baselineIso, clientIp });
      if (ev.state === 'wrong-source') return { ok: false, code: 'RDP_LOGON_WRONG_SOURCE', body: last, polls, detail: ev.detail };
      if (ev.state === 'type-mismatch') return { ok: false, code: 'RDP_LOGON_TYPE_MISMATCH', body: last, polls, detail: ev.detail };
      if (ev.state === 'candidate') {
        log(`logon candidate (${ev.proof}): ${ev.detail}; cross-checking authLast`);
        const cross = await crossCheckLogon(target, r.json.ts, 45000);
        log(`logon cross-check: ${cross.state} - ${cross.detail}`);
        if (cross.state === 'contradicted') {
          return {
            ok: false, code: 'RDP_LOGON_TYPE_MISMATCH', body: last, polls, proof: ev.proof, crossCheck: cross,
            detail: `native-status collector contradicts the logon-status candidate: ${cross.detail}`
          };
        }
        return { ok: true, body: last, polls, proof: ev.proof, proofDetail: ev.detail, crossCheck: cross };
      }
    } else {
      last = { error: summarize(r) };
    }
    if (onTick) { try { await onTick(polls, last); } catch (e) { annotate.warning('rdp observation', e.message); } }
    await new Promise(res => setTimeout(res, 3000));
  }
  return {
    ok: false, code: 'RDP_LOGON_NOT_OBSERVED', body: last, polls,
    detail: `no LogonType 10 for ${user} from ${clientIp} since ${baselineIso} within ${timeoutMs}ms; last ${digestLogonBody(last)}`
  };
}

/** Returns an owned-mstsc handle (or null). Caller must call cleanupRdp(). */
async function checkRdp(caps, args, outDir, readinessBody) {
  const name = 'rdp_auto_login';
  const host = process.env.RDP_HOST;
  const user = process.env.RDP_USER;
  const pass = process.env.RDP_LAB_PASSWORD;
  const clientIp = process.env.CLIENT_TAILNET_IP;
  if (process.platform !== 'win32') { caps.set(name, STATUS.BLOCKED, 'PLATFORM: native mstsc requires a Windows client'); return null; }
  const missing = [['RDP_HOST', host], ['RDP_USER', user], ['RDP_LAB_PASSWORD', pass], ['CLIENT_TAILNET_IP', clientIp]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { caps.set(name, STATUS.BLOCKED, `MISSING_CONFIG: ${missing.join(', ')}`); return null; }
  const mstscExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
  if (!fs.existsSync(mstscExe)) { caps.set(name, STATUS.FAIL, `MSTSC_NOT_FOUND: ${mstscExe}`); return null; }

  // baseline from the SERVER clock (avoids client/server skew), minus 2s for the
  // second-precision serverTs
  const baselineIso = new Date(Date.parse(readinessBody.serverTs) - 2000).toISOString();
  const handle = { host, rdpFile: path.join(outDir, 'slab-lab.rdp'), credSet: false, mstsc: null };

  // Transport first: tailnet reachability of TCP 7331 proves NOTHING about
  // TCP 3389 (separate listener, firewall rule and tailnet policy). A failed
  // probe is its own failure category, distinct from an unobserved logon.
  const tcp = await tcpProbe(host, 3389, 6000);
  log(`tcp 3389 probe -> ${host}: ok=${tcp.ok} ms=${tcp.ms}${tcp.error ? ` error=${tcp.error}` : ''}`);
  if (!tcp.ok) {
    caps.set(name, STATUS.FAIL, `RDP_TCP_3389_UNREACHABLE: ${host}:3389 ${tcp.error} (probe ${tcp.ms}ms; backend 7331 was reachable)`,
      { tcp3389: tcp, baselineIso });
    return handle;
  }

  const cred = await runPs('Set-RdpCredential.ps1', ['-Action', 'set', '-TargetHost', host, '-User', user], { operation: 'rdp-credential-set' });
  if (cred.code !== 0) { caps.set(name, cred.code === 3 ? STATUS.BLOCKED : STATUS.FAIL, `CREDENTIAL_SET_FAILED: ${cred.out}`, { diagnostic: cred.diagnostic, tcp3389: tcp }); return handle; }
  handle.credSet = true;
  let rdpFileInfo;
  try { rdpFileInfo = writeRdpFile(handle.rdpFile, host, user); } catch (e) {
    caps.set(name, STATUS.FAIL, e.message, { tcp3389: tcp, credential: cred.out });
    return handle;
  }
  log('whoami/session for credential identity: see Set-RdpCredential output; ' +
    `credential=${cred.out} rdpFile=${rdpFileInfo.bytes}B/${rdpFileInfo.directives} directives (utf8, read-back ok)`);
  annotate.notice('rdp attempt setup', `${cred.out}; rdpFile ${rdpFileInfo.bytes}B/${rdpFileInfo.directives} directives utf8 read-back-ok; baseline ${baselineIso}`);

  // Observer health BEFORE the attempt: if the backend process cannot read
  // the Security log, checked stays 0 and no logon can ever be observed -
  // better to learn that here than to infer it from a timeout afterwards.
  const nativePre = await nativeStatusSnapshot(args.target);
  log(`native-status (pre): ${digestNative(nativePre)}`);
  annotate.notice('rdp observer (pre)', digestNative(nativePre));

  const mstscStartedIso = new Date(Date.now() - 5000).toISOString();
  const child = spawn(mstscExe, [handle.rdpFile], { detached: false, stdio: 'ignore', windowsHide: false });
  await new Promise(res => setTimeout(res, 1500));
  const live = await proc.getProcessAsync(child.pid, { timeoutMs: 20000, operation: 'mstsc-identity' });
  if (!live) { caps.set(name, STATUS.FAIL, 'MSTSC_EXITED_IMMEDIATELY', { tcp3389: tcp, credential: cred.out, rdpFile: rdpFileInfo }); return handle; }
  handle.mstsc = { pid: live.pid, createTime: live.createTime };
  try { registry.registerProcess({ pid: live.pid, role: 'mstsc-rdp-check' }); } catch (e) { annotate.warning('registry', `mstsc registration failed: ${e.message}`); }
  log(`mstsc pid=${live.pid} -> ${host} as ${user}; baseline ${baselineIso}`);

  // Observe the attempt while it happens (bounded): mstsc's window state
  // distinguishes "sitting at a dialog" from "connected session", and a
  // mid-attempt screenshot shows any certificate/credential prompt - a
  // post-timeout screenshot alone (the old behaviour) can miss both.
  const windowSamples = [];
  const observe = async poll => {
    if (!handle.mstsc) return;
    if (poll === 1 || poll === 2 || poll === 6 || poll === 14) {
      const ws = await runPs('Get-WindowState.ps1', ['-ProcessId', String(handle.mstsc.pid)], { operation: 'mstsc-window-state', timeoutMs: 30000 });
      let parsed = null;
      try { parsed = JSON.parse(ws.out); } catch (e) { parsed = { raw: ws.out.slice(0, 200) }; }
      windowSamples.push({ poll, ...parsed });
      log(`mstsc window sample poll=${poll}: ${JSON.stringify(parsed).slice(0, 220)}`);
      annotate.notice('rdp mstsc window', `poll=${poll} ${JSON.stringify(parsed).slice(0, 220)}`);
    }
    if (poll === 4) {
      const during = path.join(outDir, 'native-rdp-during.png');
      const capD = await runPs('Capture-Desktop.ps1', ['-Path', during], { operation: 'rdp-during-capture', timeoutMs: 30000 });
      log(`during-attempt capture: ${capD.out}`);
      windowSamples.push({ poll, duringCapture: capD.out, duringScreenshot: during });
    }
  };

  const logon = await pollLogon(args.target, baselineIso, user, clientIp, 90000, observe);
  await new Promise(res => setTimeout(res, 4000)); // let the session paint before capturing
  const shot = path.join(outDir, 'native-rdp-session.png');
  const cap = await runPs('Capture-Desktop.ps1', ['-Path', shot], { operation: 'rdp-native-capture' });
  const img = validateImageFile(shot, { minWidth: 640, minHeight: 400 });
  const stillAlive = await (async () => { const p = await proc.getProcessAsync(handle.mstsc.pid, { timeoutMs: 20000, operation: 'mstsc-liveness' }); return Boolean(p && p.createTime === handle.mstsc.createTime); })();

  // What did THIS client actually do? (Run 39569844830: server logs proved
  // no RDP connection request ever arrived while mstsc idled - the answer
  // is only in the client's RDPClient log / windows / sockets.)
  let clientDiag = null;
  try {
    const cd = await runPs('Get-RdpClientDiagnostics.ps1', ['-ProcessId', String(handle.mstsc.pid), '-SinceUtc', mstscStartedIso], { operation: 'rdp-client-diagnostics', timeoutMs: 60000 });
    try { clientDiag = JSON.parse(cd.out); } catch (e) { clientDiag = { parseError: cd.out.slice(0, 300) }; }
  } catch (e) { clientDiag = { error: e.message }; }
  const nativePost = logon.ok ? null : await nativeStatusSnapshot(args.target);

  const lastTitle = [...windowSamples].reverse().find(s => s.title !== undefined);
  const evidence = {
    logon: logon.body, logonPolls: logon.polls || null, proof: logon.proof || null, proofDetail: logon.proofDetail || null,
    crossCheck: logon.crossCheck ? { state: logon.crossCheck.state, detail: logon.crossCheck.detail } : null,
    baselineIso, tcp3389: tcp, credential: cred.out, rdpFile: rdpFileInfo, windowSamples,
    nativePre, nativePost, clientDiagnostics: clientDiag,
    mstscPid: handle.mstsc.pid, mstscAlive: stillAlive, screenshot: img.valid ? shot : null, capture: cap.out
  };
  if (!logon.ok) {
    const cdg = digestClientDiagnostics(clientDiag);
    annotate.error('rdp client events', typeof cdg === 'string' ? cdg : cdg.events);
    if (typeof cdg !== 'string') annotate.error('rdp client windows/policy', cdg.windows);
    annotate.error('rdp observer (post)', digestNative(nativePost));
    const firstEv = clientDiag && Array.isArray(clientDiag.rdpClientEvents) ? clientDiag.rdpClientEvents[0] : null;
    const evHint = firstEv ? ` rdpClient ${firstEv.id}: ${String(firstEv.message || '').slice(0, 90)}` : '';
    const tail = `mstscAlive=${stillAlive} title=${JSON.stringify(lastTitle ? lastTitle.title : null)} hasWindow=${lastTitle ? lastTitle.hasWindow : null};${evHint}`;
    caps.set(name, STATUS.FAIL, `${logon.code}: ${logon.detail}; ${tail}`, evidence);
  } else if (!stillAlive) caps.set(name, STATUS.FAIL, 'MSTSC_NOT_ALIVE_AFTER_LOGON', evidence);
  else if (!img.valid) caps.set(name, STATUS.FAIL, `NATIVE_SCREENSHOT_INVALID: ${img.reason} (${cap.out})`, evidence);
  else if (img.nearUniform) caps.set(name, STATUS.FAIL, 'NATIVE_SCREENSHOT_UNIFORM: captured desktop is a single colour', evidence);
  else {
    const cross = logon.crossCheck ? ` authLast=${logon.crossCheck.state}` : '';
    caps.set(name, STATUS.PASS, `4624 ${logon.proof === 'direct' ? 'type 10' : 'type 10 (derived)'} ${logon.body.user}@${logon.body.ts} from ${logon.body.sourceIp};${cross} mstsc alive; screenshot ${img.width}x${img.height}`, evidence);
  }
  return handle;
}

async function cleanupRdp(handle) {
  if (!handle) return;
  if (handle.mstsc) {
    // identity-verified kill only; unknown identity leaves the process to the
    // registry-backed postflight cleanup instead of a blind pid kill
    let p = null;
    try { p = await proc.getProcessAsync(handle.mstsc.pid, { timeoutMs: 15000, operation: 'mstsc-cleanup-identity' }); } catch (e) { annotate.warning('rdp cleanup', `identity unavailable: ${e.message}`); }
    if (p && p.createTime === handle.mstsc.createTime) proc.terminate(p.pid);
    try { registry.unregisterProcess({ pid: handle.mstsc.pid, createTime: handle.mstsc.createTime }); } catch (e) { /* postflight will retry */ }
  }
  if (handle.credSet) {
    const r = await runPs('Set-RdpCredential.ps1', ['-Action', 'remove', '-TargetHost', handle.host], { operation: 'rdp-credential-remove' });
    log(`credential cleanup: ${r.code === 0 ? 'ok' : r.out}`);
  }
  try { if (handle.rdpFile && fs.existsSync(handle.rdpFile)) fs.unlinkSync(handle.rdpFile); } catch (e) { /* ignore */ }
}

async function checkWebDesktop(caps, browser, args, outDir) {
  const name = 'web_desktop';
  const rdp = caps.get('rdp_auto_login');
  if (rdp.status !== STATUS.PASS) {
    caps.set(name, STATUS.BLOCKED, `DEPENDS_ON_RDP_SESSION: capture engine runs at logon of the RDP user; rdp_auto_login=${rdp.status}`);
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
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  const page = await ctx.newPage();
  const shot = path.join(outDir, 'web-desktop.png');
  try {
    const resp = await page.goto(`${args.target}/webdesk`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.status() !== 200) throw new Error(`WEBDESK_HTTP: ${resp && resp.status()}`);
    const title = await page.title();
    if (title !== 'GHRDP Web Desktop') throw new Error(`WEBDESK_WRONG_TITLE: ${JSON.stringify(title)}`);
    await page.waitForFunction(() => { const i = document.getElementById('view'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
    const dims = await page.evaluate(() => { const i = document.getElementById('view'); return { w: i.naturalWidth, h: i.naturalHeight }; });
    await page.screenshot({ path: shot });
    caps.set(name, STATUS.PASS, `frameAge=${status.frameAgeMs}ms frame ${jpg.width}x${jpg.height}; browser img#view ${dims.w}x${dims.h}`, { webdeskStatus: status, screenshot: shot });
  } catch (e) {
    try { await page.screenshot({ path: shot }); } catch (e2) { /* ignore */ }
    caps.set(name, STATUS.FAIL, e.message.split('\n')[0], { webdeskStatus: status, screenshot: fs.existsSync(shot) ? shot : null });
  } finally {
    await ctx.close().catch(() => {});
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
        rdpHandle = await checkRdp(caps, args, outDir, readiness);
        await checkWebDesktop(caps, browser, args, outDir);
      }
    }
  } catch (e) {
    const status = e.blocked ? STATUS.BLOCKED : STATUS.FAIL;
    const backendName = args.scope === 'server-local' ? 'backend_readiness_server_local' : 'backend_readiness_remote';
    for (const n of names) {
      if (caps.get(n).status !== STATUS.NOT_RUN) continue;
      // the backend capability carries the causal FAIL; dependants are BLOCKED by it
      if (status === STATUS.FAIL && args.failReason && n !== backendName) caps.set(n, STATUS.BLOCKED, `DEPENDS_ON_BACKEND: ${e.message}`);
      else caps.set(n, status, e.message);
    }
  } finally {
    try { await cleanupRdp(rdpHandle); } catch (e) { annotate.warning('rdp cleanup', e.message); }
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
