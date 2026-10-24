#!/usr/bin/env node
'use strict';

// Small REAL client-VM preflight. This proves the execution environment only:
// it is not live-origin authentication, Mission Control feature verification,
// native RDP proof, or Web Desktop proof.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const ps = require('../lib/ps');
const { acquireLock, releaseLock } = require('../lib/lock');
const registry = require('../lib/registry');
const { redact } = require('../lib/redact');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function clean(value, max = 300) {
  return redact(String(value === undefined || value === null ? '' : value)).replace(/[\r\n]+/g, ' ').slice(0, max);
}

function check(id, status, actual, expected) {
  return { id, status, expected, actual: clean(actual, 500) };
}

function evaluatePreflight({ vm, browser, origin }) {
  const checks = [];
  const vmOk = vm && !vm.error;
  checks.push(check('vm.interactive_desktop', vmOk && vm.interactiveDesktop && vm.sessionId > 0 ? 'PASS' : 'FAIL',
    vmOk ? `session=${vm.sessionId}; userInteractive=${vm.userInteractive}; account=${vm.account}` : (vm && vm.error) || 'no inventory',
    'Windows interactive session > 0'));
  checks.push(check('vm.runner_responsive', vmOk && vm.responsive && vm.runnerWorkerProcessCount > 0 ? 'PASS' : 'FAIL',
    vmOk ? `responsive=${vm.responsive}; Runner.Worker processes=${vm.runnerWorkerProcessCount}` : 'inventory unavailable',
    'responsive runner process in the current job'));
  checks.push(check('vm.resource_capacity', vmOk && vm.memoryFreeBytes >= 512 * 1024 * 1024 && vm.systemDriveFreeBytes >= 2 * 1024 ** 3 ? 'PASS' : 'FAIL',
    vmOk ? `freeMemoryBytes=${vm.memoryFreeBytes}; systemDriveFreeBytes=${vm.systemDriveFreeBytes}` : 'inventory unavailable',
    '>=512 MiB free RAM and >=2 GiB free system disk'));
  checks.push(check('vm.native_launcher_present', vmOk && vm.nativeLauncher && vm.nativeLauncher.mstscPresent ? 'PASS' : 'FAIL',
    vmOk && vm.nativeLauncher ? `mstsc=${vm.nativeLauncher.mstscPresent}; ghrdpHandlerUser=${vm.nativeLauncher.ghrdpHandlerUser}; ghrdpHandlerMachine=${vm.nativeLauncher.ghrdpHandlerMachine}` : 'inventory unavailable',
    'native mstsc present; handler state is observed, not changed'));
  checks.push(check('vm.tailnet_ready', vmOk && vm.tailscale && vm.tailscale.present && vm.tailscale.selfOnline ? 'PASS' : 'FAIL',
    vmOk && vm.tailscale ? `present=${vm.tailscale.present}; backend=${vm.tailscale.backendState}; selfOnline=${vm.tailscale.selfOnline}; ${vm.tailscale.error || ''}` : 'inventory unavailable',
    'Tailscale installed and this client online'));
  checks.push(check('vm.headed_browser_interaction', browser && browser.ok ? 'PASS' : 'FAIL',
    browser ? `${browser.message}; screenshot=${browser.screenshot || 'none'}` : 'not run',
    'headed Chromium executes a real click and produces a sanitized PNG'));

  const originChecks = [];
  if (!origin || !origin.run) {
    originChecks.push(check('origin.validated_identity', 'BLOCKED', origin && origin.error || 'origin metadata unavailable', 'exact repository/run/attempt/SHA metadata'));
  } else {
    const identityOk = origin.run.repository === origin.expected.repository &&
      String(origin.run.id) === String(origin.expected.run) &&
      Number(origin.run.attempt) === Number(origin.expected.attempt) &&
      String(origin.run.headSha).toLowerCase() === String(origin.expected.sha).toLowerCase() &&
      origin.run.workflowPath === '.github/workflows/main.yml';
    originChecks.push(check('origin.validated_identity', identityOk ? 'PASS' : 'FAIL', JSON.stringify(origin.run), 'exact repository/run/attempt/SHA/workflow identity'));
    originChecks.push(check('origin.rdp_readiness', origin.readinessReached ? 'PASS' : 'BLOCKED', origin.firstFailure || origin.jobStatus || 'rdp job has not reached readiness', 'readiness step completed successfully'));
    originChecks.push(check('origin.signal_publication', origin.signalPublished ? 'PASS' : 'BLOCKED', origin.signalDetail, 'exact run+attempt signal with output.text'));
    originChecks.push(check('origin.network_path', origin.endpoint ? 'NOT_RUN' : 'BLOCKED', origin.endpoint || 'no validated endpoint published; no tailnet target was guessed', 'authenticated endpoint discovered from the exact live signal'));
  }
  const vmVerdict = checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  return { vmVerdict, checks, originChecks };
}

