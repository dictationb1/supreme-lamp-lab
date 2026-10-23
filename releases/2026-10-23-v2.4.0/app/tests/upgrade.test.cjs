/* Smart Dictation Player 2.4.0 (schema 16) release verification.
   Rewritten from scratch for v16: animated swan credit badge, Liquid Glass
   hero headline, Material Mixer moved to Settings and the zero-lag 60 FPS
   pass. It never patches app source and never edits an older suite. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, html } = require('./app-harness.cjs');

const root = path.resolve(__dirname, '..');
const json = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));
const version = json('version.json');
const config = json('config.json');
const session = json('session.json');
const PIN = require('./test-pin.cjs');

const TITLE = 'Session 7 - Travel & Transport';
const LIST_ID = 'list_session_7_travel';
const STORE_KEY = 'sdp.v16_swan';
const CREDIT = 'Created by Hansana · Idea given by Ayya01 (Lesandu) · Lecturer in Charge: Sumodya Sewmini';
const WORDS = [
  'guidebook', 'handlebars', 'harbour', 'helicopter', 'hitchhike', 'immigration',
  'journey', 'luggage', 'machine', 'mechanic', 'nationality', 'on business',
  'on vacation', 'overnight', 'passenger', 'public transport', 'reception',
  'reservation', 'road sign', 'signpost', 'spaceship', 'suitcase',
  'tourist information centre', 'traffic lights', 'tunnel', 'tyre/tire',
  'vehicle', 'visa', 'waiting room', 'windscreen'
];
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function boot() { return harness(); }
function has(token, label) { assert.ok(html.indexOf(token) >= 0, label || token); }
function lacks(token, label) { assert.equal(html.indexOf(token), -1, label || token); }
function fire(a, el, type, init) {
  el.dispatchEvent(new a.w.Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
}
function slide(a, id, value) {
  const el = a.w.document.getElementById(id);
  assert.ok(el, '#' + id + ' exists');
  el.value = String(value);
  fire(a, el, 'input');
  return el;
}
function device(a, options) {
  const p = options || {};
  if (p.width) Object.defineProperty(a.w, 'innerWidth', { value: p.width, configurable: true });
  if (p.cores) Object.defineProperty(a.w.navigator, 'hardwareConcurrency', { value: p.cores, configurable: true });
  if (p.memory) Object.defineProperty(a.w.navigator, 'deviceMemory', { value: p.memory, configurable: true });
  if (p.saveData) Object.defineProperty(a.w.navigator, 'connection', { value: { saveData: true, effectiveType: '3g' }, configurable: true });
  a.w.matchMedia = (query) => ({
    matches: (p.media || []).some((part) => query.indexOf(part) >= 0),
    addEventListener() {}
  });
  return a;
}
function openSettings(a) {
  a.q.UI.setTab('set');
  const doc = a.w.document;
  const stage = doc.querySelector('#setBody #lgStage');
  assert.ok(stage, '#lgStage is rendered inside Settings');
  return stage;
}
function stored(a) {
  return JSON.parse(a.w.localStorage.getItem(STORE_KEY) || 'null');
}

/* ------------------------------------------------------------ release data */

test('v16 / 2.4.0 metadata, schema and performance defaults are consistent', function () {
  for (const data of [version, config, session]) assert.ok(Number(data.ver) >= 16, 'ver >= 16');
  assert.equal(version.appVersion, '2.4.0');
  assert.equal(version.version, '2.4.0');
  assert.equal(version.settingsRev, 16);
  assert.equal(version.session, '7');
  assert.equal(version.title, TITLE);
  assert.equal(config.appVersion, '2.4.0');
  assert.equal(config.version, '2.4.0');
  assert.equal(config.settingsRev, 16);
  assert.equal(config.listId, LIST_ID);
  assert.equal(config.session.title, TITLE);
  assert.equal(config.session.date, '2026-10-22');
  assert.equal(config.session.branch, 'CCBE Galle Branch');
  assert.equal(config.session.display, 'SESSION 7 · 22/10/2026 · CCBE GALLE BRANCH');
  assert.equal(config.defaults.perf, 'auto');
  assert.equal(config.defaults.writeMode, 'fixed');
  assert.equal(config.defaults.writeFixed, 5);
  assert.equal(config.defaults.repeats, 2);
  assert.equal(config.defaults.sentence, false);
  assert.equal(config.performance.probeMs, 1200);
  assert.equal(config.performance.medianBudgetMs, 19);
  assert.equal(config.dataSaving.preload, 'none');
  assert.equal(config.dataSaving.audioReuse, true);
  assert.equal(config.credits.en, CREDIT);
  has('APP_VERSION = "2.4.0"');
  has('key: "sdp.v16_swan"');
  has('schema: 16');
  has('settingsRev: 16');
  has('d.settingsRev = 16;');
});

