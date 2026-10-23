'use strict';
// CANDIDATE UI SWEEP — real browser, real Windows desktop, real built bundle.
//
// Runs on the lab's self-hosted Windows client (headed Chromium) against the
// CANDIDATE build served by scripts/candidate/stub-server.js. For every control
// it records: precondition, action, expected visible effect, expected request,
// actual result, evidence file, and a verdict. Anything whose prerequisite is a
// real RDP session / real backend is reported BLOCKED with that prerequisite
// named - never PASS, never "skipped".
//
// Output (into --out):
//   candidate-report.json        machine verdicts + provenance
//   control-coverage.csv         one row per control
//   shots/<id>-<mode>.png        screenshot per executed control

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const base = arg('base', 'http://127.0.0.1:7331');
const out = arg('out', path.resolve('candidate-out'));
const buildSha = arg('sha', 'candidate');
const bundlePath = arg('bundle', '');
const modes = (arg('modes', 'refuse,empty,healthy')).split(',');

const ROUTES = [
  { id: 'nav.overview', hash: '#/', marker: 'overview-connect-panel' },
  { id: 'nav.search', hash: '#/search', marker: null },
  { id: 'nav.sessions', hash: '#/sessions', marker: null },
  { id: 'nav.connections', hash: '#/connections', marker: null },
  { id: 'nav.keys', hash: '#/keys', marker: null },
  { id: 'nav.files', hash: '#/files', marker: null },
  { id: 'nav.mirror', hash: '#/mirror', marker: null },
  { id: 'nav.telemetry', hash: '#/telemetry', marker: null },
  { id: 'nav.health', hash: '#/health', marker: null },
  { id: 'nav.collector', hash: '#/collector', marker: null },
  { id: 'nav.settings', hash: '#/settings', marker: null }
];

const rows = [];
const findings = [];
const shotsDir = path.join(out, 'shots');

function record(r) {
  rows.push({
    mode: r.mode || '',
    control_id: r.control,
    area: r.area,
    preconditions: r.pre || 'lab candidate build served on 127.0.0.1 with the stub backend in this mode',
    action: r.action,
    expected_ui: r.expectUi,
    expected_request: r.expectReq || '',
    actual: String(r.actual === undefined ? '' : r.actual).replace(/\s+/g, ' ').slice(0, 400),
    evidence: r.evidence || '',
    verdict: r.verdict,
    note: r.note || ''
  });
}

async function shot(page, name) {
  const f = path.join(shotsDir, name + '.png');
  try { await page.screenshot({ path: f, fullPage: false }); return 'shots/' + name + '.png'; } catch { return ''; }
}

