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

function sanitizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/([?&](?:key|token|dash-token|dash_token|dashtoken|access-token|access_token|password)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***');
}

const base = arg('base', 'http://127.0.0.1:7331');
const out = arg('out', path.resolve('candidate-out'));
const buildSha = arg('sha', 'candidate');
const bundlePath = arg('bundle', '');
const sourceInventoryPath = arg('source-inventory', '');
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
const coveredDomKeys = new Set();
const domByKey = new Map();
const shotsDir = path.join(out, 'shots');
const CONTROL_DOM_KEYS = {
  'auth.token_gate_visible': ['testid:dash-token-actions'],
  'auth.token_forget': ['testid:dash-token-forget'],
  'auth.token_empty_validation': ['testid:dash-token-input', 'testid:dash-token-save'],
  'auth.token_short_validation': ['testid:dash-token-input', 'testid:dash-token-save'],
  'auth.token_cancel': ['testid:dash-token-cancel'],
  'auth.token_save': ['testid:dash-token-enter', 'testid:dash-token-input', 'testid:dash-token-save'],
  'overview.auto_login_gate': ['testid:overview-auto-login'],
  'settings.theme_toggle': ['testid:topbar-theme-toggle'],
  'settings.language_toggle': ['testid:topbar-lang-toggle'],
  'global.text_scale': ['testid:topbar-text-scale-toggle'],
  'search.query_with_backend_absent': ['testid:search-query']
};
for (const route of ['overview', 'search', 'sessions', 'connections', 'keys', 'files', 'mirror', 'telemetry', 'health', 'collector', 'settings']) {
  CONTROL_DOM_KEYS[`nav.${route}`] = [`href:#/${route === 'overview' ? '' : route}`];
}
CONTROL_DOM_KEYS['nav.search'].push('id:f56.search.nav');
CONTROL_DOM_KEYS['nav.files'].push('id:f57.explorer.nav');
CONTROL_DOM_KEYS['nav.health'].push('id:f92.health.nav');
CONTROL_DOM_KEYS['nav.collector'].push('id:f99.collector.nav');

function record(r) {
  const domKeys = [...new Set([...(CONTROL_DOM_KEYS[r.control] || []), ...(r.domKeys || [])])];
  for (const key of domKeys) coveredDomKeys.add(key);
  rows.push({
    mode: r.mode || '',
    control_id: r.control,
    dom_keys: domKeys.join(' '),
    area: r.area,
    preconditions: r.pre || 'lab candidate build served on 127.0.0.1 with the stub backend in this mode',
    action: r.action,
    expected_ui: r.expectUi,
    expected_request: r.expectReq || '',
    actual: sanitizeText(String(r.actual === undefined ? '' : r.actual)).replace(/\s+/g, ' ').slice(0, 400),
    evidence: r.evidence || '',
    verdict: r.verdict,
    note: r.note || ''
  });
}

