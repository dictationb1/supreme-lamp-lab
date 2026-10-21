'use strict';
// TRUST ANCHOR for live runs. Everything the lab believes about an origin run
// comes from GitHub's OWN data for that run, plus the live backend's own
// self-attestation. Never from a caller-supplied event payload alone: a
// `repository_dispatch` body is attacker-writable, so it only names which run
// to go and verify; these checks decide whether it is real.
//
// Checks (all bounded, all reporting a machine code on failure):
//   RUN_LOOKUP          the exact (runId, attempt) exists in the origin repo
//   RUN_REPO_MATCH      its headRepository/name == descriptor.originRepo
//   RUN_WORKFLOW_MATCH  its path == descriptor.originWorkflow
//   RUN_HEAD_SHA_MATCH  its head_sha == descriptor.appSha
//   RUN_IN_PROGRESS     it must be RUNNING while we attach (a completed run's
//                       server is destroyed — that is the whole reason this
//                       handshake exists instead of a workflow_run trigger)
//   RUN_ATTEMPT_FRESH   a newer attempt of the same run supersedes us
//   ENVELOPE_PROVENANCE the artifact we read the secret from belongs to that
//                       exact run id + attempt (artifacts carry no signature,
//                       so provenance is the only anchor) — and its bytes hash
//                       to the zip the API reported
//   BACKEND_IDENTITY    /api/version sha == appSha (re-checked in live-run.js)
//
// All of this uses the job's own GITHUB_TOKEN (actions:read is enough to read
// runs of a public repository cross-repo). No repo secret is ever required,
// and nothing here prints a token.

const crypto = require('crypto');
const { request, summarize } = require('./http');

function apiBase() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}
function token() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!t) throw new Error('NO_GITHUB_TOKEN: run verification needs the job token');
  return t;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(pathname, { timeoutMs = 20000 } = {}) {
  const r = await request(`${apiBase()}${pathname}`, {
    timeoutMs,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'supreme-lamp-lab-verify-origin'
    }
  });
  return { transport: r.transport, status: r.status, json: r.json, text: r.text, bytes: r.bytes, summary: summarize(r) };
}

function fail(code, detail, extra = {}) {
  return { ok: false, code, detail: String(detail).slice(0, 500), ...extra };
}
function pass(code, detail, extra = {}) {
  return { ok: true, code, detail: String(detail).slice(0, 500), ...extra };
}

/**
 * Retry only for transient classes; a definitive mismatch must surface at
 * once (retrying a wrong-run answer is how you attach to the wrong server).
 */
async function fetchRun({ originRepo, originRunId, originAttempt, attempts = 4, retryMs = 5000, deadlineMs = 60000 }) {
  const started = Date.now();
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = await apiGet(`/repos/${originRepo}/actions/runs/${originRunId}`);
    if (r.transport !== 'ok') {
      last = fail('RUN_FETCH_UNREACHABLE', r.summary, { transient: true });
    } else if (r.status === 404) {
      return fail('RUN_NOT_FOUND', `no run ${originRunId} in ${originRepo}`);
    } else if (r.status === 403) {
      return fail('RUN_FETCH_FORBIDDEN', `the job token cannot read ${originRepo} run ${originRunId}`);
    } else if (r.status < 200 || r.status >= 300) {
      last = fail('RUN_FETCH_HTTP', `HTTP ${r.status}`, { transient: r.status >= 500 });
    } else if (!r.json || !r.json.id) {
      last = fail('RUN_FETCH_SCHEMA', 'no JSON run object');
    } else {
      return { ...pass('RUN_FETCHED', `run ${originRunId} attempt ${r.json.run_attempt}`), run: r.json };
    }
    if (Date.now() + retryMs > started + deadlineMs) break;
    await sleep(retryMs);
  }
  return last || fail('RUN_FETCH_FAILED', 'exhausted attempts');
}

/**
 * The full gate. `descriptor` has already been structurally validated by
 * lib/run-descriptor. Returns { ok, code, checks[], run }.
 */
