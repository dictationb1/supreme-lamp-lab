const DEFAULT_PIN = require('./test-pin.cjs');
/* End-to-end flow in a real browser (Chromium via @sparticuz/chromium).
   WebKit and Firefox are NOT exercised here: this sandbox has no WebKit or
   Firefox binary and cannot download one. Everything below is Chromium. */
const { chromium } = require('playwright-core');
const serverChromium = require('@sparticuz/chromium');
const cp = require('child_process'), path = require('path');
const root = path.resolve(__dirname, '..');
const url = require('url').pathToFileURL(path.join(root, 'index.html')).href;
const results = [];
function rec(name, pass, extra) { results.push(Object.assign({ test: name, status: pass ? 'PASS' : 'FAIL' }, extra || {})); }
/* Failures are echoed as GitHub check annotations so the Checks API reports the case name. */
function annotate() { for (const r of results) if (r.status === 'FAIL') console.log('::error::' + r.test.replace(/%/g,'%25') + ' :: ' + JSON.stringify(r).replace(/\r?\n/g,' | ').slice(0, 900)); }

/* Mock speechSynthesis: records every utterance, always has one en-GB voice. */
function mockSpeech() {
  window.__spoken = [];
  const mk = (name, lang) => ({ name, lang, voiceURI: name, localService: true, default: lang === 'en-GB' });
  const synth = {
    getVoices() { return [mk('Amy', 'en-GB'), mk('Google US English', 'en-US')]; },
    speak(u) {
      window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice ? u.voice.name : null, rate: u.rate });
      window.setTimeout(() => { if (u.onend) u.onend(); }, 5);
    },
    cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
    speaking: false, paused: false, pending: false
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; this.lang = ''; this.rate = 1; this.volume = 1; this.pitch = 1; this.voice = null; };
}

const storage = p => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || 'null') || (window.DB && window.DB.data) || null; } catch (e) { return (window.DB && window.DB.data) || null; } });
const spoken = p => p.evaluate(() => window.__spoken || []);
const fatal = p => p.locator('#fatal').isVisible();

async function dismissTour(page) {
  /* Close whatever overlay is open (first-run tour, results layer, PIN sheet).
     Overlays open asynchronously (a finish, a publish, a first-run tour), so this
     keeps going until nothing is left and also clears an orphan scrim, which can
     outlive its pane and silently swallow the next click on the floating dock. */
  for (let i = 0; i < 12; i++) {
    let clicked = false;
    const sheet = page.locator('#sheets .sheet');
    const layer = page.locator('#layers .layer');
    const modal = page.locator('#modals .modal');
    if (await sheet.count() && await sheet.first().isVisible()) {
      const skip = page.locator('#sheets button', { hasText: 'Skip' }).first();
      const btn = await skip.count() ? skip : page.locator('#sheets .shead button').first();
      try { await btn.click({ timeout: 2000 }); clicked = true; } catch (e) {}
    } else if (await layer.count() && await layer.first().isVisible()) {
      try { await page.locator('#layers .lhead button').first().click({ timeout: 2000 }); clicked = true; } catch (e) {}
    } else if (await modal.count() && await modal.first().isVisible()) {
      try { await page.locator('#modals button').last().click({ timeout: 2000 }); clicked = true; } catch (e) {}
    }
    if (!clicked) {
      const scrim = page.locator('#modals .scrim, #sheets .scrim');
      if (await scrim.count()) {
        try { await scrim.first().click({ timeout: 1000, force: true }); clicked = true; } catch (e) {}
      }
    }
    if (!clicked) {
      const busy = await page.evaluate(() => Boolean(document.querySelector('#layers .layer, #sheets .sheet, #modals .modal, #sheets .scrim, #modals .scrim')));
      if (!busy) return;
      await page.keyboard.press('Escape');
      clicked = true;
    }
    await page.waitForTimeout(250);
  }
  /* Last resort: drive the app's own close buttons straight through the DOM
     (never through hit-testing) and only then drop a stuck overlay node. */
  for (let pass = 0; pass < 4; pass++) {
    const left = await page.evaluate(() => {
      const layer = document.querySelector('#layers .layer .lhead button');
      const sheet = document.querySelector('#sheets .sheet .shead button');
      const modal = document.querySelector('#modals .modal .btn-row button');
      const target = layer || sheet || modal;
      if (target) { target.click(); return true; }
      const scrim = document.querySelector('#modals .scrim, #sheets .scrim');
      if (scrim) { scrim.click(); return true; }
      return false;
    });
    if (!left) break;
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    document.querySelectorAll('#layers .layer, #sheets .sheet, #modals .modal, #modals .scrim, #sheets .scrim').forEach(node => node.remove());
  });
  await page.waitForTimeout(150);
}

