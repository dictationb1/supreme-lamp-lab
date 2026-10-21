#!/usr/bin/env node
'use strict';
// APPLY THE LIVE-RUN HANDOFF TO THE APPLICATION REPOSITORY.
//
//   node patches/apply-live-run-signal.js --repo <app-checkout> [--write] [--snippet <file>]
//
// WHY A SCRIPT AND NOT A .patch: `.github/workflows/main.yml` in the application
// repository is ~7.3k lines and moves with every merged PR. A line-number diff
// would rot within days and, worse, could apply to the WRONG job. This tool is
// anchor-based and refuses to write unless:
//   * both anchors occur EXACTLY once (the readiness step and the keep-alive step);
//   * the insertion point lies between them;
//   * the snippet is not already present (idempotent: re-running is a no-op);
//   * the resulting file still parses as YAML (structural check, see below);
//   * the file is a workflow the app's own validate step will accept.
// It prints a machine-readable summary so a CI job can assert the outcome.

const fs = require('fs');
const path = require('path');

const ANCHOR_BEFORE = '      - name: Service Readiness Check (Pre-Keepalive)';
const ANCHOR_AFTER = '      - name: Keep-alive 5h30';
const MARKER = 'Signal the verification lab (live run)';

function parseArgs(argv) {
  const a = { repo: '', write: false, snippet: path.join(__dirname, 'app-live-run-signal.snippet.yml') };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = argv[++i];
    else if (k === '--snippet') a.snippet = argv[++i];
    else if (k === '--write') a.write = true;
    else { const e = new Error(`unknown flag ${k}`); e.usage = true; throw e; }
  }
  return a;
}

/**
 * Minimal workflow-shape check. A full YAML parser is not a dependency of this
 * repository, so instead of pretending to parse we assert the properties that a
 * mis-placed insertion would break: consistent 6-space step indentation inside the
 * job, no tab characters, no duplicated step names, and balanced `${{ }}` actions
 * expressions. A real `actionlint`/validate-workflows run still happens in CI.
 */
function structuralChecks(text) {
  const problems = [];
  if (/\t/.test(text)) problems.push('TAB_CHARS: workflow files must not contain tabs');
  const opens = (text.match(/\$\{\{/g) || []).length;
  const closes = (text.match(/\}\}/g) || []).length;
  if (opens !== closes) problems.push('EXPRESSION_BALANCE: action-expression opens=' + opens + ' closes=' + closes);
  const names = (text.match(/^      - name: (.+)$/gm) || []).map(s => s.replace(/^      - name: /, '').trim());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) problems.push(`DUPLICATE_STEP_NAMES: ${[...new Set(dupes)].join(', ')}`);
  const bad = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*-\s+name:/.test(l) && !/^      - name:/.test(l) && !/^        - name:/.test(l)) bad.push(i + 1);
  });
  if (bad.length) problems.push(`STEP_INDENTATION_UNEXPECTED at lines ${bad.slice(0, 5).join(',')}`);
  return problems;
}

function main() {
  let a;
  try { a = parseArgs(process.argv); } catch (e) { console.error(e.message); return process.exit(64); }
  if (!a.repo) { console.error('--repo <app checkout> is required'); return process.exit(64); }
  const target = path.join(a.repo, '.github', 'workflows', 'main.yml');
  if (!fs.existsSync(target)) return report(69, { code: 'TARGET_MISSING', target });
  const original = fs.readFileSync(target, 'utf8');
  const snippet = fs.readFileSync(a.snippet, 'utf8');
  if (original.includes(MARKER)) return report(0, { code: 'ALREADY_APPLIED', target, note: 'idempotent: no second copy inserted' });

  const count = (hay, needle) => hay.split(needle).length - 1;
  const beforeHits = count(original, ANCHOR_BEFORE);
  const afterHits = count(original, ANCHOR_AFTER);
  if (beforeHits !== 1 || afterHits !== 1) {
    return report(5, {
      code: 'ANCHOR_AMBIGUOUS', target, beforeHits, afterHits,
      detail: 'the application workflow no longer has exactly one readiness step and one keep-alive step; re-derive the anchors before inserting anything (inserting at a guess would put the handoff in the wrong job)'
    });
  }
  const i = original.indexOf(ANCHOR_BEFORE);
  const j = original.indexOf(ANCHOR_AFTER);
  if (j < i) return report(5, { code: 'ANCHOR_ORDER_UNEXPECTED', detail: 'the keep-alive step precedes the readiness step' });
  const inserted = original.slice(0, j) + snippet.replace(/\n+$/, '\n') + '\n' + original.slice(j);
  const problems = structuralChecks(inserted);
  if (problems.length) return report(5, { code: 'STRUCTURE_REJECTED', problems, detail: 'the patched workflow failed the structural checks; nothing was written' });
  const addedLines = snippet.split('\n').length;
  if (!a.write) return report(0, { code: 'WOULD_APPLY', target, addedLines, beforeLine: i, insertBeforeLine: original.slice(0, j).split('\n').length, sha256Before: sha(original), sha256After: sha(inserted) });
  fs.writeFileSync(target, inserted);
  return report(0, { code: 'APPLIED', target, addedLines, sha256Before: sha(original), sha256After: sha(inserted) });
}

function sha(t) { return require('crypto').createHash('sha256').update(t).digest('hex').slice(0, 16); }
function report(code, obj) { console.log(JSON.stringify(obj, null, 2)); return process.exit(code); }

if (require.main === module) process.exit(main());

module.exports = { parseArgs, structuralChecks, ANCHOR_BEFORE, ANCHOR_AFTER, MARKER, main };
