#!/usr/bin/env node
'use strict';
// QUEUE SELECTOR — decides which live-run record THIS lab run will serve.
//
//   node scripts/pick-record.js [--correlation ID] [--origin repo] [--run N]
//                               [--attempt N] [--records records.txt]
//
// Output: one JSON object on stdout:
//   { proceed: 'yes'|'no', reason, descriptor? }
//
// Rules, in order (this is the documented queue policy):
//   1. An explicit correlation id wins. If that record is missing/expired or
//      already claimed by a LIVE lab run -> proceed=no with that reason. A
//      requested correlation is NEVER substituted with another one: attaching an
//      operator's request to "whatever server is up" is the failure mode this
//      integration must not have.
//   2. An explicit (origin repo, run, attempt) wins next — same non-substitution
//      rule. This is also how a duplicate repository_dispatch dedupes: the second
//      delivery resolves to the SAME record, sees the live claim, and stands down.
//   3. Otherwise take the OLDEST unclaimed, unexpired, allowlisted record
//      (FIFO by correlationId, which sorts by run id and attempt). Never the newest.
//   4. Every candidate is validated through lib/run-descriptor before it can be
//      selected: a malformed or expired descriptor is skipped and reported, and
//      an origin repo outside the allowlist is refused outright.
//
// Exit code is always 0 (a "no" is a normal, reportable outcome); usage errors
// exit 64.
//
// TWO MEASURED DEFECTS IN THIS FILE (fixed, with regressions in
// scripts/test/queue-selection-regressions.js):
//   a. the records listing was parsed with a `}`-at-end-of-file anchor, but
//      `live-run.js poll-records` prints a header line BEFORE the JSON and a
//      `[NOTICE] ...` line AFTER it. Every read therefore failed with
//      RECORDS_UNREADABLE -> proceed=no -> the client job was skipped even
//      though discovery had just published a valid record.
//   b. the record file was consumed as if it were the record itself, while
//      `record-store.readRepoFile` returns `{text,json,sha,size}`. The real
//      record lives in `.json`, so every candidate became "record body
//      unavailable" (or threw on `rec.descriptor`).

const fs = require('fs');
const rd = require('./lib/run-descriptor');

const DEFAULT_ALLOWLIST = ['dictationb1/supreme-lamp'];

function parseArgs(argv) {
  const a = { correlation: '', origin: '', run: 0, attempt: 1, records: '', allow: process.env.LIVE_RUN_ALLOWED_ORIGINS || DEFAULT_ALLOWLIST.join(',') };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = () => { const n = argv[i + 1]; if (n === undefined) throw new Error(`missing value for ${k}`); i++; return n; };
    if (k === '--correlation') a.correlation = v();
    else if (k === '--origin') a.origin = v();
    else if (k === '--run') a.run = Number(v());
    else if (k === '--attempt') a.attempt = Number(v());
    else if (k === '--records') a.records = v();
    else if (k === '--allow-origins') a.allow = v();
    else { const e = new Error(`unknown flag ${k}`); e.usage = true; throw e; }
  }
  return a;
}

function out(proceed, reason, descriptor) {
  const o = { proceed: proceed ? 'yes' : 'no', reason };
  if (descriptor) o.descriptor = descriptor;
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(0);
}

/**
 * Extract the FIRST balanced JSON object from arbitrary text.
 * Brace counting respects strings and escapes, so a `}` inside a message cannot
 * truncate the document either.
 */
function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function loadRecords(file) {
  let text = '';
  try { text = file ? fs.readFileSync(file, 'utf8') : ''; } catch (e) { return { error: `records file unreadable: ${e.message}` }; }
  const doc = extractJsonObject(text);
  if (!doc) return { error: 'no JSON payload in the records listing' };
  if (Array.isArray(doc.records)) return { doc };
  if (doc.doc && Array.isArray(doc.doc.records)) return { doc: doc.doc };
  return { error: 'records JSON has no records array' };
}

/** `record-store.readRepoFile()` returns {text,json,...}: the RECORD is `.json`. */
function recordFromFile(file) {
  if (!file) return null;
  if (file.json && typeof file.json === 'object') return file.json;
  if (file.text) { try { return JSON.parse(file.text); } catch (e) { return null; } }
  return null;
}

/**
 * Apply the documented selection rules to already-listed rows. Exported so a
 * regression can drive it with a fake listing and a fake reader.
 */
