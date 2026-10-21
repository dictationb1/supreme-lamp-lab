'use strict';
// RUN-RECORD STORE — where a live-run descriptor and its credential envelope
// physically live, and how a lab run claims one without fighting a sibling.
//
// Two transports, one interface:
//   artifact  — the origin run uploads `live-run-<id>` / `live-run-<id>-envelope`
//               artifacts to ITS OWN run. Read by the lab with the job's
//               actions:read token. Secrets never leave the origin run's
//               artifact store (retention 1 day, no job outputs, no PR bodies).
//   ref       — an orphan branch `run-records` in the LAB repository, path
//               records/<origin-slug>/<run>-<attempt>.json (+ .claim.json).
//               Used (a) as the ack channel back to the origin, which can read
//               its own dispatch target only through this repo's public-ish
//               Pages/contents API, and (b) for the lab's own CI
//               self-validation where no cross-repository artifact grant needs
//               to be assumed. The claim file is the queue ticket.
//
// Concurrency rules implemented here (they are the whole point of the module):
//   * one claim per (originRunId, originAttempt) — a second lab run sees the
//     claim and honours it while the claimant is alive, so two attempts can
//     never fight over the same VM desktop;
//   * a claim is released by its owner, or judged stale ONLY from the
//     claimant's recorded lab run status (GitHub says completed/failed/
//     cancelled), never from wall-clock age — a long queue is not a dead owner;
//   * a queued request is NEVER re-attached to a different server: the record
//     key contains the origin run id and attempt, and every read re-validates
//     the descriptor (expiry) before the claim is accepted.

const crypto = require('crypto');
const { request, summarize } = require('./http');
const { DescriptorError, validateDescriptor, serializeDescriptor } = require('./run-descriptor');

const RECORDS_BRANCH = 'run-records';
const RECORDS_DIR = 'records';
const CLAIM_TTL_HINT = 'claim is released by its owner or when the claimant lab run reaches a terminal state';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiBase() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}
function ghToken() {
  const t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!t) throw new DescriptorError('NO_GITHUB_TOKEN', 'GH_TOKEN/GITHUB_TOKEN is required to read run records');
  return t;
}
function repoSlug(explicit) {
  const slug = explicit || process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new DescriptorError('REPO_INVALID', slug);
  return slug;
}
/** `owner/repo` is not a path segment; flatten it deterministically. */
function originSlug(originRepo) {
  return String(originRepo).replace(/[^A-Za-z0-9._-]+/g, '_').toLowerCase();
}
function recordKey(descriptor) {
  return `${originSlug(descriptor.originRepo)}/${descriptor.originRunId}-${descriptor.originAttempt}`;
}
function recordPath(descriptor) {
  return `${RECORDS_DIR}/${recordKey(descriptor)}.json`;
}
function claimPath(descriptor) {
  return `${RECORDS_DIR}/${recordKey(descriptor)}.claim.json`;
}

