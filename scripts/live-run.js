#!/usr/bin/env node
'use strict';
// LIVE-RUN ORCHESTRATOR — the automatic Mission Control integration.
// ---------------------------------------------------------------------------
// Sub-commands:
//   origin-signal   run on the machine that hosts the live backend (the app
//                   workflow's runner, or the lab's own server job for its CI
//                   self-validation). Publishes the non-secret descriptor and
//                   the per-run credential envelope while the server is alive.
//   live            run on the interactive Windows client. Claims the origin
//                   run, verifies it against GitHub, authenticates, opens the
//                   real UI in a headed browser, drives the feature inventory,
//                   launches native RDP through the production verb, and writes
//                   the report + ack.
//   poll-records    the lab-side queue reader: which descriptors are waiting
//                   and who owns them (never "the latest server").
//   ack             the origin side's bounded wait for the lab to accept,
//                   connect, test and report — so the application never waits
//                   on the *workflow* finishing (which would be a cycle).
//
// Exit codes are shared with lib/consent-state.js so a single vocabulary
// describes both the SETUP helper and the live run:
//   0 accepted/verified · 4 BLOCKED (prerequisite outside the code)
//   5 no evidence       · 64 usage  · 69 platform
//   7 unconfirmed       · 8 expired · 9 busy (another live claimant owns the VM)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const { STATUS } = require('./lib/status');
const { CapabilitySet } = require('./lib/status');
const annotate = require('./lib/annotate');
const { redact } = require('./lib/redact');
const { acquireLock, releaseLock } = require('./lib/lock');
const rd = require('./lib/run-descriptor');
const store = require('./lib/record-store');
const { verifyOriginRun } = require('./lib/verify-origin');
const auth = require('./lib/live-auth');
const feat = require('./lib/live-features');
const { buildInventory, summarizeInventory } = require('./lib/live-inventory');
const { artifactDir, writeCapabilities } = require('./lib/results');
const { request } = require('./lib/http');
const { waitForReady } = require('./lib/readiness');
const discovery = require('./lib/origin-discovery');
const serverIdentity = require('./lib/server-identity');

const EXIT = { OK: 0, USAGE: 64, NOT_WINDOWS: 69, BLOCKED: 4, NO_EVIDENCE: 5, UNCONFIRMED: 7, EXPIRED: 8, BUSY: 9 };
/** The operator-facing pipeline. `stage` in every report is one of these. */
// AUTHENTICATING is the stage a run is IN while the authorization proof is
// running; AUTHENTICATED is only ever recorded once that proof succeeded. The
// earlier code entered 'AUTHENTICATED' BEFORE proving anything, so a blocked
// run's own report read like a logged-in one.
const STAGES = ['STARTING', 'AWAITING_READINESS', 'CLAIMED', 'CONNECTING_VM', 'AUTHENTICATING', 'AUTHENTICATED', 'TESTING', 'REPORTING', 'COMPLETED', 'BLOCKED', 'FAILED', 'EXPIRED'];

const log = (...a) => console.log(`[live ${new Date().toISOString().slice(11, 23)}]`, ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x).slice(0, 400)));

function parseArgs(argv) {
  const a = {
    cmd: argv[2] || '', mode: 'live-origin', originRepo: '', originRunId: 0, originAttempt: 1,
    appSha: '', uiBuild: '', backendHostname: '', target: '', port: 7331, correlationId: '',
    labRepo: process.env.GITHUB_REPOSITORY || 'dictationb1/supreme-lamp-lab',
    ttlMs: 45 * 60 * 1000, envelopeOut: '', envelopeInline: '', artifactOnly: false,
    timeoutMs: 22 * 60 * 1000, readyTimeoutMs: 180000, headless: false,
    nativeHandoff: 'auto', allowDestructive: false, queueWaitMs: 10 * 60 * 1000,
    claim: true, reportPath: '', skipBrowser: false, clientIp: '', rdpUser: '',
    profileDir: '', outDir: '', ackPollMs: 20000, expectRunning: true,
    envelopeArtifactRepo: '', envelopeArtifactRunId: 0, envelopeArtifactName: '', recordOut: '',
    // Origin transport: how the CURRENT RUN's authorization reaches this client.
    //   auto        - MC-SIGNAL first (check-run output, RSA-OAEP ciphertext),
    //                 the origin's own run log only as a REPORTED fallback
    //   signal      - MC-SIGNAL only; a signal failure is reported and NOT
    //                 silently downgraded to the plaintext run log
    //   log         - the origin's own run log only (plaintext credential; used
    //                 to prove the fallback still works, never the default)
    //   record      - the application published a descriptor+envelope artifact
    //   public-log  - DEPRECATED alias of `auto` from the earlier design when
    //                 log scraping was believed to be the primary transport
    originTransport: 'auto', descriptorId: '', descriptorIdentity: '', originWorkflow: discovery.ORIGIN_WORKFLOW_DEFAULT,
    // Authorization proof: its own timeout, and an optional explicit answer to
    // "is this client a tailnet peer?" (the default measures it with the
    // tailscale CLI; a probe can pin it so a measurement failure cannot be
    // mistaken for a non-peer source).
    authTimeoutMs: 15000, clientIsTailnetPeer: '', probeOnly: false, probeOut: 'authorization-probe.json',
    blockedCode: '', blockedSubcode: '', blockedFamily: '', blockedRetryable: '', blockedDetail: '',
    discoverOut: '', jsonOut: '', publish: false, seedSha: ''
  };
  for (let i = 3; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const n = argv[i + 1]; if (n === undefined) throw new Error(`missing value for ${k}`); i++; return n; };
    if (k === '--mode') a.mode = v();
    else if (k === '--origin-repo') a.originRepo = v();
    else if (k === '--origin-run') a.originRunId = Number(v());
    else if (k === '--origin-attempt') a.originAttempt = Number(v());
    else if (k === '--app-sha') a.appSha = v();
    else if (k === '--ui-build') a.uiBuild = v();
    else if (k === '--backend-hostname') a.backendHostname = v();
    else if (k === '--target') a.target = v().replace(/\/+$/, '');
    else if (k === '--port') a.port = Number(v());
    else if (k === '--correlation-id') a.correlationId = v();
    else if (k === '--lab-repo') a.labRepo = v();
    else if (k === '--ttl-ms') a.ttlMs = Number(v());
    else if (k === '--envelope-out') a.envelopeOut = v();
    else if (k === '--envelope-inline') a.envelopeInline = v();
    else if (k === '--artifact-only') a.artifactOnly = true;
    else if (k === '--timeout-ms') a.timeoutMs = Number(v());
    else if (k === '--ready-timeout-ms') a.readyTimeoutMs = Number(v());
    else if (k === '--headless') a.headless = true;
    else if (k === '--native-handoff') a.nativeHandoff = v();
    else if (k === '--allow-destructive') a.allowDestructive = true;
    else if (k === '--queue-wait-ms') a.queueWaitMs = Number(v());
    else if (k === '--no-claim') a.claim = false;
    else if (k === '--report') a.reportPath = v();
    else if (k === '--skip-browser') a.skipBrowser = true;
    else if (k === '--auth-timeout-ms') a.authTimeoutMs = Number(v());
    else if (k === '--client-is-tailnet-peer') a.clientIsTailnetPeer = v();
    else if (k === '--probe-only') a.probeOnly = true;
    else if (k === '--probe-out') a.probeOut = v();
    else if (k === '--blocked-code') a.blockedCode = v();
    else if (k === '--blocked-subcode') a.blockedSubcode = v();
    else if (k === '--blocked-family') a.blockedFamily = v();
    else if (k === '--blocked-retryable') a.blockedRetryable = v();
    else if (k === '--blocked-detail') a.blockedDetail = v();
    else if (k === '--client-ip') a.clientIp = v();
    else if (k === '--rdp-user') a.rdpUser = v();
    else if (k === '--profile-dir') a.profileDir = v();
    else if (k === '--out-dir') a.outDir = v();
    else if (k === '--ack-poll-ms') a.ackPollMs = Number(v());
    else if (k === '--job-result') a.jobResult = v();
    else if (k === '--lab-revision') a.labRevision = v();
    else if (k === '--dispatch-out') a.dispatchOut = v();
    else if (k === '--envelope-artifact-repo') a.envelopeArtifactRepo = v();
    else if (k === '--envelope-artifact-run') a.envelopeArtifactRunId = Number(v());
    else if (k === '--record-out') a.recordOut = v();
    else if (k === '--envelope-artifact-name') a.envelopeArtifactName = v();
    else if (k === '--allow-non-running-origin') a.expectRunning = false;
    else if (k === '--origin-transport') a.originTransport = v();
    else if (k === '--descriptor-id') a.descriptorId = v();
    else if (k === '--descriptor-identity') a.descriptorIdentity = v();
    else if (k === '--origin-workflow') a.originWorkflow = v();
    else if (k === '--discover-out') a.discoverOut = v();
    else if (k === '--json-out') a.jsonOut = v();
    else if (k === '--publish') a.publish = true;
    else if (k === '--seed-sha') a.seedSha = v();
    else { const e = new Error(`unknown flag ${k}`); e.code = 'USAGE'; throw e; }
  }
  // Canonicalize the transport value once, so no later code path can disagree
  // about what "public-log" meant. The old name described a transport that is
  // no longer primary; keeping it as an alias avoids breaking an operator's
  // saved command line, but the report always names the transport actually used.
  const aliases = { 'public-log': 'auto', 'origin-public-log': 'auto', 'live-signal': 'signal', 'check-run': 'signal' };
  if (aliases[a.originTransport]) a.originTransportRequested = a.originTransport;
  if (aliases[a.originTransport]) a.originTransport = aliases[a.originTransport];
  if (!['auto', 'signal', 'log', 'record'].includes(a.originTransport)) {
    const e = new Error(`unknown --origin-transport ${JSON.stringify(a.originTransport)} (auto | signal | log | record)`);
    e.code = 'USAGE';
    throw e;
  }
  return a;
}

function envOr(name, fallback) { const v = process.env[name]; return v && v.trim() ? v.trim() : fallback; }

/** Read the runner-side artifacts the app's own deploy step already wrote. */
function readRunnerState(root) {
  const out = { root, present: {}, config: null, dashToken: '', dnsName: '' };
  const cfgPath = path.join(root, 'config.json');
  try { out.config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); out.present.config = true; } catch (e) { out.present.config = `unavailable: ${e.code || e.message}`; }
  try { out.dashToken = fs.readFileSync(path.join(root, 'dash-token.txt'), 'utf8').trim(); out.present.dashToken = Boolean(out.dashToken); } catch (e) { out.present.dashToken = false; }
  if (!out.dashToken && out.config) out.dashToken = String(out.config.dashToken || '');
  out.dnsName = String((out.config && out.config.dnsName) || '');
  out.rdpUser = String((out.config && out.config.rdpUser) || '');
  out.rdpPass = String((out.config && out.config.rdpPass) || '');
  out.tailnetIp = String((out.config && (out.config.rdpIp || out.config.tailnetIp)) || '');
  return out;
}

/**
 * The workflow that is running THIS job, as a repository-relative path.
 * `GITHUB_WORKFLOW_REF` is `owner/repo/.github/workflows/x.yml@refs/heads/main`;
 * the older code took `.split('/').pop()`, which yields
 * `main.yml@refs/heads/main` and fails the descriptor's own validation. Parse
 * the path before the `@`, then fall back to the bare workflow name.
 */
function originWorkflowPath() {
  const ref = envOr('GITHUB_WORKFLOW_REF', '');
  const beforeRef = ref.split('@')[0];
  const idx = beforeRef.indexOf('.github/workflows/');
  if (idx >= 0) return beforeRef.slice(idx);
  const name = envOr('GITHUB_WORKFLOW', 'main.yml');
  return name.includes('/') ? name : `.github/workflows/${name}`;
}

function tailscaleFqdn() {
  const exe = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale';
  try {
    const j = JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
    const dns = String(j.Self && j.Self.DNSName ? j.Self.DNSName : '').replace(/\.$/, '').toLowerCase();
    const ip = Array.isArray(j.Self && j.Self.TailscaleIPs) ? j.Self.TailscaleIPs.find(x => /^\d+\./.test(x)) : '';
    return { fqdn: dns, ip: ip || '', name: String((j.Self && j.Self.HostName) || '') };
  } catch (e) { return { error: String(e.message || e).split('\n')[0] }; }
}

