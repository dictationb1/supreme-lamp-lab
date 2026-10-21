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
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { STATUS, CapabilitySet } = require('./lib/status');
const { request, summarize } = require('./lib/http');
const { waitForReady, checkVersion } = require('./lib/readiness');
const { validatePngBuffer, validateJpegBuffer, validateImageFile } = require('./lib/image');
const { acquireLock, releaseLock } = require('./lib/lock');
const registry = require('./lib/registry');
const proc = require('./lib/proc');
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
    rdp_auto_login: { required: true, contract: 'mstsc with stored TERMSRV credential; server 4624 LogonType 10 for user, newer than baseline, sourceIp==client tailnet IP; mstsc alive; valid native screenshot' },
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
    const title = await page.title();
    if (title !== 'RDP Mission Control') throw new Error(`DASHBOARD_WRONG_TITLE: ${JSON.stringify(title)}`);
    const build = await page.getAttribute('meta#ghrdpBuild', 'content');
    if (build !== args.expectSha) throw new Error(`DASHBOARD_BUILD_MISMATCH: meta#ghrdpBuild=${JSON.stringify(build)} expected ${args.expectSha}`);
    await page.waitForSelector('#topbar', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
    const img = validatePngBuffer(fs.readFileSync(shot), { minWidth: 640, minHeight: 400 });
    if (!img.valid) throw new Error(`DASHBOARD_SCREENSHOT_INVALID: ${img.reason}`);
    caps.set(name, STATUS.PASS, `title ok, build ${build.slice(0, 12)}, #topbar visible, screenshot ${img.width}x${img.height}`, { screenshot: shot, pageErrors });
  } catch (e) {
    try { await page.screenshot({ path: shot }); } catch (e2) { /* ignore */ }
    caps.set(name, STATUS.FAIL, e.message.split('\n')[0], { screenshot: fs.existsSync(shot) ? shot : null, pageErrors });
  } finally {
    if (pageErrors.length) annotate.warning(`${name} page errors`, pageErrors.slice(0, 5).join(' | '));
    await ctx.close().catch(() => {});
  }
}

