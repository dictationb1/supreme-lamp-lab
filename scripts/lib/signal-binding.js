'use strict';
// PUBLIC-ONLY MC-SIGNAL IDENTITY AUDIT.
//
// `lib/live-signal.js` validates the envelope against the GitHub run API and
// then decrypts the per-run credential (which needs the lab private key, i.e.
// the self-hosted client job). This module answers the narrower question that
// needs NO secret:
//
//   does the published signal check run belong to THIS run, THIS attempt and
//   THIS head sha - and is it still live, tailnet-scoped and within the 6 h cap?
//
// Two published formats are audited, because both exist in the wild:
//   * `MC-SIGNAL v1 <base64url(JSON)>` in `output.summary` (the lab's patch);
//   * the application's `mc-signal/v1` fenced JSON in `output.text`
//     (hybrid rsa-oaep-sha256+aes-256-gcm envelope + published AAD).
// The AAD is checked against the published identity; the ciphertext is checked
// for SHAPE only and is never decrypted here, so nothing in the output can be
// mistaken for the credential/ticket proof that only the client VM can produce.
//
// Every expectation comes from TRUSTED evidence (the run API), never from a
// second field of the same document.

const signalLib = require('./live-signal');

const SHA_RE = /^[0-9a-f]{40}$/;
const KEYID_RE = /^(rsa:)?[0-9a-f]{16,32}$/;
// RSA-3072 OAEP-SHA256 ciphertext is 384 bytes => 512 base64 characters.
// Larger keys are allowed; a value this short cannot be a sealed 3072-bit key.
const MIN_CIPHERTEXT_B64 = 340;

function checkRunIsLive(checkRun) {
  const status = String((checkRun && checkRun.status) || '');
  const conclusion = String((checkRun && checkRun.conclusion) || '');
  if (status && status !== 'in_progress') return { ok: false, detail: `check run status ${status}${conclusion ? '/' + conclusion : ''}` };
  return { ok: true };
}

/**
 * Audit one published signal against one run.
 *
 * @param {object} p
 * @param {object} p.run        GitHub run object (id, run_attempt, head_sha)
 * @param {object|null} p.checkRun  the `mission-control-live-signal` check run, if any
 * @param {string} p.originRepo  expected repository, e.g. `dictationb1/supreme-lamp`
 * @param {number} [p.now]       epoch ms (tests pin the clock)
 */
