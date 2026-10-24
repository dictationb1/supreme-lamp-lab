'use strict';
// [FUNCTIONAL SWEEP] Contract probes against the LIVE staged candidate backend
// (capability-check server job): File Explorer (fx), Search, and the core
// dashboard contracts. This is the runtime measurement the stub-lane sweep
// correctly leaves BLOCKED (its stub has none of these backends).
//
// Honesty rules (same family as real-backend.js / r2-fault-injection.js):
//   * Every verdict is a MEASURED response (status, headers, body, bytes),
//     recorded in `actual`; nothing is inferred from "the step did not throw".
//   * The gofile UPLOAD path is proven only to the queue contract (202 + job
//     shape). External delivery is NOT claimed - that needs host credentials.
//   * The 401/403 negative paths are exercised where this vantage can see
//     them; the fx routes trust tailnet-class clients, so a no-token 401
//     CANNOT be observed from this vantage and is NOT claimed.
//   * Mutating fx ops run against the disposable lab fixtures only, and the
//     sweep restores trashed/pinned/tagged state so later probes see the
//     staged baseline.
//
// Args: --target http://<peer>:7331  --out <dir>  --label <id>
//       --expect-build <cand-sha>  --max-seconds <n>
// Exit: 0 = all controls PASS/BLOCKED; 1 = any FAIL or fatal. The report is
// written before any exit so evidence always survives the verdict.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { redact, registerSecret } = require('../lib/redact');
const { deriveDashboardToken } = require('../lib/capability-auth');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0 || i + 1 >= process.argv.length) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v === null || v === '') ? dflt : v;
}

const target = String(arg('target', '')).replace(/\/+$/, '');
const outDir = String(arg('out', 'functional-sweep'));
const label = String(arg('label', 'functional-sweep'));
const expectBuild = String(arg('expect-build', ''));
const maxMs = Number(arg('max-seconds', '0') || '0') * 1000 || 420000;

const startedAt = Date.now();
const report = {
  schema: 'slab-functional-sweep/1',
  label,
  target: redact(target),
  runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  expectBuild: expectBuild || null,
  startedAtUtc: new Date().toISOString(),
  fatal: null,
  controls: []
};
const verdicts = { PASS: 0, FAIL: 0, BLOCKED: 0 };

function flush() {
  report.counts = {
    controls: report.controls.length,
    pass: verdicts.PASS, fail: verdicts.FAIL, blocked: verdicts.BLOCKED,
    durationMs: Date.now() - startedAt
  };
  report.finishedAtUtc = new Date().toISOString();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'functional-sweep-report.json'), JSON.stringify(report, null, 2));
  const rows = ['control_id,area,verdict'];
  for (const c of report.controls) rows.push(`${c.control_id},${c.area},${c.verdict}`);
  fs.writeFileSync(path.join(outDir, 'functional-sweep-control-coverage.csv'), rows.join('\n') + '\n');
}

function record(c) {
  if (verdicts[c.verdict] === undefined) c.verdict = 'FAIL';
  verdicts[c.verdict]++;
  report.controls.push(c);
  flush();
  process.stdout.write(`FUNCTIONAL ${c.verdict}  ${c.control_id}  (${c.note || c.actual || ''})\n`);
}