test('Session 7 keeps all 30 Travel & Transport words with the 5s / ×2 defaults', function () {
  assert.equal(session.appVersion, '2.4.0');
  assert.equal(session.session.no, '7');
  assert.equal(session.session.listId, LIST_ID);
  assert.equal(session.lists.length, 1);
  const list = session.lists[0];
  assert.equal(list.id, LIST_ID);
  assert.equal(list.name, TITLE);
  assert.equal(list.words.length, 30);
  assert.deepEqual(list.words.map((word) => word.w), WORDS);
  for (const word of list.words) {
    assert.ok(word.m.length > 8, word.w + ' definition');
    assert.ok(word.s.length > 15, word.w + ' example');
    assert.match(word.audio, /^https:\/\/.+\.mp3$/, word.w + ' UK MP3');
    has(word.w, 'embedded word ' + word.w);
  }
  has('SAMPLE_LIST_ID = "list_session_7_travel"');
  has('writeFixed: 5');
  has('repeats: 2');
  has('sentence: false');
  const a = boot();
  try {
    assert.equal(a.q.DB.data.settings.writeMode, 'fixed');
    assert.equal(a.q.DB.data.settings.writeFixed, 5);
    assert.equal(a.q.DB.data.settings.repeats, 2);
    assert.equal(a.q.DB.data.settings.sentence, false);
    assert.equal(a.q.Lib.current().words.length, 30);
    assert.equal(a.q.SAMPLE_LIST_ID, LIST_ID);
    assert.equal(a.w.document.getElementById('homeTitle').textContent, TITLE);
  } finally { a.close(); }
});

test('the unified British female professor voice is Amy (en-GB) with a female failover', function () {
  assert.match(config.tts.primary, /Amy/);
  assert.match(config.tts.primary, /en-GB/);
  assert.match(config.tts.failover, /Google Translate TTS/);
  assert.match(config.tts.backup, /female/i);
  has('voice=Amy');
  has('translate.google.com/translate_tts');
  has('tl=en-GB');
  has('ttsBackupHost');
  has('playSmartAudio: function (text, rate, onEnd)');
  has('}, 3500);');
  const a = boot();
  try {
    const sources = a.q.Speech.streamSources('good morning');
    assert.equal(sources.length, 2, 'Amy then Google en-GB');
    assert.match(sources[0], /voice=Amy/);
    assert.match(sources[1], /translate\.google\.com/);
    assert.match(sources[1], /tl=en-GB/);
    assert.equal(a.q.Speech.isMaleName('Daniel'), true, 'male device voices stay excluded');
    assert.equal(a.q.Speech.isMaleName('Sonia'), false);
  } finally { a.close(); }
});

/* ---------------------------------------------------------------- the swan */

test('the credit badge carries the animated Liquid Glass swan, never the water drop', function () {
  lacks('c-drop', 'the water drop is gone');
  lacks('<path d="M12 2.7C9 7 5.5 11 5.5 14.5', 'the water drop path is gone');
  has('<svg class="c-swan" viewBox="0 0 36 36"');
  has('class="swan-group"');
  has('class="swan-wing"');
  has('class="swan-ripple"');
  has('id="swanBody"');
  has('id="swanWing"');
  has('.c-swan { width: 30px; height: 30px; flex: none; overflow: visible; filter: drop-shadow(0 2px 8px rgba(92, 208, 244, .45)); }');
  has('.c-swan .swan-group { transform-origin: 18px 22px; animation: swanFloat 3.2s ease-in-out infinite; }');
  has('.c-swan .swan-wing { transform-origin: 20px 21px; animation: swanWing 2.4s ease-in-out infinite alternate; }');
  has('.c-swan .swan-ripple { transform-origin: 19px 29.5px; animation: swanRipple 2.8s ease-out infinite; }');
  has('@keyframes swanFloat { 0%, 100% { transform: translate3d(0, 0, 0) rotate(0deg); } 50% { transform: translate3d(0, -2.5px, 0) rotate(-2.5deg); } }');
  has('@keyframes swanWing { 0% { transform: scaleY(1) rotate(0deg); } 100% { transform: scaleY(1.08) translate3d(0, -1px, 0) rotate(3deg); } }');
  has('@keyframes swanRipple { 0% { transform: scaleX(.75); opacity: .85; } 100% { transform: scaleX(1.22); opacity: 0; } }');
  has('.credit.in .ring');
  has('@keyframes sheen');
  has('@keyframes ping');
  lacks('body[data-perf="lite"] .c-swan', 'the swan is never animation:none in Lite');
  has('.credit { position: fixed;');
  has('.credit.in {');
  has('.credit.out {');
  const a = boot();
  try {
    const doc = a.w.document;
    const credit = doc.getElementById('credit');
    assert.equal(doc.querySelectorAll('#credit .c-swan').length, 1);
    assert.equal(doc.querySelectorAll('#credit .c-drop').length, 0);
    assert.ok(doc.querySelectorAll('#credit .c-swan .swan-group path').length >= 4, 'body, wing, neck and beak');
    assert.equal(doc.querySelectorAll('#credit .c-swan .swan-ripple').length, 1);
    assert.equal(credit.getAttribute('aria-label'), 'Credits go to Hansana');
    assert.ok(credit.textContent.indexOf('credits goes to') >= 0);
    assert.ok(credit.textContent.indexOf('Hansana') >= 0);
    assert.equal(credit.classList.contains('in'), false, 'the loop starts hidden');
    a.clock.tick(250);
    assert.ok(credit.classList.contains('in'), 'the swan badge springs in');
    assert.equal(credit.classList.contains('out'), false);
  } finally { a.close(); }
});

