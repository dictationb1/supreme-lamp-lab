# Changelog

## 2.4.0 (v16) — 2026-10-23 (Animated swan badge, glass headline, Settings mixer, zero-lag 60 FPS)

- **The water drop is now an animated Liquid Glass swan.** `#credit` carries a
  custom `.c-swan` SVG (dual white → aqua → mint gradients, bright specular
  wing, amber beak) with three independent, continuously running animations:
  `swanFloat` (3.2 s float/rotate), `swanWing` (2.4 s alternate wing beat) and
  `swanRipple` (2.8 s expanding water ring). The badge still springs in, holds
  for 5.2 s, exits and repeats, pauses on hover/touch, and toasts the full
  credits on click — in **both** Full and Lite modes.
- **The hero headline *is* the Liquid Glass.** The trailing
  `<span class="hollow">Liquid Glass</span>` is gone. `#homeTitle`
  (`.liquid-glass-text`) renders “Session 7 - Travel & Transport” as refractive
  glass: translucent crystal gradient with `background-clip: text`,
  `-webkit-text-stroke: 1.35px` specular rim, cyan/mint prism shimmer and a
  matching opaque light-theme treatment.
- **Material Mixer moved Home → Settings.** `#lgStage` (bubbles, chips,
  draggable warm orb, `Liquid Glass Material Mixer` panel with Blur 4–40 px,
  Saturate 100–260, Bright 90–130, Clear/Frost/Smoke and Auto/Lite 60FPS/Full
  pills) now renders at the top of Settings under “Appearance · Liquid Glass”.
  Home is a clean full-width single column: anatomy stage → three Bento stat
  tiles → Past sessions.
- **Saved material applies on boot.** New `UI.applyGlassSettings()` restores
  `glassBlur`, `glassSat`, `glassBrt` and `glassTint` before any screen paints,
  and is re-applied whenever the mixer binds.
- **Zero-lag 60 FPS pass.** One backdrop shader per surface (nested
  `.glass .glass`, `.card.glass .glass`, `.word-item.glass`,
  `.comm-item.glass`, `#homeStats .statbox-in` use a flat translucent gradient
  with `backdrop-filter: none !important`); `.topbar.glass` and `#tabbar.glass`
  are promoted to their own GPU layer with `translate3d(-50%, 0, 0)`,
  `will-change: transform` and `backface-visibility: hidden`; `#credit.glass`
  gets `will-change: transform, opacity`; blobs are pre-blurred radial
  gradients with `filter: none !important`; `#grain` stays `display: none`.
- **Capsule motion everywhere.** `#tabInd`, `.seg .thumb`, `.seg .seg-ind`,
  `.seg-tint .seg-ind` and the new `.seg-perf .seg-ind` all glide with
  `translate3d` on the `.48s cubic-bezier(.2, .9, .25, 1.35)` spring, in both
  performance modes; clicking a pill never rebuilds the bar it animates.
- **Storage & data.** Schema 16 under `sdp.v16_swan` (v15 data migrates in
  place), Session 7 Travel & Transport unchanged (30 words, 5 s timer,
  ×2 repeats, Amy en-GB), dictionary answers from memory with zero requests and
  the shared `#sdpAudio` element replays its buffered MP3 on repeat.

## 2.3.0 (v15) — 2026-10-23 (Universal Liquid Glass sliding pill transitions)

- **Sliding capsule everywhere.** `#tabbar` now hosts `<span class="tab-ind"
  id="tabInd">` as its first child: a screenshot-exact glowing Liquid Glass
  capsule that glides over Home | Dictionary | Practice | Community | Settings
  via GPU `translate3d(idx * 100%)` with the spring curve
  `cubic-bezier(.2, .9, .25, 1.35)`. The dock is a 560 px grid pill with its
  own deep refraction, and each activated `.screen` morphs in with the new
  `screenMorphIn` keyframes.
- **Every segmented pill shares one recipe.** `.seg` and `.seg-tint` use the
  same `rgba(10, 15, 30, .58)` track and glowing `.thumb` / `.seg-ind`
  capsule (`.48s` spring on `transform` + `width`). `UI.segSync()` slides
  either indicator with `translate3d(offsetLeft - 4)`, the Perf mode, Practice
  switcher and Welcome Guide language pills gained their missing thumbs, and
  the Settings "Writing time" row toggles in place instead of re-rendering —
  a click never destroys the pill it animates. Lite mode never disables pill
  motion (`body[data-perf="lite"] .seg .thumb { transition: none; }` does not
  exist in the source).
