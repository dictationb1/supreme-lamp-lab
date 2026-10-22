'use strict';
// STRUCTURAL READS OF A WORKFLOW FILE THAT DO NOT DEPEND ON LINE ENDINGS.
// ---------------------------------------------------------------------------
// REPRODUCED DEFECT (lab run 39819073772, job `client`, step "Regression suite
// (Windows, real processes)"; runner WIN-NFU1JG4VESE, session 1):
//
//     AssertionError [ERR_ASSERTION]: concurrency block present
//         at scripts/test/origin-discovery-regressions.js:560
//
// The workflow *did* contain the concurrency block. The self-hosted Windows
// runner checks the file out with CRLF line endings (no .gitattributes pins the
// EOL, and Git for Windows defaults to core.autocrlf=true), so the assertion's
// `/^concurrency:\n/` could never match `concurrency:\r\n...`. The same bytes
// converted to LF passed on Linux — the test was measuring the checkout, not
// the workflow.
//
// The fix is to normalize line endings (and a UTF-8 BOM) BEFORE any structural
// check, and to keep the assertions that actually matter (only GitHub's two
// concurrency keys are allowed; the block must exist; it must be a map).
// A YAML parser would also work, but the repository intentionally has no
// runtime dependencies, and a normalized textual read keeps the negative
// fixtures (missing block, scalar block, unknown key) exact.

const fs = require('fs');

/** GitHub accepts exactly these two keys under a workflow's `concurrency:`. */
const CONCURRENCY_KEYS = ['cancel-in-progress', 'group'];

/** Strip a UTF-8 BOM and collapse CRLF/CR to LF. Idempotent. */
function normalizeText(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Read a file and normalize it. `path` may be a path or an array of segments. */
function readNormalized(...segments) {
  const p = segments.length === 1 && Array.isArray(segments[0]) ? segments[0] : segments;
  return normalizeText(fs.readFileSync(require('path').join(...p), 'utf8'));
}

/**
 * Structural check of the top-level `concurrency:` block.
 * @returns {{ok:true, keys:string[], block:string} | {ok:false, code:string, detail:string, keys?:string[]}}
 */
function concurrencyBlock(text) {
  const s = normalizeText(text);
  const m = s.match(/^concurrency:[ \t]*\n((?:[ \t]+.*\n)+)/m);
  if (!m) {
    if (/^concurrency:[ \t]*\r?$/m.test(s) || /^concurrency:[ \t]+$/m.test(s)) {
      return { ok: false, code: 'CONCURRENCY_EMPTY', detail: 'concurrency: has no value' };
    }
    if (/^concurrency:/m.test(s)) {
      return { ok: false, code: 'CONCURRENCY_NOT_A_MAP', detail: 'concurrency: is a scalar, not a group/cancel-in-progress map' };
    }
    return { ok: false, code: 'CONCURRENCY_MISSING', detail: 'no top-level concurrency: block' };
  }
  const block = m[1];
  const keys = block.split('\n').map(l => (l.match(/^[ \t]+([A-Za-z0-9_-]+):/) || [])[1]).filter(Boolean);
  const unknown = keys.filter(k => !CONCURRENCY_KEYS.includes(k));
  if (unknown.length) {
    return {
      ok: false, code: 'CONCURRENCY_UNKNOWN_KEY', keys, block,
      detail: `unknown concurrency key(s) ${unknown.join(', ')} — GitHub rejects the whole workflow file`
    };
  }
  if (!keys.length) return { ok: false, code: 'CONCURRENCY_NO_KEYS', detail: 'concurrency block has no keys', block };
  if (keys.filter(k => k === 'group').length > 1) return { ok: false, code: 'CONCURRENCY_DUPLICATE_GROUP', detail: 'group is declared twice', keys, block };
  return { ok: true, keys, block };
}

/**
 * Return the YAML text of one `- name: <stepName>` step in one job.
 * A step ends at the next sibling `- name:` or at the next job key. This is a
 * deliberately small textual slice: the point is to prove which env entries a
 * *specific* step receives, and a YAML library would still need the same
 * "enclosing step" logic.
 */
function stepBlock(text, stepName) {
  const s = normalizeText(text);
  const lines = s.split('\n');
  const start = lines.findIndex(l => new RegExp(`^\\s*-\\s*name:\\s*${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    const li = l.match(/^\s*/)[0].length;
    if (li <= indent) break;                     // next task (e.g. `- name:` or a job key)
    out.push(l);
  }
  return out.join('\n');
}

/** Env keys visible to a step: step-level `env:` plus job/workflow `env:` names. */
function envKeysIn(block) {
  const keys = new Set();
  for (const m of normalizeText(block).matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*):/gm)) keys.add(m[1]);
  return keys;
}

/** The value bound to `KEY:` inside a step block (or null). */
function envValue(block, key) {
  const m = normalizeText(block).match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : null;
}

module.exports = {
  CONCURRENCY_KEYS,
  normalizeText,
  readNormalized,
  concurrencyBlock,
  stepBlock,
  envKeysIn,
  envValue
};
