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
const { request, summarize } = require('./lib/http');
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
  const dep = r.match(/^(DEPENDS_ON_[A-Z0-9_]+)/);
  if (dep) return dep[1];
  const m = r.match(/category=([A-Z0-9_]+)/);
  if (m) return m[1];
  const t = r.match(/\b(TRUST_CREDENTIAL_REJECTED|TAG_NOT_PERMITTED|MISSING_AUTH_KEYS_PERMISSION|TAILSCALE_SERVICE_NOT_READY|CLIENT_VERSION_UNSUPPORTED|TAILSCALE_API_[A-Z_]+|TOKEN_EXCHANGE_[A-Z_]+|MISSING_CONFIG|OIDC_UNAVAILABLE|JOIN_FAILED_[A-Z_]+|SERVER_NEVER_JOINED_TAILNET|SUPERVISOR_[A-Z_]+|DEPENDS_ON_[A-Z_]+|BACKEND_[A-Z_]+|READINESS_[A-Z_]+|VERSION_[A-Z_]+)\b/);
  return t ? t[1] : null;
}

function isDownstreamDependency(reason) {
  return /^(DEPENDS_ON_[A-Z0-9_]+|SERVER_RDP_NOT_CONFIGURED)\b/.test(String(reason || ''));
}

/**
 * The named upstream a downstream BLOCKED depends on, or null for a root
 * cause. This is what keeps rdp_auto_login FAIL -> web_desktop BLOCKED a
 * single causal chain in the report instead of two "independent" causes
 * (run 39560693766 attempt 2 named the downstream web_desktop the *first*
 * cause merely because it is declared before rdp_auto_login above).
 */
function dependencyOf(capability, reason) {
  const r = String(reason || '');
  if (/^DEPENDS_ON_RDP_SESSION\b/.test(r)) return 'rdp_auto_login';
  if (/^DEPENDS_ON_TAILNET\b/.test(r)) return 'tailnet_connectivity';
  if (/^DEPENDS_ON_BACKEND\b/.test(r)) {
    return REQUIRED[capability] && REQUIRED[capability].scope === 'server_local'
      ? 'backend_readiness_server_local'
      : 'backend_readiness_remote';
  }
  if (/^SERVER_RDP_NOT_CONFIGURED\b/.test(r)) return 'server rdp preparation';
  return null;
}

function subsystemOf(capability) {
  if (capability === 'tailnet_connectivity' || capability === 'backend_readiness_remote' || capability === 'dashboard_client' ||
      capability === 'web_desktop' || capability === 'rdp_auto_login') return 'tailnet_or_remote';
  if (capability === 'backend_readiness_server_local' || capability === 'dashboard_server_local') return 'server_local';
  return 'client_local';
}