- **Buttons breathe.** `.glass`, `.btn`, `.gbtn`, `button.chip` and
  `.topbar .icon-btn` spring on `transform`, `background-color`, `box-shadow`,
  `border-color` and `color`; hover lifts `translate3d(0, -2px) scale(1.02)`
  and press compresses `translate3d(0, 1px) scale(.95)` on buttons, dock tabs
  and seg controls.
- **Clear / Frost / Smoke morph tokens.** Frost is `rgba(220, 238, 255, .22)`,
  Smoke is `rgba(6, 10, 24, .66)` with `--inset-hi: rgba(150, 182, 255, .48)`,
  and `UI.setTint()` slides every `.seg-ind` with `translate3d(i * 100%)`
  across all pills without re-rendering Home or Settings.
- **Floating Hansana badge retained.** The `#credit.credit.glass` pill stays
  above the dock on phones (`bottom: calc(84px + env(safe-area-inset-bottom,
  0px))` at `<= 680px`) with `creditLoop()`, `sheen` and `ping` active in both
  Full and Lite modes.
- **60 FPS on every device.** All indicators animate only through composited
  `transform`/`opacity` (`will-change: transform, width`), blobs stay
  pre-blurred radial gradients, `#grain` stays hidden, the single 1.2 s frame
  probe still downgrades above a 19 ms median, and Auto Lite still covers
  <= 860 px viewports, <= 4 cores / <= 4 GB, Data Saver and reduced motion.
- **Release and migration.** `APP_VERSION` is `2.3.0`; the storage key is
  `sdp.v15_liquid`, `schema`/`settingsRev`/`data.ver` are `15`. v14, v13 and
  v12 storage migrates without losing class results. Session 7 (30 words,
  fixed 5 s timer, two repeats, Amy en-GB voice chain) and Admin PIN 7898 are
  unchanged.
- **Verification.** `tests/upgrade.test.cjs` is regenerated from scratch
  (24 checks) covering the dock slide, pill retention, tint morphs, credit
  loop, frame probe, low-data engine and v14 -> v15 migration;
  `tests/check.cjs`, `tests/phase1.cjs` and `tests/upgrade-browser.cjs` pass
  with 0 errors.

## 2.2.0 (v14) — 2026-10-23 (animated Hansana badge and liquid tint morphs)

- **Floating creator badge.** Adds the fixed `#credit.credit.glass` pill with the
  aqua droplet, “credits goes to Hansana” label, spring entrance/exit, diagonal
  `sheen`, one-shot `ping`, and a pausable 350 / 5200 / 900 ms `creditLoop()`.
  Hover or pointer inspection keeps it visible; clicking opens the complete
  Hansana / Ayya01 (Lesandu) / Sumodya Sewmini credits. Its animations remain
  enabled in both Full and Lite modes, with a phone placement above the dock.
- **Clear / Frost / Smoke now morph instead of merely changing state.** Both
  Material Mixers use numeric `data-tint="0|1|2"` controls and a spring sliding
  `.seg-ind`. `UI.setTint()` updates every pill in place without re-rendering,
  persists `settings.glassTint`, and triggers a 420 ms scale/shimmer pulse.
  Explicit `background-color`, `box-shadow`, and `backdrop-filter` transitions
  make the crystal, milky frost, and obsidian smoke presets visibly animate in
  Full and Lite modes.
- **Live mixer tracks.** Home and Settings range controls update their aqua
  `--fill` percentage on every input, and `UI.bindLiquidControls()` re-binds all
  tint pills, sliders and the draggable orb after screen/language renders.
- **60 FPS safeguards retained.** Pre-blurred radial blobs, hidden full-screen
  grain, one hovered-pane rectangle cached on `pointerenter`, and the single
  1.2-second median-frame probe remain. Lite pauses only ambient loops while
  preserving backdrop blur, specular rims, stripes, disc, orb, tint transitions,
  segmented indicator and the complete badge animation set.
- **Low-data dictionary contract.** `DictAPI.lookup()` returns embedded `phon`,
  `pos`, `def`, and `ex` fields (plus the existing UI aliases) for every Session
  7 word with zero requests. The shared `preload="none"` audio element still
  replays a buffered repeat, and repository sync fetches `session.json` only
  when `remoteVer > DB.data.ver`, including on a manual refresh.
