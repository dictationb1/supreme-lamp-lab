#!/usr/bin/env node
'use strict';
// PUBLIC-ONLY PROOF: does the published MC-SIGNAL belong to THIS run?
//
//   node scripts/verify-signal-binding.js --origin-repo dictationb1/supreme-lamp --origin-run 39952421153
//
// Reads two PUBLIC GitHub facts and nothing else:
//   * the run object for `--origin-run` (id, run_attempt, head_sha, status);
//   * the `mission-control-live-signal` check run published on that head sha.
// Then it decodes the envelope and compares it to the run object. The sealed
// credential is inspected for SHAPE only - this tool never decrypts it, so its
// success is NOT the client-VM credential/ticket proof (that needs the lab
// private key on the self-hosted runner).
//
// Exit codes: 0 bound · 4 nothing attachable yet (not published / closed)
//             5 no evidence (unreadable run) · 7 contradicted · 64 usage
//
// Token: GITHUB_TOKEN or GH_TOKEN (read-only public scope is enough for the
// public application repository).

const fs = require('fs');
const https = require('https');
const { auditSignalBinding, SHA_RE } = require('./lib/signal-binding');
const { SIGNAL_NAME } = require('./lib/live-signal');

const EXIT = { OK: 0, BLOCKED: 4, NO_EVIDENCE: 5, CONTRADICTED: 7, USAGE: 64 };

function parseArgs(argv) {
  const a = { originRepo: 'dictationb1/supreme-lamp', originRun: 0, attempt: 0, jsonOut: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const n = argv[i + 1];
      if (n === undefined) throw Object.assign(new Error(`missing value for ${k}`), { code: 'USAGE' });
      i++;
      return n;
    };
    if (k === '--origin-repo') a.originRepo = v();
    else if (k === '--origin-run') a.originRun = Number(v());
    else if (k === '--origin-attempt') a.attempt = Number(v());
    else if (k === '--json-out') a.jsonOut = v();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw Object.assign(new Error(`unknown flag ${k}`), { code: 'USAGE' });
  }
  return a;
}

function apiGet(repoPath, token) {
  const url = `https://api.github.com${repoPath}`;
  return new Promise(resolve => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'supreme-lamp-lab-verify-signal-binding',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'
      },
      timeout: 20000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* non-JSON error body */ }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, json: null, body: String(e.message || e) }));
    req.end();
  });
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.help) {
    console.log('usage: node scripts/verify-signal-binding.js --origin-repo <owner/repo> --origin-run <id> [--origin-attempt <n>] [--json-out <file>]');
    return process.exit(EXIT.OK);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.originRepo) || !(a.originRun > 0)) {
    console.error('usage: --origin-repo <owner/repo> --origin-run <positive id>');
    return process.exit(EXIT.USAGE);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) {
    console.error('GITHUB_TOKEN/GH_TOKEN is required (read-only public access is enough)');
    return process.exit(EXIT.NO_EVIDENCE);
  }

  const runRes = await apiGet(`/repos/${a.originRepo}/actions/runs/${a.originRun}`, token);
  if (runRes.status !== 200 || !runRes.json) {
    const out = { schema: 1, ok: false, code: 'RUN_UNREADABLE', detail: `HTTP ${runRes.status}`, originRepo: a.originRepo, runId: a.originRun };
    if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return process.exit(EXIT.NO_EVIDENCE);
  }
  const run = runRes.json;
  // A named attempt is an assertion: never silently audit a different attempt.
  if (a.attempt && Number(a.attempt) !== Number(run.run_attempt)) {
    const out = {
      schema: 1, ok: false, code: 'ATTEMPT_NOT_CURRENT',
      detail: `requested attempt ${a.attempt} but the run's current attempt is ${run.run_attempt}`,
      originRepo: a.originRepo, runId: a.originRun, attempt: a.attempt
    };
    if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return process.exit(EXIT.CONTRADICTED);
  }
  if (!SHA_RE.test(String(run.head_sha || ''))) {
    const out = { schema: 1, ok: false, code: 'RUN_HEAD_SHA_INVALID', detail: String(run.head_sha || '') };
    if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return process.exit(EXIT.NO_EVIDENCE);
  }

  const checksRes = await apiGet(`/repos/${a.originRepo}/commits/${run.head_sha}/check-runs?per_page=100`, token);
  const rows = (checksRes.status === 200 && checksRes.json && Array.isArray(checksRes.json.check_runs)) ? checksRes.json.check_runs : [];
  const signals = rows
    .filter(c => c && c.name === SIGNAL_NAME)
    .sort((x, y) => String(y.started_at || '').localeCompare(String(x.started_at || '')));
  const audit = auditSignalBinding({ run, checkRun: signals[0] || null, originRepo: a.originRepo });

  const out = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    operation: 'verify-signal-binding',
    originRepo: a.originRepo,
    runId: Number(run.id),
    runAttempt: Number(run.run_attempt),
    headSha: run.head_sha,
    headBranch: run.head_branch || null,
    event: run.event || null,
    runStatus: run.status || null,
    runConclusion: run.conclusion || null,
    checkRunCount: rows.length,
    signalCheckRuns: signals.length,
    decrypted: false,
    credentialProof: 'NOT ATTEMPTED - the sealed credential is inspected for shape only; the client-VM job owns the decrypt/ticket proof',
    ok: audit.ok,
    code: audit.code,
    detail: audit.detail,
    evidence: audit.evidence
  };
  if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
  if (audit.ok) return process.exit(EXIT.OK);
  if (['SIGNAL_NOT_PUBLISHED', 'SIGNAL_NOT_LIVE'].includes(audit.code)) return process.exit(EXIT.BLOCKED);
  if (['SIGNAL_WRONG_CHECK', 'SIGNAL_CHECK_SHA_MISMATCH', 'SIGNAL_CIPHERTEXT_SHAPE'].includes(audit.code)) return process.exit(EXIT.CONTRADICTED);
  if (audit.code && (audit.code.startsWith('SIGNAL_') || audit.code.startsWith('APP_SIGNAL_'))) return process.exit(EXIT.CONTRADICTED);
  return process.exit(EXIT.NO_EVIDENCE);
}

main().catch(e => {
  console.error(String((e && e.message) || e));
  process.exit(e && e.code === 'USAGE' ? EXIT.USAGE : EXIT.NO_EVIDENCE);
});