test('creditLoop still holds for 5200ms, exits, repeats, pauses on hover and toasts on click', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    const credit = doc.getElementById('credit');
    a.clock.tick(250);
    assert.ok(credit.classList.contains('in'));
    a.clock.tick(5199);
    assert.ok(credit.classList.contains('in'), 'still held');
    a.clock.tick(1);
    assert.ok(credit.classList.contains('out'));
    assert.ok(!credit.classList.contains('in'));
    a.clock.tick(900);
    a.clock.tick(350);
    assert.ok(credit.classList.contains('in'), 'the loop enters again');
    fire(a, credit, 'mouseenter');
    a.clock.tick(12000);
    assert.ok(credit.classList.contains('in'), 'hover pauses the loop');
    fire(a, credit, 'mouseleave');
    credit.click();
    assert.ok(doc.getElementById('toasts').textContent.indexOf('Hansana') >= 0, 'full credits toast');
    assert.ok(doc.getElementById('toasts').textContent.indexOf('Sumodya Sewmini') >= 0);
    assert.ok(credit.querySelector('.c-swan'), 'the swan stays inside the badge in both modes');
    a.q.UI.setPerf('lite');
    assert.equal(doc.body.getAttribute('data-perf'), 'lite');
    assert.ok(credit.querySelector('.c-swan'));
    assert.ok(!credit.classList.contains('out') || credit.classList.contains('in'));
  } finally { a.close(); }
});

/* ---------------------------------------------------------- hero headline */

test('the hero headline no longer says Liquid Glass and is itself the glass', function () {
  lacks('<span class="hollow"', 'no hollow "Liquid Glass" word');
  lacks('.hollow {', 'the hollow rule is gone');
  has('<h1 class="hero-h1"><span id="homeTitle" class="liquid-glass-text">Session 7 - Travel &amp; Transport</span></h1>');
  has('#homeTitle, .liquid-glass-text { display: inline-block;');
  has('font-size: clamp(2.1rem, 4.8vw, 3.85rem)');
  has('-webkit-background-clip: text; background-clip: text; color: transparent;');
  has('-webkit-text-stroke: 1.35px rgba(255, 255, 255, .78)');
  has('text-shadow: 0 10px 28px rgba(83, 199, 240, .24)');
  has(':root[data-theme="light"] #homeTitle, body[data-theme="light"] #homeTitle');
  has('-webkit-text-stroke: 1.25px rgba(14, 20, 36, .75)');
  const hero = html.slice(html.indexOf('id="homeHero"'), html.indexOf('class="hero-actions"'));
  assert.equal(hero.indexOf('Liquid Glass'), -1, 'the words never follow the title');
  assert.equal(hero.indexOf('hollow'), -1);
  assert.match(hero, /class="liquid-glass-text"/);
  const a = boot();
  try {
    const doc = a.w.document;
    const title = doc.getElementById('homeTitle');
    const h1 = title.parentNode;
    assert.equal(h1.className, 'hero-h1');
    assert.ok(title.classList.contains('liquid-glass-text'));
    assert.equal(title.textContent, TITLE);
    assert.equal(doc.getElementById('homeHero').innerHTML.indexOf('Liquid Glass'), -1);
    assert.equal(doc.querySelectorAll('#homeHero .hollow').length, 0);
  } finally { a.close(); }
});

/* ------------------------------------------------- the mixer inside Settings */

