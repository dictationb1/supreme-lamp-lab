/* Smart Dictation Player 2.6.0 (schema 18) release verification.
   Regenerated from scratch with fs.writeFileSync for this release: the
   zero-keyboard-suggestion typing shield, the animated tick mark, the streak
   breakdown and false-answer correction flow, the 1-tap cross-mark exits and
   every v16/v17 visual upgrade (swan badge, see-through title, Settings mixer,
   sliding capsules, 60 FPS engine). */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { harness, html } = require('./app-harness.cjs');

const root = path.resolve(__dirname, '..');
const json = (name) => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));
const version = json('version.json');
const config = json('config.json');
const session = json('session.json');

const TITLE = 'Session 7 - Travel & Transport';
const LIST_ID = 'list_session_7_travel';
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
function fire(a, el, type) {
  el.dispatchEvent(new a.w.Event(type, { bubbles: true, cancelable: true }));
}
function click(a, el) {
  el.dispatchEvent(new a.w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function enter(a, el) {
  el.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}
function has(token, label) { assert.ok(html.indexOf(token) >= 0, label || token); }
function lacks(token, label) { assert.equal(html.indexOf(token), -1, label || token); }
function rule(selector) {
  const at = html.indexOf(selector + ' {');
  assert.ok(at >= 0, 'CSS rule exists: ' + selector);
  const end = html.indexOf('}', at);
  return html.slice(at, end + 1);
}
function homeMarkup() {
  const start = html.indexOf('<section class="screen" id="screen-home"');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}
function appScript() {
  const found = html.match(/<script>([\s\S]*?)<\/script>/g);
  return found[found.length - 1].replace(/^<script>/, '').replace(/<\/script>$/, '');
}
function typeBoot(a) {
  a.q.DB.data.settings.mode = 'type';
  a.q.Eng.start({});
  a.clock.tick(50);
  return a.w.document;
}
function startPlaying(a) {
  const doc = typeBoot(a);
  const go = doc.querySelector('#sheets .sheet .btn.primary');
  assert.ok(go, 'the ready sheet has the primary start button');
  click(a, go);
  a.clock.tick(4000);
  return doc;
}

/* ------------------------------------------------------- release integrity */

test('single-file budget, strict ES5 and zero external assets', function () {
  assert.ok(Buffer.byteLength(html) < 450000, 'under the 450,000-byte gate');
  assert.ok(Buffer.byteLength(html) < 442000, 'under the 442,000-byte target');
  const script = appScript();
  acorn.parse(script, { ecmaVersion: 5 });
  assert.equal(/<link\b/i.test(html), false, 'no <link> tags at all');
  assert.equal(/@import/i.test(html), false, 'no CSS imports');
  assert.equal(/<script[^>]+src=/i.test(html), false, 'no external scripts');
  assert.equal(script.indexOf('=>'), -1, 'no arrow functions');
  assert.equal(script.indexOf(String.fromCharCode(96)), -1, 'no template literals');
  assert.equal(/\basync\s+function/.test(script), false, 'no async functions');
  assert.equal(/\bawait\s/.test(script), false, 'no await');
});

test('v18 / 2.6.0 metadata is consistent across the app and data files', function () {
  for (const data of [version, config, session]) assert.ok(Number(data.ver) >= 18, 'ver >= 18');
  assert.equal(version.appVersion, '2.6.0');
  assert.equal(version.version, '2.6.0');
  assert.equal(version.settingsRev, 18);
  assert.equal(version.session, '7');
  assert.equal(version.title, TITLE);
  assert.equal(config.appVersion, '2.6.0');
  assert.equal(config.settingsRev, 18);
  assert.equal(config.listId, LIST_ID);
  assert.equal(config.storageKey, 'sdp.v18_nosuggest');
  assert.equal(session.appVersion, '2.6.0');
  assert.equal(session.ver, 18);
  has('var APP_VERSION="2.6.0"');
  has('key:"sdp.v18_nosuggest"');
  const a = boot();
  try {
    assert.equal(a.q.CONFIG.key, 'sdp.v18_nosuggest');
    assert.equal(a.q.CONFIG.schema, 18);
    assert.equal(a.q.CONFIG.settingsRev, 18);
    assert.equal(a.w.SDP.version, '2.6.0');
    assert.equal(a.w.document.body.getAttribute('data-perf') !== null, true);
  } finally { a.close(); }
});

test('Session 7 keeps all 30 Travel & Transport words, 5s timer, 2 repeats and Amy', function () {
  assert.deepEqual(session.lists[0].words.map((w) => w.w), WORDS);
  assert.equal(session.session.title, TITLE);
  assert.equal(session.session.no, '7');
  assert.equal(session.session.day, 'Thursday');
  assert.equal(session.lists[0].id, LIST_ID);
  assert.equal(session.lists[0].published, true);
  for (const w of session.lists[0].words) {
    assert.ok(w.m && w.m.length > 10, w.w + ' meaning');
    assert.ok(w.s && w.s.length > 10, w.w + ' sentence');
    assert.match(w.audio || '', /^https:\/\/.+\.mp3$/i);
  }
  assert.equal(config.defaults.writeFixed, 5);
  assert.equal(config.defaults.repeats, 2);
  assert.match(config.tts.primary, /Amy/);
  assert.match(config.tts.primary, /en-GB/);
  const a = boot();
  try {
    const list = a.q.Lib.current();
    assert.equal(list.words.length, 30);
    assert.equal(list.words[0].w, 'guidebook');
    assert.equal(list.words[29].w, 'windscreen');
    assert.equal(a.q.DB.data.settings.writeFixed, 5);
    assert.equal(a.q.DB.data.settings.repeats, 2);
    assert.equal(a.q.DB.data.settings.voiceName === '' || /female|amy/i.test(a.q.DB.data.settings.voiceName), true);
  } finally { a.close(); }
});

/* ------------------------------------------------------- smart answer match */

test('getTargetVariants and isAnswerMatch accept every spelling of tyre/tire', function () {
  has('Eng.getTargetVariants=function');
  has('Eng.isAnswerMatch=function');
  has('Eng.isPrefixMatch=function');
  const a = boot();
  try {
    const Eng = a.q.Eng;
    const variants = (wObj) => Array.prototype.slice.call(Eng.getTargetVariants(wObj));
    assert.deepEqual(variants({ w: 'tyre/tire' }), ['tyre/tire', 'tyre', 'tire']);
    assert.deepEqual(variants({ w: ' Tourist   Information Centre ' }), ['tourist information centre']);
    assert.equal(Eng.isAnswerMatch('tyre', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isAnswerMatch('tire', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isAnswerMatch('tyre/tire', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isAnswerMatch('  TIRE ', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isAnswerMatch('tyres', { w: 'tyre/tire' }), false);
    assert.equal(Eng.isAnswerMatch('', { w: 'tyre/tire' }), false);
    assert.equal(Eng.isPrefixMatch('tyr', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isPrefixMatch('tir', { w: 'tyre/tire' }), true);
    assert.equal(Eng.isPrefixMatch('xx', { w: 'tyre/tire' }), false);
    assert.equal(Eng.isPrefixMatch('', { w: 'tyre/tire' }), true);
  } finally { a.close(); }
});

/* ------------------------------------------------ zero keyboard suggestions */

test('layer A: the built-in QWERTY keyboard ships inside the answer deck', function () {
  has('Eng.buildVkb=function');
  has('vkb.id="ansVkb"');
  has('id="ansVkb"');
  has('qwertyuiop');
  has('asdfghjkl');
  has('zxcvbnm');
  has('vkb-key vkb-space');
  has('vkb-key vkb-check');
  has('btnVkbToggle');
  has('Eng.isTouch=function');
  has('inp.setAttribute("inputmode","none")');
  assert.match(rule('.ans-vkb'), /display:flex/);
  assert.match(rule('.ans-vkb'), /border-radius:18px/);
  assert.match(rule('.ans-vkb.is-hidden'), /display:none/);
  assert.match(rule('.vkb-key'), /min-height:38px/);
  assert.match(rule('.vkb-key.vkb-space'), /flex:4 1 0/);
  assert.match(rule('.vkb-key.vkb-check'), /linear-gradient/);
  const a = boot();
  try {
    const doc = typeBoot(a);
    const vkb = doc.querySelector('.ans-deck.glass #ansVkb');
    assert.ok(vkb, 'the keyboard lives in the answer deck');
    assert.equal(vkb.getAttribute('role'), 'group');
    const rows = vkb.querySelectorAll('.vkb-row');
    assert.equal(rows.length, 4, 'four key rows');
    assert.equal(rows[0].querySelectorAll('.vkb-key').length, 10, 'q..p');
    assert.equal(rows[1].querySelectorAll('.vkb-key').length, 9, 'a..l');
    assert.equal(rows[2].querySelectorAll('.vkb-key').length, 8, 'z..m plus backspace');
    assert.equal(rows[3].textContent, '-/Space\u2713 Check');
    assert.equal(vkb.querySelectorAll('.vkb-key').length, 31);
    const inp = doc.getElementById('ansInput');
    const q = rows[0].querySelector('.vkb-key');
    click(a, q);
    click(a, rows[0].querySelectorAll('.vkb-key')[1]);
    assert.equal(inp.value, 'qw');
    assert.equal(a.q.Eng.answers[0], 'qw', 'keyboard taps reach the saved answer');
    click(a, rows[2].querySelector('.vkb-wide'));
    assert.equal(inp.value, 'q');
    click(a, rows[3].querySelector('.vkb-space'));
    assert.equal(inp.value, 'q ');
    const toggle = doc.getElementById('btnVkbToggle');
    click(a, toggle);
    assert.ok(vkb.classList.contains('is-hidden'), 'the keyboard can be hidden');
    click(a, toggle);
    assert.equal(vkb.classList.contains('is-hidden'), false, 'and shown again');
  } finally { a.close(); }
});

test('layer B: every IME suggestion, paste and drop is suppressed on #ansInput', function () {
  has('one-time-code');
  has('insertReplacementText');
  has('insertFromPaste');
  has('insertFromDrop');
  has('data-gramm');
  has('data-gramm_editor');
  has('data-enable-grammarly');
  has('data-lpignore');
  has('data-form-type');
  has('aria-autocomplete');
  has('-webkit-search-cancel-button');
  const a = boot();
  try {
    const doc = typeBoot(a);
    const inp = doc.getElementById('ansInput');
    assert.equal(inp.type, 'search');
    assert.equal(inp.getAttribute('autocomplete'), 'one-time-code');
    assert.equal(inp.getAttribute('autocorrect'), 'off');
    assert.equal(inp.getAttribute('autocapitalize'), 'none');
    assert.equal(inp.getAttribute('spellcheck'), 'false');
    assert.equal(inp.getAttribute('aria-autocomplete'), 'none');
    assert.equal(inp.getAttribute('data-gramm'), 'false');
    assert.equal(inp.getAttribute('data-gramm_editor'), 'false');
    assert.equal(inp.getAttribute('data-enable-grammarly'), 'false');
    assert.equal(inp.getAttribute('data-lpignore'), 'true');
    assert.equal(inp.getAttribute('data-form-type'), 'other');
    assert.match(inp.name, /^sdp_nosuggest_\d{1,12}$/);
    assert.equal(inp.hasAttribute('inputmode'), false, 'desktop keeps the hardware keyboard');
    const blocked = (type, data) => {
      const ev = new a.w.Event('beforeinput', { bubbles: true, cancelable: true });
      ev.inputType = type;
      if (data !== undefined) ev.data = data;
      inp.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    assert.equal(blocked('insertReplacementText', 'letter'), true, 'suggestion chip rejected');
    assert.equal(blocked('insertFromPaste', 'pasted'), true, 'paste rejected');
    assert.equal(blocked('insertFromDrop'), true, 'drop rejected');
    assert.equal(blocked('insertCompositionText', 'two'), true, 'multi-character commit rejected');
    assert.equal(blocked('insertText', 'g'), false, 'normal typing is untouched');
    for (const type of ['paste', 'drop', 'contextmenu']) {
      const ev = new a.w.Event(type, { bubbles: true, cancelable: true });
      inp.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true, type + ' is prevented');
    }
    assert.match(doc.getElementById('ansFeedback').textContent, /blocked/);
  } finally { a.close(); }
});

test('touch devices get inputmode=none so no system keyboard can appear', function () {
  const a = harness();
  try {
    a.w.matchMedia = function () { return { matches: true, addEventListener() {} }; };
    const doc = typeBoot(a);
    assert.equal(doc.getElementById('ansInput').getAttribute('inputmode'), 'none');
    assert.equal(a.q.Eng.isTouch(), true);
  } finally { a.close(); }
});

/* ------------------------------------------------------------- tick + cross */

test('Type mode builds the Liquid Glass answer deck, tick, cross and score pill', function () {
  has('Eng.onTypeCorrect=function');
  has('Eng.onTypeWrong=function');
  has('UI.playTickChime();');
  has('playWrongTone:function');
  has('tick.id="ansTick"');
  has('cross.id="ansWrong"');
  has('hero.id="plTickHero"');
  has('badHero.id="plWrongHero"');
  has('slots.id="ansSlots"');
  has('pill.id="plLiveScore"');
  has('checkBtn.id="ansCheckBtn"');
  has('cmp.id="ansCompare"');
  has('slot-done');
  assert.match(rule('.ans-input-wrap'), /border-radius:999px/);
  assert.match(rule('.ans-input-wrap.is-correct'), /inset 0 0 0 2px #39d4b8/);
  assert.match(rule('.ans-input-wrap.is-wrong'), /ansShake/);
  assert.match(rule('.ans-tick'), /opacity:0/);
  assert.match(rule('.ans-tick.is-correct'), /opacity:1/);
  assert.match(rule('.ans-cross'), /opacity:0/);
  assert.match(rule('.ans-cross.is-wrong'), /opacity:1/);
  assert.match(rule('.ans-compare'), /display:none/);
  assert.match(rule('.ans-compare.is-open'), /display:flex/);
  assert.match(rule('.wordcard.is-wrong'), /rgba\(255,111,97,.85\)/);
  assert.match(rule('.ans-score-pill .sc-str.streak-broken'), /animation:streakBreak 1\.4s/);
  has('@keyframes streakBreak');
  const a = boot();
  try {
    const doc = typeBoot(a);
    const deck = doc.querySelector('.ans-deck.glass');
    assert.ok(deck);
    const pill = doc.getElementById('plLiveScore');
    assert.ok(pill.classList.contains('ans-score-pill'));
    assert.equal(doc.getElementById('plCorrectCount').textContent, '\u2713 0 Correct');
    assert.equal(doc.getElementById('plWrongCount').textContent, '\u2717 0 Wrong');
    assert.equal(doc.getElementById('plStreakCount').textContent, '\uD83D\uDD25 0 Streak');
    const slots = doc.getElementById('ansSlots');
    assert.equal(slots.querySelectorAll('.slot').length, 9, 'guidebook has nine slots');
    assert.equal(slots.querySelector('.ans-hint-chip').textContent, '9 letters');
    const wrap = doc.getElementById('ansWrap');
    assert.ok(wrap.contains(doc.getElementById('ansInput')));
    assert.ok(wrap.contains(doc.getElementById('ansTick')));
    assert.ok(wrap.contains(doc.getElementById('ansWrong')));
    assert.ok(wrap.contains(doc.getElementById('ansCheckBtn')));
    assert.equal(doc.getElementById('ansCheckBtn').textContent, 'Check \u2713');
    assert.equal(wrap.querySelector('svg .tick-check').getAttribute('d'), 'M10.5 18.5L15.8 23.8L25.8 13.2');
    assert.equal(doc.querySelectorAll('#ansWrong .cross-line').length, 2);
    const hero = doc.querySelector('.wordcard #plTickHero');
    assert.ok(hero);
    assert.match(hero.textContent, /Correct!/);
    const bad = doc.querySelector('.wordcard #plWrongHero');
    assert.ok(bad);
    assert.match(bad.textContent, /Incorrect/);
    assert.equal(doc.querySelectorAll('#plWrongHero .hero-cross-line').length, 2);
  } finally { a.close(); }
});

test('a correct answer pops the animated tick, chimes, scores and auto-advances', function () {
  const a = boot();
  try {
    let started = 0;
    a.w.AudioContext = function () {
      this.currentTime = 0;
      this.destination = {};
      this.resume = function () {};
      this.createOscillator = function () {
        return { type: '', frequency: { value: 0 }, connect() {}, start() { started++; }, stop() {} };
      };
      this.createGain = function () {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
      };
    };
    const doc = typeBoot(a);
    const inp = doc.getElementById('ansInput');
    inp.value = 'guidebook';
    fire(a, inp, 'input');
    assert.equal(a.q.Eng.wordSolved, true);
    assert.ok(doc.getElementById('ansWrap').classList.contains('is-correct'));
    assert.ok(doc.querySelector('.wordcard').classList.contains('is-correct'));
    assert.ok(doc.getElementById('ansTick').classList.contains('is-correct'));
    assert.ok(doc.getElementById('plTickHero').classList.contains('is-correct'));
    const done = doc.querySelectorAll('#ansSlots .slot-done');
    assert.equal(done.length, 9, 'every slot lights up mint');
    assert.equal(done[0].textContent, 'g');
    assert.equal(doc.getElementById('plWord').textContent, 'guidebook');
    assert.match(doc.getElementById('plHint').textContent, /book that gives information/);
    assert.equal(doc.getElementById('plCorrectCount').textContent, '\u2713 1 Correct');
    assert.equal(doc.getElementById('plStreakCount').textContent, '\uD83D\uDD25 1 Streak');
    assert.equal(a.q.Eng.bestStreak, 1);
    assert.equal(doc.getElementById('ansCheckBtn').textContent, 'Next \u2192');
    assert.equal(doc.getElementById('ansFeedback').textContent, '\u2713 Correct! Spot on!');
    assert.ok(started > 0, 'the crystal chime played');
    assert.equal(a.q.Eng.answers[0], 'guidebook');
    a.clock.tick(1100);
    assert.equal(a.q.Eng.idx, 1, 'auto-advance after 1050 ms');
  } finally { a.close(); }
});

test('a wrong answer breaks the streak, shows the cross and teaches the spelling', function () {
  has('streak-broken');
  has('liveStreakCount');
  has('Lib.addMistake(w.w)');
  const a = boot();
  try {
    const spoken = [];
    a.q.Speech.say = function (list) { spoken.push(list.join(' ')); };
    const doc = startPlaying(a);
    const inp = doc.getElementById('ansInput');
    // word 1 right, so there is a streak to break
    inp.value = 'guidebook';
    fire(a, inp, 'input');
    a.clock.tick(1100);
    assert.equal(a.q.Eng.liveStreakCount, 1);
    // word 2 wrong
    inp.value = 'handelbars';
    fire(a, inp, 'input');
    assert.equal(doc.getElementById('ansFeedback').textContent, '\u2717 Letter mismatch \u2014 check your spelling');
    enter(a, inp);
    assert.equal(a.q.Eng.wordWrong, true);
    const streak = doc.getElementById('plStreakCount');
    assert.equal(streak.textContent, '\uD83D\uDC94 Streak Broken! (0)');
    assert.ok(streak.classList.contains('streak-broken'));
    assert.equal(a.q.Eng.liveStreakCount, 0);
    assert.equal(doc.getElementById('plWrongCount').textContent, '\u2717 1 Wrong');
    assert.equal(a.q.Eng.liveWrongCount, 1);
    assert.ok(doc.getElementById('ansWrap').classList.contains('is-wrong'));
    assert.ok(doc.querySelector('.wordcard').classList.contains('is-wrong'));
    assert.ok(doc.getElementById('ansWrong').classList.contains('is-wrong'));
    assert.ok(doc.getElementById('plWrongHero').classList.contains('is-wrong'));
    assert.equal(doc.getElementById('ansCheckBtn').textContent, 'Got it \u2192 Next');
    assert.equal(doc.getElementById('plWord').textContent, 'handlebars');
    assert.match(doc.getElementById('plHint').textContent, /bicycle or motorcycle/);
    const cmp = doc.getElementById('ansCompare');
    assert.ok(cmp.classList.contains('is-open'));
    assert.match(cmp.textContent, /Your answer:/);
    assert.ok(cmp.querySelectorAll('.cmp-bad').length > 0, 'wrong letters are struck through');
    assert.match(cmp.textContent, /Correct UK spelling: \u2713/);
    assert.match(cmp.textContent, /handlebars/);
    assert.ok(cmp.querySelectorAll('.cmp-bad').length + cmp.querySelectorAll('.cmp-miss').length > 0, 'letters are highlighted');
    assert.ok(cmp.querySelector('#ansGotIt'), 'the Got it button is offered');
    assert.ok(a.q.DB.data.mistakes.some((m) => m.w === 'handlebars'), 'Lib.addMistake recorded the word');
    assert.equal(a.q.Eng.missedWords.length, 1);
    assert.ok(spoken.indexOf('handlebars') >= 0, 'the correct word is spoken once');
    a.clock.tick(1400);
    assert.equal(doc.getElementById('plStreakCount').textContent, '\uD83D\uDD25 0 Streak', 'the pill settles back');
    assert.equal(doc.getElementById('plStreakCount').className, 'sc-str');
    a.clock.tick(800);
    assert.equal(a.q.Eng.idx, 2, 'held for 2100 ms before moving on');
    assert.equal(a.q.Eng.wordWrong, false, 'the next word starts clean');
  } finally { a.close(); }
});

test('a blank or time-up answer shows the correction card and the blank marker', function () {
  const a = boot();
  try {
    a.q.Speech.say = function () {};
    const doc = startPlaying(a);
    const inp = doc.getElementById('ansInput');
    inp.value = '';
    click(a, doc.getElementById('ansCheckBtn'));
    assert.equal(a.q.Eng.wordWrong, true);
    assert.match(doc.getElementById('ansCompare').textContent, /\(blank\)/);
    assert.match(doc.getElementById('ansFeedback').textContent, /Not quite/);
    click(a, doc.getElementById('ansGotIt'));
    a.clock.tick(50);
    assert.equal(a.q.Eng.idx, 1, 'Got it moves on at once');
  } finally { a.close(); }
});

test('the writing countdown ends a wrong answer through the correction flow', function () {
  has('self.onTypeWrong("timeout")');
  const a = boot();
  try {
    a.q.Speech.supported = true;
    a.q.Speech.textOnly = false;
    a.q.Speech.say = function (list, opts, done) { if (done) done({ ok: true }); };
    const doc = startPlaying(a);
    assert.ok(a.q.Eng.countdown, 'the writing countdown runs in type mode');
    a.clock.tick(7000);
    assert.equal(a.q.Eng.liveWrongCount, 1, 'the timeout counted as wrong');
    assert.ok(a.q.DB.data.mistakes.some((m) => m.w === 'guidebook'));
    a.clock.tick(2300);
    assert.equal(a.q.Eng.idx, 1, 'and then advanced');
    assert.ok(doc.getElementById('ansInput'));
  } finally { a.close(); }
});

test('Sinhala students get the Sinhala celebration', function () {
  const a = boot();
  try {
    const doc = typeBoot(a);
    a.q.DB.data.settings.lang = 'si';
    const inp = doc.getElementById('ansInput');
    inp.value = 'guidebook';
    fire(a, inp, 'input');
    assert.equal(a.q.Eng.wordSolved, true);
    assert.equal(doc.getElementById('ansFeedback').textContent, '\u2713 \u0db1\u0dd2\u0dc0\u0dd0\u0dbb\u0daf\u0dd2\u0dba\u0dd2!');
  } finally { a.close(); }
});

/* ------------------------------------------------------- 1-tap cross exits */

test('the ready sheet carries a cross mark and a Not ready exit', function () {
  has('close-x-btn');
  has('cancelReadyAndExit');
  has('btnReadyClose');
  has('btnNotReady');
  has('btnPlayerClose');
  assert.match(rule('.close-x-btn'), /width:40px/);
  assert.match(rule('.close-x-btn'), /height:40px/);
  assert.match(rule('.close-x-btn'), /border-radius:50%/);
  assert.match(rule('.close-x-btn'), /display:inline-grid/);
  assert.match(rule('.close-x-btn'), /place-items:center/);
  assert.match(rule('.close-x-btn'), /font:700 18px\/1 "Manrope",sans-serif/);
  assert.match(rule('.close-x-btn'), /rgba\(255, 111, 97, \.18\)/);
  assert.match(rule('.close-x-btn'), /transition:transform \.32s cubic-bezier\(\.2,\.9,\.25,1\.35\), background-color \.25s ease/);
  assert.match(rule('.close-x-btn:hover'), /transform:scale\(1\.08\)/);
  assert.match(rule('.close-x-btn:active'), /transform:scale\(\.92\)/);
  const a = boot();
  try {
    const doc = typeBoot(a);
    const x = doc.getElementById('btnReadyClose');
    assert.ok(x, 'the close button exists');
    assert.ok(x.classList.contains('close-x-btn'));
    assert.equal(x.getAttribute('aria-label'), 'Close and exit dictation');
    assert.ok(x.parentNode.classList.contains('shead'), 'the x sits in the sheet header');
    const nr = doc.getElementById('btnNotReady');
    assert.ok(nr);
    assert.match(nr.textContent, /\u2715 Not ready \u00b7 Exit/);
    assert.ok(doc.querySelector('#sheets .sheet .sfoot').contains(nr));
  } finally { a.close(); }
});

test('one tap on the ready cross mark exits cleanly and drops the snapshot', function () {
  const a = boot();
  try {
    const doc = typeBoot(a);
    a.clock.tick(600);
    assert.ok(a.q.DB.data.snapshot, 'a resume snapshot exists while ready');
    click(a, doc.getElementById('btnReadyClose'));
    a.clock.tick(60);
    assert.equal(doc.querySelector('#sheets .sheet'), null, 'the ready sheet is gone');
    assert.equal(doc.querySelector('#layers .layer'), null, 'the player layer is gone too');
    assert.equal(a.q.Eng.layer, null);
    assert.equal(a.q.Eng.st, 'idle');
    assert.equal(a.q.DB.data.snapshot, undefined, 'the uncommitted snapshot was deleted');
    assert.equal(doc.querySelector('#screen-home').classList.contains('hidden'), false, 'Home is shown');
  } finally { a.close(); }
});

test('Not ready, the scrim and Escape all leave the session in one step', function () {
  const a = boot();
  try {
    let doc = typeBoot(a);
    click(a, doc.getElementById('btnNotReady'));
    a.clock.tick(60);
    assert.equal(a.q.Eng.st, 'idle');
    assert.equal(doc.querySelector('#layout .layer') || doc.querySelector('#layers .layer'), null);

    doc = typeBoot(a);
    click(a, doc.querySelector('#sheets .scrim'));
    a.clock.tick(60);
    assert.equal(a.q.Eng.st, 'idle');
    assert.equal(doc.querySelector('#layers .layer'), null);

    doc = typeBoot(a);
    doc.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    a.clock.tick(60);
    assert.equal(a.q.Eng.st, 'idle');
    assert.equal(doc.querySelector('#sheets .sheet'), null);
    assert.equal(doc.querySelector('#layers .layer'), null);
  } finally { a.close(); }
});

test('the player topbar cross mark stops the session and returns Home', function () {
  const a = boot();
  try {
    const doc = startPlaying(a);
    const x = doc.getElementById('btnPlayerClose');
    assert.ok(x, 'the player close button exists');
    assert.equal(x.getAttribute('title'), 'Exit dictation');
    assert.equal(x.getAttribute('aria-label'), 'Exit dictation');
    assert.ok(doc.getElementById('layers').contains(x), 'it lives in the player header');
    assert.ok(doc.querySelector('#layers .lhead .close-x-btn'));
    click(a, x);
    a.clock.tick(60);
    assert.equal(a.q.Eng.st, 'idle');
    assert.equal(a.q.Eng.layer, null);
    assert.equal(doc.querySelector('#layers .layer'), null);
    assert.equal(doc.querySelector('#screen-home').classList.contains('hidden'), false);
  } finally { a.close(); }
});

/* ------------------------------------------------------------- v16 visuals */

test('the animated swan replaces the water drop inside #credit', function () {
  has('c-swan');
  has('swanFloat');
  has('swanWing');
  has('swanRipple');
  lacks('c-drop', 'the water drop is gone');
  assert.match(rule('.c-swan'), /width:32px/);
  has('animation:swanFloat');
  has('@keyframes swanFloat');
  has('@keyframes swanWing');
  has('@keyframes swanRipple');
  const a = boot();
  try {
    const credit = a.w.document.getElementById('credit');
    assert.ok(credit.classList.contains('credit'));
    const swan = credit.querySelector('.c-swan');
    assert.ok(swan, 'the swan badge is rendered');
    assert.match(credit.querySelector('.c-text small').textContent, /credits goes to/i);
    assert.equal(credit.querySelector('.c-text b').textContent, 'Hansana');
    has('body[data-perf="lite"] .c-swan .swan-group {animation:swanFloat');
    has('body[data-perf="lite"] .c-swan .swan-wing {animation:swanWing');
    has('body[data-perf="lite"] .c-swan .swan-ripple {animation:swanRipple');
    a.q.UI.setPerf('lite');
    assert.ok(a.w.document.getElementById('credit').querySelector('.c-swan'));
    a.q.UI.setPerf('full');
    assert.ok(a.w.document.getElementById('credit').querySelector('.c-swan'));
  } finally { a.close(); }
});

test('#homeTitle wears the see-through Liquid Glass font with no hollow span', function () {
  has('id="homeTitle"');
  has('liquid-glass-text');
  assert.equal(html.indexOf('class="hollow"'), -1, 'the hollow span is gone');
  assert.equal(html.indexOf('.hollow {'), -1, 'the hollow rule is gone');
  const title = rule('#homeTitle,.liquid-glass-text');
  assert.match(title, /background:linear-gradient\(135deg,rgba\(255,255,255,\.28\) 0%,rgba\(83,199,240,\.18\) 45%/);
  assert.match(title, /-webkit-background-clip:text/);
  assert.match(title, /background-clip:text/);
  assert.match(title, /color:transparent !important/);
  assert.match(title, /-webkit-text-stroke:1\.75px rgba\(241,244,255,\.92\)/);
  const a = boot();
  try {
    const doc = a.w.document;
    const h1 = doc.getElementById('homeTitle');
    assert.ok(h1.classList.contains('liquid-glass-text'));
    assert.equal(h1.textContent, TITLE);
    assert.ok(doc.querySelector('.anatomy-stage .stripes'));
    assert.ok(doc.querySelector('.anatomy-stage .disc'));
  } finally { a.close(); }
});

test('#lgStage lives in Settings and never in Home', function () {
  assert.equal(/<div[^>]+id="lgStage"/.test(html), false, 'the stage is built by Screens.settings(), not static markup');
  assert.equal(homeMarkup().indexOf('lgStage'), -1, 'Home markup has no stage');
  has('host.appendChild(UI.liquidStage())');
  has('liquidStage:function');
  has('UI.bindLiquidControls(host);');
  const a = boot();
  try {
    const doc = a.w.document;
    assert.equal(doc.querySelector('#screen-home #lgStage'), null, 'Home has no stage after boot');
    a.q.Screens.home();
    assert.equal(doc.querySelector('#screen-home #lgStage'), null, 'Home stays clean after a re-render');
    a.q.UI.setTab('set');
    const set = doc.getElementById('screen-set');
    const stage = set.querySelector('#lgStage');
    assert.ok(stage, 'Settings hosts the stage');
    assert.equal(set.querySelector('#setBody').firstElementChild, stage, 'the stage is first in Settings');
    assert.ok(stage.classList.contains('stage'));
    assert.equal(stage.querySelectorAll('.bubble').length, 4);
    assert.ok(stage.querySelector('#orb'));
    const mixer = stage.querySelector('#materialMixer.glass.panel');
    assert.ok(mixer);
    assert.match(mixer.textContent, /Material Mixer/);
    assert.ok(stage.querySelector('#sBlur') && stage.querySelector('#sSat') && stage.querySelector('#sBrt'));
    assert.equal(stage.querySelectorAll('#segTint button').length, 3, 'Clear / Frost / Smoke');
    assert.equal(stage.querySelectorAll('#segPerf button').length, 3, 'Auto / Lite 60FPS / Full');
    assert.equal(doc.querySelectorAll('#lgStage').length, 1, 'exactly one stage in the document');
  } finally { a.close(); }
});

test('the dock capsule and every seg glide with one translate3d layer', function () {
  const capsule = rule('#tabInd,.tab-ind');
  assert.match(capsule, /transform \.48s cubic-bezier\(\.2,\.9,\.25,1\.35\)/);
  assert.match(capsule, /!important/);
  assert.equal((html.match(/id="tabInd"/g) || []).length, 1);
  const thumb = rule('.seg .thumb,.seg-tint .seg-ind');
  assert.match(thumb, /transform \.48s cubic-bezier\(\.2,\.9,\.25,1\.35\)/);
  has('segSync:function');
  has('seg-tint .seg-ind');
  const a = boot();
  try {
    const doc = a.w.document, ind = doc.getElementById('tabInd');
    a.q.UI.setTab('comm');
    assert.equal(ind.style.transform, 'translate3d(300%, 0, 0)');
    a.q.UI.setTab('set');
    assert.equal(ind.style.transform, 'translate3d(400%, 0, 0)');
    a.q.UI.setTab('home');
    assert.equal(ind.style.transform, 'translate3d(0%, 0, 0)');
    const seg = doc.getElementById('segMode');
    assert.equal(seg.querySelectorAll('button').length, 2);
    seg.querySelector('[data-mode="type"]').click();
    assert.equal(doc.getElementById('segMode'), seg, 'the seg is not recreated');
    assert.match(seg.querySelector('.thumb').style.transform, /^translate3d\(/);
    assert.equal(a.q.DB.data.settings.mode, 'type');
  } finally { a.close(); }
});

test('nested glass is flattened, chrome is promoted and blobs are pre-blurred', function () {
  const flat = rule('.glass .glass,.tile .glass,.glass .tile');
  assert.match(flat, /backdrop-filter:none !important/);
  const layers = rule('.topbar.glass,#tabbar.glass,#credit.glass');
  assert.match(layers, /backface-visibility:hidden/);
  assert.match(rule('#grain'), /display:none !important/);
  has('.blob {filter:none !important;}');
  assert.match(rule('.blob'), /radial-gradient\(circle,var\(--blob-color\) 0%,transparent 70%\)/);
  assert.equal(html.indexOf('filter: blur(85px)'), -1, 'no 85px blob blur');
  assert.match(rule('body[data-perf="lite"]'), /--gb:8px/);
  const a = boot();
  try {
    assert.equal(a.w.document.querySelectorAll('#bg .blob').length, 4);
    a.q.UI.setPerf('lite');
    assert.equal(a.w.document.body.getAttribute('data-perf'), 'lite');
    a.q.UI.setPerf('full');
    assert.equal(a.w.document.body.getAttribute('data-perf'), 'full');
  } finally { a.close(); }
});

/* ------------------------------------------------------------- data path */

test('DictAPI answers all 30 words from memory with zero requests', function () {
  const a = boot();
  try {
    let fetches = 0;
    a.w.fetch = function () { fetches++; return Promise.reject(new Error('offline')); };
    assert.equal(a.q.DictAPI, a.q.Dict);
    for (const word of WORDS) {
      let result = null;
      const returned = a.q.DictAPI.lookup(word, (entry) => { result = entry; });
      assert.equal(returned, result, 'embedded lookup is synchronous');
      assert.ok(result && result.embedded, word);
      assert.ok(result.phon.length > 2, word + ' phon');
      assert.ok(result.def.length > 8, word + ' def');
    }
    assert.equal(fetches, 0, 'no network request for Session 7 words');
  } finally { a.close(); }
});

test('the shared #sdpAudio element replays from currentTime 0 on Repeat #2', function () {
  const a = boot();
  try {
    const doc = a.w.document, speech = a.q.Speech;
    assert.equal(doc.querySelectorAll('#sdpAudio').length, 1);
    const audio = doc.getElementById('sdpAudio');
    assert.equal(audio.getAttribute('preload'), 'none');
    const first = speech.streamSources('guidebook');
    assert.match(first[0], /voice=Amy/);
    assert.match(first[1], /tl=en-GB/);
    let srcSets = 0, plays = 0;
    audio.currentTime = 7;
    Object.defineProperty(audio, 'canPlayType', { configurable: true, value: () => 'probably' });
    Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 2 });
    Object.defineProperty(audio, 'src', { configurable: true, get: () => first[0], set: () => { srcSets++; } });
    audio.play = function () { plays++; return Promise.resolve(); };
    audio.pause = function () {};
    speech.playOnce(first[0], 0.88, 6000, function () {});
    assert.equal(srcSets, 0, 'same source is not reassigned');
    assert.equal(plays, 1);
    assert.equal(audio.currentTime, 0, 'Repeat #2 rewinds the buffer');
    speech.playOnce(speech.streamSources('harbour')[1], 0.88, 6000, function () {});
    assert.equal(srcSets, 1, 'a new word loads once');
    has('a.currentTime=0');
  } finally { a.close(); }
});

/* -------------------------------------------------------------- migration */

test('a v17 save moves to the sdp.v18_nosuggest key without losing results', function () {
  has('"sdp.v17_type_tick"');
  const a = boot();
  try {
    const v17 = JSON.parse(JSON.stringify(a.q.DB.data));
    v17.settingsRev = 17;
    v17.ver = 17;
    const lifted = a.q.DB.migrate(v17);
    assert.equal(lifted.settingsRev, 18);
    assert.equal(lifted.v, 18);
    assert.equal(lifted.settings.vkb, true);
    const v16 = JSON.parse(JSON.stringify(a.q.DB.data));
    v16.settingsRev = 16;
    const up = a.q.DB.migrate(v16);
    assert.equal(up.settingsRev, 18);
    assert.equal(a.q.CONFIG.key, 'sdp.v18_nosuggest');
  } finally { a.close(); }
});

/* --------------------------------------------------------------- results */

test('scoreTypeMode scores tyre, tire and tyre/tire all as ok', function () {
  const a = boot();
  try {
    const words = [
      { w: 'tyre/tire', m: 'a rubber ring', s: 'The tyre is new.' },
      { w: 'public transport', m: 'buses and trains', s: 'I use public transport.' },
      { w: 'visa', m: 'a travel document', s: 'My visa is ready.' }
    ];
    const res = a.q.Results.scoreTypeMode(words, [0, 1, 2], ['tire', 'public transport', '']);
    assert.equal(res.rows[0].state, 'ok');
    assert.equal(res.rows[1].state, 'ok');
    assert.equal(res.rows[2].state, 'empty');
    assert.equal(res.correct, 2);
    assert.equal(a.q.Results.scoreTypeMode(words, [0], ['tyre']).rows[0].state, 'ok');
    assert.equal(a.q.Results.scoreTypeMode(words, [0], ['tyre/tire']).rows[0].state, 'ok');
    assert.equal(a.q.Results.scoreTypeMode(words, [0], ['tyres']).rows[0].state, 'wrong');
  } finally { a.close(); }
});

test('the Results review glows a tick on every ok row and offers Practice Missed Words Only', function () {
  has('row-tick');
  has('Practise Missed Words Only');
  const a = boot();
  try {
    const words = [
      { w: 'tyre/tire', m: 'a rubber ring', s: 'The tyre is new.' },
      { w: 'public transport', m: 'buses and trains', s: 'I use public transport.' },
      { w: 'visa', m: 'a travel document', s: 'My visa is ready.' }
    ];
    const res = a.q.Results.scoreTypeMode(words, [0, 1, 2], ['tire', 'public transport', '']);
    const rec = {
      id: 'r18', date: '2026-10-24', ts: Date.now(), sessionNo: '7', sessionDay: 'Thursday',
      sessionDate: '2026-10-22', sessionTitle: TITLE, listName: TITLE, listId: LIST_ID,
      mode: 'type', wordCount: 3, score: 2, percent: 67, durationSec: 90,
      voiceName: 'Amy', ukVoice: true, deviceType: 'desktop', selfScored: false, rows: res.rows
    };
    a.q.Results.open(rec, words, [0, 1, 2]);
    const doc = a.w.document;
    assert.equal(doc.querySelectorAll('.row-tick').length, 2, 'one glowing tick per ok row');
    assert.match(doc.querySelector('#layers').textContent, /Practise Missed Words Only/);
  } finally { a.close(); }
});

test('full credits stay in the Hero, Welcome Guide and Settings About', function () {
  const a = boot();
  try {
    const doc = a.w.document;
    const hero = doc.getElementById('homeCredits').textContent;
    assert.match(hero, /Created by Hansana/);
    assert.match(hero, /Ayya01 \(Lesandu\)/);
    assert.match(hero, /Sumodya Sewmini/);
    assert.match(a.q.T('creditFull'), /Hansana/);
    assert.match(a.q.GUIDE.en.credit, /Hansana/);
    assert.match(a.q.STRINGS_SI.creditFull, /[\u0d80-\u0dff]/);
  } finally { a.close(); }
});

/* ------------------------------------------------------------- run suite */

let failed = 0;
for (const item of tests) {
  try {
    item.fn();
    console.log('# ok - ' + item.name);
  } catch (error) {
    failed++;
    console.log('# not ok - ' + item.name);
    console.log('#   ' + String((error && error.stack) || error).split('\n').join('\n#   '));
  }
}
if (failed) {
  console.log('# ' + failed + ' of ' + tests.length + ' upgrade checks failed');
  process.exit(1);
}
console.log('# all ' + tests.length + ' upgrade checks passed');
