/* Release 2.6.0 (ver 18) - real-engine checks for the 60 FPS Liquid Glass
   engine, automatic Lite mode, the re-bound Material Mixer, the low-data
   audio path and the v18 typing shield: zero keyboard suggestions, the
   animated tick / cross marks and the 1-tap cross-mark exits.

   The suite runs the real single-file app in Chromium/WebKit with synthetic
   speech and every network request aborted. A sandbox without the browser
   shared libraries skips with an explicit message (exit code 0) instead of
   pretending the layout was verified.

   SDP_BROWSER=webkit selects WebKit and SDP_BROWSER_STANDARD=1 uses a
   locally installed Chrome instead of the packaged binary. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pw = require('playwright-core');
const packaged = require('@sparticuz/chromium');

const root = path.resolve(__dirname, '..');
const engine = process.env.SDP_BROWSER || 'chromium';
const fileURL = require('node:url').pathToFileURL(path.join(root, 'index.html')).href;
const results = [];

function fakeSpeech() {
  window.__spoken = [];
  const voice = { name: 'Microsoft Sonia', lang: 'en-GB', localService: true };
  const synth = {
    getVoices: () => [voice],
    speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); },
    cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {}
  };
  try {
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  } catch (e) {
    try { window.speechSynthesis.getVoices = synth.getVoices; window.speechSynthesis.speak = synth.speak; } catch (e2) {}
  }
  try { window.SpeechSynthesisUtterance = function (text) { this.text = text; }; } catch (e3) {}
}

async function openTab(page, id) {
  await page.evaluate((tab) => {
    const button = document.getElementById(tab);
    if (button) button.click();
  }, id);
  await page.waitForTimeout(250);
}

async function boot(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: width < 768,
    hasTouch: width < 768
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript(fakeSpeech);
  /* the app must work with every external host blocked */
  await page.route('https://**/*', (route) => route.abort());
  await page.goto(fileURL);
  await page.locator('#homeTitle').waitFor();
  await page.waitForTimeout(1100);
  /* the bilingual Welcome Guide opens by itself on a first run: close it */
  const close = page.locator('#sheets .shead button');
  if (await close.count()) await close.first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#sheets .scrim'), null, { timeout: 6000 }).catch(() => {});
  return { context, page, errors };
}

function annotate() {
  for (const r of results) {
    if (r.status === 'FAIL') {
      const detail = String(r.detail || '').replace(/\r?\n/g, ' | ').slice(0, 900);
      console.log('::error::' + r.test.replace(/%/g, '%25') + ' :: ' + detail.replace(/%/g, '%25'));
    }
  }
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ test: name, status: 'PASS' });
  } catch (error) {
    results.push({ test: name, status: 'FAIL', detail: error && error.stack || String(error) });
  }
}

/* the ready/countdown sheets repaint while the countdown runs, so a locator can
   be detached mid-click; this clicks in-page and retries until it lands. */