test('Home is a clean single-column hero: no mixer, straight into stats and past sessions', function () {
  has('.lg-hero { display: block; }');
  const a = boot();
  try {
    const doc = a.w.document;
    const home = doc.getElementById('screen-home');
    assert.equal(home.querySelector('#lgStage'), null, 'Home has no Material Mixer');
    assert.equal(home.querySelector('#materialMixer'), null);
    assert.equal(home.querySelector('#orb'), null);
    assert.equal(home.querySelector('#sBlur'), null);
    assert.equal(home.querySelector('#segTint'), null);
    assert.ok(home.querySelector('.lg-hero .anatomy-stage #homeHero.glass'));
    assert.ok(home.querySelector('.lg-hero .anatomy-stage .stripes'));
    assert.ok(home.querySelector('.lg-hero .anatomy-stage .disc'));
    const stats = home.querySelector('.lg-hero #homeStats');
    assert.ok(stats, 'the three bento tiles follow inside the hero stage');
    assert.equal(stats.children.length, 3);
    assert.ok(stats.textContent.indexOf('day streak') >= 0);
    assert.ok(stats.textContent.indexOf('last score') >= 0);
    assert.ok(stats.textContent.indexOf('sessions done') >= 0);
    assert.ok(home.querySelector('.lg-hero .home-lower #homeSessions'), 'past sessions stay in the stage');
    assert.equal(home.querySelectorAll('.lg-hero').length, 1);
  } finally { a.close(); }
});

test('#lgStage is rendered by Screens.settings() with the whole Material Mixer', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    assert.equal(doc.querySelectorAll('#lgStage').length, 0, 'not mounted before Settings opens');
    const stage = openSettings(a);
    assert.equal(doc.querySelectorAll('#lgStage').length, 1);
    assert.ok(doc.querySelectorAll('#setBody .lg-section #lgStage').length === 1, 'top of the Liquid Glass section');
    assert.ok(doc.getElementById('setBody').textContent.indexOf('Appearance · Liquid Glass') >= 0);
    assert.equal(stage.querySelectorAll('.bubble').length, 4, 'the four rising spheres');
    assert.ok(stage.querySelector('.chip-a').textContent.indexOf('Liquid Glass: Live') >= 0);
    assert.ok(stage.querySelector('.chip-a').textContent.indexOf('🦢') >= 0);
    assert.ok(stage.querySelector('.chip-b').textContent.indexOf('Amy UK Voice') >= 0);
    const orb = doc.getElementById('orb');
    assert.ok(orb.classList.contains('orb'));
    assert.equal(orb.getAttribute('role'), 'button');
    assert.equal(orb.getAttribute('tabindex'), '0');
    const mixer = doc.getElementById('materialMixer');
    assert.ok(mixer.classList.contains('glass') && mixer.classList.contains('panel'));
    assert.ok(mixer.textContent.indexOf('Liquid Glass Material Mixer') >= 0);
    assert.equal(doc.getElementById('sBlur').getAttribute('min'), '4');
    assert.equal(doc.getElementById('sBlur').getAttribute('max'), '40');
    assert.equal(doc.getElementById('sSat').getAttribute('min'), '100');
    assert.equal(doc.getElementById('sSat').getAttribute('max'), '260');
    assert.equal(doc.getElementById('sBrt').getAttribute('min'), '90');
    assert.equal(doc.getElementById('sBrt').getAttribute('max'), '130');
    const tint = doc.getElementById('segTint');
    assert.ok(tint.classList.contains('seg-tint'));
    assert.equal(tint.querySelectorAll('button').length, 3);
    assert.deepEqual(Array.from(tint.querySelectorAll('button'), (b) => b.textContent), ['Clear', 'Frost', 'Smoke']);
    assert.equal(tint.querySelectorAll('.seg-ind').length, 1);
    const perf = doc.getElementById('segPerf');
    assert.ok(perf.classList.contains('seg-perf'));
    assert.equal(perf.querySelectorAll('button').length, 3);
    assert.deepEqual(Array.from(perf.querySelectorAll('button'), (b) => b.textContent), ['Auto', 'Lite 60FPS', 'Full']);
    assert.equal(perf.querySelectorAll('.seg-ind').length, 1);
    assert.ok(mixer.textContent.indexOf('drag the glowing orb behind this glass pane') >= 0);
  } finally { a.close(); }
});

test('Settings sliders drive the global material, the live --fill track and storage', function () {
  const a = boot();
  try {
    const doc = a.w.document, rootStyle = doc.documentElement.style;
    openSettings(a);
    const blur = slide(a, 'sBlur', 28);
    assert.equal(rootStyle.getPropertyValue('--gb'), '28px');
    assert.equal(doc.getElementById('outBlur').textContent, '28px');
    assert.ok(Math.abs(parseFloat(blur.style.getPropertyValue('--fill')) - 66.6667) < 0.05);
    const sat = slide(a, 'sSat', 210);
    assert.equal(rootStyle.getPropertyValue('--gs'), '2.10');
    assert.equal(doc.getElementById('outSat').textContent, '2.1×');
    assert.equal(sat.style.getPropertyValue('--fill'), '68.75%');
    const brt = slide(a, 'sBrt', 110);
    assert.equal(rootStyle.getPropertyValue('--gbr'), '1.10');
    assert.equal(doc.getElementById('outBrt').textContent, '1.1');
    assert.equal(brt.style.getPropertyValue('--fill'), '50%');
    a.clock.tick(600);
    const saved = stored(a);
    assert.equal(saved.settings.glassBlur, 28);
    assert.equal(saved.settings.glassSat, 210);
    assert.equal(saved.settings.glassBrt, 110);
    assert.equal(saved.settings.lowData !== undefined, true);
  } finally { a.close(); }
});