async function apiJson(apiPath, timeoutMs = 10000) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'supreme-lamp-lab-vm-preflight'
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com${apiPath}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* retained as a status-only failure */ }
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${apiPath.split('?')[0]}`);
  if (!body || typeof body !== 'object') throw new Error(`GitHub API returned non-JSON for ${apiPath.split('?')[0]}`);
  return body;
}

async function inspectOrigin({ repository, run, attempt, sha }) {
  const expected = { repository, run: String(run), attempt: Number(attempt), sha: String(sha).toLowerCase() };
  const result = { expected, run: null, jobStatus: 'UNKNOWN', firstFailure: '', readinessReached: false, signalPublished: false, signalDetail: '', endpoint: '' };
  try {
    const [metadata, jobs, checks] = await Promise.all([
      apiJson(`/repos/${repository}/actions/runs/${encodeURIComponent(run)}`),
      apiJson(`/repos/${repository}/actions/runs/${encodeURIComponent(run)}/attempts/${encodeURIComponent(attempt)}/jobs?per_page=100`),
      apiJson(`/repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs?check_name=mission-control-live-signal&per_page=100`)
    ]);
    result.run = {
      repository,
      id: String(metadata.id),
      attempt: Number(metadata.run_attempt),
      headSha: String(metadata.head_sha || '').toLowerCase(),
      workflowPath: metadata.path,
      status: metadata.status,
      conclusion: metadata.conclusion || null,
      updatedAt: metadata.updated_at
    };
    const rdp = (jobs.jobs || []).find(j => j.name === 'rdp');
    if (rdp) {
      result.jobStatus = `${rdp.status}/${rdp.conclusion || 'pending'}`;
      const failed = (rdp.steps || []).find(s => s.conclusion === 'failure');
      if (failed) result.firstFailure = `step ${failed.number}: ${failed.name}`;
      const readiness = (rdp.steps || []).find(s => s.name === 'Service Readiness Check (Pre-Keepalive)');
      result.readinessReached = Boolean(readiness && readiness.status === 'completed' && readiness.conclusion === 'success');
    } else {
      result.firstFailure = 'rdp job not present in this attempt';
    }
    const externalId = `${repository}#${run}.${attempt}`;
    const exact = (checks.check_runs || []).filter(c => c.external_id === externalId && String(c.head_sha).toLowerCase() === expected.sha);
    const live = exact.filter(c => c.status === 'in_progress' && c.output && typeof c.output.text === 'string' && c.output.text.length > 0);
    result.signalPublished = live.length > 0;
    result.signalDetail = live.length ? `exact live signal check id=${live[0].id}; ciphertext not read or copied` :
      (exact.length ? `exact signal check(s) exist but none is live with output.text (count=${exact.length})` : 'SIGNAL_NOT_PUBLISHED for the exact run+attempt+SHA');
    // This preflight deliberately does not decrypt or copy the envelope. The
    // normal discovery path is the only source of an endpoint for live tests.
  } catch (error) {
    result.error = clean(error && error.message || error);
  }
  return result;
}

