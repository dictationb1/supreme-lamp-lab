#!/usr/bin/env node
'use strict';
// Client-local capabilities (self-hosted interactive Windows runner):
//   browser_synthetic  - headed Chromium drives a local page (DOM assertion +
//                        validated screenshot + video). Synthetic: it proves the
//                        browser/desktop works, NOT Mission Control.
//   native_screenshot  - a real capture of the interactive desktop (Windows),
//                        validated as a non-uniform PNG.
// The desktop session lock is mandatory: if it cannot be acquired both
// capabilities FAIL (no "warn and continue").

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { STATUS, CapabilitySet } = require('./lib/status');
const { validatePngBuffer, validateImageFile } = require('./lib/image');
const { acquireLock, releaseLock } = require('./lib/lock');
const registry = require('./lib/registry');
const { writeCapabilities, artifactDir } = require('./lib/results');

const DEFS = {
  browser_synthetic: { required: true, contract: 'headed chromium: local page DOM interaction asserted, valid PNG screenshot, video recorded' },
  native_screenshot: { required: true, contract: 'Windows interactive desktop captured to a valid, non-uniform PNG' }
};

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Supreme Lamp Lab Synthetic Check</title>
<style>body{font-family:sans-serif;margin:40px;background:#f0f4f8;color:#102a43}#output{padding:10px;background:#d9e2ec;margin-top:10px}</style></head>
<body><h1>Supreme Lamp Lab - synthetic browser check</h1><p id="status">Status: Ready</p>
<button id="action-btn">Run Interaction Test</button><div id="output">Initial</div>
<script>document.getElementById('action-btn').addEventListener('click',()=>{document.getElementById('output').innerText='Interaction Successful';document.getElementById('status').innerText='Status: Clicked';});</script>
</body></html>`;

function startServer() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function browserSynthetic(caps, outDir) {
  const name = 'browser_synthetic';
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { caps.set(name, STATUS.FAIL, `PLAYWRIGHT_MISSING: ${e.message}`); return; }
  const { server, url } = await startServer();
  let browser = null; let context = null;
  const shot = path.join(outDir, 'browser-synthetic.png');
  const videoDir = path.join(outDir, 'video-browser-synthetic');
  const pageErrors = [];
  try {
    try { browser = await chromium.launch({ headless: false }); } catch (e) { throw new Error(`HEADED_LAUNCH_FAILED: ${e.message.split('\n')[0]}`); }
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    const initial = (await page.textContent('#output')).trim();
    if (initial !== 'Initial') throw new Error(`UNEXPECTED_INITIAL_STATE: ${initial}`);
    await page.click('#action-btn');
    await page.waitForFunction(() => document.getElementById('output').innerText === 'Interaction Successful', null, { timeout: 5000 });
    await page.screenshot({ path: shot });
    await page.waitForTimeout(800);
    const img = validatePngBuffer(fs.readFileSync(shot), { minWidth: 640, minHeight: 360 });
    if (!img.valid) throw new Error(`SCREENSHOT_INVALID: ${img.reason}`);
    if (pageErrors.length) throw new Error(`PAGE_ERRORS: ${pageErrors.join(' | ')}`);
    await context.close(); context = null; // flush video
    const video = fs.existsSync(videoDir) ? fs.readdirSync(videoDir).find(f => f.endsWith('.webm')) : null;
    const videoBytes = video ? fs.statSync(path.join(videoDir, video)).size : 0;
    if (!video || videoBytes < 1000) throw new Error(`VIDEO_MISSING_OR_EMPTY: ${video || 'none'} (${videoBytes} bytes)`);
    caps.set(name, STATUS.PASS, `DOM interaction asserted; screenshot ${img.width}x${img.height}; video ${videoBytes} bytes`, { screenshot: shot, video: path.join(videoDir, video) });
  } catch (e) {
    caps.set(name, STATUS.FAIL, e.message, { pageErrors });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
}

function nativeScreenshot(caps, outDir) {
  const name = 'native_screenshot';
  if (process.platform !== 'win32') { caps.set(name, STATUS.BLOCKED, 'PLATFORM: native desktop capture is implemented for Windows interactive runners only'); return; }
  const shot = path.join(outDir, 'native-desktop.png');
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ps', 'Capture-Desktop.ps1'), '-Path', shot], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const img = validateImageFile(shot, { minWidth: 640, minHeight: 400 });
  if (r.status !== 0 || !img.valid) caps.set(name, STATUS.FAIL, `NATIVE_CAPTURE_FAILED: exit=${r.status} ${out} ${img.reason || ''}`.trim());
  else if (img.nearUniform) caps.set(name, STATUS.FAIL, `NATIVE_SCREENSHOT_UNIFORM: ${out} (locked or blank desktop?)`, { screenshot: shot });
  else caps.set(name, STATUS.PASS, `${out}; ${img.width}x${img.height}`, { screenshot: shot });
}

async function main() {
  const caps = new CapabilitySet(DEFS);
  const outDir = artifactDir();
  let lock = null;
  try {
    try {
      lock = acquireLock({ lockDir: registry.sessionLockDir(), role: 'browser-check', timeoutMs: Number(process.env.SESSION_LOCK_TIMEOUT_MS || 120000) });
    } catch (e) {
      throw new Error(`LOCK_ACQUISITION_FAILED: ${e.message}`);
    }
    try { registry.registerProcess({ pid: process.pid, role: 'browser-check' }); } catch (e) { console.warn(`[registry] ${e.message}`); }
    await browserSynthetic(caps, outDir);
    nativeScreenshot(caps, outDir);
  } catch (e) {
    for (const n of Object.keys(DEFS)) if (caps.get(n).status === STATUS.NOT_RUN) caps.set(n, STATUS.FAIL, e.message);
  } finally {
    try { registry.unregisterProcess({ pid: process.pid }); } catch (e) { /* postflight */ }
    if (lock) releaseLock(lock);
  }
  const agg = caps.aggregate();
  const file = writeCapabilities('client-local', caps, { aggregate: agg });
  console.log(`client-local aggregate=${agg.status} -> ${file}`);
  process.exit(agg.accepted ? 0 : 1);
}

if (require.main === module) main();
module.exports = { DEFS };
