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
//      (FIFO by issuedAt). Never the newest.
//   4. Every candidate is validated through lib/run-descriptor before it can be
//      selected: a malformed or expired descriptor is skipped and reported, and
//      an origin repo outside the allowlist is refused outright.
//
// Exit code is always 0 (a "no" is a normal, reportable outcome); usage errors
// exit 64.

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
 * Extract the first BALANCED JSON object from a mixed stream.
 *
 * `poll-records` writes a human header and workflow-command annotations
 * (`::notice`/`[NOTICE]`) around its payload, so a `... }$` regex matched only
 * when nothing trailed the JSON. Measured 2026-10-23: the claim job answered
 * RECORDS_UNREADABLE - "no verification was attempted" - while a pickable,
 * unexpired record for a live run was sitting in the queue. Braces inside
 * strings are handled; a truncated object is reported, never guessed.
 */
function extractJsonObject(text) {
  const start = String(text || '').indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function loadRecords(file) {
  let text = '';
  try { text = file ? fs.readFileSync(file, 'utf8') : ''; } catch (e) { return { error: `records file unreadable: ${e.message}` }; }
  const sliced = extractJsonObject(text);
  if (!sliced) return { error: 'no JSON payload in the records listing' };
  try { return { doc: JSON.parse(sliced) }; } catch (e) { return { error: `records JSON unparseable: ${e.message}` }; }
}

/**
 * Pure selector (exported for regressions). `readFull(path)` must resolve to the
 * record FILE as the store returns it: `{ json, sha }`. The selector used to
 * read `rec.descriptor` off that wrapper, so every candidate died with
 * "Cannot read properties of undefined (reading 'clientTailnetIp')" and the
 * claim job reported NO_PICKABLE_RECORD while a live record was waiting
 * (measured 2026-10-23, run 39952421153).
 */
async function selectRecord({ rows, a, allow, now = Date.now(), readFull }) {
  const detail = r => `${r.origin || '?'} corr=${r.correlationId || '?'} state=${r.state} claim=${r.claimedBy || 'none'} ttl=${r.expiresInSeconds}s`;
  let candidates = [];
  if (a.correlation) {
    candidates = rows.filter(r => String(r.correlationId) === String(a.correlation));
    if (!candidates.length) return { proceed: 'no', reason: `CORRELATION_NOT_FOUND: no record for ${a.correlation} (queue holds: ${rows.map(r => r.correlationId).join(', ') || 'none'}) — a requested correlation is never substituted` };
  } else if (a.origin && a.run) {
    candidates = rows.filter(r => String(r.origin).startsWith(`${a.origin}#${a.run}/`) && String(r.origin).endsWith(`/${a.attempt}`));
    if (!candidates.length) return { proceed: 'no', reason: `RECORD_NOT_FOUND: no record for ${a.origin}#${a.run}/${a.attempt} — it may already have been consumed, expired, or never published` };
  } else {
    // FIFO by issuedAt: the oldest still-valid origin is served first, because
    // its server is the one that is alive and waiting.
    candidates = rows.slice().sort((x, y) => String(x.correlationId).localeCompare(String(y.correlationId)));
  }

  /**
   * A record may be re-queued ONLY when it is provable that no verification was
   * ever attempted: the last transition is a LAB job-level write-back
   * ("the verify job exited without an in-process report" / "did not reach a
   * report") and no `report` object exists. Measured 2026-10-23: the Windows
   * client job died in preflight cleanup before the verification step, the ack
   * step wrote FAILED, and the still-live origin could never be attached again -
   * every later sweep answered "nothing to attach" for a healthy run.
   *
   * A record that DID produce a report (pass or fail) is never re-queued here:
   * re-running a real verdict needs an explicit correlation (operator).
   * Bounded to 3 re-queues so a persistently broken client cannot spin.
   */
  const requeueProof = rec => {
    if (!rec || rec.report) return null;
    const hist = Array.isArray(rec.history) ? rec.history : [];
    const last = hist[hist.length - 1] || {};
    // A state that claims a verdict while carrying NO report object is itself
    // provably inconsistent: the in-process verify job writes state and report
    // together, so this can only be a gap-fill (measured 2026-10-23:
    // REPORTED_VERIFIED written for a run that aborted at CLAIMED).
    const claimsVerdictWithoutReport = String(last.state || '').startsWith('REPORTED_');
    if (!claimsVerdictWithoutReport) {
      if (last.state !== 'FAILED' && last.state !== 'BLOCKED') return null;
      if (!/in-process report|did not reach a report/.test(String(last.detail || ''))) return null;
    }
    const requeues = hist.filter(h => h.state === 'AWAITING_LAB_ACCEPTANCE' && h.by && h.by !== 'origin').length;
    if (requeues >= 3) return null;
    return `REQUEUE_NO_VERIFICATION_WAS_ATTEMPTED(${requeues + 1}/3)`;
  };

  const skipped = [];
  for (const r of candidates) {
    if (r.claimedBy) { skipped.push(`${r.correlationId}: already claimed by live lab run ${r.claimedBy}`); continue; }
    // FAILED/BLOCKED rows are inspected (not skipped outright): only the record
    // BODY can prove that no verification was ever attempted, which is the one
    // condition that permits an automatic re-queue.
    const inspectable = r.state === 'AWAITING_LAB_ACCEPTANCE' || r.state === 'FAILED' || r.state === 'BLOCKED' || String(r.state || '').startsWith('REPORTED_');
    if (!inspectable && !a.correlation) { skipped.push(`${r.correlationId}: state=${r.state}`); continue; }
    if (!(r.expiresInSeconds > 0)) { skipped.push(`${r.correlationId}: expired`); continue; }
    if (String(r.origin).split('#')[0] && !allow.includes(String(r.origin).split('#')[0])) { skipped.push(`${r.correlationId}: origin ${r.origin} not allowlisted`); continue; }
    const file = await readFull(r.path);
    const rec = file && file.json ? file.json : null;
    if (!rec || !rec.descriptor) { skipped.push(`${r.correlationId}: record body unavailable`); continue; }
    let d = null;
    try { d = rd.validateDescriptor({ ...rec.descriptor, clientTailnetIp: rec.descriptor.clientTailnetIp || '' }, { now }); }
    catch (e) { skipped.push(`${r.correlationId}: ${e.message}`); continue; }
    const requeue = a.correlation ? null : requeueProof(rec);
    if (rec.state === 'AWAITING_LAB_ACCEPTANCE' || a.correlation || requeue) {
      return { proceed: 'yes', reason: `SELECTED ${detail(r)}${requeue ? ' ' + requeue : ''}`, descriptor: d, requeue: requeue || null };
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

  const picked = await selectRecord({ rows, a, allow, now: Date.now(), readFull });
  return picked.proceed === 'yes' ? out(true, picked.reason, picked.descriptor) : out(false, picked.reason);
}

async function readFull(p) {
  const store = require('./lib/record-store');
  try { return await store.readRepoFile(process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab', store.RECORDS_BRANCH, p); }
  catch (e) { return null; }
}

if (require.main === module) main().catch(e => { console.error(`pick-record fatal: ${e.stack || e.message}`); process.exit(64); });

module.exports = { parseArgs, loadRecords, selectRecord, extractJsonObject };