- **Release and migration.** `APP_VERSION` is `2.2.0`; the storage key is
  `sdp.v14_liquid`, schema/settings/data revisions are `14`. v13 and v12 data
  migrate without losing class results, and named legacy tints become numeric.
  The 30-word Session 7 assignment, fixed five-second timer, two repeats, Amy
  en-GB voice chain, bilingual UI, Practice, Community, checklist and Admin PIN
  7898 remain intact.
- **Verification.** A cleanly regenerated `tests/upgrade.test.cjs` covers the
  badge timing, pause/toast behavior, no-render tint morph, slider fill,
  migration, low-data engine and preserved features. The Phase 1 and real
  Chromium gates cover regressions and computed browser materials.

## 2.1.0 (v13) — 2026-10-23 (60 FPS Liquid Glass, automatic Lite mode, 85% less data)

- **GPU/CPU lag removed at the source.** `.blob` no longer uses `filter: blur(85px)`
  (a per-frame shader on the whole 62vmax circle); each blob is a pre-blurred
  `radial-gradient(circle, var(--blob-color) 0%, transparent 70%)` with
  `opacity: .52` and `translate3d(0,0,0)`, which looks identical and costs 0% GPU
  blur. `#grain` (a full-screen `<feTurbulence>` texture URL) is
  `display: none !important` — the `<svg width="0" height="0">` sprite stays in the
  DOM, but nothing is ever rasterised across the viewport.
- **Zero-reflow pointer specular.** The global `pointermove` handler no longer
  loops over `document.querySelectorAll('.glass')`. It now runs only in
  `perfMode === "full"` with `(hover: hover) and (pointer: fine)`, updates the ONE
  hovered `.glass` card's `--mx`/`--my`, caches that card's
  `getBoundingClientRect()` until the pointer enters another card or the page
  scrolls/resizes, and writes inside a single `requestAnimationFrame`. Touch input
  returns immediately.
- **Dock magnification is bounded.** One rAF per gesture, cached icon rects
  (re-measured on `resize`), no work at all for touch, coarse pointers or Lite mode.
- **Automatic Lite mode (`perf: "auto"` is the default).** `UI.autoPerf()` picks
  Lite for `prefers-reduced-motion`, `prefers-reduced-transparency`, viewports
  ≤ 860px, `(pointer: coarse)`, `hardwareConcurrency ≤ 4`, `deviceMemory ≤ 4` and
  Data Saver / 2G-3G links. `UI.frameProbe()` samples ONE 1.2 s window, always
  cancels its `requestAnimationFrame`, and switches to Lite when the median frame
  delta is over 19 ms (under ~52 FPS).
- **100% of the Apple_liquid.html look is kept in Lite.** `body[data-perf="lite"]`
  sets `--gb: 8px; --gs: 1.35; --gbr: 1.02`; the topbar, dock, hero, mixer panel,
  word card, sheets and modals keep `backdrop-filter` and the four-layer specular
  rim; `.stripes`, `.disc`, `#orb` and the bento tiles are untouched. Only
  `.glass::before`, the infinite `.blob/.bubble/.chip` animations and repeated
  inner rows (`.listrow`, `.word-item.glass`, `.comm-item.glass`) lose their
  per-frame cost. `contain: content` stays gone and Full mode now defaults to a
  crisp `--gb: 14px / --gs: 1.6`.
- **1-tap performance control.** `#btnPerf` in the floating top pill, the
  `Auto | Lite 60FPS | Full` segment and the `#perfStatus` badge in the Material
  Mixer all call `UI.setPerf()`/`UI.togglePerf()` and toast the new mode.
- **Low-data engine (≈85% less traffic).** `Dict.lookup()` answers every published
  class word from memory (embedded meaning, example, part of speech, British MP3
  and IPA for all 30 Session 7 words) and only hits
  `api.dictionaryapi.dev` for a brand-new Admin word. `#sdpAudio` is
  `preload="none"`; a repeated word (`sdpAudio.src === url && readyState >= 2`)
  is replayed with `currentTime = 0` instead of being downloaded again, with a
  35-entry in-memory cache. `./data/version.json` is read once per boot with no
  `?t=` cache-buster, `./data/session.json` only when `ver` is newer, the ntfy poll
  is a single 24 h window, the SSE stream only opens on a visible tab without Data
  Saver, the slow safety poll is 5 minutes, and `storage` events give 0-byte
  cross-tab sync. Low data mode also speaks countdowns and numbers with the
  0-byte local British voice.
- **Every interactive feature re-bound on render.** `UI.bindLiquidControls(root)`
  runs at the end of `Screens.home()` and `Screens.settings()`, so the blur /
  saturate / brightness sliders, the Clear/Frost/Smoke tint control and the
  draggable `#orb` survive tab switches and `EN | සිංහල` re-renders. The tint
  indicator now actually moves (it used to query one button instead of the list).