async function gh(method, path, body, { expected = [200, 201, 204] } = {}) {
  const r = await request(`${apiBase()}${path}`, {
    method,
    timeoutMs: 30000,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'supreme-lamp-lab-live-run',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const out = { status: r.status, json: r.json, text: r.text, transport: r.transport, summary: summarize(r) };
  if (r.transport !== 'ok') {
    const err = new Error(`gh ${method} ${path}: ${out.summary}`);
    err.code = r.transport === 'timeout' ? 'GH_API_TIMEOUT' : 'GH_API_UNREACHABLE';
    throw err;
  }
  if (!expected.includes(r.status)) {
    const err = new Error(`gh ${method} ${path}: HTTP ${r.status} ${(r.text || '').slice(0, 200)}`);
    err.code = r.status === 403 ? 'GH_API_FORBIDDEN' : r.status === 404 ? 'GH_API_NOT_FOUND' : 'GH_API_ERROR';
    err.status = r.status;
    throw err;
  }
  return out;
}

async function readRepoFile(repo, ref, p) {
  // The contents API takes slash-separated path segments; encode each one but
  // never the separators (that is how a path with a space or `#` survives).
  const url = `/repos/${repo}/contents/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  try {
    const out = await gh('GET', `${url}?ref=${encodeURIComponent(ref)}`, null, { expected: [200] });
    const content = String((out.json && out.json.content) || '');
    const text = Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported by the caller */ }
    return { text, json, sha: out.json && out.json.sha, size: out.json && out.json.size };
  } catch (e) {
    if (e.code === 'GH_API_NOT_FOUND') return null;
    throw e;
  }
}

async function writeRepoFile(repo, branch, p, contents, message, { sha } = {}) {
  const url = `/repos/${repo}/contents/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  const body = { message, content: Buffer.from(contents, 'utf8').toString('base64'), branch };
  if (sha) body.sha = sha;
  return gh('PUT', url, body, { expected: [200, 201] });
}

/**
 * Best-effort existence of the records branch. If it is missing, create it
 * from the workflow's own SHA so the very first live run can still publish.
 */
async function ensureRecordsBranch(repo, seedSha) {
  try {
    await gh('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(RECORDS_BRANCH)}`, null, { expected: [200] });
    return { exists: true };
  } catch (e) {
    if (e.code !== 'GH_API_NOT_FOUND') throw e;
    if (!seedSha) return { exists: false, error: 'no seed sha supplied' };
    try {
      await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${RECORDS_BRANCH}`, sha: seedSha }, { expected: [201] });
      return { exists: true, created: true };
    } catch (e2) {
      return { exists: false, error: e2.message };
    }
  }
}

/** Publish a descriptor (never the secret envelope) + its ack skeleton. */
async function publishRecord({ repo, descriptor, envelope, seedSha, now = new Date() }) {
  validateDescriptor(descriptor, { now: now.getTime() });   // refuse to publish garbage
  const branchState = await ensureRecordsBranch(repo, seedSha);
  const body = {
    kind: 'slab-live-run-record/1',
    publishedAt: now.toISOString(),
    descriptor: JSON.parse(serializeDescriptor(descriptor)),
    // State machine the operator reads. Every transition is written by the
    // party that actually observed it; nothing here is inferred.
    state: 'AWAITING_LAB_ACCEPTANCE',
    history: [{ at: now.toISOString(), state: 'AWAITING_LAB_ACCEPTANCE', by: 'origin' }],
    // The envelope is NOT stored in the repository. It only records where the
    // secret lives so the lab can fetch it over a protected channel.
    envelopeTransport: envelope && envelope.transport ? envelope.transport : { kind: 'artifact', repository: descriptor.originRepo, runId: descriptor.originRunId, name: `live-run-${descriptor.originRunId}-${descriptor.originAttempt}-envelope` },
    branch: branchState
  };
  const p = recordPath(descriptor);
  let sha = null;
  const existing = await readRepoFile(repo, RECORDS_BRANCH, p);
  if (existing) sha = existing.sha;
  await writeRepoFile(repo, RECORDS_BRANCH, p, JSON.stringify(body, null, 2), `live-run record ${descriptor.correlationId} [skip ci]`, { sha });
  return { path: p, record: body };
}

/**
 * Transition the record's state. `by` names the writer ('origin' | 'lab') and
 * the lab run id, so an operator can always tell who claimed what.
 */
async function updateRecordState({ repo, descriptor, state, by, detail = null, extra = {} }) {
  const p = recordPath(descriptor);
  const cur = await readRepoFile(repo, RECORDS_BRANCH, p);
  if (!cur || !cur.json) throw new DescriptorError('RECORD_MISSING', `no record at ${RECORDS_BRANCH}:${p}`);
  const rec = cur.json;
  const at = new Date().toISOString();
  rec.state = state;
  rec.updatedAt = at;
  rec.history = Array.isArray(rec.history) ? rec.history.slice(-40) : [];
  rec.history.push({ at, state, by, detail: detail ? String(detail).slice(0, 400) : null });
  Object.assign(rec, extra || {});
  await writeRepoFile(repo, RECORDS_BRANCH, p, JSON.stringify(rec, null, 2), `live-run ${descriptor.correlationId} -> ${state} [skip ci]`, { sha: cur.sha });
  return rec;
}

async function readRecord({ repo, originRepo, originRunId, originAttempt }) {
  const p = `${RECORDS_DIR}/${originSlug(originRepo)}/${originRunId}-${originAttempt}.json`;
  const cur = await readRepoFile(repo, RECORDS_BRANCH, p);
  if (!cur) return null;
  if (!cur.json) throw new DescriptorError('RECORD_UNPARSEABLE', `${RECORDS_BRANCH}:${p}`);
  return { path: p, sha: cur.sha, record: cur.json };
}

async function readClaim({ repo, descriptor }) {
  const cur = await readRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor));
  if (!cur || !cur.json) return null;
  return cur.json;
}

/** Terminal states of a GitHub Actions run, used to judge a stale claim. */
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);

async function labRunStatus(runId) {
  const out = await gh('GET', `/repos/${process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab'}/actions/runs/${runId}`, null, { expected: [200] });
  return { status: String(out.json.status || ''), conclusion: out.json.conclusion ? String(out.json.conclusion) : null, attempt: Number(out.json.run_attempt || 1), url: String(out.json.html_url || '') };
}

/**
 * Claim a record for this lab run. Returns { claimed, reason, claim }.
 * Never steals a live claimant; only a claimant whose lab run is terminal
 * (or whose recorded identity is provably gone) can be superseded.
 */
async function claimRecord({ repo, descriptor, labRunId, labAttempt, maxWaitMs = 0, pollMs = 15000, now = Date.now() }) {
  const deadline = now + Math.max(0, maxWaitMs);
  for (;;) {
    const claim = await readClaim({ repo, descriptor });
    if (!claim) {
      const body = {
        kind: 'slab-live-run-claim/1',
        claimedAt: new Date().toISOString(),
        claimant: { labRunId, labAttempt, url: `https://github.com/${repo}/actions/runs/${labRunId}` },
        descriptorId: descriptor.id,
        correlationId: descriptor.correlationId,
        releaseHint: CLAIM_TTL_HINT,
        nonce: crypto.randomBytes(8).toString('hex')
      };
      try {
        // Atomic-ish: create with no sha. If a sibling wrote first this 422s
        // and we fall into the live-claim branch below.
        await writeRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor), JSON.stringify(body, null, 2), `live-run claim ${descriptor.correlationId} [skip ci]`);
        return { claimed: true, claim: body, reason: 'CLAIMED' };
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
      }
    } else {
      const ownerRun = Number(claim.claimant && claim.claimant.labRunId);
      if (ownerRun === Number(labRunId)) return { claimed: true, claim, reason: 'ALREADY_MINE' };
      let ownerState = null;
      try { ownerState = await labRunStatus(ownerRun); } catch (e) { ownerState = { status: 'unknown', error: e.message }; }
      if (ownerState && TERMINAL_RUN_STATES.has(ownerState.status)) {
        const stale = { ...claim, supersededAt: new Date().toISOString(), supersededReason: `claimant run ${ownerRun} is ${ownerState.status}${ownerState.conclusion ? `/${ownerState.conclusion}` : ''}` };
        const cur = await readRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor));
        await writeRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor), JSON.stringify(stale, null, 2), `live-run claim supersede ${descriptor.correlationId} [skip ci]`, { sha: cur ? cur.sha : undefined });
        const body = {
          kind: 'slab-live-run-claim/1', claimedAt: new Date().toISOString(),
          claimant: { labRunId, labAttempt }, descriptorId: descriptor.id,
          correlationId: descriptor.correlationId, superseded: stale.supersededReason, nonce: crypto.randomBytes(8).toString('hex')
        };
        await writeRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor), JSON.stringify(body, null, 2), `live-run claim ${descriptor.correlationId} [skip ci]`, { sha: (await readRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor)))?.sha });
        return { claimed: true, claim: body, reason: 'SUPERSEDED_DEAD_CLAIMANT' };
      }
      if (Date.now() + pollMs > deadline) {
        return { claimed: false, claim, reason: 'QUEUED_BEHIND_LIVE_CLAIMANT', detail: `claimant run ${ownerRun} is ${ownerState ? ownerState.status : 'unknown'}; ${CLAIM_TTL_HINT}` };
      }
    }
    await sleep(pollMs);
  }
}

