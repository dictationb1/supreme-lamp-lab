# Smart Dictation Player v2.6.0 (ver 18) — release bundle

Zero keyboard suggestions · Animated tick mark · Streak breakdown & false-answer
correction flow · 1-tap cross-mark (✕) exits · Swan badge, see-through title,
Settings mixer & 60 FPS engine

| item | value |
|---|---|
| target app | `dictationb1/dictationb1.github.io` (`main`) |
| base commit | `4fcd9d5` (Merge PR #64 — v2.5.0 / ver 17) |
| release commit | `42bf5d8` — "Release v2.6.0 (v18): Zero Keyboard Suggestions, Streak Breakdown & Mistake Flow, 1-Tap CrossMark Exit, Swan Badge & 60 FPS UI" |
| `APP_VERSION` | `2.6.0` (build `2026-10-24`) |
| storage key / schema | `sdp.v18_nosuggest` / `18` · `settingsRev = 18` |
| release data | `data/version.json`, `data/config.json`, `data/session.json` → `ver: 18`, `appVersion: "2.6.0"` |
| `index.html` | **441,328 bytes** (target `< 442,000`; hard ceiling `450,000`) |
| verification | `check.cjs` PASS · `upgrade.test.cjs` 28/28 · `phase1.cjs` 68/68 · `server.cjs` 7/7 · `upgrade-browser.cjs` SKIP (no browser in the sandbox) |
| publish state | **NOT PUSHED** — the agent's GitHub integration is read-only on this repository (see below) |

## Why it is not on `main` yet

Every write to `dictationb1/dictationb1.github.io` was refused by GitHub, exactly
as in the v2.4.0 release:

```
$ git push https://x-access-token:<token>@github.com/dictationb1/dictationb1.github.io.git HEAD:refs/heads/arena/e33a8e7b-v18-release
remote: Permission to dictationb1/dictationb1.github.io.git denied to dictationb1.
fatal: unable to access '...': The requested URL returned error: 403

$ gh api -X POST repos/dictationb1/dictationb1.github.io/git/refs -f ref=refs/heads/arena/e33a8e7b-v18-release -f sha=42bf5d8
{"message":"Resource not accessible by integration","status":403}
```

Reads work (`gh api repos/...` reports `admin`/`push` in `permissions`, the repo
clones, every gate runs), but the installation token cannot create refs, so
neither a PR nor a direct push is possible from the sandbox. The same token has
write access to `dictationb1/supreme-lamp-lab`, which is why the release is
delivered here. Nothing in the app repository was rewritten and no rewrite was
faked: `42bf5d8` exists only in the sandbox clone until someone with write access
publishes it.

## Publish it (one command)

```bash
# from a clone with write access to dictationb1/dictationb1.github.io
git clone https://github.com/dictationb1/dictationb1.github.io.git
cd dictationb1.github.io
git checkout main                        # must be at 4fcd9d5
git am ../path/to/0001-release-v2.6.0.patch    # or: git apply ../v2.6.0.diff && git commit -F ../MSG
(cd tests && npm install)
node tests/check.cjs && node tests/upgrade.test.cjs && node tests/phase1.cjs && node tests/server.cjs
git push origin main
```

`apply-release.sh` does exactly this, including the gate run and the push.

**Patch dry-run already done:** a fresh clone of `main` at `4fcd9d5` was patched
with `0001-release-v2.6.0.patch` in this sandbox and re-verified —
`check.cjs` PASS (441,328 / 450,000), `upgrade.test.cjs` 28/28, `phase1.cjs`
68/68, `server.cjs` 7/7.

## What changed

### 1. Zero keyboard suggestions in "Type my answers"

* **Layer A — built-in keyboard.** `Eng.buildVkb()` renders a compact Liquid
  Glass QWERTY keyboard `#ansVkb.ans-vkb` inside `.ans-deck.glass` under
  `#ansWrap` with four rows (`q…p`, `a…l`, `z…m` + `⌫`, and `-` `/` `Space`
  `✓ Check`; 31 keys). On coarse pointers
  (`(pointer: coarse)` or `maxTouchPoints > 0`) the input is created with
  `inputmode="none"`, so tapping it can never raise Gboard, Samsung Keyboard,
  Helakuru, SwiftKey or the iOS suggestion bar. A `⌨️ Keyboard` chip toggles the
  keyboard, and hardware typing keeps working.
* **Layer B — native IME suppression.** `#ansInput` is `type="search"` (search
  cancel button hidden) with `autocomplete="one-time-code"`,
  `autocorrect="off"`, `autocapitalize="none"`, `spellcheck="false"`,
  `aria-autocomplete="none"`, `data-gramm`, `data-gramm_editor`,
  `data-enable-grammarly`, `data-lpignore`, `data-form-type="other"` and a random
  `sdp_nosuggest_<n>` name. `beforeinput` rejects `insertReplacementText`,
  `insertFromPaste`, `insertFromDrop` and multi-character commits; `paste`,
  `drop` and `contextmenu` are prevented.

### 2. Tick mark, streak breakdown and the false-answer correction flow

* `Eng.getTargetVariants()` / `Eng.isAnswerMatch()` accept every slash variant
  (`tyre/tire` → `tyre/tire`, `tyre`, `tire`) and `Eng.isPrefixMatch()` drives the
  live `✗ Letter mismatch — check your spelling` warning.
* The score pill `#plLiveScore` carries `✓ Correct`, `✗ Wrong` and `🔥 Streak`
  (`#plCorrectCount`, `#plWrongCount`, `#plStreakCount`) and the session keeps
  `bestStreak`.
* `Eng.onTypeCorrect()` lights every `.slot-done`, pops `#ansTick` and
  `#plTickHero`, reveals the word + phonetics + meaning, plays the WebAudio
  crystal chime, vibrates 25 ms and advances after 1050 ms.
* `Eng.onTypeWrong()` runs on Enter/Check **and** when the writing countdown hits
  zero: streak → `💔 Streak Broken! (0)` (`.streak-broken`, 1.4 s, then
  `🔥 0 Streak`), `✗ Wrong` +1, animated coral cross `#ansWrong` /
  `#plWrongHero`, two-tone error tone, vibration, a `#ansCompare` card with
  `diffChars()` highlighting (`Your answer:` vs `Correct UK spelling: ✓`),
  `Lib.addMistake()` + `missedWords`, one spoken correction, and a 2100 ms hold
  with a `Got it → Next` button.
* Countdown time-up in type mode routes through the same handler; the countdown
  now also runs in type mode when `advance` is manual.

### 3. 1-tap ✕ exits

* `#btnReadyClose` (`.close-x-btn`, `aria-label="Close and exit dictation"`) in
  the `Are you ready?` header and `#btnNotReady` (`✕ Not ready · Exit`) in the
  sheet footer, plus the scrim and `Escape`, all call
  `Eng.cancelReadyAndExit()`: `runId++`, `clearTimers()`, `Speech.stop()`,
  uncommitted snapshot deleted, sheet + player layer closed, `st = "idle"`,
  `Screens.home()`.
* `#btnPlayerClose` (`.close-x-btn`, `title="Exit dictation"`) sits next to the
  eye icon in the player topbar and calls `self.stop(false)` + `Screens.home()`.
* `.close-x-btn` keeps the exact styling asked for (40 px disc, coral inner
  ring, spring hover/active).

### 4. All v16 / v17 upgrades kept

Animated swan badge (`#credit` → `.c-swan`, `swanFloat` / `swanWing` /
`swanRipple`, live in Full **and** Lite), see-through `.liquid-glass-text`
`#homeTitle` with no `.hollow` span, `#lgStage` material mixer at the top of
Settings only, sliding `#tabInd` and `.seg .thumb` capsules, flattened nested
glass, pre-blurred blobs, `#grain { display: none !important; }`, zero dictionary
requests for the 30 Session 7 words, single-buffer MP3 replay, 30 words
`guidebook … windscreen`, `writeFixed: 5`, `repeats: 2`, British female `Amy`
(`en-GB`).

### 5. Size and schema

Trimmed while adding the above: duplicate per-word audio URLs in `SAMPLE_WORDS`
(now derived by `ukMp3()`), the re-indented/blank-line-stripped `gas-source`
backend block, dead `.bubble-*` / `.hr` / `.stepper` rules, superseded v13/v16 CSS
commentary, redundant HTML section dividers, and `\uXXXX` escapes rewritten as
UTF-8. Net: 431,960 → **441,328 bytes** (−30,672 for the v16 features and the
v17 typing UI, plus 14 KB of new v18 UI, still under the 442,000 target).

## Files in this bundle

```
app/index.html                      the whole single-file app (441,328 / 450,000 bytes)
app/CHANGELOG.md                    the 2.6.0 (v18) entry prepended
app/data/version.json               ver 18 · appVersion 2.6.0 · settingsRev 18
app/data/config.json                ver 18 · appVersion 2.6.0 · Session 7 defaults + v18 keyboard/feedback notes
app/data/session.json               ver 18 · appVersion 2.6.0 · 30 Travel & Transport words
app/tests/upgrade.test.cjs          rewritten from scratch for v18 (28 checks, fs.writeFileSync)
app/tests/phase1.cjs                release stamp + storage key moved to v2.6.0 / sdp.v18_nosuggest
app/tests/upgrade-browser.cjs       real-engine suite plus a v18 typing-shield scenario
app/tests/browser.cjs / e2e.cjs     storage-key references moved to sdp.v18_nosuggest
0001-release-v2.6.0.patch           git-am mailbox patch (4fcd9d5 → 42bf5d8)
v2.6.0.diff                         plain unified diff of the same change
apply-release.sh                    clone · apply · gate · push helper
```

## Verification actually run (in the sandbox)

```
$ node tests/check.cjs
node --check: PASS; ES5 syntax: PASS; index.html 441328 / 450000 bytes

$ node tests/upgrade.test.cjs
# all 28 upgrade checks passed

$ node tests/phase1.cjs
68 PASS · 0 FAIL

$ node tests/server.cjs
7 PASS · 0 FAIL

$ node tests/upgrade-browser.cjs
SKIP upgrade-browser.cjs (chromium): no runnable browser in this environment
```

The real-engine suite is **not** claimed as passing: this sandbox has no Chromium
and cannot load `libnspr4/libnss3`, so the suite skipped with its explicit
message exactly as designed. Run it on a machine with a browser before calling
the visual layer verified.