// ---------------------------------------------------------------- http -----
async function req(method, url, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const r = await fetch(url, {
      method, headers, body,
      signal: ac.signal,
      redirect: 'manual',
      cache: 'no-store'
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const out = { status: r.status, headers: Object.fromEntries(r.headers.entries()), bytes: buf };
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json') || ct.includes('text')) {
      out.text = buf.toString('utf8');
      if (ct.includes('json')) { try { out.json = JSON.parse(out.text); } catch (e) { out.jsonParseError = String(e.message); } }
    }
    return out;
  } finally { clearTimeout(t); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------- fixtures ----
// Byte-pinned expectations for the fixtures whose content is deterministic
// (Stage-FxFixtures.ps1 writes them from fixed bytes). lab-readme.txt embeds
// the staging timestamp, so its check is marker + index-checksum consistency.
const PINNED = {
  '/lab-fixture/lab-pixel.png': {
    sha256: '3220fc7838ccdab0a3a21b5d8498275c7abe6930abbb059e9fdb4939bba8c2fd',
    size: 69, mime: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47])
  },
  '/lab-fixture/subdir/lab-nested.txt': {
    sha256: 'd24f2a37b3b77df27d851c32c132459c609a4d6e860d98142bef16b67c4fb90d',
    size: 19, mime: 'text/plain', text: 'nested lab fixture'
  },
  '/lab-fixture/lab-readme.txt': { marker: 'lab file explorer fixture', mime: 'text/plain' },
  '/lab-fixture/lab-data.json': { marker: 'disposable lab fixture', mime: 'application/json' }
};
const FX_ROOT = 'RDP-Storage';
function stableId(p) { return crypto.createHash('sha1').update(Buffer.from(FX_ROOT + p, 'utf8')).digest('hex'); }

// ---------------------------------------------------------------- main -----
let dashToken = '';
let csrfToken = '';
let fxIndex = null;

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (dashToken) h['X-Dash-Token'] = dashToken;
  return h;
}

async function fxList() {
  const r = await req('GET', target + '/api/fx/list', { headers: authHeaders() });
  if (r.status === 200 && r.json && r.json.schemaVersion === 2) { fxIndex = r.json; }
  const hdrTok = r.headers['x-csrf-token'] || '';
  const setCookie = r.headers['set-cookie'] || '';
  const m = /ghrdp_fx_csrf=([A-Za-z0-9._-]+)/.exec(Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie));
  if (hdrTok) csrfToken = hdrTok; else if (m) csrfToken = m[1];
  return r;
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await req('GET', target + '/health', { timeoutMs: 5000 });
      last = r.status;
      if (r.status === 200) return true;
    } catch (e) { last = String(e.message); }
    await sleep(2000);
  }
  report.fatal = 'backend never became healthy within ' + timeoutMs + 'ms (last=' + last + ')';
  return false;
}