test('Clear / Frost / Smoke and Auto / Lite 60FPS / Full glide without rebuilding the bars', function () {
  const a = boot();
  try {
    const doc = a.w.document, q = a.q;
    openSettings(a);
    const tint = doc.getElementById('segTint'), perf = doc.getElementById('segPerf');
    const tintInd = tint.querySelector('.seg-ind'), perfInd = perf.querySelector('.seg-ind');
    doc.querySelector('#segTint [data-tint="1"]').click();
    assert.ok(doc.body.classList.contains('tint-frost'));
    assert.equal(tintInd.style.transform, 'translate3d(100%, 0, 0)');
    assert.equal(doc.getElementById('segTint'), tint, 'the tint bar is never re-created');
    assert.equal(doc.getElementById('segPerf'), perf, 'the perf bar is never re-created');
    assert.equal(tintInd.style.transform, tint.querySelector('.seg-ind').style.transform);
    doc.querySelector('#segTint [data-tint="2"]').click();
    assert.ok(doc.body.classList.contains('tint-smoke'));
    assert.ok(!doc.body.classList.contains('tint-frost'));
    assert.equal(tintInd.style.transform, 'translate3d(200%, 0, 0)');
    doc.querySelector('#segTint [data-tint="0"]').click();
    assert.ok(doc.body.classList.contains('tint-clear'));
    assert.equal(tintInd.style.transform, 'translate3d(0%, 0, 0)');
    assert.equal(q.DB.data.settings.glassTint, 0);

    doc.querySelector('#segPerf [data-perf="lite"]').click();
    assert.equal(q.DB.data.settings.perf, 'lite');
    assert.equal(q.UI.perfMode, 'lite');
    assert.equal(doc.body.getAttribute('data-perf'), 'lite');
    assert.equal(doc.getElementById('perfStatus').textContent, '⚡ Lite (60 FPS)');
    assert.equal(doc.getElementById('segPerf'), perf);
    assert.ok(perfInd.style.transform.indexOf('translate3d(') === 0);
    doc.querySelector('#segPerf [data-perf="full"]').click();
    assert.equal(doc.body.getAttribute('data-perf'), 'full');
    assert.equal(doc.getElementById('perfStatus').textContent, '✨ Full');
    doc.querySelector('#segPerf [data-perf="auto"]').click();
    assert.equal(q.DB.data.settings.perf, 'auto');
    assert.equal(q.DB.data.settingsRev, 16);
  } finally { a.close(); }
});

test('the orb is bound inside Settings, drags and nudges with the keyboard', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    const stage = openSettings(a);
    const orb = doc.getElementById('orb');
    assert.equal(orb.__lgBound, 1, 'bindLiquidControls ran inside Screens.settings()');
    stage.getBoundingClientRect = () => ({ width: 400, height: 400, left: 0, top: 0, right: 400, bottom: 400 });
    orb.getBoundingClientRect = () => ({ width: 140, height: 140, left: 20, top: 40, right: 160, bottom: 180 });
    assert.equal(orb.style.left, '0px', 'the orb is mounted and positioned');
    const down = new a.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    orb.dispatchEvent(down);
    assert.equal(orb.style.left, '32px');
    const downKey = new a.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    orb.dispatchEvent(downKey);
    assert.equal(orb.style.top, '52px');
    const centre = new a.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    orb.dispatchEvent(centre);
    assert.equal(orb.style.left, '109.2px', 'Enter centres the orb');
  } finally { a.close(); }
});

test('applyGlassSettings restores the saved material at boot and on every render', function () {
  const a = boot();
  try {
    const doc = a.w.document, rootStyle = doc.documentElement.style;
    assert.equal(typeof a.q.UI.applyGlassSettings, 'function');
    assert.equal(rootStyle.getPropertyValue('--gb'), '14px', 'defaults applied on boot');
    assert.equal(rootStyle.getPropertyValue('--gs'), '1.60');
    assert.equal(rootStyle.getPropertyValue('--gbr'), '1.03');
    a.q.DB.data.settings.glassBlur = 26;
    a.q.DB.data.settings.glassSat = 140;
    a.q.DB.data.settings.glassBrt = 96;
    a.q.DB.data.settings.glassTint = 2;
    a.q.UI.applyGlassSettings();
    assert.equal(rootStyle.getPropertyValue('--gb'), '26px');
    assert.equal(rootStyle.getPropertyValue('--gs'), '1.40');
    assert.equal(rootStyle.getPropertyValue('--gbr'), '0.96');
    assert.ok(doc.body.classList.contains('tint-smoke'));
    has('UI.applyGlassSettings();', 'called on boot');
    has('if (DB.data && DB.data.settings) UI.applyGlassSettings();', 'called when the mixer binds');
  } finally { a.close(); }
});

