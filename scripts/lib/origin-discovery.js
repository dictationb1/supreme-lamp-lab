'use strict';
// ORIGIN DISCOVERY — the zero-application-change half of the automatic link.
// ---------------------------------------------------------------------------
// The application repository (`dictationb1/supreme-lamp`) is PUBLIC and its RDP
// workflow already publishes, while the server is still alive:
//
//   * a readiness marker  ("Dashboard API responded with valid readiness JSON")
//   * the run's own dashboard URL, including its `?key=` authorization
//     (`ps (7331) .........: http://100.x.y.z:7331/?key=...` in the keepalive
//      banner, and the Tailscale Serve form in the expose step)
//
// both inside the run's own Actions log. GitHub exposes that log for a public
// repository to any caller (HTTP 302 to a pre-signed blob), so the lab can
// discover and authenticate against the CORRECT live run with:
//   * no write access to the application repository,
//   * no cross-repository token or secret,
//   * no operator action of any kind.
//
// That is the least-complex integration that actually works under the measured
// permission split (the lab token has admin on this repository but its pushes
// to the application repository are refused with 403). The supported
// application-side envelope (`patches/app-live-run-signal.snippet.yml`) remains
// the SECURE upgrade path: it stops printing the key and hands the lab an
// encrypted, run-scoped envelope instead. Until that patch is applied, this
// module is what makes the integration automatic — and it reports the public
// credential exposure as a product finding rather than hiding it.
//
// WHAT IS NEVER TRUSTED HERE
//   * The endpoint is never "the newest server" and never a caller-supplied
//     target: it is read from the log OF THE EXACT RUN whose id, attempt,
//     workflow path and head sha came from GitHub's run API.
//   * A completed run is never attached to (its ephemeral host is gone).
//   * A log that predates the current attempt is impossible by construction
//     (Actions logs are per attempt) and the attempt is re-checked on the run
//     API immediately before the descriptor is built.
//   * Loopback, non-CGNAT and foreign-repository endpoints are refused.
//
// WHAT IS NEVER STORED HERE
//   The dashboard token is returned in memory (`secret.dashboardToken`) and is
//   never part of the descriptor, the evidence object, a log line or a file.

const crypto = require('crypto');
const { request, summarize } = require('./http');
const { extractZip } = require('./verify-origin');
const { registerSecret } = require('./redact');
const rd = require('./run-descriptor');

const ORIGIN_WORKFLOW_DEFAULT = '.github/workflows/main.yml';
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LOG_ENTRIES = 4000;
const MAX_LOG_ENTRY_BYTES = 16 * 1024 * 1024;
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;    // the application's ephemeral server lifetime
const MIN_TTL_MS = 3 * 60 * 1000;
const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function apiBase() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}
function token() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(pathname, { timeoutMs = 20000, allowStatus = [] } = {}) {
  const t = token();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'supreme-lamp-lab-origin-discovery'
  };
  // Public origin data needs no token at all. Sending one when present raises
  // the rate limit; it is never required and its absence is not an error.
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await request(`${apiBase()}${pathname}`, { timeoutMs, headers });
  if (allowStatus.includes(r.status)) return r;
  return r;
}

function fail(code, detail, extra = {}) {
  return { ok: false, code, detail: String(detail).slice(0, 600), ...extra };
}

/**
 * Follow a GitHub 302 to the pre-signed log blob WITHOUT forwarding the
 * Authorization header. The blob URL carries its own signature; leaking the
 * job token to it would be a credential-scope violation, and the signature is
 * all the blob needs.
 */
async function fetchSignedBlob(url, { timeoutMs = 60000, maxBytes = MAX_LOG_BYTES } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const r = await request(current, {
      timeoutMs,
      headers: { 'User-Agent': 'supreme-lamp-lab-origin-discovery' }
    });
    if (r.transport !== 'ok') return fail('LOG_TRANSPORT_ERROR', r.errorChain || summarize(r));
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      current = r.headers.location;
      continue;
    }
    if (r.status !== 200) return fail('LOG_HTTP_ERROR', `HTTP ${r.status} from the log blob`);
    const bytes = r.bytes || Buffer.alloc(0);
    if (bytes.length > maxBytes) return fail('LOG_TOO_LARGE', `${bytes.length} bytes > ${maxBytes}`);
    return { ok: true, bytes };
  }
  return fail('LOG_REDIRECT_LOOP', 'too many redirects for the log blob');
}