/** A regression summary is a GATE: all tests must pass, none may be skipped. */
function regressionGate(outputs, jobName) {
  const raw = outputs && outputs.caps_regressions;
  const base = { job: jobName, required: true, total: null, passed: null, failed: null, skipped: null, failures: [], reason: null };
  if (!raw) return { ...base, status: 'MISSING', reason: `NO_RESULT: job ${jobName} produced no caps_regressions output` };
  let s;
  try { s = JSON.parse(raw); } catch (e) { return { ...base, status: 'UNPARSEABLE', reason: `RESULT_UNPARSEABLE: ${e.message}` }; }
  const failures = Array.isArray(s.failures) ? s.failures.map(f => ({ name: String(f.name || '').slice(0, 200), detail: String(f.detail || '').slice(0, 400) })) : [];
  const skipped = Number(s.skipped || 0);
  const failed = Number(s.failed || 0);
  const browserRequired = s.requireBrowser !== false;
  const ok = failed === 0 && (!browserRequired || skipped === 0);
  return {
    ...base,
    status: ok ? 'PASS' : 'FAIL',
    total: Number(s.total || 0), passed: Number(s.passed || 0), failed, skipped,
    browserRequired,
    platform: s.platform || null,
    failures,
    reason: ok ? null : `REGRESSION_GATE_FAILED: ${failed} failed, ${skipped} skipped (browser e2e required=${browserRequired})`
  };
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
  // Regression suites are gates, not advisory: a green capability table must
  // never hide a failing (or skipped) required regression.
  const regressions = {
    static: regressionGate(jobs.static && jobs.static.outputs, 'static'),
    client: regressionGate(jobs.client && jobs.client.outputs, 'client')
  };
  const regressionFailures = Object.entries(regressions).filter(([, r]) => r.status !== 'PASS')
    .map(([job, r]) => ({ job, status: r.status, reason: r.reason, failures: r.failures, failed: r.failed, skipped: r.skipped }));
  const regressionsOk = regressionFailures.length === 0;
  const verdict = agg.accepted && staticOk && regressionsOk ? 'VERIFIED' : 'NOT_VERIFIED';

  // EVERY independently observed failure, so a single "first cause" field can
  // never hide a second one (e.g. a supervisor guard timeout AND a tailnet join
  // failure in the same attempt). Downstream entries carry dependsOn; they are
  // consequences of their named upstream, never additional root causes.
  const independentCauses = Object.entries(caps)
    .filter(([, c]) => c.required && c.status !== STATUS.PASS)
    .map(([name, c]) => ({
      capability: name,
      subsystem: subsystemOf(name),
      status: c.status,
      category: causeCategory(c.reason),
      dependsOn: dependencyOf(name, c.reason),
      reason: c.reason
    }));
  for (const r of regressionFailures) {
    independentCauses.push({
      capability: `regressions_${r.job}`, subsystem: 'regression', status: STATUS.FAIL,
      category: r.status === 'MISSING' ? 'REGRESSION_GATE_MISSING' : 'REGRESSION_GATE_FAILED',
      dependsOn: null,
      reason: `${r.reason}${r.failures && r.failures.length ? ` :: ${r.failures.map(f => f.name).join(' | ')}` : ''}`
    });
  }
  // First cause = first ROOT capability cause (in declared order). The bare
  // aggregate picks by insertion order, which named the downstream
  // web_desktop BLOCKED ahead of the rdp_auto_login FAIL it depends on.
  const rootCapabilityCauses = independentCauses.filter(c => !c.dependsOn && REQUIRED[c.capability]);
  const aggFirstCause = rootCapabilityCauses.length
    ? { capability: rootCapabilityCauses[0].capability, status: rootCapabilityCauses[0].status, reason: rootCapabilityCauses[0].reason }
    : agg.firstCause;
  let firstCause = !staticOk ? { capability: 'static', status: STATUS.FAIL, reason: `static job result=${jobs.static ? jobs.static.result : 'absent'}` } : aggFirstCause;
  if (!firstCause && !regressionsOk) {
    firstCause = { capability: 'regressions', status: STATUS.FAIL, reason: regressionFailures.map(r => `${r.job}: ${r.reason}`).join('; ') };
  }
  const counts = { pass: 0, fail: 0, blocked: 0, blockedDownstream: 0, notRun: 0, other: 0 };
  for (const c of Object.values(caps)) {
    if (c.status === STATUS.PASS) counts.pass++;
    else if (c.status === STATUS.FAIL) counts.fail++;
    else if (c.status === STATUS.BLOCKED) { counts.blocked++; if (isDownstreamDependency(c.reason)) counts.blockedDownstream++; }
    else if (c.status === STATUS.NOT_RUN) counts.notRun++;
    else counts.other++;
  }
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
    tailnetFirstError: server.tailnet_first_error || null,
    tailnetFailedOperation: server.tailnet_failed_operation || null,
    tailnetCliVersion: server.tailnet_cli_version || null,
    tailnetServiceState: server.tailnet_service_state || null,
    regressionGates: regressions,
    regressionGateFailures: regressionFailures,
    oidcSubject: server.oidc_sub || null,
    audienceMatchesConfigured: server.audience_matches === undefined ? null : server.audience_matches,
    rdpConfigured: server.rdp_configured || null,
    rdpReason: server.rdp_reason || null,
    prerequisitesMissing: independentCauses.filter(c => c.status === STATUS.BLOCKED).map(c => c.capability),
    rootCauses: independentCauses.filter(c => !isDownstreamDependency(c.reason)),
    downstreamBlocked: independentCauses.filter(c => isDownstreamDependency(c.reason)).map(c => ({
      capability: c.capability,
      subsystem: c.subsystem,
      category: c.category,
      dependsOn: c.dependsOn
    }))
  };
  return {
    verdict, aggregate: agg.status, counts, firstCause, independentCauses, bySubsystem, diagnostics, regressions,
    capabilities: caps, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.result]))
  };
}

const COMMENT_MARKER = '<!-- supreme-lamp-verification -->';

/**
 * Publish the same sanitized verdict that is written to the artifact as a PR
 * comment. Job logs and artifacts live on the results blob host, which some
 * driving tools cannot reach; a PR comment is readable through api.github.com,
 * so the evidence stays inspectable. Failure to comment never changes a verdict.
 */