/* -------------------------------------------------------------- the dock */

test('#tabInd / .tab-ind slides with translate3d across all five sections', function () {
  has('#tabInd, .tab-ind {');
  has('transition: transform .48s cubic-bezier(.2, .9, .25, 1.35)');
  has('ind.style.transform = "translate3d(" + (idx * 100) + "%, 0, 0)"');
  has('.seg-tint .seg-ind, .seg .thumb, .seg .seg-ind, .seg-perf .seg-ind, #tabInd { transition: transform .48s cubic-bezier(.2, .9, .25, 1.35), width .48s cubic-bezier(.2, .9, .25, 1.35), background .35s ease !important; }');
  const a = boot();
  try {
    const doc = a.w.document;
    const ind = doc.getElementById('tabInd');
    assert.ok(ind.classList.contains('tab-ind'));
    const order = ['home', 'dict', 'practice', 'comm', 'set'];
    order.forEach((name, index) => {
      a.q.UI.setTab(name);
      assert.equal(ind.style.transform, 'translate3d(' + (index * 100) + '%, 0, 0)', name);
      assert.equal(doc.getElementById('tab-' + name).getAttribute('aria-selected'), 'true');
      assert.equal(doc.getElementById('tabInd'), ind, 'the capsule element survives every tab switch');
    });
    assert.equal(typeof a.q.UI.segSync, 'function');
  } finally { a.close(); }
});

test('segSync glides every pill with translate3d and clicks never rebuild the seg DOM', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    const seg = doc.getElementById('segMode');
    const thumb = seg.querySelector('.thumb');
    assert.ok(thumb, 'Home keeps its seg thumb');
    doc.querySelector('#segMode [data-mode="type"]').click();
    assert.equal(a.q.DB.data.settings.mode, 'type');
    assert.equal(doc.getElementById('segMode'), seg, 'the Home seg is never re-created');
    assert.ok(thumb.style.transform.indexOf('translate3d(') === 0);
    assert.match(thumb.style.width, /px$/);
    doc.querySelector('#segMode [data-mode="paper"]').click();
    assert.equal(a.q.DB.data.settings.mode, 'paper');
    openSettings(a);
    const perf = doc.getElementById('segPerf');
    a.q.UI.segSync(perf);
    assert.ok(perf.querySelector('.seg-ind').style.transform.indexOf('translate3d(') === 0);
    assert.equal(perf.querySelectorAll('button[aria-pressed="true"]').length, 1);
  } finally { a.close(); }
});

/* ------------------------------------------------------- zero-lag 60 FPS */