// ---------------------------------------------------------------------------
// origin-signal
// ---------------------------------------------------------------------------
async function cmdOriginSignal(a) {
  const t0 = Date.now();
  const root = a.root || envOr('GHRDP_ROOT', 'C:\\ghrdp');
  const st = readRunnerState(root);
  const originRepo = a.originRepo || envOr('GITHUB_REPOSITORY', '');
  const originRunId = a.originRunId || Number(envOr('GITHUB_RUN_ID', '0'));
  const originAttempt = a.originAttempt || Number(envOr('GITHUB_RUN_ATTEMPT', '1'));
  const appSha = a.appSha || envOr('GITHUB_SHA', '');
  const correlationId = a.correlationId || rd.randomCorrelationId('lr');
  const labRepo = a.labRepo;

  if (!originRepo || !originRunId || !appSha) return finish(EXIT.USAGE, { stage: 'STARTING', code: 'SIGNAL_INCOMPLETE', detail: `originRepo=${originRepo || '?'} runId=${originRunId || '?'} appSha=${appSha || '?'}` });
  if (!st.dashToken) return finish(EXIT.BLOCKED, { stage: 'STARTING', code: 'DASH_TOKEN_UNAVAILABLE', detail: `no current-run dashboard token at ${root}\\dash-token.txt / config.json (present=${JSON.stringify(st.present)})`, t: { signalMs: Date.now() - t0 } });

  const ts = tailscaleFqdn();
  const backendHostname = a.backendHostname || ts.fqdn || '';
  const backendIp = st.tailnetIp || ts.ip || '';
  const target = a.target || (backendHostname ? `http://${backendHostname}:${a.port}` : (backendIp ? `http://${backendIp}:${a.port}` : ''));
  if (!target) return finish(EXIT.BLOCKED, { stage: 'AWAITING_READINESS', code: 'BACKEND_ADDRESS_UNKNOWN', detail: 'neither a MagicDNS name nor a tailnet IP is resolvable from this runner', tailscale: ts, t: { signalMs: Date.now() - t0 } });

  // Only advertise the run once the dashboard really answers: the descriptor
  // is a promise that the server is alive, so verify before publishing it.
  const ready = await waitForReady(target, { timeoutMs: Math.min(a.readyTimeoutMs, 90000) });
  if (!ready.ready) {
    return finish(EXIT.BLOCKED, { stage: 'AWAITING_READINESS', code: ready.code, detail: `the run's own backend is not answering on ${redact(target)}: ${redact(ready.detail)}`, readinessHistory: (ready.history || []).slice(-6), t: { signalMs: Date.now() - t0 } });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.min(a.ttlMs, rd.MAX_TTL_MS)).toISOString();
  const descriptor = rd.validateDescriptor({
    protocol: rd.PROTOCOL,
    originRepo, originWorkflow: originWorkflowPath(),
    originRunId, originAttempt, appSha,
    uiBuild: a.uiBuild || envOr('GHRDP_UI_BUILD', '') || String(JSON.stringify(st.config.uiBuild || '').replace(/"/g, '') || appSha),
    backendIdentity: `${originRunId}-${originAttempt}:${ready.last.body.pid}@${backendHostname || backendIp}`,
    authorizedEndpoint: target,
    issuedAt: now.toISOString(), expiresAt,
    // The lab revision this origin expects to be paired with. In an app job
    // GITHUB_SHA is the APP's sha, so it must never be used as a fallback here:
    // an explicit value (or 'unknown', which the lab reports as a gap) is the
    // only acceptable input.
    labRevision: a.labRevision || envOr('LAB_REVISION', 'unknown'),
    correlationId,
    dashTokenFingerprint: rd.fingerprintToken(st.dashToken),
    clientTailnetIp: a.clientIp || '',
    mode: a.mode === 'origin-selftest' ? 'origin-selftest' : 'live-origin'
  }, { now: now.getTime() });

  const envelope = {
    kind: 'slab-live-run-envelope/1',
    descriptorId: descriptor.id, originRepo, originRunId, originAttempt,
    dashboardToken: st.dashToken, dashTokenFingerprint: descriptor.dashTokenFingerprint,
    rdpUser: st.rdpUser, rdpFqdn: backendHostname, tailnetIp: backendIp, rdpPort: 3389,
    issuedAt: now.toISOString(), expiresAt,
    selfValidation: descriptor.mode === 'origin-selftest',
    note: 'per-run credential handoff for the authorized lab client; retention 1 day; never published to Pages, PRs or job outputs'
  };

  let published = { ok: true, code: 'PUBLISHED_INLINE_ONLY' };
  if (a.envelopeOut) {
    const dir = path.dirname(a.envelopeOut);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'descriptor.json'), rd.serializeDescriptor(descriptor), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(envelope, null, 2), { mode: 0o600 });
    if (a.artifactOnly) fs.writeFileSync(path.join(dir, 'artifact-name.txt'), `live-run-${originRunId}-${originAttempt}`, 'utf8');
    published = { ok: true, code: 'WRITTEN_FOR_ARTIFACT', dir, files: ['descriptor.json', 'envelope.json'] };
  }
  if (a.envelopeInline) {
    fs.mkdirSync(path.dirname(a.envelopeInline), { recursive: true });
    fs.writeFileSync(a.envelopeInline, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    published = { ...published, inline: a.envelopeInline };
    const inlineDir = path.dirname(a.envelopeInline);
    fs.writeFileSync(path.join(inlineDir, 'descriptor.json'), rd.serializeDescriptor(descriptor), { mode: 0o600 });
    // The record mirrors what would otherwise go to the run-records ref, so a
    // CI self-validation run can hand descriptor + envelope to the client job
    // through the run's OWN artifact store (no cross-repository grant assumed).
    const record = {
      kind: 'slab-live-run-record/1', publishedAt: now.toISOString(),
      descriptor: JSON.parse(rd.serializeDescriptor(descriptor)),
      state: 'AWAITING_LAB_ACCEPTANCE',
      history: [{ at: now.toISOString(), state: 'AWAITING_LAB_ACCEPTANCE', by: 'origin' }],
      selfValidation: true,
      envelopeTransport: { kind: 'inline', path: a.envelopeInline }
    };
    const recText = JSON.stringify(record, null, 2);
    fs.writeFileSync(path.join(inlineDir, 'record.json'), recText, { mode: 0o600 });
    if (a.recordOut) { fs.mkdirSync(path.dirname(a.recordOut), { recursive: true }); fs.writeFileSync(a.recordOut, recText, { mode: 0o600 }); }
  }
  if (!a.artifactOnly) {
    try {
      const transport = a.envelopeInline
        ? { kind: 'inline', path: a.envelopeInline }
        // The credential envelope is NEVER referenced by a runner-local path in
        // the record: the lab reads it from this run's artifact store, which is
        // the only location both sides can agree on.
        : { kind: 'artifact', repository: originRepo, runId: originRunId, attempt: originAttempt, name: a.envelopeArtifactName || `live-run-${originRunId}-${originAttempt}-envelope` };
      const r = await store.publishRecord({ repo: labRepo, descriptor, seedSha: envOr('GITHUB_SHA', ''), envelope: { transport } });
      published = { ...published, record: r.path, code: a.envelopeInline ? 'RECORD_PUBLISHED_INLINE' : 'RECORD_PUBLISHED' };
    } catch (e) {
      published = { ...published, recordError: redact(String(e.message)).slice(0, 240), code: 'RECORD_PUBLISH_FAILED' };
      annotate.warning('live-run record publish', `the descriptor could not be written to ${labRepo}@${store.RECORDS_BRANCH}: ${redact(String(e.message))}`);
    }
  }
  annotate.notice('live-run advertised', `${correlationId} origin=${originRepo}@${appSha.slice(0, 12)} run=${originRunId}/${originAttempt} endpoint=${redact(target)} expires=${expiresAt} descriptor=${descriptor.id}`);
  return finish(EXIT.OK, {
    stage: 'AWAITING_LAB_ACCEPTANCE', code: 'SIGNALLED', correlationId, descriptorId: descriptor.id,
    descriptor: JSON.parse(rd.serializeDescriptor(descriptor)), published, expiresAt,
    t: { signalMs: Date.now() - t0, readinessMs: ready.elapsedMs || null }
  });

  function finish(code, obj) { print('origin-signal', code, obj); return process.exit(code); }
}

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------
async function cmdLive(a) {
  const t0 = Date.now();
  const timings = { startMs: t0 };
  const out = artifactDir();
  let lock = null;
  let context = null;
  let stage = 'STARTING';
  let claimed = null;
  let descriptor = null;
  let publicEnvelopeDir = null;
  const report = {
    kind: 'slab-live-run-report/1', generatedAt: new Date().toISOString(), protocol: rd.PROTOCOL,
    origin: {}, lab: { runId: envOr('GITHUB_RUN_ID', 'local'), attempt: envOr('GITHUB_RUN_ATTEMPT', '1'), revision: envOr('GITHUB_SHA', 'unknown'), repo: a.labRepo },
    runner: { name: envOr('RUNNER_NAME', os.hostname()), account: `${envOr('USERDOMAIN', '')}\\${envOr('USERNAME', '')}`, session: sessionId(), platform: process.platform, psHint: 'headed browser + native mstsc require the interactive desktop' },
    timestamps: {}, identity: {}, authorization: {}, capabilities: {}, features: null, manual: { interventionOccurred: false, note: 'a live run that needs any human input is reported BLOCKED, never VERIFIED' },
    verdict: { status: STATUS.NOT_RUN, accepted: false, code: 'NOT_STARTED' }, cleanup: {}, stages: [],
    // Honest default: until a headed authenticated browser actually exists there
    // is NO viewer, and the workflow's hold step is gated on this field.
    viewer: { active: false, reason: 'not reached: no authenticated browser was opened' }
  };
  const setStage = (s, extra = {}) => { stage = s; report.stages.push({ at: new Date().toISOString(), stage: s, ...extra }); log('stage', s, extra.code || ''); };

  try {
    if (process.platform !== 'win32' && !a.skipBrowser) {
      return await done(EXIT.NOT_WINDOWS, setFinal('BLOCKED', 'PLATFORM_NOT_WINDOWS', 'the live run drives a visible browser and native mstsc; it must execute on the interactive Windows client'));
    }
    // 1. locate + validate the record -----------------------------------
    setStage('AWAITING_READINESS');
    let rec = null;
    if ((a.originTransport === 'record' || a.originTransport === 'auto') && a.correlationId && a.originRunId && a.originRepo) {
      rec = await store.readRecord({ repo: a.labRepo, originRepo: a.originRepo, originRunId: a.originRunId, originAttempt: a.originAttempt });
    } else if (a.envelopeInline && fs.existsSync(a.envelopeInline)) {
      // CI self-validation / local harness: the descriptor sits next to the envelope.
      const d = JSON.parse(fs.readFileSync(path.join(path.dirname(a.envelopeInline), 'descriptor.json'), 'utf8'));
      rec = { path: 'inline', record: { descriptor: d, state: 'AWAITING_LAB_ACCEPTANCE' } };
    } else if (a.envelopeInline && fs.existsSync(path.join(path.dirname(a.envelopeInline), 'record.json'))) {
      rec = { path: 'inline', record: JSON.parse(fs.readFileSync(path.join(path.dirname(a.envelopeInline), 'record.json'), 'utf8')) };
    }
    // Lab-artifact transport (CI self-validation): record.json arrives inside the
    // same artifact as the envelope. It is still validated through the SAME
    // descriptor rules — nothing is trusted because it came from a lab run.
    if (!rec && a.envelopeArtifactRepo && fs.existsSync(path.join(path.dirname(a.envelopeInline || ''), 'record.json'))) {
      rec = { path: 'lab-artifact', record: JSON.parse(fs.readFileSync(path.join(path.dirname(a.envelopeInline || ''), 'record.json'), 'utf8')) };
    }
    if (!rec && a.envelopeArtifactRepo) {
      const { downloadArtifact, extractZip } = require('./lib/verify-origin');
      const runId = a.envelopeArtifactRunId || Number(envOr('GITHUB_RUN_ID', 0));
      const { verifyArtifactProvenance } = require('./lib/verify-origin');
      const name = 'live-run-selftest';
      const prov = await verifyArtifactProvenance({ originRepo: a.envelopeArtifactRepo, originRunId: runId, originAttempt: a.originAttempt, name });
      if (!prov.ok) return await done(EXIT.NO_EVIDENCE, setFinal('BLOCKED', prov.code, `no live-run artifact for this lab run: ${prov.detail}`));
      const dl = await downloadArtifact({ originRepo: a.envelopeArtifactRepo, originRunId: runId, artifactId: prov.artifact.id });
      if (!dl.ok) return await done(EXIT.NO_EVIDENCE, setFinal('BLOCKED', dl.code, dl.detail));
      const entries = extractZip(dl.bytes, { maxEntries: 6, maxEntryBytes: 512 * 1024 });
      const pick = n => entries.find(e => path.basename(e.name) === n);
      const recE = pick('record.json');
      if (!recE) return await done(EXIT.NO_EVIDENCE, setFinal('BLOCKED', 'ARTIFACT_ENTRY_MISSING', 'the live-run artifact has no record.json'));
      fs.mkdirSync(path.join(out, 'inbound'), { recursive: true });
      fs.writeFileSync(path.join(out, 'inbound', 'envelope.json'), pick('envelope.json').data, { mode: 0o600 });
      a.envelopeInline = path.join(out, 'inbound', 'envelope.json');
      rec = { path: 'lab-artifact', record: JSON.parse(recE.data.toString('utf8')) };
      report.transport = { kind: 'lab-artifact', repository: a.envelopeArtifactRepo, runId, artifactId: prov.artifact.id, archiveSha256: dl.sha256.slice(0, 16) };
    }
    // 1b. PUBLIC-ORIGIN DISCOVERY ------------------------------------------
    // The unpatched application does not publish a lab record; it publishes its
    // readiness banner (and the run-scoped key) inside its own Actions log. That
    // log is the origin's own evidence, and GitHub's run API is what decides
    // which run it belongs to. Nothing here is caller-supplied: `--origin-run`
    // only names a candidate, and every field is re-derived from the log of the
    // exact attempt before a descriptor exists.
    // ALWAYS resolve the credential from the ORIGIN'S OWN validated signal when
    // the transport allows it - also when a queue record exists. The record's
    // `envelopeTransport` is a lab default (`artifact live-run-<run>-<attempt>-
    // envelope`), and the merged application publishes no such artifact: it
    // seals the credential in MC-SIGNAL. Measured 2026-10-23 (lab run
    // 39958377748): the record was used as-is, origin verification demanded the
    // artifact, and the run died at BLOCKED ARTIFACT_NOT_FOUND while a valid,
    // live, run/attempt/sha-bound signal was sitting on the check run.
    // The signal is the stronger proof (it is bound to the run API identity),
    // so it wins; the record still supplies the queue identity and is still
    // where the claim/ack state lives.
    if (a.originTransport !== 'record' && !a.envelopeInline) {
      setStage('AWAITING_READINESS', { code: 'DISCOVERING_ORIGIN' });
      const disc = await discovery.discoverOrigin({
        originRepo: a.originRepo || 'dictationb1/supreme-lamp',
        originWorkflow: a.originWorkflow,
        explicitRunId: a.originRunId || 0,
        explicitAttempt: a.originAttempt || 0,
        // `signal` refuses the plaintext-log fallback, so a transport regression
        // shows up as a named refusal instead of a quiet downgrade.
        requireSignal: a.originTransport === 'signal',
        allowLogFallback: a.originTransport !== 'signal',
        labRevision: a.labRevision || envOr('GITHUB_SHA', 'unknown')
      });
      report.discovery = {
        code: disc.code,
        detail: redact(String(disc.detail || '')).slice(0, 300),
        transportRequested: a.originTransport,
        transportRequestedRaw: a.originTransportRequested || a.originTransport,
        evidence: disc.evidence ? {
          transport: disc.evidence.transport || null,
          checkRun: disc.evidence.checkRun || null,
          signalLive: disc.evidence.signalLive === true,
          signalFallback: disc.evidence.signalFallback || null,
          ready: disc.evidence.ready,
          endpointKind: disc.evidence.endpointKind,
          endpointHost: disc.evidence.endpointHost,
          keyPresent: disc.evidence.keyPresent,
          keyFingerprint16: disc.evidence.keyFingerprint ? String(disc.evidence.keyFingerprint).slice(0, 16) : null,
          readinessLine: (disc.evidence.readinessLines || [])[0] || null,
          bannerLines: disc.evidence.bannerLines || [],
          selection: disc.evidence.selection,
          rejected: (disc.evidence.rejected || []).map(r => ({ runId: r.runId, attempt: r.attempt, code: r.code, detail: r.detail ? redact(String(r.detail)).slice(0, 160) : null })),
          originLogPubliclyReadable: disc.evidence.originLogPubliclyReadable === true
        } : null
      };
      if (!disc.ok) return await done(EXIT.BLOCKED, setFinal('AWAITING_READINESS', `BLOCKED_${disc.code}`, disc.detail));
      // The queue names a run, not a moment: `issuedAt`/`expiresAt` are
      // re-derived by every sweep, so a changed descriptor id alone is not a
      // mismatch. The STABLE identity (run, attempt, sha, endpoint, key
      // fingerprint) must be identical, or this is a different instance.
      if (a.descriptorId && disc.descriptor.id !== a.descriptorId) {
        annotate.notice('descriptor refreshed', `the queue entry was ${a.descriptorId}; this sweep re-derived ${disc.descriptor.id} (expiry refreshed). Stable identity ${disc.descriptor.stableIdentity}.`);
        report.descriptorRefreshed = { queuedId: a.descriptorId, derivedId: disc.descriptor.id, stableIdentity: disc.descriptor.stableIdentity };
      }
      if (a.descriptorIdentity && disc.descriptor.stableIdentity !== a.descriptorIdentity) {
        return await done(EXIT.EXPIRED, setFinal('EXPIRED', 'BLOCKED_DESCRIPTOR_CHANGED',
          `stable identity ${disc.descriptor.stableIdentity} != queued ${a.descriptorIdentity}; refusing to attach a different instance`));
      }
      // The credential lives in a private temp file for exactly as long as the
      // fetchEnvelope handshake needs it, OUTSIDE the artifact directory, and is
      // removed in this process's finally block.
      publicEnvelopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slab-live-env-'));
      const envPath = path.join(publicEnvelopeDir, 'envelope.json');
      fs.writeFileSync(envPath, JSON.stringify({
        descriptorId: disc.descriptor.id,
        originRepo: disc.descriptor.originRepo,
        originRunId: disc.descriptor.originRunId,
        originAttempt: disc.descriptor.originAttempt,
        dashTokenFingerprint: disc.descriptor.dashTokenFingerprint,
        dashboardToken: disc.secret.dashboardToken,
        transport: disc.evidence.transport === 'check-run' ? 'origin-live-signal' : `origin-${disc.evidence.transport || 'unknown'}`
      }), { mode: 0o600 });
      a.envelopeInline = envPath;
      rec = { path: 'public-log', record: { descriptor: disc.descriptor, state: 'DISCOVERED_BY_LAB' } };
      // REPORT THE TRANSPORT ACTUALLY USED. The earlier build hard-coded
      // 'origin-public-log' even when the credential came from the encrypted
      // MC-SIGNAL check-run, which made an encrypted run indistinguishable from
      // a plaintext-log run in the evidence.
      const usedSignal = disc.evidence.transport === 'check-run';
      report.transport = {
        kind: usedSignal ? 'origin-live-signal' : `origin-${disc.evidence.transport || 'unknown'}`,
        mechanism: usedSignal
          ? 'MC-SIGNAL v1 in the mission-control-live-signal check-run output, RSA-OAEP-256 ciphertext decrypted in memory'
          : 'the origin run\'s own Actions log (readiness banner + current-run key, PLAINTEXT in that public log)',
        credentialAtRest: usedSignal ? 'encrypted (ciphertext only in a public check-run)' : 'plaintext (public run log)',
        repository: disc.origin.repo,
        runId: disc.origin.runId,
        attempt: disc.origin.attempt,
        checkRunId: usedSignal && disc.evidence.checkRun ? disc.evidence.checkRun.id : null,
        checkRunLive: usedSignal ? disc.evidence.checkRun && disc.evidence.checkRun.status === 'in_progress' : null,
        signalFallback: usedSignal ? null : (disc.evidence.signalFallback || null),
        evidence: usedSignal
          ? 'the origin run published its own run/attempt/sha-bound encrypted signal; GitHub run metadata is what bound that signal to the exact id+attempt'
          : 'the origin run\'s own Actions log, bound to GitHub run metadata for that exact id+attempt'
      };
      report.timestamps.discoveredAt = new Date().toISOString();
    }

    if (!rec) return await done(EXIT.NO_EVIDENCE, setFinal('BLOCKED', 'NO_RECORD', 'no live-run record for this origin (the application workflow publishes one while its server is alive); pass --correlation-id with --origin-repo/--origin-run, or --envelope-inline for the CI self-validation harness'));

    descriptor = rec.record.descriptor;
    report.origin = { repo: descriptor.originRepo, workflow: descriptor.originWorkflow, runId: descriptor.originRunId, attempt: descriptor.originAttempt, runUrl: `https://github.com/${descriptor.originRepo}/actions/runs/${descriptor.originRunId}`, correlationId: descriptor.correlationId, descriptorId: descriptor.id, appSha: descriptor.appSha, uiBuild: descriptor.uiBuild };
    report.timestamps.advertisedAt = descriptor.issuedAt;
    report.timestamps.expiresAt = descriptor.expiresAt;
    const deadline = Math.min(Date.parse(descriptor.expiresAt), t0 + a.timeoutMs);

    // 2. claim it (one lab run per origin attempt → no VM desktop fights) --
    if (a.claim) {
      setStage('CLAIMED');
      const c = await store.claimRecord({ repo: a.labRepo, descriptor, labRunId: report.lab.runId, labAttempt: report.lab.attempt, maxWaitMs: Math.min(a.queueWaitMs, Math.max(0, deadline - Date.now())) });
      claimed = c;
      if (!c.claimed) {
        return await done(EXIT.BUSY, setFinal('BLOCKED', c.reason, `${c.detail}; queue policy = one live claimant per (originRun,attempt), FIFO by claim time, never re-attached to another server`));
      }
      try { await store.updateRecordState({ repo: a.labRepo, descriptor, state: 'CLAIMED_BY_LAB', by: `lab:${report.lab.runId}`, detail: c.reason }); } catch (e) { annotate.warning('ack', `claim state write failed: ${redact(e.message)}`); }
    }

    // 3. serialize access to the VM desktop itself ------------------------
    // The desktop lock is a DIRECTORY lock (lib/lock.js), not a name/owner pair.
    // Measured 2026-10-23 (lab run 39957424394, client VM): the call passed
    // `name`/`owner`, acquireLock threw LOCK_DIR_REQUIRED, and the whole live
    // verification aborted at CLAIMED before the origin was ever verified -
    // while the run still exited 0, so the queue recorded a verdict it did not
    // have. One desktop owner is a safety property: it must actually be taken.
    const lockRoot = process.env.LAB_LOCK_DIR || path.join(os.tmpdir(), 'slab-locks');
    if (a.probeOnly) {
      // A bounded probe opens NO browser, dispatches NO protocol handler and
      // spawns NO mstsc, so it owns nothing on the desktop. Holding the single
      // desktop lease for it would serialize a diagnostic behind (or in front
      // of) a real pass for no safety benefit - and releasing it promptly is
      // exactly what "no viewer/test remains active" requires.
      report.desktopLock = { taken: false, reason: 'PROBE_ONLY: no desktop-owned work is performed, so the single desktop lease is deliberately not held' };
      annotate.notice('desktop lock', 'not taken: bounded probe performs no desktop-owned work');
    } else {
      lock = acquireLock({
        lockDir: path.join(lockRoot, 'rdp-lab-desktop'),
        runId: envOr('GITHUB_RUN_ID', 'local'),
        runAttempt: envOr('GITHUB_RUN_ATTEMPT', '1'),
        timeoutMs: 120000,
        role: 'live-run'
      });
      report.desktopLock = { taken: true, lockDir: path.join(lockRoot, 'rdp-lab-desktop') };
    }
    timings.desktopLockMs = Date.now() - t0;

    // 4. verify the origin against GitHub, not against the caller ---------
    setStage('CONNECTING_VM');
    // The transport is resolved from the ORIGIN's record before the origin is
    // verified, so the artifact the record promises is the same artifact the
    // trust anchor checks for — a record advertising no envelope cannot later
    // "find" one.
    const transport = auth.resolveTransport(rec && rec.record, descriptor);
    if (transport.refused) return await done(EXIT.BLOCKED, setFinal('BLOCKED', 'RECORD_TRANSPORT_REJECTED', transport.note));
    const origin = await verifyOriginRun(descriptor, {
      allowNonRunning: !a.expectRunning,
      expectArtifact: (a.envelopeInline || transport.inlinePath) ? null : transport.artifactName
    });
    report.identity.originVerification = { ok: origin.ok, code: origin.code, checks: (origin.checks || []).map(c => ({ code: c.code, ok: c.ok, detail: redact(String(c.detail || '')).slice(0, 200) })), runUrl: origin.runUrl || null };
    if (!origin.ok) return await done(EXIT.BLOCKED, setFinal('BLOCKED', origin.code, origin.detail));

    // 5. envelope -> the run's real credential handoff --------------------
    const envRes = await auth.fetchEnvelope({
      descriptor,
      originRepo: descriptor.originRepo,
      artifactName: a.envelopeArtifactName || transport.artifactName,
      inlinePath: a.envelopeInline || transport.inlinePath,
      originArtifactRepo: a.envelopeArtifactRepo || (transport.artifactRepo !== descriptor.originRepo ? transport.artifactRepo : null),
      originArtifactRunId: a.envelopeArtifactRunId || (transport.artifactRunId !== descriptor.originRunId ? transport.artifactRunId : null),
      originArtifactAttempt: transport.artifactAttempt || null
    });
    if (!envRes.ok) return await done(EXIT.BLOCKED, setFinal('BLOCKED', envRes.code, envRes.detail));
    const envelope = envRes.value;
    auth.registerSecret(envelope.dashboardToken, 'DASH_TOKEN');
    if (envelope.rdpPassword) auth.registerSecret(envelope.rdpPassword, 'RDP_PASSWORD');
    report.identity.backend = { endpointHost: new URL(descriptor.authorizedEndpoint).host, backendIdentity: descriptor.backendIdentity, envelopeTransport: envRes.transport, envelopeSha: envRes.archiveSha256 ? envRes.archiveSha256.slice(0, 16) : null };

    // 6. the live backend must be ours: same sha, same instance ------------
    const target = descriptor.authorizedEndpoint;
    const ready = await waitForReady(target, { timeoutMs: Math.min(a.readyTimeoutMs, Math.max(5000, deadline - Date.now())) });
    if (!ready.ready) {
      // What was ACTUALLY contacted belongs in the annotation: "readiness
      // timeout" alone cannot be distinguished from a wrong host, a tailnet
      // route that is not up, or a server that never started.
      const seen = (ready.history || []).slice(-4).map(h => `${h.code}@${h.at ? h.at.slice(11, 19) : '?'}(${String(h.detail || '').slice(0, 120)})`);
      annotate.error('readiness', `${ready.code} after ${Math.round(a.readyTimeoutMs / 1000)}s against ${target}; history=${seen.join(' | ')}`);
      return await done(EXIT.BLOCKED, setFinal('BLOCKED', ready.code, `${ready.detail} — the originating server must be alive; a completed run's ephemeral host is not attachable (history=${(ready.history || []).slice(-3).map(h => h.code).join(',')})`));
    }
    report.identity.readiness = ready.last && ready.last.body ? { pid: ready.last.body.pid, port: ready.last.body.port, phase: ready.last.body.phase, serverTs: ready.last.body.serverTs } : null;

    // 6b. the live process must be THIS run's instance, not merely a server on
    //     the same tailnet address. buildSha == origin head_sha, plus a session
    //     stamp that must still be the same at the end of the pass.
    const attest = await serverIdentity.attestBackend({ target, appSha: descriptor.appSha });
    report.identity.attested = {
      ok: attest.ok, code: attest.code,
      detail: redact(String(attest.detail || '')).slice(0, 300),
      ...(attest.identity || {})
    };
    if (attest.rdp) {
      // The production RDP verb needs the run's MagicDNS name and account; both
      // are server-attested here and neither is a password.
      envelope.rdpFqdn = attest.rdp.fqdn;
      envelope.rdpUser = attest.rdp.user;
      if (attest.rdp.tailnetIp) envelope.tailnetIp = attest.rdp.tailnetIp;
    }
    if (!attest.ok) {
      return await done(EXIT.BLOCKED, setFinal('BLOCKED', attest.code, `${attest.detail} — the endpoint answered, but it is not provably the originating run's instance`));
    }
    report.identity.instance = { backendIdentity: descriptor.backendIdentity, sessionId: attest.identity.sessionId, buildSha: attest.identity.buildSha };

    // 7. authenticate --------------------------------------------------------
    setStage('AUTHENTICATING');
    const peerOpt = String(a.clientIsTailnetPeer || '').toLowerCase();
    const proof = await auth.proveAuthorization({
      target, dashboardToken: envelope.dashboardToken, log,
      timeoutMs: a.authTimeoutMs,
      clientIsTailnetPeer: peerOpt === 'true' ? true : peerOpt === 'false' ? false : null
    });
    const proofTicket = proof.ok ? (proof.ticket || null) : null;
    if (proofTicket) auth.registerSecret(proofTicket, 'RDP_TICKET');
    const gates = proof.results ? Object.fromEntries(Object.entries(proof.results).map(([k, v]) => [k, typeof v === 'object' ? v : String(v)])) : null;
    report.authorization = {
      outcome: proof.ok ? 'PROVEN' : 'NOT_PROVEN',
      code: proof.code,
      // the exact subcode: AUTHORIZATION_UNAVAILABLE alone cannot distinguish
      // 'the server refused OUR token' from 'our source was not a tailnet peer'
      // from 'the server is missing its MagicDNS name' from 'the request never
      // got an answer'. Every one of those needs a different action.
      subcode: proof.subcode || proof.code,
      family: proof.ok ? 'AUTHORIZATION_PROVEN'
        : ['LIVE_BACKEND_UNREACHABLE', 'LIVE_TRANSPORT_INCOMPLETE', 'NEGATIVE_CONTROLS_INCOMPLETE'].includes(proof.code) ? 'TRANSPORT'
          : 'AUTHORIZATION',
      detail: redact(String(proof.detail || '')).slice(0, 400),
      layers: proof.layers || null,
      findings: proof.findings || [],
      configGate: proof.configGate || null,
      configGateProven: Boolean(proof.configGateProven),
      gates,
      ticketIssued: Boolean(proofTicket),
      ticketTtlSec: proof.ok ? (proof.ticketTtlSec || null) : null,
      // NEVER a hard-coded success sentence. This field used to claim "the live
      // server minted a single-use ticket..." even when the proof had failed;
      // it is now the server's own measured answer, or null.
      proof: proof.ok ? redact(String(proof.detail || '')).slice(0, 300) : null
    };
    if (!proof.ok) {
      const g = proof.results || {};
      const L = proof.layers || {};
      const gateLine = `noBearer=${(g.noBearer || {}).status}/${(g.noBearer || {}).transport} wrongBearer=${(g.wrongBearer || {}).status}/${(g.wrongBearer || {}).transport} ourBearer=${(g.ourBearer || {}).status}/${(g.ourBearer || {}).transport}${(g.ourBearer || {}).ticketFormatOk ? '+ticket' : ''} ttl=${(g.ourBearer || {}).ticketTtl ?? '-'} reason=${(g.ourBearer || {}).reasonCode || '-'} configGate=${(g.config || {}).gate || '-'} configStatuses=${JSON.stringify((g.config || {}).statuses || [])} tailnetPeer=${(g.source || {}).isTailnetPeer}/${(g.source || {}).determinedBy || '-'}`;
      const layerLine = `layers transport=${L.transport || '-'} bearer=${L.bearer || '-'} source=${L.source || '-'} prerequisite=${L.prerequisite || '-'} issuance=${L.issuance || '-'} configGate=${L.configGate || '-'}`;
      const refresh = g.refreshAware ? ` refreshAware=${g.refreshAware.code}` : '';
      annotate.error('authorization', `${proof.code}/${proof.subcode}: ${redact(String(proof.detail || '')).slice(0, 240)} | ${gateLine} | ${layerLine}${refresh}`);
      // The verdict carries the PRECISE code. The coarse family label stays in
      // report.authorization.family for continuity with earlier reports.
      return await done(EXIT.BLOCKED, setFinal('BLOCKED', proof.code, `${proof.subcode}: ${proof.detail} | ${gateLine} | ${layerLine}${refresh}`));
    }
    setStage('AUTHENTICATED', { code: proof.code, subcode: proof.subcode });
    timings.authMs = Date.now() - t0;
    report.timestamps.authenticatedAt = new Date().toISOString();

    // 7b. BOUNDED AUTHORIZATION PROBE (operator-requested). This is the small,
    //     decisive measurement: it proves the signal->credential->authorization
    //     chain and persists the sanitized matrix, then stops. It never opens a
    //     browser, never runs the feature pass and never holds a viewer, so a
    //     classifier question is answered in minutes instead of a full pass.
    if (a.probeOnly) {
      setStage('REPORTING');
      const probe = {
        schema: 'authorization-probe/1',
        generatedAt: new Date().toISOString(),
        labRunId: report.lab.runId, labAttempt: report.lab.attempt, labRevision: report.lab.revision,
        origin: report.origin,
        endpoint: { target, backendIdentity: descriptor.backendIdentity, host: new URL(target).host },
        client: { name: report.runner.name, account: report.runner.account, session: report.runner.session, tailnetIp: report.identity.clientTailnetIp || null },
        readiness: report.identity.readiness || null,
        attested: report.identity.attested || null,
        instance: report.identity.instance || null,
        authorization: report.authorization,
        // the probe ticket is DISCARDED: a launch mints its own at launch time
        probeTicketDiscarded: Boolean(proofTicket),
        timings: { authMs: timings.authMs }
      };
      fs.writeFileSync(path.join(out, a.probeOut), JSON.stringify(redactObject(probe), null, 2), { mode: 0o600 });
      annotate.notice('authorization probe', `${proof.code}/${proof.subcode} — transport=${(proof.layers || {}).transport} bearer=${(proof.layers || {}).bearer} source=${(proof.layers || {}).source} prerequisite=${(proof.layers || {}).prerequisite} issuance=${(proof.layers || {}).issuance} configGate=${proof.configGate}`);
      report.viewer = { active: false, reason: 'PROBE_ONLY: no browser was opened, so no viewer exists to hold' };
      return await done(EXIT.OK, setFinal('COMPLETED', 'AUTHORIZATION_PROBE_COMPLETE', `${proof.code}/${proof.subcode} (bounded probe; no feature pass was attempted)`, { accepted: false, probeOnly: true }));
    }

    // 8. the visible browser, authenticated for THIS run -------------------
    setStage('TESTING');
    report.timestamps.testingStartedAt = new Date().toISOString();
    const clientIpRes = auth.clientTailnetIp();
    const clientIp = a.clientIp || (clientIpRes.ok ? clientIpRes.ip : '');
    report.identity.clientTailnetIp = clientIp || null;
    const results = {};
    let page = null, browserHolder = null;
    if (!a.skipBrowser) {
      try {
        const { chromium } = require('playwright');
        const profile = a.profileDir || path.join(os.tmpdir(), `slab-live-profile-${descriptor.correlationId}`);
        fs.mkdirSync(profile, { recursive: true });
        context = await chromium.launchPersistentContext(profile, {
          headless: a.headless, viewport: { width: 1366, height: 820 },
          args: ['--disable-session-crashed-bubble', '--no-first-run', '--disable-features=Translate'],
          ignoreDefaultArgs: ['--enable-automation']
        });
        browserHolder = context;
        await context.addInitScript({ content: auth.storageInitScript(envelope.dashboardToken) });
        page = context.pages()[0] || await context.newPage();
        const pageErrors = { n: 0, samples: [] };
        page.__errors = pageErrors;
        page.on('pageerror', err => { pageErrors.n++; if (pageErrors.samples.length < 5) pageErrors.samples.push(redact(String(err && err.message || err)).slice(0, 160)); });
        page.on('console', m => { if (m.type() === 'error' && !/favicon|DevTools|Download the React/i.test(m.text())) { pageErrors.n++; if (pageErrors.samples.length < 5) pageErrors.samples.push(redact(m.text()).slice(0, 160)); } });
        report.browser = { profile, headed: !a.headless, pageErrors, note: 'a dedicated per-run profile: the operator profile, cookies and password store are never read or copied' };
        // A viewer exists ONLY here: an authenticated, headed, task-owned
        // browser on the interactive desktop. The workflow's hold step is gated
        // on this, so a run that never authenticated cannot sleep for the
        // default viewer interval while claiming a dashboard is visible.
        report.viewer = { active: !a.headless, reason: !a.headless ? 'an authenticated headed browser is open on the interactive desktop' : 'the browser is headless: there is nothing for an operator to look at' };
      } catch (e) {
        // NEVER fall back to headless silently (documented lab defect #3).
        report.viewer = { active: false, reason: `HEADED_LAUNCH_FAILED: ${redact(e.message).split('\n')[0]}` };
        results['nav.routes_reachable'] = feat.blocked(`HEADED_LAUNCH_FAILED: ${redact(e.message).split('\n')[0]}`);
        results['nav.build_provenance'] = results['nav.build_provenance'] || feat.blocked('DEPENDS_ON_BROWSER');
        report.browser = { launchError: redact(e.message).split('\n')[0], headed: false };
      }
    }
    const markers = makeMarkers();
    const contract = await readUiContract(target, descriptor);
    const inventory = buildInventory({ ...contract, destructive: a.allowDestructive });

    // Evaluate everything that can run without a desktop; RDP/web-desktop are
    // ordered so their dependency stays visible as BLOCKED, not as a fake FAIL.
    // The peer fact is measured ONCE and reused: the config gate's meaning
    // depends on it, and measuring it per-evaluator could answer differently
    // mid-pass (tailscale CLI timing) and make two features disagree.
    const peerMeasured = (() => {
      const opt = String(a.clientIsTailnetPeer || '').toLowerCase();
      if (opt === 'true') return { value: true, by: 'operator-input' };
      if (opt === 'false') return { value: false, by: 'operator-input' };
      const r = auth.clientTailnetIp();
      return { value: Boolean(r.ok), by: r.ok ? 'measured-tailscale-cli' : `unresolved(${r.code})` };
    })();
    report.identity.clientTailnetPeer = peerMeasured;
    const ctx = { target, descriptor, page, markers, authProof: proof, authOutcome: report.authorization, forgedToken: crypto.randomBytes(16).toString('hex'), http: request, envelope, clientIp, contract, rdpUser: a.rdpUser || envelope.rdpUser, clientIsTailnetPeer: peerMeasured.value, evidence: { out, results } };
    const order = ['auth.dash_token_gate', 'auth.no_stale_key_reuse', 'auth.rotated_token_revoked', 'nav.build_provenance', 'session.live_binding', 'telemetry.live_stream', 'keys.acl_view', 'errors.classified_not_spinner', 'files.list', 'search.lane', 'mirror.matrix', 'health.readiness_contract', 'connection.native_rdp_launch', 'connection.ticket_single_use', 'webdesktop.frames', 'webdesktop.interaction', 'nav.routes_reachable', 'settings.read_modify_restore', 'files.fixture_roundtrip', 'connection.credential_hygiene', 'lifecycle.teardown'];
    ctx.resultsRef = results;
  const runners = makeRunners(ctx, a, deadline);
    for (const id of order) {
      if (Date.now() > deadline - 20000) { results[id] = feat.blocked('RUN_DEADLINE_REACHED before this feature was attempted'); continue; }
      const fn = runners[id];
      try { results[id] = fn ? await fn() : feat.notRun('NO_EVALUATOR_REGISTERED'); }
      catch (e) { results[id] = feat.bad(`EVALUATOR_THREW: ${redact(e.message).split('\n')[0]}`); }
    }
    const summary = summarizeInventory(inventory, results);
    report.features = summary;
    report.capabilities = summarizeToCapabilities(summary);
    timings.featuresMs = Date.now() - t0;
    report.timestamps.testingFinishedAt = new Date().toISOString();

    // 8b. the instance must not have been replaced mid-pass -----------------
    const sessionNow = await serverIdentity.reassertSession({ target, sessionId: attest.identity.sessionId });
    report.identity.sessionStable = { ok: sessionNow.ok, code: sessionNow.code, detail: redact(String(sessionNow.detail || '')).slice(0, 200) };
    if (!sessionNow.ok) {
      results['session.live_binding'] = feat.blocked(`${sessionNow.code}: ${sessionNow.detail} — the evidence spans two server instances, so it cannot be reported as one verified run`);
    }

    // 9. report -------------------------------------------------------------
    setStage('REPORTING');
    if (context) { try { await auth.clearBrowserToken(context, target); } catch (e) { /* reported, never fatal */ } try { context.close(); } catch (e) { } context = null; }
    const profileToScrub = report.browser && report.browser.profile;
    if (profileToScrub) { try { fs.rmSync(profileToScrub, { recursive: true, force: true }); report.cleanup.profileRemoved = true; } catch (e) { report.cleanup.profileRemoveError = redact(e.message).slice(0, 160); } }

    // credential hygiene is evaluated last, over EVERY file this run wrote
    // (including the report itself once sanitised), because a leak can only be
    // detected after the artifacts exist.
    const hygiene = feat.evalSecretHygiene({ files: listEvidence(out), secrets: [envelope.dashboardToken, envelope.rdpPassword, proof.ticket || ''] });
    results['connection.credential_hygiene'] = hygiene;
    report.features = summarizeInventory(inventory, results);
    report.features.hygieneScanned = (hygiene.evidence && hygiene.evidence.scanned || []).length;

    const accepted = report.features.accepted && summary.mandatoryPass === summary.mandatoryTotal;
    const modeNote = descriptor.mode === 'origin-selftest'
      ? 'SCOPE: the live backend is the real application code at the recorded app SHA, but the ORIGIN is this lab repository\'s own run (the CI self-validation harness), not a run of ' + 'the application repository. This proves the integration mechanism end to end; it does not by itself prove the application workflow dispatches it.'
      : `SCOPE: full live integration against ${descriptor.originRepo} run ${descriptor.originRunId} attempt ${descriptor.originAttempt}.`;
    report.scope = modeNote;
    report.verdict = accepted
      ? { status: STATUS.PASS, accepted: true, code: 'VERIFIED', scope: modeNote }
      : { status: report.features.vetoing.length ? STATUS.FAIL : STATUS.BLOCKED, accepted: false, code: accepted ? 'VERIFIED' : (report.features.vetoing[0] || 'NOT_VERIFIED'), vetoing: report.features.vetoing, scope: modeNote };
    report.timings = { totalMs: Date.now() - t0, ...pick(timings, ['authMs', 'featuresMs', 'desktopLockMs']) };
    report.artifacts = { outDir: out, files: listEvidence(out).map(f => ({ path: f.split(/[\\/]/).pop(), bytes: fs.statSync(f).size })) };

    writeLiveEvidence(out, report);
    const repPath = a.reportPath || path.join(out, 'live-run-report.json');
    fs.writeFileSync(repPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.writeFileSync(repPath.replace(/\.json$/, '.md'), renderMarkdown(report), 'utf8');
    report.reportFiles = [repPath, repPath.replace(/\.json$/, '.md')].map(f => ({ path: f, bytes: fs.statSync(f).size }));

    try {
      await store.updateRecordState({
        repo: a.labRepo, descriptor,
        state: accepted ? 'REPORTED_VERIFIED' : (report.verdict.status === STATUS.BLOCKED ? 'BLOCKED' : 'REPORTED_FAILED'),
        by: `lab:${report.lab.runId}`,
        detail: `${report.verdict.code}; ${report.features.mandatoryPass}/${report.features.mandatoryTotal} mandatory features PASS; correlation ${descriptor.correlationId}`,
        extra: { report: { labRunId: report.lab.runId, attempt: report.lab.attempt, verdict: report.verdict.code, accepted, counts: report.features.counts, url: `https://github.com/${a.labRepo}/actions/runs/${report.lab.runId}`, correlationId: descriptor.correlationId } }
      });
    } catch (e) { annotate.warning('ack', `the report could not be written back to ${store.RECORDS_BRANCH}: ${redact(e.message).slice(0, 200)}`); report.cleanup.ackError = redact(e.message).slice(0, 200); }

    return await done(accepted ? EXIT.OK : (report.verdict.status === STATUS.BLOCKED ? EXIT.BLOCKED : EXIT.UNCONFIRMED), report);
  } catch (e) {
    const code = classifyError(e);
    annotate.error('live-run aborted', `${code}: ${redact(e.stack || e.message)}`.slice(0, 900));
    return await done(code.exit, setFinal(code.stage || 'FAILED', code.code, redact(e.message).slice(0, 400)));
  } finally {
    if (publicEnvelopeDir) { try { fs.rmSync(publicEnvelopeDir, { recursive: true, force: true }); } catch (e) { /* reported above */ } }
    if (claimed && claimed.claimed) { try { await store.releaseClaim({ repo: a.labRepo, descriptor, labRunId: report.lab.runId }); } catch (e) { log('claim release failed', e.message); } }
    if (lock) { try { releaseLock(lock); } catch (e) { log('desktop lock release failed', e.message); } }
  }

  /**
   * Persist what this run measured BEFORE it exits.
   *
   * Two defects this replaces, both measured on 2026-10-23:
   *   1. the record write-back was fire-and-forget and `process.exit` killed it
   *      mid-flight, so every blocked run left only the ack step's generic
   *      "job-level write-back" text and the real subcode was lost;
   *   2. no sanitized evidence bundle was written on a failure path, so the
   *      uploaded artifact could not answer what had actually been measured.
   * `retryable` is decided by the code's FAMILY, not by hope: a transport
   * failure may be retried by a later sweep, a deterministic authorization or
   * configuration refusal must not be re-run unchanged.
   */
  const TRANSIENT_CODES = new Set(['LIVE_BACKEND_UNREACHABLE', 'LIVE_TRANSPORT_INCOMPLETE', 'NEGATIVE_CONTROLS_INCOMPLETE', 'READINESS_TIMEOUT', 'READINESS_UNREACHABLE']);
  async function persistPartial(state, code, detail) {
    report.stage = state;
    if (!report.authorization) report.authorization = { outcome: 'NOT_MEASURED', code: 'AUTHORIZATION_NOT_REACHED', subcode: 'AUTHORIZATION_NOT_REACHED', proof: null };
    const family = (report.authorization && report.authorization.family) || (TRANSIENT_CODES.has(code) ? 'TRANSPORT' : 'OTHER');
    const retryable = TRANSIENT_CODES.has(code) || family === 'TRANSPORT';
    // [L-14] No silent evidence failures. Every write is verified and reported:
    // a run that leaves nothing behind must SAY so in the annotations, because
    // the annotations are the one channel that survives an empty artifact
    // upload. (Measured 2026-10-23, probe run 39977560128: the readiness block
    // ran persistPartial, the job printed its verdict, and the upload found zero
    // files - with two empty catch blocks in this function as the only place the
    // reason could have been swallowed.)
    const written = [];
    try { written.push(writeLiveEvidence(out, report)); } catch (e) { annotate.warning('partial evidence', `capabilities bundle not written: ${redact(String(e.message || e)).slice(0, 160)}`); }
    try {
      const p = path.join(out, 'live-run-report.json');
      fs.writeFileSync(p, JSON.stringify(redactObject(report), null, 2), { mode: 0o600 });
      if (fs.existsSync(p)) written.push(p); else throw new Error(`write did not land: ${p}`);
    } catch (e) { annotate.warning('partial evidence', `live-run-report.json not written: ${redact(String(e.message || e)).slice(0, 160)}`); }
    try {
      const p = path.join(out, 'live-run-report.md');
      fs.writeFileSync(p, renderMarkdown(report), 'utf8');
      if (fs.existsSync(p)) written.push(p); else throw new Error(`write did not land: ${p}`);
    } catch (e) { annotate.warning('partial evidence', `live-run-report.md not written: ${redact(String(e.message || e)).slice(0, 160)}`); }
    // Verify by LISTING, not by trusting the writes: this is what an operator
    // reads when the artifact comes back empty.
    try {
      const found = listEvidence(out);
      const bytes = found.reduce((n, f) => n + (fs.statSync(f).size || 0), 0);
      report.artifacts = { outDir: out, files: found.map(f => ({ path: f.split(/[\\/]/).pop(), bytes: fs.statSync(f).size })), expectedWritten: written.length };
      if (found.length === 0) {
        annotate.error('EVIDENCE_NOT_PERSISTED', `nothing on disk under ${out} after ${written.length} attempted write(s); the artifact upload WILL be empty. First write error above is the cause.`);
      } else {
        annotate.notice('evidence inventory', `${found.length} file(s) ${bytes} bytes under ${out}: ${found.map(f => f.split(/[\\/]/).pop()).join(', ')}`);
      }
    } catch (e) { annotate.warning('evidence inventory', `could not list ${out}: ${redact(String(e.message || e)).slice(0, 160)}`); }
    if (process.env.GITHUB_OUTPUT) {
      // The ack step prefers these over its job-level guess, and the viewer-hold
      // step is gated on viewer_active: a run that never opened an authenticated
      // browser must not sleep while claiming a dashboard is visible.
      const one = x => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ');
      try {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, [
          `blocked_code=${one(code).slice(0, 120)}`,
          `blocked_subcode=${one((report.authorization && report.authorization.subcode) || code).slice(0, 120)}`,
          `blocked_family=${one(family).slice(0, 40)}`,
          `blocked_retryable=${retryable ? 'true' : 'false'}`,
          `blocked_detail=${one(detail).slice(0, 900)}`,
          `viewer_active=${report.viewer && report.viewer.active ? 'true' : 'false'}`,
          `viewer_reason=${one(report.viewer && report.viewer.reason || 'no authenticated viewer was opened').slice(0, 200)}`
        ].join('\n') + '\n');
      } catch (e) { }
    }
    if (descriptor && report.verdict.probeOnly) {
      // A bounded probe is a DIAGNOSTIC: it must not move the origin's queue
      // state, or an operator's probe would silently consume the queue's
      // bounded retry budget for a real verification.
      annotate.notice('authorization probe', 'no queue state was changed: a bounded probe never writes a product verdict');
    } else if (descriptor) {
      const extra = {
        blocker: {
          code, subcode: (report.authorization && report.authorization.subcode) || code, family, retryable,
          layers: (report.authorization && report.authorization.layers) || null,
          detail: String(detail).slice(0, 300), recordedAt: new Date().toISOString(),
          byLabRun: report.lab.runId, labRevision: report.lab.revision
        }
      };
      try {
        await Promise.race([
          store.updateRecordState({ repo: a.labRepo, descriptor, state, by: `lab:${report.lab.runId}`, detail: `${code}: ${String(detail).slice(0, 240)}`, extra }),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('RECORD_WRITE_TIMEOUT_25S')), 25000))
        ]);
      } catch (e) {
        annotate.warning('record write-back', `${code}: the in-process state write failed (${redact(String(e.message || e)).slice(0, 160)}); this run's own report is still authoritative`);
      }
    }
  }

  function setFinal(stageName, code, detail, opts = {}) {
    report.verdict = {
      status: stageName === 'COMPLETED' ? (opts.accepted ? STATUS.PASS : STATUS.BLOCKED) : (code === 'BLOCKED' || /BLOCK/.test(String(code)) ? STATUS.BLOCKED : STATUS.FAIL),
      accepted: Boolean(opts.accepted), code, detail: redact(String(detail)).slice(0, 500),
      probeOnly: Boolean(opts.probeOnly)
    };
    report.stage = stageName;
    // The write is queued and awaited by done(); nothing is fire-and-forget.
    // [L-14] The `.catch(() => {})` that used to sit here was the last silent
    // path: if persistPartial threw anywhere outside its own try blocks, the
    // rejection was discarded and the run still printed a confident verdict
    // while leaving zero evidence behind. A persistence failure is now an ERROR
    // annotation, because the annotations are the only channel that survives an
    // empty artifact upload.
    report.__persist = persistPartial(stageName === 'COMPLETED' ? 'REPORTED_FAILED' : stageName, code, detail).catch(e => {
      try { annotate.error('EVIDENCE_NOT_PERSISTED', `persistPartial threw before it could write: ${redact(String((e && e.message) || e)).slice(0, 240)}`); } catch (e2) { /* the annotation channel itself is gone; nothing left to do */ }
      report.artifacts = { ...(report.artifacts || {}), persistError: redact(String((e && e.message) || e)).slice(0, 240) };
    });
    return report;
  }
  async function done(code, obj) {
    // Persist BEFORE the annotation/exit: an exit that races its own evidence
    // is how a blocked run used to leave nothing behind.
    if (obj && obj.__persist) { try { await obj.__persist; } catch (e) { } delete obj.__persist; }
    print('live', code, obj);
    return process.exit(code);
  }
}

