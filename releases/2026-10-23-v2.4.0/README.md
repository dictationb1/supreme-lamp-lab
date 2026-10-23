# Smart Dictation Player v2.4.0 (ver 16) — release bundle

Animated Swan Credit Badge · Liquid Glass Hero Title Font · Settings Material Mixer · Zero-Lag 60 FPS UI

| item | value |
|---|---|
| target app | `dictationb1/dictationb1.github.io` (`main`) |
| base commit | `b2a605d` (Merge PR #60) |
| release commit | `205ff0a` — "Release v2.4.0 (v16): Animated Swan Credit Badge, Liquid Glass Hero Title Font, Settings Material Mixer & Zero-Lag 60 FPS UI" |
| `APP_VERSION` | `2.4.0` |
| storage key / schema | `sdp.v16_swan` / `16` · `settingsRev = 16` |
| release data | `data/version.json`, `data/config.json`, `data/session.json` → `ver: 16`, `appVersion: "2.4.0"` |
| verification | `check.cjs` PASS · `upgrade.test.cjs` 22/22 · `phase1.cjs` 68/68 · `server.cjs` 7/7 · `upgrade-browser.cjs` SKIP (no browser in the sandbox) |
| publish state | **NOT PUSHED** — the agent's GitHub integration is read-only on this repository (see below) |

## Why it is not on `main` yet

The sandbox GitHub App token can read `dictationb1/dictationb1.github.io` and can run every
test against it, but every write was refused by GitHub:

```
$ git push https://x-access-token:<token>@github.com/dictationb1/dictationb1.github.io.git HEAD:main
remote: Permission to dictationb1/dictationb1.github.io.git denied to dictationb1.
fatal: unable to access '...': The requested URL returned error: 403

$ gh api -X POST repos/dictationb1/dictationb1.github.io/git/refs -f ref=refs/heads/arena/438a8540-v240 -f sha=205ff0a
{"message":"Resource not accessible by integration","status":"403"}
```

The same token **does** have write access to `dictationb1/supreme-lamp-lab` (this repository),
which is why the release is delivered here instead of being force-fitted somewhere else.
Nothing in the app repository was rewritten, and no rewrite was faked: the commit above exists
only in the sandbox clone until someone with write access publishes it.

## Publish it (one command)

```bash
# from a clone with write access to dictationb1/dictationb1.github.io
git clone https://github.com/dictationb1/dictationb1.github.io.git
cd dictationb1.github.io
git checkout main                       # must be at b2a605d
git am ../path/to/0001-release-v2.4.0.patch    # or: git apply ../path/to/v2.4.0.diff && git commit -F ../MSG
node tests/check.cjs && node tests/upgrade.test.cjs && node tests/phase1.cjs
git push origin main
```

`apply-release.sh` does exactly this, including the gate run and the commit message.

## What changed

### 1. `#credit` — water drop → animated Liquid Glass swan
* `.c-drop` SVG deleted; `.c-swan` SVG (36×36) added with `swanBody` / `swanWing` gradients,
  a `swan-ripple` ellipse, an amber beak and a specular eye.
* `swanFloat` (3.2 s), `swanWing` (2.4 s alternate) and `swanRipple` (2.8 s) keyframes with
  `transform-origin` on group, wing and ripple; 30 px glyph + cyan drop shadow.
* The badge keeps `sheen`, `ping`, the 350 ms spring entrance, 5.2 s hold, exit, 900 ms gap,
  hover/touch pause and the click toast (now "🦢 Created by Hansana …").
* Animations stay live in **both** Full and Lite (`body[data-perf="lite"]` never disables `.c-swan`).

### 2. Hero headline is the Liquid Glass
* `<span class="hollow">Liquid Glass</span>` removed together with the `.hollow` rule.
* `<h1 class="hero-h1"><span id="homeTitle" class="liquid-glass-text">Session 7 - Travel &amp; Transport</span></h1>`
  with the crystal/prism gradient, `background-clip: text`, `-webkit-text-stroke: 1.35px`,
  cyan text shadow, and an opaque light-theme variant (`-webkit-text-stroke: 1.25px`).

### 3. Material Mixer moved Home → Settings
* `#lgStage` (4 bubbles, `🦢 Liquid Glass: Live` + `🇬🇧 Amy UK Voice ⚡︎` chips, draggable `#orb`,
  `Liquid Glass Material Mixer` panel with Blur 4–40 px / Saturate 100–260 / Bright 90–130,
  Clear·Frost·Smoke and Auto·Lite 60FPS·Full pills, live `--fill` aqua tracks and the
  "↖ drag the glowing orb behind this glass pane" hint) is rendered at the top of
  `Screens.settings()` under "Appearance · Liquid Glass".
* Home is a single full-width `.lg-hero` (`display: block`) holding the anatomy stage
  (stripes + disc behind `#homeHero.glass`), the three Bento stat tiles and Past sessions.
* `UI.bindLiquidControls(host)` runs inside `Screens.settings()`, and the new
  `UI.applyGlassSettings()` restores `glassBlur`/`glassSat`/`glassBrt`/`glassTint` on boot
  and on every mixer bind.

### 4. Zero-lag 60 FPS pass
* Nested glass surfaces (`#s-home .tile .glass`, `.card.glass .glass`, `.glass .glass`,
  `.tile .glass`, `.word-item.glass`, `.comm-item.glass`, `#homeStats .statbox-in`,
  `.bento-sessions > .glass`) use one flat translucent gradient and
  `backdrop-filter: none !important`.
* `.topbar.glass` and `#tabbar.glass` are GPU-promoted (`translate3d(-50%, 0, 0)`,
  `will-change: transform`, `backface-visibility: hidden`); `#credit.glass` gets
  `will-change: transform, opacity`.
* `.blob` are pre-blurred radial gradients with `filter: none !important`; `#grain` stays
  `display: none !important` so `<feTurbulence>` never rasterises.
* `#tabInd`, `.seg .thumb`, `.seg .seg-ind`, `.seg-tint .seg-ind`, `.seg-perf .seg-ind` all glide
  with `transform/width .48s cubic-bezier(.2, .9, .25, 1.35) !important` in both modes, and no
  click ever rebuilds the `.seg` it animates.
* `UI.autoPerf()` still downgrades phones/touch/≤4 cores/≤4 GB RAM/Data Saver and a single
  1.2 s `frameProbe()` window (median > 19 ms → Lite, then `cancelAnimationFrame`).
* `DictAPI.lookup()` answers from embedded Session 7 data (0 requests) and `#sdpAudio`
  (`preload="none"`) replays its buffered MP3 with `currentTime = 0`.

### 5. Files in this bundle

```
app/index.html                      the whole single-file app (449,009 / 450,000 bytes)
app/CHANGELOG.md                    the 2.4.0 (v16) entry prepended
app/data/version.json               ver 16 · appVersion 2.4.0 · settingsRev 16
app/data/config.json                ver 16 · appVersion 2.4.0 · Session 7 defaults
app/data/session.json               ver 16 · appVersion 2.4.0 · 30 Travel & Transport words
app/tests/upgrade.test.cjs          rewritten from scratch for v16 (22 checks)
app/tests/phase1.cjs                release-stamp expectation moved to v2.4.0
app/tests/upgrade-browser.cjs       real-engine suite re-pointed at the Settings mixer
0001-release-v2.4.0.patch           git-am mailbox patch (b2a605d → 205ff0a)
v2.4.0.diff                         plain unified diff of the same change
apply-release.sh                    clone · apply · gate · commit · push helper
```

## Verification actually run (in the sandbox)

```
$ node tests/check.cjs
node --check: PASS; ES5 syntax: PASS; index.html 449009 / 450000 bytes

$ node tests/upgrade.test.cjs
all 22 v16 upgrade checks passed

$ node tests/phase1.cjs
68 PASS · 0 FAIL

$ node tests/server.cjs
7 PASS · 0 FAIL

$ node tests/upgrade-browser.cjs
SKIP upgrade-browser.cjs (chromium): no runnable browser in this environment
```

The real-engine suite is **not** claimed as passing: this sandbox has no Chromium and cannot
load `libnspr4/libnss3`, so the suite skipped with its explicit message exactly as designed.
Run it on a machine with a browser before calling the visual layer verified.
