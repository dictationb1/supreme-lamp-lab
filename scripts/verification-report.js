#!/usr/bin/env node
'use strict';
// Final verdict for one workflow run attempt. Inputs (env):
//   NEEDS_JSON   toJSON(needs) - results + outputs of every job
//   APP_SHA, LAB_SHA, PR_HEAD_SHA, CORRELATION_ID, EVENT_NAME
// Output: verification-report.json (+ step summary + annotations).
// Exit 0 ONLY when verdict === 'VERIFIED' (every required capability PASS).

const fs = require('fs');
const path = require('path');
const { STATUS, aggregate } = require('./lib/status');
const { request } = require('./lib/http');
const annotate = require('./lib/annotate');
const { redactDeep } = require('./lib/redact');

// capability -> { job, output scope }
const REQUIRED = {
  browser_synthetic: { job: 'client', scope: 'client_local' },
  native_screenshot: { job: 'client', scope: 'client_local' },
  backend_readiness_server_local: { job: 'server', scope: 'server_local' },
  dashboard_server_local: { job: 'server', scope: 'server_local' },
  tailnet_connectivity: { job: 'client', scope: 'tailnet' },
  backend_readiness_remote: { job: 'client', scope: 'remote' },
  dashboard_client: { job: 'client', scope: 'remote' },
  web_desktop: { job: 'client', scope: 'remote' },
  rdp_auto_login: { job: 'client', scope: 'remote' }
};

/**
 * How a failure was *observed*, independent of which capability it broke.
 * A helper/diagnostic timeout means "not verified", never "backend crashed".
 */
function classifyBackendFailure(reason) {
  const r = String(reason || '');
  if (/BACKEND_EXITED|BACKEND_DIED|BACKEND_LISTEN_FAIL/.test(r)) return 'BACKEND_PROCESS_FAILED';
  if (/POWERSHELL_TIMEOUT|GUARD_IDENTITY_UNVERIFIED|GUARD_LISTENER_UNVERIFIED|GUARD_OWNERSHIP_UNVERIFIED|BUDGET_EXHAUSTED/.test(r)) return 'UNVERIFIED_DIAGNOSTIC_TIMEOUT';
  if (/READINESS_|VERSION_/.test(r)) return 'BACKEND_UNHEALTHY';
  return 'UNKNOWN';
}

/** Extract an explicit `category=CODE` marker or a named failure token. */
function causeCategory(reason) {
  const r = String(reason || '');
  const m = r.match(/category=([A-Z0-9_]+)/);
  if (m) return m[1];
  const t = r.match(/\b(TRUST_CREDENTIAL_REJECTED|TOKEN_EXCHANGE_[A-Z_]+|MISSING_CONFIG|OIDC_UNAVAILABLE|JOIN_FAILED_[A-Z_]+|SERVER_NEVER_JOINED_TAILNET|SUPERVISOR_[A-Z_]+|DEPENDS_ON_[A-Z_]+|BACKEND_[A-Z_]+|READINESS_[A-Z_]+|VERSION_[A-Z_]+)\b/);
  return t ? t[1] : null;
}

function subsystemOf(capability) {
  if (capability === 'tailnet_connectivity' || capability === 'backend_readiness_remote' || capability === 'dashboard_client' ||
      capability === 'web_desktop' || capability === 'rdp_auto_login') return 'tailnet_or_remote';
  if (capability === 'backend_readiness_server_local' || capability === 'dashboard_server_local') return 'server_local';
  return 'client_local';
}

function parseCaps(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return { __invalid: e.message }; }
}

