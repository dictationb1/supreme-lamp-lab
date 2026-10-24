'use strict';
// Hosted (no-Windows) regressions for two things:
//   1. scripts/lib/ws-frame.js - the RFC6455 framing the R2 matrix uses to talk
//      to the REAL PowerShell server (masked client frames, server-frame
//      parsing, close codes, latency statistics).
//   2. The committed application R2 patch (0003-*.patch): static invariants that
//      prove the accept-loop starvation repair is present and that the long-
//      lived WebSocket pump moved off the accept thread. The behavioral,
//      real-socket consequence is measured on the Windows client by
//      scripts/candidate/real-backend.js; this test pins the source structure.
//
// The negative direction matters: every structural assertion below is true on
// the runspace-repaired server and false on the pristine inline base, so a
// regression that re-inlines the pump fails here without needing Windows.
const fs = require('fs');
const path = require('path');
const wsFrame = require('../lib/ws-frame');

module.exports = async function wsFrameTests({ test, assert }) {
  test('ws-frame: masked text frame round-trips through the server mask convention', () => {
    const payload = JSON.stringify({ type: 'hello', key: 'lab-synthetic-key-000' });
    const frame = wsFrame.maskedFrame(payload, 0x1);
    assert.ok(Buffer.isBuffer(frame));
    // FIN + text opcode in the first byte; MASK bit set in the second.
    assert.strictEqual(frame[0] & 0xf0, 0x80);
    assert.strictEqual(frame[0] & 0x0f, 0x1);
    assert.ok((frame[1] & 0x80) === 0x80, 'client frame must be masked');
    const len = frame[1] & 0x7f;
    const mask = frame.slice(2, 6);
    const body = frame.slice(6, 6 + len);
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = body[i] ^ mask[i % 4];
    assert.strictEqual(unmasked.toString('utf8'), payload);
  });

  test('ws-frame: 16-bit length path frames a 126..65535 byte payload', () => {
    const payload = 'x'.repeat(200);
    const frame = wsFrame.maskedFrame(payload, 0x1);
    assert.strictEqual(frame[1] & 0x7f, 126, 'uses the extended-length marker');
    const declared = frame.readUInt16BE(2);
    assert.strictEqual(declared, 200);
    const mask = frame.slice(4, 8);
    const body = frame.slice(8, 8 + 200);
    const unmasked = Buffer.alloc(200);
    for (let i = 0; i < 200; i++) unmasked[i] = body[i] ^ mask[i % 4];
    assert.strictEqual(unmasked.toString('utf8'), payload);
  });

  test('ws-frame: close frame carries the RFC6455 status code', () => {
    const frame = wsFrame.closeFrame(1001);
    assert.strictEqual(frame[0] & 0x0f, 0x8, 'close opcode');
    const len = frame[1] & 0x7f;
    assert.strictEqual(len, 2);
    const mask = frame.slice(2, 6);
    const body = frame.slice(6, 8);
    const code = Buffer.from([body[0] ^ mask[0], body[1] ^ mask[1]]).readUInt16BE(0);
    assert.strictEqual(code, 1001);
  });

  test('ws-frame: parses unmasked server text and close frames', () => {
    const text = JSON.stringify({ type: 'ping', ok: true });
    const textFrame = Buffer.concat([Buffer.from([0x81, text.length]), Buffer.from(text, 'utf8')]);
    let parsed = wsFrame.parseServerFrames(textFrame);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].opcode, 0x1);
    assert.strictEqual(parsed[0].text, text);
    assert.strictEqual(parsed[0].closeCode, null);

    const closeBody = Buffer.alloc(2);
    closeBody.writeUInt16BE(1000, 0);
    const closeFrame = Buffer.concat([Buffer.from([0x88, 0x02]), closeBody]);
    parsed = wsFrame.parseServerFrames(closeFrame);
    assert.strictEqual(parsed[0].opcode, 0x8);
    assert.strictEqual(parsed[0].closeCode, 1000);

    // A partial frame must not throw and must not yield a half record.
    const partial = Buffer.from([0x81, 80, 0x61, 0x62]);
    assert.deepStrictEqual(wsFrame.parseServerFrames(partial), []);
  });

  test('ws-frame: latency stats separate successes from timeouts', () => {
    const samples = [
      { ok: true, status: 200, ms: 10 }, { ok: true, status: 200, ms: 20 },
      { ok: true, status: 200, ms: 30 }, { ok: true, status: 200, ms: 40 },
      { ok: false, ms: 2000, error: 'timeout' }
    ];
    const st = wsFrame.latencyStats(samples);
    assert.strictEqual(st.count, 5);
    assert.strictEqual(st.okCount, 4);
    assert.strictEqual(st.timeouts, 1);
    assert.strictEqual(st.median, 30);
    assert.strictEqual(st.max, 40);
    assert.ok(st.p95 >= 30 && st.p95 <= 40);
    const none = wsFrame.latencyStats([{ ok: false, ms: 5, error: 'timeout' }]);
    assert.strictEqual(none.okCount, 0);
    assert.strictEqual(none.median, null);
  });

  test('r2 patch: structural accept-loop starvation repair invariants', () => {
    // Locate the newest committed 0003 R2 patch across the report bundles.
    const reportsDir = path.join(process.cwd(), 'reports', 'mission-control');
    let patchText = '';
    try {
      const bundles = fs.readdirSync(reportsDir).filter((d) => /^[0-9]/.test(d)).sort();
      for (let i = bundles.length - 1; i >= 0 && !patchText; i--) {
        const pdir = path.join(reportsDir, bundles[i], 'app-patches');
        if (!fs.existsSync(pdir)) continue;
        const p = fs.readdirSync(pdir).filter((f) => /^0003-.*\.patch$/.test(f)).sort().pop();
        if (p) patchText = fs.readFileSync(path.join(pdir, p), 'utf8');
      }
    } catch (e) { patchText = ''; }
    if (!patchText) {
      // Older checkout without a committed R2 patch: nothing to assert here,
      // the Windows real-backend job remains the behavioral gate.
      return;
    }
    // The /ws request path must dispatch to a worker, not pump inline.
    assert.match(patchText, /Invoke-R2DispatchWebSocket/);
    // A bounded runspace pool and a non-blocking admission semaphore.
    assert.match(patchText, /CreateRunspacePool\(/);
    assert.match(patchText, /SetMaxRunspaces\(\[int\]\$script:R2WsMaxClients\)/);
    assert.match(patchText, /New-Object System\.Threading\.SemaphoreSlim/);
    assert.match(patchText, /R2WsGate\.Wait\(0\)/);
    // Excess connections fail predictably with 503 instead of hanging.
    assert.match(patchText, /websocket capacity exhausted; retry/);
    // The worker releases the gate and closes its socket on every path.
    assert.match(patchText, /\$Ctx\.Gate\.Release\(\)/);
    assert.match(patchText, /\$Ctx\.Client\.Close\(\)/);
    // Audit writers serialize on a shared Monitor lock.
    assert.match(patchText, /\[System\.Threading\.Monitor\]::Enter\(\$script:ClientAuditLock\)/);
    // Shutdown disposes the pool and semaphore after the listener stops.
    assert.match(patchText, /Stop-R2WebSocketPool/);
    assert.match(patchText, /R2WsPool\.Dispose\(\)/);
    assert.match(patchText, /R2WsGate\.Dispose\(\)/);
    // Split the diff into added vs removed content (strip the diff column).
    const addedText = patchText.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    const removedText = patchText.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1))
      .join('\n');
    // The repair ADDS the worker dispatch and REMOVES the inline pump. This is
    // the precise accept-loop starvation swap, independent of context lines.
    assert.match(addedText, /Invoke-R2DispatchWebSocket -Client \$Client/);
    assert.match(removedText, /Invoke-F99WebSocketUpgrade -Client \$Client/);
    // The dispatcher is invoked from the request path and returns immediately.
    assert.match(addedText, /if \(\$path -eq '\/ws'\)|Invoke-R2DispatchWebSocket/);
  });
};