async function behavior(spec) {
  let actual = '', ok = false;
  try {
    const result = await spec.run();
    ok = result && result.ok === true;
    actual = result && result.actual !== undefined ? String(result.actual) : '';
  } catch (e) {
    actual = 'ACTION_ERROR: ' + String(e && e.message || e).split('\n')[0];
  }
  record({
    mode: spec.mode, control: spec.control, area: spec.area,
    action: spec.action, expectUi: spec.expectUi, expectReq: spec.expectReq || '',
    actual, evidence: spec.evidence || '', verdict: ok ? 'PASS' : 'FAIL',
    note: ok ? '' : 'The control was attempted; this is a behavioural failure, not an unexecuted prerequisite.', domKeys: spec.domKeys || []
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

async function inventoryDom(page, route, mode, evidence) {
  const found = await page.locator('button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="slider"], [draggable="true"]').evaluateAll((els, route) => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const safeHref = raw => {
      try {
        const u = new URL(raw, location.href);
        for (const k of [...u.searchParams.keys()]) if (/key|token|secret|pass|auth/i.test(k)) u.searchParams.set(k, '***');
        return u.hash && (u.origin === location.origin) ? u.hash : u.href;
      } catch { return clean(raw); }
    };
    return els.map((el, index) => {
      const testid = el.getAttribute('data-testid') || '';
      const id = el.id || '';
      const href = el.getAttribute('href') || '';
      const aria = el.getAttribute('aria-label') || '';
      const tag = el.tagName.toLowerCase();
      const text = clean(el.innerText || el.value || '');
      const key = testid ? `testid:${testid}` : id ? `id:${id}` : href ? `href:${safeHref(href)}` : `dom:${route}:${tag}:${aria || text || index}`;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        key, route, stableKind: testid ? 'data-testid' : id ? 'id' : href ? 'href' : 'none',
        testid: testid || null, id: id || null, tag,
        type: el.getAttribute('type'), role: el.getAttribute('role'),
        ariaLabel: aria || null, text, href: href ? safeHref(href) : null,
        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        behaviouralStatus: 'NOT_RUN'
      };
    });
  }, route);
  for (const control of found) {
    const prior = domByKey.get(control.key);
    if (prior) {
      if (!prior.routes.includes(route)) prior.routes.push(route);
      prior.visible = prior.visible || control.visible;
      if (!prior.evidence && evidence) prior.evidence = evidence;
    } else {
      domByKey.set(control.key, { ...control, routes: [route], evidence: evidence || '' });
      delete domByKey.get(control.key).route;
    }
  }
}

async function unlockWithSyntheticToken(page, mode) {
  const gate = page.getByTestId('dash-token-gate');
  const visible = await gate.isVisible().catch(() => false);
  if (mode === 'healthy') {
    const gateEvidence = await shot(page, 'token-gate-healthy');
    await inventoryDom(page, 'token-gate', mode, gateEvidence);
    const actions = page.getByTestId('dash-token-actions');
    const href = visible ? await actions.getAttribute('href') : null;
    const target = visible ? await actions.getAttribute('target') : null;
    record({
      mode, control: 'auth.token_gate_visible', area: 'authentication',
      action: 'Open a fresh browser context without a dashboard key.',
      expectUi: 'the modal gate blocks the UI and the Actions escape link is a new-tab GitHub Actions URL',
      actual: `visible=${visible} actionsHref=${href ? 'github-actions' : 'missing'} target=${target}`,
      evidence: gateEvidence,
      verdict: visible && /github\.com\/.+\/actions/.test(href || '') && target === '_blank' ? 'PASS' : 'FAIL'
    });
  }
  if (!visible) {
    if (mode === 'healthy') throw new Error('expected the synthetic token gate before control interactions');
    return;
  }

  if (mode === 'healthy') {
    await page.getByTestId('dash-token-forget').click();
    const forgetOpened = await page.getByTestId('dash-token-input').isVisible();
    const formEvidence = await shot(page, 'token-form-healthy');
    await inventoryDom(page, 'token-entry', mode, formEvidence);
    record({
      mode, control: 'auth.token_forget', area: 'authentication',
      action: 'Choose “Forget a previously saved key” in a fresh context.',
      expectUi: 'the saved-key store is cleared and the manual-entry form opens',
      actual: `inputVisible=${forgetOpened}`,
      evidence: formEvidence,
      verdict: forgetOpened ? 'PASS' : 'FAIL'
    });
    await page.getByTestId('dash-token-cancel').click();
    await page.getByTestId('dash-token-enter').click();
    await page.getByTestId('dash-token-save').click();
    const emptyError = (await text(page, 'dash-token-error')) || '';
    record({
      mode, control: 'auth.token_empty_validation', area: 'authentication',
      action: 'Submit the manual token form with an empty value.',
      expectUi: 'a visible validation error; the gate remains locked',
      actual: emptyError ? 'visible validation error' : 'no validation error',
      verdict: emptyError.length > 0 && await gate.isVisible() ? 'PASS' : 'FAIL'
    });
    await page.getByTestId('dash-token-input').fill('short');
    await page.getByTestId('dash-token-save').click();
    const shortError = (await text(page, 'dash-token-error')) || '';
    record({
      mode, control: 'auth.token_short_validation', area: 'authentication',
      action: 'Submit a synthetic value shorter than eight characters.',
      expectUi: 'a visible length validation error; the gate remains locked',
      actual: shortError ? 'visible length validation error' : 'no validation error',
      verdict: shortError.length > 0 && await gate.isVisible() ? 'PASS' : 'FAIL'
    });
    await page.getByTestId('dash-token-cancel').click();
    const cancelled = !(await page.getByTestId('dash-token-input').isVisible().catch(() => false)) && await gate.isVisible();
    record({
      mode, control: 'auth.token_cancel', area: 'authentication',
      action: 'Cancel manual token entry.',
      expectUi: 'the form closes without unlocking the dashboard',
      actual: `formHiddenAndGateVisible=${cancelled}`,
      verdict: cancelled ? 'PASS' : 'FAIL'
    });
  }

  await page.getByTestId('dash-token-enter').click();
  await page.getByTestId('dash-token-input').fill('lab-synthetic-key-000');
  await page.getByTestId('dash-token-save').click();
  await gate.waitFor({ state: 'hidden', timeout: 5000 });
  if (mode === 'healthy') {
    const stored = await page.evaluate(() => Boolean(window.localStorage.getItem('ghrdp.dashToken')));
    record({
      mode, control: 'auth.token_save', area: 'authentication',
      action: 'Enter and save a synthetic lab-only dashboard key.',
      expectUi: 'the key round-trips through local storage and the modal unlocks; the key value is not evidence',
      actual: `gateHidden=${!(await gate.isVisible())} storagePresent=${stored}`,
      verdict: !(await gate.isVisible()) && stored ? 'PASS' : 'FAIL'
    });
  }
}

async function exerciseChromeAndSettings(page, mode) {
  await behavior({
    mode, control: 'topbar.status_disclosure', area: 'global', domKeys: ['testid:topbar-status-summary'],
    action: 'Click the status summary twice.', expectUi: 'aria-expanded and the detailed chip panel toggle open then closed',
    run: async () => {
      const button = page.getByTestId('topbar-status-summary');
      await button.click();
      const opened = await button.getAttribute('aria-expanded') === 'true' && await page.getByTestId('topbar-chips').isVisible();
      await button.click();
      const closed = await button.getAttribute('aria-expanded') === 'false' && !(await page.getByTestId('topbar-chips').isVisible());
      return { ok: opened && closed, actual: `opened=${opened} closed=${closed}` };
    }
  });
  await behavior({
    mode, control: 'sidebar.collapse', area: 'global', domKeys: ['testid:sidebar-collapse'],
    action: 'Click the desktop sidebar collapse control twice.', expectUi: 'aria-pressed and the sidebar width state toggle then restore',
    run: async () => {
      const button = page.getByTestId('sidebar-collapse');
      const before = await button.getAttribute('aria-pressed');
      await button.click();
      const changed = await button.getAttribute('aria-pressed');
      const widthChanged = await page.getByTestId('sidebar').evaluate((el, collapsed) => collapsed === 'true' ? el.className.includes('w-16') : el.className.includes('w-60'), changed);
      await button.click();
      const restored = await button.getAttribute('aria-pressed');
      return { ok: before !== changed && changed !== restored && before === restored && widthChanged, actual: `${before} -> ${changed} -> ${restored}; widthChanged=${widthChanged}` };
    }
  });

  await page.goto(base + '/v2#/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="page-settings"]', { timeout: 15000 });
  const evidence = await shot(page, 'settings-controls-healthy');
  for (const theme of ['dark', 'light']) {
    await behavior({
      mode, control: `settings.theme_${theme}`, area: 'settings', evidence, domKeys: [`testid:settings-theme-${theme}`],
      action: `Click the ${theme} theme button.`, expectUi: `html[data-theme]=${theme} and the button's selected variant is rendered`,
      run: async () => {
        const button = page.getByTestId(`settings-theme-${theme}`);
        await button.click();
        const actualTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        return { ok: actualTheme === theme, actual: `theme=${actualTheme}` };
      }
    });
  }
  for (const scale of ['comfort', 'large', 'a11y']) {
    await behavior({
      mode, control: `settings.text_scale_${scale}`, area: 'settings', evidence, domKeys: [`testid:settings-text-scale-${scale}`],
      action: `Click the ${scale} text-scale button.`, expectUi: `html[data-scale]=${scale} and a real root font-size change`,
      run: async () => {
        const before = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
        const button = page.getByTestId(`settings-text-scale-${scale}`);
        await button.click();
        const state = await page.evaluate(() => ({ scale: document.documentElement.getAttribute('data-scale'), font: getComputedStyle(document.documentElement).fontSize }));
        return { ok: state.scale === scale && state.font !== before, actual: `${before} -> ${state.font}; scale=${state.scale}` };
      }
    });
  }
  await behavior({
    mode, control: 'settings.language_switch', area: 'settings', evidence, domKeys: ['testid:settings-language-toggle'],
    action: 'Click the Settings language switch twice.', expectUi: 'html[lang] and aria-checked change then restore',
    run: async () => {
      const button = page.getByTestId('settings-language-toggle');
      const before = await page.evaluate(() => document.documentElement.lang);
      await button.click();
      const changed = await page.evaluate(() => document.documentElement.lang);
      const checked = await button.getAttribute('aria-checked');
      await button.click();
      const restored = await page.evaluate(() => document.documentElement.lang);
      return { ok: before !== changed && before === restored && ((changed === 'si') === (checked === 'true')), actual: `${before} -> ${changed} -> ${restored}; aria-checked=${checked}` };
    }
  });
  for (const quality of ['opaque', 'frosted', 'clear', 'auto']) {
    await behavior({
      mode, control: `settings.glass_quality_${quality}`, area: 'settings', evidence, domKeys: [`testid:glass-quality-${quality}`],
      action: `Click glass quality ${quality}.`, expectUi: `the requested quality and aria-pressed state become ${quality}`,
      run: async () => {
        const button = page.getByTestId(`glass-quality-${quality}`);
        await button.click();
        const actualQuality = await page.evaluate(() => document.documentElement.getAttribute('data-glass-quality'));
        const pressed = await button.getAttribute('aria-pressed');
        return { ok: actualQuality === quality && pressed === 'true', actual: `quality=${actualQuality} aria-pressed=${pressed}` };
      }
    });
  }
  for (const variant of ['clear', 'tinted']) {
    await behavior({
      mode, control: `settings.glass_variant_${variant}`, area: 'settings', evidence, domKeys: [`testid:glass-variant-${variant}`],
      action: `Click glass variant ${variant}.`, expectUi: `html[data-glass-variant]=${variant} and aria-pressed=true`,
      run: async () => {
        const button = page.getByTestId(`glass-variant-${variant}`);
        await button.click();
        const actualVariant = await page.evaluate(() => document.documentElement.getAttribute('data-glass-variant'));
        const pressed = await button.getAttribute('aria-pressed');
        return { ok: actualVariant === variant && pressed === 'true', actual: `variant=${actualVariant} aria-pressed=${pressed}` };
      }
    });
  }
  await behavior({
    mode, control: 'settings.glass_clarity', area: 'settings', evidence, domKeys: ['testid:glass-clarity'],
    action: 'Focus the clarity slider and press End then Home.', expectUi: 'the output and html[data-glass-clarity] snap to 1 then 0',
    run: async () => {
      const slider = page.getByTestId('glass-clarity');
      await slider.focus(); await slider.press('End');
      const max = await page.evaluate(() => ({ root: document.documentElement.getAttribute('data-glass-clarity'), output: document.querySelector('[data-testid="glass-clarity-value"]')?.getAttribute('data-clarity') }));
      await slider.press('Home');
      const min = await page.evaluate(() => ({ root: document.documentElement.getAttribute('data-glass-clarity'), output: document.querySelector('[data-testid="glass-clarity-value"]')?.getAttribute('data-clarity') }));
      return { ok: max.root === '1' && max.output === '1' && min.root === '0' && min.output === '0', actual: `End=${JSON.stringify(max)} Home=${JSON.stringify(min)}` };
    }
  });
  await behavior({
    mode, control: 'settings.about_recheck', area: 'settings', evidence, domKeys: ['testid:about-recheck'],
    action: 'Click the build/backend recheck button.', expectUi: 'GET /api/f92-selftest answers 200 with version:match=pass and a fresh match verdict is rendered', expectReq: 'GET /api/f92-selftest?frontendSha=… -> 200',
    run: async () => {
      const waiting = page.waitForResponse(r => new URL(r.url()).pathname === '/api/f92-selftest', { timeout: 7000 });
      await page.getByTestId('about-recheck').click();
      const response = await waiting;
      const body = await response.json();
      await page.waitForFunction(() => document.querySelector('[data-testid="about-backend-match"]')?.textContent?.trim() === 'match', null, { timeout: 7000 });
      const verdict = (await text(page, 'about-backend-match')) || '';
      const check = body?.checks?.['version:match'];
      const row = Array.isArray(check) ? check[0] : check;
      return { ok: response.status() === 200 && row?.status === 'pass' && verdict === 'match', actual: `HTTP ${response.status()}; version:match=${row?.status}; verdict=${verdict}` };
    }
  });
  await behavior({
    mode, control: 'settings.trash_empty_disabled_when_empty', area: 'settings', evidence, domKeys: ['testid:settings-trash-empty'],
    action: 'Inspect the empty-trash action in a fresh context.', expectUi: 'the action is disabled with a zero count; no destructive request occurs',
    run: async () => {
      const disabled = await page.getByTestId('settings-trash-empty').isDisabled();
      const count = (await text(page, 'settings-trash-count')) || '';
      return { ok: disabled && /0/.test(count), actual: `disabled=${disabled} count=${count}` };
    }
  });
  await behavior({
    mode, control: 'settings.live_patch_arm', area: 'settings', evidence, domKeys: ['testid:settings-live-patch-arm-toggle'],
    action: 'Toggle the live-patch arm switch on then off.', expectUi: 'aria-checked and the disarmed/inert explanation change then restore; no patch is applied',
    run: async () => {
      const button = page.getByTestId('settings-live-patch-arm-toggle');
      const before = await button.getAttribute('aria-checked');
      await button.click();
      const changed = await button.getAttribute('aria-checked');
      const inertWhenArmed = await page.getByTestId('settings-live-patch-inert').count();
      await button.click();
      const restored = await button.getAttribute('aria-checked');
      const inertWhenDisarmed = await page.getByTestId('settings-live-patch-inert').count();
      return { ok: before === 'false' && changed === 'true' && restored === 'false' && inertWhenArmed === 0 && inertWhenDisarmed === 1, actual: `${before} -> ${changed} -> ${restored}; inertNodes=${inertWhenArmed}/${inertWhenDisarmed}` };
    }
  });
  await behavior({
    mode, control: 'settings.live_patch_rollback_empty', area: 'settings', evidence, domKeys: ['testid:settings-live-patch-rollback'],
    action: 'Inspect rollback before any patch arrives.', expectUi: 'rollback is disabled and explicitly says there is nothing to roll back',
    run: async () => {
      const button = page.getByTestId('settings-live-patch-rollback');
      const disabled = await button.isDisabled();
      const label = (await button.innerText()) || '';
      return { ok: disabled && /nothing to roll back/i.test(label), actual: `disabled=${disabled} label=${label}` };
    }
  });
  await behavior({
    mode, control: 'settings.debug_hud_enable', area: 'settings', evidence, domKeys: ['testid:settings-debug-hud-toggle'],
    action: 'Enable Debug HUD and press Shift+F12.', expectUi: 'the enabled flag persists and the real HUD overlay opens',
    run: async () => {
      const button = page.getByTestId('settings-debug-hud-toggle');
      await button.click();
      const stored = await page.evaluate(() => localStorage.getItem('f109:enabled'));
      await page.keyboard.press('Shift+F12');
      const visible = await page.getByTestId('debug-hud').isVisible();
      return { ok: stored === 'true' && visible && await button.getAttribute('aria-checked') === 'true', actual: `stored=${stored} visible=${visible}` };
    }
  });
  const hudEvidence = await shot(page, 'debug-hud-open-healthy');
  await inventoryDom(page, 'debug-hud', mode, hudEvidence);
  await behavior({
    mode, control: 'debug_hud.close', area: 'developer', evidence: hudEvidence, domKeys: ['testid:debug-hud-close'],
    action: 'Click the HUD close button.', expectUi: 'the HUD overlay is removed from the visible UI',
    run: async () => {
      await page.getByTestId('debug-hud-close').click();
      const visible = await page.getByTestId('debug-hud').isVisible().catch(() => false);
      return { ok: !visible, actual: `visibleAfterClose=${visible}` };
    }
  });
  // Restore the default-off developer state after proving the toggle. This is
  // still a real click, and failure is surfaced by the following assertion.
  await behavior({
    mode, control: 'settings.debug_hud_disable', area: 'settings', evidence, domKeys: ['testid:settings-debug-hud-toggle'],
    action: 'Disable Debug HUD after the overlay test.', expectUi: 'aria-checked=false and the f109 flag is removed',
    run: async () => {
      const button = page.getByTestId('settings-debug-hud-toggle');
      await button.click();
      const stored = await page.evaluate(() => localStorage.getItem('f109:enabled'));
      const checked = await button.getAttribute('aria-checked');
      return { ok: stored === null && checked === 'false', actual: `stored=${stored} aria-checked=${checked}` };
    }
  });
  await inventoryDom(page, 'settings-after-actions', mode, evidence);
}

async function exerciseMobile(page, mode) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/v2#/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="app-topbar"]', { timeout: 15000 });
  const evidence = await shot(page, 'mobile-overview-healthy');
  await inventoryDom(page, 'mobile-overview', mode, evidence);
  for (const opener of ['topbar-mobile-menu', 'mobile-nav-more']) {
    await behavior({
      mode, control: `mobile.drawer_${opener}`, area: 'mobile', evidence, domKeys: [`testid:${opener}`, 'testid:sidebar-close'],
      action: `Open the mobile drawer with ${opener}, then close it.`, expectUi: 'the sidebar and its explicit close control become visible, then the drawer closes',
      run: async () => {
        await page.getByTestId(opener).click();
        const opened = await page.getByTestId('sidebar').isVisible() && await page.getByTestId('sidebar-close').isVisible();
        const drawerEvidence = await shot(page, `mobile-drawer-${opener}-healthy`);
        await inventoryDom(page, `mobile-drawer-${opener}`, mode, drawerEvidence);
        await page.getByTestId('sidebar-close').click();
        const closed = !(await page.getByTestId('sidebar').isVisible());
        return { ok: opened && closed, actual: `opened=${opened} closed=${closed}` };
      }
    });
  }
  const links = [
    ['mobile-nav-f56.search.nav', '#/search'],
    ['mobile-nav-f57.explorer.nav', '#/files'],
    ['mobile-nav-mirror', '#/mirror'],
    ['mobile-nav-home', '#/']
  ];
  for (const [id, hash] of links) {
    await behavior({
      mode, control: `mobile.navigation.${id}`, area: 'mobile', evidence, domKeys: [`testid:${id}`],
      action: `Tap ${id}.`, expectUi: `the HashRouter location becomes ${hash}`,
      run: async () => {
        await page.getByTestId(id).click();
        await page.waitForTimeout(150);
        const actual = await page.evaluate(() => location.hash);
        return { ok: actual === hash, actual: `hash=${actual}` };
      }
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ mode, text: sanitizeText(m.text()).slice(0, 300) }); });
    page.on('requestfailed', r => failedRequests.push({ mode, url: sanitizeText(r.url()), why: sanitizeText((r.failure() && r.failure().errorText) || '') }));

    await page.goto(base + '/v2', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The polling hooks run on a 15 s config / 15 s status cadence; the first
    // answer is immediate, so wait for the shell rather than a fixed sleep.
    await page.waitForSelector('[data-testid="app-topbar"]', { timeout: 30000 });
    // A runner-served dashboard deliberately blocks every other control until a
    // key is present. Exercise that gate, then unlock with a synthetic value so
    // later clicks cannot be intercepted and misreported as application no-ops.
    await unlockWithSyntheticToken(page, mode);
    await page.waitForTimeout(1200);

    // ---- C-01/C-02/C-03: overview launch gate in this backend state --------
    const note = await text(page, 'overview-auto-login-note');
    const btn = await page.$('[data-testid="overview-auto-login"]');
    const disabled = btn ? await btn.isDisabled() : null;
    const chip = await text(page, 'topbar-status-summary');
    const shotName = `overview-${mode}`;
    const evidence = await shot(page, shotName);
    await inventoryDom(page, 'overview', mode, evidence);

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
        await inventoryDom(page, r.hash.replace(/^#\//, '') || 'overview', mode, evidence2);
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
      let after = before, clicked = false, themeClickError = '';
      if (themeBtn) {
        try { await themeBtn.click({ timeout: 5000 }); clicked = true; } catch (e) { themeClickError = String(e.message || e).split('\n')[0]; }
        await page.waitForTimeout(400);
        after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      }
      record({
        mode, control: 'settings.theme_toggle', area: 'settings',
        action: 'Click the theme control after the token gate is unlocked.',
        expectUi: 'the document theme attribute changes',
        actual: `before=${before} after=${after} clicked=${clicked} clickError=${themeClickError}`,
        evidence: await shot(page, 'theme-toggle-healthy'),
        verdict: clicked && after !== before ? 'PASS' : (themeBtn ? 'FAIL' : 'BLOCKED'),
        note: themeClickError || (themeBtn ? '' : 'no theme control exposed a test id')
      });

      // ---- C-06: language toggle reaches Sinhala ---------------------------
      const lang = await page.$('[data-testid="topbar-lang-toggle"]');
      let langOk = false, langDetail = '', langClickError = '';
      if (lang) {
        try { await lang.click({ timeout: 5000 }); } catch (e) { langClickError = String(e.message || e).split('\n')[0]; }
        await page.waitForTimeout(500);
        const body2 = await page.evaluate(() => document.body.innerText || '');
        langOk = /[\u0D80-\u0DFF]/.test(body2);
        langDetail = (langClickError || body2.replace(/\s+/g, ' ').slice(0, 100));
      }
      record({
        mode, control: 'settings.language_toggle', area: 'settings',
        action: 'Click the language control after the token gate is unlocked.',
        expectUi: 'Sinhala script appears in the UI',
        actual: langOk ? 'Sinhala text rendered' : langDetail,
        evidence: await shot(page, 'language-toggle-healthy'),
        verdict: lang ? (langOk ? 'PASS' : 'FAIL') : 'BLOCKED',
        note: langClickError
      });

      // ---- C-07: text scale control ---------------------------------------
      const scale = await page.$('[data-testid="topbar-text-scale-toggle"]');
      let scaleOk = false, scaleDetail = '', scaleClickError = '';
      if (scale) {
        const beforeState = await page.evaluate(() => ({ font: getComputedStyle(document.documentElement).fontSize, scale: document.documentElement.getAttribute('data-scale') }));
        try { await scale.click({ timeout: 5000 }); } catch (e) { scaleClickError = String(e.message || e).split('\n')[0]; }
        await page.waitForTimeout(400);
        const afterState = await page.evaluate(() => ({ font: getComputedStyle(document.documentElement).fontSize, scale: document.documentElement.getAttribute('data-scale') }));
        scaleOk = !scaleClickError && beforeState.font !== afterState.font && beforeState.scale !== afterState.scale;
        scaleDetail = `${beforeState.scale}/${beforeState.font} -> ${afterState.scale}/${afterState.font}; clickError=${scaleClickError}`;
      }
      record({
        mode, control: 'global.text_scale', area: 'global',
        action: 'Click the text-scale control after the token gate is unlocked.',
        expectUi: 'both html[data-scale] and the root font size change',
        actual: scaleDetail || 'control not found',
        evidence: await shot(page, 'text-scale-healthy'),
        verdict: scale ? (scaleOk ? 'PASS' : 'FAIL') : 'BLOCKED',
        note: scaleClickError
      });

      // ---- real chrome/settings behaviours, then search -------------------
      await exerciseChromeAndSettings(page, mode);
      await exerciseMobile(page, mode);

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
        const phase = await page.getByTestId('page-search-phase').getAttribute('data-phase');
        const errorVisible = await page.getByTestId('results-error').isVisible().catch(() => false);
        const emptyVisible = await page.getByTestId('results-empty').isVisible().catch(() => false);
        searchDetail = `phase=${phase} resultsError=${errorVisible} resultsEmpty=${emptyVisible}`;
        // Language-independent state + request evidence. Earlier wording-only
        // matching broke after the legitimate Sinhala toggle test.
        searchVerdict = phase === 'failed' && errorVisible ? 'PASS' : 'FAIL';
      }
      const searchEvidence = await shot(page, 'search-absent-healthy');
      await inventoryDom(page, 'search-results', mode, searchEvidence);
      record({
        mode, control: 'search.query_with_backend_absent', area: 'search',
        action: 'Submit a known-absent query while the stub has no search backend.',
        expectUi: 'a visible failure/empty state, never a fabricated result list',
        expectReq: 'search request -> 404 from the stub',
        actual: searchDetail,
        evidence: searchEvidence,
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

  // Reconcile, never hide, controls discovered outside the hand-written happy
  // path. These BLOCKED rows are intentionally noisy: a small list of routes
  // must not be presented as full feature/control acceptance.
  const domControls = [...domByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const control of domControls) {
    if (coveredDomKeys.has(control.key)) {
      control.behaviouralStatus = 'COVERED_BY_REPORT_ROW';
      continue;
    }
    control.behaviouralStatus = control.visible ? 'BLOCKED_NOT_EXECUTED' : 'NOT_VISIBLE_NOT_EXECUTED';
    if (!control.visible) continue;
    record({
      mode: modes.join('+'), control: `dom.uncovered.${control.key}`, area: 'dom-inventory',
      action: 'not behaviourally executed by this sweep',
      expectUi: 'a control-specific visible assertion and, where applicable, a backend effect',
      actual: `BLOCKED: DOM_DISCOVERED_NOT_EXECUTED tag=${control.tag} routes=${control.routes.join(',')} disabled=${control.disabled} stableKind=${control.stableKind}`,
      evidence: control.evidence || '', verdict: 'BLOCKED',
      note: control.stableKind === 'none' ? 'No stable test ID or href key; add a stable test ID before behavioural acceptance.' : 'Discovered in the real DOM but has no behavioural coverage mapping.'
    });
  }
  const domSummary = {
    discoveredUnique: domControls.length,
    visibleUnique: domControls.filter(c => c.visible).length,
    coveredByReportRow: domControls.filter(c => c.behaviouralStatus === 'COVERED_BY_REPORT_ROW').length,
    blockedNotExecuted: domControls.filter(c => c.behaviouralStatus === 'BLOCKED_NOT_EXECUTED').length,
    withoutStableTestIdOrHref: domControls.filter(c => c.stableKind === 'none').length
  };
  fs.writeFileSync(path.join(out, 'dom-inventory.json'), JSON.stringify({ schema: 'slab-dom-action-inventory/1', summary: domSummary, controls: domControls }, null, 2) + '\n');

  let sourceSummary = null;
  if (sourceInventoryPath && fs.existsSync(sourceInventoryPath)) {
    const source = JSON.parse(fs.readFileSync(sourceInventoryPath, 'utf8'));
    for (const control of source.controls || []) {
      if (coveredDomKeys.has(control.key)) control.behaviouralStatus = 'COVERED_BY_REPORT_ROW';
    }
    const sourceControls = source.controls || [];
    sourceSummary = {
      discovered: sourceControls.length,
      coveredByReportRow: sourceControls.filter(c => c.behaviouralStatus === 'COVERED_BY_REPORT_ROW').length,
      unreconciled: sourceControls.filter(c => c.behaviouralStatus === 'NOT_RUN').length,
      deferredComponentCallbacks: sourceControls.filter(c => c.behaviouralStatus === 'DEFER_TO_RENDERED_DOM').length,
      withoutLiteralStableId: sourceControls.filter(c => !c.stable).length
    };
    fs.writeFileSync(path.join(out, 'source-reconciliation.json'), JSON.stringify({ schema: 'slab-source-action-reconciliation/1', application: source.application, summary: sourceSummary, controls: sourceControls }, null, 2) + '\n');
    if (sourceSummary.unreconciled > 0) {
      record({
        mode: modes.join('+'), control: 'source.controls_reconciliation', area: 'source-inventory',
        action: 'Compare the TypeScript-AST action inventory with behavioural DOM coverage.',
        expectUi: 'every source-discovered action surface is reconciled to a behavioural assertion or a separately named external prerequisite',
        actual: `BLOCKED: SOURCE_CONTROLS_NOT_RECONCILED ${sourceSummary.unreconciled}/${sourceSummary.discovered}; covered=${sourceSummary.coveredByReportRow}; deferredCallbacks=${sourceSummary.deferredComponentCallbacks}; withoutLiteralStableId=${sourceSummary.withoutLiteralStableId}`,
        evidence: 'source-reconciliation.json', verdict: 'BLOCKED',
        note: 'This is an explicit completeness gap, not an application failure and not acceptance.'
      });
    }
  }

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
    domInventory: domSummary,
    sourceInventory: sourceSummary,
    consoleErrors: consoleErrors.slice(0, 50),
    failedRequests: failedRequests.slice(0, 50),
    controls: rows
  };
  fs.writeFileSync(path.join(out, 'candidate-report.json'), JSON.stringify(report, null, 2));

  const header = ['mode', 'control_id', 'dom_keys', 'area', 'preconditions', 'action', 'expected_ui', 'expected_request', 'actual', 'evidence', 'verdict', 'note'];
  const csv = [header.join(',')].concat(rows.map(r => header.map(h => '"' + String(r[h] === undefined ? '' : r[h]).replace(/"/g, '""') + '"').join(','))).join('\n');
  fs.writeFileSync(path.join(out, 'control-coverage.csv'), csv + '\n');

  console.log('[sweep] ' + JSON.stringify(counts));
  if ((counts.FAIL || 0) > 0) process.exitCode = 2;
}

main().catch(e => { console.error('[sweep] fatal: ' + (e && e.stack || e)); process.exit(1); });