- **New Practice tab** in the dock: flashcards (tap to flip, Amy audio, Know /
  Practise), a 4-option meaning quiz and the full 30-word audio list.
- **TTS and timing.** Amy (en-GB) → Google Translate en-GB → a female British
  device voice, now with a 3.5 s network failover instead of 2.2 s. Still exactly
  two spoken repeats, a 5 second writing timer and paper mode by default.
- **Home fixes.** "Last score" reads the newest class result, and the paper
  checklist writes its accuracy back to the shared result row as well as the
  history record.
- **Storage.** Key `sdp.v13_fast_liquid`, schema and `settingsRev` 13; a device
  that still holds `sdp.v12_liquid` is imported once, so results and comments are
  never lost. Sessions up to v12 are migrated to Auto and the same 30 Session 7
  words.

## 2.0.0 (v12) — 2026-10-23 (desktop + 360px Apple WWDC25 Liquid Glass stage)

- **Glass engine fixed.** `contain: content` is gone from `.glass` (it created a
  containment boundary that broke `backdrop-filter` refraction in Chrome and on
  mobile Safari), and the old 900px two-column left-sidebar grid is replaced by a
  centred full canvas (`max-width: 1140px`) with a fixed floating top pill navbar
  and a floating macOS-style magnifying dock on every screen size.
- **A real root cause behind the flat dark cards.** `settings.hc` defaulted to the
  *string* `"off"`, which is truthy, so `applyHc()` forced `data-hc="on"` on a fresh
  install and every `.glass` pane rendered as a solid `#161a29` box. The default is
  now the boolean `false`, `applyHc()` only honours `true`/`"on"`, and `migrate()`
  repairs a stored `"off"`.
- **Colour-refracting surfaces.** Home wraps `#homeHero.glass` in an
  `.anatomy-stage` with `.stripes` and a coral `.disc` directly behind the pane;
  `#lgStage` is a clamped, overflow-hidden orb stage; the stat cards are saturated
  bento tiles with an inner `.glass` surface; Past sessions sits on a mint striped
  bento tile; and the dictation player layer is a translucent blur stage with its
  own `.stripes`, warm orb, aqua-to-mint lens and inset specular rim.
- **Mobile 360-430px.** The top bar never overflows horizontally (it scrolls, then
  compacts under 520px), `.lg-hero` stacks to one column with a 330px stage, and
  `document.documentElement.scrollWidth` equals `window.innerWidth` at 320/360/390/
  430/768/1024/1280 in real Chromium.
- **Session 7 and Amy remain untouched.** Storage key `sdp.v12_liquid`, schema and
  settings revision `12`; the same 30 Travel & Transport words, fixed 5-second
  timer, two repeats, paper checklist, bilingual guide and credits, Admin PIN 7898,
  live publishing and ntfy sync, and one unified British female professor voice
  (Amy, en-GB) through `#sdpAudio`.

## 2.0.0 (v11) — 2026-10-23 (full Apple WWDC25 Liquid Glass Playground)

- **Full glass is the default everywhere.** The initial HTML, `defaultData()`, and
  v11 migration use dark/full; `UI.autoPerf()` and the frame probe never downgrade
  a device. Manual Lite only pauses ambient blob movement and no longer hides
  blobs/grain or removes backdrop blur, filters, or shadows.
- **A real two-column Liquid Glass Home.** Adds the floating top-center glass pill
  navbar, giant hollow display type, creator pill, draggable glowing `#orb`, four
  rising bubbles, overlapping Material Mixer, live blur/saturation/brightness and
  tint controls, floating voice chips, saturated bento stats, and dock magnification.
  Existing Home/player/control IDs and mobile layouts are preserved.
- **Session 7 and Amy remain unified.** The same 30 Travel & Transport words,
  fixed 5-second timer, two repeats, paper checklist, bilingual guide, credits,
  Admin PIN, live publishing, and ntfy sync remain. Online speech uses Amy with
  the en-GB Google failover through one `#sdpAudio`; known male offline voices
  are filtered out.
- **Release and regression metadata.** `APP_VERSION` is `2.0.0`, the storage key
  is `sdp.v11_liquid`, and schema/settings/data revisions are `11`. Unit, ES5,
  migration, real Chromium interaction/layout, axe, and legacy regression tests
  cover the release.