async function text(page, testid) {
  const el = await page.$(`[data-testid="${testid}"]`);
  if (!el) return null;
  return (await el.innerText().catch(() => '')) || '';
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  // The interactive VM runs headed (a human can watch); a hosted runner has no
  // desktop, so it runs the SAME sweep headless. Which one is recorded, because
  // "headed on the real desktop" and "headless in CI" are different evidence.
  const headless = process.env.CANDIDATE_HEADLESS === '1';
  const browser = await chromium.launch({ headless, args: ['--no-first-run', '--no-default-browser-check'] });
  const consoleErrors = [];
  const failedRequests = [];

  for (const mode of modes) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ mode, text: m.text().slice(0, 300) }); });
    page.on('requestfailed', r => failedRequests.push({ mode, url: r.url().replace(/key=[^&]+/, 'key=***'), why: (r.failure() && r.failure().errorText) || '' }));

    await page.goto(base + '/v2', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The polling hooks run on a 15 s config / 15 s status cadence; the first
    // answer is immediate, so wait for the shell rather than a fixed sleep.
    await page.waitForSelector('[data-testid="app-topbar"]', { timeout: 30000 });
    await page.waitForTimeout(1200);

    // ---- C-01/C-02/C-03: overview launch gate in this backend state --------
    const note = await text(page, 'overview-auto-login-note');
    const btn = await page.$('[data-testid="overview-auto-login"]');
    const disabled = btn ? await btn.isDisabled() : null;
    const chip = await text(page, 'topbar-status-summary');
    const shotName = `overview-${mode}`;
    const evidence = await shot(page, shotName);

    if (mode === 'refuse') {
      const honest = /refused this page|no valid run key|HTTP 401/i.test(note || '');
      const accusatory = /FQDN\/user pair failed validation|tailnet IP did not resolve|LISTENER probe is not all green/i.test(note || '');
      record({
        mode, control: 'overview.auto_login_gate', area: 'overview',
        action: 'Load the dashboard while /api/config and /api/native-status answer 401, read the gate note and the button state.',
        expectUi: 'the note names the refused status read; it does NOT claim credentials/DNS/listener were measured; the button stays disabled',
        expectReq: 'GET /api/config -> 401, GET /api/native-status -> 401',
        actual: `note="${note}" disabled=${disabled} chip="${chip}"`,
        evidence,
        verdict: honest && !accusatory && disabled === true ? 'PASS' : 'FAIL',
        note: honest ? '' : 'the gate did not name the refusal'
      });
      record({
        mode, control: 'topbar.status_semantics', area: 'overview',
        action: 'Read the glanceable status chip while both status probes are refused.',
        expectUi: 'NOT "Live": the chip reports unavailable data',
        actual: `chip="${chip}"`,
        evidence,
        verdict: chip && !/^Live$/i.test(chip.trim()) ? 'PASS' : 'FAIL',
        note: 'Live must describe connectivity, never stand in for backend data'
      });
    }

    if (mode === 'empty') {
      const accusatory = /FQDN\/user pair failed validation/i.test(note || '');
      record({
        mode, control: 'overview.auto_login_gate', area: 'overview',
        action: 'Load the dashboard while both status routes answer 200 with an EMPTY object.',
        expectUi: 'the gate names the real missing credential fields (a measurement, because the read succeeded)',
        expectReq: 'GET /api/native-status -> 200 {}',
        actual: `note="${note}" disabled=${disabled}`,
        evidence,
        verdict: accusatory && disabled === true ? 'PASS' : 'FAIL'
      });
    }

    if (mode === 'healthy') {
      record({
        mode, control: 'overview.auto_login_gate', area: 'overview',
        action: 'Load the dashboard with a complete, green listener snapshot.',
        expectUi: 'WINDOWS AUTO-LOGIN is ENABLED (the gate is not permanently closed)',
        expectReq: 'GET /api/native-status -> 200 {fqdn, user, rdpListener all green}',
        actual: `disabled=${disabled} note="${note}" chip="${chip}"`,
        evidence,
        verdict: disabled === false ? 'PASS' : 'FAIL',
        note: disabled === false ? '' : 'all gates green yet the action stayed disabled'
      });
    }

    // ---- C-04: every route renders (this mode only once, in healthy) ------
    if (mode === 'healthy') {
      for (const r of ROUTES) {
        let ok = false, detail = '';
        try {
          await page.goto(base + '/v2' + r.hash, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(700);
          const shell = await page.$('[data-testid="app-topbar"]');
          const body = (await page.evaluate(() => document.body.innerText || '')).slice(0, 200);
          ok = !!shell && body.length > 0;
          detail = body.replace(/\s+/g, ' ').slice(0, 120);
        } catch (e) {
          detail = 'error: ' + String(e.message || e).slice(0, 120);
        }
        const evidence2 = await shot(page, r.id.replace(/\./g, '-') + '-healthy');
        record({
          mode, control: r.id, area: 'navigation',
          action: `Navigate to ${r.hash} in the built bundle.`,
          expectUi: 'the app shell stays mounted and the page renders its own content',
          actual: detail,
          evidence: evidence2,
          verdict: ok ? 'PASS' : 'FAIL'
        });
      }

      // ---- C-05: theme toggle changes the document -------------------------
      await page.goto(base + '/v2#/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      const themeBtn = await page.$('[data-testid="topbar-theme-toggle"], [data-testid="settings-theme-toggle"]');
      let after = before, clicked = false;
      if (themeBtn) { await themeBtn.click({ timeout: 5000 }).catch(() => {}); clicked = true; await page.waitForTimeout(400); after = await page.evaluate(() => document.documentElement.getAttribute('data-theme')); }
      record({
        mode, control: 'settings.theme_toggle', area: 'settings',
        action: 'Click the theme control.',
        expectUi: 'the document theme attribute changes',
        actual: `before=${before} after=${after} clicked=${clicked}`,
        evidence: await shot(page, 'theme-toggle-healthy'),
        verdict: clicked && after !== before ? 'PASS' : (clicked ? 'FAIL' : 'BLOCKED'),
        note: clicked ? '' : 'no theme control exposed a test id'
      });

      // ---- C-06: language toggle reaches Sinhala ---------------------------
      const lang = await page.$('[data-testid="topbar-lang-toggle"]');
      let langOk = false, langDetail = '';
      if (lang) {
        await lang.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        const body2 = await page.evaluate(() => document.body.innerText || '');
        langOk = /[\u0D80-\u0DFF]/.test(body2);
        langDetail = body2.replace(/\s+/g, ' ').slice(0, 100);
      }
      record({
        mode, control: 'settings.language_toggle', area: 'settings',
        action: 'Click the language control.',
        expectUi: 'Sinhala script appears in the UI',
        actual: langOk ? 'Sinhala text rendered' : langDetail,
        evidence: await shot(page, 'language-toggle-healthy'),
        verdict: lang ? (langOk ? 'PASS' : 'FAIL') : 'BLOCKED'
      });

      // ---- C-07: text scale control ---------------------------------------
      const scale = await page.$('[data-testid="topbar-text-scale-toggle"]');
      let scaleOk = false, scaleDetail = '';
      if (scale) {
        const fs0 = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
        await scale.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
        const fs1 = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
        scaleOk = fs0 !== fs1;
        scaleDetail = `${fs0} -> ${fs1}`;
      }
      record({
        mode, control: 'global.text_scale', area: 'global',
        action: 'Click the text-scale control.',
        expectUi: 'the root font size changes',
        actual: scaleDetail || 'control not found',
        evidence: await shot(page, 'text-scale-healthy'),
        verdict: scale ? (scaleOk ? 'PASS' : 'FAIL') : 'BLOCKED'
      });

      // ---- C-08: search rejects an empty query visibly ---------------------
      await page.goto(base + '/v2#/search', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const searchInput = await page.$('input[type="search"], input[data-testid*="search"]');
      let searchDetail = 'no search input found';
      let searchVerdict = 'BLOCKED';
      if (searchInput) {
        await searchInput.fill('lab-candidate-nonexistent-fixture');
        await searchInput.press('Enter').catch(() => {});
        await page.waitForTimeout(1500);
        const body3 = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ');
        searchDetail = body3.slice(0, 200);
        // The stub answers 404 for /api/search routes: the page must show a
        // failure/empty state, and must NOT claim a successful search.
        searchVerdict = /error|failed|unavailable|no result|empty|not found|unable/i.test(body3) ? 'PASS' : 'FAIL';
      }
      record({
        mode, control: 'search.query_with_backend_absent', area: 'search',
        action: 'Submit a known-absent query while the stub has no search backend.',
        expectUi: 'a visible failure/empty state, never a fabricated result list',
        expectReq: 'search request -> 404 from the stub',
        actual: searchDetail,
        evidence: await shot(page, 'search-absent-healthy'),
        verdict: searchVerdict
      });

      // ---- C-09..C-12: controls that REQUIRE a real backend/RDP -----------
      const blocked = [
        ['sessions.list', 'sessions', 'Session rows come from /api/sessions on the real backend'],
        ['connections.connect', 'connections', 'A native RDP connect needs the production ghrdp:// handler plus a real server'],
        ['keys.reveal', 'keys', 'Revealing a credential needs the real credential store (the stub holds masked fields only)'],
        ['files.browse', 'files', 'File Explorer drives the runner filesystem through the real backend'],
        ['mirror.start', 'mirror', 'Mirror operations need the real backend and external credentials'],
        ['telemetry.samples', 'telemetry', 'Real samples need the real /api/progress producer'],
        ['health.service_checks', 'health', 'Health rows need the real service checks'],
        ['collector.run', 'collector', 'Collector needs POST /api/collector/run on the real backend'],
        ['rdp.native_logon', 'rdp', 'Native logon needs a real target host, NLA and a type-10 4624 to correlate']
      ];
      for (const [id, area, why] of blocked) {
        record({
          mode, control: id, area,
          action: 'not attempted in the candidate run',
          expectUi: 'n/a for this harness',
          actual: 'BLOCKED: ' + why,
          verdict: 'BLOCKED',
          note: 'the candidate stub has no ' + area + ' backend; this is a prerequisite, not a result'
        });
      }
    }

    await ctx.close();
  }

  await browser.close();

  const bundle = bundlePath && fs.existsSync(bundlePath)
    ? { path: path.basename(bundlePath), bytes: fs.statSync(bundlePath).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex') }
    : null;

  const counts = rows.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const report = {
    schema: 'slab-candidate-report/1',
    generatedAt: new Date().toISOString(),
    candidate: { buildSha, bundle },
    backend: 'lab-candidate-stub (synthetic; NOT the application server)',
    modes,
    host: process.env.COMPUTERNAME || '',
    execution: {
      headless,
      runner: process.env.RUNNER_NAME || '',
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT || '',
      session: process.env.SESSIONNAME || ''
    },
    counts,
    consoleErrors: consoleErrors.slice(0, 50),
    failedRequests: failedRequests.slice(0, 50),
    controls: rows
  };
  fs.writeFileSync(path.join(out, 'candidate-report.json'), JSON.stringify(report, null, 2));

  const header = ['mode', 'control_id', 'area', 'preconditions', 'action', 'expected_ui', 'expected_request', 'actual', 'evidence', 'verdict', 'note'];
  const csv = [header.join(',')].concat(rows.map(r => header.map(h => '"' + String(r[h] === undefined ? '' : r[h]).replace(/"/g, '""') + '"').join(','))).join('\n');
  fs.writeFileSync(path.join(out, 'control-coverage.csv'), csv + '\n');

  console.log('[sweep] ' + JSON.stringify(counts));
  if ((counts.FAIL || 0) > 0) process.exitCode = 2;
}

main().catch(e => { console.error('[sweep] fatal: ' + (e && e.stack || e)); process.exit(1); });