async function publishPrComment(markdown, report) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const pr = process.env.PR_NUMBER;
  if (!repo || !token || !pr) return { published: false, reason: 'NO_PR_CONTEXT' };
  const headers = {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json', 'User-Agent': 'supreme-lamp-lab'
  };
  const body = `${COMMENT_MARKER}\n${markdown}\n\n<sub>verification-report-${report.runId}-${report.runAttempt}.json · lab ${report.labCommit || '?'} · app ${report.appCommit || '?'}</sub>`;
  const list = await request(`https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100`, { timeoutMs: 15000, headers });
  let existing = null;
  if (list.transport === 'ok' && Array.isArray(list.json)) {
    existing = list.json.find(c => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));
  }
  const url = existing
    ? `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`
    : `https://api.github.com/repos/${repo}/issues/${pr}/comments`;
  const r = await request(url, { method: existing ? 'PATCH' : 'POST', timeoutMs: 15000, headers, body: JSON.stringify({ body }) });
  return {
    published: Boolean(r.ok), updated: Boolean(existing && r.ok), created: Boolean(!existing && r.ok),
    id: (r.json && r.json.id) || (existing && existing.id) || null,
    status: r.status, error: r.ok ? null : summarize(r)
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
  const rows = Object.entries(report.capabilities).map(([k, c]) => `| ${k} | ${c.status} | ${String(c.reason || '').replace(/\|/g, '\\|').slice(0, 220)} |`);
  const rootCapsMd = ((report.diagnostics && report.diagnostics.rootCauses) || []).filter(c => report.capabilities[c.capability]);
  const downstreamMd = (report.diagnostics && report.diagnostics.downstreamBlocked) || [];
  const md = [`## Verification verdict: **${report.verdict}**`, '', `run ${report.runId} attempt ${report.runAttempt} · lab ${report.labCommit} · app ${report.appCommit}`, '',
    report.firstCause ? `First cause: \`${report.firstCause.capability}\` = ${report.firstCause.status} — ${report.firstCause.reason}` : '', '',
    rootCapsMd.length > 1
      ? `Independent causes (${rootCapsMd.length}): ${rootCapsMd.map(c => `\`${c.capability}\` ${c.status}${c.category ? ` [${c.category}]` : ''}`).join('; ')}`
      : '', '',
    downstreamMd.length
      ? `Downstream blocked (${downstreamMd.length}, consequences - not independent causes): ${downstreamMd.map(d => `\`${d.capability}\` ← ${d.dependsOn || d.category}`).join('; ')}`
      : '', '',
    '| capability | status | reason |', '|---|---|---|', ...rows, '',
    '### Regression gates', '',
    '| job | status | total | passed | failed | skipped |', '|---|---|---|---|---|---|',
    ...Object.entries(report.regressions).map(([job, r]) => `| ${job} | ${r.status} | ${r.total} | ${r.passed} | ${r.failed} | ${r.skipped} |`),
    '',
    ...Object.values(report.regressions).flatMap(r => (r.failures || []).map(f => `- **${r.job}** regression failed: \`${f.name}\` — ${f.detail}`)),
    report.diagnostics && report.diagnostics.tailnetFirstError
      ? `\n**Tailscale join failure (actual first error):** \`${String(report.diagnostics.tailnetFirstError).replace(/\|/g, '\\|')}\` (operation: ${report.diagnostics.tailnetFailedOperation || 'n/a'}, CLI ${report.diagnostics.tailnetCliVersion || '?'}, service ${report.diagnostics.tailnetServiceState || '?'})`
      : ''
  ].join('\n');
  report.publish = await publishPrComment(md, report);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  const msg = `verdict=${report.verdict} ${Object.entries(report.capabilities).map(([k, c]) => `${k}=${c.status}`).join(' ')}`;
  if (report.publish && report.publish.published) annotate.notice('verification report published', `PR comment ${report.publish.updated ? 'updated' : 'created'} (id=${report.publish.id})`);
  else if (report.publish && report.publish.reason !== 'NO_PR_CONTEXT') annotate.warning('verification report not published', String(report.publish.error || report.publish.reason));
  if (report.verdict === 'VERIFIED') annotate.notice('Verification verdict', msg);
  else annotate.error('Verification verdict', `${msg} :: first cause ${report.firstCause && report.firstCause.capability}: ${report.firstCause && report.firstCause.reason}`);
  if (report.regressions) {
    for (const [job, r] of Object.entries(report.regressions)) {
      if (r.status === 'PASS') annotate.notice(`regression gate ${job}`, `${r.total} tests: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`);
      else annotate.error(`regression gate ${job}`, `${r.reason} :: ${(r.failures || []).map(f => f.name).join(' | ') || 'no named failures'}`);
    }
  }
  if (report.diagnostics && report.diagnostics.tailnetFirstError) {
    annotate.error('tailscale join failure (actual first error)', `${report.diagnostics.tailnetFirstError} (operation=${report.diagnostics.tailnetFailedOperation || 'n/a'} cli=${report.diagnostics.tailnetCliVersion || '?'} service=${report.diagnostics.tailnetServiceState || '?'})`);
  }
  if (report.verdict !== 'VERIFIED' && report.diagnostics && report.diagnostics.rootCauses) {
    for (const c of report.diagnostics.rootCauses) {
      annotate.error(`independent cause ${c.capability}`, `${c.subsystem} ${c.status}${c.category ? ` ${c.category}` : ''}: ${String(c.reason || '').slice(0, 700)}`);
    }
    if (report.diagnostics.downstreamBlocked && report.diagnostics.downstreamBlocked.length) {
      annotate.warning(
        'downstream blocked capabilities',
        report.diagnostics.downstreamBlocked.map(d => `${d.capability} (${d.category})`).join(', ')
      );
    }
  }
  process.exit(report.verdict === 'VERIFIED' ? 0 : 1);
}

if (require.main === module) main();
module.exports = { build, REQUIRED, classifyBackendFailure, causeCategory, subsystemOf, regressionGate, dependencyOf };