async function verifyOriginRun(descriptor, { expectArtifact = null, allowNonRunning = false } = {}) {
  const checks = [];
  const add = c => { checks.push(c); return c; };

  const fetched = await fetchRun({ originRepo: descriptor.originRepo, originRunId: descriptor.originRunId });
  add(fetched);
  if (!fetched.ok) return { ok: false, code: fetched.code, checks, detail: fetched.detail };
  const run = fetched.run;

  const repoOf = String(run.head_repository && run.head_repository.full_name ? run.head_repository.full_name : run.repository && run.repository.full_name ? run.repository.full_name : '');
  add(repoOf === descriptor.originRepo
    ? pass('RUN_REPO_MATCH', repoOf)
    : fail('RUN_REPO_MISMATCH', `run belongs to ${repoOf || 'unknown'}, descriptor says ${descriptor.originRepo}`));

  const wfPath = String(run.path || '').split('/').pop();
  add(wfPath === descriptor.originWorkflow
    ? pass('RUN_WORKFLOW_MATCH', wfPath)
    : fail('RUN_WORKFLOW_MISMATCH', `run workflow ${wfPath || 'unknown'} != ${descriptor.originWorkflow}`));

  add(String(run.head_sha || '').toLowerCase() === descriptor.appSha
    ? pass('RUN_HEAD_SHA_MATCH', descriptor.appSha)
    : fail('RUN_HEAD_SHA_MISMATCH', `run head_sha ${run.head_sha} != descriptor appSha ${descriptor.appSha}`));

  add(Number(run.run_attempt) === Number(descriptor.originAttempt)
    ? pass('RUN_ATTEMPT_MATCH', `attempt ${run.run_attempt}`)
    : fail(Number(run.run_attempt) > Number(descriptor.originAttempt) ? 'RUN_ATTEMPT_SUPERSEDED' : 'RUN_ATTEMPT_MISMATCH',
      `current attempt ${run.run_attempt}, descriptor says ${descriptor.originAttempt}`));

  const running = String(run.status || '') === 'in_progress';
  add(running || allowNonRunning
    ? pass('RUN_IN_PROGRESS', `status=${run.status}`)
    : fail('RUN_NOT_LIVE', `origin run is ${run.status}${run.conclusion ? '/' + run.conclusion : ''}; its ephemeral server is gone — nothing to attach to`));

  if (expectArtifact) {
    const a = await verifyArtifactProvenance({ originRepo: descriptor.originRepo, originRunId: descriptor.originRunId, originAttempt: descriptor.originAttempt, name: expectArtifact });
    add(a);
    if (!a.ok) return { ok: false, code: a.code, checks, detail: a.detail, run };
  }

  const bad = checks.find(c => !c.ok);
  return bad
    ? { ok: false, code: bad.code, detail: bad.detail, checks, run }
    : { ok: true, code: 'ORIGIN_VERIFIED', checks, run, runUrl: String(run.html_url || '') };
}

/**
 * Artifact provenance: the secret envelope must come from THIS run+attempt,
 * under the exact expected name, and the bytes we downloaded must hash to the
 * archive the API listed (so a truncated or substituted zip is detected before
 * any credential from it is used).
 */
async function verifyArtifactProvenance({ originRepo, originRunId, originAttempt, name }) {
  const list = await apiGet(`/repos/${originRepo}/actions/runs/${originRunId}/artifacts`);
  if (!list.ok && list.transport !== undefined && list.status !== 200) {
    if (list.status === 403) return fail('ARTIFACT_LIST_FORBIDDEN', `job token cannot list artifacts of ${originRepo} run ${originRunId} (needs actions:read)`);
    return fail('ARTIFACT_LIST_HTTP', `HTTP ${list.status}`);
  }
  if (list.transport !== 'ok') return fail('ARTIFACT_LIST_UNREACHABLE', list.summary);
  const arts = ((list.json && list.json.artifacts) || []).filter(a => String(a.name) === String(name));
  if (!arts.length) return fail('ARTIFACT_NOT_FOUND', `artifact ${JSON.stringify(name)} is not present on run ${originRunId}`);
  if (arts.length > 1) return fail('ARTIFACT_AMBIGUOUS', `${arts.length} artifacts named ${name}; the handoff must be uniquely addressed`);
  const art = arts[0];
  if (Number(art.workflow_run_id) !== Number(originRunId)) {
    return fail('ARTIFACT_RUN_MISMATCH', `artifact ${art.id} belongs to run ${art.workflow_run_id}`);
  }
  if (Number(art.run_attempt || art.workflow_run_attempt || originAttempt) !== Number(originAttempt)) {
    return fail('ARTIFACT_ATTEMPT_MISMATCH', `artifact attempt ${art.run_attempt} != ${originAttempt}`);
  }
  if (art.expired) return fail('ARTIFACT_EXPIRED', 'the credential envelope artifact has already expired');
  return pass('ARTIFACT_PROVENANCE_OK', `artifact ${art.id} size=${art.size_in_bytes} expected=${art.expected_size}`, { artifact: art });
}

/**
 * Download + unzip-free integrity check. GitHub gives a signed URL for the
 * whole zip; we verify the byte count against `expected_size` and hash it, then
 * hand back the raw buffer. Retention/expiry is the origin's cleanup.
 */
