'use strict';
// THE FEATURE INVENTORY. Built from the app's ACTUAL current contract (its
// routes, its gated/protected API surface, and the per-run feature flags the
// launcher records), not from a fixed checklist. `mandatory: true` means a
// non-PASS vetoes the run's VERIFIED verdict; `mandatory: 'conditional'`
// becomes mandatory only when the run enabled the feature; `false` means it is
// reported but cannot veto. NOT_APPLICABLE must always carry a reason —
// "silently skipped" is exactly what this file exists to prevent.

const flagOn = v => v === true || v === 'true' || v === 1;

/**
 * @param contract { routes:[{id,url,testid?,text?}], searchEnable, mirror,
 *                   webdesk, webdeskInput, uiBuild, destructive }
 */
function buildInventory(contract = {}) {
  const c = contract || {};
  const defs = [
    {
      id: 'auth.dash_token_gate', area: 'authentication', mandatory: true, evaluator: 'evalAuthGate',
      requirement: 'The dashboard must refuse to run unauthenticated on a runner-served origin and accept exactly the current run\'s key.',
      source: 'src/lib/dashToken.ts (isRunnerServed/shouldGate) · payloads/ghrdp-server.ps1 Test-ClientAllowed/Test-CredsAllowed',
      preconditions: ['live backend reachable', 'per-run envelope delivered'],
      action: 'Fresh browser profile with no stored token → gate; seed the run\'s key → gate clears.',
      expectUi: 'gate visible without a key; gone with the key; no ?key= left in the address bar',
      expectServer: 'POST /api/rdp-token → 401 anonymous, 401 forged bearer, 200 {rid} with the run bearer'
    },
    {
      id: 'auth.no_stale_key_reuse', area: 'authentication', mandatory: true, evaluator: 'evalStaleKey',
      requirement: 'A key stored from an earlier run must not authorise this run.',
      source: 'main.yml writes a fresh dashToken per run into C:\\ghrdp\\config.json',
      preconditions: ['a forged token of the same shape'],
      action: 'Present the forged token to the ticket route and to the gated config route.',
      expectUi: 'n/a (server contract)',
      expectServer: '401 on /api/rdp-token; /api/config?key=forged must NOT return the gated credentials block'
    },
    {
      id: 'nav.routes_reachable', area: 'navigation', mandatory: true, evaluator: 'evalDashboardSurfaces',
      requirement: 'The visible UI reaches every surface the current build actually declares, with no new page errors. The shipped dashboard (payloads/ui.html) is one page with named sections, so the surfaces are its own anchors; a build that publishes `uiRoutes` is walked route by route instead.',
      source: 'payloads/ui.html (#pillConn, #sec-conn, #sec-keys, #sec-native-rdp, #sec-mirror, #sec-log, #fileRows) · /api/config.uiRoutes when present',
      preconditions: ['authenticated session'],
      action: 'Open the dashboard in the headed browser and verify each declared surface; count new console/page errors.',
      expectUi: 'every declared surface present, app shell still mounted, zero new page errors',
      expectServer: 'no new 4xx/5xx triggered by the render'
    },
    {
      id: 'nav.build_provenance', area: 'navigation', mandatory: true, evaluator: 'evalProvenance',
      requirement: 'The UI and backend rendered on the VM belong to the originating run\'s revision.',
      source: 'GET /api/version (GHRDP_BUILD_SHA) · meta#ghrdpBuild in the bundle',
      preconditions: ['descriptor appSha + uiBuild'],
      action: 'Compare the backend stamp and the page build stamp with the descriptor.',
      expectUi: 'provenance stamp equals the run\'s UI build',
      expectServer: '/api/version sha == origin head_sha'
    },
    {
      id: 'session.live_binding', area: 'session', mandatory: true, evaluator: 'evalLiveBinding',
      requirement: 'The dashboard is attached to THIS live instance (readiness contract satisfied from the client side).',
      source: 'GET /api/readiness · GET /api/progress',
      preconditions: [],
      action: 'Read readiness/progress from the client over the tailnet.',
      expectUi: 'health/connection surfaces show a live instance',
      expectServer: 'evaluateReadiness() == READY with the expected port'
    },
    {
      id: 'telemetry.live_stream', area: 'telemetry', mandatory: true, evaluator: 'evalTelemetryDelta',
      requirement: 'Live state must change over time; compare semantics and timestamps, not identical screenshots.',
      source: 'GET /api/progress snapshot shape',
      preconditions: [],
      action: 'Sample the progress snapshot twice ~6 s apart.',
      expectUi: 'counters/timestamps advance',
      expectServer: 'serverTs differs between samples and moves forward'
    },
    {
      id: 'connection.native_rdp_launch', area: 'rdp', mandatory: true, evaluator: 'evalRdpLaunch',
      requirement: 'The production ghrdp:// verb redeems a 60 s single-use ticket, stores the TERMSRV credential and opens mstsc with NO human input.',
      source: 'src/stores/sessionStore.ts fireAutoLogin · src/lib/domain/native.ts ghrdpRdpUrl · payloads/ghrdp-browser-helper.ps1 · ghrdp-rdp-launcher.cs',
      preconditions: ['ghrdp:// handler enrolled for this Windows account', 'ticket mintable'],
      action: 'Dispatch the identical verb the WINDOWS AUTO-LOGIN button produces.',
      expectUi: 'no credential prompt, no consent dialog, session appears',
      expectServer: '/api/logon-status: 4624 LogonType 10 for the intended account, sourceIp == client tailnet IP, inside the attempt window'
    },
    {
      id: 'connection.ticket_single_use', area: 'keys', mandatory: false, evaluator: 'evalTicketReplay',
      requirement: 'A redeemed ticket must not work twice.',
      source: 'Use-RdpTicket in payloads/ghrdp-server.ps1',
      preconditions: ['a fresh ticket'],
      action: 'Attempt a second redemption with the same ticket.',
      expectUi: 'n/a', expectServer: 'second POST /api/rdp-creds → 401'
    },
    {
      id: 'connection.credential_hygiene', area: 'keys', mandatory: true, evaluator: 'evalSecretHygiene',
      requirement: 'No plaintext credential in any artifact, annotation, report, Pages file or dispatch input.',
      source: 'lab policy + docs/check-artifact-privacy.mjs in the app',
      preconditions: ['evidence files written'],
      action: 'Scan every file this run wrote for the token/password values and for url-key/ticket shapes.',
      expectUi: 'n/a', expectServer: 'n/a'
    },
    {
      id: 'webdesktop.frames', area: 'web-desktop', mandatory: true, evaluator: 'evalWebDesktop',
      requirement: 'Fresh frames of the intended RDP session rendered in a real browser — not a placeholder, not a fixture.',
      source: 'GET /webdesk-status · GET /webdesk-frame · /webdesk img#view',
      preconditions: ['the web-desktop capture engine is running in the session'],
      action: 'Sample two frames ~5 s apart and read the rendered <img>.',
      expectUi: 'img#view naturalWidth>0 and decoded',
      expectServer: 'frameAgeMs<15000 on both samples and the two JPEGs differ'
    },
    {
      id: 'webdesktop.interaction', area: 'web-desktop', mandatory: false, evaluator: 'evalWebDesktopInput',
      requirement: 'Input reaches the session through a supported route.',
      source: 'the app\'s web-desktop input contract, if this build exposes one',
      preconditions: ['a supported input endpoint exists'],
      action: 'Drive the documented input control.',
      expectUi: 'the remote session reflects the input', expectServer: '2xx with a state token'
    },
    {
      id: 'files.list', area: 'files', mandatory: true, evaluator: 'evalFilesList',
      requirement: 'The Files view lists real server-side entries for this run, not a fixture.',
      source: 'GET /api/tree (docs/tree.json) or the app\'s index route',
      preconditions: [],
      action: 'Read the rendered rows and compare with the server-side count.',
      expectUi: 'rows render; count agrees with the API', expectServer: 'index endpoint answers 200 with the same count'
    },
    {
      id: 'files.fixture_roundtrip', area: 'files', mandatory: false, evaluator: 'evalFilesRoundtrip',
      requirement: 'A run-owned fixture written through a supported route appears in the index and is removable.',
      source: 'the app\'s staging contract (D:\\RDP-Storage)',
      preconditions: ['a run-owned scratch path'],
      action: 'Write `slab-live-<correlation>-fixture.txt`, verify, delete.',
      expectUi: 'row appears then disappears', expectServer: 'file exists then does not'
    },
    {
      id: 'search.lane', area: 'search', mandatory: 'conditional', evaluator: 'evalSearchLane',
      requirement: 'Search tab + transport lane are live iff the run enabled them; when disabled the feature is NOT_APPLICABLE with the flag named.',
      source: 'main.yml input search_enable (default true) · /api/launch-url',
      preconditions: ['per-run flag read from the server'],
      action: 'Open the search route and submit a benign query.',
      expectUi: 'surface present iff enabled; results or an explicit empty state',
      expectServer: 'the search route answers within its deadline'
    },
    {
      id: 'mirror.matrix', area: 'mirror', mandatory: 'conditional', evaluator: 'evalMirrorMatrix',
      requirement: 'The mirror host matrix reflects this run\'s mirror configuration, including an OFF state.',
      source: 'main.yml inputs mirror_enable/mirror_encrypt · /api/progress mirror fields',
      preconditions: [],
      action: 'Read the mirror card and compare with the server view.',
      expectUi: 'hosts/status render', expectServer: 'server reports the same enablement'
    },
    {
      id: 'keys.acl_view', area: 'keys', mandatory: true, evaluator: 'evalKeysMasked',
      requirement: 'Key/access surfaces show masked state only; no raw secret in the DOM.',
      source: '/api/config Get-CredsMask (last-4)',
      preconditions: ['authenticated page'],
      action: 'Read the page text and search for current-run secret values.',
      expectUi: 'masked shape, never the raw value', expectServer: 'n/a'
    },
    {
      id: 'health.readiness_contract', area: 'health', mandatory: true, evaluator: 'evalReadinessContract',
      requirement: 'Readiness must satisfy the documented contract in full; a partial answer is not ready.',
      source: 'GET /api/readiness',
      preconditions: [], action: 'Evaluate the contract from the client.',
      expectUi: 'health chip ready', expectServer: 'ok/status/phase/apiReadiness all consistent, pid>0, port expected'
    },
    {
      id: 'settings.read_modify_restore', area: 'settings', mandatory: false, evaluator: 'evalSettingsRestore',
      requirement: 'A UI setting change persists server-side and is restored by the run.',
      source: 'the app\'s settings/PUT contract (run-owned keys only)',
      preconditions: ['a benign reversible setting exists'],
      action: 'Read → flip → verify → restore → verify.',
      expectUi: 'control reflects each state', expectServer: 'persisted value changes then returns'
    },
    {
      id: 'errors.classified_not_spinner', area: 'errors', mandatory: true, evaluator: 'evalErrorSurface',
      requirement: 'A failure surfaces an actionable cause and settles; it never hides behind a spinner.',
      source: 'the app\'s gate/note paths (setAutoLoginNote etc.)',
      preconditions: ['a controllable failure'],
      action: 'Force a 401 from inside the page and observe the settled state.',
      expectUi: 'a reason is visible; no visible indeterminate loader afterwards', expectServer: '401 recorded, no retry storm'
    },
    {
      id: 'lifecycle.teardown', area: 'lifecycle', mandatory: false, evaluator: 'evalDestructive',
      requirement: 'Destructive lifecycle behaviour is verified only against explicitly disposable resources.',
      source: 'main.yml cleanup + finalize steps',
      preconditions: ['--allow-destructive with a disposable resource id'],
      action: 'Not attempted during an observation pass on the operator\'s live run.',
      expectUi: 'n/a', expectServer: 'n/a',
      notApplicableReason: 'observation pass — destructive lifecycle tests are reserved for a dedicated run against a disposable resource'
    }
  ];

  return defs.map(d => {
    const row = { ...d };
    if (d.mandatory === 'conditional') {
      const enabled = d.id === 'search.lane' ? flagOn(c.searchEnable) : d.id === 'mirror.matrix' ? flagOn(c.mirror) : true;
      row.mandatory = enabled;
      row.condition = { observed: enabled, flag: d.id };
    }
    if (d.notApplicableReason && !c.destructive) row.preconditionGap = d.notApplicableReason;
    return row;
  });
}

function summarizeInventory(rows, results) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, SKIPPED: 0, SIMULATED: 0 };
  const per = rows.map(r => {
    const res = results[r.id] || { status: 'NOT_RUN', reason: 'evaluator did not run', evidence: {} };
    if (counts[res.status] !== undefined) counts[res.status]++;
    return { id: r.id, area: r.area, mandatory: r.mandatory, status: res.status, reason: res.reason, evidence: res.evidence || {} };
  });
  const vetoing = per.filter(p => p.mandatory === true && p.status !== 'PASS');
  return {
    rows: per, counts, total: per.length,
    mandatoryTotal: per.filter(p => p.mandatory === true).length,
    mandatoryPass: per.filter(p => p.mandatory === true && p.status === 'PASS').length,
    vetoing: vetoing.map(v => v.id),
    accepted: vetoing.length === 0
  };
}

module.exports = { buildInventory, summarizeInventory };