test('zero-lag CSS: one backdrop pass per surface, GPU bars, pre-blurred blobs', function () {
  has('#s-home .tile .glass, .card.glass .glass, .glass .glass, .tile .glass, .word-item.glass, .comm-item.glass, #homeStats .statbox-in, .bento-sessions > .glass { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: linear-gradient(135deg, rgba(255,255,255,.12), rgba(255,255,255,.04)); }');
  has('.topbar.glass { position: fixed;');
  has('transform: translate3d(-50%, 0, 0); will-change: transform; backface-visibility: hidden;');
  has('#tabbar {position: fixed; bottom: calc(12px + var(--safe-b)); left: 50%; transform: translate3d(-50%, 0, 0); will-change: transform; backface-visibility: hidden;');
  has('#credit.glass { will-change: transform, opacity; backface-visibility: hidden; }');
  has('.blob { --blob-c: var(--blob-color); background: radial-gradient(circle, var(--blob-c) 0%, transparent 70%); filter: none !important; }');
  has('radial-gradient(circle, var(--blob-color) 0%, transparent 70%)');
  has('#grain { display: none !important; }');
  has('<feTurbulence', 'the grain SVG is kept but never painted');
  has('#grain { display: none !important; }');
  has('blur(var(--gb)) saturate(var(--gs)) brightness(var(--gbr))');
  has('body[data-perf="lite"] { --gb: 8px; --gs: 1.35; --gbr: 1.02; }');
  has('body[data-perf="lite"] .blob, body[data-perf="lite"] .bubble, body[data-perf="lite"] .chip-a, body[data-perf="lite"] .chip-b { animation: none !important; }');
  assert.doesNotMatch(html, /body\[data-perf="lite"\]\s+(?:#credit|\.credit)/);
  const a = boot();
  try {
    const doc = a.w.document;
    assert.equal(doc.querySelectorAll('.glass .glass').length >= 1, true, 'nested glass surfaces exist and are flattened');
    assert.equal(doc.querySelectorAll('.toast.glass .glass').length, 0);
  } finally { a.close(); }
});

test('Auto Lite covers phones, touch, low CPU, low RAM, Data Saver and reduced motion', function () {
  const scenarios = [
    [{ width: 390, cores: 8, memory: 8 }, 'lite', 'phone'],
    [{ width: 1280, cores: 8, memory: 8, media: ['(pointer: coarse)'] }, 'lite', 'touch'],
    [{ width: 1280, cores: 4, memory: 8 }, 'lite', 'CPU'],
    [{ width: 1280, cores: 8, memory: 4 }, 'lite', 'RAM'],
    [{ width: 1280, cores: 8, memory: 8, saveData: true }, 'lite', 'Data Saver'],
    [{ width: 1280, cores: 8, memory: 8, media: ['prefers-reduced-motion'] }, 'lite', 'reduced motion'],
    [{ width: 1280, cores: 8, memory: 8 }, 'full', 'strong desktop']
  ];
  for (const [prefs, expected, label] of scenarios) {
    const a = boot();
    try {
      device(a, prefs);
      assert.equal(a.q.UI.autoPerf(), expected, label);
    } finally { a.close(); }
  }
  const a = boot();
  try {
    device(a, { width: 1280, cores: 8, memory: 8 });
    a.q.DB.data.settings.perf = 'auto';
    a.q.UI.setPerf('full');
    assert.equal(a.w.document.body.getAttribute('data-perf'), 'full', 'a manual choice wins');
    a.q.UI.setPerf('auto');
    assert.equal(a.w.document.body.getAttribute('data-perf'), 'full');
  } finally { a.close(); }
});

test('the single 1.2 second frame probe stops and downgrades above 19ms', function () {
  const a = boot();
  try {
    const ui = a.q.UI;
    assert.equal(ui.frameWatchStarted, true, 'boot starts exactly one probe');
    let pending = null, requests = 0, cancelled = 0, calls = 0;
    a.w.requestAnimationFrame = function (cb) { requests++; pending = cb; return requests; };
    a.w.cancelAnimationFrame = function () { cancelled++; };
    ui.frameWatchStarted = false;
    ui.frameProbe(function () { calls++; });
    let now = 0;
    for (let i = 0; i < 120 && pending; i++) {
      const cb = pending;
      pending = null;
      now += 16.7;
      cb(now);
    }
    assert.equal(calls, 1);
    assert.equal(pending, null);
    assert.ok(cancelled >= 1, 'cancelAnimationFrame stops the window');
    assert.ok(requests >= 60 && requests <= 80, 'one startup window: ' + requests);
    device(a, { width: 1280, cores: 8, memory: 8 });
    a.q.DB.data.settings.perf = 'auto';
    ui.autoDowngraded = false;
    ui.recordFrames([16, 16.6, 17, 16.2]);
    assert.equal(ui.perfMode, 'full');
    ui.recordFrames([42, 48, 55, 60]);
    assert.equal(ui.autoDowngraded, true);
    assert.equal(ui.perfMode, 'lite');
    assert.equal(a.w.document.body.getAttribute('data-perf'), 'lite');
    assert.equal(ui.frameMs, 55);
  } finally { a.close(); }
});

/* ------------------------------------------------------- low-data engine */

test('DictAPI answers all Session 7 entries from memory with zero requests', function () {
  const a = boot();
  try {
    let fetches = 0;
    a.w.fetch = function () { fetches++; return Promise.reject(new Error('offline')); };
    const seen = [];
    a.q.DictAPI.lookup('guidebook', (entry) => seen.push(entry));
    assert.equal(fetches, 0, 'no network for an embedded word');
    assert.equal(seen.length, 1);
    const entry = seen[0];
    assert.equal(entry.embedded, true);
    assert.ok(entry.phon && entry.phon.length > 1, 'phonetic');
    assert.ok(entry.pos && entry.pos.length > 1, 'part of speech');
    assert.ok(entry.def && entry.def.length > 8, 'definition');
    assert.ok(entry.ex && entry.ex.length > 15, 'example');
    const more = [];
    a.q.DictAPI.lookup('windscreen', (e) => more.push(e));
    a.q.DictAPI.lookup('public transport', (e) => more.push(e));
    assert.equal(fetches, 0, 'still zero requests');
    assert.equal(more.length, 2);
    assert.ok(more[0].def.indexOf('windscreen') >= 0 || more[0].def.length > 8);
    assert.equal(a.q.CONFIG.key, STORE_KEY);
  } finally { a.close(); }
});

test('the shared Amy audio reuses its buffer instead of downloading twice', function () {
  has('<audio id="sdpAudio" preload="none"');
  has('a.currentTime = 0');
  has('same = !!src && a.src === src && a.readyState >= 2;');
  has('preloadCache');
  has('playSmartAudio: function (text, rate, onEnd)');
  assert.equal((html.match(/id="sdpAudio"/g) || []).length, 1, 'one shared element');
  const a = boot();
  try {
    const audio = a.w.document.getElementById('sdpAudio');
    assert.equal(audio.getAttribute('preload'), 'none');
    assert.equal(audio.id, 'sdpAudio');
  } finally { a.close(); }
});

test('v15 storage upgrades in place to schema 16 without losing results', function () {
  assert.equal(version.settingsRev, 16);
  has('var legacyKeys = ["sdp.v15_liquid", "sdp.v14_liquid", "sdp.v13_fast_liquid", "sdp.v12_liquid"]');
  const a = boot();
  try {
    const migrated = a.q.DB.migrate({ results: [{ id: 'keep-me', score: 27 }], settings: { glassTint: 1 } });
    assert.equal(migrated.settingsRev, 16);
    assert.equal(migrated.v, 16);
    assert.equal(migrated.results[0].id, 'keep-me', 'class results survive the upgrade');
    assert.equal(migrated.settings.writeFixed, 5);
    assert.equal(migrated.settings.repeats, 2);
    assert.equal(migrated.settings.sentence, false);
    a.q.DB.data.session.title = 'v16 write';
    a.q.DB.saveNow();
    assert.ok(stored(a), 'the v16 key holds the data');
    assert.equal(stored(a).settingsRev, 16);
  } finally { a.close(); }
});

/* --------------------------------------------------------------- product */

test('bilingual navigation, practice, dictionary, community and Admin PIN 7898 work', function () {
  const a = boot();
  try {
    const doc = a.w.document, q = a.q;
    assert.equal(PIN, '7898');
    doc.getElementById('btnLang').click();
    assert.equal(q.DB.data.settings.lang, 'si');
    assert.equal(doc.documentElement.getAttribute('lang'), 'si');
    doc.getElementById('btnLang').click();
    assert.equal(q.DB.data.settings.lang, 'en');

    doc.getElementById('btnGuideTop').click();
    assert.ok(doc.querySelector('#sheets .sheet'));
    assert.ok(doc.querySelector('#sheets').textContent.indexOf(CREDIT) >= 0);
    q.UI.closeSheet();

    q.UI.setTab('practice');
    assert.ok(doc.querySelector('#pracStage b'));
    doc.querySelector('#pracMode [data-p="quiz"]').click();
    assert.ok(doc.querySelectorAll('#pracStage .btn').length >= 4);
    doc.querySelector('#pracMode [data-p="audio"]').click();
    assert.equal(doc.querySelectorAll('#pracStage .listrow').length, 30);

    q.UI.setTab('dict');
    const search = doc.getElementById('dictSearch');
    search.value = 'tu'; fire(a, search, 'input'); a.clock.tick(300);
    assert.ok(doc.getElementById('dictList').textContent.indexOf('tunnel') >= 0);

    q.UI.setTab('comm');
    assert.ok(doc.getElementById('btnCompose'));
    assert.ok(doc.getElementById('btnMsg'));

    doc.getElementById('btnAdmin').click();
    for (const digit of PIN) doc.querySelector('#pinPad [data-k="' + digit + '"]').click();
    assert.equal(q.Admin.unlocked, true);
    assert.ok(doc.getElementById('adminHost'));
  } finally { a.close(); }
});

test('full credits remain in the hero, Welcome Guide and Settings About', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    assert.ok(doc.querySelector('.hero-credit').textContent.indexOf(CREDIT) >= 0);
    assert.ok(doc.getElementById('homeCredits').textContent.indexOf(CREDIT) >= 0);
    a.q.UI.setTab('set');
    assert.ok(doc.getElementById('setBody').textContent.indexOf(CREDIT) >= 0);
    a.q.UI.openWelcomeGuide();
    assert.ok(doc.querySelector('#sheets').textContent.indexOf(CREDIT) >= 0);
    a.q.UI.setLang('si');
    assert.ok(a.q.T('creditFull').indexOf('Hansana') >= 0);
    assert.match(a.q.T('creditFull'), /[\u0d80-\u0dff]/);
  } finally { a.close(); }
});

(async function main() {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok - ' + item.name);
    } catch (error) {
      failed++;
      console.error('not ok - ' + item.name);
      console.error(String(error && error.stack || error));
    }
  }
  console.log(failed ? failed + ' failed, ' + (tests.length - failed) + ' passed' : 'all ' + tests.length + ' v16 upgrade checks passed');
  process.exitCode = failed ? 1 : 0;
})();