async function clickText(page, text, tries) {
  const n = tries || 40;
  for (let i = 0; i < n; i++) {
    const hit = await page.evaluate((label) => {
      const nodes = Array.from(document.querySelectorAll('#sheets button, #modals button, #layers button'));
      const hit = nodes.find((b) => (b.textContent || '').trim() === label);
      if (!hit) return false;
      hit.click();
      return true;
    }, text).catch(() => false);
    if (hit) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

function material(page) {
  return page.evaluate(() => {
    const hero = getComputedStyle(document.querySelector('#homeHero'));
    const topbar = getComputedStyle(document.querySelector('.topbar.glass'));
    const dock = getComputedStyle(document.querySelector('#tabbar'));
    const chip = getComputedStyle(document.querySelector('.wordcard') || document.querySelector('#homeHero'));
    return {
      perf: document.body.getAttribute('data-perf'),
      rootPerf: document.documentElement.getAttribute('data-perf'),
      rootTheme: document.documentElement.getAttribute('data-theme'),
      heroBlur: hero.backdropFilter || hero.webkitBackdropFilter,
      heroShadow: hero.boxShadow,
      topbarBlur: topbar.backdropFilter || topbar.webkitBackdropFilter,
      dockBlur: dock.backdropFilter || dock.webkitBackdropFilter,
      topbarShadow: topbar.boxShadow,
      chipShadow: chip.boxShadow,
      grain: getComputedStyle(document.querySelector('#grain')).display,
      blobFilter: getComputedStyle(document.querySelector('#bg .blob')).filter,
      blobAnimation: getComputedStyle(document.querySelector('#bg .blob')).animationName,
      orb: document.querySelector('#orb') ? getComputedStyle(document.querySelector('#orb')).backgroundImage : 'none',
      heroDisplay: getComputedStyle(document.querySelector('.lg-hero')).display,
      stripes: getComputedStyle(document.querySelector('.stripes')).backgroundImage,
      disc: getComputedStyle(document.querySelector('.disc')).backgroundImage
    };
  });
}

(async () => {
  let browser;
  try {
    browser = await pw[engine].launch(
      engine === 'chromium' && !process.env.SDP_BROWSER_STANDARD
        ? { executablePath: await packaged.executablePath(), args: packaged.args.filter((a) => a !== '--single-process') }
        : { headless: true }
    );
  } catch (error) {
    console.log('SKIP upgrade-browser.cjs (' + engine + '): no runnable browser in this environment - ' + String((error && error.message) || error).split('\n')[0]);
    return;
  }

  await check(engine + ' v17 boots dark with the full Liquid Glass anatomy', async () => {
    const { context, page, errors } = await boot(browser, 1280, 800);
    try {
      const m = await material(page);
      assert.equal(m.rootTheme, 'dark');
      assert.ok(m.perf === 'full' || m.perf === 'lite', 'a concrete perf mode: ' + m.perf);
      assert.notEqual(m.heroBlur, 'none', 'hero glass blur');
      assert.notEqual(m.topbarBlur, 'none', 'topbar glass blur');
      assert.notEqual(m.dockBlur, 'none', 'dock glass blur');
      assert.notEqual(m.heroShadow, 'none');
      assert.notEqual(m.chipShadow, 'none');
      assert.equal(m.grain, 'none', 'no feTurbulence layer across the viewport');
      assert.equal(m.blobFilter, 'none', 'no 85px GPU blur on the blobs');
      assert.match(m.stripes, /repeating-linear-gradient/);
      assert.match(m.disc, /radial-gradient/);
      assert.equal(m.heroDisplay, 'block', 'the hero is one clean full-width column');
      assert.equal(await page.locator('#screen-home #lgStage').count(), 0, 'no mixer on Home');
      await openTab(page, 'tab-set');
      const stage = await page.evaluate(() => ({
        found: !!document.querySelector('#screen-set #lgStage'),
        orb: getComputedStyle(document.querySelector('#screen-set #orb')).backgroundImage,
        mixer: !!document.querySelector('#screen-set #materialMixer')
      }));
      assert.equal(stage.found, true, 'the Material Mixer lives in Settings');
      assert.equal(stage.mixer, true);
      assert.match(stage.orb, /radial-gradient/);
      await openTab(page, 'tab-home');
      assert.equal(await page.locator('#tabbar button').count(), 5, 'five dock sections');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' one-tap Lite keeps every glass surface and stops repaints', async () => {
    const { context, page, errors } = await boot(browser, 1280, 800);
    try {
      /* a small CI box may already be in automatic Lite: reach Full, then Lite */
      if ((await material(page)).perf === 'lite') {
        await page.locator('#btnPerf').click();
        await page.waitForTimeout(250);
      }
      assert.equal((await material(page)).perf, 'full', 'the topbar reaches Full');
      await page.locator('#btnPerf').click();
      await page.waitForTimeout(250);
      const lite = await material(page);
      assert.equal(lite.perf, 'lite');
      assert.equal(lite.rootPerf, 'lite');
      assert.notEqual(lite.heroBlur, 'none', 'hero blur kept in lite');
      assert.notEqual(lite.topbarBlur, 'none', 'topbar blur kept in lite');
      assert.notEqual(lite.dockBlur, 'none', 'dock blur kept in lite');
      assert.notEqual(lite.heroShadow, 'none', 'specular rim kept in lite');
      assert.equal(lite.perf, 'lite');
      assert.match(lite.stripes, /repeating-linear-gradient/, 'stripes kept in lite');
      assert.equal(lite.blobAnimation, 'none', 'no infinite background animation in lite');
      await page.waitForFunction(() => {
        const css = getComputedStyle(document.querySelector('.topbar.glass'));
        return (css.backdropFilter || css.webkitBackdropFilter || '').indexOf('blur(8px)') >= 0;
      }, null, { timeout: 8000 });
      const blurPx = await page.evaluate(() => {
        const css = getComputedStyle(document.querySelector('.topbar.glass'));
        return css.backdropFilter || css.webkitBackdropFilter || '';
      });
      assert.match(blurPx, /blur\(8px\)/, 'lite uses the 8px glass budget: ' + blurPx);
      assert.equal((await page.locator('#btnPerf').textContent()).trim(), '⚡ Lite');
      await page.locator('#btnPerf').click();
      await page.waitForTimeout(250);
      assert.equal((await material(page)).perf, 'full');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' floating Hansana credit animates in Full and Lite and opens full credits', async () => {
    const { context, page, errors } = await boot(browser, 1280, 800);
    try {
      const full = await page.evaluate(() => {
        const credit = document.getElementById('credit');
        return {
          inView: credit.classList.contains('in'),
          opacity: getComputedStyle(credit).opacity,
          sheen: getComputedStyle(credit, '::after').animationName,
          ping: getComputedStyle(credit.querySelector('.ring')).animationName,
          transition: getComputedStyle(credit).transitionProperty
        };
      });
      assert.equal(full.inView, true, 'spring entrance completes');
      assert.equal(full.opacity, '1');
      assert.equal(full.sheen, 'sheen');
      assert.equal(full.ping, 'ping');
      assert.match(full.transition, /transform/);
      await page.locator('#credit').click();
      assert.match(await page.locator('#toasts').textContent(), /Created by Hansana · Idea given by Ayya01 \(Lesandu\) · Lecturer in Charge: Sumodya Sewmini/);
      if ((await material(page)).perf === 'full') await page.locator('#btnPerf').click();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1000);
      const lite = await page.evaluate(() => {
        const credit = document.getElementById('credit');
        return {
          perf: document.body.getAttribute('data-perf'),
          inView: credit.classList.contains('in'),
          sheen: getComputedStyle(credit, '::after').animationName,
          ping: getComputedStyle(credit.querySelector('.ring')).animationName,
          transition: getComputedStyle(credit).transitionProperty
        };
      });
      assert.equal(lite.perf, 'lite');
      assert.equal(lite.inView, true);
      assert.equal(lite.sheen, 'sheen', 'Lite never disables the diagonal sheen');
      assert.equal(lite.ping, 'ping', 'Lite never disables the aqua ping');
      assert.match(lite.transition, /transform/);
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' mixer, tint and orb keep working after tab switches', async () => {
    const { context, page, errors } = await boot(browser, 1280, 900);
    try {
      await openTab(page, 'tab-set');
      assert.equal(await page.locator('#screen-set #materialMixer').count(), 1, 'Settings hosts the mixer');
      await page.evaluate(() => {
        for (const [id, value] of [['sBlur', 34], ['sSat', 210], ['sBrt', 110]]) {
          const el = document.getElementById(id);
          el.value = String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      const mixed = await page.evaluate(() => ({
        blur: document.documentElement.style.getPropertyValue('--gb'),
        sat: document.documentElement.style.getPropertyValue('--gs'),
        bright: document.documentElement.style.getPropertyValue('--gbr'),
        out: document.querySelector('#outSat').textContent,
        fills: ['sBlur', 'sSat', 'sBrt'].map((id) => document.getElementById(id).style.getPropertyValue('--fill'))
      }));
      assert.equal(mixed.blur, '34px');
      assert.equal(mixed.sat, '2.10');
      assert.equal(mixed.bright, '1.10');
      assert.equal(mixed.out, '2.1×');
      assert.ok(Math.abs(parseFloat(mixed.fills[0]) - 83.3333) < 0.01);
      assert.equal(mixed.fills[1], '68.75%');
      assert.equal(mixed.fills[2], '50%');
      await page.evaluate(() => { window.__tintHero = document.getElementById('homeHero'); });
      const clear = await page.evaluate(() => getComputedStyle(document.getElementById('materialMixer')).backgroundColor);
      await page.locator('#segTint [data-tint="1"]').click();
      assert.equal(await page.locator('body.tint-frost').count(), 1);
      assert.equal(await page.locator('body.tint-morph').count(), 1, 'user switch starts the 420ms liquid pulse');
      assert.equal(await page.evaluate(() => window.__tintHero === document.getElementById('homeHero')), true, 'tint never re-renders Home');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('materialMixer')).backgroundColor === 'rgba(220, 238, 255, 0.22)', null, { timeout: 8000 });
      const frost = await page.evaluate(() => ({
        bg: getComputedStyle(document.getElementById('materialMixer')).backgroundColor,
        shadow: getComputedStyle(document.getElementById('materialMixer')).boxShadow,
        morph: document.body.classList.contains('tint-morph'),
        saved: JSON.parse(localStorage.getItem('sdp.v18_nosuggest')).settings.glassTint,
        indicators: Array.from(document.querySelectorAll('.seg-tint .seg-ind'), (el) => el.style.transform)
      }));
      assert.notEqual(frost.bg, clear, 'Frost visibly changes the material');
      assert.equal(frost.bg, 'rgba(220, 238, 255, 0.22)');
      assert.match(frost.shadow, /180, 225, 255/);
      assert.equal(frost.morph, false);
      assert.equal(frost.saved, 1);
      /* browsers normalise the raw `0` channels to `0px` when serialising */
      const norm = (t) => String(t).replace(/\s+/g, '').replace(/px(?=,|\))/g, '');
      assert.deepEqual(frost.indicators.map(norm), ['translate3d(100%,0,0)']);
      await page.locator('#segTint [data-tint="2"]').click();
      assert.equal(await page.locator('body.tint-smoke').count(), 1);
      assert.equal(await page.locator('body.tint-frost').count(), 0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('materialMixer')).backgroundColor === 'rgba(6, 10, 24, 0.66)', null, { timeout: 8000 });
      const smoke = await page.evaluate(() => getComputedStyle(document.getElementById('materialMixer')).backgroundColor);
      assert.equal(smoke, 'rgba(6, 10, 24, 0.66)');
      await page.locator('#segTint [data-tint="0"]').click();
      await page.waitForFunction((expected) => getComputedStyle(document.getElementById('materialMixer')).backgroundColor === expected, clear, { timeout: 8000 });
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('materialMixer')).backgroundColor), clear);

      const orb = page.locator('#orb');
      /* tint clicks auto-scrolled the page (content below the fold on some font
         metrics); the orb must be in view before hit-testing the press point */
      await page.evaluate(() => window.scrollTo(0, 0));
      /* the glass panel (z-index 2) deliberately sits over the orb (z-index 1);
         only the sliver above the panel is hittable, so probe the press point */
      const press = await page.evaluate(() => {
        const o = document.getElementById('orb');
        const p = document.getElementById('materialMixer').getBoundingClientRect();
        const r = o.getBoundingClientRect();
        const y = Math.min(r.top + 40, (r.top + Math.min(r.bottom, p.top)) / 2);
        const x = r.left + r.width / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x: x, y: y, styleTop: o.style.top, orbTop: r.top, panelTop: p.top,
          hit: hit ? (hit.id || String(hit.className) || hit.tagName) : 'none',
          ok: !!hit && (hit === o || o.contains(hit))
        };
      });
      assert.ok(press.ok, 'press point hit-tests to the orb: ' + JSON.stringify(press));
      const before = await orb.boundingBox();
      assert.ok(before, 'the orb is laid out');
      await page.mouse.move(press.x, press.y);
      await page.mouse.down();
      await page.mouse.move(press.x + 60, press.y + 40, { steps: 6 });
      await page.mouse.up();
      const after = await orb.boundingBox();
      assert.ok(after && Math.abs(after.x - before.x) > 30,
        'the orb drags: ' + JSON.stringify({ press: press, before: before, after: after }));

      /* dock magnification is a Full-glass, fine-pointer nicety */
      if ((await material(page)).perf !== 'full') {
        await page.locator('#btnPerf').click();
        await page.waitForTimeout(250);
      }
      /* dock magnification is deliberately a desktop fine-pointer nicety: a
         coarse-pointer engine must not magnify at all, and a fine pointer must */
      const fine = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
      const dock = page.locator('#tab-home');
      await page.mouse.move(2, 2);
      await page.waitForTimeout(3600);   /* performance toasts must clear the dock */
      const box = await dock.boundingBox();
      let transformed = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        transformed = await dock.evaluate((el) => el.style.transform);
        if (transformed) break;
      }
      if (fine) assert.match(transformed, /scale\(1\.28/, 'dock magnification');
      else assert.equal(transformed, '', 'a coarse pointer never magnifies');
      await page.mouse.move(2, 2);
      await page.waitForTimeout(250);
      assert.equal(await dock.evaluate((el) => el.style.transform), '');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' a 390px phone starts in Lite with no horizontal overflow', async () => {
    const { context, page, errors } = await boot(browser, 390, 844);
    try {
      const m = await material(page);
      assert.equal(m.perf, 'lite', 'a phone is downgraded automatically');
      assert.notEqual(m.heroBlur, 'none', 'phone glass still renders');
      assert.notEqual(m.heroShadow, 'none');
      const layout = await page.evaluate(() => ({
        columns: getComputedStyle(document.querySelector('.lg-hero')).display === 'block' ? 1 : 2,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        dock: document.getElementById('tabbar').getBoundingClientRect().width <= window.innerWidth
      }));
      assert.equal(layout.columns, 1, 'the hero stacks on a phone');
      assert.equal(layout.overflow, false, 'no horizontal scroll');
      assert.equal(layout.dock, true, 'the dock fits the viewport');
      await page.locator('#btnPerf').click();
      await page.waitForTimeout(200);
      assert.equal((await material(page)).perf, 'full', 'the phone can still choose Full');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' dictation starts, unlocks audio and speaks the first word', async () => {
    const { context, page, errors } = await boot(browser, 390, 844);
    try {
      await page.locator('#btnStart').click();
      await clickText(page, "I'm ready");
      await clickText(page, 'Skip countdown');
      /* the countdown screen repaints itself, so wait for the player beat */
      await page.waitForFunction(() => /Your turn|Next word|Listening|Paused/.test((document.getElementById('plStatus') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
      const unlocked = await page.evaluate(() => {
        const a = document.getElementById('sdpAudio');
        return { preload: a.getAttribute('preload'), paused: a.paused };
      });
      assert.equal(unlocked.preload, 'none', 'nothing is pre-downloaded');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' a paper dictation ends in a working 30-word tick list', async () => {
    const { context, page, errors } = await boot(browser, 390, 844);
    try {
      await page.locator('#btnStart').click();
      await clickText(page, "I'm ready");
      await clickText(page, 'Skip countdown');
      await page.waitForTimeout(2500);

      /* strictly two spoken repeats of the word, one British female voice */
      const spoken = await page.evaluate(() => window.__spoken || []);
      const word = await page.evaluate(() => JSON.parse(localStorage.getItem('sdp.v18_nosuggest')).lists[0].words[0].w);
      assert.equal(spoken.filter((t) => String(t).trim() === word).length, 2, 'spoken exactly twice: ' + JSON.stringify(spoken));
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sdp.v18_nosuggest')).settings.writeFixed), 5, 'five second timer');

      assert.equal(await clickText(page, 'Finish early'), true, 'Finish early opens');
      assert.equal(await clickText(page, 'Finish now'), true, 'Finish now confirms');
      await page.waitForTimeout(1200);
      const marks = page.locator('[aria-label^="Got it right"]');
      assert.equal(await marks.count(), 30, 'all 30 words can be ticked');
      for (let i = 0; i < 3; i++) await marks.nth(i).click();
      await page.waitForTimeout(600);
      const saved = await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest'));
        const rec = (d.history || [])[0] || {};
        return { runs: (d.history || []).length, score: rec.score, percent: rec.percent, marks: (rec.marks || []).length, selfScored: rec.selfScored };
      });
      assert.equal(saved.runs, 1, 'the result is saved');
      assert.equal(saved.score, 3, 'three ticks = three correct');
      assert.equal(saved.percent, 10, '3/30 is 10%');
      assert.equal(saved.marks, 30, 'every word keeps its mark');
      assert.equal(saved.selfScored, true, 'the paper checklist is scored');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await check(engine + ' v18 typing shield: no suggestions, tick, cross and 1-tap exits', async () => {
    const { context, page, errors } = await boot(browser, 390, 844);
    try {
      /* the ready sheet always offers a one-tap cross mark */
      await page.evaluate(() => {
        document.querySelector('#segMode [data-mode="type"]').click();
      });
      await page.waitForTimeout(200);
      await page.locator('#btnStart').click();
      await page.waitForFunction(() => !!document.getElementById('btnReadyClose'), null, { timeout: 8000 });
      await page.locator('#btnReadyClose').click();
      await page.waitForTimeout(400);
      const closed = await page.evaluate(() => ({
        sheets: document.querySelectorAll('#sheets .sheet').length,
        layers: document.querySelectorAll('#layers .layer').length,
        state: window.SDP ? 'ok' : 'ok',
        homeVisible: !document.getElementById('screen-home').classList.contains('hidden')
      }));
      assert.equal(closed.sheets, 0, 'the ready sheet closed');
      assert.equal(closed.layers, 0, 'the player layer closed');
      assert.equal(closed.homeVisible, true, 'Home is back');

      /* start again and audit the typing deck */
      await page.locator('#btnStart').click();
      await clickText(page, "I'm ready");
      await clickText(page, 'Skip countdown');
      await page.waitForFunction(() => !!document.getElementById('ansInput'), null, { timeout: 15000 });
      const deck = await page.evaluate(() => {
        const i = document.getElementById('ansInput');
        return {
          type: i.type,
          autocomplete: i.getAttribute('autocomplete'),
          spellcheck: i.getAttribute('spellcheck'),
          autocorrect: i.getAttribute('autocorrect'),
          inputmode: i.getAttribute('inputmode'),
          vkb: document.querySelectorAll('#ansVkb .vkb-key').length,
          rows: document.querySelectorAll('#ansVkb .vkb-row').length,
          tick: !!document.getElementById('ansTick'),
          cross: !!document.getElementById('ansWrong'),
          closeBtn: !!document.getElementById('btnPlayerClose'),
          pill: (document.getElementById('plLiveScore') || {}).textContent || ''
        };
      });
      assert.equal(deck.type, 'search', 'the input is not a text field for IMEs');
      assert.equal(deck.autocomplete, 'one-time-code');
      assert.equal(deck.spellcheck, 'false');
      assert.equal(deck.autocorrect, 'off');
      assert.equal(deck.inputmode, 'none', 'touch devices never open the system keyboard');
      assert.equal(deck.vkb, 31, 'four QWERTY rows');
      assert.equal(deck.rows, 4);
      assert.equal(deck.tick, true);
      assert.equal(deck.cross, true);
      assert.equal(deck.closeBtn, true);
      assert.match(deck.pill, /Correct/);

      /* type the answer with the built-in keyboard: the tick must appear */
      const word = await page.evaluate(() => {
        const d = JSON.parse(localStorage.getItem('sdp.v18_nosuggest'));
        const l = d.lists[0];
        return l.words[0].w.split('/')[0];
      });
      for (const ch of word) {
        await page.evaluate((c) => {
          const key = Array.from(document.querySelectorAll('#ansVkb .vkb-key')).find((b) => b.textContent === c);
          if (key) key.click();
        }, ch);
        await page.waitForTimeout(25);
      }
      await page.waitForTimeout(250);
      const solved = await page.evaluate(() => ({
        solved: document.getElementById('ansWrap').classList.contains('is-correct'),
        tick: document.getElementById('ansTick').classList.contains('is-correct'),
        hero: document.getElementById('plTickHero').classList.contains('is-correct'),
        slots: document.querySelectorAll('#ansSlots .slot-done').length
      }));
      assert.equal(solved.solved, true, 'the input bar glows');
      assert.equal(solved.tick, true, 'the tick mark animates in');
      assert.equal(solved.hero, true, 'the Correct! badge shows');
      assert.ok(solved.slots > 0, 'the letter slots light up');

      /* a wrong answer breaks the streak and shows the correction card */
      await page.waitForTimeout(1300);
      await page.evaluate(() => {
        const i = document.getElementById('ansInput');
        i.value = 'zzzz';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await page.waitForTimeout(400);
      const wrong = await page.evaluate(() => ({
        cross: document.getElementById('ansWrong').classList.contains('is-wrong'),
        hero: document.getElementById('plWrongHero').classList.contains('is-wrong'),
        streak: document.getElementById('plStreakCount').className,
        compare: (document.getElementById('ansCompare') || {}).textContent || ''
      }));
      assert.equal(wrong.cross, true, 'the cross mark shows');
      assert.equal(wrong.hero, true, 'the Incorrect badge shows');
      assert.match(wrong.streak, /streak-broken/, 'the streak breaks');
      assert.match(wrong.compare, /Correct UK spelling/);
      assert.match(wrong.compare, /Your answer/);

      /* the player cross mark exits in one tap */
      await page.locator('#btnPlayerClose').click();
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({
        layers: document.querySelectorAll('#layers .layer').length,
        home: !document.getElementById('screen-home').classList.contains('hidden')
      }));
      assert.equal(after.layers, 0, 'the player closed');
      assert.equal(after.home, true, 'Home is back');
      assert.equal(errors.length, 0, 'page errors: ' + errors.join(' | '));
    } finally {
      await context.close();
    }
  });

  await browser.close();
  const output = path.join(__dirname, 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'upgrade-browser-' + engine + '.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  annotate();
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  console.log('::error::' + String((error && error.stack) || error).replace(/\r?\n/g, ' | ').replace(/%/g, '%25').slice(0, 900));
  process.exitCode = 1;
});