async function pickFromRows(rows, a, { now = Date.now(), readFull, allow = [], claimLive = null } = {}) {
  const detail = r => `${r.origin || '?'} corr=${r.correlationId || '?'} state=${r.state} claim=${r.claimedBy || 'none'} ttl=${r.expiresInSeconds}s`;
  let candidates = [];
  if (a.correlation) {
    candidates = rows.filter(r => String(r.correlationId) === String(a.correlation));
    if (!candidates.length) return { proceed: 'no', reason: `CORRELATION_NOT_FOUND: no record for ${a.correlation} (queue holds: ${rows.map(r => r.correlationId).join(', ') || 'none'}) — a requested correlation is never substituted` };
  } else if (a.origin && a.run) {
    candidates = rows.filter(r => String(r.origin).startsWith(`${a.origin}#${a.run}/`) && String(r.origin).endsWith(`/${a.attempt}`));
    if (!candidates.length) return { proceed: 'no', reason: `RECORD_NOT_FOUND: no record for ${a.origin}#${a.run}/${a.attempt} — it may already have been consumed, expired, or never published` };
  } else {
    // FIFO: the oldest still-valid origin is served first, because its server is
    // the one that is alive and waiting.
    candidates = rows.slice().sort((x, y) => String(x.correlationId).localeCompare(String(y.correlationId)));
  }

  const skipped = [];
  for (const r of candidates) {
    // A claim left behind by a lab run that is already terminal is stale: the
    // desktop lock, the record state and the claim itself must not make an
    // origin unattachable for the rest of its lifetime. MEASURED (runs
    // 39904982757 -> 39905558539): the claimant failed in the live step, and
    // every later sweep refused to even look at the record. The row is only
    // skipped when the claimant is provably still running; when its status
    // cannot be read the conservative answer (a live claimant) stands.
    if (r.claimedBy) {
      // No resolver at all means "assume a live claimant" (the safe reading).
      const live = claimLive ? await claimLive(String(r.claimedBy)) : true;
      if (live !== false) {
        skipped.push(`${r.correlationId}: already claimed by ${live === null ? 'unreadable' : 'live'} lab run ${r.claimedBy}`);
        continue;
      }
      skipped.push(`${r.correlationId}: stale claim by terminal lab run ${r.claimedBy}`);
    }
    // A lab attempt that failed WITHOUT an in-process report (e.g. the client VM
    // preflight died) leaves the record `retryable`. The origin server is still
    // alive and nothing was verified, so a later sweep may serve it again. A
    // real report (REPORTED_VERIFIED / REPORTED_FAILED) is never re-served.
    // The flag lives in the record BODY (and, for operators, on the row); the
    // row alone is not trusted for it, so a queue listing that predates the
    // flag still behaves correctly.
    const rowMayBeRetryable = ['FAILED', 'BLOCKED'].includes(r.state) || r.retryable === true;
    if (r.state !== 'AWAITING_LAB_ACCEPTANCE' && !a.correlation && !rowMayBeRetryable) {
      skipped.push(`${r.correlationId}: state=${r.state}`);
      continue;
    }
    if (!(r.expiresInSeconds > 0)) { skipped.push(`${r.correlationId}: expired`); continue; }
    const originRepo = String(r.origin).split('#')[0];
    if (originRepo && allow.length && !allow.includes(originRepo)) { skipped.push(`${r.correlationId}: origin ${originRepo} not allowlisted`); continue; }
    const rec = recordFromFile(readFull ? await readFull(r.path) : null);
    if (!rec || !rec.descriptor) { skipped.push(`${r.correlationId}: record body unavailable`); continue; }
    let d = null;
    try {
      d = rd.validateDescriptor({ ...rec.descriptor, clientTailnetIp: rec.descriptor.clientTailnetIp || '' }, { now });
    } catch (e) { skipped.push(`${r.correlationId}: ${e.message}`); continue; }
    const retryable = rec.retryable === true && ['FAILED', 'BLOCKED'].includes(rec.state);
    if (rec.state === 'AWAITING_LAB_ACCEPTANCE' || a.correlation || retryable) {
      return { proceed: 'yes', reason: `SELECTED ${detail(r)}${rec.state !== 'AWAITING_LAB_ACCEPTANCE' ? ` retryable=${rec.state}` : ''}`, descriptor: d, retryable: retryable || undefined };
    }
    skipped.push(`${r.correlationId}: state=${rec.state}`);
  }
  return { proceed: 'no', reason: `NO_PICKABLE_RECORD: ${skipped.slice(0, 6).join(' | ') || 'all candidates filtered'}` };
}

async function main() {
  let a;
  try { a = parseArgs(process.argv); } catch (e) { console.error(e.message); return process.exit(64); }
  const allow = String(a.allow).split(',').map(s => s.trim()).filter(Boolean);
  if (!allow.length) return out(false, 'NO_ALLOWLIST: refusing to select any record because the origin allowlist is empty');
  rd.setAllowedOriginRepos(allow);

  const loaded = loadRecords(a.records);
  if (loaded.error) return out(false, `RECORDS_UNREADABLE: ${loaded.error}`);
  const rows = (loaded.doc && loaded.doc.records) || [];
  if (!rows.length) return out(false, 'EMPTY_QUEUE: no live-run record has been published for any run that is still in progress');

  const res = await pickFromRows(rows, a, {
    allow,
    claimLive: async (labRunId) => {
      const store = require('./lib/record-store');
      try {
        const st = await store.labRunStatus(labRunId);
        return !store.TERMINAL_RUN_STATES.has(String(st.status || ''));
      } catch (e) {
        // Never silent: an unreadable claimant keeps the row skipped, and the
        // reason has to say why so a broken status read is not mistaken for a
        // live lab run.
        console.error(`[NOTICE] claim status unreadable for lab run ${labRunId}: ${e && e.message}`);
        return null;
      }
    },
    readFull: async (p) => {
      const store = require('./lib/record-store');
      try {
        return await store.readRepoFile(process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab', store.RECORDS_BRANCH, p);
      } catch (e) { return null; }
    }
  });
  return out(res.proceed === 'yes', res.reason, res.descriptor);
}

if (require.main === module) {
  main().catch(e => { console.error(`pick-record fatal: ${e.stack || e.message}`); process.exit(64); });
}

module.exports = { parseArgs, loadRecords, extractJsonObject, recordFromFile, pickFromRows };