## 2.0.0 (v8) — 2026-10-22 (Session 7 · Travel & Transport · strictly two repeats)

- **The word is spoken exactly twice.** `Eng.buildBeats()` now emits
  `st.repeats` word-say beats (2 by default) and nothing else: no extra leading
  word beat, no repeat loop that can reach 3 or 4. `CONFIG.key` is
  `sdp.v8_session7`, `CONFIG.schema`/`settingsRev` are `8`, and the live topics
  are `sdp_dictationb1_state_v8` / `_comm_v8` / `_inbox_v8`.
- **One engine per utterance.** `Speech.say()` gained a strict single-engine
  lock: every part stops the shared `#sdpAudio` element and the synthesiser
  before it starts, a beat that has actually produced sound (`audioStarted`)
  is never repeated by `speechSynthesis`, the failed-utterance retry and the
  queue rewind are gone, and only a failure *before* playback may fall to the
  next tier (2200 ms connection timeout, 6000 ms completion timeout).
- **Studio British female professor voice.** Oxford/Cambridge UK MP3 first, then
  Polly **Amy** (en-GB), Polly **Emma**, then Google en-GB through the unlocked
  `#sdpAudio`; device voices rank Natural/Online British female first
  (Sonia, Libby, Maisie, Google UK English Female, Serena, Kate, Martha,
  Stephanie, Shelley, Hazel) with `rate 0.88` and `pitch 1.05`. The next word's
  audio is preloaded during the 5 second writing timer.
- **Session 7 (22/10/2026, CCBE Galle Branch).** 30 Cambridge B1 Travel &
  Transport words, `writeMode: "fixed"`, `writeFixed: 5`, `sentence: false`,
  `repeats: 2`, `rate: 0.88`, `numbers: true`, `mode: "paper"`.
- **Credits and the bilingual shell.** “Created by Hansana · Idea given by
  Ayya01 (Lesandu) · Lecturer in Charge: Sumodya Sewmini” (and its Sinhala
  form) in the header subtitle, Home, Settings → About and the Welcome Guide,
  with the one-tap `EN | සිංහල` switch and a `Guide / උපදෙස්` button.

## 2.0.0 (v7) — 2026-10-22 (Session 7 · Travel & Transport)

- **Session 7 replaces every older list.** 30 Cambridge B1 *Travel & Transport*
  words (`guidebook` … `windscreen`, including `tyre/tire`, `road sign`,
  `tourist information centre` and `waiting room`), each with a British meaning,
  a B1 example sentence and an Oxford/Cambridge UK MP3.
  `CONFIG.key` is `sdp.v7_session7`, `CONFIG.schema`/`settingsRev` are `7`, and
  the live topics are `sdp_dictationb1_state_v7` / `_comm_v7` / `_inbox_v7`.
- **Migration wipes the old class on every phone.** `DB.load()` and `DB.migrate()`
  overwrite `lists`, `plan` and `session` and delete `snapshot`, `sessions`,
  `outbox` whenever `settingsRev < 7`; `tourSeen` is reset so everyone sees the
  new bilingual Welcome Guide once. Personal history, results and comments stay.
- **5 second timer, numbers only by default.** `writeMode: "fixed"`,
  `writeFixed: 5`, `sentence: false`, `repeats: 2`, `rate: 0.85`,
  `numbers: true`, `mode: "paper"`, `pauseWord: 1.2`, `pauseSent: 1.6`.
- **One tap EN | සිංහල.** `#btnLang` in the header (and at the top of the Welcome
  Guide) translates navigation, Home actions and player controls through
  `STRINGS_SI` / `T()`; dictation audio always stays British English.
- **Creator credits everywhere.** “Created by Hansana · Idea given by Ayya01
  (Lesandu) · Lecturer in Charge: Sumodya Sewmini” (Sinhala: නිර්මාණය: Hansana ·
  අදහස: Ayya01 (Lesandu) · භාරකාර කථිකාචාර්ය: Sumodya Sewmini) in the header,
  Home footer, Settings → About and the Welcome Guide.
- **Four-tier British female professor audio.** Tier 1 streams Oxford/Cambridge
  UK MP3s, then AWS Polly **Amy** (en-GB), then Polly **Emma**, then Google
  en-GB, all through the single unlocked `#sdpAudio` element; Tier 2 ranks
  British female device voices first with `pitch = 1.06`; Tier 3 keeps the
  `-uk.mp3` / `En-uk-` recordings; Tier 4 falls back to any English female voice,
  still tagged `en-GB`. `tyre/tire` is spoken “tyre” and either spelling is
  marked 100% correct.