function runPs(script, psArgs, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, script), ...psArgs], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ...env }
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function writeRdpFile(file, host, user) {
  // authentication level 0: do not block on the lab server's self-signed cert
  // prompt for credentials 0: use the TERMSRV/<host> generic credential
  const lines = [
    `full address:s:${host}`, `username:s:${user}`, 'prompt for credentials:i:0', 'promptcredentialonce:i:0',
    'authentication level:i:0', 'enablecredsspsupport:i:1', 'negotiate security layer:i:1',
    'screen mode id:i:1', 'desktopwidth:i:1280', 'desktopheight:i:800', 'session bpp:i:32',
    'redirectclipboard:i:0', 'redirectprinters:i:0', 'redirectdrives:i:0', 'redirectsmartcards:i:0',
    'autoreconnection enabled:i:0', 'administrative session:i:0'
  ];
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`, { encoding: 'utf16le' });
}

async function pollLogon(target, baselineIso, user, clientIp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await request(`${target}/api/logon-status?since=${encodeURIComponent(baselineIso)}&user=${encodeURIComponent(user)}`, { timeoutMs: 8000 });
    if (r.transport === 'ok' && r.json) {
      last = r.json;
      const j = r.json;
      const newer = j.ts && Date.parse(j.ts) >= Date.parse(baselineIso);
      if (j.connected === true && String(j.logonType) === '10' && newer && j.sourceIp === clientIp) return { ok: true, body: j };
      if (j.connected === true && String(j.logonType) === '10' && newer && j.sourceIp !== clientIp) {
        return { ok: false, code: 'RDP_LOGON_WRONG_SOURCE', body: j, detail: `sourceIp ${j.sourceIp} != client tailnet ip ${clientIp}` };
      }
    } else {
      last = { error: summarize(r) };
    }
    await new Promise(res => setTimeout(res, 3000));
  }
  return { ok: false, code: 'RDP_LOGON_NOT_OBSERVED', body: last, detail: `no LogonType 10 for ${user} from ${clientIp} since ${baselineIso} within ${timeoutMs}ms` };
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
  const cred = runPs('Set-RdpCredential.ps1', ['-Action', 'set', '-TargetHost', host, '-User', user]);
  if (cred.code !== 0) { caps.set(name, cred.code === 3 ? STATUS.BLOCKED : STATUS.FAIL, `CREDENTIAL_SET_FAILED: ${cred.out}`); return handle; }
  handle.credSet = true;
  writeRdpFile(handle.rdpFile, host, user);

  const child = spawn(mstscExe, [handle.rdpFile], { detached: false, stdio: 'ignore', windowsHide: false });
  await new Promise(res => setTimeout(res, 1500));
  const live = proc.getProcess(child.pid);
  if (!live) { caps.set(name, STATUS.FAIL, 'MSTSC_EXITED_IMMEDIATELY'); return handle; }
  handle.mstsc = { pid: live.pid, createTime: live.createTime };
  try { registry.registerProcess({ pid: live.pid, role: 'mstsc-rdp-check' }); } catch (e) { annotate.warning('registry', `mstsc registration failed: ${e.message}`); }
  log(`mstsc pid=${live.pid} -> ${host} as ${user}; baseline ${baselineIso}`);

  const logon = await pollLogon(args.target, baselineIso, user, clientIp, 90000);
  await new Promise(res => setTimeout(res, 4000)); // let the session paint before capturing
  const shot = path.join(outDir, 'native-rdp-session.png');
  const cap = runPs('Capture-Desktop.ps1', ['-Path', shot]);
  const img = validateImageFile(shot, { minWidth: 640, minHeight: 400 });
  const stillAlive = (() => { const p = proc.getProcess(handle.mstsc.pid); return Boolean(p && p.createTime === handle.mstsc.createTime); })();
  const evidence = { logon: logon.body, baselineIso, mstscPid: handle.mstsc.pid, mstscAlive: stillAlive, screenshot: img.valid ? shot : null, capture: cap.out };
  if (!logon.ok) caps.set(name, STATUS.FAIL, `${logon.code}: ${logon.detail}`, evidence);
  else if (!stillAlive) caps.set(name, STATUS.FAIL, 'MSTSC_NOT_ALIVE_AFTER_LOGON', evidence);
  else if (!img.valid) caps.set(name, STATUS.FAIL, `NATIVE_SCREENSHOT_INVALID: ${img.reason} (${cap.out})`, evidence);
  else if (img.nearUniform) caps.set(name, STATUS.FAIL, 'NATIVE_SCREENSHOT_UNIFORM: captured desktop is a single colour', evidence);
  else caps.set(name, STATUS.PASS, `4624 type 10 ${logon.body.user}@${logon.body.ts} from ${logon.body.sourceIp}; mstsc alive; screenshot ${img.width}x${img.height}`, evidence);
  return handle;
}

function cleanupRdp(handle) {
  if (!handle) return;
  if (handle.mstsc) {
    const p = proc.getProcess(handle.mstsc.pid);
    if (p && p.createTime === handle.mstsc.createTime) proc.terminate(p.pid);
    try { registry.unregisterProcess({ pid: handle.mstsc.pid, createTime: handle.mstsc.createTime }); } catch (e) { /* postflight will retry */ }
  }
  if (handle.credSet) {
    const r = runPs('Set-RdpCredential.ps1', ['-Action', 'remove', '-TargetHost', handle.host]);
    log(`credential cleanup: ${r.out}`);
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
    caps.set(name, STATUS.FAIL, `WEBDESK_NO_FRESH_FRAME: status=${JSON.stringify(status)} task=${p.taskState} session=${p.sessionState} capture=${p.captureProcAlive}`, { webdeskStatus: status, probe: probe.json });
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
    for (const n of names) if (caps.get(n).status === STATUS.NOT_RUN) caps.set(n, status, e.message);
  } finally {
    try { cleanupRdp(rdpHandle); } catch (e) { annotate.warning('rdp cleanup', e.message); }
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
module.exports = { parseArgs, DEFS, writeRdpFile };