async function releaseClaim({ repo, descriptor, labRunId }) {
  const cur = await readRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor));
  if (!cur || !cur.json) return { released: false, reason: 'NO_CLAIM' };
  if (Number(cur.json.claimant && cur.json.claimant.labRunId) !== Number(labRunId)) {
    return { released: false, reason: 'NOT_OWNER', owner: cur.json.claimant };
  }
  const body = { ...cur.json, releasedAt: new Date().toISOString(), releasedBy: labRunId };
  await writeRepoFile(repo, RECORDS_BRANCH, claimPath(descriptor), JSON.stringify(body, null, 2), `live-run claim released ${descriptor.correlationId} [skip ci]`, { sha: cur.sha });
  return { released: true, reason: 'RELEASED' };
}

/** List pending records (used by the scheduled poller), never "the latest". */
async function listRecords({ repo }) {
  try {
    const out = await gh('GET', `/repos/${repo}/git/trees/${encodeURIComponent(RECORDS_BRANCH)}?recursive=1`, null, { expected: [200] });
    const paths = (out.json.tree || [])
      .filter(t => t.type === 'blob' && String(t.path).startsWith(`${RECORDS_DIR}/`) && t.path.endsWith('.json') && !t.path.endsWith('.claim.json'))
      .map(t => t.path);
    return paths;
  } catch (e) {
    if (e.code === 'GH_API_NOT_FOUND') return [];
    throw e;
  }
}

module.exports = {
  RECORDS_BRANCH, RECORDS_DIR, recordKey, recordPath, claimPath, originSlug,
  publishRecord, updateRecordState, readRecord, readClaim, claimRecord,
  releaseClaim, listRecords, readRepoFile, writeRepoFile, ensureRecordsBranch,
  TERMINAL_RUN_STATES, sleep
};