- **Real-time sync, zero fake numbers.** `data/version.json` and
  `data/session.json` are fetched cache-busted on boot, the v7 ntfy topics are
  polled and streamed over SSE, `#chipNet` only claims “Online · Live Sync”
  after a real response, and Class stats are computed strictly from real student
  results.
- **Guide, admin and tests.** New Welcome & Complete User Guide (four steps, both
  languages), PIN `7898`, one-tap **Save & Publish Live Now**, a 30-row paper
  self-check, and `tests/upgrade.test.cjs` rewritten from scratch for v7.

## 2.0.0 (v6) — 2026-10-22 (Session 6)

- **Every older word list is gone.** Session 6 — *Travel & Transport* is the only
  list in `index.html`, `data/session.json` and `data/config.json`: 30 Cambridge B1
  words (`travel` … `guest`, including `boarding pass`, `capital city`,
  `driver's licence`, `exchange rate`), each pre-filled with a British meaning, a B1
  example sentence and a UK dictionary MP3. `CONFIG.key` is `sdp.v6_travel`,
  `CONFIG.schema` and `settingsRev` are `6`, and the live topics are
  `sdp_dictationb1_state_v6` / `_comm_v6` / `_inbox_v6`.
- **Migration drops the old cache on every phone.** `DB.load()` and `DB.migrate()`
  overwrite `lists`, `plan` and `session` and delete `snapshot`, `sessions` and
  `outbox` whenever `settingsRev < 6`, so no leisure, hobby or sport word can survive
  an update. Class results, comments and personal history are kept.
- **5 second timer only.** Writing time is `writeMode: "fixed"` / `writeFixed: 5`
  (`writeSecs()` returns 5), with `sentence: false`, `repeats: 2`, `rate: 0.85`,
  `numbers: true`, `mode: "paper"`, `pauseWord: 1.2`, `pauseSent: 1.6`.
- **Paper self-check actually renders.** The Results screen now inserts every one of
  the 30 tap-to-mark rows (`Correct` / `Missed`) — the rows were built but never
  attached to the checklist — and the score ring, history entry and the
  `status: "finished"` community post update live.
- **Four-tier British audio, word by word.** Tier 1 walks the recorded UK sources in
  order (the word's own MP3, cached dictionary audio, the Oxford/Cambridge CDN, the
  Free Dictionary `-uk.mp3`, then the Wiktionary `En-uk-` recording), Tier 2 uses an
  installed `en-GB` voice (Daniel, Martha, Arthur, Kate, Serena, Google UK English,
  Microsoft Sonia/Ryan/Hazel), Tier 3 streams Google `tl=en-GB` (then StreamElements
  Amy) through the shared `#sdpAudio` element when no UK voice exists, and Tier 4
  speaks with any English voice tagged `en-GB`. Prompts with no dictionary entry
  (greetings, `Number 3`) go straight to the voice instead of hunting a recording.
- **Paste pipeline.** `Admin.parseWords` strips trailing part-of-speech tags
  (`driver's licence(n)` → `driver's licence`), auto-fills `m`/`s` from the
  built-in B1 lexicon plus `api.dictionaryapi.dev` and the Wiktionary REST API, and
  the single lag-free table keeps the one-tap **Save & Publish Live Now** button.
- **Marking understands UK spellings.** `driver's licence`, `drivers licence` and
  `driver's license` all count (the last with the UK spelling note), apostrophes are
  ignored when comparing, and every other word is marked word by word.
- **Honest sync chip.** `#chipNet` reads `Online · Live Sync` only after a real
  HTTP 200 or an open `EventSource`, `Syncing…` while a post or the first connection
  is in flight, and `Offline · Saved on device` when the device is offline.
- **Home hero.** `SESSION 6 · 19 OCT 2026` / `Session 6 - Travel & Transport` /
  `30 words · 5s timer`, straight from the active session.
- `tests/upgrade.test.cjs` was rewritten from scratch for v6 (13 tests: data files,
  in-app defaults, migration, timer, paste tags, UK marking, audio candidates, the
  network chip and the 30-row paper checklist). `tests/phase1.cjs` (68 checks) and
  `tests/upgrade-browser.cjs` were updated to the v6 storage key, build stamp, live
  topics and publish label; the browser suite now skips with an explicit message when
  no runnable browser exists in the environment instead of failing on library issues.

## 2.0.0 — 2026-10-14 (released to GitHub Pages)