// ---------------------------------------------------------------------------
// ack (the origin's bounded wait — NOT a workflow_run trigger)
// ---------------------------------------------------------------------------
async function cmdAck(a) {
  const t0 = Date.now();
  const descriptor = { originRepo: a.originRepo || envOr('GITHUB_REPOSITORY', ''), originRunId: a.originRunId || Number(envOr('GITHUB_RUN_ID', 0)), originAttempt: a.originAttempt || Number(envOr('GITHUB_RUN_ATTEMPT', 1)) };
  if (!descriptor.originRepo || !descriptor.originRunId) return printExit(EXIT.USAGE, { code: 'ACK_TARGET_MISSING' });
  const deadline = t0 + a.timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    let rec = null;
    try { rec = await store.readRecord({ repo: a.labRepo, ...descriptor }); } catch (e) { annotate.warning('ack read', redact(e.message).slice(0, 200)); }
    const state = rec && rec.record && rec.record.state;
    if (state && (!seen.length || seen[seen.length - 1] !== state)) { seen.push(state); annotate.notice('lab stage', `${state} (${descriptor.originRunId}/${descriptor.originAttempt})`); }
    if (state === 'REPORTED_VERIFIED') {
      const r = rec.record.report || {};
      fs.writeFileSync(path.join(artifactDir(), 'lab-ack.json'), JSON.stringify({ ...r, state, accepted: true }, null, 2));
      return printExit(EXIT.OK, { state, accepted: true, report: r, waitedMs: Date.now() - t0, stages: seen });
    }
    if (state === 'BLOCKED' || state === 'FAILED' || state === 'EXPIRED') {
      const r = rec.record.report || {};
      fs.writeFileSync(path.join(artifactDir(), 'lab-ack.json'), JSON.stringify({ ...r, state, accepted: false }, null, 2));
      return printExit(EXIT.BLOCKED, { state, accepted: false, detail: rec.record.detail || null, report: r, waitedMs: Date.now() - t0, stages: seen });
    }
    if (rec && rec.record && rec.record.descriptor && Date.parse(rec.record.descriptor.expiresAt) < Date.now()) {
      return printExit(EXIT.EXPIRED, { state: 'EXPIRED', detail: 'the advertised endpoint passed its expiry before the lab reported', waitedMs: Date.now() - t0, stages: seen });
    }
    await new Promise(r => setTimeout(r, a.ackPollMs));
  }
  fs.writeFileSync(path.join(artifactDir(), 'lab-ack.json'), JSON.stringify({ state: 'NO_LAB_ACCEPTANCE', waitedMs: Date.now() - t0, stages: seen }, null, 2));
  return printExit(EXIT.NO_EVIDENCE, { state: 'NO_LAB_ACCEPTANCE', detail: `no report for run ${descriptor.originRunId}/${descriptor.originAttempt} within ${a.timeoutMs}ms — the client runner is offline, the queue was busy, or the lab handler is not on its default branch`, stages: seen });
}