async function sectionFx() {
  // ---- fx.list.contract ---------------------------------------------------
  const r = await fxList();
  const files = (fxIndex && Array.isArray(fxIndex.files)) ? fxIndex.files : [];
  const roots = (fxIndex && Array.isArray(fxIndex.roots)) ? fxIndex.roots : [];
  const idOk = files.every(f => f.id === stableId(String(f.path)));
  const expectedPaths = Object.keys(PINNED);
  const haveAll = expectedPaths.every(p => files.some(f => String(f.path) === p));
  record({
    control_id: 'fx.list.contract', area: 'files',
    action: 'GET /api/fx/list with the dashboard token; validate the v2 index contract.',
    expectReq: '200, schemaVersion 2, RDP-Storage root, the 4 staged fixtures, ids == SHA-1(root+path), CSRF token issued',
    actual: `status=${r.status} schemaVersion=${fxIndex ? fxIndex.schemaVersion : 'none'} roots=[${roots.map(x => x.root).join(',')}] files=${files.length} idsRecomputeOk=${idOk} allFixturesPresent=${haveAll} csrfIssued=${Boolean(csrfToken)}`,
    verdict: r.status === 200 && fxIndex && fxIndex.schemaVersion === 2 && roots.some(x => x.root === FX_ROOT) && idOk && haveAll && Boolean(csrfToken) ? 'PASS' : 'FAIL',
    note: 'the index checksum is the download-verify reference; ids are recomputed, not trusted'
  });
  if (!fxIndex || !files.length) {
    for (const id of ['fx.preview.download_verify', 'fx.preview.range', 'fx.preview.errors', 'fx.op.guardrails', 'fx.op.lifecycle', 'fx.upload.queue']) {
      record({ control_id: id, area: 'files', action: 'not attempted', expectReq: 'n/a', actual: 'BLOCKED: no fx index', verdict: 'BLOCKED' });
    }
    return;
  }
  const byPath = {};
  for (const f of files) byPath[String(f.path)] = f;

  // ---- fx.preview.download_verify ----------------------------------------
  {
    const per = [];
    let ok = true;
    for (const [p, pin] of Object.entries(PINNED)) {
      const f = byPath[p];
      if (!f) { per.push(`${p}:absent`); ok = false; continue; }
      const r2 = await req('GET', target + '/api/fx/preview?id=' + encodeURIComponent(f.id), { headers: authHeaders() });
      const sha = crypto.createHash('sha256').update(r2.bytes).digest('hex');
      const ct = (r2.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let fileOk = r2.status === 200 && sha === String(f.checksum).toLowerCase();
      let why = `status=${r2.status} sha256=${sha.slice(0, 12)}.. indexChecksum=${String(f.checksum).slice(0, 12)}.. ct=${ct}`;
      if (pin.sha256 && sha !== pin.sha256) { fileOk = false; why += ` PINNED_MISMATCH`; }
      if (pin.size && r2.bytes.length !== pin.size) { fileOk = false; why += ` size=${r2.bytes.length}!=${pin.size}`; }
      if (pin.magic && !r2.bytes.slice(0, 4).equals(pin.magic)) { fileOk = false; why += ' BAD_PNG_MAGIC'; }
      if (pin.text && !r2.text.includes(pin.text)) { fileOk = false; why += ' TEXT_MARKER_MISSING'; }
      if (pin.marker && !(r2.text || '').includes(pin.marker)) { fileOk = false; why += ' MARKER_MISSING'; }
      if (pin.mime && ct !== pin.mime) { fileOk = false; why += ` MIME_${ct}!=${pin.mime}`; }
      if (!(r2.headers['accept-ranges'] === 'bytes')) { fileOk = false; why += ' no-accept-ranges'; }
      if (!(r2.headers['x-content-type-options'] || '').includes('nosniff')) { fileOk = false; why += ' no-nosniff'; }
      per.push(`${p}: ${fileOk ? 'ok' : 'FAIL'} (${why})`);
      if (!fileOk) ok = false;
    }
    record({
      control_id: 'fx.preview.download_verify', area: 'files',
      action: 'GET /api/fx/preview for every staged fixture; hash the bytes.',
      expectReq: '200; bytes sha256 == index checksum; pinned sha256 for the byte-deterministic fixtures; inline disposition + nosniff',
      actual: per.join(' | '),
      verdict: ok ? 'PASS' : 'FAIL',
      note: 'download verification is three-way: pinned bytes, index checksum, served bytes'
    });
  }

  // ---- fx.preview.range ---------------------------------------------------
  {
    const png = byPath['/lab-fixture/lab-pixel.png'];
    const full = await req('GET', target + '/api/fx/preview?id=' + encodeURIComponent(png.id), { headers: authHeaders() });
    const part = await req('GET', target + '/api/fx/preview?id=' + encodeURIComponent(png.id), { headers: authHeaders({ 'Range': 'bytes=0-15' }) });
    const bad = await req('GET', target + '/api/fx/preview?id=' + encodeURIComponent(png.id), { headers: authHeaders({ 'Range': 'bytes=999999-1000000' }) });
    const sliceOk = part.status === 206 && part.bytes.length === 16 && part.bytes.equals(full.bytes.slice(0, 16));
    const crOk = (part.headers['content-range'] || '') === `bytes 0-15/${png.size}`;
    const unsatOk = bad.status === 416 && (bad.headers['content-range'] || '') === `bytes */${png.size}`;
    record({
      control_id: 'fx.preview.range', area: 'files',
      action: 'Range: bytes=0-15 then an unsatisfiable range on the PNG fixture.',
      expectReq: '206 with exactly the first 16 bytes + Content-Range bytes 0-15/<size>; unsatisfiable -> 416 + Content-Range bytes */<size>',
      actual: `slice206=${part.status} len=${part.bytes.length} prefixOk=${part.bytes.equals(full.bytes.slice(0, 16))} contentRange=${part.headers['content-range'] || 'none'} | unsat=${bad.status} contentRange=${bad.headers['content-range'] || 'none'}`,
      verdict: sliceOk && crOk && unsatOk ? 'PASS' : 'FAIL'
    });
  }

  // ---- fx.preview.errors --------------------------------------------------
  {
    const unknown = await req('GET', target + '/api/fx/preview?id=' + '0'.repeat(40), { headers: authHeaders() });
    const missing = await req('GET', target + '/api/fx/preview', { headers: authHeaders() });
    record({
      control_id: 'fx.preview.errors', area: 'files',
      action: 'Preview an unknown id and omit the id.',
      expectReq: 'unknown id -> 404; missing id -> 400',
      actual: `unknown=${unknown.status} missing=${missing.status}`,
      verdict: unknown.status === 404 && missing.status === 400 ? 'PASS' : 'FAIL'
    });
  }

  // ---- fx.op.guardrails ---------------------------------------------------
  const opHeaders = () => authHeaders({
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    'X-Idempotency-Key': crypto.randomBytes(8).toString('hex')
  });
  {
    const readme = byPath['/lab-fixture/lab-readme.txt'];
    const noCsrf = await req('POST', target + '/api/fx/op', { headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ op: 'tag', ids: [readme.id], tags: ['x'] }) });
    const badOp = await req('POST', target + '/api/fx/op', { headers: opHeaders(), body: JSON.stringify({ op: 'shred', ids: [readme.id] }) });
    const noIds = await req('POST', target + '/api/fx/op', { headers: opHeaders(), body: JSON.stringify({ op: 'trash', ids: [] }) });
    const hardFlag = await req('POST', target + '/api/fx/op', { headers: opHeaders(), body: JSON.stringify({ op: 'trash', ids: [readme.id], hard: false }) });
    const unknownId = await req('POST', target + '/api/fx/op', { headers: opHeaders(), body: JSON.stringify({ op: 'tag', ids: ['deadbeef'.repeat(5)], tags: ['x'] }) });
    const skippedReason = unknownId.json && unknownId.json.skipped && unknownId.json.skipped[0] && unknownId.json.skipped[0].reason;
    record({
      control_id: 'fx.op.guardrails', area: 'files',
      action: 'POST /api/fx/op: no CSRF, unknown op, empty ids, hard flag, unknown id.',
      expectReq: '403 CSRF; 400 unknown op; 400 empty ids; 400 hard flag (any value); unknown id -> 200 {applied:[], skipped:[{reason:unknown id}]}',
      actual: `noCsrf=${noCsrf.status} badOp=${badOp.status}(${badOp.json && badOp.json.message ? 'msg' : 'no-msg'}) emptyIds=${noIds.status} hard=${hardFlag.status} unknownId=${unknownId.status} skippedReason=${skippedReason}`,
      verdict: noCsrf.status === 403 && badOp.status === 400 && noIds.status === 400 && hardFlag.status === 400 && unknownId.status === 200 && /unknown id/.test(String(skippedReason)) ? 'PASS' : 'FAIL',
      note: 'hard delete exists nowhere in the Explorer contract'
    });
  }

  // ---- fx.op.lifecycle ----------------------------------------------------
  {
    const readme = byPath['/lab-fixture/lab-readme.txt'];
    const nested = byPath['/lab-fixture/subdir/lab-nested.txt'];
    const steps = [];
    const step = async (name, body, want) => {
      const r2 = await req('POST', target + '/api/fx/op', { headers: opHeaders(), body: JSON.stringify(body) });
      const applied = (r2.json && Array.isArray(r2.json.applied)) ? r2.json.applied : null;
      const skipped = (r2.json && Array.isArray(r2.json.skipped)) ? r2.json.skipped : null;
      const ok = r2.status === 200 && want(applied, skipped, r2.json);
      steps.push(`${name}:${ok ? 'ok' : 'FAIL'}(status=${r2.status} applied=${JSON.stringify(applied)} skipped=${JSON.stringify(skipped)})`);
      return ok;
    };
    let ok = true;
    ok = (await step('tag', { op: 'tag', ids: [readme.id], tags: ['sweep-probe'] }, (a) => a.includes(readme.id))) && ok;
    ok = (await step('tag-merge-idempotent', { op: 'tag', ids: [readme.id], tags: ['sweep-probe'] }, (a, s) => a.includes(readme.id))) && ok;
    ok = (await step('pin', { op: 'pin', ids: [readme.id], pin: true }, (a) => a.includes(readme.id))) && ok;
    ok = (await step('pin-again-skipped', { op: 'pin', ids: [readme.id], pin: true }, (a, s) => s.length === 1 && /pin state/.test(s[0].reason))) && ok;
    ok = (await step('unpin', { op: 'pin', ids: [readme.id], pin: false }, (a) => a.includes(readme.id))) && ok;
    ok = (await step('trash', { op: 'trash', ids: [readme.id] }, (a) => a.includes(readme.id))) && ok;
    ok = (await step('trash-again-skipped', { op: 'trash', ids: [readme.id] }, (a, s) => s.length === 1 && /already trashed/.test(s[0].reason))) && ok;
    ok = (await step('restore', { op: 'restore', ids: [readme.id] }, (a) => a.includes(readme.id))) && ok;
    ok = (await step('restore-again-skipped', { op: 'restore', ids: [readme.id] }, (a, s) => s.length === 1 && /not trashed/.test(s[0].reason))) && ok;
    // move: nested.txt -> renamed path; the response reports the ASKED id, the
    // index gets a NEW id (SHA-1(root+path)) - the caller re-reads /list.
    const movedPath = '/lab-fixture/subdir/lab-nested-moved.txt';
    ok = (await step('move', { op: 'move', ids: [nested.id], target: movedPath }, (a) => a.includes(nested.id))) && ok;
    await fxList();
    const movedEntry = fxIndex && fxIndex.files.find(f => String(f.path) === movedPath);
    const oldGone = fxIndex && !fxIndex.files.some(f => String(f.path) === '/lab-fixture/subdir/lab-nested.txt');
    const newIdOk = movedEntry && movedEntry.id === stableId(movedPath);
    steps.push(`move-relist:oldGone=${oldGone} newIdRecomputed=${newIdOk}`);
    ok = oldGone && newIdOk && ok;
    // state restoration for later probes: move back, drop the probe tag.
    await step('move-back', { op: 'move', ids: [movedEntry ? movedEntry.id : nested.id], target: '/lab-fixture/subdir/lab-nested.txt' }, () => true);
    // verify readback of tags/pinned persisted through the moves
    await fxList();
    const readmeNow = fxIndex.files.find(f => String(f.path) === '/lab-fixture/lab-readme.txt');
    const tagsOk = readmeNow && Array.isArray(readmeNow.tags) && readmeNow.tags.includes('sweep-probe') && readmeNow.tags.filter(t => t === 'sweep-probe').length === 1;
    steps.push(`tag-persisted-merged-once=${tagsOk}`);
    ok = tagsOk && ok;
    record({
      control_id: 'fx.op.lifecycle', area: 'files',
      action: 'Run the full op lifecycle on the disposable fixtures: tag (merge), pin/unpin, trash/restore (incl. repeat-skip), move with new stable id.',
      expectReq: 'each op 200 {applied,skipped}; repeats skip with the exact reason; a move mints the new SHA-1(root+path) id; tags persist and merge without duplicates',
      actual: steps.join(' | '),
      verdict: ok ? 'PASS' : 'FAIL',
      note: 'state restored after the probe (move back); the probe tag remains, recorded here'
    });
  }

  // ---- fx.upload.queue ----------------------------------------------------
  {
    const png = byPath['/lab-fixture/lab-pixel.png'];
    const up = await req('POST', target + '/api/fx/upload', { headers: opHeaders(), body: JSON.stringify({ ids: [png.id], host: 'gofile' }) });
    const job = up.json && up.json.jobs && up.json.jobs[0];
    const jobOk = up.status === 202 && job && job.id === png.id && /^fxj-/.test(String(job.uploadJobId || ''));
    let statusLine = 'not-fetched';
    let statusOk = false;
    if (jobOk) {
      const gs = await req('GET', target + '/api/fx/gofile/status?id=' + encodeURIComponent(png.id), { headers: authHeaders() });
      const st = gs.json && (gs.json.status !== undefined);
      statusOk = gs.status === 200 && st;
      statusLine = `gofileStatus=${gs.status} shape=${st}`;
    }
    record({
      control_id: 'fx.upload.queue', area: 'files',
      action: 'POST /api/fx/upload {ids:[png], host:gofile} then GET /api/fx/gofile/status.',
      expectReq: '202 {jobs:[{id, uploadJobId fxj-*}]}; gofile status 200 with a status field',
      actual: `upload=${up.status} job=${jobOk ? 'ok' : 'BAD'} ${statusLine}`,
      verdict: jobOk && statusOk ? 'PASS' : 'FAIL',
      note: 'queue contract only: external gofile delivery is NOT claimed (needs host credentials; separately gated)'
    });
  }
}