/** Download every log entry of one run ATTEMPT (per-attempt by construction). */
async function downloadRunLog({ originRepo, runId, timeoutMs = 60000 } = {}) {
  const t = token();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab-origin-discovery' };
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await request(`${apiBase()}/repos/${originRepo}/actions/runs/${runId}/logs`, {
    timeoutMs, headers
  });
  if (r.transport !== 'ok') return fail('LOG_TRANSPORT_ERROR', r.errorChain || summarize(r));
  if (r.status === 403 || r.status === 404) {
    return fail('LOG_UNAVAILABLE', `HTTP ${r.status}: the origin log is not readable from here (private origin, expired retention, or a permissions change)`);
  }
  if (r.status === 200) {
    // Defensive: a 200 with the archive inline.
    return { ok: true, bytes: r.bytes || Buffer.alloc(0) };
  }
  if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
    return fetchSignedBlob(r.headers.location, { timeoutMs });
  }
  return fail('LOG_HTTP_ERROR', `HTTP ${r.status}`);
}

/**
 * Parse the application's own banner/readiness lines out of a log archive.
 * Everything returned is sanitized EXCEPT `secret.token`, which the caller must
 * register with the redactor immediately and must never persist.
 */
function logShape(bytes) {
  // Diagnostic helper for the probe only: names + a sanitized sample, so an
  // unparseable log can be classified (encoding, truncation, wrong archive)
  // from an annotation instead of guessed at.
  try {
    const entries = extractZip(bytes, { maxEntries: MAX_LOG_ENTRIES, maxEntryBytes: MAX_LOG_ENTRY_BYTES });
    const named = entries.map(e => ({ name: e.name, bytes: e.data.length }));
    const biggest = entries.slice().sort((a, b) => b.data.length - a.data.length)[0];
    let sample = '';
    if (biggest) {
      sample = biggest.data.slice(0, 600).toString('utf8').replace(/key=[^&\s"']+/g, 'key=***');
    }
    return { entries: named.slice(0, 6), entryCount: entries.length, sample: sample.replace(/\u0000/g, '<NUL>') };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

function parseOriginLog(bytes, { now = Date.now() } = {}) {
  let entries;
  try {
    entries = extractZip(bytes, { maxEntries: MAX_LOG_ENTRIES, maxEntryBytes: MAX_LOG_ENTRY_BYTES });
  } catch (e) {
    return fail('LOG_ARCHIVE_INVALID', e.message);
  }
  const readinessLines = [];
  const bannerLines = [];
  let matchedKey = null;
  let matchedUrl = null;
  let scannedBytes = 0;
  for (const e of entries) {
    const name = String(e.name || '');
    if (!/\.txt$/i.test(name) && !/\.log$/i.test(name)) continue;
    const text = e.data.toString('utf8');
    scannedBytes += text.length;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/Dashboard API responded with valid readiness JSON/i.test(line) ||
          /-\s*Dashboard API Ready:\s*True/i.test(line)) {
        if (readinessLines.length < 10) readinessLines.push(line.slice(0, 200));
      }
      // Keepalive banner:  `ps (7331) .........: http://100.x.y.z:7331/?key=...`
      // Serve banner:     `Dashboard (serve) ..: https://host.ts.net/?key=...`
      if (/ps \(7331\)|Dashboard \(serve\)/i.test(line)) {
        const m = line.match(/(https?:\/\/[^\s)]+)/);
        if (m) {
          const url = m[1].replace(/[.,;]+$/, '');
          let u = null;
          try { u = new URL(url); } catch (e) { u = null; }
          if (u && u.searchParams.get('key')) {
            // The LAST occurrence wins: a restarted server re-prints the banner,
            // and the newest line is the one that belongs to the live instance.
            matchedKey = u.searchParams.get('key');
            matchedUrl = `${u.protocol}//${u.host}${u.pathname}`.replace(/\?$/, '');
            bannerLines.push(line.replace(/key=[^&\s]+/g, 'key=***').slice(0, 200));
          }
        }
      }
    }
  }
  const endpoint = matchedUrl ? new URL(matchedUrl) : null;
  const host = endpoint ? endpoint.hostname.replace(/^\[|\]$/g, '') : '';
  const isCgnat = CGNAT_V4.test(host);
  const isFqdn = /\.ts\.net\.?$/i.test(host);
  const evidence = {
    entries: entries.length,
    scannedBytes,
    readinessLines,
    ready: readinessLines.length > 0,
    bannerLines: bannerLines.slice(-5),
    endpoint: matchedUrl,
    endpointHost: host || null,
    endpointKind: isCgnat ? 'tailnet-ipv4' : (isFqdn ? 'tailnet-fqdn' : (host ? 'other' : 'none')),
    keyPresent: Boolean(matchedKey),
    keyFingerprint: matchedKey ? crypto.createHash('sha256').update(matchedKey, 'utf8').digest('hex') : null,
    keyMaskedLength: matchedKey ? String(matchedKey).length : 0
  };
  if (!matchedKey || !matchedUrl) {
    return { ...fail('ORIGIN_LOG_NO_ENDPOINT', 'the origin log carries no dashboard URL with a current-run key yet (the server has not reached its readiness banner in this attempt)'), evidence };
  }
  if (!isCgnat) {
    return { ...fail('ORIGIN_ENDPOINT_NOT_TAILNET', `endpoint host ${JSON.stringify(host)} is not a Tailscale CGNAT address; a lab run may not be steered to an arbitrary host`), evidence };
  }
  if (!evidence.ready) {
    return { ...fail('ORIGIN_NOT_READY_IN_LOG', 'the readiness marker is absent from this attempt (the server had not answered its own readiness probe when the banner printed)'), evidence };
  }
  return {
    ok: true,
    evidence,
    secret: { dashboardToken: matchedKey },
    endpoint: { url: `${endpoint.protocol}//${endpoint.host}`, host, port: Number(endpoint.port || 80) }
  };
}

/** The run must be the one the descriptor names: same repo, path, attempt, sha. */
function runMatches(run, { originRepo, originWorkflow, runId, attempt }) {
  const problems = [];
  if (!run) return ['no run object'];
  if (String(run.id) !== String(runId)) problems.push(`run id ${run.id} != ${runId}`);
  if (String(run.path || '') !== String(originWorkflow)) problems.push(`path ${JSON.stringify(run.path)} != ${JSON.stringify(originWorkflow)}`);
  if (attempt !== undefined && attempt !== null && attempt !== '' && Number(run.run_attempt) !== Number(attempt)) {
    problems.push(`attempt ${run.run_attempt} != ${attempt}`);
  }
  if (String((run.head_repository && run.head_repository.full_name) || '') !== String(originRepo)) {
    problems.push(`head repository ${JSON.stringify(run.head_repository && run.head_repository.full_name)} != ${originRepo}`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(run.head_sha || ''))) problems.push(`head_sha ${JSON.stringify(run.head_sha)} is not 40-hex`);
  return problems;
}

/**
 * The part of a descriptor that must not change when the same run is
 * re-discovered later. `issuedAt`/`expiresAt` are re-derived by every sweep, so
 * the full descriptor id (which signs them) legitimately differs across
 * sweeps; this identity is what a queued entry and the client that serves it
 * must agree on.
 */
function stableIdentity(d) {
  const parts = [
    d.originRepo, d.originRunId, d.originAttempt, d.appSha,
    d.authorizedEndpoint, d.dashTokenFingerprint, d.correlationId
  ].map(v => String(v));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function buildDescriptor({ originRepo, originWorkflow, run, endpoint, fingerprint, labRevision, now = Date.now() }) {
  const issuedMs = now;
  const runStarted = Date.parse(run.run_started_at || run.created_at || 0) || now;
  const hardStop = runStarted + 6 * 60 * 60 * 1000;           // ephemeral server lifetime
  const expiresMs = Math.min(issuedMs + MAX_TTL_MS, hardStop);
  if (expiresMs - issuedMs < MIN_TTL_MS) {
    return fail('ORIGIN_EXPIRED', `the run started ${new Date(runStarted).toISOString()}; its 6h server window leaves <${Math.round(MIN_TTL_MS / 60000)}min, so the queue cannot be served fairly`);
  }
  const descriptor = {
    protocol: rd.PROTOCOL,
    originRepo,
    originWorkflow,
    originRunId: Number(run.id),
    originAttempt: Number(run.run_attempt || 1),
    appSha: String(run.head_sha),
    // The UI the run serves is the F59 prebuilt bundle named after the same sha
    // (`ui-dist-<sha>.zip`); the live bundle is re-checked in the browser.
    uiBuild: `ui-dist-${String(run.head_sha)}`,
    // The backend instance is the tailnet host the run's own banner advertised.
    // A restarted server keeps the address; the session stamp is re-read live.
    backendIdentity: `${endpoint.host}:${endpoint.port}`.slice(0, 90),
    authorizedEndpoint: endpoint.url,
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    labRevision: labRevision || 'unknown',
    correlationId: `lr-${run.id}-${run.run_attempt || 1}`,
    dashTokenFingerprint: fingerprint,
    clientTailnetIp: '',
    mode: 'live-origin'
  };
  try {
    const v = rd.validateDescriptor(descriptor, { now: issuedMs });
    return { ok: true, descriptor: { ...v, stableIdentity: stableIdentity(v) } };
  } catch (e) {
    return fail(e.code || 'DESCRIPTOR_INVALID', e.message || String(e));
  }
}

/**
 * Discover the live originating run.
 *
 * Selection is explicit and deterministic:
 *   explicitRunId  -> exactly that run (and attempt, when given)
 *   otherwise      -> the requested workflow's runs that GitHub still reports
 *                     as `in_progress`, OLDEST first among the ones whose log
 *                     carries a live readiness banner (never "the newest").
 *
 * A run whose log has no banner yet is NOT an error that stops the sweep: it is
 * reported as `not_yet_ready` and the next sweep re-reads it. Nothing queues it.
 */
async function discoverOrigin({
  originRepo,
  originWorkflow = ORIGIN_WORKFLOW_DEFAULT,
  explicitRunId = 0,
  explicitAttempt = 0,
  labRevision = 'unknown',
  maxCandidates = 6,
  now = Date.now()
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(originRepo || ''))) {
    return fail('ORIGIN_REPO_INVALID', JSON.stringify(originRepo));
  }
  const allowed = (rd.validateDescriptor.allowedOriginRepos || []);
  if (allowed.length && !allowed.includes(originRepo)) {
    return fail('ORIGIN_REPO_NOT_ALLOWED', `${originRepo} is not in the configured allowlist (${allowed.join(', ')})`);
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(String(originWorkflow))) {
    return fail('ORIGIN_WORKFLOW_INVALID', JSON.stringify(originWorkflow));
  }

  const candidates = [];
  if (explicitRunId) {
    const r = await apiGet(`/repos/${originRepo}/actions/runs/${explicitRunId}`);
    if (r.status === 404) return fail('ORIGIN_RUN_NOT_FOUND', `no run ${explicitRunId} in ${originRepo}`);
    if (!r.ok || !r.json || !r.json.id) return fail('ORIGIN_RUN_LOOKUP_FAILED', summarize(r));
    candidates.push(r.json);
  } else {
    const r = await apiGet(`/repos/${originRepo}/actions/runs?status=in_progress&per_page=30`);
    if (!r.ok || !r.json || !Array.isArray(r.json.workflow_runs)) {
      return fail('ORIGIN_LIST_FAILED', summarize(r));
    }
    const matches = r.json.workflow_runs.filter(x => String(x.path || '') === originWorkflow);
    // Oldest first: a queue that always jumps to the freshest run starves the
    // origin whose server is already counting down its six-hour window.
    matches.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    candidates.push(...matches.slice(0, maxCandidates));
  }

  const rejected = [];
  for (const run of candidates) {
    const id = run.id;
    const attempt = run.run_attempt || 1;
    if (explicitAttempt && Number(attempt) !== Number(explicitAttempt)) {
      rejected.push({ runId: id, attempt, code: 'ATTEMPT_NOT_REQUESTED' });
      continue;
    }
    if (String(run.status) !== 'in_progress') {
      rejected.push({ runId: id, attempt, code: 'ORIGIN_NOT_IN_PROGRESS', status: run.status });
      continue;
    }
    const startedMs = Date.parse(run.run_started_at || run.created_at || 0);
    if (!startedMs || now - startedMs > RUN_MAX_AGE_MS) {
      rejected.push({ runId: id, attempt, code: 'ORIGIN_TOO_OLD', startedAt: run.run_started_at || run.created_at });
      continue;
    }
    const problems = runMatches(run, { originRepo, originWorkflow, runId: id, attempt });
    if (problems.length) {
      rejected.push({ runId: id, attempt, code: 'ORIGIN_RUN_MISMATCH', detail: problems.join('; ') });
      continue;
    }
    const log = await downloadRunLog({ originRepo, runId: id });
    if (!log.ok) {
      rejected.push({ runId: id, attempt, code: log.code, detail: log.detail });
      continue;
    }
    const parsed = parseOriginLog(log.bytes, { now });
    if (!parsed.ok) {
      rejected.push({ runId: id, attempt, code: parsed.code, detail: parsed.detail, evidence: parsed.evidence });
      continue;
    }
    registerSecret(parsed.secret.dashboardToken, 'ORIGIN_DASH_TOKEN');
    const desc = buildDescriptor({
      originRepo, originWorkflow, run,
      endpoint: parsed.endpoint,
      fingerprint: parsed.evidence.keyFingerprint,
      labRevision, now
    });
    if (!desc.ok) {
      rejected.push({ runId: id, attempt, code: desc.code, detail: desc.detail });
      continue;
    }
    const highWater = await apiGet(`/repos/${originRepo}/actions/runs/${id}`);
    if (highWater.ok && highWater.json && Number(highWater.json.run_attempt) !== Number(attempt)) {
      rejected.push({ runId: id, attempt, code: 'ATTEMPT_SUPERSEDED', currentAttempt: highWater.json.run_attempt });
      continue;
    }
    if (highWater.ok && highWater.json && String(highWater.json.status) !== 'in_progress') {
      rejected.push({ runId: id, attempt, code: 'ORIGIN_COMPLETED_DURING_DISCOVERY', status: highWater.json.status });
      continue;
    }
    return {
      ok: true,
      code: 'ORIGIN_DISCOVERED',
      descriptor: desc.descriptor,
      secret: parsed.secret,
      origin: {
        repo: originRepo,
        workflow: originWorkflow,
        runId: Number(id),
        attempt: Number(attempt),
        appSha: String(run.head_sha),
        event: run.event,
        status: run.status,
        startedAt: run.run_started_at || run.created_at,
        url: `https://github.com/${originRepo}/actions/runs/${id}`
      },
      evidence: {
        ...parsed.evidence,
        // A public origin log is a public credential. Record the fact, not the
        // value, so the report can name the product defect precisely.
        originLogPubliclyReadable: true,
        selection: explicitRunId ? 'explicit-run-id' : 'oldest-in-progress-with-live-banner',
        rejected
      }
    };
  }
  return fail('NO_LIVE_ORIGIN', rejected.length
    ? `no attachable live origin (${rejected.map(r => `${r.runId}/${r.attempt}:${r.code}`).join(', ')})`
    : `no ${originWorkflow} run is in progress in ${originRepo}`, { evidence: { rejected } });
}

/**
 * Sanitized, read-only probe used by the diagnostics workflow: it answers
 * "what would discovery decide right now, and why" without touching a client
 * VM and without exposing a credential.
 */
async function probeOrigin({ originRepo, originWorkflow = ORIGIN_WORKFLOW_DEFAULT, explicitRunId = 0, allowCompleted = true } = {}) {
  const out = { generatedAt: new Date().toISOString(), originRepo, originWorkflow, runs: [] };
  let runs = [];
  if (explicitRunId) {
    const r = await apiGet(`/repos/${originRepo}/actions/runs/${explicitRunId}`);
    if (!r.ok || !r.json || !r.json.id) return fail('ORIGIN_RUN_LOOKUP_FAILED', summarize(r), { probe: out });
    runs = [r.json];
  } else {
    // The application dispatch lane is `workflow_dispatch`; filtering by event
    // keeps a busy scheduled workflow (its replay publisher runs every ~30 min)
    // from crowding a 30-item page out of the diagnostic.
    const r = await apiGet(`/repos/${originRepo}/actions/runs?event=workflow_dispatch&per_page=100`);
    if (!r.ok || !r.json || !Array.isArray(r.json.workflow_runs)) return fail('ORIGIN_LIST_FAILED', summarize(r), { probe: out });
    const all = r.json.workflow_runs;
    const forWorkflow = all.filter(x => String(x.path || '') === originWorkflow);
    out.listed = { total: all.length, matchingWorkflow: forWorkflow.length, workflow: originWorkflow };
    runs = forWorkflow.slice(0, 5);
    if (!runs.length) {
      out.pathsSeen = Array.from(new Set(all.map(x => String(x.path || '?')))).slice(0, 8);
    }
  }
  for (const run of runs) {
    const row = {
      runId: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion,
      event: run.event, headSha: String(run.head_sha || '').slice(0, 12), startedAt: run.run_started_at || run.created_at
    };
    if (!allowCompleted && String(run.status) !== 'in_progress') { row.decision = 'SKIPPED_NOT_IN_PROGRESS'; out.runs.push(row); continue; }
    const log = await downloadRunLog({ originRepo, runId: run.id });
    if (!log.ok) { row.decision = log.code; row.detail = log.detail; out.runs.push(row); continue; }
    const parsed = parseOriginLog(log.bytes);
    // A completed run's log is still the best available proof that the parser
    // works against real application bytes; it is never attachable, and the
    // decision says exactly that instead of implying a live session.
    row.decision = parsed.ok
      ? (String(run.status) === 'in_progress' ? 'WOULD_ATTACH' : 'WOULD_ATTACH_NOT_NOW')
      : parsed.code;
    row.attachableNow = parsed.ok && String(run.status) === 'in_progress';
    row.detail = parsed.ok ? null : String(parsed.detail).slice(0, 200);
    if (!parsed.ok) row.shape = logShape(log.bytes);
    row.log = parsed.evidence ? {
      entries: parsed.evidence.entries,
      ready: parsed.evidence.ready,
      endpointKind: parsed.evidence.endpointKind,
      endpointHost: parsed.evidence.endpointHost,
      keyPresent: parsed.evidence.keyPresent,
      keyFingerprint16: parsed.evidence.keyFingerprint ? parsed.evidence.keyFingerprint.slice(0, 16) : null,
      bannerLines: parsed.evidence.bannerLines
    } : null;
    out.runs.push(row);
  }
  const attachable = out.runs.filter(r => r.decision === 'WOULD_ATTACH' && r.status === 'in_progress');
  return {
    ok: attachable.length > 0,
    code: attachable.length ? 'PROBE_WOULD_ATTACH' : 'PROBE_NO_ATTACHABLE_RUN',
    detail: attachable.length ? `${attachable.length} run(s) would be attached` : 'no run currently carries a live, ready banner',
    probe: out
  };
}

module.exports = {
  ORIGIN_WORKFLOW_DEFAULT,
  discoverOrigin,
  probeOrigin,
  parseOriginLog,
  logShape,
  downloadRunLog,
  fetchSignedBlob,
  buildDescriptor,
  stableIdentity,
  runMatches,
  CGNAT_V4,
  MAX_TTL_MS
};