function auditSignalBinding({ run, checkRun, originRepo, now }) {
  const ev = {
    schema: 1,
    originRepo: originRepo || '',
    runId: run && run.id ? Number(run.id) : null,
    runAttempt: run && run.run_attempt ? Number(run.run_attempt) : null,
    headSha: String((run && run.head_sha) || ''),
    runStatus: String((run && run.status) || ''),
    format: null,
    checkRun: null,
    envelope: null,
    checks: []
  };
  const done = (ok, code, detail) => ({ ok, code, detail, evidence: ev });
  const check = (name, pass, detail) => {
    ev.checks.push({ name, pass, detail: detail === undefined ? '' : String(detail).slice(0, 240) });
    return pass;
  };

  if (!run || !ev.runId || !SHA_RE.test(ev.headSha)) {
    return done(false, 'RUN_EVIDENCE_INVALID', 'the run object is missing id/run_attempt/head_sha');
  }
  if (!checkRun) {
    return done(false, 'SIGNAL_NOT_PUBLISHED', `no ${signalLib.SIGNAL_NAME} check run exists for ${ev.headSha.slice(0, 7)} yet`);
  }

  ev.checkRun = {
    id: checkRun.id || null,
    name: String(checkRun.name || ''),
    status: String(checkRun.status || ''),
    conclusion: checkRun.conclusion || null,
    startedAt: checkRun.started_at || null,
    completedAt: checkRun.completed_at || null,
    headSha: String(checkRun.head_sha || ''),
    externalId: checkRun.external_id || null,
    title: checkRun.output ? (checkRun.output.title || null) : null
  };

  if (!check('name', ev.checkRun.name === signalLib.SIGNAL_NAME, ev.checkRun.name)) {
    return done(false, 'SIGNAL_WRONG_CHECK', `check run is ${JSON.stringify(ev.checkRun.name)}, not ${signalLib.SIGNAL_NAME}`);
  }
  const live = checkRunIsLive(checkRun);
  if (!check('checkRunLive', live.ok, live.detail)) {
    return done(false, 'SIGNAL_NOT_LIVE', `the signal was closed (${live.detail}) - the ephemeral server is no longer advertised`);
  }
  // The check-run API carries its own head_sha; it must be the run's head sha
  // even before the envelope is decoded.
  if (!check('checkRunHeadSha', ev.checkRun.headSha === ev.headSha, `${ev.checkRun.headSha || '(none)'} vs ${ev.headSha}`)) {
    return done(false, 'SIGNAL_CHECK_SHA_MISMATCH', `check run head_sha ${ev.checkRun.headSha} != run head_sha ${ev.headSha}`);
  }

  // The check run's own publisher-written external_id must agree too.
  if (ev.checkRun.externalId) {
    const want = `${originRepo}#${ev.runId}.${ev.runAttempt}`;
    if (!check('externalId', ev.checkRun.externalId === want, `${ev.checkRun.externalId} vs ${want}`)) {
      return done(false, 'SIGNAL_EXTERNAL_ID_MISMATCH', `external_id ${ev.checkRun.externalId} != ${want}`);
    }
  }

  const summary = String((checkRun.output && (checkRun.output.summary || checkRun.output.text)) || '');
  const text = String((checkRun.output && (checkRun.output.text || checkRun.output.summary)) || '');
  const expect = { repo: originRepo, runId: ev.runId, attempt: ev.runAttempt, appSha: ev.headSha, now };

  // ---- format 1: base64 `MC-SIGNAL v1` (lab patch) -------------------------
  const parsed = signalLib.parseSignal(summary);
  if (parsed.ok) {
    ev.format = 'MC-SIGNAL v1';
    const env = parsed.envelope;
    ev.envelope = {
      v: env.v, repo: env.repo, runId: env.runId, attempt: env.attempt, appSha: env.appSha,
      uiBuild: env.uiBuild || null, endpoint: env.endpoint, correlation: env.correlation || null,
      issuedAt: env.issuedAt || null, expiresAt: env.expiresAt || null,
      enc: { alg: env.enc && env.enc.alg, keyId: env.enc && env.enc.keyId, ciphertextChars: env.enc ? String(env.enc.ciphertext || '').length : 0 }
    };
    const v = signalLib.validateSignal(env, expect);
    if (!check('identity', v.ok, v.ok ? `${env.repo}#${env.runId}/${env.attempt} @ ${env.appSha}` : `${v.code}: ${v.detail}`)) {
      return done(false, v.code, v.detail);
    }
    const ct = String(env.enc.ciphertext || '');
    if (!check('keyId', KEYID_RE.test(String(env.enc.keyId || '')), env.enc.keyId)) {
      return done(false, 'SIGNAL_KEYID_SHAPE', `enc.keyId ${JSON.stringify(env.enc.keyId)} is not a fingerprint`);
    }
    if (!check('alg', env.enc.alg === 'RSA-OAEP-256', env.enc.alg)) {
      return done(false, 'SIGNAL_ALG', `enc.alg ${JSON.stringify(env.enc.alg)} != RSA-OAEP-256`);
    }
    if (!check('ciphertextBase64', /^[A-Za-z0-9+/]+={0,2}$/.test(ct) && ct.length >= MIN_CIPHERTEXT_B64, `${ct.length} b64 chars`)) {
      return done(false, 'SIGNAL_CIPHERTEXT_SHAPE', `ciphertext is ${ct.length} base64 chars - too short to be a sealed 3072-bit key`);
    }
    if (env.uiBuild) {
      const named = String(env.uiBuild).replace(/^ui-dist-/, '').replace(/\.zip$/, '');
      const same = named === ev.headSha || (SHA_RE.test(named) === false && named.length >= 7 && ev.headSha.startsWith(named));
      if (!check('uiBuild', same, env.uiBuild)) {
        return done(false, 'SIGNAL_UI_BUILD_MISMATCH', `uiBuild ${env.uiBuild} does not name ${ev.headSha.slice(0, 7)}`);
      }
    }
    return done(true, 'SIGNAL_BOUND', `${originRepo}#${ev.runId}/${ev.runAttempt} sha ${ev.headSha.slice(0, 7)} endpoint ${env.endpoint} expires ${v.expiresAt}`);
  }

  // ---- format 2: application `mc-signal/v1` JSON ---------------------------
  const appParsed = signalLib.parseAppSignal(text);
  if (!appParsed.ok) {
    if (check('formatRecognised', false, `${parsed.code} / ${appParsed.code}`)) { /* unreachable by design */ }
    return done(false, 'SIGNAL_NOT_FOUND', `no recognised signal block in the check-run output (${parsed.code}; application format: ${appParsed.code})`);
  }
  ev.format = signalLib.APP_SCHEMA;
  const sig = appParsed.signal;
  const appEnv = sig.credential.envelope;
  ev.envelope = {
    v: appEnv.v,
    repo: String(sig.repository || ''),
    runId: String(sig.runId || ''),
    attempt: Number(sig.runAttempt || 0),
    appSha: String(sig.sha || ''),
    uiBuild: sig.ui && sig.ui.sha ? `ui-dist-${sig.ui.sha}` : null,
    endpoint: (sig.endpoint && sig.endpoint.primary) || null,
    issuedAt: sig.publishedAt || sig.startedAt || null,
    expiresAt: sig.expiresAt || null,
    enc: {
      alg: appEnv.alg,
      keyId: appEnv.keyId,
      ciphertextChars: String(appEnv.ct || '').length,
      wrappedKeyChars: String(appEnv.wrappedKey || '').length,
      hasAad: Boolean(appEnv.aadB64)
    }
  };
  const v = signalLib.validateAppSignal(sig, expect);
  if (!check('identity', v.ok, v.ok ? `${sig.repository}#${sig.runId}/${sig.runAttempt} @ ${sig.sha}` : `${v.code}: ${v.detail}`)) {
    return done(false, v.code, v.detail);
  }
  const aad = signalLib.verifyAppAad(sig);
  if (!check('aadBindsIdentity', aad.ok, aad.ok ? Object.keys(aad.aad).join(',') : `${aad.code}: ${aad.detail}`)) {
    return done(false, aad.code, aad.detail);
  }
  if (!check('alg', appEnv.alg === signalLib.APP_ALG_RSA, appEnv.alg)) {
    return done(false, 'APP_SIGNAL_UNSUPPORTED_ALG', `alg ${JSON.stringify(appEnv.alg)} cannot be opened with the lab RSA key`);
  }
  if (!check('wrappedKeyBase64', /^[A-Za-z0-9+/]+={0,2}$/.test(String(appEnv.wrappedKey || '')) && String(appEnv.wrappedKey).length >= MIN_CIPHERTEXT_B64, `${String(appEnv.wrappedKey || '').length} b64 chars`)) {
    return done(false, 'APP_SIGNAL_CIPHERTEXT_SHAPE', `wrappedKey is ${String(appEnv.wrappedKey || '').length} base64 chars - too short for a 3072-bit RSA wrap`);
  }
  const nonceBytes = Buffer.from(String(appEnv.nonce || ''), 'base64').length;
  if (!check('nonce96', nonceBytes === 12, `${nonceBytes} bytes`)) {
    return done(false, 'APP_SIGNAL_NONCE_SHAPE', `AES-GCM nonce is ${nonceBytes} bytes, not 12`);
  }
  const tagBytes = Buffer.from(String(appEnv.tag || ''), 'base64').length;
  if (!check('tag128', tagBytes === 16, `${tagBytes} bytes`)) {
    return done(false, 'APP_SIGNAL_TAG_SHAPE', `GCM tag is ${tagBytes} bytes, not 16`);
  }
  if (sig.ui && sig.ui.matchesRunSha === false) {
    return done(false, 'APP_SIGNAL_UI_BUILD_MISMATCH', 'the publisher itself reports ui.matchesRunSha=false');
  }
  return done(true, 'SIGNAL_BOUND', `${originRepo}#${ev.runId}/${ev.runAttempt} sha ${ev.headSha.slice(0, 7)} endpoint ${v.endpoint} expires ${v.expiresAt}`);
}

module.exports = { auditSignalBinding, MIN_CIPHERTEXT_B64, SHA_RE, KEYID_RE };