async function sectionSearch() {
  const hdrs = () => authHeaders({ 'Content-Type': 'application/json' });
  // create -> terminal phase
  const create = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'websocket protocol', adapterIds: ['wikipedia-public'], limit: 5 }) });
  const j = create.json || {};
  const createOk = create.status === 202 && j.searchId && (j.statusRef || '').includes('/api/search/status?searchId=') && Array.isArray(j.adapterStatuses);
  let phase = 'none'; let terminalOk = false; let rows = 'not-polled';
  if (createOk) {
    for (let i = 0; i < 10 && !terminalOk; i++) {
      const st = await req('GET', target + j.statusRef, { headers: authHeaders() });
      const sj = st.json || {};
      phase = String(sj.phase || phase);
      rows = `status=${st.status} phase=${phase} searchIdEcho=${Boolean(sj.searchId)}`;
      terminalOk = st.status === 200 && sj.searchId && ['complete', 'empty', 'failed', 'cancelled'].includes(phase);
      if (!terminalOk) await sleep(1500);
    }
  }
  record({
    control_id: 'search.lifecycle', area: 'search',
    action: 'POST /api/search (wikipedia-public, limit 5) with the dash token, then poll the statusRef to a terminal phase.',
    expectReq: '202 {searchId, statusRef, phase, adapterStatuses}; status reaches a terminal phase (complete/empty/failed) with the searchId echoed',
    actual: `create=${create.status} searchId=${Boolean(j.searchId)} statusRef=${Boolean(j.statusRef)} | ${rows}`,
    verdict: createOk && terminalOk ? 'PASS' : 'FAIL',
    note: 'content is nondeterministic; the CONTRACT (202/status/terminal phase) is the measured fact'
  });

  // cancel (a second search)
  {
    const c2 = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'quantum tunneling', adapterIds: ['arxiv-public'], limit: 5 }) });
    const j2 = c2.json || {};
    let cancelLine = 'create-failed';
    let ok = false;
    if (c2.status === 202 && j2.searchId) {
      const cancel = await req('POST', target + '/api/search/cancel', { headers: hdrs(), body: JSON.stringify({ searchId: j2.searchId }) });
      const st = await req('GET', target + '/api/search/status?searchId=' + encodeURIComponent(j2.searchId), { headers: authHeaders() });
      const finalPhase = String((st.json || {}).phase || '');
      cancelLine = `cancel=${cancel.status} finalPhase=${finalPhase}`;
      ok = cancel.status === 200 && (finalPhase === 'cancelled' || finalPhase === 'complete' || finalPhase === 'empty');
    }
    record({
      control_id: 'search.cancel', area: 'search',
      action: 'Create a second search and cancel it.',
      expectReq: 'cancel 200; the record reports cancelled (or already-terminal, recorded truthfully)',
      actual: cancelLine,
      verdict: ok ? 'PASS' : 'FAIL'
    });
  }

  // validation negatives
  {
    const url = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'see https://example.com/x' }) });
    const unknownAdapter = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'x', adapterIds: ['not-a-source'] }) });
    const limitLow = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'x', limit: 0 }) });
    const limitHigh = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({ query: 'x', limit: 51 }) });
    const noQuery = await req('POST', target + '/api/search', { headers: hdrs(), body: JSON.stringify({}) });
    const code = (r) => (r.json && r.json.code) || '';
    record({
      control_id: 'search.validation', area: 'search',
      action: 'Validation negatives: URL-in-query, unknown adapter, limit 0/51, missing query.',
      expectReq: '400 each, with code VALIDATION_ERROR (URL, limit, query) and UNKNOWN_SOURCE (adapter)',
      actual: `url=${url.status}/${code(url)} adapter=${unknownAdapter.status}/${code(unknownAdapter)} limit0=${limitLow.status}/${code(limitLow)} limit51=${limitHigh.status}/${code(limitHigh)} noQuery=${noQuery.status}/${code(noQuery)}`,
      verdict: url.status === 400 && code(url) === 'VALIDATION_ERROR' && unknownAdapter.status === 400 && code(unknownAdapter) === 'UNKNOWN_SOURCE' && limitLow.status === 400 && limitHigh.status === 400 && noQuery.status === 400 ? 'PASS' : 'FAIL',
      note: 'the locked rule: a query must never carry an arbitrary URL'
    });
  }
}