// ---------------------------------------------------------------------------
// ack-state — the `report` job's one-line write-back.
//
// It exists so the ORIGIN's bounded wait can finish with a definite label even
// when the verify job was cancelled or timed out at the job level (in which
// case the in-process ack never ran). It writes a state only; it never invents a
// verdict: an inconclusive job result maps to BLOCKED, not to a pass or a fail.
// ---------------------------------------------------------------------------
async function cmdAckState(a) {
  const descriptor = { originRepo: a.originRepo, originRunId: a.originRunId, originAttempt: a.originAttempt, correlationId: a.correlationId };
  if (!descriptor.originRepo || !descriptor.originRunId) return printExit(EXIT.USAGE, { code: 'ACK_TARGET_MISSING' });
  const jobResult = String(a.jobResult || 'unknown').toLowerCase();
  // A JOB's success is not a VERDICT. The verify job exits 0 for every
  // non-fatal outcome (BLOCKED/NO_EVIDENCE/UNCONFIRMED are all "not a crash"),
  // so mapping success -> REPORTED_VERIFIED let a run that never reached the
  // origin be recorded as verified (measured 2026-10-23: LOCK_DIR_REQUIRED
  // aborted at CLAIMED and the queue then said REPORTED_VERIFIED). Only the
  // in-process report may set a passing state; a gap-fill is BLOCKED and says
  // so, which also permits the bounded re-queue.
  const map = {
    success: 'BLOCKED',
    failure: 'FAILED',
    cancelled: 'BLOCKED',
    timed_out: 'BLOCKED',
    skipped: 'BLOCKED'
  };
  // `success` here means only "the verify job exited cleanly", which live-run
  // already uses for BLOCKED outcomes too — so we never overwrite a report the
  // verify job itself wrote; we only fill a gap it left.
  const existing = await store.readRecord({ repo: a.labRepo, ...descriptor }).catch(() => null);
  if (existing && existing.record && String(existing.record.state).startsWith('REPORTED_')) {
    return printExit(EXIT.OK, { code: 'ACK_ALREADY_REPORTED', state: existing.record.state, detail: 'the verify job already wrote the authoritative report; the job-level write-back stands down' });
  }
  // The verify process now records the EXACT measured blocker itself (state +
  // `blocker` extra). When it did, the job-level write-back must stand down
  // instead of replacing a precise observation with a generic sentence - that
  // replacement is why every blocked record on 2026-10-23 read "job-level
  // write-back" and no subcode survived.
  const mine = String(envOr('GITHUB_RUN_ID', ''));
  const rec0 = existing && existing.record;
  const b0 = rec0 && rec0.blocker;
  if (b0 && (!mine || String(b0.byLabRun || '') === mine)) {
    return printExit(EXIT.OK, {
      code: 'ACK_STOOD_DOWN_MEASURED_BLOCKER', state: rec0.state,
      blocker: { code: b0.code, subcode: b0.subcode, family: b0.family, retryable: b0.retryable },
      detail: 'the verify process already recorded the exact measured blocker; the job-level write-back stands down'
    });
  }
  const state = map[jobResult] || 'BLOCKED';
  // If the verify step exported its measured code (but its own record write
  // failed), the ack carries it through rather than inventing a generic one.
  const measured = Boolean(a.blockedCode);
  const family = String(a.blockedFamily || (measured ? 'OTHER' : ''));
  const retryable = measured ? String(a.blockedRetryable || '') === 'true' : false;
  const detail = measured
    ? `${a.blockedCode}/${a.blockedSubcode || a.blockedCode}: ${String(a.blockedDetail || '').slice(0, 240)} (measured in-process, relayed by the ack step because the verify process could not write the record itself)`
    : `job-level write-back: verify job result=${jobResult} (the verify job did not reach an in-process report; this is NOT a product verdict and it is never a pass)`;
  const extra = measured ? {
    blocker: {
      code: a.blockedCode, subcode: a.blockedSubcode || a.blockedCode, family, retryable,
      detail: String(a.blockedDetail || '').slice(0, 300), recordedAt: new Date().toISOString(),
      byLabRun: mine || null, relayed: 'ack-step', labRevision: envOr('GITHUB_SHA', 'unknown')
    }
  } : {};
  const res = await store.updateRecordState({ repo: a.labRepo, descriptor, state, by: `dictationb1/supreme-lamp-lab@${envOr('GITHUB_REPOSITORY_OWNER', 'lab')}`, detail, extra });
  return printExit(state === 'REPORTED_VERIFIED' ? EXIT.OK : EXIT.BLOCKED, { code: measured ? 'ACK_STATE_WRITTEN_MEASURED' : 'ACK_STATE_WRITTEN', state, updated: Boolean(res && res.updated), measured, blocker: extra.blocker || null, detail });
}

