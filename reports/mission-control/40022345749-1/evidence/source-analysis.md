# Pinned application source analysis (read-only)

**Application tree:** `dictationb1/supreme-lamp` at `e432d3df4cf00a8528d574f8410f6a76e590db31`.

## Frontend-to-backend path

1. `src/hooks/useDashboardPolling.ts` polls `configUrl()` and `nativeStatusUrl()`; before F201 it used `getJson()` and collapsed unsuccessful fetches to `null`.
2. `src/lib/api.ts` targets the page origin when served on 7331/7332 or HTTPS. It requests `/api/config` and `/api/native-status`, including the dashboard token when present.
3. `src/stores/sessionStore.ts` holds config/native status. `src/components/domain/PrimaryActions.tsx` derives the auto-login gate and its text from FQDN/user, listener, DNS and status values.
4. In `payloads/ghrdp-server.ps1`, the `/api/native-status` route checks dashboard authorization, reads server-side config and Windows RDP certificate/NLA state, and adds collector state from local state files. The route also merges the Schannel window; on a cache miss `Get-F31cSchannelWindow` calls `Get-WinEvent` inline.
5. The PS server starts a raw `TcpListener`, writes its `LISTENING` sentinel, then executes three synchronous event-log scans before entering the request `AcceptTcpClient()` loop. This ordering can explain a TCP handshake without an HTTP reply if the observed socket belongs to this instance. The historical report did not preserve process-owner proof, so this remains a source-supported hypothesis, not a proven live root cause.

## F201 change and test boundary

The patch adds a typed per-probe state (`pending`, `ok`, and named failure classes), records the result of config/native-status polls, and prevents UI copy from turning “no answer yet” into a claim about credentials, DNS, or the listener. It does not weaken auth, create healthy values, enable auto-login on an untrusted response, or change server endpoints.

Local tests establish the intended component-level behavior and production bundle compilation only. They do not execute the PowerShell server or browser network path.

## Live signal / harness compatibility

The checked-out lab `scripts/lib/live-signal.js` parses `MC-SIGNAL v1` from the check-run summary. The supplied check run publishes a fenced `mc-signal/v1` document in `output.text`, with a different hybrid-envelope schema. `scripts/lib/origin-discovery.js` only passes the summary to the old parser. That mismatch prevents the automatic reader on this branch from attaching the app signal. PR #26 has a proposed reader implementation, but it is not present on this branch and was not ported in this update; exact envelope freshness and authenticated access remain unverified.