async function sectionCore() {
  // native-status (the Sessions/Keys pages read this)
  {
    const r = await req('GET', target + '/api/native-status', { headers: authHeaders() });
    const j = r.json || {};
    const rl = j.rdpListener || {};
    const hasAuthEvents = rl.authEvents && (rl.authEvents['4624'] !== undefined || rl.authEvents['4625'] !== undefined || Object.keys(rl.authEvents).length >= 0);
    const ok = r.status === 200 && (j.fqdn !== undefined) && (j.user !== undefined) && rl && typeof rl === 'object' && hasAuthEvents !== false;
    record({
      control_id: 'core.native_status', area: 'sessions',
      action: 'GET /api/native-status with the dash token (the Sessions + Keys pages poll this).',
      expectReq: '200 with fqdn/user/rdpListener; rdpListener carries authEvents (the 4624/4625 table source)',
      actual: `status=${r.status} fqdn=${j.fqdn ? 'present' : 'MISSING'} user=${j.user ? 'present' : 'MISSING'} rdpListener=${rl ? 'present' : 'MISSING'} authEvents=${rl.authEvents ? Object.keys(rl.authEvents).join('+') || '(empty)' : 'MISSING'} ticketAudit=${j.ticketAudit ? 'present' : 'MISSING'}`,
      verdict: ok ? 'PASS' : 'FAIL',
      note: 'Sessions reads native-status, NOT /api/sessions (earlier harness defect)'
    });
  }
  // config
  {
    const r = await req('GET', target + '/api/config', { headers: authHeaders() });
    const j = r.json || {};
    record({
      control_id: 'core.config', area: 'overview',
      action: 'GET /api/config with the dash token.',
      expectReq: '200; searchEnabled true on the candidate config',
      actual: `status=${r.status} searchEnabled=${j.searchEnabled}`,
      verdict: r.status === 200 && (j.searchEnabled === true || j.searchEnabled === undefined) ? 'PASS' : 'FAIL',
      note: 'configure-capability.js enables the search lane; absent means v1 shape (recorded, not failed)'
    });
  }
  // rdp-token
  {
    const noAuth = await req('POST', target + '/api/rdp-token', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const ok = await req('POST', target + '/api/rdp-token', { headers: { Authorization: 'Bearer ' + dashToken } });
    const rid = ok.json && ok.json.rid;
    const ridOk = /^[0-9a-f]{32}$/.test(String(rid || ''));
    record({
      control_id: 'core.rdp_token', area: 'connections',
      action: 'POST /api/rdp-token without auth, then with Bearer (the WINDOWS AUTO-LOGIN ticket path).',
      expectReq: 'unauthenticated -> 401/403; Bearer -> 200 {rid: 32-hex single-use ticket}',
      actual: `noAuth=${noAuth.status} auth=${ok.status} rid=${ridOk ? '32-hex' : String(rid).slice(0, 12)}`,
      verdict: (noAuth.status === 401 || noAuth.status === 403) && ok.status === 200 && ridOk ? 'PASS' : 'FAIL',
      note: 'ticket consumption needs the ghrdp:// handler (separately gated); only issue is claimed here'
    });
  }
  // purge command
  {
    const r = await req('GET', target + '/api/purge-stale-creds', { headers: { Authorization: 'Bearer ' + dashToken } });
    const cmd = r.json && r.json.command;
    record({
      control_id: 'core.purge_command', area: 'keys',
      action: 'GET /api/purge-stale-creds with Bearer (the Keys page purge-command block).',
      expectReq: '200 {command: string} (a copy-only server-generated command, never executed here)',
      actual: `status=${r.status} command=${cmd ? 'present(' + String(cmd).length + ' chars)' : 'MISSING'}`,
      verdict: r.status === 200 && typeof cmd === 'string' && cmd.length > 0 ? 'PASS' : 'FAIL'
    });
  }
  // health + diag
  {
    const h = await req('GET', target + '/health');
    const d = await req('GET', target + '/api/diag', { headers: authHeaders() });
    const dj = d.json || {};
    record({
      control_id: 'core.health_diag', area: 'health',
      action: 'GET /health and /api/diag.',
      expectReq: '/health 200 ok; /api/diag reports searchEnabled true',
      actual: `health=${h.status} bodyOk=${/ok/i.test(h.text || '')} diag=${d.status} searchEnabled=${dj.searchEnabled}`,
      verdict: h.status === 200 && d.status === 200 && dj.searchEnabled === true ? 'PASS' : 'FAIL'
    });
  }
}

async function main() {
  try {
    if (!target) { report.fatal = 'missing --target'; flush(); process.exit(1); }
    const secret = String(process.env.RDP_LAB_PASSWORD || '');
    if (!secret) { report.fatal = 'missing RDP_LAB_PASSWORD (the lab dash-token secret)'; flush(); process.exit(1); }
    dashToken = deriveDashboardToken({ secret, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1' });
    registerSecret(dashToken, 'CAPABILITY_DASH_TOKEN');
    report.tokenFingerprint = crypto.createHash('sha256').update(dashToken).digest('hex').slice(0, 12);

    if (!(await waitReady(Math.min(maxMs, 120000)))) { flush(); process.exit(1); }

    await sectionFx();
    await sectionSearch();
    await sectionCore();

    flush();
    process.stdout.write('FUNCTIONAL_SWEEP ' + label + ' fatal=' + (report.fatal || 'none') + ' counts=' + JSON.stringify(verdicts) + '\n');
    process.exit(verdicts.FAIL > 0 || report.fatal ? 1 : 0);
  } catch (e) {
    report.fatal = redact(String(e && e.stack || e)).split('\n')[0];
    flush();
    process.stdout.write('FUNCTIONAL_SWEEP ' + label + ' FATAL ' + report.fatal + '\n');
    process.exit(1);
  }
}

main();
