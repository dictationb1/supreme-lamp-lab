#!/usr/bin/env node
'use strict';
// Renders the app's ACTUAL current feature inventory as an auditable table.
// Status columns are filled by run evidence when present; with no live run
// every row is NOT_RUN with the precise reason — never a silent skip.
const fs = require('fs');
const path = require('path');
const { buildInventory } = require('./lib/live-inventory');

const rows = buildInventory({ destructive: false });
const out = process.argv.includes('--json')
  ? null
  : process.argv.includes('--table')
    ? null
    : path.join(__dirname, '..', 'docs', 'feature-inventory.md');

const lines = [
  '# Mission Control — per-feature inventory (generated from the app contract)',
  '',
  `Generated: ${new Date().toISOString()} · rows: ${rows.length} · generator: \`scripts/inventory-doc.js\``,
  '',
  'Status meaning: `PASS`/`FAIL`/`BLOCKED` come from a real live run; `NOT_RUN` means no app-originated live run has executed the evaluator. `SKIPPED`/`NOT_APPLICABLE` always carry a reason. This table is a contract listing, not a claim of verification.',
  '',
  '| # | id | area | mandatory | requirement | preconditions | action | expected UI | expected server effect | evaluator | status |',
  '|---|---|---|---|---|---|---|---|---|---|---|'
];
rows.forEach((r, i) => {
  const cell = v => String(Array.isArray(v) ? v.join('; ') : (v == null ? '' : v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  lines.push(`| ${i + 1} | \`${r.id}\` | ${r.area} | ${r.mandatory === true ? 'yes' : r.mandatory === false ? 'no' : 'conditional'} | ${cell(r.requirement)} | ${cell(r.preconditions || [])} | ${cell(r.action)} | ${cell(r.expectUi)} | ${cell(r.expectServer)} | \`${r.evaluator}\` | NOT_RUN — no app-originated live run${r.preconditionGap ? ' (' + cell(r.preconditionGap) + ')' : ''} |`);
});
lines.push('', '## Wiring', '', 'Each row is evaluated by `scripts/lib/live-features.js` (`' + rows.map(r => r.evaluator).join('`, `') + '`). A mandatory row that is not `PASS` vetoes the run verdict in `summarizeInventory()`; downstream failures are reported separately from root causes.');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out} (${rows.length} rows)`);