/** Pure: build the capability table from the needs context. */
function build(needs) {
  const caps = {};
  const jobs = {};
  for (const [name, j] of Object.entries(needs || {})) jobs[name] = { result: j.result, outputs: j.outputs || {} };
  for (const [cap, src] of Object.entries(REQUIRED)) {
    const job = jobs[src.job];
    const entry = { status: STATUS.NOT_RUN, required: true, reason: null, source: `${src.job}.caps_${src.scope}` };
    if (!job) entry.reason = `JOB_${src.job.toUpperCase()}_ABSENT`;
    else {
      const parsed = parseCaps(job.outputs[`caps_${src.scope}`]);
      if (!parsed) entry.reason = `NO_RESULT: job ${src.job} result=${job.result} produced no ${src.scope} capability output`;
      else if (parsed.__invalid) { entry.status = STATUS.FAIL; entry.reason = `RESULT_UNPARSEABLE: ${parsed.__invalid}`; }
      else if (!parsed[cap]) entry.reason = `NO_RESULT: ${cap} missing from ${src.job} ${src.scope} output`;
      else {
        const s = parsed[cap].s;
        entry.status = Object.values(STATUS).includes(s) ? s : STATUS.FAIL;
        entry.reason = parsed[cap].r || (entry.status === s ? null : `INVALID_STATUS ${s}`);
      }
    }
    caps[cap] = entry;
  }
  const server = jobs.server ? jobs.server.outputs : {};
  const client = jobs.client ? jobs.client.outputs : {};
  // External tailnet failure is authoritative from the server side. The reason
  // carries the OBSERVED category (token-exchange probe), not a guess about the
  // credential subject.
  if (server.tailscale_outcome && server.tailscale_outcome !== 'success') {
    const category = server.tailnet_category || 'JOIN_FAILED_UNCLASSIFIED';
    const detail = server.tailnet_detail || `server tailscale step outcome=${server.tailscale_outcome}`;
    const why = server.ts_configured === 'false'
      ? 'MISSING_CONFIG: repository secrets TS_OAUTH_CLIENT_ID / TS_AUDIENCE are not set; the server cannot join the tailnet'
      : `EXTERNAL_TAILSCALE_JOIN_FAILED: category=${category}; ${detail}`;
    if (caps.tailnet_connectivity.status !== STATUS.FAIL) { caps.tailnet_connectivity.status = STATUS.BLOCKED; caps.tailnet_connectivity.reason = why; }
    for (const c of ['backend_readiness_remote', 'dashboard_client', 'web_desktop', 'rdp_auto_login']) {
      if (caps[c].status === STATUS.NOT_RUN || caps[c].status === STATUS.BLOCKED) { caps[c].status = STATUS.BLOCKED; caps[c].reason = `DEPENDS_ON_TAILNET: ${why}`; }
    }
  }
  // the remote backend must be the SAME process the server supervised
  if (caps.backend_readiness_remote.status === STATUS.PASS) {
    const remotePid = client.backend_pid_remote; const serverPid = server.backend_pid;
    if (!remotePid || !serverPid) { caps.backend_readiness_remote.status = STATUS.FAIL; caps.backend_readiness_remote.reason = `IDENTITY_UNVERIFIABLE: remote pid=${remotePid} server pid=${serverPid}`; }
    else if (String(remotePid) !== String(serverPid)) { caps.backend_readiness_remote.status = STATUS.FAIL; caps.backend_readiness_remote.reason = `REMOTE_BACKEND_IDENTITY_MISMATCH: remote reported pid ${remotePid}, server supervised pid ${serverPid}`; }
  }
  // rdp needs the server side to have been configured
  if (server.rdp_configured && server.rdp_configured !== 'true' && caps.rdp_auto_login.status !== STATUS.FAIL) {
    caps.rdp_auto_login.status = STATUS.BLOCKED;
    caps.rdp_auto_login.reason = `SERVER_RDP_NOT_CONFIGURED: ${server.rdp_reason || 'unknown'}`;
  }
  const agg = aggregate(caps);
  const staticOk = jobs.static ? jobs.static.result === 'success' : false;
  const verdict = agg.accepted && staticOk ? 'VERIFIED' : 'NOT_VERIFIED';
  const firstCause = !staticOk ? { capability: 'static', status: STATUS.FAIL, reason: `static job result=${jobs.static ? jobs.static.result : 'absent'}` } : agg.firstCause;

  // EVERY independently observed failure, so a single "first cause" field can
  // never hide a second one (e.g. a supervisor guard timeout AND a tailnet join
  // failure in the same attempt).
  const independentCauses = Object.entries(caps)
    .filter(([, c]) => c.required && c.status !== STATUS.PASS)
    .map(([name, c]) => ({
      capability: name,
      subsystem: subsystemOf(name),
      status: c.status,
      category: causeCategory(c.reason),
      reason: c.reason
    }));
  const bySubsystem = {};
  for (const c of independentCauses) {
    bySubsystem[c.subsystem] = bySubsystem[c.subsystem] || [];
    bySubsystem[c.subsystem].push(`${c.capability}=${c.status}` + (c.category ? ` (${c.category})` : ''));
  }
  const backendFailure = classifyBackendFailure(caps.backend_readiness_server_local && caps.backend_readiness_server_local.reason);
  const diagnostics = {
    supervisorFirstFailure: server.supervisor_first_failure || null,
    supervisorDegradedGuards: server.supervisor_degraded_guards || null,
    backendIdentityState: server.backend_identity_state || null,
    backendFailureClass: backendFailure,
    backendHealthProven: caps.backend_readiness_server_local.status === STATUS.PASS,
    tailscaleStepOutcome: server.tailscale_outcome || null,
    tailnetCategory: server.tailnet_category || (server.ts_configured === 'false' ? 'MISSING_CONFIG' : null),
    tailnetDetail: server.tailnet_detail || null,
    oidcSubject: server.oidc_sub || null,
    audienceMatchesConfigured: server.audience_matches === undefined ? null : server.audience_matches,
    rdpConfigured: server.rdp_configured || null,
    rdpReason: server.rdp_reason || null,
    prerequisitesMissing: independentCauses.filter(c => c.status === STATUS.BLOCKED).map(c => c.capability)
  };
  return {
    verdict, aggregate: agg.status, firstCause, independentCauses, bySubsystem, diagnostics,
    capabilities: caps, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.result]))
  };
}