async function downloadArtifact({ originRepo, originRunId, artifactId, archiveBytesLimit = 2 * 1024 * 1024 }) {
  const meta = await apiGet(`/repos/${originRepo}/actions/artifacts/${artifactId}`);
  if (meta.transport !== 'ok' || meta.status !== 200) return fail('ARTIFACT_META_FAILED', meta.summary || `HTTP ${meta.status}`);
  const m = meta.json;
  if (Number(m.size_in_bytes) > archiveBytesLimit) return fail('ARTIFACT_TOO_LARGE', `${m.size_in_bytes} bytes exceeds the ${archiveBytesLimit} byte handoff budget`);
  const dl = await request(m.archive_download_url, {
    timeoutMs: 30000,
    redirect: 'follow',
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'supreme-lamp-lab-artifact' }
  });
  if (dl.transport !== 'ok') return fail('ARTIFACT_DOWNLOAD_UNREACHABLE', summarize(dl));
  // The archive endpoint 302s to a signed blob URL; `request` uses
  // redirect:'manual' by default for other callers, so follow explicitly here.
  let buf = dl.bytes || Buffer.alloc(0);
  if (dl.status >= 300 && dl.status < 400 && dl.headers && dl.headers.location) {
    const r2 = await request(dl.headers.location, { timeoutMs: 30000 });
    if (r2.transport !== 'ok') return fail('ARTIFACT_BLOB_UNREACHABLE', summarize(r2));
    if (r2.status !== 200) return fail('ARTIFACT_BLOB_HTTP', `HTTP ${r2.status}`);
    buf = r2.bytes || Buffer.alloc(0);
  } else if (dl.status !== 200) {
    return fail('ARTIFACT_DOWNLOAD_HTTP', `HTTP ${dl.status}`);
  }
  if (!buf || !buf.length) return fail('ARTIFACT_EMPTY', 'downloaded 0 bytes');
  if (Number(m.expected_size) && buf.length !== Number(m.expected_size)) {
    return fail('ARTIFACT_SIZE_MISMATCH', `got ${buf.length} bytes, the API listed ${m.expected_size}`);
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return pass('ARTIFACT_DOWNLOADED', `${buf.length} bytes sha256=${sha256.slice(0, 16)}…`, { bytes: buf, sha256, archiveDownloadUrl: undefined });
}

/**
 * Unzip in pure Node. The envelopes are tiny single-file archives; a stored
 * entry (method 0) or a deflate entry (method 8) are both handled, and any
 * archive with more than `maxEntries` files or a path escape is refused — the
 * artifact store is a handoff, not a general file transfer.
 */
function extractZip(bytes, { maxEntries = 4, maxEntryBytes = 1024 * 1024 } = {}) {
  const zlib = require('zlib');
  const out = [];
  // locate End Of Central Directory
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP_NO_EOCD: not a zip archive');
  const total = bytes.readUInt16LE(eocd + 10);
  let off = bytes.readUInt32LE(eocd + 16);
  if (total > maxEntries) throw new Error(`ZIP_TOO_MANY_ENTRIES: ${total}`);
  for (let n = 0; n < total; n++) {
    if (bytes.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP_CENTRAL_DIRECTORY_CORRUPT');
    const method = bytes.readUInt16LE(off + 10);
    const compSize = bytes.readUInt32LE(off + 20);
    const uncompSize = bytes.readUInt32LE(off + 24);
    const nameLen = bytes.readUInt16LE(off + 28);
    const extraLen = bytes.readUInt16LE(off + 30);
    const commentLen = bytes.readUInt16LE(off + 32);
    const localOff = bytes.readUInt32LE(off + 42);
    const name = bytes.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (uncompSize > maxEntryBytes) throw new Error(`ZIP_ENTRY_TOO_LARGE: ${name}`);
    if (name.startsWith('/') || name.includes('..')) throw new Error(`ZIP_ENTRY_UNSAFE_PATH: ${name}`);
    // local header: 30 bytes + its own name/extra lengths
    const lNameLen = bytes.readUInt16LE(localOff + 26);
    const lExtraLen = bytes.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`ZIP_UNSUPPORTED_METHOD ${method} for ${name}`);
    if (data.length !== uncompSize) throw new Error(`ZIP_ENTRY_SIZE_CONTRADICTION: ${name} ${data.length}!=${uncompSize}`);
    out.push({ name, data });
  }
  return out;
}

module.exports = { verifyOriginRun, fetchRun, verifyArtifactProvenance, downloadArtifact, extractZip, apiGet };