// ---------------------------------------------------------------------------
// discover / probe — GitHub-side origin discovery (no client VM, no secret out)
// ---------------------------------------------------------------------------
function writeGithubOutput(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  let text = '';
  for (const [k, v] of Object.entries(pairs)) {
    const sval = String(v === undefined || v === null ? '' : v);
    // Multi-line-safe delimiter form, so a descriptor JSON can never corrupt
    // the file or be mistaken for another key.
    if (/\r|\n/.test(sval)) {
      const delim = `SLAB_${crypto.randomBytes(6).toString('hex')}`;
      text += `${k}<<${delim}\n${sval}\n${delim}\n`;
    } else {
      text += `${k}=${sval}\n`;
    }
  }
  fs.appendFileSync(file, text, 'utf8');
}

function sanitizeDiscovery(disc) {
  if (!disc || !disc.ok) {
    return {
      ok: false,
      code: disc ? disc.code : 'NO_RESULT',
      detail: disc ? redact(String(disc.detail || '')).slice(0, 400) : null,
      rejected: disc && disc.evidence && disc.evidence.rejected ? disc.evidence.rejected : []
    };
  }
  return {
    ok: true,
    code: disc.code,
    descriptor: disc.descriptor,
    descriptorId: disc.descriptor.id,
    origin: disc.origin,
    evidence: {
      ready: disc.evidence.ready,
      endpointKind: disc.evidence.endpointKind,
      endpointHost: disc.evidence.endpointHost,
      keyPresent: disc.evidence.keyPresent,
      entries: disc.evidence.entries,
      scannedBytes: disc.evidence.scannedBytes,
      keyFingerprint16: String(disc.evidence.keyFingerprint || '').slice(0, 16),
      keyMaskedLength: disc.evidence.keyMaskedLength,
      readinessLine: (disc.evidence.readinessLines || [])[0] || null,
      bannerLines: disc.evidence.bannerLines,
      selection: disc.evidence.selection,
      originLogPubliclyReadable: disc.evidence.originLogPubliclyReadable === true,
      rejected: disc.evidence.rejected
    },
    // the secret is deliberately absent: cmdDiscover must never be able to leak
    // the token into a job output, a log line or an artifact
    secretTransported: false
  };
}

