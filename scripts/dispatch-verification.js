#!/usr/bin/env node
'use strict';
// Dispatch the capability workflow and follow THAT run to completion.
//
//   GH_TOKEN=... node scripts/dispatch-verification.js --ref main [--source-sha <40hex>] [--mode full|auth-diagnostic] [--timeout-min 60]
//
// The run is identified by a fresh correlation id that the workflow puts in
// its run-name (display_title), so concurrent runs can never be confused.
// Exit code: 0 only if the run concludes "success" (i.e. the report job said
// VERIFIED); 1 for any other conclusion; 2 for dispatch/lookup errors.

const crypto = require('crypto');
const { request } = require('./lib/http');

const WORKFLOW = 'capability-check.yml';

function parseArgs(argv) {
  const a = { ref: 'main', sourceSha: '', mode: 'full', timeoutMin: 60, repo: process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--ref') a.ref = argv[++i];
    else if (argv[i] === '--source-sha') a.sourceSha = argv[++i];
    else if (argv[i] === '--mode') a.mode = argv[++i];
    else if (argv[i] === '--timeout-min') a.timeoutMin = Number(argv[++i]);
    else if (argv[i] === '--repo') a.repo = argv[++i];
  }
  return a;
}

async function api(method, pathname, body) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required');
  const r = await request(`https://api.github.com${pathname}`, {
    method, timeoutMs: 30000, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'supreme-lamp-lab' }
  });
  if (r.transport !== 'ok') throw new Error(`${method} ${pathname}: ${r.errorChain}`);
  return r;
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function main() {
  const a = parseArgs(process.argv);
  const correlationId = `cv-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const inputs = { correlation_id: correlationId, mode: a.mode };
  if (a.sourceSha) inputs.source_sha = a.sourceSha;
  const d = await api('POST', `/repos/${a.repo}/actions/workflows/${WORKFLOW}/dispatches`, { ref: a.ref, inputs });
  if (d.status !== 204) { console.error(`dispatch failed: HTTP ${d.status} ${d.text}`); process.exit(2); }
  console.log(`dispatched ${WORKFLOW}@${a.ref} correlation_id=${correlationId}`);

  let run = null;
  const findDeadline = Date.now() + 5 * 60000;
  while (!run && Date.now() < findDeadline) {
    await sleep(5000);
    const r = await api('GET', `/repos/${a.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
    run = (r.json && r.json.workflow_runs || []).find(x => String(x.display_title || '').includes(correlationId)) || null;
  }
  if (!run) { console.error(`run with correlation id ${correlationId} not found within 5 min`); process.exit(2); }
  console.log(`run ${run.id} attempt ${run.run_attempt}: ${run.html_url}`);

  const deadline = Date.now() + a.timeoutMin * 60000;
  let last = '';
  while (Date.now() < deadline) {
    const r = await api('GET', `/repos/${a.repo}/actions/runs/${run.id}`);
    run = r.json;
    const state = `${run.status}/${run.conclusion}`;
    if (state !== last) { console.log(`${new Date().toISOString()} ${state}`); last = state; }
    if (run.status === 'completed') break;
    await sleep(20000);
  }
  if (run.status !== 'completed') { console.error(`run ${run.id} not completed within ${a.timeoutMin} min`); process.exit(2); }
  const jobs = await api('GET', `/repos/${a.repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  for (const j of (jobs.json && jobs.json.jobs) || []) console.log(`  job ${j.name}: ${j.conclusion} (runner ${j.runner_name || '-'}) id=${j.id}`);
  console.log(JSON.stringify({ runId: run.id, attempt: run.run_attempt, headSha: run.head_sha, conclusion: run.conclusion, correlationId }));
  process.exit(run.conclusion === 'success' ? 0 : 1);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(2); });
module.exports = { parseArgs };