async function runners() {
  const repo = process.env.GITHUB_REPOSITORY; const runId = process.env.GITHUB_RUN_ID; const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const token = process.env.GH_TOKEN;
  if (!repo || !runId || !token) return null;
  const r = await request(`https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { timeoutMs: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab' } });
  if (!r.json || !r.json.jobs) return null;
  return r.json.jobs.map(j => ({ name: j.name, id: j.id, status: j.status, conclusion: j.conclusion, runner: j.runner_name, labels: j.labels, startedAt: j.started_at, completedAt: j.completed_at }));
}

async function main() {
  const needs = JSON.parse(process.env.NEEDS_JSON || '{}');
  const result = build(needs);
  const report = redactDeep({
    schema: 2,
    generatedAt: new Date().toISOString(),
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.EVENT_NAME,
    correlationId: process.env.CORRELATION_ID || null,
    labCommit: process.env.LAB_SHA,
    prHeadCommit: process.env.PR_HEAD_SHA || null,
    appRepository: 'dictationb1/supreme-lamp',
    appCommit: process.env.APP_SHA || null,
    ...result,
    jobsDetail: await runners()
  });
  const out = process.env.REPORT_PATH || path.join(process.cwd(), 'verification-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const rows = Object.entries(report.capabilities).map(([k, c]) => `| ${k} | ${c.status} | ${String(c.reason || '').replace(/\|/g, '\\|').slice(0, 220)} |`);
  const md = [`## Verification verdict: **${report.verdict}**`, '', `run ${report.runId} attempt ${report.runAttempt} · lab ${report.labCommit} · app ${report.appCommit}`, '',
    report.firstCause ? `First cause: \`${report.firstCause.capability}\` = ${report.firstCause.status} — ${report.firstCause.reason}` : '', '',
    report.independentCauses && report.independentCauses.length > 1
      ? `Independent causes (${report.independentCauses.length}): ${report.independentCauses.map(c => `\`${c.capability}\` ${c.status}${c.category ? ` [${c.category}]` : ''}`).join('; ')}`
      : '', '',
    '| capability | status | reason |', '|---|---|---|', ...rows].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  const msg = `verdict=${report.verdict} ${Object.entries(report.capabilities).map(([k, c]) => `${k}=${c.status}`).join(' ')}`;
  if (report.verdict === 'VERIFIED') annotate.notice('Verification verdict', msg);
  else annotate.error('Verification verdict', `${msg} :: first cause ${report.firstCause && report.firstCause.capability}: ${report.firstCause && report.firstCause.reason}`);
  if (report.verdict !== 'VERIFIED' && report.independentCauses && report.independentCauses.length) {
    for (const c of report.independentCauses) {
      annotate.error(`independent cause ${c.capability}`, `${c.subsystem} ${c.status}${c.category ? ` ${c.category}` : ''}: ${String(c.reason || '').slice(0, 700)}`);
    }
  }
  process.exit(report.verdict === 'VERIFIED' ? 0 : 1);
}

if (require.main === module) main();
module.exports = { build, REQUIRED, classifyBackendFailure, causeCategory, subsystemOf };