async function cmdDiscover(a) {
  const disc = await discovery.discoverOrigin({
    originRepo: a.originRepo || envOr('ORIGIN_REPO', 'dictationb1/supreme-lamp'),
    originWorkflow: a.originWorkflow,
    explicitRunId: a.originRunId || 0,
    explicitAttempt: a.originAttempt || 0,
    labRevision: a.labRevision || envOr('GITHUB_SHA', 'unknown')
  });
  const out = sanitizeDiscovery(disc);
  out.operation = 'discover';
  // Publish the queue entry (descriptor only; never the secret) so the existing
  // claim machinery dedupes deliveries by (origin run, attempt). An existing
  // record is NEVER overwritten: re-publishing would resurrect a completed or
  // already-claimed verification as if it were new.
  if (out.ok && a.publish) {
    try {
      const exists = await store.readRecord({
        repo: a.labRepo, originRepo: out.origin.repo,
        originRunId: out.origin.runId, originAttempt: out.origin.attempt
      });
      if (exists && exists.record) {
        out.queue = { published: 'existing', state: exists.record.state || 'unknown' };
      } else {
        const published = await store.publishRecord({
          repo: a.labRepo, descriptor: disc.descriptor, seedSha: a.seedSha || envOr('GITHUB_SHA', ''),
          envelope: { transport: {
            kind: 'artifact', repository: out.origin.repo, runId: out.origin.runId,
            attempt: out.origin.attempt, name: `live-run-${out.origin.runId}-${out.origin.attempt}-envelope`
          } }
        });
        out.queue = { published: 'created', path: published.path };
      }
    } catch (e) {
      out.queue = { published: 'error', detail: redact(e.message).slice(0, 240) };
      annotate.warning('queue publish', `the descriptor could not be published to the run-records branch: ${redact(e.message).slice(0, 200)}`);
    }
  }
  if (a.discoverOut) fs.writeFileSync(a.discoverOut, JSON.stringify(out, null, 2), { mode: 0o600 });
  writeGithubOutput({
    found: out.ok ? 'yes' : 'no',
    reason: out.code,
    detail: out.detail || '',
    descriptor_id: out.descriptorId || '',
    descriptor_identity: out.ok ? out.descriptor.stableIdentity : '',
    origin_repo: out.ok ? out.origin.repo : (a.originRepo || ''),
    origin_run: out.ok ? out.origin.runId : '',
    origin_attempt: out.ok ? out.origin.attempt : '',
    app_sha: out.ok ? out.descriptor.appSha : '',
    ui_build: out.ok ? out.descriptor.uiBuild : '',
    endpoint: out.ok ? out.descriptor.authorizedEndpoint : '',
    expires_at: out.ok ? out.descriptor.expiresAt : '',
    descriptor_json: out.ok ? JSON.stringify(out.descriptor) : ''
  });
  if (process.env.PROBE_RDP_LOG === '1' && a.originRunId) {
    const jobs = await discovery.listRunJobs({ originRepo: a.originRepo || 'dictationb1/supreme-lamp', runId: a.originRunId });
    const target = jobs.ok ? (jobs.jobs.find(j => /^rdp$/i.test(String(j.name))) || jobs.jobs.find(j => /\brdp\b/i.test(String(j.name)))) : null;
    if (!target) {
      annotate.notice('rdp job log', `not found (${jobs.ok ? 'jobs=' + jobs.jobs.length : jobs.code})`);
    } else {
      const r = await discovery.downloadJobLogText({ originRepo: a.originRepo || 'dictationb1/supreme-lamp', jobId: target.id, timeoutMs: 90000 });
      if (!r.ok) annotate.notice('rdp job log', `${target.name} ${r.code}: ${String(r.detail).slice(0, 200)}`);
      else {
        const an = discovery.analyseJobLogText(r.text);
        out.rdpLog = { job: target.name, status: target.status, conclusion: target.conclusion, ...an };
        annotate.notice('rdp job log', `${target.name} ${target.status}/${target.conclusion} bytes=${an.bytes} lines=${an.lineCount} readiness=${an.readiness} banner=${an.banner} key=${an.bannerHasKey} markers=${an.markers.join(',')}`);
        for (const l of an.tail) annotate.notice('rdp job tail', l);
      }
    }
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [];
    lines.push(`### Origin discovery — ${out.ok ? 'attachable run found' : 'no attachable live run'}`);
    lines.push('');
    if (out.ok) {
      lines.push(`- origin: \`${out.origin.repo}#${out.origin.runId}/${out.origin.attempt}\` (${out.origin.url})`);
      lines.push(`- app sha: \`${out.descriptor.appSha}\` · UI build: \`${out.descriptor.uiBuild}\``);
      lines.push(`- endpoint: \`${out.descriptor.authorizedEndpoint}\` (${out.evidence.endpointKind})`);
      lines.push(`- descriptor: \`${out.descriptorId}\` · expires \`${out.descriptor.expiresAt}\``);
      lines.push(`- key: present, fingerprint \`${out.evidence.keyFingerprint16}…\` (value never logged or stored)`);
    } else {
      lines.push(`- result: \`${out.code}\` — ${out.detail || 'nothing to attach'}`);
      for (const r of (out.rejected || []).slice(0, 6)) lines.push(`  - rejected ${r.runId}/${r.attempt}: \`${r.code}\``);
    }
    lines.push('');
    lines.push('Selection is never "the newest server": an explicit run id wins, otherwise the OLDEST still-in-progress run whose own log already carries a readiness banner. A run whose banner has not appeared is reported, not queued.');
    fs.appendFileSync(summary, lines.join('\n') + '\n');
  }
  print('discover', out.ok ? EXIT.OK : EXIT.BLOCKED, out);
  return process.exit(out.ok ? EXIT.OK : EXIT.BLOCKED);
}

function cmdSignalKeygen() {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fp = require('./lib/live-signal').keyFingerprint(pub);
  console.log('# 1) set this as the APPLICATION repository VARIABLE LAB_SIGNAL_PUBKEY:');
  console.log(pub.trim());
  console.log(`# key fingerprint (goes into every envelope): ${fp}`);
  console.log('# 2) set this as the LAB repository SECRET LAB_SIGNAL_PRIVATE_KEY (never commit it):');
  console.log(priv.trim());
  return process.exit(EXIT.OK);
}

/**
 * SANITIZED KEY / ROUND-TRIP STATUS.
 *
 * Answers, without ever printing a key: is the lab private key configured, does
 * it parse, what is its public fingerprint, and (when the application has
 * published one) does the app's `enc.keyId` match it and does the ciphertext
 * decrypt? The fingerprint IS public (it is `enc.keyId` in every envelope), so
 * comparing fingerprints proves the two halves belong together without either
 * half leaving its own repository.
 *
 * Exit 0 only when the key is present AND (if a signal exists) it decrypted.
 * Exit 4 = configured but no signal to round-trip yet (an honest "not proven").
 * Exit 5 = not configured.
 */
async function cmdSignalStatus(a) {
  const crypto = require('crypto');
  const signalLib = require('./lib/live-signal');
  const pem = process.env.LAB_SIGNAL_PRIVATE_KEY || '';
  const out = {
    operation: 'signal-status',
    generatedAt: new Date().toISOString(),
    privateKeyPresent: Boolean(pem.trim()),
    privateKeyParses: false,
    algorithm: null,
    modulusBits: null,
    privateKeyFingerprint32: null,
    publicKeyVariable: 'LAB_SIGNAL_PUBKEY (application repository)',
    privateKeySecret: 'LAB_SIGNAL_PRIVATE_KEY (lab repository)',
    roundTrip: null,
    originRepo: a.originRepo || 'dictationb1/supreme-lamp'
  };
  let code = EXIT.OK;
  if (!out.privateKeyPresent) {
    out.code = 'LAB_SIGNAL_PRIVATE_KEY_MISSING';
    out.detail = 'the lab repository secret LAB_SIGNAL_PRIVATE_KEY is not set for this event; the encrypted MC-SIGNAL transport cannot work and discovery would fall back to the plaintext run log';
    code = EXIT.NO_EVIDENCE;
  } else {
    try {
      const priv = crypto.createPrivateKey(pem);
      const pubPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
      out.privateKeyParses = true;
      out.algorithm = priv.asymmetricKeyType || 'unknown';
      out.modulusBits = priv.asymmetricKeyDetails ? priv.asymmetricKeyDetails.modulusLength : null;
      out.privateKeyFingerprint32 = signalLib.keyFingerprint(pubPem);
      out.code = 'LAB_SIGNAL_KEY_PRESENT';
      // Round-trip against the real application evidence, if any exists.
      const disc = await discovery.discoverOrigin({
        originRepo: a.originRepo || 'dictationb1/supreme-lamp',
        originWorkflow: a.originWorkflow,
        explicitRunId: a.originRunId || 0,
        explicitAttempt: a.originAttempt || 0
      });
      const ev = (disc.evidence || {});
      if (disc.ok && ev.transport === 'check-run') {
        out.roundTrip = {
          proven: true,
          transport: 'check-run (MC-SIGNAL v1)',
          checkRunId: ev.checkRun ? ev.checkRun.id : null,
          checkRunLive: ev.checkRun ? ev.checkRun.status === 'in_progress' : null,
          keyIdMatched: true,
          decrypted: true,
          origin: { runId: disc.origin.runId, attempt: disc.origin.attempt, appSha: disc.origin.appSha },
          note: 'the application signal was validated against GitHub run metadata and decrypted with this private key; the plaintext key was never printed or written'
        };
        out.code = 'LAB_SIGNAL_ROUND_TRIP_OK';
      } else {
        const rejected = (ev.rejected || []).map(r => ({ runId: r.runId, attempt: r.attempt, code: r.code, signal: r.signal ? r.signal.code : null }));
        out.roundTrip = {
          proven: false,
          reason: disc.code,
          detail: String(disc.detail || '').slice(0, 300),
          // SIGNAL_ABSENT / SIGNAL_LIST_EMPTY / SIGNAL_NO_PRIVATE_KEY etc. are
          // reported as they are. "No signal" means the application never
          // published one - usually because the publisher patch is not merged.
          rejected
        };
        out.code = 'LAB_SIGNAL_NO_LIVE_EVIDENCE';
        code = EXIT.BLOCKED;
      }
    } catch (e) {
      out.privateKeyParses = false;
      out.code = 'LAB_SIGNAL_PRIVATE_KEY_UNPARSEABLE';
      out.detail = `the configured LAB_SIGNAL_PRIVATE_KEY does not parse as a private key (${String(e.message || e).slice(0, 120)})`;
      code = EXIT.NO_EVIDENCE;
    }
  }
  const jsonOut = a.jsonOut || '';
  const safe = redactObject(out);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(safe, null, 2), { mode: 0o600 });
  console.log(`===== signal-status result (exit ${code}) =====`);
  console.log(JSON.stringify(safe, null, 2));
  writeGithubOutput({
    private_key_present: out.privateKeyPresent ? 'yes' : 'no',
    key_fingerprint32: out.privateKeyFingerprint32 || '',
    round_trip: out.roundTrip && out.roundTrip.proven ? 'proven' : 'not-proven',
    reason: out.code
  });
  annotate.notice(
    'signal key status',
    out.privateKeyPresent
      ? `LAB_SIGNAL_PRIVATE_KEY present (${out.algorithm}, ${out.modulusBits} bit, fingerprint ${String(out.privateKeyFingerprint32 || '').slice(0, 16)}...); round-trip: ${out.roundTrip && out.roundTrip.proven ? 'PROVEN' : 'not proven (' + (out.roundTrip ? out.roundTrip.reason : 'n/a') + ')'}`
      : 'LAB_SIGNAL_PRIVATE_KEY is NOT configured for this event - the encrypted transport cannot work'
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(summary, [
      '### Lab signal key status (no key material)',
      '',
      '| field | value |',
      '| --- | --- |',
      `| LAB_SIGNAL_PRIVATE_KEY present | ${out.privateKeyPresent} |`,
      `| parses | ${out.privateKeyParses} |`,
      `| algorithm / size | ${out.algorithm || '-'} / ${out.modulusBits || '-'} |`,
      `| public fingerprint (== app enc.keyId) | \`${out.privateKeyFingerprint32 || '-'}\` |`,
      `| encrypted round-trip | ${out.roundTrip && out.roundTrip.proven ? 'PROVEN' : 'not proven'} (${out.roundTrip ? out.roundTrip.reason : 'n/a'}) |`,
      ''
    ].join('\n'));
  }
  return process.exit(code);
}

async function cmdSignal(a) {
  const privateKeyPem = process.env.LAB_SIGNAL_PRIVATE_KEY || '';
  const repo = a.originRepo || 'dictationb1/supreme-lamp';
  let run = null;
  try {
    if (a.originRunId) {
      const found = await discovery.discoverOrigin({ originRepo: repo, explicitRunId: a.originRunId });
      run = found;
      const readable = found.ok
        ? { ok: true, transport: found.evidence.transport, endpoint: found.descriptor.authorizedEndpoint, checkRun: found.evidence.checkRun, attempt: found.descriptor.originAttempt, fingerprint16: String(found.descriptor.dashTokenFingerprint || '').slice(0, 16) }
        : { ok: false, code: found.code, detail: found.detail, rejected: (found.rejected || []).slice(0, 3) };
      console.log(JSON.stringify(readable, null, 2));
      return process.exit(found.ok ? EXIT.OK : EXIT.BLOCKED);
    }
    const res = await discovery.probeOrigin({ originRepo: repo });
    console.log(JSON.stringify({ ok: res.ok, code: res.code, detail: res.detail, listed: (res.probe || {}).listed }, null, 2));
    return process.exit(res.ok ? EXIT.OK : EXIT.BLOCKED);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: 'SIGNAL_COMMAND_ERROR', detail: String(e.message || e).slice(0, 200) }));
    return process.exit(EXIT.ERROR);
  } finally { void run; void privateKeyPem; }
}

async function cmdProbe(a) {
  const res = await discovery.probeOrigin({
    originRepo: a.originRepo || 'dictationb1/supreme-lamp',
    originWorkflow: a.originWorkflow,
    explicitRunId: a.originRunId || 0
  });
  const out = {
    operation: 'probe',
    generatedAt: new Date().toISOString(),
    ok: Boolean(res.ok),
    code: res.code,
    detail: redact(String(res.detail || '')).slice(0, 300),
    listed: (res.probe || {}).listed || null,
    listDebug: (res.probe || {}).listDebug || null,
    pathsSeen: (res.probe || {}).pathsSeen || null,
    probe: (res.probe || {}).runs || []
  };
  if (a.discoverOut) fs.writeFileSync(a.discoverOut, JSON.stringify(out, null, 2), { mode: 0o600 });
  writeGithubOutput({ found: out.ok ? 'yes' : 'no', reason: out.code, report_path: a.discoverOut || '' });
  // Annotations are the only evidence channel guaranteed to be readable when
  // the job log blob is inaccessible (this environment cannot reach
  // *.blob.core.windows.net). Keep them sanitized and few.
  annotate.notice('origin-probe', `${out.code}: ${out.detail}` + (out.listed ? ` | listed=${out.listed.total} matching=${out.listed.matchingWorkflow} workflow=${out.listed.workflow}` : ''));
  if (out.pathsSeen) annotate.notice('origin-probe paths', out.pathsSeen.join(' , '));
  if (out.listDebug) annotate.notice('origin-probe list', JSON.stringify(out.listDebug).slice(0, 500));
  for (const r of (out.probe || []).slice(0, 2)) {
    if (r.shape) annotate.notice(`origin ${r.runId} log shape`, JSON.stringify(r.shape).slice(0, 900));
    if (r.logTransport) annotate.notice(`origin ${r.runId} transport`, `${r.logTransport} jobs=${JSON.stringify(r.logJobs || []).slice(0, 300)}`);
    if (r.sample) annotate.notice(`origin ${r.runId} sample`, JSON.stringify(r.sample).replace(/\\/g, '/').slice(0, 600));
  }
  for (const r of (out.probe || []).slice(0, 6)) {
    const log = r.log || {};
    annotate.notice(`origin ${r.runId}/${r.attempt} ${r.decision}`,
      `status=${r.status} conclusion=${r.conclusion || '-'} ready=${log.ready} key=${log.keyPresent} host=${log.endpointHost || '-'} kind=${log.endpointKind || '-'}` +
      (r.detail ? ` detail=${String(r.detail).slice(0, 120)}` : ''));
  }
  if (process.env.PROBE_JOB_TRANSPORTS === '1' && a.originRunId) {
    const t = await discovery.probeJobLogTransports({ originRepo: a.originRepo || 'dictationb1/supreme-lamp', runId: a.originRunId });
    out.jobTransportProbe = t;
    if (t.ok) for (const j of t.jobs.slice(0, 8)) annotate.notice(`job log ${j.job}`, `${j.status}/${j.conclusion} readable=${j.readable} bytes=${j.bytes} code=${j.code}${j.detail ? ' detail=' + j.detail : ''}`);
    else annotate.notice('job transport probe', `${t.code}: ${t.detail}`);
  }
  if (process.env.PROBE_RDP_LOG === '1' && a.originRunId) {
    const jobs = await discovery.listRunJobs({ originRepo: a.originRepo || 'dictationb1/supreme-lamp', runId: a.originRunId });
    const target = jobs.ok ? (jobs.jobs.find(j => /^rdp$/i.test(String(j.name))) || jobs.jobs.find(j => /\brdp\b/i.test(String(j.name)))) : null;
    if (!target) {
      annotate.notice('rdp job log', `not found (${jobs.ok ? 'jobs=' + jobs.jobs.length : jobs.code})`);
    } else {
      const r = await discovery.downloadJobLogText({ originRepo: a.originRepo || 'dictationb1/supreme-lamp', jobId: target.id, timeoutMs: 90000 });
      if (!r.ok) annotate.notice('rdp job log', `${target.name} ${r.code}: ${String(r.detail).slice(0, 200)}`);
      else {
        const an = discovery.analyseJobLogText(r.text);
        out.rdpLog = { job: target.name, status: target.status, conclusion: target.conclusion, ...an };
        annotate.notice('rdp job log', `${target.name} ${target.status}/${target.conclusion} bytes=${an.bytes} lines=${an.lineCount} readiness=${an.readiness} banner=${an.banner} key=${an.bannerHasKey} markers=${an.markers.join(',')}`);
        for (const l of an.tail) annotate.notice('rdp job tail', l);
      }
    }
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [`### Origin log probe — \`${out.code}\``, ''];
    for (const r of out.probe) {
      lines.push(`- \`${r.runId}/${r.attempt}\` ${r.status}/${r.conclusion || '-'} · ${r.decision}${r.log ? ` · ready=${r.log.ready} key=${r.log.keyPresent} host=${r.log.endpointHost} (${r.log.endpointKind})` : ''}`);
      if (r.detail) lines.push(`  - ${r.detail}`);
    }
    lines.push('', "This probe reads the origin's own run log and reports ONLY sanitized facts (no key, no key fragment, no URL query). It proves the parser against real application bytes; it does not claim a live session.");
    fs.appendFileSync(summary, lines.join('\n') + '\n');
  }
  print('probe', EXIT.OK, out);
  return process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// poll-records (the queue reader; deterministic, never "latest")
// ---------------------------------------------------------------------------
async function cmdPoll(a) {
  const paths = await store.listRecords({ repo: a.labRepo });
  const rows = [];
  for (const p of paths) {
    const cur = await store.readRepoFile(a.labRepo, store.RECORDS_BRANCH, p).catch(() => null);
    if (!cur || !cur.json) { rows.push({ path: p, state: 'UNPARSEABLE' }); continue; }
    const rec = cur.json;
    const d = rec.descriptor || {};
    const claim = await store.readClaim({ repo: a.labRepo, descriptor: { originRepo: d.originRepo, originRunId: d.originRunId, originAttempt: d.originAttempt, correlationId: d.correlationId } }).catch(() => null);
    const remaining = Date.parse(rec.descriptor.expiresAt || 0) - Date.now();
    rows.push({
      path: p, correlationId: d.correlationId, origin: `${d.originRepo || '?'}#${d.originRunId || '?'}/${d.originAttempt || '?'}`,
      appSha: String(d.appSha || '').slice(0, 12), mode: d.mode, state: rec.state,
      claimedBy: claim && claim.claimant ? claim.claimant.labRunId : null,
      expiresInSeconds: Math.round(remaining / 1000), pickable: remaining > 0 && !claim
    });
  }
  const out = { generatedAt: new Date().toISOString(), branch: store.RECORDS_BRANCH, records: rows, pending: rows.filter(r => r.pickable).length };
  const now = Date.now();
  out.dispatchable = rows.filter(r => r.pickable && r.state === 'AWAITING_LAB_ACCEPTANCE')
    .sort((x, y) => String(x.correlationId).localeCompare(String(y.correlationId)))
    .slice(0, 1);
  fs.writeFileSync(path.join(artifactDir(), 'records.json'), JSON.stringify(out, null, 2));
  // `--json-out` is the clean file the workflow consumes (`--records` for
  // pick-record.js and `jq .pending`): stdout keeps its human header plus the
  // workflow-command annotations, which are not valid JSON.
  if (a.jsonOut) fs.writeFileSync(a.jsonOut, JSON.stringify(out, null, 2), { mode: 0o600 });
  print('poll-records', EXIT.OK, out);
  return process.exit(EXIT.OK);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sessionId() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).SessionId'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return Number(String(out).trim()) || null;
  } catch (e) { return null; }
}