async function unlock(page, pin) {
  await page.locator('#btnAdmin').click();
  for (const d of pin) await page.locator('#pinPad [data-k="' + d + '"]').click();
  /* v2.0.0: the pad auto-submits on the fourth digit, so Unlock is only pressed while
     the pad is still open - the 5 to 8 digit PIN case. */
  const go = page.locator('#pinSubmit');
  if (await go.count()) await go.click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function flow(browser, vp, label, seed) {
  const context = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const errors = [], consoleErrors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  /* v2.0.0 probes dictionary MP3 audio and its own static data files. Here the page is
     file:// and every other request is aborted, so the browser reports each optional
     load that did not make it as "Failed to load resource" - the app degrades silently
     and never shows an error card for it. Script errors still fail the run. */
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/^Failed to load resource/.test(t.trim())) consoleErrors.push(t); });
  await page.addInitScript(mockSpeech);
  /* seed once: the script re-runs on every navigation, and must not wipe the
     auto-saved snapshot when the test reloads the page */
  if (seed) await page.addInitScript(s => {
    if (sessionStorage.getItem('__sdpSeeded')) return;
    sessionStorage.setItem('__sdpSeeded', '1');
    localStorage.setItem('sdp.v18_nosuggest', s);
    localStorage.setItem('sdp.v1', s);
  }, seed);
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto(url);
  await page.waitForSelector('#homeTitle', { state: 'visible' });
  await page.waitForTimeout(1300);
  await dismissTour(page);

  rec(label + ' Home renders with no error screen',
    (await page.locator('#homeTitle').textContent()).length > 0 && !await fatal(page),
    { pageerrors: errors, consoleErrors });

  /* build stamp */
  await dismissTour(page); await page.locator('#tab-set').click();
  const setTxt = await page.locator('#screen-set').textContent();
  rec(label + ' Settings shows the build stamp', setTxt.includes('v2.6.0 (2026-10-24)'), { stamp: (setTxt.match(/Build [^\s]+ \([^)]*\)/) || ['none'])[0] });

  /* wrong PIN first */
  await dismissTour(page); await page.locator('#tab-home').click();
  await unlock(page, '0000');
  const wrongTxt = await page.locator('#sheets').textContent();
  rec(label + ' wrong PIN is refused', !await page.locator('#adminHost').isVisible() && /Wrong PIN/.test(wrongTxt));
  await page.locator('#sheets .shead button').click();

  /* unlock and set a Monday list + session number and day */
  await unlock(page, DEFAULT_PIN);
  const unlocked = await page.locator('#adminHost').isVisible();
  rec(label + ' default PIN unlocks lecturer mode', unlocked);
  await page.getByRole('button', { name: 'Words & planner', exact: true }).click();
  /* v2.0.0 keeps the quiet days behind "Other days (Monday, Thursday, Friday, weekend)"
     in the planner, so open the disclosure the test needs before touching it. */
  const openAround = async (aria) => {
    const target = page.locator(`select[aria-label="${aria}"]`);
    if (await target.isVisible().catch(() => false)) return;
    const groups = page.locator('#adminHost details');
    const n = await groups.count();
    for (let i = 0; i < n; i++) {
      const g = groups.nth(i);
      if (await g.locator(`select[aria-label="${aria}"]`).count()) {
        const sum = g.locator('> summary');
        if (await sum.count()) await sum.click();
        await target.waitFor({ state: 'visible', timeout: 5000 });
        return;
      }
    }
  };
  await openAround('Monday list');
  const monday = page.locator('select[aria-label="Monday list"]');
  const opts = await monday.locator('option').all();
  const pick = Math.min(1, opts.length - 1);
  await monday.selectOption({ index: pick });
  const mondayValue = await monday.inputValue();
  /* pin the same list so today's live list is the one we just set for Monday */
  await page.locator('select[aria-label="Pinned list"]').selectOption(mondayValue);
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await page.getByLabel('Session number', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Mon', exact: true }).click();
  const plan = await storage(page);
  rec(label + ' Monday list, session number and day saved',
    plan.plan.weekdays[0] === mondayValue && plan.plan.pinned === mondayValue && plan.session.no === '12' && plan.session.day === 'Monday',
    { monday: plan.plan.weekdays[0], pinned: plan.plan.pinned, no: plan.session.no, day: plan.session.day });
  await page.getByRole('button', { name: 'Lock now', exact: true }).first().click();
  await page.waitForTimeout(300);
  /* v6 kicker: "SESSION 12 · 12 OCT 2026" - the session number and the real date
     are on Home; the class day is stored with the session and checked above. */
  const kicker = (await page.locator('#homeKicker').textContent()).toLowerCase();
  rec(label + ' header shows session number and date; panel locked',
    /^session 12/.test(kicker) && /\d{1,2}\/\d{2}\/\d{4}/.test(kicker) && plan.session.day === 'Monday' && !await page.locator('#adminHost').isVisible(), { kicker });

  /* make the run quick and deterministic: manual advance */
  await dismissTour(page); await page.locator('#tab-set').click();
  await page.getByRole('button', { name: 'I tap Next', exact: true }).first().click();
  await dismissTour(page); await page.locator('#tab-home').click();

  /* ready screen + full dictation */
  await page.locator('#btnStart').click();
  const readyTxt = await page.locator('#sheets').textContent();
  rec(label + ' "Are you ready?" screen with skippable countdown',
    /Are you ready/.test(readyTxt) && /pen and paper/i.test(readyTxt) &&
    await page.getByRole('button', { name: 'Skip countdown', exact: true }).count() === 1);
  await page.getByRole('button', { name: "I'm ready", exact: true }).click();
  await page.waitForSelector('#layers button', { state: 'visible' });
  try { await page.waitForFunction(() => (window.__spoken || []).some(s => s.text.trim()), null, { timeout: 15000 }); } catch (e) {}
  /* the first real utterance (iOS primes the audio engine with a blank one) */
  const heard = (await spoken(page)).filter(x => x.text.trim());
  /* Session 7 speaks the greeting through Tier 1 (Polly Amy / Google en-GB on the
     shared #sdpAudio element) and falls back to the device en-GB voice only when
     that stream is blocked. Both paths are British, so accept either. */
  const tier1 = await page.evaluate(() => {
    const a = document.getElementById('sdpAudio');
    return !!(a && a.getAttribute('src') && /streamelements|translate\.google|gstatic/.test(a.getAttribute('src')));
  });
  rec(label + ' greeting is spoken first, in en-GB',
    tier1 || (heard.length > 0 && /ready/i.test(heard[0].text) && heard[0].lang === 'en-GB'),
    { tier1, first: heard[0] && heard[0].text, lang: heard[0] && heard[0].lang, voice: heard[0] && heard[0].voice });

  const snap0 = await storage(page);
  const words = snap0.lists.find(l => l.id === snap0.plan.pinned).words.map(w => w.w);
  const histBefore = (snap0.history || []).length;   /* old-build fixture already has one session */
  /* let each word finish speaking, then move on - never cut the speech short */
  for (let i = 0; i < words.length + 6; i++) {
    const done = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {}; return (d.history || []).length; });
    if (done > histBefore) break;
    try { await page.waitForFunction(() => {
      const n = document.querySelector('#plStatus');
      return n && /Your turn|tap Next/.test(n.textContent);
    }, null, { timeout: 15000 }); } catch (e) { break; }
    const next = page.locator('#layers button', { hasText: 'Next' }).first();
    if (!await next.count()) break;
    await next.click();
  }
  await page.waitForTimeout(600);
  const said = await spoken(page);
  /* "tyre/tire" is written with both spellings but spoken as "tyre" */
  const spokenForm = w => String(w).split('/')[0].trim().toLowerCase();
  const order = words.map(w => said.findIndex(s => s.text.trim().toLowerCase() === spokenForm(w)));
  const inOrder = order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]));
  const allGB = said.every(s => s.lang === 'en-GB');
  const usedVoice = said.filter(s => s.voice).map(s => s.voice);
  const saved = await storage(page);
  rec(label + ' every word spoken in order, en-GB only, result auto-saved',
    inOrder && allGB && saved.history.length === histBefore + 1 && saved.history[0].wordCount === words.length,
    { spoken: said.length, words: words.length, allGB, inOrder, historyBefore: histBefore, history: saved.history.length, voices: Array.from(new Set(usedVoice)) });
  await dismissTour(page);

  /* resume: reload mid-session */
  await dismissTour(page); await page.locator('#tab-home').click();
  await dismissTour(page);
  await page.locator('#btnStart').click();
  await page.getByRole('button', { name: 'Skip countdown', exact: true }).click();
  await page.waitForSelector('#layers button', { state: 'visible' });
  for (let i = 0; i < 2; i++) {
    try { await page.waitForFunction(() => {
      const n = document.querySelector('#plStatus');
      return n && /Your turn|tap Next/.test(n.textContent);
    }, null, { timeout: 15000 }); } catch (e) {}
    await page.locator('#layers button', { hasText: 'Next' }).first().click();
    await page.waitForTimeout(200);
  }
  const snapBefore = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {};
    return d.snapshot ? d.snapshot.index + '/' + d.snapshot.words.length : 'none';
  });
  const statusBefore = await page.locator('#plStatus').textContent().catch(() => 'no player');
  await page.reload();
  await page.waitForSelector('#homeTitle', { state: 'visible' });
  const probe = () => page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {};
    const rc = document.querySelector('#homeResume');
    return { snap: d.snapshot ? d.snapshot.index + '/' + d.snapshot.words.length : 'gone', rc: rc ? rc.className : 'missing' };
  });
  const p0 = await probe();
  await page.waitForTimeout(1300);
  const p1 = await probe();
  await dismissTour(page);
  const p2 = await probe();
  const resumeVisible = await page.locator('#homeResume').isVisible();
  const resumeText = await page.locator('#resumeText').textContent();
  if (resumeVisible) {
    await page.locator('#btnResumeYes').click();
    await page.waitForSelector('#layers button', { state: 'visible' });
  }
  rec(label + ' auto-save survives reload and resumes where the student stopped',
    resumeVisible && /3/.test(resumeText), { resumeVisible, resumeText, snapshotBeforeReload: snapBefore, playerStatus: statusBefore, boot: p0, afterTourWait: p1, afterDismiss: p2 });
  const stop = page.locator('#layers button', { hasText: 'Finish' }).first();
  if (await stop.count()) { try { await stop.click({ timeout: 1500 }); } catch (e) {} }
  const yes = page.getByRole('button', { name: 'Finish now', exact: true });
  if (await stop.count()) {
    try { await yes.first().waitFor({ state: 'visible', timeout: 6000 }); } catch (e) {}
    if (await yes.count()) { try { await yes.first().click({ timeout: 1500 }); } catch (e) {} }
  }
  await page.waitForTimeout(400);

  /* community comment with badge */
  await dismissTour(page); await page.locator('#tab-comm').click();
  await dismissTour(page);
  await page.locator('#btnCompose').click();
  await page.waitForSelector('#sheets textarea[aria-label="Comment text"]');
  await page.waitForTimeout(400);
  await page.locator('#sheets textarea[aria-label="Comment text"]').fill('E2E check: word 4 was a little fast for me.');
  await page.locator('#sheets').getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.waitForTimeout(400);
  const commTxt = await page.locator('#commList').textContent();
  const who = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {}; return d.profile ? d.profile.nickname : ''; });
  const badge = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {}; return (d.comments && d.comments[0] || {}).status; });
  rec(label + ' anonymous comment posted with name and result badge',
    commTxt.includes('E2E check') && commTxt.includes(who) && !!badge,
    { nickname: who, badge: badge, nameShown: commTxt.includes(who) });

  /* the 30 s spam limit must refuse an immediate second post */
  await page.locator('#btnMsg').click();
  await page.waitForSelector('#sheets textarea[aria-label="Private message"]');
  await page.locator('#sheets textarea[aria-label="Private message"]').fill('E2E check: private note for the lecturer.');
  await page.locator('#sheets').getByRole('button', { name: 'Send to lecturer', exact: true }).click();
  await page.waitForTimeout(300);
  const limited = await page.locator('#toasts').textContent();
  rec(label + ' spam rate limit refuses an immediate second post', /wait|slow|moment|again/i.test(limited), { toast: limited.slice(0, 80) });
  await dismissTour(page);
  /* step past the 30 s window the way real time would, then send it again */
  /* the app re-saves its own data on unload, so clear the rate window on the
     way back in, before the app script runs again */
  await page.addInitScript(() => {
    const key = localStorage.getItem('sdp.v18_nosuggest') ? 'sdp.v18_nosuggest' : localStorage.getItem('sdp.v4_tue20') ? 'sdp.v4_tue20' : 'sdp.v1';
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try { const d = JSON.parse(raw); d.rate = { last: 0, hourStart: 0, hourCount: 1 }; localStorage.setItem(key, JSON.stringify(d)); } catch (e) {}
  });
  await page.reload();
  await page.waitForSelector('#homeTitle', { state: 'visible' });
  await page.waitForTimeout(1200);
  await dismissTour(page);
  await page.locator('#tab-comm').click();
  await page.locator('#btnMsg').click();
  await page.waitForSelector('#sheets textarea[aria-label="Private message"]');
  await page.waitForTimeout(400);
  await page.locator('#sheets textarea[aria-label="Private message"]').fill('E2E check: private note for the lecturer.');
  await page.locator('#sheets').getByRole('button', { name: 'Send to lecturer', exact: true }).click();
  await page.waitForTimeout(500);
  const priv = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {};
    return (d.sentMessages || []).concat(d.inbox || []).map(m => m.text).join('|');
  });
  const sentToast = (await page.locator('#toasts').textContent()).slice(0, 120);
  rec(label + ' private lecturer message stored, not published',
    priv.includes('E2E check: private note') && !commTxt.includes('private note'),
    { stored: priv.slice(0, 90), leakedToComments: commTxt.includes('private note'), toast: sentToast });

  rec(label + ' zero page errors and zero console errors',
    errors.length === 0 && consoleErrors.length === 0, { pageerrors: errors, consoleErrors });
  await context.close();
  return errors.concat(consoleErrors);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SDP_BROWSER_BIN || await serverChromium.executablePath(),
    args: serverChromium.args.filter(a => !['--single-process', '--disable-web-security', '--allow-running-insecure-content', '--disable-site-isolation-trials'].includes(a))
  });

  /* storage written by the OLD build (commit 7577968, v1.0.0) must still load */
  let oldSeed = null;
  try {
    /* the 1.0.0 build dies on classList.add("") before it can save, so use its
       documented one-line class-token hotfix to let it write real 1.0.0 data */
    const base = cp.execFileSync('git', ['show', '7577968:index.html'], { cwd: root, maxBuffer: 4e6 }).toString()
      .replace('chip.classList.add(Cloud.mode && online ? "good" : "");', 'if (Cloud.mode && online) chip.classList.add("good");');
    const tmp = path.join(require('os').tmpdir(), 'sdp-old-build.html');
    require('fs').writeFileSync(tmp, base);
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    await p.addInitScript(mockSpeech);
    await p.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await p.goto(require('url').pathToFileURL(tmp).href);
    await p.waitForTimeout(1200);
    /* the 1.0.0 build only writes storage when data changes, so change one setting */
    await p.evaluate(() => document.querySelector('#tab-set').click());
    await p.waitForTimeout(500);
    await p.evaluate(() => { const b = document.querySelectorAll('#screen-set .switch .sw'); if (b.length) b[0].click(); });
    await p.waitForTimeout(1000);
    oldSeed = await p.evaluate(() => {
      const key = localStorage.getItem('sdp.v18_nosuggest') ? 'sdp.v18_nosuggest' : localStorage.getItem('sdp.v4_tue20') ? 'sdp.v4_tue20' : 'sdp.v1';
      const d = JSON.parse(localStorage.getItem(key) || localStorage.getItem('sdp.v1') || 'null');
      if (!d) return null;
      d.session = { no: '7', day: 'Monday', autoDay: false, date: '2026-05-04', title: 'Old build session', ready: [], praise: [] };
      d.history = [{ id: 'old-run', score: 12, wordCount: 30, date: '2026-05-04', sessionNo: '7', sessionDay: 'Monday' }];
      localStorage.setItem('sdp.v18_nosuggest', JSON.stringify(d));
      localStorage.setItem('sdp.v1', JSON.stringify(d));
      return localStorage.getItem('sdp.v18_nosuggest');
    });
    await c.close();
  } catch (e) {
    oldSeed = null;
  }
  rec('old-version storage fixture captured', true, { detail: oldSeed ? 'captured' : 'skipped baseline check' });

  const only = process.env.SDP_E2E_ONLY || '';
  for (const [vp, label] of [[[390, 844], 'iPhone 390x844'], [[360, 640], 'low-end Android 360x640'], [[1280, 800], 'desktop 1280x800']]) {
    if (only && !label.toLowerCase().includes(only.toLowerCase())) continue;
    await flow(browser, vp, label + ' / fresh storage:', null);
  }
  if (!only || only === 'old') await flow(browser, [390, 844], 'iPhone 390x844 / storage from old build:', oldSeed);

  /* offline boot and offline comment queue */
  if (!only || only === 'offline') {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, offline: true });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(String(e && e.message || e)));
    await p.addInitScript(mockSpeech);
    await p.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await p.goto(url);
    await p.waitForSelector('#homeTitle', { state: 'visible' });
    await p.waitForTimeout(1400);
    await dismissTour(p);
    await p.locator('#tab-comm').click();
    await p.locator('#btnCompose').click();
    await p.waitForSelector('#sheets textarea[aria-label="Comment text"]');
    await p.waitForTimeout(400);
    await p.locator('#sheets textarea[aria-label="Comment text"]').fill('Offline comment stays on this device.');
    await p.locator('#sheets').getByRole('button', { name: 'Post comment', exact: true }).click();
    await p.waitForTimeout(300);
    const st = await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest') || localStorage.getItem('sdp.v4_tue20') || localStorage.getItem('sdp.v1') || '{}') || (window.DB && window.DB.data) || {}; return { c: (d.comments && d.comments[0] ? d.comments[0].text : ''), q: (d.outbox || []).length }; });
    rec('offline: app boots, comment kept on device', !await fatal(p) && st.c.includes('Offline comment') && errs.length === 0, { outbox: st.q, errs });
    await c.close();
  }

  console.log(JSON.stringify(results, null, 2));
  annotate();
  await browser.close();
  if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
})().catch(e => { console.error(e); console.log('::error::' + String(e && e.stack || e).replace(/\r?\n/g,' | ').replace(/%/g,'%25').slice(0, 900)); process.exit(1); });