async function browserProbe(outDir) {
  const started = Date.now();
  let browser;
  let context;
  const screenshot = path.join(outDir, 'client-preflight.png');
  try {
    browser = await chromium.launch({ headless: false, timeout: 30000, args: ['--no-first-run', '--no-default-browser-check'] });
    context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Lab client preflight</title><style>body{font:20px system-ui;background:#f4f7fb;color:#16283c;padding:48px}main{background:white;padding:32px;border-radius:12px}button{font:18px system-ui;padding:12px 20px}#result{margin-top:24px;font-weight:600}</style></head><body><main><h1>RDP Mission Control lab</h1><p>Sanitized synthetic client-VM preflight — not an application test.</p><button id="probe">Exercise browser input</button><div id="result">Waiting</div><script>document.querySelector('#probe').addEventListener('click',()=>{document.querySelector('#result').textContent='PASS: native browser click handled';});</script></main></body></html>`, { waitUntil: 'load', timeout: 15000 });
    await page.click('#probe', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#result').textContent.startsWith('PASS:'), null, { timeout: 5000 });
    const visible = await page.textContent('#result');
    await page.screenshot({ path: screenshot, timeout: 15000 });
    const png = fs.readFileSync(screenshot);
    if (png.length < 5000 || png.subarray(1, 4).toString() !== 'PNG') throw new Error('sanitized screenshot is missing or too small');
    return { ok: true, message: `${visible}; headed=true; browser=chromium`, screenshot: path.basename(screenshot), durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, message: clean(error && error.message || error), screenshot: fs.existsSync(screenshot) ? path.basename(screenshot) : '', durationMs: Date.now() - started };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const out = path.resolve(arg('out', path.join(os.tmpdir(), 'slab-vm-preflight')));
  fs.mkdirSync(out, { recursive: true });
  const started = Date.now();
  const report = {
    schema: 'slab-client-preflight/1',
    generatedAt: new Date().toISOString(),
    scope: 'CLIENT_VM_PREFLIGHT_ONLY; not live application or RDP/Web Desktop acceptance',
    lab: {
      repository: process.env.GITHUB_REPOSITORY || '',
      runId: process.env.GITHUB_RUN_ID || 'local',
      attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
      revision: arg('lab-revision', process.env.LAB_REVISION || process.env.GITHUB_SHA || ''),
      runner: process.env.RUNNER_NAME || '',
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT || ''
    },
    timings: {}
  };
  let lock;
  let registered = false;
  try {
    const lockStarted = Date.now();
    lock = acquireLock({
      lockDir: registry.sessionLockDir(),
      runId: report.lab.runId,
      runAttempt: report.lab.attempt,
      role: 'client-vm-preflight',
      timeoutMs: 120000
    });
    report.timings.desktopLockMs = Date.now() - lockStarted;
    try { registry.registerProcess({ pid: process.pid, role: 'client-vm-preflight' }); registered = true; } catch (error) { report.registryWarning = clean(error.message); }

    if (process.platform !== 'win32') throw new Error('WINDOWS_CLIENT_REQUIRED');
    const tInventory = Date.now();
    const inventory = await ps.runPowerShell({
      script: path.join(__dirname, '..', 'ps', 'Get-ClientPreflight.ps1'),
      timeoutMs: 30000,
      operation: 'client-vm-inventory',
      site: 'candidate/vm-preflight.js'
    });
    report.timings.inventoryMs = Date.now() - tInventory;
    if (!inventory.ok) throw new Error(`CLIENT_VM_INVENTORY_FAILED: ${ps.describe(inventory)}`);
    try { report.vm = JSON.parse(inventory.stdout.trim()); } catch (error) { throw new Error(`CLIENT_VM_INVENTORY_JSON: ${clean(error.message)}`); }

    const tOrigin = Date.now();
    report.origin = await inspectOrigin({
      repository: arg('origin-repo', 'dictationb1/supreme-lamp'),
      run: arg('origin-run', '40051974454'),
      attempt: Number(arg('origin-attempt', '1')),
      sha: arg('app-sha', '4a91c5c2eadc12e5b071bc46bae7683087f56fbd')
    });
    report.timings.originApiMs = Date.now() - tOrigin;
    report.browser = await browserProbe(out);
    const evaluated = evaluatePreflight(report);
    Object.assign(report, evaluated);
    report.timings.totalMs = Date.now() - started;
  } catch (error) {
    report.fatal = clean(error && error.message || error, 800);
    report.vmVerdict = 'FAIL';
    report.timings.totalMs = Date.now() - started;
  } finally {
    if (registered) { try { registry.unregisterProcess({ pid: process.pid }); } catch { /* postflight retains the record */ } }
    if (lock) { try { releaseLock(lock); } catch (error) { report.lockReleaseWarning = clean(error.message); } }
    fs.writeFileSync(path.join(out, 'client-preflight.json'), JSON.stringify(report, null, 2));
  }
  console.log(`[client-preflight] VM=${report.vmVerdict} report=${path.join(out, 'client-preflight.json')}`);
  for (const c of report.checks || []) console.log(`[client-preflight] ${c.status} ${c.id}: ${c.actual}`);
  for (const c of report.originChecks || []) console.log(`[client-preflight] ${c.status} ${c.id}: ${c.actual}`);
  if (report.fatal) console.error(`[client-preflight] ${report.fatal}`);
  process.exitCode = report.vmVerdict === 'PASS' ? 0 : 2;
}

if (require.main === module) main().catch(error => { console.error(clean(error && error.stack || error)); process.exit(1); });
module.exports = { evaluatePreflight, inspectOrigin };