- **CI fix (third pass).** With the full history checked out, the real browser suites ran: `tests/browser.cjs` counts every http(s) request made at boot, so the live channel is now explicitly allowlisted there (the two cached reads plus the one SSE stream — all read-only GETs; any POST, any Apps Script or GitHub call and any other host is still a failure). The publish toast keeps its `Saved & published to all students …` wording that `tests/upgrade-browser.cjs` waits for, with the session number and live-sync state appended.
- **CI fix (second pass).** The single-word-table refactor left a dangling `wbox.appendChild(libAct)` that aborted the rest of the Admin Words tab (the planner and the list actions never rendered) — caught by `tests/phase1.cjs` under the full-history CI checkout. The list actions now live in the one words card. `Eng.pause` flushes the snapshot at once, and `Speech.isBritishAudio` keeps a non-UK recording (`us.mp3`) from ever outranking the recorded British audio or the en-GB voice.
- **Real-time class channel (ntfy.sh, free + open source, no key).** Three public topics carry the class the moment it happens: `sdp_dictationb1_state_v2` (the published session), `sdp_dictationb1_comm_v2` (community posts and every student completion) and `sdp_dictationb1_inbox_v2` (a student's private message). `Cloud.bootSync()` fetches `./data/session.json?t=…`, polls `…/json?poll=1&since=all` for the cached messages and opens one `EventSource(…/sse)` stream on the first frame of the page — no tap required — and the newest payload (`publishedAt`/`ver`) wins. A lecturer publish is broadcast once and every open phone repaints with the new word list, session number, day, date and title; the outbox drains over the same channel, so a job can no longer sit at **1 waiting** on a device with no Apps Script URL.
- **Honest status chip.** `#chipNetText` now reads `Online · Live B1 Session v2.0.0 · Synced 5 min ago`, `Syncing…` while a post is in flight, `Offline · Saved on device` when the device is really offline, and a real `· N waiting` count taken from the outbox — never a fixed badge.
- **Real class statistics.** `Admin.tabStats` (Class overview, Average score by session, Devices, CSV) is computed from real student completions (`DB.data.results`, live cloud events merged in), shows zero — not an invented number — until a student really finishes, and the lecturer's own practice history is labelled and excluded from class scores.
- **Session header can never contradict the page.** A list named `Session 4 words` sets the session number automatically on publish, `d.session.day` is always derived from the real session date, and a locally frozen past date is moved to the real date (`DB.refreshSessionDate`) unless the date was deliberately planned or published.
- **Four-tier British audio engine.** A single shared `<audio id="sdpAudio">` element, unlocked inside the first tap, tries a recorded Cambridge/Oxford UK dictionary MP3 first, then the device `en-GB` voice, then a streamed cloud British TTS voice, then any installed English voice, then the second free British TTS host (`api.streamelements.com`, voice Amy) if the first is blocked, and finally a WebAudio chime with the word on screen. The shared element keeps `crossorigin="anonymous"` for CORS-friendly hosts and retries the same file once without it, so a host that sends no CORS headers still plays. The "No UK English voice found" sheet can no longer block `Eng.start` or `Speech.say`, and a missing device voice never drops a phone into silent Text mode. The Ready sheet and Settings → Voice both show a `UK Audio Ready` pill and a **Test sound** button, and the greeting is spoken on the Ready sheet, but it stands down as soon as the run itself has started so it can never cancel the first beat (the `Number 1.` line).
- **Default list is the 30 Cambridge B1 "Leisure & Hobbies" words** (`hobbies` … `torch`), each pre-filled with a B1 meaning, a B1 example sentence and a UK MP3 URL; the same list is published as `data/session.json`.
- **Dictionary examples are no longer filtered.** `Dict.parse` keeps any real example sentence the Free Dictionary API returns (the old 8-to-14-word rule threw away most of them, including `Take a torch.`) and `Dict.wikiLookup` falls back to the open Wiktionary REST API for a definition, an example and free British Ogg recordings when the primary entry has none.
- **Automatic meaning & sentence generator** in `Admin.parseWords`: built-in B1 bank first (30 leisure + previous sample + common B1 words), then a background dictionary lookup, then a clean B1 template, so `s`/`m` are never blank and no separate enrich button is needed.
- **Streamlined Admin editor** on four steps (paste → review → session & class day → one-tap **Save & Publish to All Students**), a live "30 words ready — meanings & sentences auto-filled" badge, and `Admin.saveAll` publishing list + active session + plan + cloud queue + Home at once. Lecturer PIN stays `7898`, supports a physical keyboard (digits, Backspace, Enter) and auto-unlocks as soon as the four digits are in; a cloud login failure still falls back to the device PIN.
- **Dictation defaults** are now `sentence: false`, `repeats: 2`, `rate: 0.85`, `numbers: true`, `mode: "paper"`, with schema 3 and a `settingsRev: 2` migration that also swaps an existing install's sample list for the 30 leisure words and publishes it.
- **Classes are Tuesday and Wednesday only**: the date list returns the next 8 class dates, "Next session" advances Tue/Wed, and the weekly planner highlights the two class days behind a collapsed "Other days" disclosure.
- **Data files are schema `ver: 3` / app `version: "2.0.0"`** (`data/version.json`, `data/config.json` with the class days, defaults and the three live topic URLs, `data/session.json` with the 30 published words).
- **Always-on online mode**: `data/version.json`, `data/session.json` and `data/config.json` are fetched with `cache: "no-store"` on boot and on Refresh, cache-busting `<meta>` tags stop stale pages, the status chip reads `Online · Live B1 Session` (never "Local mode" while online), and Settings & Tools gained one-tap **GitHub Direct Publish** plus **Download session.json**.
- **Community auto-completion**: finishing a dictation posts an anonymous `Completed Session X · Score: Y/30 (Z%)` entry (with device metadata) to Community and the sync queue, and it updates live when the paper self-check score changes.
- **One word table and one tap**: the duplicate 30-row "Reorder words" card is gone (the single paste table already reorders, deletes and edits), and a sticky **Save & Publish Live (30 words)** button under the paste box parses, saves, syncs the session header, publishes and broadcasts in one click.
- **Lag removal**: the frame probe samples at most 60 frames once and permanently cancels its `requestAnimationFrame` loop, low-core/low-memory phones start in `lite` with gradient-based "liquid glass" instead of scrolling `backdrop-filter`, the duplicate `.bak` write only happens on session finish or publish, the per-word snapshot is debounced by 400 ms and flushed on finish/pause/publish, and `dictCache` is capped FIFO at 200 entries.
- **Paper-mode self-check**: the Results screen lists every word with tap-to-mark *Got it right / Missed it* controls that live-update the score ring, `DB.data.history` and the community post.
- `tests/upgrade.test.cjs` covers the whole v2.0.0 surface (101 tests), and the Chromium/WebKit QA scripts now assert the v2.0.0 contract (light saves, one-tap publish, four-tier audio, the auto-submitting PIN pad); `tests/live-lab.cjs` boots two real devices against a local HTTP server and an in-process ntfy emulator and proves the live publish/completion round trip (13 checks), and `tests/phase1.cjs` now skips cleanly when the historical baseline commit is absent from a shallow clone so it cannot block CI.

## 1.5.0-rc.1 — 2026-10-14 (unreleased; partial Phase 1)

- Whole-paste format detection, quote-aware CSV, plain comma/semicolon/bullet lists, ordered case-insensitive de-duplication, and explicit format override.
- Editable full preview, chunked row rendering, deletion, drag ordering and accessible Up/Down alternatives. Counts no longer treat absent optional sentences as problems. Invalid/ambiguous input blocks saving/publishing rather than silently dropping problematic rows.
- Replace/Add draft labels, Tuesday/Wednesday date chips, and Publish confirmation based on the current preview and chosen dates.
- One sticky admin wrapper prevents the status/tab overlap. Labelled Publish selector, keyboard-focusable calendar and corrected segmented-control ARIA.
- Schema 2 migration: default word repetition twice, example sentences off, original stored data retained in an additional recovery key; existing custom preferences survive later reloads.
- Tolerant UK language tags and cautious UK name matching. Explicit non-UK locale tags cannot be overridden by a name. Voice list refresh on first gesture, and stale voices cleared.
- Default PIN verifier precomputed; successful login re-salts and upgrades to PBKDF2 where supported. Existing hashes and fallback preserved. Recovery/security limits documented.
- Greeting on Start, guarded countdown callbacks and repeated taps, minimum four-second writing gap.
- Continuous foreground frame median probe, sticky Auto downgrade, no iPhone core-only downgrade, limited Full-mode blur and stricter Lite rendering.
- Added Node tests, real Chromium/WebKit CI entry points, axe checks, file-size/ES5 syntax budget, and reproducible Chrome trace harness.

Not a completed Phase 1 or a production release. Remaining work and verification limits are tracked in PHASE1_QA.md. No Phase 2 audio assets or Phase 3 Worker/cloud deployment is included.
