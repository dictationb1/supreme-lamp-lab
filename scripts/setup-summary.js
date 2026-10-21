#!/usr/bin/env node
'use strict';
// Summary for a SETUP run (workflow_dispatch mode=consent-setup).
//
// A SETUP run exists to give the operator a bounded window to answer the
// one-time Windows RDP-file consent dialog. It is NOT an acceptance run: it
// produces no capability verdicts and can never be reported as VERIFIED. This
// script writes that summary explicitly, so a reader of the run cannot mistake
// a successful setup for a passing verification.

const fs = require('fs');

function main() {
  const mode = process.env.MODE || '';
  const state = process.env.SETUP_STATE || '';
  const detail = process.env.SETUP_DETAIL || '';
  let needs = {};
  try { needs = JSON.parse(process.env.NEEDS_JSON || '{}'); } catch (e) { needs = {}; }
  const job = name => (needs[name] && needs[name].result) || 'unknown';

  const doc = {
    kind: 'SETUP',
    verdict: 'NO_VERDICT_SETUP_MODE',
    note: 'This run only opened the consent window for the operator. It is not a verification run, ' +
      'it never clicks the consent dialog, and nothing here can make the lab VERIFIED. ' +
      'The acceptance evidence remains a fresh full run (mode=full) with no manual clicks and no credential entry.',
    mode,
    labSha: process.env.LAB_SHA || null,
    setupState: state || 'UNKNOWN',
    setupDetail: detail || null,
    jobs: { static: job('static'), server: job('server'), client: job('client') },
    finishedAtUtc: new Date().toISOString()
  };

  const outPath = process.env.SETUP_SUMMARY_PATH || 'setup-summary.json';
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);

  const lines = [
    '## SETUP run - no verification verdict',
    '',
    '> This is **not** an acceptance run. It exists only to give the operator a bounded window',
    '> to answer the one-time Windows RDP-file consent dialog. Nothing here is `VERIFIED`.',
    '',
    `| field | value |`,
    `|---|---|`,
    `| mode | \`${mode}\` |`,
    `| setup state | \`${doc.setupState}\` |`,
    `| setup detail | ${doc.setupDetail || '_none_'} |`,
    `| lab commit | \`${doc.labSha}\` |`,
    `| static / server / client | ${doc.jobs.static} / ${doc.jobs.server} / ${doc.jobs.client} |`,
    '',
    'Next step: run the workflow with **mode=full**. It must complete with no manual clicks and',
    'no credential entry before any capability can be reported as passing.',
    ''
  ];
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`); } catch (e) { /* summary only */ }
  }
  console.log(lines.join('\n'));
  console.log(`::notice title=SETUP summary::state=${doc.setupState} (no verification verdict was produced)`);

  // A SETUP window that could not even present a live target is a real failure.
  const bad = !doc.setupState || doc.setupState === 'UNKNOWN' || doc.setupState === 'BLOCKED_NO_LIVE_TARGET';
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