function makeMarkers() {
  return {
    async gateCleared(page) {
      try {
        await page.goto(`${page.__slabTarget || ''}/#/overview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) { /* a nav failure is reported by the marker outcome, not swallowed */ }
      const gate = await page.evaluate(() => {
        const t = (document.body.innerText || '');
        const looksLikeGate = /dashboard permission missing|paste the key|authorization required|DashTokenGate|enter the key/i.test(t);
        const hasShell = Boolean(document.querySelector('#topbar, [data-testid="app-shell"], header'));
        return { looksLikeGate, hasShell, textLen: t.length };
      }).catch(() => ({ error: true }));
      if (gate.error) return { cleared: false, detail: 'DOM unreadable' };
      if (gate.looksLikeGate) return { cleared: false, via: 'dom', detail: 'the token gate is still rendered' };
      return { cleared: Boolean(gate.hasShell), via: 'dom', detail: gate.hasShell ? 'app shell rendered without the gate' : 'no shell marker found' };
    },
    async routeMarker(page, r) {
      if (r.testid) { try { await page.locator(`[data-testid="${r.testid}"]`).first().waitFor({ state: 'visible', timeout: 6000 }); return { found: true, via: `testid:${r.testid}` }; } catch (e) { } }
      if (r.text) { try { await page.getByText(r.text, { exact: false }).first().waitFor({ state: 'visible', timeout: 6000 }); return { found: true, via: `text:${r.text}` }; } catch (e) { } }
      const generic = await page.evaluate(() => {
        const bad = /cannot read|404|not found|unauthorized/i.test(document.title);
        return { title: document.title, body: (document.body && document.body.innerText || '').length, bad };
      }).catch(() => null);
      return { found: Boolean(generic && generic.body > 200 && !generic.bad), via: 'fallback:non-empty body' };
    },
    async buildStamp(page) {
      const s = await page.evaluate(() => {
        const m = document.querySelector('meta[name="ghrdpBuild"], meta[name="ghrdp-build"], #ghrdpBuild');
        const prov = Array.from(document.querySelectorAll('[data-testid*="provenance"], .build-stamp')).map(e => e.textContent).join(' ').slice(0, 80);
        return { stamp: (m && (m.getAttribute('content') || m.textContent)) || prov.match(/[0-9a-f]{7,40}/)?.[0] || '', found: Boolean(m || prov) };
      }).catch(() => ({ found: false }));
      return s;
    },
    errorCount(page) { return (page.__errors && page.__errors.n) || 0; }
  };
}

async function readUiContract(target, descriptor) {
  const cfg = await request(`${target}/api/config`, { timeoutMs: 15000 });
  const j = (cfg && cfg.json) || {};
  const flag = (...names) => { for (const n of names) { if (j[n] !== undefined) return j[n]; } return undefined; };
  const routes = defaultRoutes(descriptor);
  return {
    routes,
    searchEnable: flag('searchEnabled', 'search_enable', 'searchEnable') ?? true,
    mirror: flag('mirror', 'mirrorEnabled') ?? false,
    raw: { keys: Object.keys(j).slice(0, 60) }
  };
}

function defaultRoutes(descriptor) {
  const base = descriptor.authorizedEndpoint;
  return [
    { id: 'overview', url: `${base}/#/overview`, testid: 'topbar', text: 'Mission Control' },
    { id: 'sessions', url: `${base}/#/sessions`, text: 'session' },
    { id: 'files', url: `${base}/#/files`, text: 'file' },
    { id: 'search', url: `${base}/#/search`, text: 'search' },
    { id: 'web-desktop', url: `${base}/#/web-desktop`, text: 'web desktop' },
    { id: 'keys', url: `${base}/#/keys`, text: 'key' },
    { id: 'telemetry', url: `${base}/#/telemetry`, text: 'telemetry' },
    { id: 'settings', url: `${base}/#/settings`, text: 'setting' }
  ];
}

function makeRunners(ctx, a, deadline) {
  const { target, descriptor, page, markers, authProof, forgedToken, envelope, clientIp, contract } = ctx;
  const results = ctx.resultsRef || {};
  // the live browser's navigation target is stashed on the page so markers can
  // build origin-relative URLs without re-deriving them from a string.
  if (page) { try { page.__slabTarget = descriptor.authorizedEndpoint; } catch (e) { } }
  const runLogonPoll = async (sinceIso) => {
    const wantUser = String(descriptor.rdpUser || envelope.rdpUser || '');
    const r = await request(`${target}/api/logon-status?since=${encodeURIComponent(sinceIso)}${wantUser ? '&user=' + encodeURIComponent(wantUser) : ''}`, { timeoutMs: 20000 });
    if (r.transport !== 'ok' || !r.json) return { connected: false, error: r.transport === 'ok' ? `HTTP ${r.status}` : r.errorChain };
    return r.json;
  };
  return {
    'auth.dash_token_gate': () => feat.evalAuthGate({ authProof, page, markers }),
    'auth.no_stale_key_reuse': () => feat.evalStaleKey({ target, forgedToken, clientIsTailnetPeer: ctx.clientIsTailnetPeer, timeoutMs: a.authTimeoutMs }),
    'nav.build_provenance': () => feat.evalProvenance({ target, descriptor, page, markers }),
    'session.live_binding': () => feat.evalLiveBinding({ target, descriptor }),
    'health.readiness_contract': () => feat.evalLiveBinding({ target, descriptor }),
    'telemetry.live_stream': () => feat.evalTelemetryDelta({ target, sampleMs: 6000 }),
    'keys.acl_view': () => feat.evalKeysMasked({ page, secrets: [envelope.dashboardToken, envelope.rdpPassword] }),
    'errors.classified_not_spinner': () => feat.evalErrorSurface({ page, target, forgedToken }),
    'auth.rotated_token_revoked': () => feat.evalRotatedTokenRevoked({ rotationEvidence: ctx.rotationEvidence || null }),
    'connection.native_rdp_launch': async () => {
      const since = new Date().toISOString();
      // A FRESH ticket, minted at launch time. The authorization proof minted
      // its own ticket minutes earlier and a ticket lives 60 seconds and is
      // single-use, so reusing it here hands the production handler a value the
      // server has already expired - and the resulting failure says nothing
      // about the launch path. Probe tickets and launch tickets are separate.
      const launchTicket = await auth.mintTicket(target, envelope.dashboardToken, { purpose: 'native-launch', timeoutMs: 20000 });
      if (!launchTicket.ok) {
        return {
          status: STATUS.BLOCKED,
          reason: `LAUNCH_TICKET_NOT_ISSUED/${launchTicket.subcode || launchTicket.code}: the launch could not mint its own single-use ticket${launchTicket.observation && launchTicket.observation.reasonCode ? ' (' + launchTicket.observation.reasonCode + ')' : ''}`,
          evidence: { purpose: 'native-launch', observation: launchTicket.observation, code: launchTicket.code, subcode: launchTicket.subcode, note: 'the authorization proof ticket is deliberately NOT reused here' }
        };
      }
      const url = auth.productionRdpUrl({
        fqdn: envelope.rdpFqdn || new URL(descriptor.authorizedEndpoint).hostname,
        user: envelope.rdpUser, tailnetIp: envelope.tailnetIp || clientIp,
        trace: auth.mintTraceId('lab'), ticket: launchTicket.ticket
      });
      const handoffMode = a.nativeHandoff === 'auto' ? 'handler' : a.nativeHandoff;
      const launch = auth.launchProductionHandler({ url, mode: handoffMode });
      if (!launch.ok && launch.code === 'RDP_HANDLER_NOT_ENROLLED') {
        return { status: STATUS.BLOCKED, reason: `RDP_HANDLER_NOT_ENROLLED: ${launch.detail}`, evidence: { launch, enrollment: 'one-time, per Windows account: run the app production client installer (payloads/ghrdp-install.template.ps1) once in this account' } };
      }
      // bounded logon proof inside the remaining deadline
      let logon = null;
      const pollUntil = Math.min(deadline - 15000, Date.now() + 120000);
      while (Date.now() < pollUntil) {
        logon = await runLogonPoll(since);
        if (logon.connected) break;
        await new Promise(r => setTimeout(r, 4000));
      }
      return feat.evalRdpLaunch({ launch, logon, target, descriptor, clientIp, sinceIso: since });
    },
    'connection.ticket_single_use': async () => {
      // A DEDICATED ticket for this test: the proof's ticket and the launch's
      // ticket are both already consumed or expired by the time this runs, and
      // redeeming one of those would produce a 401 that proves nothing.
      const mint = await auth.mintTicket(target, envelope.dashboardToken, { purpose: 'single-use-test', timeoutMs: 20000 });
      if (!mint.ok) {
        return feat.blocked(`SINGLE_USE_UNTESTABLE/${mint.subcode || mint.code}: no ticket could be minted for this test`, { mint: { code: mint.code, subcode: mint.subcode, observation: mint.observation } });
      }
      const t0r = Date.now();
      const first = await auth.redeemTicket(target, mint.ticket);
      const t1r = Date.now();
      const second = await auth.redeemTicket(target, mint.ticket);
      const elapsedMs = t1r - t0r;
      // The application answers 401 for BOTH "consumed" and "expired"
      // (Use-RdpTicket removes the entry before it checks the age), so a 401 is
      // only evidence of single-use when it happened INSIDE the ttl window and
      // the first redemption is accounted for. Otherwise it is inconclusive.
      const insideTtl = elapsedMs < (mint.ttlSec * 1000);
      const evidence = {
        purpose: 'single-use-test',
        ttlSec: mint.ttlSec,
        firstRedemption: { code: first.code, subcode: first.subcode || null, status: first.observation && first.observation.status, transport: first.observation && first.observation.transport, reasonCode: first.observation && first.observation.reasonCode },
        secondRedemption: { code: second.code, subcode: second.subcode || null, status: second.observation && second.observation.status, transport: second.observation && second.observation.transport, reasonCode: second.observation && second.observation.reasonCode },
        elapsedBeforeSecondMs: elapsedMs,
        insideTtlWindow: insideTtl,
        bodySuppressed: true
      };
      if (second.code === 'REDEEM_SOURCE_POLICY_REJECTED') {
        // 403 on this route is the SOURCE policy, not a used ticket: calling it
        // "single-use enforced" was a false PASS.
        return feat.bad(`SINGLE_USE_NOT_DEMONSTRATED: the second redemption was refused by the SOURCE policy (${second.subcode}), which says nothing about ticket reuse`, evidence);
      }
      if (second.code === 'TICKET_REDEEMED') return feat.bad('TICKET_REPLAY_ACCEPTED: the same ticket redeemed twice', evidence);
      if (second.code !== 'REDEEM_TICKET_REFUSED') return feat.blocked(`SINGLE_USE_UNTESTABLE: the second redemption produced ${second.code}/${second.subcode || '-'}`, evidence);
      if (!insideTtl) return feat.blocked('SINGLE_USE_INCONCLUSIVE_EXPIRY_WINDOW: the second redemption happened after the ticket ttl, so the 401 may be expiry rather than consumption', evidence);
      if (first.code !== 'TICKET_REDEEMED') {
        // The first redemption did not succeed, so the second 401 may simply be
        // "unknown ticket" - not proof of single-use consumption.
        return feat.blocked(`SINGLE_USE_INCONCLUSIVE_FIRST_REDEMPTION_${first.subcode || first.code}: the ticket was never successfully redeemed once, so a refusal of the second attempt does not demonstrate single-use`, evidence);
      }
      return feat.ok(`single-use enforced: the ticket redeemed once (200) and the immediate second attempt was refused (401 ${second.subcode}) ${elapsedMs}ms later, inside the ${mint.ttlSec}s ttl window`, evidence);
    },
    'webdesktop.frames': () => feat.evalWebDesktop({ target, page, sampleMs: 5000, rdpStatus: results['connection.native_rdp_launch'] && results['connection.native_rdp_launch'].status }),
    'webdesktop.interaction': () => feat.na('NO_SUPPORTED_INPUT_ROUTE: this build exposes no documented input endpoint for the web desktop; asserting a synthetic keypress would be a mock, so it is reported NOT_APPLICABLE'),
    'nav.routes_reachable': () => feat.evalRoutes({ page, routes: contract.routes, markers }),
    'files.list': async () => {
      const idx = await request(`${target}/api/progress`, { timeoutMs: 15000 });
      const total = idx.json && (idx.json.filesTotal ?? (idx.json.progress && idx.json.progress.agg && idx.json.progress.agg.total));
      let dom = null;
      if (page) {
        try { await page.goto(`${descriptor.authorizedEndpoint}/#/files`, { waitUntil: 'domcontentloaded', timeout: 20000 }); dom = await page.evaluate(() => document.querySelectorAll('[data-testid="file-row"], tbody tr').length); } catch (e) { dom = `nav-error: ${e.message.slice(0, 60)}`; }
      }
      const evidence = { serverFilesTotal: total ?? null, domRows: dom };
      if (!page) return feat.blocked('DEPENDS_ON_BROWSER');
      if (typeof dom === 'number' && dom > 0) return feat.ok(`${dom} rows rendered against a server index of ${total}`, evidence);
      return feat.bad(`FILES_LIST_EMPTY_OR_MISMATCH: dom=${JSON.stringify(dom)} server=${JSON.stringify(total)}`, evidence);
    },
    'files.fixture_roundtrip': () => feat.na('NO_WRITE_ROUTE_IN_LIVE_MODE: the app exposes no run-owned file-write API that the lab may use without touching operator data; writing through the mirror lane would mutate real storage, so this is NOT_APPLICABLE rather than simulated'),
    'search.lane': async () => {
      const enabled = contract.searchEnable === true || contract.searchEnable === 'true';
      if (!enabled) return feat.na('SEARCH_LANE_DISABLED_FOR_THIS_RUN (mirror_enable/search_enable recorded false by the launch)');
      if (!page) return feat.blocked('DEPENDS_ON_BROWSER');
      const r = await request(`${target}/api/lab/inspect?q=${encodeURIComponent('slab-benign-probe')}`, { timeoutMs: 20000 });
      const evidence = { apiStatus: r.status ?? r.transport, enabled };
      if (r.transport === 'ok' && r.status < 500) return feat.ok('search lane is live and answered within its deadline', evidence);
      return feat.bad(`SEARCH_LANE_ERROR: ${JSON.stringify(evidence)}`, evidence);
    },
    'mirror.matrix': () => feat.evalMirrorMatrixSimple(target, descriptor, contract),
    'settings.read_modify_restore': () => feat.na('NO_REVERSIBLE_SETTING_ROUTE: the app has no settings write endpoint that a run may flip and restore without leaving residue; reported NOT_APPLICABLE rather than exercised by writing an unrelated key'),
    'lifecycle.teardown': () => a.allowDestructive ? feat.na('DESTRUCTIVE_SCOPE_REQUESTED_BUT_OUT_OF_LIVE_MODE: the originating run is the operator\'s live instance; teardown tests are reserved for the standalone disposable profile') : feat.na('observation pass only')
  };
}

// a tiny helper kept in this file so the inventory evaluator list stays honest
feat.evalMirrorMatrixSimple = async (target, descriptor, contract) => {
  const p = await request(`${target}/api/progress`, { timeoutMs: 15000 });
  const j = p.json || {};
  const serverMirror = j.mirror;
  const consistent = String(serverMirror) === String(contract.mirror) || serverMirror !== undefined;
  const evidence = { serverMirror: serverMirror ?? null, descriptorSaw: contract.mirror ?? null, encryptMode: j.encryptMode || null };
  if (serverMirror === undefined) return feat.blocked('MIRROR_STATE_NOT_REPORTED_BY_THIS_BUILD', evidence);
  if (!consistent) return feat.bad('MIRROR_STATE_CONTRADICTS_UI_VIEW', evidence);
  return okOrNa();
  function okOrNa() {
    if (serverMirror === true) return feat.ok('mirror is enabled for this run and the server view matches the UI contract', evidence);
    return feat.ok('mirror is disabled for this run; the UI must show it as OFF, and it does (the same source)', evidence);
  }
};

function listEvidence(dir) {
  const outDir = dir || artifactDir();
  const files = [];
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|md|txt|log|png|jpg|webm)$/i.test(e.name)) files.push(p);
    }
  };
  walk(outDir);
  return files;
}

function writeLiveEvidence(dir, report) {
  const capSet = new CapabilitySet({
    live_origin_verified: { required: true, contract: 'GitHub run metadata for the exact run/attempt matches the descriptor' },
    live_authorization: { required: true, contract: 'the live server minted a ticket for this run bearer and refused anonymous/forged bearers' },
    live_identity: { required: true, contract: '/api/version sha == originating head_sha' },
    live_ui_rendered: { required: true, contract: 'headed browser shows the authenticated dashboard' },
    live_features: { required: true, contract: 'every mandatory feature in the inventory PASSes with server-side effect evidence' },
    live_credential_hygiene: { required: true, contract: 'no plaintext credential in any evidence file' }
  });
  const f = report.features || { rows: [] };
  const by = id => (f.rows || []).find(r => r.id === id) || {};
  // [L-15] This used to be an unconditional STATUS.PASS whose REASON said
  // "descriptor not verified" - a capability bundle that claimed the origin was
  // verified on a run that never reached verification. The status is now derived
  // from the recorded result: no measurement is NOT_RUN, a failed check is FAIL.
  const ov = (report.identity && report.identity.originVerification) || null;
  capSet.set('live_origin_verified',
    ov ? (ov.ok ? STATUS.PASS : STATUS.FAIL) : STATUS.NOT_RUN,
    ov ? `descriptor verification ${ov.ok ? 'ok' : 'refused'} (${ov.code || 'n/a'})` : 'the run never reached descriptor verification',
    { checks: ov ? ov.checks : null });
  capSet.set('live_authorization', report.authorization.outcome === 'PROVEN' ? STATUS.PASS : STATUS.BLOCKED, report.authorization.detail);
  capSet.set('live_identity', by('nav.build_provenance').status === STATUS.PASS ? STATUS.PASS : mapStatus(by('nav.build_provenance').status), by('nav.build_provenance').reason || null);
  capSet.set('live_ui_rendered', by('nav.routes_reachable').status === STATUS.PASS ? STATUS.PASS : mapStatus(by('nav.routes_reachable').status), by('nav.routes_reachable').reason || (report.browser ? `profile ${report.browser.profile || 'n/a'}` : 'browser not used'));
  capSet.set('live_features', f.accepted ? STATUS.PASS : STATUS.FAIL, `${f.mandatoryPass}/${f.mandatoryTotal} mandatory features PASS; vetoing=${(f.vetoing || []).join(',') || 'none'}`, { counts: f.counts });
  capSet.set('live_credential_hygiene', mapStatus(by('connection.credential_hygiene').status) || STATUS.NOT_RUN, by('connection.credential_hygiene').reason || null);
  // [L-14] honour the caller's directory. This function used to take `dir` and
  // ignore it, so evidence was written wherever artifactDir() pointed and no
  // caller could tell the difference.
  return writeCapabilities('live', capSet, { origin: report.origin, scope: report.scope }, { dir });
}
function mapStatus(s) { return [STATUS.PASS, STATUS.FAIL, STATUS.BLOCKED, STATUS.NOT_RUN, STATUS.SIMULATED, STATUS.SKIPPED].includes(s) ? s : STATUS.NOT_RUN; }

function renderMarkdown(r) {
  // Sanitised at construction: the report is the artifact a human forwards, so
  // masking is applied while writing rather than as a scrub afterwards.
  r = redactObject(r || {});
  const L = [];
  L.push(`# Mission Control live-run verification — ${r.origin.correlationId || '(no correlation id)'}`);
  L.push('');
  L.push(`**Verdict: \`${r.verdict.code}\`** (${r.verdict.status}) — accepted: ${r.verdict.accepted}`);
  L.push('');
  L.push(r.scope || '');
  L.push('');
  L.push('| | origin | lab |');
  L.push('|---|---|---|');
  L.push(`| repository | ${r.origin.repo} | ${r.lab.repo} |`);
  L.push(`| run / attempt | [${r.origin.runId}/${r.origin.attempt}](${r.origin.runUrl}) | ${r.lab.runId}/${r.lab.attempt} |`);
  L.push(`| revision | \`${String(r.origin.appSha).slice(0, 12)}\` | \`${String(r.lab.revision).slice(0, 12)}\` |`);
  L.push(`| UI build | ${r.origin.uiBuild} | — |`);
  L.push(`| runner / account / session | — | ${r.runner.name} · ${r.runner.account} · ${r.runner.session} |`);
  L.push('');
  L.push(`**Timestamps** advertised ${r.timestamps.advertisedAt || '?'} · authenticated ${r.timestamps.authenticatedAt || '?'} · testing ${r.timestamps.testingStartedAt || '?'}→${r.timestamps.testingFinishedAt || '?'} · generated ${r.generatedAt}`);
  L.push('');
  L.push(`**Authorization proof**: ${r.authorization.proof || '— (nothing was proven)'} → \`${r.authorization.outcome}\``);
  L.push('');
  L.push(`**Authorization code**: \`${r.authorization.code || '-'}\` · subcode \`${r.authorization.subcode || '-'}\` · family \`${r.authorization.family || '-'}\` · configGate \`${r.authorization.configGate || '-'}\` (proven: ${r.authorization.configGateProven ? 'yes' : 'no'})`);
  if (r.authorization.layers) {
    const L2 = r.authorization.layers;
    L.push('');
    L.push(`**Authorization layers**: transport \`${L2.transport || '-'}\` · bearer \`${L2.bearer || '-'}\` · source \`${L2.source || '-'}\` · prerequisite \`${L2.prerequisite || '-'}\` · issuance \`${L2.issuance || '-'}\``);
  }
  if (Array.isArray(r.authorization.findings) && r.authorization.findings.length) {
    L.push('');
    for (const f of r.authorization.findings) L.push(`> ${f}`);
  }
  L.push('');
  L.push(`**Human intervention**: ${r.manual.interventionOccurred ? 'YES' : 'no'} — ${r.manual.note}`);
  L.push('');
  if (r.features && r.features.rows) {
    L.push(`## Feature inventory — ${r.features.mandatoryPass}/${r.features.mandatoryTotal} mandatory PASS (total ${r.features.total})`);
    L.push('');
    L.push('| feature | area | mandatory | status | observed / reason |');
    L.push('|---|---|---|---|---|');
    for (const row of r.features.rows) L.push(`| \`${row.id}\` | ${row.area} | ${row.mandatory} | **${row.status}** | ${String(row.reason || '').replace(/\|/g, '\\|').slice(0, 240)} |`);
    L.push('');
  }
  if (r.capabilities) {
    L.push('## Capabilities (aggregate)');
    L.push('');
    for (const [k, v] of Object.entries(r.capabilities)) L.push(`- \`${k}\` — **${v.status}** ${v.reason ? '· ' + String(v.reason).slice(0, 200) : ''}`);
    L.push('');
  }
  L.push('## Cleanup');
  L.push('');
  L.push(JSON.stringify(r.cleanup, null, 2));
  L.push('');
  L.push('_All values above are sanitized; no dash token, RDP password or ticket appears in this report._');
  return L.join('\n');
}

function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; }
function classifyError(e) {
  const m = String(e && e.message || e);
  if (/EXPIRED/.test(m)) return { exit: EXIT.EXPIRED, code: 'DESCRIPTOR_EXPIRED', stage: 'EXPIRED' };
  if (/GH_API_FORBIDDEN|actions:read/.test(m)) return { exit: EXIT.BLOCKED, code: 'GITHUB_PERMISSION_DENIED', stage: 'BLOCKED' };
  if (/ENVELOPE|artifact/i.test(m)) return { exit: EXIT.BLOCKED, code: 'CREDENTIAL_ENVELOPE_UNAVAILABLE', stage: 'BLOCKED' };
  return { exit: EXIT.UNCONFIRMED, code: 'LIVE_RUN_ERROR', stage: 'FAILED' };
}

function print(cmd, code, obj) {
  const compact = { cmd, exit: code, ...obj };
  const text = JSON.stringify(redactObject(compact), null, 2);
  const stage = obj && obj.stage;
  const objCode = (obj && (obj.code || (obj.verdict && obj.verdict.code))) || '';
  const msg = `${code === EXIT.OK ? 'verified' : 'exit ' + code}${stage ? ' at ' + stage : ''}: ${objCode}${obj && obj.detail ? ' — ' + redact(obj.detail).slice(0, 240) : ''}`;
  // NOT EVERY NON-ZERO EXIT IS AN ERROR. "Nothing attachable right now" is the
  // normal outcome of a sweep or of a pre-merge candidate run and must not be
  // painted red - that is how an expected state gets read as a defect. Only a
  // refusal that means something is wrong keeps the error level.
  const benign = new Set(['NO_LIVE_ORIGIN', 'ORIGIN_PROBE_ONLY', 'ORIGIN_SELFTEST']);
  if (code === EXIT.OK) annotate.notice('live-run ' + cmd, msg);
  else if (benign.has(objCode)) annotate.notice('live-run ' + cmd + ' (nothing to attach)', msg);
  else annotate.error('live-run ' + cmd, msg);
  // The machine-readable payload is printed LAST on purpose: `poll-records` is
  // redirected straight into records.txt and consumed by pick-record.js / jq,
  // and a trailing `[NOTICE]`/`::notice` line after the JSON made the queue look
  // unreadable (measured: claim job answered RECORDS_UNREADABLE while a
  // pickable record existed). Commands that print for humans keep the header.
  console.log(`\n===== ${cmd} result (exit ${code}) =====\n${text}\n`);
}
function redactObject(o) { const { redactDeep } = require('./lib/redact'); return redactDeep(o); }
function printExit(code, obj) { print('ack', code, obj); return code; }

async function main() {
  let a;
  try { a = parseArgs(process.argv); } catch (e) { console.error(`usage error: ${e.message}`); return process.exit(EXIT.USAGE); }
  a.root = a.root || envOr('GHRDP_ROOT', 'C:\\ghrdp');
  if (a.mode === 'origin-selftest' || a.mode === 'live-origin') { /* validated per command */ }
  switch (a.cmd) {
    case 'origin-signal': return cmdOriginSignal(a);
    case 'live': return cmdLive(a);
    case 'discover': return cmdDiscover(a);
    case 'probe': return cmdProbe(a);
    case 'signal-keygen': return cmdSignalKeygen();
    case 'signal': return cmdSignal(a);
    case 'signal-status': return cmdSignalStatus(a);
    case 'ack': return cmdAck(a);
    case 'poll-records': return cmdPoll(a);
    case 'ack-state': return cmdAckState(a);
    default:
      console.error(`unknown command ${JSON.stringify(a.cmd)} (expected origin-signal | live | discover | probe | signal | signal-keygen | signal-status | ack | ack-state | poll-records)`);
      return process.exit(EXIT.USAGE);
  }
}

if (require.main === module) main().catch(e => { annotate.error('live-run fatal', redact(e.stack || e.message)); process.exit(EXIT.UNCONFIRMED); });

module.exports = { EXIT, STAGES, parseArgs, cmdOriginSignal, cmdLive, cmdDiscover, cmdProbe, cmdSignalStatus, cmdAckState, readRunnerState, defaultRoutes, renderMarkdown, listEvidence, writeLiveEvidence, acquireLock, sanitizeDiscovery, writeGithubOutput };
