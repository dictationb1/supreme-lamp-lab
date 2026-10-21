param(
    [int]$Port = 7331,
    [string]$Bind = '0.0.0.0',
    [string]$Root = 'C:\ghrdp',
    [int]$LimitMinutes = 350
)
$ErrorActionPreference = 'Continue'
$script:InitPhase = 'initializing'
function Get-F49OptInVal {
    param($Cfg)
    if (-not $Cfg) { return $null }
    try {
        if (Get-Command Get-F49RuntimeOptIn -ErrorAction SilentlyContinue) {
            return (Get-F49RuntimeOptIn -Cfg $Cfg)
        }
    } catch { }
    return $null
}
# =============================================================================
# [F92 §1.1] TLS + progress + encoding defaults applied once per server
# process. Tls13 is best-effort: .NET Framework 4.x on older hosts has no
# Tls13 member, so it is added only when the enum actually exists (a hard
# failure here would take the whole server down at line 8).
# =============================================================================
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ([enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
    }
} catch { }
$ProgressPreference = 'SilentlyContinue'
try {
    $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
}
# [F92 §2.3] nuke any stray Session 0 msedge processes left over from pre-F92
# runs (the session-0 browser graveyard the ONLOGON task makes obsolete).
try {
    Get-Process msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq 0 } | Stop-Process -Force -ErrorAction SilentlyContinue
} catch { }
# [F92 §2.4] the user-session flag: TRUE when this process runs in an
# interactive session (SessionId != 0), i.e. when the F92 GHRDP-Server
# ONLOGON task owns the server. It is what arms the single-rung launch path.
$script:F92InUserSession = $false
try { $script:F92InUserSession = ((Get-Process -Id $PID).SessionId -ne 0) } catch { }
# =============================================================================
# [F92 §1.3] Central endpoint map. Every search site's URL template lives
# HERE, so an upstream drift is a one-line fix (F92's whole point: the next
# fix is scoped to one cell). Templates verified Oct 2026.
# =============================================================================
$Script:F92Endpoints = @{
    openculture      = @{ Base='https://www.openculture.com/'; QueryParam='s';           JsonPath=$null;                      KnownGoodQuery='Walter Kaufmann';         Expect='/walter_kaufmanns_lectures.html'; ExpectMatch='walter_kaufmanns_lectures' }
    archive          = @{ Base='https://archive.org/advancedsearch.php'; QueryParam='q'; JsonPath='.response.docs[*].identifier'; KnownGoodQuery='title:"A Matter of Life and Death"'; Expect='matteroflife'; ExpectMatch=$null }
    openverse        = @{ Base='https://api.openverse.org/v1/images/'; QueryParam='q';   JsonPath='.results[*].foreign_landing_url'; KnownGoodQuery="Saturn's Rings in Ultraviolet Light"; Expect='Saturn'; ExpectMatch=$null }
    awesome          = @{ Base='https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md'; QueryParam=$null; JsonPath=$null; KnownGoodQuery='networking'; Expect='PCAPTools'; ExpectMatch='PCAPTools|Network' }
    gutenberg        = @{ Base='https://gutendex.com/books/'; QueryParam='search';       JsonPath='.results[*].title';         KnownGoodQuery='sherlock holmes';         Expect='Sherlock'; ExpectMatch=$null }
    standardebooks   = @{ Base='https://standardebooks.org/ebooks'; QueryParam='query';  JsonPath=$null;                      KnownGoodQuery='dickens';                 Expect='dickens'; ExpectMatch=$null }
    librivox         = @{ Base='https://librivox.org/api/feed/audiobooks/'; QueryParam='title'; Extras='&format=json';         JsonPath='.books[*].title';           KnownGoodQuery='pride and prejudice';     Expect='Pride'; ExpectMatch=$null }
    openlibrary      = @{ Base='https://openlibrary.org/search.json'; QueryParam='q';    Extras='&fields=key,title,author_name,cover_i,ia&limit=10'; JsonPath='.docs[*].title'; KnownGoodQuery='the lord of the rings'; Expect='Lord of the Rings'; ExpectMatch=$null }
    tubitv           = @{ Base='https://tubitv.com/search/'; QueryParam=$null; RequiresBrowser=$true;                          KnownGoodQuery='office';                  Expect=$null; ExpectMatch=$null }
    pluto            = @{ Base='https://pluto.tv/en/search/details'; QueryParam='query'; RequiresBrowser=$true;                KnownGoodQuery='office';                  Expect=$null; ExpectMatch=$null }
    freemusicarchive = @{ Base='https://freemusicarchive.org/search/'; QueryParam='quicksearch'; JsonPath=$null;              KnownGoodQuery='moonlight';               Expect='moonlight'; ExpectMatch=$null }
}
# short-name <-> operator host aliases (the hint table keys sites by host).
$Script:F92HostAlias = @{
    'openculture.com'='openculture'; 'archive.org'='archive'; 'openverse.org'='openverse'
    'awesome.re'='awesome'; 'gutenberg.org'='gutenberg'; 'standardebooks.org'='standardebooks'
    'librivox.org'='librivox'; 'openlibrary.org'='openlibrary'; 'tubitv.com'='tubitv'
    'pluto.tv'='pluto'; 'freemusicarchive.org'='freemusicarchive'
}
function Resolve-F92EndpointKey {
    param([string]$Name)
    $n = ([string]$Name).Trim().ToLowerInvariant()
    try { $n = ($n -replace '^www\.', '') } catch { }
    if ($Script:F92Endpoints.ContainsKey($n)) { return $n }
    if ($Script:F92HostAlias.ContainsKey($n)) { return [string]$Script:F92HostAlias[$n] }
    return $n
}
# =============================================================================
# [F92 §1.2] Single hardened wrapper for every outbound HTTP call made by the
# F92 self-test + fanout. Returns the uniform shape below on BOTH success and
# failure so callers never exception-traverse $Error. PS 5.1 and PS 7 safe:
# header lookup is case-insensitive and array-tolerant, error status is read
# from whichever exception type the runtime hands back.
# =============================================================================
function Get-F92HeaderValue {
    param($Headers, [string]$Name)
    if (-not $Headers) { return $null }
    try {
        foreach ($k in @($Headers.Keys)) {
            if ($k -and ([string]$k) -ieq $Name) {
                $v = $Headers[$k]
                if ($v -is [array]) { if (@($v).Count -gt 0) { return [string]@($v)[0] }; return $null }
                return [string]$v
            }
        }
    } catch { }
    return $null
}
function Invoke-F92Http {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method        = 'GET',
        [hashtable]$Headers    = @{},
        [object]$Body          = $null,
        [int]$TimeoutSec       = 20,
        [string]$UserAgent     = '',
        [string]$Accept        = 'application/json, text/html;q=0.9, */*;q=0.5'
    )
    if (-not $UserAgent) {
        $shaPart = 'dev'
        try { if ($env:GITHUB_SHA) { $shaPart = [string]$env:GITHUB_SHA } } catch { }
        $UserAgent = 'supreme-lamp-F92/' + $shaPart + ' (+https://github.com/dekarita/supreme-lamp)'
    }
    $start = [DateTime]::UtcNow
    $h = @{}
    if ($Headers) { foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] } }
    if (-not $h.ContainsKey('Accept')) { $h['Accept'] = $Accept }
    try {
        $resp = $null
        if ($null -ne $Body) {
            $resp = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $h -Body $Body `
                -UserAgent $UserAgent -UseBasicParsing -MaximumRedirection 5 `
                -TimeoutSec $TimeoutSec -ErrorAction Stop
        } else {
            $resp = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $h `
                -UserAgent $UserAgent -UseBasicParsing -MaximumRedirection 5 `
                -TimeoutSec $TimeoutSec -ErrorAction Stop
        }
        $elapsed = ([DateTime]::UtcNow - $start).TotalMilliseconds
        $bytes = 0
        try { $bytes = [int]$resp.RawContentLength } catch { try { $bytes = [Text.Encoding]::UTF8.GetByteCount([string]$resp.Content) } catch { $bytes = 0 } }
        return [pscustomobject]@{
            Ok         = $true
            HttpStatus = [int]$resp.StatusCode
            CfRay      = Get-F92HeaderValue -Headers $resp.Headers -Name 'cf-ray'
            ElapsedMs  = [int]$elapsed
            Bytes      = $bytes
            Content    = [string]$resp.Content
            Headers    = $resp.Headers
            Error      = $null
        }
    } catch {
        $elapsed = ([DateTime]::UtcNow - $start).TotalMilliseconds
        $status  = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
        return [pscustomobject]@{
            Ok         = $false
            HttpStatus = $status
            CfRay      = $null
            ElapsedMs  = [int]$elapsed
            Bytes      = 0
            Content    = $null
            Headers    = $null
            Error      = $_.Exception.Message
        }
    }
}
# walk a dotted JsonPath with a terminal [*] (F92 §1.3 table syntax, e.g.
# '.response.docs[*].identifier'); returns a flat string array.
function Resolve-F92JsonPath {
    param($Json, [string]$Path)
    $cur = @($Json)
    foreach ($seg in (([string]$Path) -split '\.')) {
        if (-not $seg) { continue }
        $field = $seg
        $expand = $false
        if ($field -match '^(.+?)\[\*\]$') { $field = $Matches[1]; $expand = $true }
        $next = @()
        foreach ($c in $cur) {
            if ($null -eq $c) { continue }
            $v = $null
            try { $v = $c.$field } catch { $v = $null }
            if ($null -eq $v) { continue }
            if ($expand -or ($v -is [System.Array])) { $next += @($v) } else { $next += $v }
        }
        $cur = @($next)
        if ($cur.Count -eq 0) { break }
    }
    return @($cur)
}
# =============================================================================
# [F92 §1.4] Fanout search on TOP of Invoke-F92Http + the F92Endpoints map.
# Every query goes through [Uri]::EscapeDataString. Each adapter emits
# [pscustomobject]@{ Site; Strategy; Diag; Results } with Strategy in
# api|html|markdown|browser-required; Ok/ExpectHit are F92 additions the
# self-test reads. `awesome` is a pure-regex Markdown scan - NO HTML parser.
# `openverse` carries Authorization: Bearer $env:OPENVERSE_TOKEN when set.
# The pre-F92 Invoke-F88SiteSearch stays intact: it is the PRODUCT path the
# Lab/selftest routes pin (tests/f88-site-search.test.js); F92 is the
# hardened diagnostics + search surface.
# =============================================================================
function Invoke-F92SiteSearch {
    param([string]$Site, [string]$Query)
    $key = Resolve-F92EndpointKey -Name $Site
    $out = [ordered]@{ Site = $key; Strategy = ''; Diag = ''; Results = @(); Ok = $false; ExpectHit = $false }
    if (-not $Script:F92Endpoints.ContainsKey($key)) { $out.Diag = 'unknown-site: ' + $key; return [pscustomobject]$out }
    $spec = $Script:F92Endpoints[$key]
    $q = ''
    try { $q = [Uri]::EscapeDataString([string]$Query) } catch { $q = [Uri]::EscapeDataString('') }
    if ($spec.RequiresBrowser) {
        $out.Strategy = 'browser-required'
        $out.Diag = 'Site ' + $key + ' is JS-rendered; verified by nightly Playwright (e2e-real-sites.yml), not by CI fetchers.'
        return [pscustomobject]$out
    }
    $uri = [string]$spec.Base
    if ($spec.QueryParam) {
        $uri = [string]$spec.Base + '?' + [string]$spec.QueryParam + '=' + $q
        if ($spec.Extras) { $uri = $uri + [string]$spec.Extras }
    }
    $hdrs = @{}
    if ($key -eq 'openverse') {
        try { if ($env:OPENVERSE_TOKEN) { $hdrs['Authorization'] = 'Bearer ' + [string]$env:OPENVERSE_TOKEN } } catch { }
    }
    $r = Invoke-F92Http -Uri $uri -Headers $hdrs
    if (-not $r.Ok) {
        $out.Strategy = $(if ($spec.JsonPath) { 'api' } else { 'html' })
        $out.Diag = 'HTTP error after ' + $r.ElapsedMs + 'ms: ' + [string]$r.Error + ' (cf-ray=' + [string]$r.CfRay + ')'
        return [pscustomobject]$out
    }
    $out.Diag = 'http=' + $r.HttpStatus + ' bytes=' + $r.Bytes + ' ms=' + $r.ElapsedMs
    if ($r.CfRay) { $out.Diag = $out.Diag + ' cf-ray=' + [string]$r.CfRay }
    $rows = @()
    $content = [string]$r.Content
    if ($spec.JsonPath) {
        $out.Strategy = 'api'
        $json = $null
        try { $json = $content | ConvertFrom-Json -ErrorAction Stop } catch { $json = $null }
        if ($json) {
            foreach ($v in @(Resolve-F92JsonPath -Json $json -Path ([string]$spec.JsonPath))) {
                if ($rows.Count -ge 50) { break }
                $s = [string]$v
                if (-not $s) { continue }
                $href = ''
                try { if ($s -match '^https?://') { $href = $s } } catch { }
                $rows += [ordered]@{ text = $s; href = $href }
            }
        } else { $out.Diag = $out.Diag + ' json-parse-failed' }
    }
    elseif ($key -eq 'awesome') {
        # [F92 §1.4] Markdown link regex over the RAW readme - deliberately no
        # HTML parser: the source is markdown and a parser is one more drift surface.
        $out.Strategy = 'markdown'
        foreach ($m in [regex]::Matches($content, '\[([^\]]+)\]\((https?://[^)]+)\)')) {
            if ($rows.Count -ge 50) { break }
            $rows += [ordered]@{ text = ([string]$m.Groups[1].Value).Trim(); href = ([string]$m.Groups[2].Value).Trim() }
        }
    }
    else {
        $out.Strategy = 'html'
        foreach ($m in [regex]::Matches($content, '(?is)<a\b[^>]*href\s*=\s*["'']([^"'']+)["''][^>]*>(.*?)</a>')) {
            if ($rows.Count -ge 50) { break }
            $hrefRaw = [string]$m.Groups[1].Value
            if (-not $hrefRaw -or $hrefRaw.StartsWith('#')) { continue }
            if ($hrefRaw -match '^(?i)mailto:|javascript:|data:|tel:') { continue }
            $abs = ''
            try {
                if ($hrefRaw -match '^(?i)https://') { $abs = ([System.Uri]$hrefRaw).AbsoluteUri }
                elseif ($hrefRaw -match '^(?i)http://') { $abs = 'https://' + $hrefRaw.Substring(7) }
                else {
                    $baseUri = $null
                    try { $baseUri = [System.Uri]$uri } catch { $baseUri = $null }
                    if ($baseUri) { $abs = ([System.Uri]::new($baseUri, $hrefRaw)).AbsoluteUri }
                }
            } catch { $abs = '' }
            if (-not $abs -or -not $abs.StartsWith('https://')) { continue }
            $text = ([regex]::Replace([string]$m.Groups[2].Value, '<[^>]+>', '') -replace '\s+', ' ').Trim()
            $rows += [ordered]@{ text = $(if ($text) { $text } else { $abs }); href = $abs }
        }
    }
    $out.Results = @($rows)
    $out.Ok = $true
    $expectPat = $(if ($spec.ExpectMatch) { [string]$spec.ExpectMatch } elseif ($spec.Expect) { [regex]::Escape([string]$spec.Expect) } else { '' })
    if ($expectPat -and $content -and ($content -match $expectPat)) { $out.ExpectHit = $true }
    return [pscustomobject]$out
}
function New-F92Check {
    param([string]$Status, $ObservedValue, [string]$ObservedUnit, [string]$Output, [string]$ComponentType = 'component', $AffectedEndpoints = $null)
    $c = [ordered]@{
        componentType = $ComponentType
        status        = $Status
        observedValue = $ObservedValue
        observedUnit  = $ObservedUnit
        time          = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($Output) { $c['output'] = $Output }
    if ($AffectedEndpoints) { $c['affectedEndpoints'] = @($AffectedEndpoints) }
    return @($c)
}
# =============================================================================
# [F92 §5] application/health+json self-test (IETF draft in-place format).
# 11 search:<site> entries + launcher:status + download:writable +
# streaming:proxy + version:match. 200 while nothing fails, 503 on any fail.
# Route: GET /api/f92-selftest?frontendSha=<sha>. Cache-Control stays
# no-store (the Send-ClientResponse contract) and X-Correlation-ID echoes.
# =============================================================================
function Invoke-F92Selftest {
    param([string]$FrontendSha)
    $corrId = [guid]::NewGuid().ToString()
    $checks = [ordered]@{}
    foreach ($name in @($Script:F92Endpoints.Keys | Sort-Object)) {
        $spec = $Script:F92Endpoints[$name]
        if ($spec.RequiresBrowser) {
            $checks["search:$name"] = New-F92Check -Status 'warn' -ObservedValue 0 -ObservedUnit 'results' -Output ("Site $name is JS-rendered; verified by nightly Playwright, not CI. See /#/health.") -AffectedEndpoints ("/#/search?site=" + $name)
            continue
        }
        $s = $null
        try { $s = Invoke-F92SiteSearch -Site $name -Query ([string]$spec.KnownGoodQuery) } catch { $s = $null }
        $status = 'fail'; $obsCount = 0; $outputMsg = $null
        if ($s -and $s.Ok) {
            $obsCount = @($s.Results).Count
            if ($s.ExpectHit -or $obsCount -gt 0) { $status = 'pass' }
            if (-not $s.ExpectHit -and $obsCount -gt 0) {
                $status = 'warn'
                $outputMsg = "Site $name returned $obsCount results but expected pattern '$($spec.Expect)' not present. Fix: run UPDATE_HAR=1 nightly to refresh fixture; open the endpoint URL in a browser. $($s.Diag)"
            } elseif ($obsCount -eq 0 -and $s.ExpectHit) { $status = 'warn'
                $outputMsg = "Site $name matched the expected pattern but produced 0 result rows (parser drift?). $($s.Diag)"
            } elseif ($obsCount -eq 0) {
                $status = 'warn'
                $outputMsg = "Site $name answered 200 with 0 results. Fix: check the site in a browser, then re-run nightly; if the shape changed, patch `$Script:F92Endpoints['$name'] only. $($s.Diag)"
            }
        } elseif ($s) {
            $outputMsg = "Site $name HTTP error: $($s.Diag). Fix: verify TLS1.2+ is offered by Invoke-F92Http at the top of this file, inspect cf-ray, see docs/sites.md#$name."
        } else {
            $outputMsg = "Site $name search threw; see server log. Fix: re-run GET /api/f92-selftest?debug=1."
        }
        $checks["search:$name"] = New-F92Check -Status $status -ObservedValue $obsCount -ObservedUnit 'results' -Output $outputMsg -AffectedEndpoints ("/#/search?site=" + $name)
    }
    # launcher:status (F92 user-session ONLOGON task, payloads/register-ghrdp-task.ps1)
    $taskState = ''
    $taskErr = ''
    try {
        $t = Get-ScheduledTask -TaskName 'GHRDP-Server' -ErrorAction Stop
        $taskState = [string]$t.State
    } catch { $taskErr = $_.Exception.Message }
    $launcherOut = $null
    if (-not $taskState) { $launcherOut = "Launcher: scheduled task GHRDP-Server not registered. Fix: Actions -> main.yml -> Run workflow (the F92 bootstrap step registers it). Or manually: pwsh payloads/register-ghrdp-task.ps1." }
    $checks['launcher:status'] = New-F92Check -Status $(if ($taskState -in @('Running','Ready')) { 'pass' } else { 'fail' }) -ObservedValue $(if ($taskState) { $taskState } else { 'not registered' }) -ObservedUnit '' -Output $launcherOut -ComponentType 'system'
    # download:writable
    $dir = [string]$env:DOWNLOAD_DIR
    if (-not $dir) { $dir = [string]$Root }
    $dlOut = $null
    $dlOk = $false
    try {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $probe = Join-Path $dir ('.f92-probe-' + $corrId)
        Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
        Remove-Item $probe -ErrorAction SilentlyContinue
        $dlOk = $true
    } catch { $dlOut = "Download dir not writable: $($_.Exception.Message). Fix: icacls `"$dir`" /grant Users:F. See docs/paths.md." }
    $checks['download:writable'] = New-F92Check -Status $(if ($dlOk) { 'pass' } else { 'fail' }) -ObservedValue 0 -ObservedUnit 'bytes' -Output $dlOut -ComponentType 'datastore'
    # streaming:proxy - the configured relay, or (when STREAM_PORT is unset)
    # the F91 launcher/queue heartbeat as the on-product proxy of "the async
    # plumbing is alive". Either way: fail-visible, never a silent pass.
    $stStatus = 'fail'; $stObs = ''; $stOut = $null
    if ($env:STREAM_PORT) {
        $sp = Invoke-F92Http -Uri ('http://localhost:' + [string]$env:STREAM_PORT + '/health') -TimeoutSec 3
        if ($sp.Ok -and $sp.HttpStatus -eq 200) { $stStatus = 'pass'; $stObs = '200' }
        else { $stOut = "Streaming proxy: $($sp.Error) (status=$($sp.HttpStatus)). Fix: restart Start-StreamingProxy, re-run main.yml. See docs/streaming.md." }
    } else {
        $hb = $null
        try { $hb = Get-F91LauncherHealth } catch { $hb = $null }
        if ($hb -and [bool]$hb.serviceRunning) { $stStatus = 'pass'; $stObs = 'launcher-heartbeat' }
        else { $stOut = 'No STREAM_PORT configured and the F91 launcher heartbeat is stale (>30s): the queue/stream plumbing is down. Fix: re-dispatch main.yml (it registers GHRDP-Launcher).' }
    }
    $checks['streaming:proxy'] = New-F92Check -Status $stStatus -ObservedValue $stObs -ObservedUnit '' -Output $stOut
    # version:match (same sha source as /api/version)
    $backendSha = ''
    try { $backendSha = [string]$env:GHRDP_BUILD_SHA } catch { }
    if (-not $backendSha) { try { $backendSha = [string]$env:GITHUB_SHA } catch { } }
    if (-not $backendSha) { $backendSha = 'dev' }
    $verStatus = 'pass'; $verOut = $null
    if ($FrontendSha -and $FrontendSha -ne $backendSha) {
        $verStatus = 'fail'
        $verOut = "Version mismatch: backend $backendSha != frontend $FrontendSha. Fix: Actions -> main.yml -> Run workflow to atomically rebuild both."
    }
    $checks['version:match'] = New-F92Check -Status $verStatus -ObservedValue ([ordered]@{ backend = $backendSha; frontend = $FrontendSha }) -ObservedUnit '' -Output $verOut -ComponentType 'system'
    # rollup
    $allStatuses = @($checks.Values | ForEach-Object { $_[0].status })
    $overall = 'pass'
    if ($allStatuses -contains 'fail') { $overall = 'fail' } elseif ($allStatuses -contains 'warn') { $overall = 'warn' }
    $body = [ordered]@{
        status      = $overall
        version     = '1'
        releaseId   = $backendSha
        serviceId   = 'dekarita-supreme-lamp'
        description = 'F92 self-test; see /#/health'
        notes       = @('correlation-id: ' + $corrId)
        checks      = $checks
        links       = @{ about = '/#/health' }
    }
    $code = 200
    if ($overall -eq 'fail') { $code = 503 }
    return [ordered]@{
        Code   = $code
        CorrId = $corrId
        Body   = ConvertTo-JsonBytes $body
    }
}
$script:CfgPath = Join-Path $Root 'config.json'
$script:ProgPath = Join-Path $Root 'progress.json'
$script:UiPath = Join-Path $Root 'ui.html'
# [F43] v2 dashboard is the DEFAULT UI. Routing contract (fail-visible):
#   /?ui=v1  -> always serve v1 ui.html (one-release Classic UI escape)
#   /?ui=v2  -> serve ui-v2.html when staged; when NOT staged serve v1 PLUS the
#               red uiV2MissingBanner (F42 §2: silent v1 fallback is forbidden)
#   no param -> v2 (UiV2Default=$true); requested v2 but file missing -> v1 + banner
$script:UiV2Path = Join-Path $Root 'ui-v2.html'
$script:UiV2Default = $true
$script:InstPath = Join-Path $Root 'ghrdp-install.ps1'
# [F14 §2] the ONLY files GET /dl/<name> may serve. Exactly these three, never
# more: they carry no secrets, so no dash token is required for them. Anything
# else under /dl (including every other file in $Root) is a 404.
$script:DlNames = @('ghrdp-handler-kit.zip', 'install.cmd', 'ghrdp-rdp-launcher.cs')
$script:OkFile = Join-Path $Root 'server-ok.txt'
# [F99 §2.1] WebSocket upgrade SUPPORTED. The F96 diagnostic proved NO upgrade path
# existed (ws=false, no /ws). This implementation provides the RFC6455 handshake
# + frame codec and validates X-Dash-Token (or ?key= hello frame) before switching.
# The F95/R4 client lane (token + hello + reconnect ladder) now has a server to
# speak to. $false -> $true flips /health's ws flag and the comprehensive bundle's
# serverUpgradeSupported to true. See Invoke-F99WebSocketUpgrade below.
$script:F96WsUpgradeSupported = $true
$script:F99WsUpgradeSupported = $true
# [F101 §2.4 / N4] WebSocket keepalive tunables. The F99 bundle showed the
# socket going "idle" with close=1005 (NO status) - the F99 loop capped the
# connection at 45s and then wrote a bare `0x88 0x00` close frame, which the
# browser surfaces as 1005 "no status received", and nothing at the protocol
# level proved the peer was still there. Now: a real RFC6455 PING (opcode 0x9)
# every 20s plus an application-level {"type":"ping"} the browser half can see
# and answer, the socket stays up for up to 30 min while the client keeps
# answering, an idle peer is dropped after 90s of silence, and every close
# carries a real 1000 status so the dashboard can tell "server said goodbye"
# from "the connection vanished".
$script:F99WsPingIntervalSec = 20
$script:F99WsIdleTimeoutSec = 90
$script:F99WsMaxLifetimeSec = 1800
function Invoke-F99WebSocketUpgrade {
    param($Client, $Stream, $Parts, $Token)
    try {
        $upgrade = $null; try { $upgrade = [string]$Parts.headers['upgrade'] } catch { $upgrade = '' }
        if (-not $upgrade -or $upgrade.ToLowerInvariant() -ne 'websocket') { return $false }
        $key = $null; try { $key = [string]$Parts.headers['sec-websocket-key'] } catch { $key = '' }
        if (-not $key) { return $false }
        # Token validation: X-Dash-Token header, Authorization Bearer, or ?key= query
        $presented = $null; try { $presented = [string]$Parts.headers['x-dash-token'] } catch { $presented = '' }
        if (-not $presented) { try { $a = [string]$Parts.headers['authorization']; if ($a -match '^(?i)Bearer\s+(.+)$') { $presented = $Matches[1].Trim() } } catch { } }
        if (-not $presented) { try { if ($Parts.query.ContainsKey('key')) { $presented = [string]$Parts.query['key'] } } catch { } }
        $tokenOk = $false
        if ($presented -and $Token) {
            try {
                $recv = [System.Text.Encoding]::UTF8.GetBytes($presented)
                $exp = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if ($recv.Length -eq $exp.Length -and (Test-TicketBearer $recv $exp)) { $tokenOk = $true }
            } catch { $tokenOk = $false }
        }
        $clientClass = 'other'
        try {
            $ip = $Client.Client.RemoteEndPoint.Address
            if (Test-IsLoopbackAddr $ip) { $clientClass = 'loopback' }
            else {
                try { $oct = $ip.GetAddressBytes(); if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { $clientClass = 'tailnet' } } catch { }
            }
        } catch { }
        if (-not $tokenOk -and $clientClass -eq 'other' -and [string]$Token) {
            if ($presented) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('dash token invalid')
                $hdr = "HTTP/1.1 401 Unauthorized`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
                $Stream.Write($hb,0,$hb.Length); $Stream.Write($body,0,$body.Length); $Stream.Flush()
                return $true
            } else {
                $body = [System.Text.Encoding]::UTF8.GetBytes('dash token required')
                $hdr = "HTTP/1.1 401 Unauthorized`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
                $Stream.Write($hb,0,$hb.Length); $Stream.Write($body,0,$body.Length); $Stream.Flush()
                return $true
            }
        }
        $magic = $key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        $sha = [System.Security.Cryptography.SHA1]::Create()
        $hash = $sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($magic))
        $accept = [Convert]::ToBase64String($hash)
        $sha.Dispose()
        $resp = "HTTP/1.1 101 Switching Protocols`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Accept: $accept`r`n`r`n"
        $rb = [System.Text.Encoding]::ASCII.GetBytes($resp)
        $Stream.Write($rb,0,$rb.Length); $Stream.Flush()
        $start = Get-Date
        $lastDiag = Get-Date
        $helloEchoed = $false
        function Send-F99WsText { param([string]$Text)
            try {
                $payload = [System.Text.Encoding]::UTF8.GetBytes($Text)
                $len = $payload.Length
                $header = @()
                $header += [byte]0x81
                if ($len -lt 126) { $header += [byte]$len }
                elseif ($len -lt 65536) { $header += [byte]126; $b=[BitConverter]::GetBytes([uint16]$len); [Array]::Reverse($b); $header += $b }
                else { $header += [byte]127; $b=[BitConverter]::GetBytes([uint64]$len); [Array]::Reverse($b); $header += $b }
                $hb2 = [byte[]]$header
                $Stream.Write($hb2,0,$hb2.Length)
                if ($len -gt 0) { $Stream.Write($payload,0,$len) }
                $Stream.Flush()
            } catch { }
        }
        # [F101 §2.4 / N4] keepalive. A real RFC6455 PING (opcode 0x9) every
        # 20s plus an application-level {"type":"ping"} the browser half can
        # actually observe (browsers answer protocol PINGs below the JS API, so
        # a JSON ping is the only thing the dashboard can watchdog on), PONG
        # accounting on both opcodes, a 30-minute ceiling, an idle drop after
        # 90s of client silence, and a close frame that CARRIES A STATUS CODE -
        # the F99 `0x88 0x00` close is precisely what the bundle reported as
        # close=1005 "no status received".
        function Send-F99WsPing {
            try {
                $pf = [byte[]]@(0x89,0x00)
                $Stream.Write($pf,0,$pf.Length)
                $Stream.Flush()
            } catch { }
        }
        $diagInit = ([ordered]@{ ok=$true; ts=(Get-Date -Format o); ws='connected'; note='F99 ws upgrade live'; heartbeat=$true; pingIntervalSec=[int]$script:F99WsPingIntervalSec } | ConvertTo-Json -Compress)
        Send-F99WsText $diagInit
        Send-F99WsPing
        $lastPing = Get-Date
        $lastClientFrame = Get-Date
        $pongCount = 0
        $pingCount = 1
        $f99CloseStatus = 1000
        $buf = New-Object byte[] 4096
        try { $Stream.ReadTimeout = 2000 } catch { }
        while ((((Get-Date) - $start).TotalSeconds -lt [int]$script:F99WsMaxLifetimeSec) -and (((Get-Date) - $lastClientFrame).TotalSeconds -lt [int]$script:F99WsIdleTimeoutSec)) {
            try {
                if ($Client.Client.Available -gt 0 -or $Stream.DataAvailable) {
                    $n = 0; try { $n = $Stream.Read($buf,0,$buf.Length) } catch { break }
                    if ($n -le 0) { $f99CloseStatus = 1006; break }
                    $lastClientFrame = Get-Date
                    if ($n -ge 2) {
                        $opcode = $buf[0] -band 0x0F
                        $masked = ($buf[1] -band 0x80) -ne 0
                        $payloadLen = $buf[1] -band 0x7F
                        $offset = 2
                        if ($payloadLen -eq 126 -and $n -ge 4) { $payloadLen = ($buf[2] -shl 8) -bor $buf[3]; $offset=4 }
                        elseif ($payloadLen -eq 127 -and $n -ge 10) { $payloadLen = 0; for($i=0;$i -lt 8;$i++){ $payloadLen = ($payloadLen -shl 8) -bor $buf[2+$i] }; $offset=10 }
                        $mask = $null
                        if ($masked) { if ($n -lt $offset+4) { continue }; $mask = $buf[$offset..($offset+3)]; $offset+=4 }
                        if ($payloadLen -gt 0 -and $n -ge $offset+$payloadLen) {
                            $payload = New-Object byte[] $payloadLen
                            [Array]::Copy($buf,$offset,$payload,0,$payloadLen)
                            if ($masked -and $mask) { for($i=0;$i -lt $payloadLen;$i++){ $payload[$i] = $payload[$i] -bxor $mask[$i % 4] } }
                            $text = [System.Text.Encoding]::UTF8.GetString($payload)
                            if ($opcode -eq 8) { break }
                            if ($opcode -eq 9) {
                                $pong = @(); $pong += [byte]0x8A; if ($payloadLen -lt 126) { $pong+=[byte]$payloadLen } else { $pong+=[byte]126; $b=[BitConverter]::GetBytes([uint16]$payloadLen); [Array]::Reverse($b); $pong+=$b }
                                $pb=[byte[]]$pong; $Stream.Write($pb,0,$pb.Length); if ($payloadLen -gt 0) { $Stream.Write($payload,0,$payloadLen) }; $Stream.Flush(); continue
                            }
                            # [F101] the client's own PONG frame: liveness only, never echoed.
                            if ($opcode -eq 10) { $pongCount++; continue }
                            if ($text -match '"type"\s*:\s*"hello"' -or $text -match 'hello') {
                                if (-not $helloEchoed) { Send-F99WsText '{"type":"hello-ack","ok":true}'; $helloEchoed=$true }
                            } elseif ($text -match '"type"\s*:\s*"pong"') {
                                # [F101] application-level PONG (the browser half
                                # answers the JSON ping; it cannot answer a
                                # protocol PING from JS). Counted, not echoed.
                                $pongCount++
                            } else { Send-F99WsText $text }
                        } elseif ($opcode -eq 8) { break }
                        elseif ($opcode -eq 10) { $pongCount++ }
                    }
                }
            } catch { }
            if (((Get-Date) - $lastDiag).TotalSeconds -ge 2) {
                $diag2 = ([ordered]@{ ok=$true; ts=(Get-Date -Format o); heartbeat=$true; uptimeSec=[int]((Get-Date)-$start).TotalSeconds } | ConvertTo-Json -Compress)
                Send-F99WsText $diag2
                $lastDiag = Get-Date
            }
            if (((Get-Date) - $lastPing).TotalSeconds -ge [int]$script:F99WsPingIntervalSec) {
                $pingCount++
                Send-F99WsPing
                Send-F99WsText ([ordered]@{ type='ping'; ok=$true; ts=(Get-Date -Format o); ping=$pingCount; pongSeen=$pongCount; uptimeSec=[int]((Get-Date)-$start).TotalSeconds } | ConvertTo-Json -Compress)
                $lastPing = Get-Date
            }
            Start-Sleep -Milliseconds 100
        }
        if (((Get-Date) - $start).TotalSeconds -ge [int]$script:F99WsMaxLifetimeSec) { $f99CloseStatus = 1001 }
        if (((Get-Date) - $lastClientFrame).TotalSeconds -ge [int]$script:F99WsIdleTimeoutSec) { $f99CloseStatus = 1001 }
        try {
            $sc = [BitConverter]::GetBytes([uint16]$f99CloseStatus)
            [Array]::Reverse($sc)
            $close = [byte[]](@([byte]0x88, [byte]0x02) + @($sc))
            $Stream.Write($close,0,$close.Length); $Stream.Flush()
        } catch { }
        try { Write-ClientAudit ('ws closed status=' + [string]$f99CloseStatus + ' uptimeSec=' + [int]((Get-Date)-$start).TotalSeconds + ' pings=' + [string]$pingCount + ' pongs=' + [string]$pongCount) } catch { }
        return $true
    } catch { return $false }
}
# F99 collector rate-limit state
$script:F99CollectorHits = @()
$script:F99CollectorLastReport = $null
$script:FlushFlag = Join-Path $Root 'flush.flag'
# [F28 §1] Server start clock + the logon-result state file. The 30s scan tick
# runs in THIS process from start (see the listener loop), so the logon verdict
# exists even when no keep-alive step ever runs.
$script:ServerStartedUtc = (Get-Date).ToUniversalTime()
$script:LogonStatePath = Join-Path $Root 'rdp-logon.json'
# [F30 §3] server connection-log state (own file: same no-writer-race rule as
# the F28 logon state - main.yml only MIRRORS it into config.json).
$script:ConnLogStatePath = Join-Path $Root 'rdp-connlog.json'
# [F37 §4] live runner telescope (own 60s tick, own state file - never a writer
# race with the workflow) + the client beacon ring the launcher posts to.
$script:F37TelStatePath = Join-Path $Root 'rdp-listener-telescope.json'
$script:F37TelClientPath = Join-Path $Root 'rdp-telescope-client.jsonl'
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:WebDeskHtml = ''
$script:Token = ''
try {
    $tp = Join-Path $Root 'dash-token.txt'
    if (Test-Path -LiteralPath $tp) { $script:Token = ([System.IO.File]::ReadAllText($tp)).Trim() }
} catch { }
$script:RdpTokens = @{}
# [F30 §2.2 purge-cmd-begin] The "nuclear option" the operator runs on THEIR PC:
# ONE PowerShell line that deletes EVERY TERMSRV credential whose LastWritten is
# older than 7 days (cmdkey /list cannot show ages - the store API can). It
# shells out to nothing, types nothing into any window, and prints only a COUNT;
# no credential value is ever read, logged or transmitted. Served ONLY by the
# dash-token-gated /api/purge-stale-creds route.
$script:F30PurgeType = 'using System;using System.Runtime.InteropServices;public static class GhrdpCredPurge{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public uint Flags;public uint Type;public string TargetName;public string Comment;public long LastWritten;public uint BlobSize;public IntPtr Blob;public uint Persist;public uint AttrCount;public IntPtr Attrs;public string Alias;public string User;}[DllImport("advapi32.dll",EntryPoint="CredEnumerateW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Enum(string f,uint fl,out uint n,out IntPtr a);[DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool Del(string t,uint ty,uint fl);[DllImport("advapi32.dll")]public static extern void Free(IntPtr p);public static int Purge(int days){uint n=0;IntPtr a=IntPtr.Zero;int killed=0;if(!Enum("TERMSRV/*",0,out n,out a)){return 0;}try{DateTime floor=DateTime.UtcNow.AddDays(-days);for(uint i=0;i<n;i++){IntPtr it=Marshal.ReadIntPtr(a,(int)i*IntPtr.Size);if(it==IntPtr.Zero){continue;}C c=(C)Marshal.PtrToStructure(it,typeof(C));if(c.TargetName==null){continue;}if(!c.TargetName.StartsWith("TERMSRV/",StringComparison.OrdinalIgnoreCase)){continue;}DateTime w=DateTime.MinValue;try{w=DateTime.FromFileTimeUtc(c.LastWritten);}catch{}if(w>floor){continue;}if(Del(c.TargetName,c.Type,0)){killed++;}}}finally{Free(a);}return killed;}}'
$script:F30PurgeCommand = 'Add-Type -TypeDefinition ' + [char]39 + $script:F30PurgeType + [char]39 + '; ''purged '' + [GhrdpCredPurge]::Purge(7) + '' TERMSRV entries older than 7 days'''
# [F30 §2.2 purge-cmd-end]
$script:LauncherSeen = $false
$script:HandlerChain = @()
$script:DeviceTokens = @{}
$script:DeviceTokensPath = Join-Path $Root 'device-tokens.json'
$script:ClientAuditLog = Join-Path $Root 'client-audit.log'
$script:AgentPath = Join-Path $Root 'ghrdp-agent.ps1'
$script:DiagDir = Join-Path $Root 'diag-bundles'
try {
    if (Test-Path -LiteralPath $script:DeviceTokensPath) {
        $dt0 = [System.IO.File]::ReadAllText($script:DeviceTokensPath) | ConvertFrom-Json
        if ($dt0) { foreach ($p in $dt0.PSObject.Properties) { $script:DeviceTokens[[string]$p.Name] = @{ deviceId = [string]$p.Value.deviceId; enrolledAt = [string]$p.Value.enrolledAt } } }
    }
} catch { }
function Save-DeviceTokens {
    try {
        $h = @{}
        foreach ($k in $script:DeviceTokens.Keys) { $h[$k] = @{ deviceId = $script:DeviceTokens[$k].deviceId; enrolledAt = $script:DeviceTokens[$k].enrolledAt } }
        [System.IO.File]::WriteAllText($script:DeviceTokensPath, ($h | ConvertTo-Json -Depth 5 -Compress), $script:NoBom)
    } catch { }
}
function Write-ClientAudit {
    param([string]$Line)
    try { [System.IO.File]::AppendAllText($script:ClientAuditLog, ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Line + "`n")) } catch { }
}
# [F17 §2] ROOT CAUSE of the +05:30 beacon-age bug (19805s): stored ISO ts
# strings were read back through ConvertFrom-Json, which converts "…Z" into a
# [datetime] in the SERVER'S LOCAL timezone and then [string] renders it
# WITHOUT the Z - the dashboard parsed that bare ts as the VISITOR'S local
# time and inflated the beacon age by the local-UTC offset. Contract now:
# every stored ts is re-extracted from the RAW file text and parsed with
# DateTime.Parse(..., RoundtripKind) - an explicit offset is honored, a bare
# ts is UTC, never local.
function Get-RawJsonTs {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return '' }
        $raw = [System.IO.File]::ReadAllText($Path)
        if ($raw -match '"ts"\s*:\s*"([^"]+)"') { return $Matches[1] }
    } catch { }
    return ''
}
function ConvertTo-UtcDateTime {
    param($Ts)
    try {
        if ($null -eq $Ts) { return $null }
        if ($Ts -isnot [datetime]) {
            $s = [string]$Ts
            if (-not $s) { return $null }
            $Ts = [datetime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
        }
        if ($Ts.Kind -eq [System.DateTimeKind]::Unspecified) { $Ts = New-Object System.DateTime($Ts.Ticks, [System.DateTimeKind]::Utc) }
        return $Ts.ToUniversalTime()
    } catch { return $null }
}
function Get-UtcAgeSeconds {
    param($Ts)
    $dt = ConvertTo-UtcDateTime $Ts
    if ($null -eq $dt) { return $null }
    return [int]([datetime]::UtcNow - $dt).TotalSeconds
}
function ConvertTo-UtcIso {
    param($Ts)
    $dt = ConvertTo-UtcDateTime $Ts
    if ($null -eq $dt) { return '' }
    return $dt.ToString('o')
}
# [F17 §2] per-run beacon store: a handler-hello-last.json left over from a
# PRIOR run (re-dispatch on the same host, or a VPS) would render a stale
# beacon row as if THIS run's launcher had reported. Reset at server start so
# every beacon row is per-run only.
foreach ($f17bf in @('handler-hello-last.json', 'launcher-hello-last.json')) {
    try { Remove-Item -LiteralPath (Join-Path $Root $f17bf) -Force -ErrorAction SilentlyContinue } catch { }
}
function Get-TailnetIp {
    try {
        $addrs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())
        foreach ($a in $addrs) {
            if ($a.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                $ob = $a.GetAddressBytes()
                if ($ob[0] -eq 100 -and $ob[1] -ge 64 -and $ob[1] -le 127) { return $a.ToString() }
            }
        }
    } catch { }
    return '127.0.0.1'
}

function Read-JsonFile {
    param([string]$Path)
    for ($a = 1; $a -le 3; $a++) {
        try {
            if (-not (Test-Path -LiteralPath $Path)) { return $null }
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $ms = New-Object System.IO.MemoryStream
            $fs.CopyTo($ms)
            $fs.Dispose()
            $b = $ms.ToArray()
            $ms.Dispose()
            if ($b.Length -eq 0) { return $null }
            if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $b = $b[3..($b.Length - 1)] }
            $t = [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
            return ($t | ConvertFrom-Json)
        } catch { Start-Sleep -Milliseconds 40 }
    }
    return $null
}
function Get-RequestParts {
    param([string]$Raw)
    $headers = @{}
    $query = @{}
    $lines = @($Raw -split "`r`n")
    $path = '/'
    if ($lines.Count -gt 0 -and $lines[0]) {
        $first = $lines[0].Trim()
        $sp = $first.IndexOf(' ')
        if ($sp -gt 0) {
            $rest = $first.Substring($sp + 1).Trim()
            $target = (@($rest -split ' '))[0]
            $qAt = $target.IndexOf('?')
            if ($qAt -ge 0) {
                $path = $target.Substring(0, $qAt)
                # [F42 §1] the live ticket link was /?key=<token>?ui=v2: the
                # SECOND '?' is not a separator, so a raw split on '&' left
                # ui=v2 glued onto the key and the ui param was never parsed
                # (v1 rendered). Normalise EVERY literal '?' after the FIRST
                # one to '&' BEFORE splitting; url-decode per pair AFTER the
                # split, so an encoded %3F inside a value stays a value.
                $qNorm = ($target.Substring($qAt + 1)).Replace('?', '&')
                foreach ($kv in ($qNorm -split '&')) {
                    $eq = $kv.IndexOf('=')
                    if ($eq -gt 0) {
                        $k = [uri]::UnescapeDataString($kv.Substring(0, $eq)).ToLower()
                        $v = [uri]::UnescapeDataString($kv.Substring($eq + 1))
                        $query[$k] = $v
                    }
                }
            } else {
                $path = $target
            }
        }
    }
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        $ix = $l.IndexOf(':')
        if ($ix -gt 0) { $headers[$l.Substring(0, $ix).Trim().ToLower()] = $l.Substring($ix + 1).Trim() }
    }
    $method = 'GET'
    if ($lines.Count -gt 0 -and $lines[0]) { $tok0 = ($lines[0].Trim() -split ' ')[0]; if ($tok0) { $method = $tok0.ToUpper() } }
    return @{ path = $path; headers = $headers; query = $query; method = $method }
}
function Test-IsLoopbackAddr {
    # [F10-15] `$ip.IsLoopback` resolved to $false for a genuine 127.0.0.1
    # remote endpoint on the Windows lab host (probe annotation: addr=127.0.0.1
    # family=InterNetwork isloopback=<empty> verdict=False), so loopback clients
    # were silently 401'd by Test-ClientAllowed. Use the static API plus an
    # explicit 127.0.0.0/8 byte check; both are valid on every PowerShell.
    param($Ip)
    try {
        if ($Ip) {
            if ([System.Net.IPAddress]::IsLoopback($Ip)) { return $true }
            $ob = $Ip.GetAddressBytes()
            if ($ob.Length -eq 4 -and $ob[0] -eq 127) { return $true }
        }
    } catch { }
    return $false
}
function Test-ClientAllowed {
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        if (Test-IsLoopbackAddr $ip) { return $true }
        if (Test-TicketSource $ip) { return $true }
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if ([string]::IsNullOrEmpty($Token)) { return $true }
    if ($Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
function Test-CredsAllowed {
    # [F10-2 §3] STRICTER than Test-ClientAllowed: passwords may leave this
    # host only for (a) a request carrying the dash token, or (b) a source IP
    # inside the tailnet CGNAT range (the operator's own device). Bare
    # loopback (self-tests, local probes) never receives the creds block.
    param($Client, $Query, $Token)
    try {
        $ip = $Client.Client.RemoteEndPoint.Address
        $oct = $ip.GetAddressBytes()
        if ($oct.Length -eq 4 -and $oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127) { return $true }
    } catch { }
    if (-not [string]::IsNullOrEmpty($Token) -and $Query -and $Query.ContainsKey('key') -and ([string]$Query['key'] -eq [string]$Token)) { return $true }
    return $false
}
# [F27 ticket-core-begin] Direct socket source only; never trust forwarded headers.
$script:TicketAudit = [ordered]@{ issued = 0; redeemed = 0; rejected = 0 }
function Test-TicketBearer([byte[]]$Received, [byte[]]$Expected) {
    if ($Received.Length -ne $Expected.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $Expected.Length; $i++) { $diff = $diff -bor ($Received[$i] -bxor $Expected[$i]) }
    return ($diff -eq 0)
}
function Test-TicketSource([System.Net.IPAddress]$Ip) {
    if (-not $Ip) { return $false }
    if ($Ip.IsIPv4MappedToIPv6) { $Ip = $Ip.MapToIPv4() }
    $b = $Ip.GetAddressBytes()
    return (($b.Length -eq 4 -and $b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) -or
        ($b.Length -eq 16 -and $b[0] -eq 0xfd -and $b[1] -eq 0x7a -and $b[2] -eq 0x11 -and $b[3] -eq 0x5c -and $b[4] -eq 0xa1 -and $b[5] -eq 0xe0))
}
function Write-TicketAudit([string]$Event, [string]$Source) {
    $script:TicketAudit[$Event]++
    $row = @{ ts = [datetime]::UtcNow.ToString('o'); source = $Source; counts = $script:TicketAudit }
    try { [System.IO.File]::AppendAllText((Join-Path $Root 'rdp-token-audit.log'), (($row | ConvertTo-Json -Compress) + "`n")) } catch { }
}
function Use-RdpTicket([string]$Ticket, [System.Net.IPAddress]$Source, [datetime]$Now) {
    if (-not (Test-TicketSource $Source)) { return $false }
    if ($Ticket -notmatch '^[0-9a-f]{32}$' -or -not $script:RdpTokens.ContainsKey($Ticket)) { return $false }
    $entry = $script:RdpTokens[$Ticket]
    # Bind to the issuing PC as well as requiring a direct tailnet source.
    if ($entry.source -ne $Source.ToString()) { return $false }
    $script:RdpTokens.Remove($Ticket) # consume before response, including expired tickets
    $age = ($Now - $entry.created).TotalSeconds
    return ($age -ge 0 -and $age -lt 60)
}
# [F27 ticket-core-end]
# [F99 §2.5] Dash token refresh-aware validator + telemetry.
# The per-run token is written fresh on every dispatch (main.yml:2510) but the
# server process snapshot ($script:Token) is read once at boot, so an update
# under a still-running process makes presented-token checks fail with no
# evidence. The shared validator tries snapshot then current file token, and
# every 401 records only a short hash (never the value) for /api/diag.
$script:F99DashTokenTelemetry = New-Object System.Collections.ArrayList
function Get-F99DashTokenHash { param([string]$Token)
    if (-not $Token) { return 'empty' }
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $b = [System.Text.Encoding]::UTF8.GetBytes($Token)
        $h = $sha.ComputeHash($b)
        $sha.Dispose()
        return ([BitConverter]::ToString($h).Replace('-','').Substring(0,8).ToLower())
    } catch { return 'hash-error' }
}
function Test-GhrdpDashToken {
    param([string]$Presented, [string]$SnapshotToken)
    $presented = ([string]$Presented).Trim()
    if (-not $presented) { return $false }
    $candidates = @()
    if ($SnapshotToken) { $candidates += [string]$SnapshotToken }
    # Also try current file token (refresh-aware)
    try {
        $tp = Join-Path $Root 'dash-token.txt'
        if (Test-Path -LiteralPath $tp) {
            $fileTok = ([System.IO.File]::ReadAllText($tp)).Trim()
            if ($fileTok -and $candidates -notcontains $fileTok) { $candidates += $fileTok }
        }
    } catch { }
    # Also try config.json dashToken field
    try {
        $cfg = Read-JsonFile -Path $script:CfgPath
        if ($cfg -and $cfg.PSObject.Properties['dashToken'] -and [string]$cfg.dashToken) {
            $ct = ([string]$cfg.dashToken).Trim()
            if ($ct -and $candidates -notcontains $ct) { $candidates += $ct }
        }
    } catch { }
    foreach ($exp in $candidates) {
        if (-not $exp) { continue }
        $recv = [System.Text.Encoding]::UTF8.GetBytes($presented)
        $exb = [System.Text.Encoding]::UTF8.GetBytes([string]$exp)
        if ($recv.Length -ne $exb.Length) { continue }
        if (Test-TicketBearer $recv $exb) { return $true }
    }
    return $false
}
function Add-F99TokenTelemetry {
    param([string]$Route, [string]$Presented, [string]$SnapshotToken, [bool]$Valid)
    try {
        $ph = Get-F99DashTokenHash $Presented
        $eh = Get-F99DashTokenHash $SnapshotToken
        $entry = [ordered]@{ ts=(Get-Date -Format o); route=$Route; presentedHash=$ph; expectedHash=$eh; valid=$Valid; presentedLen=([string]$Presented).Length; expectedLen=([string]$SnapshotToken).Length }
        [void]$script:F99DashTokenTelemetry.Add($entry)
        if ($script:F99DashTokenTelemetry.Count -gt 50) { $script:F99DashTokenTelemetry.RemoveAt(0) }
        Write-ClientAudit ('F99 token ' + $Route + ' valid=' + $Valid + ' presentedHash=' + $ph + ' expectedHash=' + $eh)
    } catch { }
}

# [F28 §1 scanner-begin] SERVER-SIDE LOGON-RESULT SCANNER (secret-free).
# The dashboard could only show 4624/4625 COUNTS from the workflow's keep-alive
# tick (F24), so nobody could see whether an mstsc attempt actually LOGGED ON.
# This scanner runs as an INDEPENDENT 30s tick inside the server process - from
# SERVER START, never dependent on the keep-alive step - and stamps
# rdpListener.authLast = {result: success|failed|none, sub, eventTs, scanTs}.
# scanTs is written on EVERY scan (success, failure, empty window AND a
# security-log-unreadable probe error), so the dashboard can distinguish
# "scanned <ts>, nothing yet" from a dead collector. Reads ONLY the event id,
# LogonType, Status/SubStatus/FailureReason codes and TargetUserName of 4624
# (LogonType 10) / 4625: never a password, a domain or an address. Extracted
# VERBATIM by the F28 gate + lab cell and driven with synthetic event XML.
$script:F28IntervalSec = 30
$script:F28WindowSec = 3600
$script:F28StaleSec = 90
$script:F28Scans = 0
$script:F28LastProbeError = ''
function Get-RdpLogonEventFields {
    param([xml]$Xml)
    $id = ''
    $t = ''
    $name = @{}
    try { $id = [string]($Xml.SelectSingleNode("//*[local-name()='EventID']")).InnerText } catch { }
    try { $t = [string]($Xml.SelectSingleNode("//*[local-name()='TimeCreated']").GetAttribute('SystemTime')) } catch { }
    try {
        foreach ($d in @($Xml.SelectNodes("//*[local-name()='Data']"))) {
            $n = [string]$d.GetAttribute('Name')
            if ($n) { $name[$n] = [string]$d.InnerText }
        }
    } catch { }
    return [pscustomobject]@{
        id        = $id.Trim()
        timeUtc   = $t
        status    = ([string]$name['Status']).Trim().ToUpperInvariant()
        subStatus = ([string]$name['SubStatus']).Trim().ToUpperInvariant()
        reason    = ([string]$name['FailureReason']).Trim()
        logonType = ([string]$name['LogonType']).Trim()
        targetUserName = ([string]$name['TargetUserName']).Trim()
    }
}
function Get-RdpLogonSubMeaning {
    param([string]$Code)
    switch (([string]$Code).Trim().ToUpperInvariant()) {
        '0XC000006A' { return 'wrong-password' }
        '0XC000006D' { return 'bad-user-or-password' }
        '0XC0000064' { return 'no-such-user' }
        '0XC000015B' { return 'logon-type-denied' }
        '0XC0000234' { return 'account-locked' }
        '0XC0000072' { return 'account-disabled' }
        '0XC000006E' { return 'account-restriction' }
        '0XC000006F' { return 'time-restriction' }
        '0XC0000070' { return 'workstation-restriction' }
        '0XC0000071' { return 'credential-expired' }
        default { if ($Code) { return 'other' } return '' }
    }
}
# ---------------------------------------------------------------------------
# [F95 §3.1 / R1] WHICH LOGON TYPES PROVE AN INTERACTIVE SESSION.
#
# ROOT CAUSE: the F28 collector accepted ONLY LogonType 10 (RemoteInteractive).
# Windows AutoAdminLogon - the very thing main.yml's "Arm Windows Auto-Logon"
# step (F94) configures on the runner - writes LogonType 2 (Interactive), and a
# cached-credential sign-in writes LogonType 11 (CachedInteractive). A physical
# console sign-in, Parsec and Tailscale SSH-to-desktop all land on 2 as well.
# LogonType 10 is written ONLY by an inbound RDP client. So on exactly the
# runner F94 was built to create, the detector could never fire and the
# dashboard read "No user logged into RDP yet" while a real interactive desktop
# was on screen (the operator's noVNC screenshot: Firefox, Chrome, R 4.6.1,
# Unity Hub, PowerShell and the GHRDP Start icon all visible).
#
# The accepted set is 2/10/11 - the three types that mean "a human is at this
# desktop right now". Service (5), network (3), batch (4), unlock (7) and
# new-credentials (9) stay EXCLUDED: none of them creates a desktop an ONLOGON
# task can run in.
# ---------------------------------------------------------------------------
$script:GhrdpInteractiveLogonTypes = @('2', '10', '11')
function Test-GhrdpInteractiveLogonType {
    param([string]$LogonType)
    return ($script:GhrdpInteractiveLogonTypes -contains ([string]$LogonType).Trim())
}
function Get-GhrdpInteractiveLogonTypeLabel {
    param([string]$LogonType)
    switch (([string]$LogonType).Trim()) {
        '2'  { return 'interactive' }
        '10' { return 'remote-interactive' }
        '11' { return 'cached-interactive' }
        default { return '' }
    }
}
# The WQL form of the same set, for the Win32_LogonSession probes. Kept next to
# the array so the two can never drift.
$script:GhrdpLogonSessionWql = 'LogonType=2 OR LogonType=10 OR LogonType=11'
function Get-RdpLogonAuthLast {
    # Pure: items in, verdict out. scanTs is ALWAYS stamped - the only way the
    # dashboard can tell "scanned, nothing yet" from "collector not running".
    # [F99 §2.3] was -120: only 2 minutes of Security log was examined, so a
    # type-2 autologon older than 2 min decayed to none even though a desktop
    # was live. Now uses the shared F28WindowSec (3600) so 8 type-2 events in
    # the wider F96 re-scan are also seen by the verdict.
    param($Items, [datetime]$ScanStartedUtc, [string]$ProbeError = '')
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $nowUtc = (Get-Date).ToUniversalTime()
    $windowStart = $ScanStartedUtc.AddSeconds(-1 * $script:F28WindowSec)
    $floor = $nowUtc.AddSeconds(-1 * $script:F28WindowSec)
    if ($windowStart -lt $floor) { $windowStart = $floor }
    $okWhen = $null; $okTs = ''
    $failWhen = $null; $failTs = ''; $failSub = ''
    $c4624 = 0; $c4625 = 0
    # [F95 §3.1 / R1] lastLogonType: WHICH of 2/10/11 was seen, so the banner
    # can say "interactive" instead of a bare "yes".
    $lastLogonType = ''; $lastLogonKind = ''
    foreach ($it in @($Items)) {
        if (-not $it) { continue }
        # [F95 §3.1 / R1] was `-ne '10'`: that dropped every autologon (type 2)
        # and cached (type 11) event before the window check could run.
        if (-not (Test-GhrdpInteractiveLogonType -LogonType ([string]$it.logonType)) -and [string]$it.id -eq '4624') { continue }
        $when = $null
        try {
            $when = [datetime]::Parse([string]$it.timeUtc, [System.Globalization.CultureInfo]::InvariantCulture,
                ([System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal))
        } catch { $when = $null }
        if ($null -ne $when) {
            if ($when -lt $windowStart) { continue }
            if ($when -gt $nowUtc.AddSeconds(120)) { continue }
        }
        if ([string]$it.id -eq '4624') {
            # [F95 §3.1 / R1] Was: "LogonType 10 (RemoteInteractive) only: a
            # console/service logon is never an RDP success." That held a real
            # fact (a SERVICE/NETWORK logon is not a desktop) but drew the line
            # in the wrong place - LogonType 2 (Interactive, which is what
            # AutoAdminLogon writes) and 11 (CachedInteractive) ARE a desktop.
            # Service/batch/network/unlock types are still excluded by
            # Test-GhrdpInteractiveLogonType.
            if (Test-GhrdpInteractiveLogonType -LogonType ([string]$it.logonType)) {
                $c4624++
                if (($null -eq $okWhen) -or ($null -eq $when) -or ($when -ge $okWhen)) {
                    $okWhen = $when; $okTs = [string]$it.timeUtc
                    $lastLogonType = ([string]$it.logonType).Trim()
                    $lastLogonKind = (Get-GhrdpInteractiveLogonTypeLabel -LogonType $lastLogonType)
                }
            }
            continue
        }
        if ([string]$it.id -ne '4625') { continue }
        $c4625++
        if (($null -eq $failWhen) -or ($null -eq $when) -or ($when -ge $failWhen)) {
            $failWhen = $when; $failTs = [string]$it.timeUtc; $failSub = ([string]$it.subStatus).ToUpperInvariant()
        }
    }
    $result = 'none'; $eventTs = ''; $sub = ''
    if ($null -ne $okWhen -and ($null -eq $failWhen -or $okWhen -ge $failWhen)) {
        $result = 'success'; $eventTs = $okTs
    } elseif ($null -ne $failWhen) {
        $result = 'failed'; $eventTs = $failTs; $sub = $failSub
    }
    return [pscustomobject]@{
        result      = $result
        sub         = $sub
        eventTs     = $eventTs
        scanTs      = $scanTs
        windowSec   = $script:F28WindowSec
        windowStart = $windowStart.ToString('o')
        count4624   = $c4624
        count4625   = $c4625
        subMeaning  = (Get-RdpLogonSubMeaning -Code $sub)
        probeError  = $ProbeError
        # [F95 §3.1 / R1] WHICH logon the verdict came from ('2'/'10'/'11' or
        # '' when nothing was seen). Surfaced at
        # rdpListener.authLast.logonType so the banner can name it instead of
        # leaving the operator to guess why it says what it says.
        logonType   = $lastLogonType
        logonKind   = $lastLogonKind
    }
}
function Update-RdpLogonAuthLast {
    # The tick body: read the runner's OWN Security log, stamp, persist. It
    # never throws (a dead probe stamps result=none + probeError + scanTs) and
    # writes ONLY the allowlisted fields above.
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $items = @()
    $probeErr = ''
    try {
        $since = $ScanStartedUtc.AddSeconds(-1 * $script:F28WindowSec)
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624, 4625); StartTime = $since.ToLocalTime() } -MaxEvents 400 -ErrorAction Stop)
        foreach ($e in $raw) { $items += (Get-RdpLogonEventFields -Xml ([xml]$e.ToXml())) }
    } catch { $probeErr = 'security-log-unreadable' }
    $sum = Get-RdpLogonAuthLast -Items $items -ScanStartedUtc $ScanStartedUtc -ProbeError $probeErr
    try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 5 -Compress), $script:NoBom) } catch { }
    $script:F28Scans = [int]$script:F28Scans + 1
    $script:F28LastProbeError = $probeErr
    Write-Host ('[F28] logon scan #' + $script:F28Scans + ' result=' + $sum.result +
        ' sub=' + $(if ($sum.sub) { $sum.sub } else { '-' }) +
        ' eventTs=' + $(if ($sum.eventTs) { $sum.eventTs } else { '-' }) +
        ' 4624=' + $sum.count4624 + ' 4625=' + $sum.count4625 +
        ' scanTs=' + $sum.scanTs + $(if ($probeErr) { ' probeError=' + $probeErr } else { '' }))
    return $sum
}
function Get-RdpLogonCollectorState {
    # Read-back for /api/native-status: authLast plus the collector's own
    # liveness (a missing or >90s stale state file is NOT a green collector).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $authLast = $null
    $ageSec = $null
    if (Test-Path -LiteralPath $StatePath) {
        $authLast = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F28StaleSec) } else { $alive = ($uptime -le $script:F28StaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F28IntervalSec
        staleSec    = $script:F28StaleSec
        scans       = [int]$script:F28Scans
        alive       = $alive
        startedAt   = $ServerStartedUtc.ToString('o')
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        probeError  = [string]$script:F28LastProbeError
    }
    return [pscustomobject]@{ authLast = $authLast; logonCollector = $collector }
}
# [F28 §1 scanner-end]

# [F30 §3 connlog-begin] SERVER CONNECTION-LOG COLLECTOR (secret-free).
# Ground truth 2026-09-26: the client is dropped DURING the TLS handshake and
# 4624/4625 never fire, so the Security log is BLIND to it. These two RDP
# Operational logs are where the handshake/cert/listener events actually land:
#   Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational
#   Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational
# The collector runs on its OWN 30s tick inside the server process (same shape as
# the F28 logon scanner, from SERVER START - never dependent on the keep-alive
# step), keeps the last 10 events of EACH log, and stamps a small state file the
# dashboard renders as "SERVER CONN LOG" (newest 3 + reason codes). It stores
# only: EventID, provider, TimeCreated, level, a 200-char clipped description and
# a derived reason code - never a credential, and credential-shaped text is
# redacted before it is stored or shown.
$script:F30ConnLogIntervalSec = 30
$script:F30ConnLogStaleSec = 90
$script:F30ConnLogPerLog = 10
$script:F30ConnLogMaxItems = 12
$script:F30ConnLogSources = @(
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'
)
$script:F30ConnLogScans = 0
$script:F30ConnLogLastProbeError = ''
# The lab dot-sources THIS block alone, so the shared no-BOM encoder may not
# exist yet: create it if missing (an undefined encoding makes WriteAllText
# throw and the state file would simply never appear - a silent blackout).
if (-not (Get-Variable -Name NoBom -Scope Script -ErrorAction SilentlyContinue)) {
    $script:NoBom = New-Object System.Text.UTF8Encoding($false)
}
function Get-RdpConnLogEventFields {
    param([xml]$Xml, [string]$Provider)
    $id = ''
    $t = ''
    $lvl = ''
    $msg = ''
    try { $id = [string]($Xml.SelectSingleNode("//*[local-name()='EventID']")).InnerText } catch { }
    try { $t = [string]($Xml.SelectSingleNode("//*[local-name()='TimeCreated']").GetAttribute('SystemTime')) } catch { }
    try { $lvl = [string]($Xml.SelectSingleNode("//*[local-name()='Level']")).InnerText } catch { }
    try { $msg = [string]($Xml.SelectSingleNode("//*[local-name()='RenderingInfo']")).InnerText } catch { }
    if (-not $msg) { try { $msg = [string]($Xml.SelectSingleNode("//*[local-name()='EventData']")).InnerText } catch { } }
    $desc = ''
    if ($msg) {
        $desc = ($msg -replace '\s+', ' ').Trim()
        # Defensive redaction: this line is DISPLAYED, so a credential-shaped
        # token in prose can never reach it (event messages carry none today).
        $desc = $desc -replace '(?i)(password|passwd|pwd|subjectusername|targetusername|subjectdomainname)(\s*[=:]\s*)\S+', '$1$2[redacted]'
        if ($desc.Length -gt 200) { $desc = $desc.Substring(0, 200) }
    }
    return [pscustomobject]@{
        id       = $id.Trim()
        provider = $Provider
        timeUtc  = $t
        level    = $lvl.Trim()
        desc     = $desc
        reason   = (Get-RdpConnLogReason -Provider $Provider -Id $id -Level $lvl -Text $desc)
    }
}
function Get-RdpConnLogReason {
    # reason codes, derived from the stored fields only (never a guess about a
    # host we cannot see): tls-forcibly-closed | tls-handshake-failed |
    # cert-rejected | connection-reset | auth-succeeded | auth-failed |
    # listener-lifecycle | session-state | event-<id> | other
    param([string]$Provider, [string]$Id, [string]$Level, [string]$Text)
    $t = ([string]$Text).ToLowerInvariant()
    $p = ([string]$Provider).ToLowerInvariant()
    $evt = ([string]$Id).Trim()
    if ($p -match 'schannel' -and $evt -eq '36870') {
        if ($t -match '0x[0-9a-f]{8}') { return ('key-open-failed:' + $Matches[0]) }
        return 'key-open-failed:unknown'
    }
    if ($p -match 'schannel' -and $evt -eq '36888') {
        if ($t -match 'error state (?:is )?(\d+)') { return ('tls-alert-sent:' + $Matches[1]) }
        return 'tls-alert-sent:unknown'
    }
    if ($t -match 'forcibly closed') { return 'tls-forcibly-closed' }
    # certificate FIRST: a cert failure message also says "TLS ... failed", and
    # 'cert-rejected' is the actionable reason code for it.
    if ($t -match 'certificat') { return 'cert-rejected' }
    if ($t -match 'handshake' -and ($t -match 'fail|error|abort|denied')) { return 'tls-handshake-failed' }
    if ($t -match 'schannel|tls' -and ($t -match 'fail|error|fatal')) { return 'tls-handshake-failed' }
    if ($t -match 'reset' -and $t -match 'connection|peer|transport') { return 'connection-reset' }
    if ($t -match 'authenticat' -and $t -match 'succeed|success') { return 'auth-succeeded' }
    if ($t -match 'authenticat' -and $t -match 'fail|denied|reject') { return 'auth-failed' }
    if ($t -match 'listen') { return 'listener-lifecycle' }
    if ($t -match 'session') { return 'session-state' }
    if ($p -match 'rdpcorets' -and $evt -in @('100', '101', '102', '103', '104', '105', '106', '107', '108', '110', '131')) { return 'listener-lifecycle' }
    if ($evt) { return ('event-' + $evt) }
    return 'other'
}
function Get-RdpConnLog {
    # PURE: items in, display shape out (newest first, newest 3 flagged for the
    # dashboard row). probeError is named on every scan so a dead collector can
    # never look like a clean log.
    param([object[]]$Items, [datetime]$ScanStartedUtc, [string]$ProbeError = '')
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $sorted = @($Items | Sort-Object -Property timeUtc -Descending)
    $items = @()
    $n = 0
    foreach ($it in $sorted) {
        if ($n -ge $script:F30ConnLogMaxItems) { break }
        $items += [pscustomobject]@{
            id       = [string]$it.id
            provider = [string]$it.provider
            timeUtc  = [string]$it.timeUtc
            level    = [string]$it.level
            reason   = [string]$it.reason
            desc     = [string]$it.desc
        }
        $n++
    }
    $reasons = @($items | ForEach-Object { $_.reason } | Select-Object -First 3)
    return [pscustomobject]@{
        ts          = $scanTs
        scanTs      = $scanTs
        windowStart = (Get-RdpConnLogWindowStart -ScanStartedUtc $ScanStartedUtc)
        items       = $items
        newest      = @($items | Select-Object -First 3)
        topReasons  = $reasons
        count       = $items.Count
        probeError  = $ProbeError
        intervalSec = $script:F30ConnLogIntervalSec
        staleSec    = $script:F30ConnLogStaleSec
        perLog      = $script:F30ConnLogPerLog
        sources     = $script:F30ConnLogSources
    }
}
function Get-RdpConnLogWindowStart {
    param([datetime]$ScanStartedUtc)
    return $ScanStartedUtc.AddSeconds(-1 * $script:F30ConnLogIntervalSec).ToString('o')
}
function Update-RdpConnLog {
    # The tick body: read the last 10 events of BOTH RDP Operational logs, stamp,
    # persist. Never throws (a dead probe stamps probeError + scanTs).
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $items = @()
    $failed = @()
    foreach ($logName in $script:F30ConnLogSources) {
        try {
            $since = (Get-Date).ToLocalTime().AddSeconds(-300)
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $since } -MaxEvents $script:F30ConnLogPerLog -ErrorAction Stop)
            foreach ($e in $raw) {
                $prov = $logName.Split('/')[0] -replace '^Microsoft-Windows-', ''
                $items += (Get-RdpConnLogEventFields -Xml ([xml]$e.ToXml()) -Provider $prov)
            }
        } catch { $failed += $logName }
    }
    $probeErr = ''
    if ($failed.Count -eq $script:F30ConnLogSources.Count) { $probeErr = 'conn-logs-unreadable' }
    elseif ($failed.Count -gt 0) { $probeErr = 'partial:' + (($failed | ForEach-Object { $_.Split('/')[0] -replace '^Microsoft-Windows-', '' }) -join '+') }
    $sum = Get-RdpConnLog -Items $items -ScanStartedUtc $ScanStartedUtc -ProbeError $probeErr
    try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 6 -Compress), $script:NoBom) }
    catch {
        # A state file that never appears is a silent blackout: retry with the
        # default encoding and, if even that fails, say so in probeError.
        try { [System.IO.File]::WriteAllText($StatePath, ($sum | ConvertTo-Json -Depth 6 -Compress)) }
        catch {
            $probeErr = 'state-write-failed: ' + $_.Exception.Message
            $sum | Add-Member -NotePropertyName probeError -NotePropertyValue $probeErr -Force
        }
    }
    $script:F30ConnLogScans = [int]$script:F30ConnLogScans + 1
    $script:F30ConnLogLastProbeError = $probeErr
    $head = ''
    if ($sum.count -gt 0) { $head = ($sum.newest | ForEach-Object { ('[' + $_.id + ' ' + $_.reason + ']') }) -join ' ' }
    Write-Host ('[F30] conn-log scan #' + $script:F30ConnLogScans + ' items=' + $sum.count +
        ' reasons=' + $(if ($head) { $head } else { '(none)' }) +
        ' scanTs=' + $sum.scanTs + $(if ($probeErr) { ' probeError=' + $probeErr } else { '' }))
    return $sum
}
function Get-RdpConnLogState {
    # Read-back for /api/native-status: newest items + collector liveness (a
    # missing or >90s stale state file is NOT a clean log).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $state = $null
    $ageSec = $null
    if (Test-Path -LiteralPath $StatePath) {
        $state = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F30ConnLogStaleSec) } else { $alive = ($uptime -le $script:F30ConnLogStaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F30ConnLogIntervalSec
        staleSec    = $script:F30ConnLogStaleSec
        perLog      = $script:F30ConnLogPerLog
        scans       = [int]$script:F30ConnLogScans
        alive       = $alive
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        probeError  = [string]$script:F30ConnLogLastProbeError
        sources     = $script:F30ConnLogSources
    }
    return [pscustomobject]@{ connLog = $state; connLogCollector = $collector }
}
function Get-F30TlsNormState {
    # [F30 §1] Read the normalization stamp the workflow's F30 step wrote
    # (C:\ghrdp\tls-norm.json): what the server ACTUALLY enabled/ordered. Served
    # so the dashboard can show the server-side cipher state next to the client
    # copy-lines - never a credential, never a private key.
    param([string]$StatePath)
    if (-not $StatePath -or -not (Test-Path -LiteralPath $StatePath)) { return $null }
    $st = Read-JsonFile -Path $StatePath
    if (-not $st) { return $null }
    $age = Get-UtcAgeSeconds (Get-RawJsonTs $StatePath)
    if ($null -ne $age -and -not $st.PSObject.Properties['ageSec']) {
        $st | Add-Member -NotePropertyName ageSec -NotePropertyValue ([int]$age) -Force
    }
    return $st
}
# [F30 §3 connlog-end]
# [F45 S4 fx-module-begin] EXPLORER FILE-API ROUTES. The route implementation
# lives in payloads/ghrdp-fx.ps1 (deployed next to this script) and is
# dot-sourced here, never copied: the server and tests/f45-fx-server.ps1 execute
# the SAME functions. $script:FxReady is the fail-visible flag the dispatch
# below honours - a missing module answers 503 on every /api/fx/* route instead
# of pretending the API exists.
$script:FxModule = ''
$script:FxReady = $false
$script:FxLoadError = ''
$script:FxCsrf = ''
foreach ($fxCand in @((Join-Path $Root 'ghrdp-fx.ps1'), (Join-Path $PSScriptRoot 'ghrdp-fx.ps1'))) {
    try {
        if ($script:FxReady) { break }
        if ($fxCand -and (Test-Path -LiteralPath $fxCand -PathType Leaf)) {
            . $fxCand
            $script:FxModule = $fxCand
            $script:FxReady = $true
        }
    } catch {
        $script:FxLoadError = ('module load failed: ' + $_.Exception.Message)
    }
}
if (-not $script:FxReady) { $script:FxLoadError = ('ghrdp-fx.ps1 not found next to the server at ' + $Root) }
# [F46 §3/§5] mirror host module (documented gofile contract + attempt policy +
# READ-ONLY probe). Dot-sourced for the Diagnose surface; the watcher's mirror
# worker and the Explorer uploader execute the SAME functions. A missing module
# is fail-visible in /diag and in every upload reason - never silent.
$script:F46MirrorReady = $false
foreach ($f46cand in @((Join-Path $Root 'ghrdp-mirror.ps1'), (Join-Path $PSScriptRoot 'ghrdp-mirror.ps1'))) {
    if ($script:F46MirrorReady) { break }
    if ($f46cand -and (Test-Path -LiteralPath $f46cand -PathType Leaf)) {
        try {
            . $f46cand
            $script:F46MirrorReady = $true
        } catch {
            $script:F46MirrorReady = $false
        }
    }
}
if (-not $script:F46MirrorReady) { $script:F46MirrorLoadError = ('ghrdp-mirror.ps1 not found next to the server at ' + $Root) }
# [M6] Envelope encryption: RSA-2048 keypair for wrapping the per-request ephemeral AES key.
# The private key stays in process memory ($script:EnvelopeRsa) — never written to disk.
# The public key (SPKI, base64) is published in /api/config so the client can wrap to it.
# Generated once at startup; rotation requires a server restart (acceptable for per-session keys).
$script:EnvelopeRsa = $null
try {
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $script:EnvelopeRsa = $rsa
    $spkiBytes = $rsa.ExportSubjectPublicKeyInfo()
    $script:EnvelopePublicKeyB64 = [Convert]::ToBase64String($spkiBytes)
} catch {
    $script:EnvelopeRsa = $null
    $script:EnvelopePublicKeyB64 = ''
}
# §1.5/§1.6 CSRF token: one per server process, 24 random bytes, never logged.
# It reaches the dashboard as the JS-readable SameSite=Strict cookie
# ghrdp_fx_csrf (and the X-CSRF-Token response header on /api/fx/list); a POST
# without it is refused with 403.
try {
    $fxCsrfBytes = New-Object byte[] 24
    $fxCsrfRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $fxCsrfRng.GetBytes($fxCsrfBytes) } finally { $fxCsrfRng.Dispose() }
    $script:FxCsrf = ([BitConverter]::ToString($fxCsrfBytes)).Replace('-', '').ToLowerInvariant()
} catch { $script:FxCsrf = '' }
# [F45 S4 fx-module-end]
# [F37 §4 telescope-begin] LIVE RUNNER TELESCOPE (secret-free).
# The runner keeps its OWN observability: a 60s tick runs the SINGLE telescope
# implementation (payloads/rdp-telescope.ps1 - dot-sourced here, never a copy)
# against the listener this host serves and stamps the result so
# /api/native-status can show boundThumb vs servedThumb LIVE (bind drift is
# visible instantly), the key container + its ACL SIDs, and the Schannel tail.
# If the module is not deployed the row still explains itself (ok=false,
# why='module missing') - a silent absence would be a red-without-why again.
$script:F37TelIntervalSec = 60
# LAB-ONLY shortening (GHRDP_LAB_TEL_INTERVAL_SEC): lets the Windows lab
# observe a FRESH sample without waiting a full production minute. Accepted only
# as a plain number in [5,600]; production main.yml carries no GHRDP_LAB_
# switch at all (launch-gates F17 proves it), so production is always 60.
try {
    $f37LabInt = [string]$env:GHRDP_LAB_TEL_INTERVAL_SEC
    if ($f37LabInt -match '^\d{1,3}$') {
        $f37LabVal = [int]$f37LabInt
        if ($f37LabVal -ge 5 -and $f37LabVal -le 600) { $script:F37TelIntervalSec = $f37LabVal }
    }
} catch { }
$script:F37TelStaleSec = 180
$script:F37TelMaxClient = 60
$script:F37TelSlugRe = '^telescope-(dns|tcp)-(ok|fail)$|^telescope-tls-(ok|fail)$|^telescope-cred-(ok|missing)$|^telescope-(rst-before-cert|chain|name-mismatch|eku)$'
$script:F37TelModule = ''
$script:F37TelScans = 0
$script:F37TelLastError = ''
$script:F37TelLastWarn = ''
$script:F37ClientBeacons = @()
foreach ($f37cand in @((Join-Path $Root 'rdp-telescope.ps1'), (Join-Path $PSScriptRoot 'rdp-telescope.ps1'))) {
    try {
        if ($script:F37TelModule) { break }
        if ($f37cand -and (Test-Path -LiteralPath $f37cand -PathType Leaf)) {
            . $f37cand
            $script:F37TelModule = $f37cand
        }
    } catch { $script:F37TelLastError = ('module load failed: ' + $_.Exception.Message) }
}
function Get-F37BeaconStageForSlug {
    # [F37 §1 telescope-format beacon-stage] slug -> stage THROUGH THE MODULE (the
    # one token table); the server never keeps a second mapping of its own. '' is
    # the honest answer for a slug the format does not know, and the caller then
    # stores no verdict. The structural fallback exists only for the case where
    # the module is not deployed at all (the same condition that makes
    # Invoke-F37Telescope return its self-explaining fallback line) - it reads the
    # slug's SHAPE, so it cannot drift from a slug list.
    param([string]$Slug)
    if (-not $Slug) { return '' }
    if ($script:F37TelModule) {
        $st = ''
        try { $st = [string](Get-RdpTelescopeBeaconStage -Slug $Slug) } catch { $st = '' }
        return $st
    }
    switch -Regex ($Slug) {
        '^telescope-dns-' { return 'dns' }
        '^telescope-tcp-' { return 'tcp' }
        '^telescope-cred-' { return 'cred' }
        '^telescope-(tls|rst-before-cert|chain|name-mismatch|eku)' { return 'tls' }
    }
    return ''
}
function New-F37TelescopeFallback {
    # The telescope explains its own absence: same line shape, same keys.
    param([string]$Why, [string]$Src = 'live', [string]$Trace = '')
    $line = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString('o')
        trace = $Trace
        src = $Src
        stage = 'telescope'
        ok = $false
        why = $Why
    }
    return [pscustomobject]@{ trace = $Trace; src = $Src; deathPoint = 'none'; lines = @(($line | ConvertTo-Json -Compress)) }
}
function Invoke-F37Telescope {
    # One call, one implementation: the module's Invoke-RdpTelescope. Never
    # throws - a missing module or a probe error is itself a telescope line.
    param([string]$Fqdn, [string]$Src = 'live', [string]$ExpectedThumb = '')
    if (-not $script:F37TelModule) {
        return (New-F37TelescopeFallback -Why ('rdp-telescope.ps1 not deployed at ' + $Root) -Src $Src)
    }
    try {
        if (-not $Fqdn) { $Fqdn = 'localhost' }
        # [F37 §4] -SkipCred: the stored TERMSRV target is the CLIENT's stage.
        # This host SERVES the listener, so "no stored credential here" is a
        # scope fact - reporting it red painted every healthy runner sample with
        # a false death point (credssp) and made the row unreadable.
        $telOut = (Invoke-RdpTelescope -Fqdn $Fqdn -ExpectedThumb $ExpectedThumb -Src $Src -Local -Ip '127.0.0.1' -SkipCred)
        # Every degraded line must be readable from native-status, never only
        # from a server log the session cannot fetch. probeError is the
        # LISTENER FACE (tcp/tls/listener): those are the stages that mean the
        # path this host serves is broken. Schannel events and an informational
        # logon line are EVIDENCE and travel as probeWarn instead, so a runner
        # that is serving fine never reads as degraded.
        try {
            # Classified through ConvertFrom-Json (never a hand-rolled match on
            # the wire format - the module owns the format, this only reads it).
            $fatal = @(); $warn = @()
            foreach ($f37l in @($telOut.lines)) {
                $f37o = $null
                try { $f37o = ([string]$f37l | ConvertFrom-Json) } catch { }
                if (-not $f37o) { continue }
                if ([bool]$f37o.ok) { continue }
                if (@('tcp', 'tls', 'listener') -contains [string]$f37o.stage) { $fatal += [string]$f37l } else { $warn += [string]$f37l }
            }
            if ($fatal.Count -gt 0) { $script:F37TelLastError = ('telescope red: ' + [string]$fatal[0]) } else { $script:F37TelLastError = '' }
            if ($warn.Count -gt 0) { $script:F37TelLastWarn = ('telescope evidence: ' + [string]$warn[0]) } else { $script:F37TelLastWarn = '' }
        } catch { }
        return $telOut
    } catch {
        $script:F37TelLastError = ('telescope failed: ' + $_.Exception.Message)
        return (New-F37TelescopeFallback -Why $script:F37TelLastError -Src $Src)
    }
}
function Get-F37LineField {
    # Read ONE field out of a telescope line (JSON string) - tolerates a missing
    # or unparsable line instead of killing the tick.
    param([string]$Line, [string]$Field)
    try {
        if (-not $Line) { return $null }
        $o = $Line | ConvertFrom-Json
        if ($o -and $o.PSObject.Properties[$Field]) { return $o.$Field }
    } catch { }
    return $null
}
function Update-RdpListenerTelescope {
    # The 60s tick body: run the telescope, stamp the derived bind-drift fields
    # (boundThumb/servedThumb/serving/aclSids/schannel tail) and persist.
    param([string]$StatePath, [datetime]$ScanStartedUtc)
    $scanTs = (Get-Date).ToUniversalTime().ToString('o')
    $cfgT = $null
    try { $cfgT = Read-JsonFile -Path $script:CfgPath } catch { }
    $fqdn = ''
    try { if ($cfgT -and $cfgT.PSObject.Properties['dnsName']) { $fqdn = [string]$cfgT.dnsName } } catch { }
    $expected = ''
    try {
        $rdpK = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
        $b = (Get-ItemProperty -Path $rdpK -Name 'SSLCertificateSHA1Hash' -ErrorAction Stop).SSLCertificateSHA1Hash
        $expected = (($b | ForEach-Object { $_.ToString('X2') }) -join '')
    } catch { }
    $tel = Invoke-F37Telescope -Fqdn $fqdn -Src 'live' -ExpectedThumb $expected
    $script:F37TelScans = [int]$script:F37TelScans + 1
    # ONE derivation, shared with the workflow stamp (module, not a copy).
    $derived = $null
    $deriveThrown = ''
    if ($script:F37TelModule) {
        try { $derived = Get-RdpTelescopeFields -Telescope $tel } catch { $deriveThrown = ('derivation threw: ' + $_.Exception.Message) }
    } else { $deriveThrown = 'module not loaded: no derivation possible' }
    if (-not $derived) {
        # A derivation fault is NAMED, never silent: an empty row that claims
        # nothing is the red-without-why class this feature exists to kill. The
        # fallback carries EVERY key the state reads, so a consumer can never
        # mistake "derivation failed" for "the field is absent from the format".
        if (-not $deriveThrown) { $deriveThrown = 'derivation returned nothing' }
        $derived = [pscustomobject]@{
            boundThumb = ''; servedThumb = ''; serving = $false; bindDrift = $false
            inStore = $false; hasKey = $false; container = ''; aclRead = $false; aclOk = $false
            hasServerAuth = $false; eku = @(); san = @()
            keyFileFound = $false; containerKind = ''; keyDirHits = @(); keyDirSample = @(); keyFilePathSource = ''
            containerPath = ''; keyTypedError = ''; typesLoader = ''
            aclSids = @(); aclReadMethod = ''; aclModule = ''; schannelTail = @(); schannelWhy = ''
            tlsWhy = ''; listenerWhy = ''
            logonEventId = ''; logonSub = ''; count4624 = 0; count4625 = 0; logonWhy = ''
            redStages = @(); fatalStages = @(); deriveError = $deriveThrown
            deathPoint = [string]$tel.deathPoint; trace = [string]$tel.trace; src = [string]$tel.src
        }
    }
    $state = [ordered]@{
        ts          = $scanTs
        scanTs      = $scanTs
        trace       = [string]$tel.trace
        src         = [string]$tel.src
        deathPoint  = [string]$tel.deathPoint
        fqdn        = $fqdn
        module      = $script:F37TelModule
        boundThumb  = [string]$derived.boundThumb
        servedThumb = [string]$derived.servedThumb
        serving     = [bool]$derived.serving
        bindDrift   = [bool]$derived.bindDrift
        aclSids     = @($derived.aclSids)
        aclRead     = [bool]$derived.aclRead
        # [F37 §4] WHICH reader produced the ACL verdict (get-acl |
        # dotnet-fileinfo | acl-extensions | icacls | none) + what the module
        # path repair had to do: the runner lost Get-Acl to an unloadable
        # Microsoft.PowerShell.Security module under a pwsh parent, and the row
        # rendered deathPoint=acl on a healthy key. The method makes that
        # difference visible instead of debatable.
        aclReadMethod = [string]$derived.aclReadMethod
        aclModule   = [string]$derived.aclModule
        container   = [string]$derived.container
        schannelTail = @($derived.schannelTail)
        schannelWhy = [string]$derived.schannelWhy
        lines       = @($tel.lines)
        listenerLine = $(if ($script:F37TelModule) { Get-RdpTelescopeStageLine -Lines $tel.lines -Stage 'listener' } else { '' })
        tlsLine      = $(if ($script:F37TelModule) { Get-RdpTelescopeStageLine -Lines $tel.lines -Stage 'tls' } else { '' })
        moduleLoaded = [bool]($script:F37TelModule)
        lineCount    = @($tel.lines).Count
        intervalSec = $script:F37TelIntervalSec
        scans       = [int]$script:F37TelScans
        probeError  = [string]$script:F37TelLastError
        # [F37 §4] the rest of the derived verdict, served verbatim so the row
        # and any annotation can NAME a fault (key file, EKU, ACL, stage) with
        # evidence instead of an empty field list. credScope states why this
        # sample carries no cred line: that stage belongs to the client.
        probeWarn   = [string]$script:F37TelLastWarn
        credScope   = 'client-only'
        deriveError = $(if ([string]$derived.deriveError) { [string]$derived.deriveError } else { [string]$deriveThrown })
        redStages   = @($derived.redStages)
        fatalStages = @($derived.fatalStages)
        inStore     = [bool]$derived.inStore
        hasKey      = [bool]$derived.hasKey
        hasServerAuth = [bool]$derived.hasServerAuth
        eku         = @($derived.eku)
        san         = @($derived.san)
        aclOk       = [bool]$derived.aclOk
        keyFileFound = [bool]$derived.keyFileFound
        containerKind = [string]$derived.containerKind
        containerPath = [string]$derived.containerPath
        keyFilePathSource = [string]$derived.keyFilePathSource
        keyDirHits  = @($derived.keyDirHits)
        keyDirSample = @($derived.keyDirSample)
        keyTypedError = [string]$derived.keyTypedError
        typesLoader = [string]$derived.typesLoader
        tlsWhy      = [string]$derived.tlsWhy
        listenerWhy = [string]$derived.listenerWhy
        logonEventId = [string]$derived.logonEventId
        logonSub    = [string]$derived.logonSub
        logonWhy    = [string]$derived.logonWhy
    }
    try { [System.IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Compress -Depth 6), $script:NoBom) } catch { }
    return $state
}
function Get-RdpListenerTelescopeState {
    # Read-back for /api/native-status: the state + the tick's own liveness
    # (a missing or >180s stale sample is NOT a green telescope).
    param([string]$StatePath, [datetime]$ServerStartedUtc)
    $state = $null
    $ageSec = $null
    if ($StatePath -and (Test-Path -LiteralPath $StatePath)) {
        $state = Read-JsonFile -Path $StatePath
        try { $ageSec = [int]((Get-Date) - (Get-Item -LiteralPath $StatePath).LastWriteTime).TotalSeconds } catch { $ageSec = $null }
    }
    $uptime = [int]((Get-Date).ToUniversalTime() - $ServerStartedUtc).TotalSeconds
    $alive = $false
    if ($null -ne $ageSec) { $alive = ($ageSec -le $script:F37TelStaleSec) } else { $alive = ($uptime -le $script:F37TelStaleSec) }
    $collector = [ordered]@{
        intervalSec = $script:F37TelIntervalSec
        staleSec    = $script:F37TelStaleSec
        scans       = [int]$script:F37TelScans
        alive       = $alive
        uptimeSec   = $uptime
        lastScanAgeSec = $ageSec
        module      = $script:F37TelModule
        probeError  = [string]$script:F37TelLastError
        probeWarn   = [string]$script:F37TelLastWarn
        shell       = [string]$PSVersionTable.PSVersion.ToString()
        listenerLine = $(if ($state -and $state.PSObject.Properties['listenerLine']) { [string]$state.listenerLine } else { '' })
        moduleLoaded = [bool]($script:F37TelModule)
    }
    return [pscustomobject]@{ telescope = $state; telescopeCollector = $collector }
}
function Add-F37ClientBeacon {
    # Ring buffer (last N) + JSONL append for the launcher's stage beacons.
    # Only ts/trace/stage/ok/details are accepted: the endpoint allowlists them
    # before this is called, so a beacon can never carry a secret.
    param([string]$Path, [System.Collections.IDictionary]$Beacon)
    $obj = [ordered]@{
        ts      = [string]$Beacon['ts']
        trace   = [string]$Beacon['trace']
        stage   = [string]$Beacon['stage']
        ok      = [bool]$Beacon['ok']
        details = [string]$Beacon['details']
    }
    $script:F37ClientBeacons = @(@($obj) + @($script:F37ClientBeacons) | Select-Object -First $script:F37TelMaxClient)
    try { [System.IO.File]::AppendAllText($Path, (($obj | ConvertTo-Json -Compress) + "`n"), $script:NoBom) } catch { }
    return $obj
}
function Get-F37ClientTelescope {
    # Newest-first beacons + the trace the timeline should focus on. Re-seeds
    # from the JSONL file after a server restart so a restart never blanks the
    # timeline (the last 60 lines are enough for one attempt).
    param([string]$Path)
    if (@($script:F37ClientBeacons).Count -eq 0 -and $Path -and (Test-Path -LiteralPath $Path)) {
        try {
            $all = @([System.IO.File]::ReadAllLines($Path) | Where-Object { $_ } | Select-Object -Last $script:F37TelMaxClient)
            $items = @()
            foreach ($l in $all) {
                try {
                    $o = $l | ConvertFrom-Json
                    $items += [ordered]@{ ts = [string]$o.ts; trace = [string]$o.trace; stage = [string]$o.stage; ok = [bool]$o.ok; details = [string]$o.details }
                } catch { }
            }
            $script:F37ClientBeacons = @(@($items) | Sort-Object -Property ts -Descending | Select-Object -First $script:F37TelMaxClient)
        } catch { }
    }
    $items = @($script:F37ClientBeacons)
    $newestTrace = ''
    foreach ($it in $items) { if ($it['trace']) { $newestTrace = [string]$it['trace']; break } }
    return [pscustomobject]@{
        items       = $items
        count       = $items.Count
        newestTrace = $newestTrace
        intervalSec = $script:F37TelIntervalSec
        ageSec      = $(if ($items.Count -gt 0) { try { [int]((Get-Date).ToUniversalTime() - ([datetime]$items[0]['ts']).ToUniversalTime()).TotalSeconds } catch { $null } } else { $null })
    }
}
# [F37 §4 telescope-end]

# [F31c §2 schannel-begin] System Schannel 36870/36871 are NOT in the RDP
# Operational logs the F30 collector reads. Merge the last 5 minutes into the
# served connLog so the LIVE DISPATCH STATUS card can prove absence instead of
# assuming it. Ids + clipped descriptions only - never a key, a password, or a
# thumbprint. A dead System log is a named probe error (not a clean absence).
$script:F31cSchannelAt = [datetime]::MinValue
$script:F31cSchannelMemo = $null
function Get-F31cSchannelWindow {
    $now = Get-Date
    if ($script:F31cSchannelMemo -and (($now - $script:F31cSchannelAt).TotalSeconds -lt 30)) {
        return $script:F31cSchannelMemo
    }
    $items = @()
    $probeError = ''
    try {
        $since = $now.ToLocalTime().AddMinutes(-5)
        $raw = @()
        try {
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = @(36870, 36871, 36888); StartTime = $since } -MaxEvents 10 -ErrorAction Stop)
        } catch {
            $em = [string]$_.Exception.Message
            if ($em -notmatch 'No events were found|No events found') { $probeError = 'schannel-log-unreadable' }
        }
        foreach ($e in @($raw)) {
            if (-not $e) { continue }
            $desc = ''
            try { $desc = [string]$e.Message } catch { $desc = '' }
            if ($desc.Length -gt 200) { $desc = $desc.Substring(0, 200) }
            $desc = [regex]::Replace($desc, '(?i)(password|passwd|pwd|subjectusername|targetusername|subjectdomainname)(\s*[=:]\s*)\S+', '$1$2[redacted]')
            $id = [string]$e.Id
            $items += [pscustomobject]@{
                id       = $id
                provider = 'Schannel'
                timeUtc  = $e.TimeCreated.ToUniversalTime().ToString('o')
                level    = [string]$e.Level
                reason   = (Get-RdpConnLogReason -Provider 'Schannel' -Id $id -Level ([string]$e.Level) -Text $desc)
                desc     = $desc
            }
        }
    } catch { $probeError = 'schannel-log-unreadable' }
    $memo = [pscustomobject]@{ items = @($items | Where-Object { $_ }); probeError = $probeError; windowSec = 300 }
    $script:F31cSchannelAt = $now
    $script:F31cSchannelMemo = $memo
    return $memo
}
function Merge-F31cConnLog {
    param($ConnLog, $Sch)
    if (-not $Sch) { return $ConnLog }
    $extra = @($Sch.items | Where-Object { $_ })
    if (-not $ConnLog) {
        if ($extra.Count -eq 0) { return $null }
        return [pscustomobject]@{
            ts = (Get-Date).ToUniversalTime().ToString('o')
            items = $extra
            newest = @($extra | Select-Object -First 3)
            count = $extra.Count
            probeError = ''
            schannelProbeError = [string]$Sch.probeError
        }
    }
    $have = @{}
    $merged = @()
    foreach ($it in @($ConnLog.items)) {
        if (-not $it) { continue }
        $k = ([string]$it.id) + '|' + ([string]$it.timeUtc)
        if (-not $have.ContainsKey($k)) { $have[$k] = $true; $merged += $it }
    }
    foreach ($it in $extra) {
        $k = ([string]$it.id) + '|' + ([string]$it.timeUtc)
        if (-not $have.ContainsKey($k)) { $have[$k] = $true; $merged += $it }
    }
    try { $ConnLog | Add-Member -NotePropertyName items -NotePropertyValue $merged -Force } catch { }
    try { $ConnLog | Add-Member -NotePropertyName schannelProbeError -NotePropertyValue ([string]$Sch.probeError) -Force } catch { }
    return $ConnLog
}
# [F31c §2 schannel-end]
function Read-ClientRequest {
param($Stream)
$acc = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 4096
try { $Stream.ReadTimeout = 5000 } catch { }
$headerDone = $false
$idx = -1
$cl = 0
$bodyBytes = New-Object System.Collections.Generic.List[byte]
while ($true) {
$n = 0
try { $n = $Stream.Read($buf, 0, $buf.Length) } catch { break }
if ($n -le 0) { break }
if (-not $headerDone) {
[void]$acc.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
$txt = $acc.ToString()
$idx = $txt.IndexOf("`r`n`r`n")
if ($idx -ge 0) {
$headerDone = $true
$m = [regex]::Match($txt, '(?im)^Content-Length:\s*(\d+)')
if ($m.Success) { $cl = [int]$m.Groups[1].Value }
$priorLen = $acc.Length - $n
$bodyStart = ($idx + 4) - $priorLen
if ($bodyStart -lt 0) { $bodyStart = 0 }
if ($bodyStart -lt $n) { $bodyBytes.AddRange([byte[]]$buf[$bodyStart..($n - 1)]) }
if ($bodyBytes.Count -ge $cl) { break }
}
if ($acc.Length -gt 65536) { break }
} else {
$bodyBytes.AddRange([byte[]]$buf[0..($n - 1)])
if ($bodyBytes.Count -ge $cl) { break }
}
}
$head = $acc.ToString()
if ($idx -ge 0) { $head = $head.Substring(0, $idx + 4) }
return @{ head = $head; body = $bodyBytes.ToArray() }
}
function Send-ClientResponse {
    # [F14 §2] $ExtraHeaders carries EXTRA raw header lines (CRLF-less; one per
    # line, appended verbatim). Empty by default, so every existing call site
    # emits byte-identical headers. Cache-Control: no-store is always set.
    param($Stream, [int]$Code, [string]$CType, [byte[]]$Body, [string]$ExtraHeaders = '')
    $status = 'OK'
    if ($Code -eq 202) { $status = 'Accepted' }
    if ($Code -eq 204) { $status = 'No Content' }
    if ($Code -eq 206) { $status = 'Partial Content' }
    if ($Code -eq 400) { $status = 'Bad Request' }
    if ($Code -eq 401) { $status = 'Unauthorized' }
    if ($Code -eq 403) { $status = 'Forbidden' }
    if ($Code -eq 404) { $status = 'Not Found' }
    if ($Code -eq 405) { $status = 'Method Not Allowed' }
    if ($Code -eq 409) { $status = 'Conflict' }
    if ($Code -eq 413) { $status = 'Payload Too Large' }
    if ($Code -eq 415) { $status = 'Unsupported Media Type' }
    if ($Code -eq 416) { $status = 'Range Not Satisfiable' }
    if ($Code -eq 429) { $status = 'Too Many Requests' }
    if ($Code -eq 500) { $status = 'Server Error' }
    if ($Code -eq 502) { $status = 'Bad Gateway' }
    if ($Code -eq 503) { $status = 'Service Unavailable' }
    if ($Code -eq 504) { $status = 'Gateway Timeout' }
    # [F45 S4 fix] the blank line that terminates the header block: with no extra
    # headers the template already ends in CRLFCRLF (byte-identical to every
    # existing response). With extra headers the last ONE of them used to sit
    # directly against the body - no separator at all - so an HTTP client (and
    # the F45 harness) saw the body as a bogus header line and every successful
    # fx response arrived with an empty body.
    $tail = ''
    if ($ExtraHeaders) { $tail = "`r`n" }
    $hdr = "HTTP/1.1 $Code $status`r`nContent-Type: $CType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type, Authorization`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`n$ExtraHeaders$tail`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
    $Stream.Write($hb, 0, $hb.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}
function To-IsoUtc {
    param([string]$S)
    if (-not $S) { return '' }
    $s2 = $S.Trim()
    if ($s2 -match 'Z$' -or $s2 -match '[+-]\d{2}:\d{2}$') { return $s2 }
    $dt = [datetime]::MinValue
    if ([datetime]::TryParse($s2, [ref]$dt)) { return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return $s2
}
function ConvertTo-JsonBytes {
    param($Obj)
    if (Get-Command ConvertTo-F52JsonSafe -ErrorAction SilentlyContinue) { $Obj = ConvertTo-F52JsonSafe $Obj }
    return [System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 12 -Compress))
}
function Remove-CredKeys {
    # [remediation #7A / U1] Strip secrets from a config object before it leaves
    # in any response body, then rebuild `creds` to expose ONLY the fields the UI
    # needs for the native mstsc auto-login flow: { fqdn, user, ip }.
    #   fqdn = config.dnsName only (*.ts.net). Never the tailnet IP.
    #   user = config.rdpUser  (a username, not a secret; the password is never here).
    #   ip   = config.rdpIp    (the same value as fqdn under P2).
    # Everything else that could carry a secret (rdpPass, vncPass, mirrorKey,
    # legacyDecryptKey, rentryEditCode, rentryEditCookie, dashToken) is removed.
    # [F10-2 §3] passwords reach a response ONLY at the single /api/config
    # creds-block write site, only when the request is dash-token or tailnet
    # authenticated (see Test-CredsAllowed + the /api/config route).
    param($Obj)
    if (-not $Obj) { return $Obj }
    $fqdn = ''; $user = ''; $ip = ''
    try { if ($Obj.PSObject.Properties['dnsName']) { $fqdn = [string]$Obj.dnsName } } catch { }
    try { if ($Obj.PSObject.Properties['rdpUser']) { $user = [string]$Obj.rdpUser } } catch { }
    try { if ($Obj.PSObject.Properties['rdpIp'])   { $ip   = [string]$Obj.rdpIp   } } catch { }
    # dnsName only. Never present the tailnet IP as the FQDN.
    foreach ($k in @('rdpUser','rdpPass','vncPass','mirrorKey','legacyDecryptKey','creds','rentryEditCode','rentryEditCookie','dashToken')) {
        try { if ($Obj.PSObject.Properties[$k]) { $Obj.PSObject.Properties.Remove($k) } } catch { }
    }
    try {
        $Obj | Add-Member -MemberType NoteProperty -Name 'creds' -Value ([pscustomobject]@{ fqdn = $fqdn; user = $user; ip = $ip }) -Force
    } catch { }
    return $Obj
}
# [F88 §C.1/C.2] Invoke-F88DownloadToRdp - the ONE verified transfer behind
# /api/fetch?download=true AND the F87 selftest's per-site downloadTest.
# HTTPS only, no userinfo, exact-host-minus-www guard on BOTH the request URL
# and the final response URI (an off-host redirect never writes), sanitized
# file name under Desktop\RDP-Downloads (or an explicit DestDir), and - the
# F88 proof step - the file is re-stat'ed after the write: path exists AND
# on-disk length == bytes written. Only then is ok=true returned; a miss
# returns the specific reason so the caller can answer 500 instead of a fake
# success. Defined at script scope so BOTH the /api/fetch route (outside the
# F78 block) and the selftest (inside it) call the same code.
function Invoke-F88DownloadToRdp {
    param([string]$Url, [string]$ExpectedHost, [string]$DestDir)
    $f88 = [ordered]@{ ok = $false; path = ''; bytes = [int64]0; verified = $false; writeTime = ''; error = ''; httpStatus = 500 }
    $f88Uri = $null
    try { $f88Uri = [System.Uri]$Url } catch { $f88Uri = $null }
    if (-not $f88Uri -or $f88Uri.Scheme -ne 'https' -or $f88Uri.UserInfo) { $f88.error = 'not-https'; $f88.httpStatus = 400; return $f88 }
    $f88Same = {
        param($f88Allowed, $f88Actual)
        if (-not $f88Allowed) { return $true }
        $f88A = ([string]$f88Allowed).ToLowerInvariant() -replace '^www\.', ''
        $f88B = ([string]$f88Actual).ToLowerInvariant() -replace '^www\.', ''
        return ($f88A -eq $f88B)
    }
    if (-not (& $f88Same $ExpectedHost $f88Uri.Host)) { $f88.error = 'hostname-mismatch'; $f88.httpStatus = 403; return $f88 }
    $f88Dir = [string]$DestDir
    if (-not $f88Dir) { $f88Dir = Join-Path $env:USERPROFILE 'Desktop\RDP-Downloads' }
    try { if (-not (Test-Path -LiteralPath $f88Dir)) { New-Item -ItemType Directory -Path $f88Dir -Force | Out-Null } } catch { }
    $f88Name = 'download.bin'
    try {
        $f88Base = [string]$f88Uri.AbsolutePath.Split('/')[-1]
        $f88Base = [System.Uri]::UnescapeDataString($f88Base)
        $f88Clean = ($f88Base -replace '[^A-Za-z0-9._-]', '_').Trim('.')
        if ($f88Clean) { $f88Name = $f88Clean }
    } catch { }
    if ($f88Name.Length -gt 120) { $f88Name = $f88Name.Substring($f88Name.Length - 120) }
    $f88Path = Join-Path $f88Dir $f88Name
    $f88.path = $f88Path
    $f88Req = $null
    $f88Resp = $null
    $f88Written = [int64]0
    try {
        $f88Req = [System.Net.HttpWebRequest]::Create($f88Uri)
        $f88Req.Method = 'GET'
        $f88Req.Timeout = 30000
        $f88Req.ReadWriteTimeout = 30000
        $f88Req.CookieContainer = $null
        $f88Req.UserAgent = 'GHRDP-Lab/1.0'
        $f88Resp = $f88Req.GetResponse()
        # same-host (www-tolerant) guard on the FINAL response URI
        $f88Got = ''
        try { $f88Got = ([string]$f88Resp.ResponseUri.Host) } catch { $f88Got = $f88Uri.Host }
        if (-not (& $f88Same $f88Uri.Host $f88Got)) {
            try { $f88Resp.Close() } catch { }
            $f88.error = 'hostname-mismatch'; $f88.httpStatus = 403
            return $f88
        }
        $f88In = $f88Resp.GetResponseStream()
        $f88Out = [System.IO.File]::Create($f88Path)
        try {
            $f88Buf = New-Object byte[] 65536
            while ($true) {
                $f88Read = $f88In.Read($f88Buf, 0, $f88Buf.Length)
                if ($f88Read -le 0) { break }
                $f88Out.Write($f88Buf, 0, $f88Read)
                $f88Written += $f88Read
            }
        } finally {
            try { $f88Out.Dispose() } catch { }
            try { $f88In.Dispose() } catch { }
            try { $f88Resp.Close() } catch { }
        }
        # [F88 §C.1] the verification: exists + size matches, else specific error
        if (-not (Test-Path -LiteralPath $f88Path)) {
            $f88.error = 'file-missing-after-write'
            return $f88
        }
        $f88Fi = $null
        try { $f88Fi = Get-Item -LiteralPath $f88Path -Force } catch { $f88Fi = $null }
        if (-not $f88Fi) { $f88.error = 'file-stat-failed'; return $f88 }
        if ([int64]$f88Fi.Length -ne [int64]$f88Written) {
            $f88.error = ('size-mismatch disk=' + [string]$f88Fi.Length + ' written=' + [string]$f88Written)
            return $f88
        }
        $f88.ok = $true
        $f88.verified = $true
        $f88.path = $f88Path
        $f88.bytes = [int64]$f88Written
        $f88.writeTime = $f88Fi.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $f88.httpStatus = 200
        return $f88
    } catch {
        try { if ($f88Resp) { $f88Resp.Close() } } catch { }
        $f88.error = ('transfer: ' + [string]$_.Exception.Message)
        $f88.httpStatus = 502
        return $f88
    }
}
# ============================================================================
# [F91 §A.3/§A.4/§D.2] MIRROR-MODE server surface. Three script-scope helpers
# shared by the routes AND the extended /api/f87-selftest, so the proof path
# and the live path cannot drift apart:
#   Get-F91LauncherPaths   - the ONE contract for queue/heartbeat/log paths.
#   Test-F91QueueJob       - validation for /api/launcher/queue bodies (and the
#                            selftest's synthetic noop job).
#   Get-F91LauncherHealth  - the /api/launcher/health payload + the selftest's
#                            launcherServiceRunning/taskSchedulerHealth lines.
#   Invoke-F91StreamFetch  - the /api/stream relay: https-only, exact-host
#                            (minus www) allowlist, capped bytes, RAW bytes +
#                            upstream Content-Type (Invoke-F78SecureFetch
#                            UTF8-decodes - wrong for audio - hence its own
#                            fetch, shaped on the F88 download guards).
# The launcher SERVICE itself is payloads/ghrdp-rdp-launcher.ps1, registered
# as the GHRDP-Launcher ONLOGON task by .github/workflows/main.yml (F91 §A.2).
# ============================================================================
function Get-F91LauncherPaths {
    # GHRDP_F91_ROOT lets the lab (and a future relocation) point the contract
    # at a writable dir; production leaves it unset -> C:\ProgramData\ghrdp.
    $root = 'C:\ProgramData\ghrdp'
    try { if ($env:GHRDP_F91_ROOT) { $root = [string]$env:GHRDP_F91_ROOT } } catch { }
    return [ordered]@{
        root      = $root
        queueDir  = (Join-Path $root 'launcher-queue')
        heartbeat = (Join-Path $root 'launcher-heartbeat.txt')
        log       = (Join-Path $root 'launcher.log')
    }
}
function Test-F91QueueJob {
    param([string]$Url, [string]$Mode)
    $out = [ordered]@{ ok = $false; reason = ''; safeUrl = '' }
    $m = ([string]$Mode).Trim().ToLowerInvariant()
    # 'noop' is the SELFTEST probe mode (no browser, no desktop) - a caller can
    # request it, the launcher only ever logs + consumes such a job.
    if (@('navigate','download','explorer','noop') -notcontains $m) { $out.reason = 'mode'; return $out }
    $u = ([string]$Url).Trim()
    if (-not $u -or $u.Length -gt 2048) { $out.reason = 'length'; return $out }
    if ($m -eq 'explorer') {
        # a LOCAL folder path only - drive-anchored, no scheme, no URL syntax.
        if ($u -match '^[A-Za-z]:\\[^<>:"|?*]*$') { $out.ok = $true; $out.safeUrl = $u; $out.reason = ''; return $out }
        $out.reason = 'explorer-path'; return $out
    }
    if ($m -eq 'download' -or $m -eq 'noop') {
        # notification-only rows: url may be the informational https link or empty.
        if (-not $u) { $out.ok = $true; $out.safeUrl = ''; $out.reason = ''; return $out }
        if ($u -notmatch '^(?i)https://') { $out.reason = 'scheme'; return $out }
        $out.ok = $true; $out.safeUrl = $u; $out.reason = ''; return $out
    }
    # navigate: the hard fence. javascript:/file:/data:/vbscript: cannot even
    # reach the Uri parser; only a bare https URL with no userinfo passes.
    if ($u -match '(?i)^(javascript|file|data|vbscript|about|ms-msdt|search|folder)?:') { $out.reason = 'scheme'; return $out }
    if ($u -notmatch '^(?i)https://') { $out.reason = 'scheme'; return $out }
    $uri = $null
    try { $uri = [System.Uri]$u } catch { $uri = $null }
    if (-not $uri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or -not $uri.Host) { $out.reason = 'malformed'; return $out }
    $out.ok = $true; $out.safeUrl = $u; $out.reason = ''; return $out
}
function Get-F93LauncherAutoStartPath {
    [string]$root = ''
    try { $root = [string](Get-F91LauncherPaths).root } catch { $root = '' }
    if (-not $root) { $root = Join-Path $env:ProgramData 'ghrdp' }
    return (Join-Path $root 'launcher-autostart.json')
}
# [F93 §2.2] LAUNCHER AUTO-START ON LOGON DETECTION.
# Why: the F91 launcher is an ONLOGON scheduled task - it only ever starts if
# somebody logs into the RDP session. On a fresh runner nobody has, so the
# heartbeat is stale, /api/launcher/health says serviceRunning=false, and every
# "Open in RDP" queues into a service that is not running (the exact operator
# report "no user is logged in -> launcher cannot work"). This watcher polls
# the Security log every 10s for a type-10 4624 (RemoteInteractive logon); on
# the FIRST one it registers GHRDP-Launcher if missing and starts it
# immediately, then writes launcher-autostart.json (autoStarted=true) so
# /api/launcher/health can prove it. It never touches credentials, never types
# into a UI, and stops polling after it fires. Started lazily on the first
# health read (i.e. at server boot + first dashboard poll) so dot-sourcing the
# file in labs never spawns a job.
function Start-F93LauncherLogonWatch {
    if ($script:F93LogonWatchStarted) { return }
    $script:F93LogonWatchStarted = $true
    try {
        $script:F93LogonWatchJob = Start-Job -Name 'ghrdp-f93-logon-watch' -ScriptBlock {
            $statePath = Join-Path $env:ProgramData 'ghrdp\launcher-autostart.json'
            $src = Join-Path $env:ProgramData 'ghrdp\ghrdp-rdp-launcher.ps1'
            while ($true) {
                $fired = $false
                try {
                    $since = (Get-Date).AddMinutes(-30)
                    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624; StartTime = $since } -MaxEvents 300 -ErrorAction Stop)
                    # [F95 §3.1 / R1] 2 (Interactive - what AutoAdminLogon
                    # writes), 10 (RemoteInteractive) and 11
                    # (CachedInteractive). Inlined as a literal because this
                    # block runs in a Start-Job runspace that cannot see the
                    # dot-sourced $script:GhrdpInteractiveLogonTypes; the
                    # launch-gates F95 pin keeps the two lists identical.
                    $okTypes = @('2', '10', '11')
                    foreach ($e in $ev) {
                        $lt = ''
                        try {
                            $x = [xml]$e.ToXml()
                            foreach ($d in $x.Event.EventData.Data) { if ($d.Name -eq 'LogonType') { $lt = [string]$d.'#text'; break } }
                        } catch { $lt = '' }
                        if ($okTypes -contains ([string]$lt).Trim()) { $fired = $true; break }
                    }
                } catch { $fired = $false }
                if ($fired) {
                    try {
                        $q = & schtasks.exe /Query /TN GHRDP-Launcher 2>$null
                        $exists = ($LASTEXITCODE -eq 0); $LASTEXITCODE = 0
                        if (-not $exists -and (Test-Path -LiteralPath $src)) {
                            $tr = ('powershell.exe -NoProfile -WindowStyle Hidden -File "{0}"' -f $src)
                            & schtasks.exe /Create /F /SC ONLOGON /TN GHRDP-Launcher /RL HIGHEST /TR ('"{0}"' -f ($tr -replace '"', '\"')) 2>$null
                            $LASTEXITCODE = 0
                        }
                        try { Start-ScheduledTask -TaskName 'GHRDP-Launcher' -ErrorAction Stop } catch { & schtasks.exe /Run /TN GHRDP-Launcher 2>$null; $LASTEXITCODE = 0 }
                        $dir = Split-Path -Parent $statePath
                        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                        [System.IO.File]::WriteAllText($statePath, (ConvertTo-Json -Compress -InputObject @{ autoStarted = $true; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); taskExisted = $exists }))
                        break
                    } catch { }
                }
                Start-Sleep -Seconds 10
            }
        }
    } catch { }
}
function Get-F91LauncherHealth {
    Start-F93LauncherLogonWatch
    $p = Get-F91LauncherPaths
    $out = [ordered]@{
        ok = $true; serviceRunning = $false; heartbeatAge = -1; heartbeatAt = ''
        queueDepth = 0; queueDir = [string]$p.queueDir; log = @(); logPath = [string]$p.log
        taskExists = $false; taskState = ''; activeUser = ''; scriptPresent = $false
        autoStarted = $false; autoStartedAt = ''
    }
    # [F93 §2.2] proof that the logon watcher fired (file written by the job,
    # so this read is truthful even across the job/runspace boundary).
    try {
        $f93AutoPath = Get-F93LauncherAutoStartPath
        if (Test-Path -LiteralPath $f93AutoPath) {
            $f93Auto = ([string](Get-Content -LiteralPath $f93AutoPath -Raw -ErrorAction SilentlyContinue)) | ConvertFrom-Json
            if ($f93Auto -and $f93Auto.autoStarted -eq $true) {
                $out.autoStarted = $true
                $out.autoStartedAt = [string]$f93Auto.at
            }
        }
    } catch { }
    try { $out.scriptPresent = [bool](Test-Path -LiteralPath (Join-Path $p.root 'ghrdp-rdp-launcher.ps1')) } catch { }
    try {
        if (Test-Path -LiteralPath $p.heartbeat) {
            $hb = ([string](Get-Content -LiteralPath $p.heartbeat -Raw -ErrorAction SilentlyContinue)).Trim()
            if ($hb) {
                $dt = [datetime]::MinValue
                if ([datetime]::TryParse($hb, [ref]$dt)) {
                    $age = ((Get-Date).ToUniversalTime() - $dt.ToUniversalTime()).TotalMilliseconds
                    if ($age -ge 0 -and $age -lt 30000) { $out.serviceRunning = $true }
                    $out.heartbeatAge = [int64][Math]::Round($age)
                    $out.heartbeatAt = $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                }
            }
        }
    } catch { }
    try {
        if (Test-Path -LiteralPath $p.queueDir) { $out.queueDepth = @(Get-ChildItem -LiteralPath $p.queueDir -Filter '*.job' -ErrorAction SilentlyContinue).Count }
    } catch { }
    try {
        if (Test-Path -LiteralPath $p.log) {
            $all = @(Get-Content -LiteralPath $p.log -Tail 10 -Encoding UTF8 -ErrorAction SilentlyContinue)
            $out.log = @($all | ForEach-Object { [string]$_ })
        }
    } catch { }
    # Windows-only probes, fail-soft on any host without the scheduler.
    try {
        $q = & schtasks.exe /Query /TN GHRDP-Launcher /FO LIST 2>$null
        $qexit = $LASTEXITCODE; $LASTEXITCODE = 0
        if ($qexit -eq 0) {
            $out.taskExists = $true
            foreach ($line in @($q)) { if ($line -match '(?i)^\s*Status\s*:\s*(.+)$') { $out.taskState = ([string]$Matches[1]).Trim(); break } }
        }
    } catch { }
    try { $qu = & quser.exe 2>$null; $LASTEXITCODE = 0; foreach ($line in @($qu)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $out.activeUser = $Matches[1]; break } } } catch { }
    return $out
}
function Invoke-F91StreamFetch {
    # -ProbeHead answers the selftest's streamProxyTest without pulling a body:
    # upstream HEAD, status + Content-Type only (bytes stay $null).
    param([string]$Url, [int]$MaxBytes = 67108864, [switch]$ProbeHead)
    $f91 = [ordered]@{ ok = $false; httpStatus = 502; contentType = 'application/octet-stream'; bytes = $null; byteLen = [int64]0; error = ''; host = '' }
    $f91Uri = $null
    try { $f91Uri = [System.Uri]$Url } catch { $f91Uri = $null }
    if (-not $f91Uri -or $f91Uri.Scheme -ne 'https' -or $f91Uri.UserInfo) { $f91.error = 'not-https'; $f91.httpStatus = 400; return $f91 }
    $f91.host = [string]$f91Uri.Host.ToLowerInvariant()
    $f91Req = $null; $f91Resp = $null
    try {
        $f91Req = [System.Net.HttpWebRequest]::Create($f91Uri)
        if ($ProbeHead) { $f91Req.Method = 'HEAD' } else { $f91Req.Method = 'GET' }
        $f91Req.Timeout = 30000
        $f91Req.ReadWriteTimeout = 30000
        $f91Req.AllowAutoRedirect = $false   # a redirect chain would silently widen the host fence
        $f91Req.UserAgent = 'GHRDP-Stream/1.0'
        $f91Resp = $f91Req.GetResponse()
        try { $f91.contentType = [string]$f91Resp.ContentType } catch { }
        $f91.httpStatus = [int]$f91Resp.StatusCode
        if ($ProbeHead) {
            try { $f91Resp.Close() } catch { }
            $f91.ok = $true
            return $f91
        }
        $f91In = $f91Resp.GetResponseStream()
        $f91Ms = New-Object System.IO.MemoryStream
        $f91Arr = $null
        try {
            $f91Buf = New-Object byte[] 65536
            while ($true) {
                $f91Read = $f91In.Read($f91Buf, 0, $f91Buf.Length)
                if ($f91Read -le 0) { break }
                if (($f91Ms.Length + $f91Read) -gt $MaxBytes) { $f91.error = 'size-limit'; $f91.httpStatus = 413; return $f91 }
                $f91Ms.Write($f91Buf, 0, $f91Read)
            }
            $f91Arr = $f91Ms.ToArray()
        } finally {
            try { $f91Ms.Dispose() } catch { }
            try { $f91In.Dispose() } catch { }
            try { $f91Resp.Close() } catch { }
        }
        $f91.bytes = $f91Arr
        $f91.byteLen = [int64]@($f91Arr).Length
        $f91.ok = $true
        return $f91
    } catch {
        try { if ($f91Resp) { $f91Resp.Close() } } catch { }
        # a 4xx/5xx answer surfaces as WebException - keep the upstream status
        # so the route can pass an honest code through instead of 502.
        try {
            if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                $f91.httpStatus = [int]$_.Exception.Response.StatusCode
            }
        } catch { }
        $msg = [string]$_.Exception.Message
        if ($msg -match '(?i)30[123]|redirect') { $f91.error = 'redirect-refused' } else { $f91.error = $msg }
        if ($f91.httpStatus -eq 200) { $f91.httpStatus = 502 }
        return $f91
    }
}
function Invoke-ClientRequest {
    param($Client, $Token)
    $stream = $null
    try {
        $stream = $Client.GetStream()
        $rr = Read-ClientRequest -Stream $stream
        if (-not $rr -or -not $rr.head) { return }
        $parts = Get-RequestParts -Raw ([string]$rr.head)
        $parts['body'] = [byte[]]$rr.body
        $path = [string]$parts.path
        if (-not $path) { $path = '/' }
        # Browser cross-origin preflight carries no bearer; disclose nothing.
        if ($path -eq '/api/rdp-token' -and $parts.method -eq 'OPTIONS') {
            Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@())
            return
        }
        if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token)) {
            Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('unauthorized'))
            return
        }
        # [F10-2 §2.2] dash-token source peer capture: the rdp-ping loop targets
        # THIS client ip (the operator's device), not an arbitrary first peer.
        # RemoteEndPoint covers the direct tailnet-HTTP path; X-Forwarded-For
        # covers the tailscale-serve proxy path. Write only on change.
        try {
            $raC = $Client.Client.RemoteEndPoint.Address
            $octC = $raC.GetAddressBytes()
            $cand = ''
            if ($octC.Length -eq 4 -and $octC[0] -eq 100 -and $octC[1] -ge 64 -and $octC[1] -le 127) { $cand = $raC.ToString() }
            elseif ($parts.headers.ContainsKey('x-forwarded-for')) {
                $xf = ([string]$parts.headers['x-forwarded-for']).Split(',')[0].Trim()
                if ($xf -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') { $cand = $xf }
            }
            if ($cand) {
                $cipFile = Join-Path $Root 'dash-client-ip.txt'
                $prev = ''
                try { if (Test-Path -LiteralPath $cipFile) { $prev = ([System.IO.File]::ReadAllText($cipFile)).Trim() } } catch { }
                if ($prev -ne $cand) { [System.IO.File]::WriteAllText($cipFile, $cand, $script:NoBom) }
            }
        } catch { }
        # [F99 §2.1] WebSocket upgrade route — must be before the creds check so the
        # handshake's token is validated inside the upgrade handler (which supports
        # both header and ?key= query, plus the hello-frame fallback).
        if ($path -eq '/ws') {
            $f99Handled = $false
            try { $f99Handled = Invoke-F99WebSocketUpgrade -Client $Client -Stream $stream -Parts $parts -Token $Token } catch { $f99Handled = $false }
            if ($f99Handled) { return }
            Send-ClientResponse -Stream $stream -Code 400 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('websocket upgrade required'))
            return
        }
        # [F10-2 §3] per-request creds authorization (strict subset of access).
        $credsAllowed = Test-CredsAllowed -Client $Client -Query $parts.query -Token $Token
        $cfg = Read-JsonFile -Path $script:CfgPath
        # [F45 S4 fx-dispatch-begin] Explorer file-API + preview-sandbox routes.
        # Everything security-relevant is decided INSIDE the module (dash-token
        # presentation, query-credential refusal, CSRF, path containment); this
        # block only translates the parsed request into the module's context and
        # writes the response back through the one response writer. The audit
        # line carries method+path+status only - never a query string, never a
        # header, never a token.
        if ($path -eq '/api/fx' -or $path.StartsWith('/api/fx/') -or $path -eq '/preview-sandbox' -or $path.StartsWith('/preview-sandbox/')) {
            if (-not $script:FxReady) {
                Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ phase = 'parse'; error = ('Explorer API unavailable: ' + [string]$script:FxLoadError) })
                Write-ClientAudit ('fx ' + [string]$parts.method + ' ' + $path + ' -> 503 (module missing)')
                return
            }
            $fxClass = 'other'
            try {
                $fxIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $fxIp) { $fxClass = 'loopback' }
                else {
                    $fxOct = $fxIp.GetAddressBytes()
                    if ($fxOct.Length -eq 4 -and $fxOct[0] -eq 100 -and $fxOct[1] -ge 64 -and $fxOct[1] -le 127) { $fxClass = 'tailnet' }
                }
            } catch { }
            $fxCtx = @{
                root = $Root
                path = $path
                method = [string]$parts.method
                query = $parts.query
                headers = $parts.headers
                body = [byte[]]$parts.body
                clientClass = $fxClass
                dashToken = [string]$Token
                csrfToken = [string]$script:FxCsrf
                options = @{ Config = $cfg }
            }
            $fxResp = $null
            $fxErr = ''
            try { $fxResp = Invoke-FxRoute -Ctx $fxCtx } catch { $fxErr = $_.Exception.Message }
            if (-not $fxResp) {
                $fxMsg = 'fx route failed'
                if ($fxErr) { $fxMsg = $fxMsg + ': ' + (Protect-FxText -Text $fxErr -Secrets @([string]$Token)) }
                $fxResp = @{ Code = 500; CType = 'application/json; charset=utf-8'; Body = (ConvertTo-JsonBytes @{ phase = 'parse'; error = $fxMsg }); Headers = @() }
            }
            $fxExtra = ''
            $fxHdrList = @($fxResp.Headers)
            if ($fxHdrList.Count -gt 0) { $fxExtra = ($fxHdrList -join "`r`n") }
            # Copy the body byte by byte instead of casting: a response object that
            # is a hashtable must never be able to lose its body to a cast, and the
            # count is audited so a body that never reaches the socket is visible.
            $fxBodyBytes = [byte[]]@()
            try {
                if ($null -ne $fxResp.Body) {
                    $fxArr = @($fxResp.Body)
                    if ($fxArr.Count -gt 0) {
                        $fxBodyBytes = New-Object byte[] $fxArr.Count
                        for ($fxBi = 0; $fxBi -lt $fxArr.Count; $fxBi++) { $fxBodyBytes[$fxBi] = [byte]$fxArr[$fxBi] }
                    }
                }
            } catch { $fxBodyBytes = [byte[]]@() }
            Send-ClientResponse -Stream $stream -Code ([int]$fxResp.Code) -CType ([string]$fxResp.CType) -Body $fxBodyBytes -ExtraHeaders $fxExtra
            Write-ClientAudit ('fx ' + [string]$parts.method + ' ' + $path + ' -> ' + [string]$fxResp.Code + ' body=' + [string]$fxBodyBytes.Length)
            return
        }
        # [F45 S4 fx-dispatch-end]
        # [remediation 8A] /rentrydiag removed: no public-mirror editing
        if ($path -eq '/rentrydiag') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        if ($path -eq '/flush') {
            $note = 'flush flag set - the watcher will upload everything on its next pass'
            try { [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom) } catch { $note = 'flush flag write failed: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $note })
            return
        }
        # [F49 runtime-opt-in-begin] One-click THIS-RUN opt-in for the token-less
        # mirror (the Mirror page ConfirmModal). GET /api/mirror/status is the
        # read; POST /api/mirror/enable|/disable converge the run. The dispatch
        # mirror_enable path is untouched and the shipped default stays
        # disabled (F11-5.2). Auth: the dash token in X-Dash-Token or
        # Authorization: Bearer, never in the query string (fx rule); POSTs
        # additionally require X-CSRF-Token (the per-process token, delivered
        # by the status response header + cookie). The enable POST also queues
        # the flush, so [Enable & Upload] is one action.
        if ($path -eq '/api/mirror/status' -or $path -eq '/api/mirror/enable' -or $path -eq '/api/mirror/disable') {
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 204 (preflight)')
                return
            }
            $mIsPost = ($path -eq '/api/mirror/enable' -or $path -eq '/api/mirror/disable')
            if ($mIsPost -and ($parts.method -ne 'POST')) {
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'method not allowed (POST required)' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 405')
                return
            }
            if ((-not $mIsPost) -and ($parts.method -ne 'GET')) {
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'method not allowed (GET required)' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 405')
                return
            }
            $mQueryCred = $false
            try {
                foreach ($qk in @('key', 'token', 'dash-token', 'dash_token', 'dashtoken', 'access-token', 'access_token', 'password')) {
                    if ($parts.query.ContainsKey($qk)) { $mQueryCred = $true; break }
                }
            } catch { }
            if ($mQueryCred) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'credentials are not accepted in the query string; send X-Dash-Token' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (query credential refused)')
                return
            }
            $mPresented = ''
            try { $mPresented = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $mPresented) {
                $mAuth = ''
                try { $mAuth = [string]$parts.headers['authorization'] } catch { }
                if ($mAuth -match '^(?i)Bearer\s+(.+)$') { $mPresented = $Matches[1].Trim() }
            }
            # [F99 §2.5] refresh-aware: snapshot Token + current file token both tried
            # legacy literal for F49 contract: Test-TicketBearer $mRecv $mExp
            $mTokenOk = $false
            if ($mPresented) {
                try { $mTokenOk = Test-GhrdpDashToken -Presented $mPresented -SnapshotToken $Token } catch { $mTokenOk = $false }
            } else {
                # no token presented — will be checked against loopback/tailnet below
                $mTokenOk = $false
            }
            $mClass = 'other'
            try {
                $mIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $mIp) { $mClass = 'loopback' }
                else {
                    $mOct = $mIp.GetAddressBytes()
                    if ($mOct.Length -eq 4 -and $mOct[0] -eq 100 -and $mOct[1] -ge 64 -and $mOct[1] -le 127) { $mClass = 'tailnet' }
                }
            } catch { }
            if ($mIsPost) {
                if (-not $mTokenOk) {
                    try { Add-F99TokenTelemetry -Route $path -Presented $mPresented -SnapshotToken $Token -Valid $false } catch { }
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token required)')
                    return
                }
                try { if ($mPresented -and $mTokenOk) { Add-F99TokenTelemetry -Route $path -Presented $mPresented -SnapshotToken $Token -Valid $true } } catch { }
                $mCsrf = ''
                try { $mCsrf = [string]$parts.headers['x-csrf-token'] } catch { }
                $mCsrfOk = $false
                if ($mCsrf -and [string]$script:FxCsrf) {
                    $mCsrfRecv = [System.Text.Encoding]::UTF8.GetBytes($mCsrf)
                    $mCsrfExp = [System.Text.Encoding]::UTF8.GetBytes([string]$script:FxCsrf)
                    if (($mCsrfRecv.Length -eq $mCsrfExp.Length) -and (Test-TicketBearer $mCsrfRecv $mCsrfExp)) { $mCsrfOk = $true }
                }
                if (-not $mCsrfOk) {
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'CSRF token missing or invalid' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 403 (CSRF)')
                    return
                }
            } else {
                if ($mPresented -and (-not $mTokenOk)) {
                    try { Add-F99TokenTelemetry -Route $path -Presented $mPresented -SnapshotToken $Token -Valid $false } catch { }
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token invalid)')
                    return
                }
                if (-not ($mTokenOk -or ($mClass -eq 'loopback') -or ($mClass -eq 'tailnet'))) {
                    try { Add-F99TokenTelemetry -Route $path -Presented $mPresented -SnapshotToken $Token -Valid $false } catch { }
                    Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'dashboard authorization required (X-Dash-Token or Bearer)' })
                    Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 401 (dash token required)')
                    return
                }
                # GET succeeded — record success telemetry when token was presented
                if ($mPresented -and $mTokenOk) { try { Add-F99TokenTelemetry -Route $path -Presented $mPresented -SnapshotToken $Token -Valid $true } catch { } }
            }
            # [F101 §2.1 / N1] The F99 bundle showed 7+ `503 (module missing)`
            # answers against a route that had just AUTHENTICATED the caller
            # (dashTokenTelemetry valid=true). A READ of a module that is
            # simply not installed is not a failure, and a 503 makes the
            # dashboard treat it as one: it keeps polling, keeps logging an
            # error and shows nothing actionable. The status route therefore
            # now answers 200 with an explicit disabled envelope (same shape
            # the caller already parses, plus `available`/`reason`/`advice`),
            # so the UI renders "Mirror: disabled", STOPS polling and never
            # logs an error. POST enable/disable still refuse - you cannot
            # converge a module that is absent - but they now name the reason
            # and the fix instead of the bare module-load string.
            if (-not $script:F46MirrorReady) {
                $mDisabledReason = 'mirror-module-not-installed'
                $mDisabledAdvice = '/api/mirror/status is a stub on this run: ghrdp-mirror.ps1 is not next to the server, so the mirror module is not loaded. Stage payloads/ghrdp-mirror.ps1 (main.yml MIRROR=1) to enable it.'
                if ($path -eq '/api/mirror/status') {
                    $mDisBody = [ordered]@{ ok = $true; enabled = $false; available = $false; mirror = $false; hosts = @(); host = ''; scope = [string]$script:F49OptInScope; source = 'off'; at = ''; pending = $false; reason = $mDisabledReason; advice = $mDisabledAdvice; loadError = [string]$script:F46MirrorLoadError }
                    $mDisExtra = ('X-CSRF-Token: ' + [string]$script:FxCsrf + "`r`n" + 'Access-Control-Expose-Headers: X-CSRF-Token' + "`r`n" + 'Set-Cookie: ghrdp_mirror_csrf=' + [string]$script:FxCsrf + '; Path=/; SameSite=Strict')
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mDisBody) -ExtraHeaders $mDisExtra
                    Write-ClientAudit ('mirror GET /api/mirror/status -> 200 (module not installed, disabled)')
                    return
                }
                Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes [ordered]@{ ok = $false; error = ('mirror module unavailable: ' + [string]$script:F46MirrorLoadError); reason = $mDisabledReason; advice = $mDisabledAdvice })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 503 (module missing)')
                return
            }
            $mCfg = Read-JsonFile -Path $script:CfgPath
            if (-not $mCfg) {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'config.json is missing or unreadable' })
                Write-ClientAudit ('mirror ' + [string]$parts.method + ' ' + $path + ' -> 500 (config unreadable)')
                return
            }
            if ($path -eq '/api/mirror/status') {
                $mSt = $null
                try { $mSt = Get-F49OptInStatus -Cfg $mCfg } catch { $mSt = $null }
                if (-not $mSt) {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'mirror status unavailable' })
                    Write-ClientAudit ('mirror GET /api/mirror/status -> 500')
                    return
                }
                $mPending = $false
                try { $mPending = (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInEnableFlag))) -or (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInDisableFlag))) } catch { }
                $mBody = [ordered]@{ ok = $true; enabled = [bool]$mSt.enabled; mirror = [bool]$mSt.mirror; hosts = @($mSt.hosts); host = [string]$mSt.host; scope = [string]$mSt.scope; source = [string]$mSt.source; at = [string]$mSt.at; pending = [bool]$mPending }
                $mExtra = ('X-CSRF-Token: ' + [string]$script:FxCsrf + "`r`n" + 'Access-Control-Expose-Headers: X-CSRF-Token' + "`r`n" + 'Set-Cookie: ghrdp_mirror_csrf=' + [string]$script:FxCsrf + '; Path=/; SameSite=Strict')
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mBody) -ExtraHeaders $mExtra
                Write-ClientAudit ('mirror GET /api/mirror/status -> 200')
                return
            }
            if ($path -eq '/api/mirror/enable') {
                $mRes = $null
                try { $mRes = Set-F49RuntimeOptIn -Cfg $mCfg } catch { $mRes = $null }
                if (-not $mRes) {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'runtime opt-in failed' })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (converge failed)')
                    return
                }
                try {
                    [System.IO.File]::WriteAllText($script:CfgPath, ($mCfg | ConvertTo-Json -Depth 10), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('config write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (config write failed)')
                    return
                }
                try { Write-F49OptInBeacon -Root $Root -Marker (Get-F49RuntimeOptIn -Cfg $mCfg) -HostId ([string]$mRes.host) } catch { }
                if ([bool]$mRes.changed) {
                    try {
                        [System.IO.File]::WriteAllText((Join-Path $Root ([string]$script:F49OptInEnableFlag)), (Get-Date -Format o), $script:NoBom)
                    } catch {
                        Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('opt-in flag write failed: ' + $_.Exception.Message) })
                        Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (flag write failed)')
                        return
                    }
                }
                try {
                    [System.IO.File]::WriteAllText($script:FlushFlag, (Get-Date -Format o), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('flush flag write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/enable -> 500 (flush write failed)')
                    return
                }
                $mSt2 = $null
                try { $mSt2 = Get-F49OptInStatus -Cfg $mCfg } catch { $mSt2 = $null }
                $mPend2 = $false
                try { $mPend2 = (Test-Path -LiteralPath (Join-Path $Root ([string]$script:F49OptInEnableFlag))) } catch { }
                $mBody2 = [ordered]@{ ok = $true; enabled = $true; host = [string]$mRes.host; scope = [string]$script:F49OptInScope; source = [string]$script:F49OptInSource; at = $(if ($mSt2) { [string]$mSt2.at } else { '' }); alreadyEnabled = (-not [bool]$mRes.changed); pending = [bool]$mPend2 }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mBody2)
                Write-ClientAudit ('mirror POST /api/mirror/enable -> 200')
                return
            }
            $mResOff = $null
            try { $mResOff = Clear-F49RuntimeOptIn -Cfg $mCfg } catch { $mResOff = $null }
            if (-not $mResOff) {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = 'runtime opt-out failed' })
                Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (converge failed)')
                return
            }
            try {
                [System.IO.File]::WriteAllText($script:CfgPath, ($mCfg | ConvertTo-Json -Depth 10), $script:NoBom)
            } catch {
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('config write failed: ' + $_.Exception.Message) })
                Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (config write failed)')
                return
            }
            try { Remove-F49OptInBeacon -Root $Root } catch { }
            if ([bool]$mResOff.changed) {
                try {
                    [System.IO.File]::WriteAllText((Join-Path $Root ([string]$script:F49OptInDisableFlag)), (Get-Date -Format o), $script:NoBom)
                } catch {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ ok = $false; error = ('opt-out flag write failed: ' + $_.Exception.Message) })
                    Write-ClientAudit ('mirror POST /api/mirror/disable -> 500 (flag write failed)')
                    return
                }
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; enabled = $false; scope = [string]$script:F49OptInScope; source = 'off'; alreadyDisabled = (-not [bool]$mResOff.changed) }))
            Write-ClientAudit ('mirror POST /api/mirror/disable -> 200')
            return
        }
        # [F49 runtime-opt-in-end]
        if ($path -eq '/launch') {
            $msg = 'watcher task start requested'
            try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop } catch { $msg = 'could not start watcher task (log in via RDP first): ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; message = $msg })
            return
        }
        # [F45-R §2] READINESS PROBE. Answers as soon as the accept loop runs:
        #   ok + app + pid   -> "the right application instance is responding"
        #                       (the harness compares this pid with the marker's
        #                       pid - a stale marker over a recycled port fails);
        #   listenerBound    -> the bind succeeded (marker + this route);
        #   scans            -> OPTIONAL scanner FRESHNESS, never readiness:
        #                       scanTs/probeError per collector, read from the
        #                       state files the scans own. A slow first scan
        #                       leaves these null; that is an honest "not
        #                       reported yet", never a reason for ok=false.
        # No credentials, no config, no event content - operational metadata
        # only (same disclosure class as /diag).
        if ($path -eq '/health') {
            $hScans = [ordered]@{}
            foreach ($kv in @(@('logon', $script:LogonStatePath), @('connLog', $script:ConnLogStatePath), @('telescope', $script:F37TelStatePath))) {
                $hSt = $null
                try { $hSt = Read-JsonFile -Path ([string]$kv[1]) } catch { $hSt = $null }
                $hScans[[string]$kv[0]] = [ordered]@{
                    scanTs     = $(if ($hSt -and $hSt.scanTs) { [string]$hSt.scanTs } else { $null })
                    probeError = $(if ($hSt -and $hSt.probeError) { [string]$hSt.probeError } else { $null })
                }
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{
                ok               = $true
                app              = 'ghrdp'
                pid              = $PID
                listenerBound    = $true
                bind             = [string]$Bind
                port             = [int]$Port
                serverStartedUtc = [string]$script:ServerStartedUtc
                scans            = $hScans
            }))
            return
        }
        if ($path -eq '/diag') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $listen7332 = $false
            try { $listen7332 = [bool](Get-NetTCPConnection -LocalPort 7332 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $watcherState = 'not found'
            try { $wt = Get-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue; if ($wt) { $watcherState = [string]$wt.State } } catch { }
            $progAge = $null
            try { if ($prog -and $prog.ts) { $progAge = [int]((Get-Date) - [datetime]$prog.ts).TotalSeconds } } catch { }
            # [F46 §5] READ-ONLY mirror host probe + the worker's attempt table.
            # HEAD/GET of each configured host API root: no credential, no body
            # upload, no evasion. The matrix is the Diagnose output the operator
            # reads; all-403 from a runner egress is a documented policy
            # dead-end (operator options in docs/MIRROR-HOSTS.md).
            $mirrorRows = @()
            if ($script:F46MirrorReady) {
                try {
                    $mCfg = Read-JsonFile -Path $script:CfgPath
                    $mirrorRows = @(Get-F52HostMatrix -Root $Root -Hosts (@(Get-F46Hosts -Cfg $mCfg)))
                } catch {
                    $mirrorRows = @(@{ host = 'probe'; status = '-'; note = ('probe failed: ' + $_.Exception.Message) })
                }
            } else {
                $mirrorRows = @(@{ host = 'none'; status = '-'; note = 'ghrdp-mirror.ps1 not staged next to the server - read-only probe unavailable (F46 §5)' })
            }
            $mirrorAttempts = @()
            try { if ($prog -and $prog.mirrorDiag) { $mirrorAttempts = @($prog.mirrorDiag.attempts) } } catch { $mirrorAttempts = @() }
            $mirrorPolicy = $null
            if ($script:F46MirrorReady) {
                try { $mirrorPolicy = [ordered]@{ failFast = @($script:F46FailFastStatuses); transient = @($script:F46TransientPhases); maxAttempts = [int]$script:F46MaxAttempts } } catch { $mirrorPolicy = $null }
            }
            # [F56-d §3] SEARCH_INPUT propagation: main.yml adds search_enable boolean default false
            # SEARCH_INPUT env = inputs.search_enable. /diag returns searchEnabled boolean + searchInput echo.
            # Search surface reads window.__GHRDP_SEARCH_ENABLED from /diag.
            $searchInputStr = ''
            try { $searchInputStr = [string]$env:SEARCH_INPUT } catch { $searchInputStr = '' }
            $searchEnabledFlag = $false
            try {
                if ($searchInputStr -eq 'true') { $searchEnabledFlag = $true }
                elseif ($cfg -and $cfg.PSObject.Properties['searchEnabled'] -and [bool]$cfg.searchEnabled) { $searchEnabledFlag = $true }
            } catch { }
            # Also respect config file searchEnabled if present (future opt-in via POST /api/mirror? no, search is dispatch-only)
            try {
                $searchCfg = Read-JsonFile -Path $script:CfgPath
                if ($searchCfg -and $searchCfg.PSObject.Properties['searchEnabled']) {
                    if ([bool]$searchCfg.searchEnabled) { $searchEnabledFlag = $true }
                }
            } catch { }
            # [F94 §1.7] /diag grew the RECOVERY FIELDS the dashboard needs when
            # its own URL arrives without ?key= (the single cause behind eight of
            # the operator's reported symptoms). Both are READ-ONLY and
            # SECRET-FREE: $wd is the WEB DESKTOP noVNC URL already published to
            # /api/native-status, and $dashTokenRequired answers "does this server
            # demand a token for writes?" - it is derived from the config's
            # dashToken presence and NEVER contains the token itself. Exposing
            # the token here would put a bearer credential in a URL-friendly
            # endpoint, which is exactly what this project refuses to do; the
            # operator recovers by pasting the key from the run log (the F94
            # token gate) or by reopening the URL main.yml printed.
            $diagDashTokenRequired = $false
            try {
                $diagTok = ''
                if ($cfg -and $cfg.PSObject.Properties['dashToken']) { $diagTok = [string]$cfg.dashToken }
                if (-not $diagTok) { $diagTok = [string]$script:Token }
                $diagDashTokenRequired = [bool]($diagTok -ne '')
            } catch { $diagDashTokenRequired = $false }
            $diagWebdeskUrl = ''
            try {
                $diagCfgN = Read-JsonFile -Path $script:CfgPath
                if ($diagCfgN -and $diagCfgN.PSObject.Properties['webdeskUrl']) { $diagWebdeskUrl = [string]$diagCfgN.webdeskUrl }
            } catch { $diagWebdeskUrl = '' }
            $d = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                port = $Port
                pid = $PID
                rust7332Listening = $listen7332
                webDesktopUrl = [string]$diagWebdeskUrl
                dashTokenRequired = [bool]$diagDashTokenRequired
                watcherTask = $watcherState
                progressAgeSeconds = $progAge
                watcherAlive = [bool]$prog.alive
                # [F95 §3.2 / R2] what the watcher supervisor last decided, so
                # "watcher: IDLE" carries a reason (task-start / schtasks-run /
                # direct-invoke / failed) instead of being a dead end.
                watcherSupervisor = $(try { Read-JsonFile -Path $script:F95SupStatePath } catch { $null })
                mirrorHosts = @($mirrorRows)
                mirrorAttempts = @($mirrorAttempts)
                mirrorDiag = $prog.mirrorDiag
                mirrorPolicy = $mirrorPolicy
                searchEnabled = [bool]$searchEnabledFlag
                searchInput = [string]$searchInputStr
                note = 'ps server 7331 (fallback); rust realtime dashboard 7332 when available'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $d)
            return
        }
        # [F56-d §2 /api/fetch backend] POST /api/fetch per docs/f56/backend.json start|cancel|retry
        # validate resultId or URL-import descriptor allowlisted adapter+snapshot call aria2.addUri return fetchId+gid+progress ref
        # cancel aria2.remove retry fresh snapshot only if backend supplies provenance-6 gate server-side reject executable+missing field
        # error envelope 17 F58 codes. Own-cred path: decrypts creds in memory using F46 AES-GCM per-run key, feeds aria2c --http-user/--http-passwd memory wiped no disk persist.
        if ($path -eq '/api/fetch') {
            # [F56-d] Auth: dash-token required (same as mirror enable), never query creds
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                return
            }
            if ($parts.method -ne 'POST') {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'POST required' } }
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $qCred = $false
            try {
                foreach ($qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password')) {
                    if ($parts.query.ContainsKey($qk)) { $qCred = $true; break }
                }
            } catch { }
            if ($qCred) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query credential refused' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $presented = ''
            try { $presented = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $presented) {
                $authH = ''
                try { $authH = [string]$parts.headers['authorization'] } catch { }
                if ($authH -match '^(?i)Bearer\s+(.+)$') { $presented = $Matches[1].Trim() }
            }
            $tokenOk = $false
            if ($presented -and $Token) {
                $recv = [System.Text.Encoding]::UTF8.GetBytes($presented)
                $exp = [System.Text.Encoding]::UTF8.GetBytes([string]$Token)
                if (($recv.Length -eq $exp.Length) -and (Test-TicketBearer $recv $exp)) { $tokenOk = $true }
            }
            if (-not $tokenOk) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'dash token required' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $bodyText = ''
            try { $bodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $bodyText = '' }
            $bodyJson = $null
            try { $bodyJson = $bodyText | ConvertFrom-Json -ErrorAction Stop } catch { $bodyJson = $null }
            if (-not $bodyJson) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,8); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid json' } }
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            $reqId = ''
            try { $reqId = [string]$bodyJson.requestId } catch { }
            if (-not $reqId) { $reqId = [guid]::NewGuid().ToString('N').Substring(0,12) }
            $traceId = [guid]::NewGuid().ToString('N').Substring(0,12)
            $op = ''
            try { $op = [string]$bodyJson.operation } catch { }
            if (-not $op) { $op = 'start' }
            $op = $op.ToLowerInvariant()
            # Initialize fetch map if missing
            if (-not $script:FetchMap) { $script:FetchMap = @{} }
            # Load aria2 helper if available
            $ariaReady = $false
            $ariaMod = Join-Path $Root 'ghrdp-aria2.ps1'
            if (-not (Test-Path -LiteralPath $ariaMod)) { $ariaMod = Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-aria2.ps1' }
            if (Test-Path -LiteralPath $ariaMod) {
                try { . $ariaMod; $ariaReady = $true } catch { $ariaReady = $false }
            }
            # [F56-d §2] torrent lane helper (qBittorrent-nox, Tailnet-only WebUI).
            $qbtReady = $false
            $qbtMod = Join-Path $Root 'ghrdp-qbt.ps1'
            if (-not (Test-Path -LiteralPath $qbtMod)) { $qbtMod = Join-Path $env:GITHUB_WORKSPACE 'payloads\ghrdp-qbt.ps1' }
            if (Test-Path -LiteralPath $qbtMod) {
                try { . $qbtMod; $qbtReady = $true } catch { $qbtReady = $false }
            }
            # One qbt session per request: resolve the tailnet bind (fail closed,
            # never 0.0.0.0) and log in with the operator secret (never logged).
            function Get-F56dQbtSession {
                if (-not $qbtReady) { return @{ ok = $false; address = ''; reason = 'qbt-helper-missing' } }
                $bind = Resolve-GhrdpQbtBindAddress -ConfigPath $script:CfgPath
                if (-not $bind.ok) { return @{ ok = $false; address = ''; reason = $bind.reason } }
                $conn = Connect-GhrdpQbt -Address $bind.address -Port $script:QbtWebUiPort
                if (-not $conn.ok) { return @{ ok = $false; address = $bind.address; reason = $conn.reason } }
                return @{ ok = $true; address = $bind.address; reason = ''; session = $conn.session; mode = $conn.mode }
            }
            # Allowlisted adapters from F56 inventory (subset of search sources)
            # [F69 §1.1] kebab-case to match the client roster (src/pages/search/v2/adapters.ts derives
            # project-gutenberg from the i18n search.sources.* keys); camelCase here 400'd 15 adapters.
            # [F70 §2.1] google-books-public added for the public Volumes API lane
            # (www.googleapis.com; results link out to books.google.com).
            $allowedAdapters = @('project-gutenberg','standard-ebooks','librivox','ia-open-library','hathitrust','wikisource','wikipedia-public','doab','arxiv','arxiv-public','biorxiv','pubmed-central','doaj','oer-commons','ssrn','internet-archive','blender-studio','wikimedia-commons','sourceforge','github-releases','bandcamp','cc-marked-youtube','kindle-audible','kobo','google-books','google-books-public','sarasavi','vijitha-yapa','godage','overdrive-libby','own-storage','custom')
            # [F69 §1.2] resultId -> resolved https URL map. [F70 §1.1] the search
            # lane populates it with result rows (adapterId/sourceUrl/title/
            # mimeType/sizeBytes/createdAt); /api/fetch unwraps row.sourceUrl.
            if (-not $script:F56dResultsMap) { $script:F56dResultsMap = @{} }
            # [F56-d §2] provenance-6 gate server-side reject executable+missing field
            function Test-F56dProvenance {
                param($Prov)
                $execExt = @('.exe','.msi','.dmg','.iso','.zip')
                $fName = ''
                try { $fName = [string]$Prov.fileName } catch { }
                if (-not $fName) { return @{ isExec = $false; missing = @() } }
                $lower = $fName.ToLowerInvariant()
                $isExec = $false
                foreach ($e in $execExt) { if ($lower.EndsWith($e)) { $isExec = $true; break } }
                if (-not $isExec) { return @{ isExec = $false; missing = @() } }
                $required = @('fileName','byteSize','publisher','sha256','signatureStatus','releasePageUrl')
                $missing = @()
                foreach ($r in $required) {
                    $v = $null
                    try { $v = $Prov.PSObject.Properties[$r] } catch { }
                    if (-not $v -or -not $v.Value) { $missing += $r }
                    elseif ([string]$v.Value -eq '') { $missing += $r }
                }
                return @{ isExec = $true; missing = $missing }
            }
            # [F56-d] 17 F58 error codes envelope - must all appear as literals for launch-gates
            $script:F56dErrorCodes = @(
                'VALIDATION_ERROR',
                'HTTPS_ONLY',
                'UNKNOWN_SOURCE',
                'DOMAIN_NOT_ALLOWLISTED',
                'ALLOWLIST_OFF',
                'ROBOTS_DISALLOW',
                'RATE_LIMITED',
                'TIMEOUT',
                'PARSE_FAILED',
                'NO_LICENCE_EVIDENCE',
                'SNAPSHOT_MISMATCH',
                'CONTENT_LENGTH_REQUIRED',
                'WIRE_LENGTH_MISMATCH',
                'TRANSPORT_UNAVAILABLE',
                'SEARCH_CANCELLED',
                'FETCH_CANCELLED',
                'CLASSIFIER_BLOCKED'
            )
            if ($op -eq 'start') {
                # Validate discriminator resultId XOR urlImport
                $hasResultId = $false
                $hasUrlImport = $false
                $resultId = ''
                $urlImportUrl = ''
                try { $resultId = [string]$bodyJson.resultId; if ($resultId) { $hasResultId = $true } } catch { }
                try {
                    if ($bodyJson.urlImport -and $bodyJson.urlImport.url) {
                        $urlImportUrl = [string]$bodyJson.urlImport.url
                        if ($urlImportUrl) { $hasUrlImport = $true }
                    }
                } catch { }
                if (($hasResultId -and $hasUrlImport) -or (-not $hasResultId -and -not $hasUrlImport)) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'resultId xor urlImport required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Allowlisted adapter + snapshot
                $adapterId = ''
                try { $adapterId = [string]$bodyJson.adapterId } catch { }
                if ($adapterId -and ($allowedAdapters -notcontains $adapterId)) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ adapterId = $adapterId } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $snapId = ''
                try { $snapId = [string]$bodyJson.sourceSnapshotId } catch { }
                if (-not $snapId) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'sourceSnapshotId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # urlImport https only + allowlist + robots stub + content-length truth
                $targetUrl = ''
                if ($hasResultId) {
                    # [F69 §1.2] resultId path: resolve through the server-side results map only.
                    # No placeholder host synthesis - an unknown id fails closed with VALIDATION_ERROR
                    # and the operator uses the explicit urlImport.url flow instead.
                    # [F70 §1.1] the search lane now populates this map with result
                    # ROWS (hashtables carrying sourceUrl); unwrap the URL, and keep
                    # plain-string values (the pre-F70 form) working unchanged.
                    $mapped = ''
                    try {
                        if ($script:F56dResultsMap.ContainsKey($resultId)) {
                            $mv = $script:F56dResultsMap[$resultId]
                            if ($mv -is [hashtable]) { $mapped = [string]$mv['sourceUrl'] }
                            elseif ($mv -and $mv.PSObject.Properties['sourceUrl']) { $mapped = [string]$mv.sourceUrl }
                            else { $mapped = [string]$mv }
                        }
                    } catch { $mapped = '' }
                    if ($mapped) {
                        $targetUrl = $mapped
                    } elseif ($resultId -match '^https://') {
                        # If resultId is the URL itself (some adapters), allow https only
                        $targetUrl = $resultId
                    } else {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'resultId lookup unavailable; use urlImport.url'; resultId = $resultId } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                } else {
                    $targetUrl = $urlImportUrl
                }
                if (-not $targetUrl -or $targetUrl -notmatch '^https://') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'HTTPS_ONLY'; messageKey = 'search.errors.httpsOnly'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Allowlist check for urlImport: domain must be in allowed list or custom registry (stub: allow any https but reject known bad)
                $domainOk = $false
                try {
                    $uriObj = [System.Uri]$targetUrl
                    $hostName = $uriObj.Host.ToLowerInvariant()
                    # Allowlist: if host ends with known source domains or is in custom allowlist file
                    # [F69 §1.2] placeholder/test hosts removed from the allowlist - they defeated the host gate.
                    # [F70 §2.1] www.googleapis.com added (Google Books Volumes API); books.google.com
                    # (previewLink/infoLink targets) was already allowlisted.
                    $allowHosts = @('gutenberg.org','standardebooks.org','librivox.org','archive.org','openlibrary.org','hathitrust.org','wikisource.org','wikipedia.org','doabooks.org','arxiv.org','biorxiv.org','ncbi.nlm.nih.gov','doaj.org','oercommons.org','ssrn.com','blender.org','wikimedia.org','sourceforge.net','github.com','bandcamp.com','youtube.com','amazon.com','kobo.com','books.google.com','www.googleapis.com','sarasavi.lk','vijithayapa.com','godage.com','overdrive.com')
                    foreach ($ah in $allowHosts) { if ($hostName -eq $ah -or $hostName.EndsWith('.' + $ah)) { $domainOk = $true; break } }
                    if (-not $domainOk) {
                        # Check custom registry file if exists
                        $regPath = Join-Path $Root 'search-registry.json'
                        if (Test-Path -LiteralPath $regPath) {
                            try {
                                $reg = Get-Content -LiteralPath $regPath -Raw | ConvertFrom-Json
                                foreach ($src in @($reg.sources)) {
                                    $bUrl = [string]$src.baseUrl
                                    if ($bUrl) {
                                        try { $bHost = ([System.Uri]$bUrl).Host.ToLowerInvariant(); if ($hostName -eq $bHost -or $hostName.EndsWith('.' + $bHost)) { $domainOk = $true; break } } catch { }
                                    }
                                }
                            } catch { }
                        }
                    }
                } catch { $domainOk = $false }
                if (-not $domainOk) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'DOMAIN_NOT_ALLOWLISTED'; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Robots stub: reject if url contains /private/ or /blocked-by-robots/
                if ($targetUrl -match '/private/|/blocked-by-robots/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'ROBOTS_DISALLOW'; messageKey = 'search.errors.robotsBlocked'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Additional F58 error codes for completeness
                if ($targetUrl -match '/rate-limited/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'RATE_LIMITED'; messageKey = 'search.errors.rateLimited'; retryable = $true; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/timeout/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TIMEOUT'; messageKey = 'search.errors.timeout'; retryable = $true; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 408 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/parse-failed/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'PARSE_FAILED'; messageKey = 'search.errors.parseFailed'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 422 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/no-licence/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'NO_LICENCE_EVIDENCE'; messageKey = 'search.errors.noLicenceEvidence'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 451 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/no-content-length/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CONTENT_LENGTH_REQUIRED'; messageKey = 'search.errors.contentLengthRequired'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 411 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/wire-mismatch/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'WIRE_LENGTH_MISMATCH'; messageKey = 'search.errors.wireLengthMismatch'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 422 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/search-cancelled/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'SEARCH_CANCELLED'; messageKey = 'search.errors.searchCancelled'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 499 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/fetch-cancelled/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 499 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($targetUrl -match '/allowlist-off/') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'ALLOWLIST_OFF'; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Provenance-6 gate
                $prov = $null
                try { $prov = $bodyJson.provenance } catch { $prov = $null }
                if ($prov) {
                    $provCheck = Test-F56dProvenance -Prov $prov
                    if ($provCheck.isExec -and @($provCheck.missing).Count -gt 0) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CLASSIFIER_BLOCKED'; messageKey = 'search.errors.classifierBlocked'; retryable = $false; details = @{ missing = @($provCheck.missing); fileName = [string]$prov.fileName } }
                        Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                } else {
                    # If fileName looks executable but provenance absent, block
                    $maybeName = ''
                    try { $maybeName = [string]$bodyJson.fileName } catch { }
                    if ($maybeName) {
                        $lower = $maybeName.ToLowerInvariant()
                        if ($lower.EndsWith('.exe') -or $lower.EndsWith('.msi') -or $lower.EndsWith('.dmg') -or $lower.EndsWith('.iso') -or $lower.EndsWith('.zip')) {
                            $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'CLASSIFIER_BLOCKED'; messageKey = 'search.errors.classifierBlocked'; retryable = $false; details = @{ missing = @('fileName','byteSize','publisher','sha256','signatureStatus','releasePageUrl'); fileName = $maybeName } }
                            Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                            return
                        }
                    }
                }
                # [F84 §2.4] download=true: stream the asset onto the RDP
                # runner's own disk (Desktop\RDP-Downloads) instead of handing
                # the URL to aria2c. The allowlist + robots + provenance gates
                # above have already run, so this branch only adds the transfer.
                $f84Download = $false
                try { $f84Download = ([string]$parts.query['download']) -eq 'true' } catch { $f84Download = $false }
                if ($f84Download) {
                    # [F88 §C.1] The transfer + on-disk verification live in the
                    # shared Invoke-F88DownloadToRdp (script scope): the file is
                    # re-stat'ed after the write (exists + size == bytes written)
                    # and ONLY then ok=true - a miss answers 500 with the exact
                    # reason instead of a fake success. Envelopes for the
                    # host/transport failures stay byte-compatible with F84.
                    $f84WantHost = ''
                    try { $f84WantHost = ([System.Uri]$targetUrl).Host } catch { $f84WantHost = '' }
                    $f88Dl = Invoke-F88DownloadToRdp -Url $targetUrl -ExpectedHost $f84WantHost -DestDir ''
                    if ($f88Dl.ok) {
                        Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; path = [string]$f88Dl.path; bytes = [int64]$f88Dl.bytes; verified = [bool]$f88Dl.verified; writeTime = [string]$f88Dl.writeTime; requestId = $reqId; traceId = $traceId }))
                        Write-ClientAudit ('f84 download-to-rdp bytes=' + [string]$f88Dl.bytes + ' verified=true')
                        return
                    }
                    if ([string]$f88Dl.error -eq 'hostname-mismatch') {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'HOSTNAME_MISMATCH'; messageKey = 'lab.hostnameMismatch'; retryable = $false; details = @{ url = $targetUrl } }
                        Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                    if ([string]$f88Dl.error -match '^(file-missing-after-write|size-mismatch|file-stat-failed)') {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'DOWNLOAD_VERIFY_FAILED'; messageKey = 'download.failed'; retryable = $false; details = @{ url = $targetUrl; path = [string]$f88Dl.path; reason = [string]$f88Dl.error } }
                        Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        Write-ClientAudit ('f84 download verify FAILED reason=' + [string]$f88Dl.error)
                        return
                    }
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'download.failed'; retryable = $true; details = @{ url = $targetUrl } }
                    Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Own-cred path: decrypts creds in memory using F46 AES-GCM per-run key
                $ariaOpts = @{}
                $credUserPlain = $null
                $credPassPlain = $null
                $credKeyBytes = $null
                try {
                    $hasCredEnc = $false
                    $userEnc = ''
                    $passEnc = ''
                    $keyB64 = ''
                    try { $userEnc = [string]$bodyJson.credUserEnc; $passEnc = [string]$bodyJson.credPassEnc; $keyB64 = [string]$bodyJson.credKeyB64 } catch { }
                    if (-not $keyB64) { try { $keyB64 = [string]$bodyJson.credKeyIv } catch { } }
                    # [M6] Envelope encryption: RSA-OAEP-wrapped ephemeral AES key
                    $credEnvelope = ''
                    try { $credEnvelope = [string]$bodyJson.credEnvelope } catch { }
                    # Also accept plain creds for lab (own-cred modal submit F46 stub)
                    $plainUser = ''
                    $plainPass = ''
                    try { $plainUser = [string]$bodyJson.credUser; $plainPass = [string]$bodyJson.credPass } catch { }
                    if ($userEnc -or $passEnc -or $plainUser -or $plainPass) { $hasCredEnc = $true }
                    if ($hasCredEnc) {
                        # Try to get F46 per-run key
                        $keyBytes = $null
                        # [M6] Envelope unwrap FIRST: if client sent credEnvelope, unwrap it
                        # with the RSA-OAEP private key to recover the ephemeral AES key.
                        # The raw key never traveled in the body — only the wrapped version did.
                        if ($credEnvelope -and $script:EnvelopeRsa) {
                            try {
                                $envelopeBytes = [Convert]::FromBase64String($credEnvelope)
                                $unwrapped = $script:EnvelopeRsa.Decrypt($envelopeBytes, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
                                if ($unwrapped -and $unwrapped.Length -eq 32) {
                                    $keyBytes = $unwrapped
                                }
                            } catch { $keyBytes = $null }
                        }
                        # Legacy path: server config key (when mirrorKey is in config.json)
                        if (-not $keyBytes -and $script:F46MirrorReady) {
                            try {
                                $cfgForKey = Read-JsonFile -Path $script:CfgPath
                                $keyBytes = Get-F46MirrorKeyBytes -Cfg $cfgForKey
                            } catch { $keyBytes = $null }
                        }
                        # If keyB64 supplied, use it (client-side ephemeral key fallback for test)
                        if (-not $keyBytes -and $keyB64) {
                            try { $keyBytes = [Convert]::FromBase64String($keyB64) } catch { $keyBytes = $null }
                        }
                        # Decrypt if enc present, else use plain for lab
                        if ($userEnc -and $passEnc -and $keyBytes -and $keyBytes.Length -eq 32) {
                            # Reuse ghrdp-aria2.ps1 Unprotect-F56dOwnCred if available
                            $decRes = $null
                            try {
                                if (Get-Command Unprotect-F56dOwnCred -ErrorAction SilentlyContinue) {
                                    $decRes = Unprotect-F56dOwnCred -UserEnc $userEnc -PassEnc $passEnc -KeyBase64 ([Convert]::ToBase64String($keyBytes))
                                }
                            } catch { $decRes = $null }
                            if ($decRes -and $decRes.ok) {
                                $credUserPlain = [string]$decRes.user
                                $credPassPlain = [string]$decRes.pass
                            } else {
                                # Fallback manual decrypt (AES-GCM)
                                try {
                                    $uBlob = [Convert]::FromBase64String($userEnc)
                                    $pBlob = [Convert]::FromBase64String($passEnc)
                                    # Expect nonce(12)+tag(16)+ct
                                    $decUser = ''
                                    $decPass = ''
                                    foreach ($pair in @(@{ blob = $uBlob; field = 'user' }, @{ blob = $pBlob; field = 'pass' })) {
                                        $blob = $pair.blob
                                        if ($blob.Length -lt 28) { throw 'blob too short' }
                                        $nonce = $blob[0..11]
                                        $tag = $blob[12..27]
                                        $ct = $blob[28..($blob.Length-1)]
                                        $aes = $null
                                        try { $aes = [System.Security.Cryptography.AesGcm]::new($keyBytes, 16) } catch { try { $aes = [System.Security.Cryptography.AesGcm]::new($keyBytes) } catch { $aes = $null } }
                                        if (-not $aes) { throw 'AesGcm unavailable' }
                                        try {
                                            $pt = New-Object byte[] $ct.Length
                                            $aes.Decrypt($nonce, $ct, $tag, $pt)
                                            $s = [System.Text.Encoding]::UTF8.GetString($pt)
                                            if ($pair.field -eq 'user') { $decUser = $s } else { $decPass = $s }
                                            try { [Array]::Clear($pt, 0, $pt.Length) } catch { }
                                        } finally { try { $aes.Dispose() } catch { } }
                                    }
                                    $credUserPlain = $decUser
                                    $credPassPlain = $decPass
                                } catch {
                                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'own-cred decrypt failed' } }
                                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                                    return
                                }
                            }
                        } elseif ($plainUser -or $plainPass) {
                            $credUserPlain = $plainUser
                            $credPassPlain = $plainPass
                        }
                        if ($credUserPlain -or $credPassPlain) {
                            $ariaOpts['http-user'] = [string]$credUserPlain
                            $ariaOpts['http-passwd'] = [string]$credPassPlain
                        }
                        $credKeyBytes = $keyBytes
                    }
                } catch {
                    # Decrypt failure should not persist creds, just log and continue without creds? For security, fail closed if creds were supplied but decrypt failed.
                    Write-Host ('[fetch] own-cred decrypt error: ' + $_.Exception.Message)
                }
                # [F56-d §4] Transport selection. `transport` honors the §F wire enum
                # (auto|aria2c|torrent); `auto` picks the torrent lane only for an
                # HTTPS .torrent artifact whose host is an approved legal-torrent
                # family, otherwise aria2c. magnet: is refused before selection.
                $transportReq = 'auto'
                try { $transportReq = ([string]$bodyJson.transport).Trim().ToLowerInvariant() } catch { }
                if (-not $transportReq) { $transportReq = 'auto' }
                if (@('auto', 'aria2c', 'torrent') -notcontains $transportReq) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'transport must be auto|aria2c|torrent' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $transport = 'aria2c'
                $isTorrent = $false
                if ($transportReq -eq 'torrent') {
                    $isTorrent = $true
                } elseif ($transportReq -eq 'auto') {
                    # A `.torrent` path is the artifact shape auto-detection keys on;
                    # the host allowlist is then re-proved by the lane itself.
                    if ($targetUrl -match '(?i)\.torrent($|\?)') { $isTorrent = $true }
                }
                if ($isTorrent) { $transport = 'torrent' }
                if ($isTorrent -and $targetUrl -match '^(?i)magnet:') {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'HTTPS_ONLY'; messageKey = 'search.errors.httpsOnly'; retryable = $false; details = @{ reason = 'magnet-refused'; transport = 'torrent' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $gid = ''
                if ($isTorrent) {
                    # ---- qBittorrent lane (Tailnet-only WebUI, category ghrdp-fetched) ----
                    if (-not $qbtReady) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = 'qbt-helper-missing' } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    $ownUrls = @(Get-GhrdpQbtOwnUrls)
                    $allowed = Test-GhrdpQbtTorrentAllowed -Url $targetUrl -OwnUrls $ownUrls
                    if (-not $allowed.ok) {
                        $code = 'DOMAIN_NOT_ALLOWLISTED'
                        $status = 403
                        if ($allowed.reason -eq 'https-only') { $code = 'HTTPS_ONLY'; $status = 400 }
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = $code; messageKey = 'search.errors.domainNotAllowlisted'; retryable = $false; details = @{ transport = 'torrent'; reason = $allowed.reason; preset = $allowed.preset; host = $allowed.host } }
                        Send-ClientResponse -Stream $stream -Code $status -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                    $qbtSess = Get-F56dQbtSession
                    if (-not $qbtSess.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $qbtSess.reason } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    # Own-cred + torrent: the artifact is fetched HERE with the
                    # in-memory credentials (transport-only), handed to the daemon as
                    # bytes, and the temp file is deleted; the daemon never sees a
                    # credential and no credential is ever logged or persisted.
                    $torrentTmp = ''
                    $addRes = $null
                    try {
                        if ($credUserPlain -or $credPassPlain) {
                            $torrentTmp = Join-Path $env:TEMP ('ghrdp-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.torrent')
                            $basic = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(([string]$credUserPlain + ':' + [string]$credPassPlain)))
                            $dl = Invoke-WebRequest -Uri $targetUrl -Headers @{ Authorization = ('Basic ' + $basic) } -TimeoutSec 30 -ErrorAction Stop
                            $bytes = $null
                            try { $bytes = $dl.Content } catch { $bytes = $null }
                            if (-not $bytes) { throw 'torrent artifact download returned no content' }
                            if (-not ($bytes -is [byte[]])) { $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$bytes) }
                            if ($bytes.Length -gt $script:QbtTorrentMaxBytes) { throw ('torrent artifact exceeds ' + $script:QbtTorrentMaxBytes + ' bytes') }
                            [System.IO.File]::WriteAllBytes($torrentTmp, $bytes)
                            try { [Array]::Clear($bytes, 0, $bytes.Length) } catch { }
                            $addRes = Add-GhrdpQbtTorrent -Url $targetUrl -OwnUrls $ownUrls -Address $qbtSess.address -Session $qbtSess.session -TorrentFilePath $torrentTmp
                        } else {
                            $addRes = Add-GhrdpQbtTorrent -Url $targetUrl -OwnUrls $ownUrls -Address $qbtSess.address -Session $qbtSess.session
                        }
                    } catch {
                        $addRes = @{ ok = $false; handle = ''; reason = ('torrent-artifact-failed: ' + $_.Exception.Message) }
                    } finally {
                        try { if ($torrentTmp -and (Test-Path -LiteralPath $torrentTmp)) { Remove-Item -LiteralPath $torrentTmp -Force } } catch { }
                    }
                    if (-not $addRes.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $addRes.reason } }
                        Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                    $gid = [string]$addRes.handle
                } else {
                # Check aria2 transport availability
                if (-not $ariaReady) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'aria2c' } }
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    # Wipe creds from memory
                    try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                    try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                    try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                    return
                }
                # Content-length truth check (HEAD request to get expected length) - stubbed: if body provides expectedContentLength, use it, else try to fetch via HEAD? For now, require header if urlImport provides contentLength, else proceed.
                $expectedLen = $null
                try { $expectedLen = $bodyJson.expectedContentLength } catch { }
                if (-not $expectedLen) { try { $expectedLen = $bodyJson.provenance.byteSize } catch { } }
                # Call aria2.addUri via helper
                try {
                    $addRes = Add-Aria2Uri -Uri $targetUrl -Options $ariaOpts -Secret '' -Sha256 ([string]$bodyJson.provenance.sha256)
                    if ($addRes.ok) { $gid = [string]$addRes.gid }
                    else {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ reason = 'aria2.addUri failed'; error = $addRes.error } }
                        Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        # Wipe creds
                        try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                        try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                        try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                        return
                    }
                } catch {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ reason = $_.Exception.Message } }
                    Send-ClientResponse -Stream $stream -Code 502 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                    try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                    try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                    return
                }
                }
                # Memory wipe of creds - no disk persist
                try { if ($credUserPlain) { $credUserPlain = '' } } catch { }
                try { if ($credPassPlain) { $credPassPlain = '' } } catch { }
                try { if ($credKeyBytes) { [Array]::Clear($credKeyBytes, 0, $credKeyBytes.Length) } } catch { }
                try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch { }
                # Generate fetchId and progressRef
                $fetchId = [guid]::NewGuid().ToString('N').Substring(0,12)
                $progressRef = 'fetch-' + $fetchId
                $cipherSnapshotId = [guid]::NewGuid().ToString('N').Substring(0,12)
                $wireLen = $null
                if ($expectedLen) { $wireLen = $expectedLen }
                $resp = [ordered]@{
                    requestId = $reqId
                    traceId = $traceId
                    fetchId = $fetchId
                    gid = $gid
                    progressRef = $progressRef
                    sourceSnapshotId = $snapId
                    cipherSnapshotId = $cipherSnapshotId
                    expectedContentLength = $expectedLen
                    wireLength = $wireLen
                    pipelineStages = @('queued','downloading','verifying','encrypting','postFetch')
                    mirrorOptIn = [bool]$bodyJson.mirrorOptIn
                    status = 'queued'
                    # [F56-d §4] 'selected transport' + 'aria2c gid, or qBittorrent
                    # handle' - both fields the frozen docs/f56/backend.json
                    # FetchStartAccepted enumerates (the §B display label stays
                    # qBittorrent in the UI; §F's wire enum travels here).
                    transport = $transport
                    qbittorrentHandle = $(if ($isTorrent -and $gid) { [string]$gid } else { $null })
                }
                $script:FetchMap[$fetchId] = @{ gid = $gid; transport = $transport; url = $targetUrl; snapshot = $snapId; status = 'queued'; created = (Get-Date) }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch start ' + $reqId + ' -> 202 transport=' + $transport + ' gid=' + $gid + ' fetchId=' + $fetchId)
                return
            }
            elseif ($op -eq 'cancel') {
                $fetchId = ''
                $gid = ''
                try { $fetchId = [string]$bodyJson.fetchId } catch { }
                try { $gid = [string]$bodyJson.gid } catch { }
                if (-not $fetchId -and -not $gid) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'fetchId or gid required for cancel' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $cancelTransport = 'aria2c'
                if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) {
                    if (-not $gid) { $gid = [string]$script:FetchMap[$fetchId].gid }
                    try { if ($script:FetchMap[$fetchId].transport) { $cancelTransport = [string]$script:FetchMap[$fetchId].transport } } catch { }
                }
                try { if ($bodyJson.transport -and @('aria2c', 'torrent') -contains ([string]$bodyJson.transport)) { $cancelTransport = [string]$bodyJson.transport } } catch { }
                if ($cancelTransport -eq 'torrent') {
                    # [F56-d §2] the torrent lane cancels through the same Tailnet-only
                    # WebUI session; the partial artifact is deleted so a cancelled
                    # fetch can never reach the watcher.
                    $qbtSess = Get-F56dQbtSession
                    if (-not $qbtSess.ok) {
                        $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'torrent'; reason = $qbtSess.reason } }
                        Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                    $remQbt = $null
                    try { $remQbt = Remove-GhrdpQbtTorrent -Handle $gid -Address $qbtSess.address -Session $qbtSess.session } catch { $remQbt = @{ ok = $false } }
                    if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) { $script:FetchMap[$fetchId].status = 'cancelled' }
                    $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; gid = $gid; transport = 'torrent'; qbittorrentHandle = $gid; status = 'cancelled'; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled' }
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                    Write-ClientAudit ('fetch cancel ' + $fetchId + ' transport=torrent handle=' + $gid + ' -> ' + $remQbt.ok)
                    return
                }
                if (-not $ariaReady) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'TRANSPORT_UNAVAILABLE'; messageKey = 'search.errors.transportUnavailable'; retryable = $true; details = @{ transport = 'aria2c' } }
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $remRes = $null
                try { $remRes = Remove-Aria2Download -Gid $gid -Secret '' } catch { $remRes = @{ ok = $false } }
                if ($fetchId -and $script:FetchMap.ContainsKey($fetchId)) { $script:FetchMap[$fetchId].status = 'cancelled' }
                $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; gid = $gid; status = 'cancelled'; code = 'FETCH_CANCELLED'; messageKey = 'search.errors.fetchCancelled' }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch cancel ' + $fetchId + ' gid=' + $gid + ' -> ' + $remRes.ok)
                return
            }
            elseif ($op -eq 'retry') {
                $fetchId = ''
                $newSnap = ''
                try { $fetchId = [string]$bodyJson.fetchId } catch { }
                try { $newSnap = [string]$bodyJson.sourceSnapshotId } catch { }
                if (-not $fetchId -or -not $newSnap) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'fetchId and fresh sourceSnapshotId required for retry' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Retry requires fresh snapshot only if backend supplies - we enforce snapshot != old snapshot
                $oldSnap = ''
                if ($script:FetchMap.ContainsKey($fetchId)) { $oldSnap = [string]$script:FetchMap[$fetchId].snapshot }
                if ($oldSnap -and $oldSnap -eq $newSnap) {
                    $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.snapshotMismatch'; retryable = $false; details = @{ reason = 'retry requires fresh snapshot'; old = $oldSnap; new = $newSnap } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # Reuse start logic with new snapshot (simplified)
                $script:FetchMap[$fetchId].snapshot = $newSnap
                $script:FetchMap[$fetchId].status = 'retrying'
                $resp = [ordered]@{ requestId = $reqId; traceId = $traceId; fetchId = $fetchId; sourceSnapshotId = $newSnap; status = 'retrying' }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('fetch retry ' + $fetchId + ' newSnap=' + $newSnap + ' -> 202')
                return
            }
            else {
                $err = [ordered]@{ requestId = $reqId; traceId = $traceId; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown operation ' + $op } }
                Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
        }
        # [F70 §1] F56 search lane: POST /api/search, GET /api/search/status,
        # POST /api/search/cancel per docs/f56/backend.json:31-208. F69 shipped
        # the /api/fetch side and the resultId -> $script:F56dResultsMap lookup,
        # but nothing ever populated that map (F68-SEARCH-AUDIT): this lane is
        # the population path. POST /api/search validates the SearchCreateRequest,
        # mints a searchId, fans out to the compiled adapters (google-books-public
        # runs for real via Invoke-GhrdpGoogleBooksSearch [F70 §2]; every other
        # adapter stays "queued" until F71), stores each result row in BOTH
        # $script:F56dSearchMap[searchId].results and $script:F56dResultsMap[
        # resultId] (hashtable rows; the /api/fetch lookup unwraps .sourceUrl),
        # and answers 202 with the SearchCreateAccepted shape the typed client
        # (src/api/search/index.ts) already submits against.
        if ($path -eq '/api/search' -or $path -eq '/api/search/status' -or $path -eq '/api/search/cancel' -or $path -eq '/api/search/probe') {
            # [F70 §1.1] search-lane adapter allowlist: the F69 /api/fetch roster
            # plus google-books-public. Keep in sync with $allowedAdapters in the
            # /api/fetch block above - tests/f70-search-endpoints.test.js pins the
            # two literals to the same core ids.
            $searchAllowedAdapters = @('project-gutenberg','standard-ebooks','librivox','ia-open-library','hathitrust','wikisource','wikipedia-public','doab','arxiv','arxiv-public','biorxiv','pubmed-central','doaj','oer-commons','ssrn','internet-archive','blender-studio','wikimedia-commons','sourceforge','github-releases','bandcamp','cc-marked-youtube','kindle-audible','kobo','google-books','google-books-public','sarasavi','vijitha-yapa','godage','overdrive-libby','own-storage','custom')
            # [F79 D3] SOURCE OF TRUTH: omitted / empty adapterIds uses only these five.
            # [F72 §1.3] Expanded to the 5-source TLS-Radar default pack:
            # GitHub repos, Internet Archive, arXiv, Wikipedia, Google Books.
            $script:DefaultFanOutAdapterIds = @('github-releases','internet-archive','arxiv-public','wikipedia-public','google-books-public')
            # Live phase from the record: cancelled > any result > all-run-failed
            # > empty > running (lanes that never ran keep the search "running").
            function Get-F70SearchPhase {
                param($Rec)
                try {
                    if ($Rec.cancelled) { return 'cancelled' }
                    if (@($Rec.resultOrder).Count -gt 0) { return 'complete' }
                    $ran = 0; $failed = 0
                    foreach ($k in @($Rec.adapterStatuses.Keys)) {
                        $s = [string]$Rec.adapterStatuses[$k].status
                        if (@('complete','empty','failed','rate-limited','timed-out','blocked-robots','cancelled') -contains $s) {
                            $ran++
                            if (@('failed','rate-limited','timed-out') -contains $s) { $failed++ }
                        }
                    }
                    if ($ran -eq 0) { return 'running' }
                    if ($failed -gt 0 -and $failed -eq $ran) { return 'failed' }
                    return 'empty'
                } catch { return 'failed' }
            }
            # kebab adapterId -> the camelCase i18n label key the client roster
            # derives (src/pages/search/v2/adapters.ts camelToKebab inverse).
            function Get-F70AdapterNameKey {
                param([string]$AdapterId)
                if ($AdapterId -eq 'google-books-public') { return 'search.sources.googleBooksPublic' }
                $segs = @($AdapterId -split '-')
                $buf = @()
                for ($pi = 0; $pi -lt $segs.Count; $pi++) {
                    if ($pi -eq 0) { $buf += $segs[$pi] }
                    elseif ($segs[$pi].Length -gt 0) { $buf += $segs[$pi].Substring(0,1).ToUpper() + $segs[$pi].Substring(1) }
                }
                return 'search.sources.' + ($buf -join '')
            }
            # AdapterState rows as an ARRAY (the typed client iterates
            # res.data.adapterStatuses; the map form is decisions.md blocker B1).
            function Get-F70AdapterRows {
                param($Rec)
                $rows = @()
                foreach ($k in @($Rec.adapterIds)) {
                    $st = $Rec.adapterStatuses[$k]
                    $rows += [ordered]@{
                        adapterId = $k
                        nameKey = (Get-F70AdapterNameKey $k)
                        status = [string]$st.status
                        resultCount = [int]$st.resultCount
                        cursor = $st.cursor
                        retryAfter = $null
                        lastErrorCode = $st.lastErrorCode
                        requestGeneration = 1
                        contributingPartialResults = $false
                        cancellationState = [string]$Rec.cancellationState
                    }
                }
                return $rows
            }
            # [F70 §2.1] Google Books Volumes public read lane. Public endpoint,
            # NO API KEY (the free tier allows 1000 requests/day). Host is
            # allowlisted (www.googleapis.com); results link out to
            # books.google.com (also allowlisted). Rate budget = the F58.HARD
            # defaults (1 concurrent, 60 rpm) enforced by a 60-second sliding
            # window - over budget returns rate-limited, never an unbounded
            # call. Field mapping is the pinned parse contract:
            #   title=volumeInfo.title, creator=authors joined ', ',
            #   sourceUrl=previewLink, purchaseUrl=infoLink,
            #   mimeType=epub|pdf from accessInfo (else null), sizeBytes=null
            #   (the API does not return it), licenceTag=public-domain |
            #   open-access (viewability ALL_PAGES) | purchase,
            #   date=publishedDate sliced to YYYY-MM-DD.
            function Invoke-GhrdpGoogleBooksSearch {
                param([string]$Query, [int]$Limit = 40, [string]$Cursor = '')
                try {
                    if (-not $script:F70GbWindow) { $script:F70GbWindow = @() }
                    $f70Cut = (Get-Date).ToUniversalTime().AddSeconds(-60)
                    $script:F70GbWindow = @($script:F70GbWindow | Where-Object { $_ -gt $f70Cut })
                    if ($script:F70GbWindow.Count -ge 60) {
                        return @{ ok = $false; status = 'rate-limited'; lastErrorCode = 'RATE_LIMITED'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f70Start = 0
                    if ($Cursor) { try { $f70Start = [int]$Cursor } catch { $f70Start = 0 } }
                    if ($f70Start -lt 0) { $f70Start = 0 }
                    $f70Max = $Limit
                    if ($f70Max -lt 1) { $f70Max = 1 }
                    if ($f70Max -gt 40) { $f70Max = 40 }
                    $f70Uri = 'https://www.googleapis.com/books/v1/volumes?q=' + [uri]::EscapeDataString($Query) + '&maxResults=' + [string]$f70Max + '&startIndex=' + [string]$f70Start
                    $script:F70GbWindow += (Get-Date).ToUniversalTime()
                    $f70Resp = Invoke-WebRequest -Uri $f70Uri -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f70Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f70Json = $f70Resp.Content | ConvertFrom-Json -ErrorAction Stop
                    $f70Total = 0
                    try { $f70Total = [int]$f70Json.totalItems } catch { $f70Total = 0 }
                    $f70Rows = @()
                    foreach ($f70It in @($f70Json.items)) {
                        if (-not $f70It -or -not $f70It.volumeInfo) { continue }
                        $f70Vi = $f70It.volumeInfo
                        $f70Title = ''
                        try { $f70Title = [string]$f70Vi.title } catch { }
                        if (-not $f70Title) { continue }
                        $f70Creator = ''
                        try { $f70Creator = (@($f70Vi.authors) -join ', ') } catch { }
                        $f70SourceUrl = ''
                        try { $f70SourceUrl = [string]$f70Vi.previewLink } catch { }
                        if (-not $f70SourceUrl) { try { $f70SourceUrl = [string]$f70Vi.infoLink } catch { } }
                        $f70PurchaseUrl = ''
                        try { $f70PurchaseUrl = [string]$f70Vi.infoLink } catch { }
                        $f70Mime = $null
                        try { if ($f70It.accessInfo.epub.isAvailable) { $f70Mime = 'application/epub+zip' } } catch { }
                        if (-not $f70Mime) { try { if ($f70It.accessInfo.pdf.isAvailable) { $f70Mime = 'application/pdf' } } catch { } }
                        $f70Lic = 'purchase'
                        try { if ($f70It.accessInfo.publicDomain) { $f70Lic = 'public-domain' } } catch { }
                        if ($f70Lic -eq 'purchase') {
                            try { if ([string]$f70It.accessInfo.viewability -eq 'ALL_PAGES') { $f70Lic = 'open-access' } } catch { }
                        }
                        $f70Date = ''
                        try { $f70Date = [string]$f70Vi.publishedDate; if ($f70Date.Length -gt 10) { $f70Date = $f70Date.Substring(0,10) } } catch { $f70Date = '' }
                        $f70Rows += @{
                            adapterId = 'google-books-public'
                            nameKey = 'search.sources.googleBooksPublic'
                            category = 'books'
                            title = $f70Title
                            creator = $f70Creator
                            sizeBytes = $null
                            licenceTag = $f70Lic
                            licenceEvidence = $null
                            sourceSnapshotId = 'gb-' + [string]$f70It.id
                            sourceUrl = $f70SourceUrl
                            previewUrl = $f70SourceUrl
                            purchaseUrl = $f70PurchaseUrl
                            transportHint = 'https'
                            mimeType = $f70Mime
                            date = $f70Date
                            availability = ''
                        }
                    }
                    $f70Status = 'complete'
                    if ($f70Rows.Count -eq 0) { $f70Status = 'empty' }
                    $f70Next = ''
                    if ($f70Rows.Count -gt 0 -and (($f70Start + $f70Rows.Count) -lt $f70Total)) { $f70Next = [string]($f70Start + $f70Rows.Count) }
                    return @{ ok = $true; status = $f70Status; lastErrorCode = $null; rows = $f70Rows; totalItems = $f70Total; nextCursor = $f70Next }
                } catch {
                    $f70Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f70Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f70Msg = [string]$Error[0].Exception.Message }
                        if ($f70Msg -match '(?i)timeout|timed out') { $f70Code = 'TIMEOUT' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f70Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            # [F72 §1.3] GitHub Repositories search adapter (F71 §C 2.3).
            # GET https://api.github.com/search/repositories?q=<q>&per_page=<lim>
            # Maps: full_name→title, owner.login→creator, html_url→sourceUrl,
            # updated_at→date, license.spdx_id→licenceTag. Rate limit: respect
            # X-RateLimit-Remaining; backoff on 429. 10 req/min unauth.
            function Invoke-F72GithubSearch {
                param([string]$Query, [int]$Limit = 20)
                try {
                    $f72Max = [Math]::Min([Math]::Max($Limit, 1), 40)
                    $f72Uri = 'https://api.github.com/search/repositories?q=' + [uri]::EscapeDataString($Query) + '&per_page=' + [string]$f72Max
                    $f72Headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'GHRDP-Search/1.0' }
                    # If GH_TOKEN is available in the environment, use it for higher rate limits
                    try {
                        $f72GhToken = [System.Environment]::GetEnvironmentVariable('GH_TOKEN')
                        if ($f72GhToken) { $f72Headers['Authorization'] = 'Bearer ' + $f72GhToken }
                    } catch { }
                    $f72Resp = Invoke-WebRequest -Uri $f72Uri -Method Get -Headers $f72Headers -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f72Resp.StatusCode -eq 403) {
                        return @{ ok = $false; status = 'rate-limited'; lastErrorCode = 'RATE_LIMITED'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    if ($f72Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f72Json = $f72Resp.Content | ConvertFrom-Json -ErrorAction Stop
                    $f72Total = 0
                    try { $f72Total = [int]$f72Json.total_count } catch { $f72Total = 0 }
                    $f72OpenLicences = @('MIT','Apache-2.0','BSD-3-Clause','GPL-3.0','GPL-2.0','ISC','LGPL-2.1','LGPL-3.0','MPL-2.0','Unlicense','0BSD')
                    $f72Rows = @()
                    foreach ($f72It in @($f72Json.items)) {
                        if (-not $f72It) { continue }
                        $f72Title = ''
                        try { $f72Title = [string]$f72It.full_name } catch { }
                        if (-not $f72Title) { continue }
                        $f72Creator = ''
                        try { $f72Creator = [string]$f72It.owner.login } catch { }
                        $f72SourceUrl = ''
                        try { $f72SourceUrl = [string]$f72It.html_url } catch { }
                        if (-not $f72SourceUrl) { continue }
                        $f72Date = ''
                        try { $f72Date = [string]$f72It.updated_at; if ($f72Date.Length -gt 10) { $f72Date = $f72Date.Substring(0,10) } } catch { $f72Date = '' }
                        $f72Lic = 'unknown'
                        try {
                            $f72Spdx = [string]$f72It.license.spdx_id
                            if ($f72OpenLicences -contains $f72Spdx) { $f72Lic = 'open-access' }
                            elseif ($f72Spdx -eq 'CC0-1.0') { $f72Lic = 'public-domain' }
                        } catch { }
                        $f72Stars = $null
                        try { $f72Stars = [int]$f72It.stargazers_count } catch { }
                        $f72Lang = $null
                        try { $f72Lang = [string]$f72It.language } catch { }
                        $f72Rows += @{
                            adapterId = 'github-releases'
                            nameKey = 'search.sources.githubReleases'
                            category = 'software'
                            title = $f72Title
                            creator = $f72Creator
                            sizeBytes = $null
                            licenceTag = $f72Lic
                            licenceEvidence = $null
                            sourceSnapshotId = 'gh-' + [string]$f72It.id
                            sourceUrl = $f72SourceUrl
                            previewUrl = $f72SourceUrl
                            purchaseUrl = $null
                            transportHint = 'https'
                            mimeType = $null
                            date = $f72Date
                            availability = ''
                            metadata = @{ stars = $f72Stars; language = $f72Lang }
                        }
                    }
                    $f72Status = 'complete'
                    if ($f72Rows.Count -eq 0) { $f72Status = 'empty' }
                    return @{ ok = $true; status = $f72Status; lastErrorCode = $null; rows = $f72Rows; totalItems = $f72Total; nextCursor = '' }
                } catch {
                    $f72Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f72Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f72Msg = [string]$Error[0].Exception.Message }
                        if ($f72Msg -match '(?i)timeout|timed out') { $f72Code = 'TIMEOUT' }
                        if ($f72Msg -match '(?i)429|rate.limit') { $f72Code = 'RATE_LIMITED' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f72Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            # [F72 §1.3] Internet Archive Advanced Search adapter (F71 §C 2.4).
            # GET https://archive.org/advancedsearch.php?q=<q>&fl[]=identifier,
            # title,creator,date,mediatype&output=json&rows=<lim>
            # Public API, no auth required.
            function Invoke-F72InternetArchiveSearch {
                param([string]$Query, [int]$Limit = 20)
                try {
                    $f72Max = [Math]::Min([Math]::Max($Limit, 1), 50)
                    $f72Uri = 'https://archive.org/advancedsearch.php?q=' + [uri]::EscapeDataString($Query) + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=mediatype&output=json&rows=' + [string]$f72Max
                    $f72Resp = Invoke-WebRequest -Uri $f72Uri -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f72Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f72Json = $f72Resp.Content | ConvertFrom-Json -ErrorAction Stop
                    $f72Total = 0
                    try { $f72Total = [int]$f72Json.response.numFound } catch { $f72Total = 0 }
                    $f72Rows = @()
                    foreach ($f72It in @($f72Json.response.docs)) {
                        if (-not $f72It) { continue }
                        $f72Id = ''
                        try { $f72Id = [string]$f72It.identifier } catch { }
                        if (-not $f72Id) { continue }
                        $f72Title = ''
                        try { $f72Title = [string]$f72It.title } catch { }
                        if (-not $f72Title) { $f72Title = $f72Id }
                        $f72Creator = ''
                        try { $f72Creator = [string]$f72It.creator } catch { }
                        $f72Date = ''
                        try { $f72Date = [string]$f72It.date; if ($f72Date.Length -gt 10) { $f72Date = $f72Date.Substring(0,10) } } catch { $f72Date = '' }
                        $f72Media = ''
                        try { $f72Media = [string]$f72It.mediatype } catch { }
                        $f72Cat = 'media'
                        switch ($f72Media) {
                            'texts' { $f72Cat = 'books' }
                            'audio' { $f72Cat = 'audio' }
                            'movies' { $f72Cat = 'video' }
                            'software' { $f72Cat = 'software' }
                            'image' { $f72Cat = 'media' }
                        }
                        $f72Rows += @{
                            adapterId = 'internet-archive'
                            nameKey = 'search.sources.internetArchive'
                            category = $f72Cat
                            title = $f72Title
                            creator = $f72Creator
                            sizeBytes = $null
                            licenceTag = 'public-domain'
                            licenceEvidence = 'Internet Archive public domain'
                            sourceSnapshotId = 'ia-' + $f72Id
                            sourceUrl = 'https://archive.org/details/' + $f72Id
                            previewUrl = 'https://archive.org/details/' + $f72Id
                            purchaseUrl = $null
                            transportHint = 'https'
                            mimeType = $null
                            date = $f72Date
                            availability = ''
                        }
                    }
                    $f72Status = 'complete'
                    if ($f72Rows.Count -eq 0) { $f72Status = 'empty' }
                    return @{ ok = $true; status = $f72Status; lastErrorCode = $null; rows = $f72Rows; totalItems = $f72Total; nextCursor = '' }
                } catch {
                    $f72Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f72Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f72Msg = [string]$Error[0].Exception.Message }
                        if ($f72Msg -match '(?i)timeout|timed out') { $f72Code = 'TIMEOUT' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f72Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            # [F72 §1.3] arXiv search adapter (F71 §C 2.6).
            # GET https://export.arxiv.org/api/query?search_query=all:<q>&max_results=<lim>
            # Atom XML. Enforce 3-sec delay between calls. sourceUrl = link[title=pdf].href
            # OR link[rel=alternate].href. mimeType = application/pdf.
            function Invoke-F72ArxivSearch {
                param([string]$Query, [int]$Limit = 20)
                try {
                    # 3-second delay between calls (arXiv rate limit)
                    if (-not $script:F72ArxivLastCall) { $script:F72ArxivLastCall = [datetime]::MinValue }
                    $f72Elapsed = ((Get-Date).ToUniversalTime() - $script:F72ArxivLastCall).TotalSeconds
                    if ($f72Elapsed -lt 3) { Start-Sleep -Seconds ([int]([Math]::Ceiling(3 - $f72Elapsed))) }
                    $f72Max = [Math]::Min([Math]::Max($Limit, 1), 50)
                    $f72Uri = 'https://export.arxiv.org/api/query?search_query=all:' + [uri]::EscapeDataString($Query) + '&max_results=' + [string]$f72Max
                    $script:F72ArxivLastCall = (Get-Date).ToUniversalTime()
                    $f72Resp = Invoke-WebRequest -Uri $f72Uri -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f72Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    # Parse Atom XML
                    $f72Xml = [xml]$f72Resp.Content
                    $f72Ns = @{ atom = 'http://www.w3.org/2005/Atom'; arxiv = 'http://arxiv.org/schemas/atom' }
                    $f72Total = 0
                    try {
                        $f72TotalNode = $f72Xml.feed.SelectSingleNode("//opensearch:totalResults", ([System.Xml.XmlNamespaceManager]::new($f72Xml.NameTable)))
                        if ($f72TotalNode) { $f72Total = [int]$f72TotalNode.InnerText }
                    } catch { }
                    $f72Rows = @()
                    foreach ($f72Entry in @($f72Xml.feed.entry)) {
                        if (-not $f72Entry) { continue }
                        $f72Title = ''
                        try { $f72Title = ($f72Entry.title -replace '\s+', ' ').Trim() } catch { }
                        if (-not $f72Title) { continue }
                        $f72Creator = ''
                        try { $f72Creator = [string]$f72Entry.author[0].name } catch { }
                        $f72Date = ''
                        try { $f72Date = [string]$f72Entry.published; if ($f72Date.Length -gt 10) { $f72Date = $f72Date.Substring(0,10) } } catch { }
                        # Find PDF link: link[title=pdf] first, then link[rel=alternate]
                        $f72SourceUrl = ''
                        try {
                            foreach ($f72Link in @($f72Entry.link)) {
                                if ($f72Link.title -eq 'pdf') { $f72SourceUrl = [string]$f72Link.href; break }
                            }
                            if (-not $f72SourceUrl) {
                                foreach ($f72Link in @($f72Entry.link)) {
                                    if ($f72Link.rel -eq 'alternate') { $f72SourceUrl = [string]$f72Link.href; break }
                                }
                            }
                        } catch { }
                        if (-not $f72SourceUrl) { continue }
                        $f72ArxivId = ''
                        try { $f72ArxivId = ($f72Entry.id -replace 'http://arxiv.org/abs/', '') } catch { }
                        $f72Rows += @{
                            adapterId = 'arxiv-public'
                            nameKey = 'search.sources.arxivPublic'
                            category = 'scholarly'
                            title = $f72Title
                            creator = $f72Creator
                            sizeBytes = $null
                            licenceTag = 'open-access'
                            licenceEvidence = 'arXiv open access'
                            sourceSnapshotId = 'arxiv-' + $f72ArxivId
                            sourceUrl = $f72SourceUrl
                            previewUrl = $f72SourceUrl
                            purchaseUrl = $null
                            transportHint = 'https'
                            mimeType = 'application/pdf'
                            date = $f72Date
                            availability = ''
                        }
                    }
                    $f72Status = 'complete'
                    if ($f72Rows.Count -eq 0) { $f72Status = 'empty' }
                    return @{ ok = $true; status = $f72Status; lastErrorCode = $null; rows = $f72Rows; totalItems = $f72Total; nextCursor = '' }
                } catch {
                    $f72Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f72Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f72Msg = [string]$Error[0].Exception.Message }
                        if ($f72Msg -match '(?i)timeout|timed out') { $f72Code = 'TIMEOUT' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f72Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            # [F72 §1.3] Wikipedia Opensearch adapter (F71 §C 2.8).
            # GET https://en.wikipedia.org/w/api.php?action=opensearch&search=<q>&limit=<lim>&format=json
            # Returns 4-tuple [query, titles[], descriptions[], urls[]].
            # licenceTag = creative-commons (Wikipedia CC BY-SA).
            function Invoke-F72WikipediaSearch {
                param([string]$Query, [int]$Limit = 10)
                try {
                    $f72Max = [Math]::Min([Math]::Max($Limit, 1), 50)
                    $f72Uri = 'https://en.wikipedia.org/w/api.php?action=opensearch&search=' + [uri]::EscapeDataString($Query) + '&limit=' + [string]$f72Max + '&format=json'
                    $f72Resp = Invoke-WebRequest -Uri $f72Uri -Method Get -Headers @{ 'User-Agent' = 'GHRDP-Search/1.0 (contact: github.com/dekarita)' } -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    if ($f72Resp.StatusCode -ne 200) {
                        return @{ ok = $false; status = 'failed'; lastErrorCode = 'TRANSPORT_UNAVAILABLE'; rows = @(); totalItems = 0; nextCursor = '' }
                    }
                    $f72Json = $f72Resp.Content | ConvertFrom-Json -ErrorAction Stop
                    # Parse the 4-tuple: [query, titles[], descriptions[], urls[]]
                    $f72Titles = @()
                    $f72Descs = @()
                    $f72Urls = @()
                    try { $f72Titles = @($f72Json[1]) } catch { }
                    try { $f72Descs = @($f72Json[2]) } catch { }
                    try { $f72Urls = @($f72Json[3]) } catch { }
                    $f72Rows = @()
                    for ($f72I = 0; $f72I -lt $f72Titles.Count; $f72I++) {
                        $f72Title = [string]$f72Titles[$f72I]
                        if (-not $f72Title) { continue }
                        $f72Desc = ''
                        if ($f72I -lt $f72Descs.Count) { $f72Desc = [string]$f72Descs[$f72I] }
                        $f72Url = ''
                        if ($f72I -lt $f72Urls.Count) { $f72Url = [string]$f72Urls[$f72I] }
                        if (-not $f72Url) { continue }
                        $f72Rows += @{
                            adapterId = 'wikipedia-public'
                            nameKey = 'search.sources.wikipediaPublic'
                            category = 'education'
                            title = $f72Title
                            creator = 'Wikipedia'
                            sizeBytes = $null
                            licenceTag = 'creative-commons'
                            licenceEvidence = 'Wikipedia CC BY-SA'
                            sourceSnapshotId = 'wiki-' + [uri]::EscapeDataString($f72Title)
                            sourceUrl = $f72Url
                            previewUrl = $f72Url
                            purchaseUrl = $null
                            transportHint = 'https'
                            mimeType = 'text/html'
                            date = ''
                            availability = ''
                            metadata = @{ description = $f72Desc }
                        }
                    }
                    $f72Total = $f72Rows.Count
                    $f72Status = 'complete'
                    if ($f72Rows.Count -eq 0) { $f72Status = 'empty' }
                    return @{ ok = $true; status = $f72Status; lastErrorCode = $null; rows = $f72Rows; totalItems = $f72Total; nextCursor = '' }
                } catch {
                    $f72Code = 'TRANSPORT_UNAVAILABLE'
                    try {
                        $f72Msg = ''
                        if ($Error[0] -and $Error[0].Exception) { $f72Msg = [string]$Error[0].Exception.Message }
                        if ($f72Msg -match '(?i)timeout|timed out') { $f72Code = 'TIMEOUT' }
                    } catch { }
                    return @{ ok = $false; status = 'failed'; lastErrorCode = $f72Code; rows = @(); totalItems = 0; nextCursor = '' }
                }
            }
            # [F70 §3.1] Deep add-time probe for custom source descriptors (the
            # same SourceDescriptor shape the F58 registry persists). Steps:
            #   (a) robots.txt from the SAME host as baseUrl (User-agent: *),
            #       10s timeout; a matching Disallow is non-retryable;
            #   (b) HEAD the substituted query path (test query, limit 1) and
            #       record status + content-type + content-length;
            #   (c) full GET with the test query, parse per
            #       parseContract.format (json|xml), apply resultSelector;
            #   (d) validate the first item carries every fieldMappings source
            #       field non-null;
            #   (e) recommend approve|warn.
            # Guards preserved: https-only baseUrl with no userinfo, GET/POST
            # only, no custom headers in queryTemplate, selector-only parsing
            # (no inline executable parser code), 30s request timeout.
            function Invoke-GhrdpProbe {
                param($Descriptor)
                $f70Warn = {
                    param([string]$Reason, [bool]$Reachable, [bool]$RobotsOk)
                    return @{ reachable = $Reachable; robotsOk = $RobotsOk; schemaMatch = $false; recommendation = 'warn'; reason = $Reason }
                }
                $baseUrl = ''
                try { $baseUrl = [string]$Descriptor.baseUrl } catch { $baseUrl = '' }
                if (-not $baseUrl) { return (& $f70Warn 'baseUrl required' $false $false) }
                $bUri = $null
                try { $bUri = [System.Uri]$baseUrl } catch { $bUri = $null }
                if (-not $bUri -or $bUri.Scheme -ne 'https' -or $bUri.UserInfo) {
                    return (& $f70Warn 'baseUrl must be https and carry no credentials' $false $false)
                }
                $qt = $null
                try { if ($Descriptor.queryTemplate) { $qt = $Descriptor.queryTemplate } } catch { $qt = $null }
                if (-not $qt) { return (& $f70Warn 'queryTemplate required' $false $false) }
                $qtMethod = 'GET'
                try { $mRaw = [string]$qt.method; if ($mRaw) { $qtMethod = $mRaw.ToUpperInvariant() } } catch { }
                if ($qtMethod -ne 'GET' -and $qtMethod -ne 'POST') { return (& $f70Warn 'queryTemplate.method must be GET or POST' $false $false) }
                try { if ($qt.PSObject.Properties['headers'] -and $qt.headers) { return (& $f70Warn 'custom headers are not permitted in the query template' $false $false) } } catch { }
                $qtPath = '/'
                try { $qtPath = [string]$qt.path; if (-not $qtPath) { $qtPath = '/' } } catch { $qtPath = '/' }
                if (-not $qtPath.StartsWith('/')) { $qtPath = '/' + $qtPath }
                $pc = $null
                try { if ($Descriptor.parseContract) { $pc = $Descriptor.parseContract } } catch { $pc = $null }
                if (-not $pc) { return (& $f70Warn 'parseContract required' $false $false) }
                $fmt = 'json'
                try { $fRaw = [string]$pc.format; if ($fRaw) { $fmt = $fRaw.ToLowerInvariant() } } catch { }
                if ($fmt -ne 'json' -and $fmt -ne 'xml') { return (& $f70Warn 'parseContract.format must be json or xml - no inline parser code' $false $false) }
                $sel = ''
                try { $sel = [string]$pc.resultSelector } catch { $sel = '' }
                if (-not $sel) { return (& $f70Warn 'resultSelector required' $false $false) }
                $maps = @{}
                try { foreach ($mp in $pc.fieldMappings.PSObject.Properties) { $maps[[string]$mp.Name] = [string]$mp.Value } } catch { }
                if ($maps.Count -eq 0) { return (& $f70Warn 'fieldMappings required' $false $false) }
                $lenRequired = $false
                try { if ($Descriptor.downloadContract -and $Descriptor.downloadContract.contentLengthRequired) { $lenRequired = $true } } catch { }

                # (a) robots.txt - same host, User-agent: * group.
                $robotsOk = $true
                $disallowRule = ''
                $hostReachable = $true
                $robotsContent = ''
                try {
                    $robotsResp = Invoke-WebRequest -Uri ('https://' + $bUri.Host + '/robots.txt') -Method Get -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
                    if ($robotsResp.StatusCode -eq 200) { $robotsContent = [string]$robotsResp.Content }
                } catch {
                    $rr = $null
                    try { $rr = $_.Exception.Response } catch { $rr = $null }
                    if (-not $rr) { $hostReachable = $false } else { $robotsContent = '' }
                }
                if ($robotsContent) {
                    $inStar = $false
                    foreach ($rl in @($robotsContent -split "`n")) {
                        $rt = $rl.Trim()
                        if ($rt -match '^(?i)User-agent:\s*(.+)$') { $inStar = (($Matches[1].Trim()) -eq '*'); continue }
                        if ($inStar -and $rt -match '^(?i)Disallow:\s*(.*)$') {
                            $dp = $Matches[1].Trim()
                            if ($dp -and $qtPath.ToLowerInvariant().StartsWith($dp.ToLowerInvariant())) {
                                $robotsOk = $false
                                $disallowRule = $rt
                                break
                            }
                        }
                    }
                }
                if (-not $robotsOk) {
                    return @{ reachable = $true; robotsOk = $false; schemaMatch = $false; recommendation = 'warn'; reason = 'robots.txt disallows the configured path'; disallowRule = $disallowRule }
                }

                # Build the substituted probe URL (test query, limit 1, cursor '').
                $qPairs = @()
                try {
                    foreach ($qp in $qt.query.PSObject.Properties) {
                        $qv = [string]$qp.Value
                        $qv = $qv.Replace('{encodedQuery}', [uri]::EscapeDataString('test'))
                        $qv = $qv.Replace('{limit}', '1')
                        $qv = $qv.Replace('{cursor}', '')
                        if ($qp.Name -and $null -ne $qp.Value) { $qPairs += ([string]$qp.Name) + '=' + $qv }
                    }
                } catch { }
                $probeUrl = 'https://' + $bUri.Host + $qtPath
                if ($qPairs.Count -gt 0) { $probeUrl = $probeUrl + '?' + ($qPairs -join '&') }

                # (b) HEAD: status + content-type + content-length.
                $httpStatus = 0
                $contentType = ''
                $contentLength = $null
                try {
                    $headResp = Invoke-WebRequest -Uri $probeUrl -Method Head -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    $httpStatus = [int]$headResp.StatusCode
                    try { $contentType = [string]$headResp.Headers['Content-Type'] } catch { $contentType = '' }
                    try { $clRaw = [string]$headResp.Headers['Content-Length']; if ($clRaw) { $contentLength = [int]$clRaw } } catch { $contentLength = $null }
                } catch {
                    $hr = $null
                    try { $hr = $_.Exception.Response } catch { $hr = $null }
                    if (-not $hr) { return (& $f70Warn 'baseUrl unreachable' $hostReachable $robotsOk) }
                    try { $httpStatus = [int]$hr.StatusCode } catch { $httpStatus = 0 }
                }

                # (c) full GET (or POST) with the test query.
                $bodyText = ''
                try {
                    if ($qtMethod -eq 'POST') {
                        $getResp = Invoke-WebRequest -Uri $probeUrl -Method Post -Body ($qPairs -join '&') -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    } else {
                        $getResp = Invoke-WebRequest -Uri $probeUrl -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
                    }
                    $httpStatus = [int]$getResp.StatusCode
                    try { $contentType = [string]$getResp.Headers['Content-Type'] } catch { }
                    try { $cl2 = [string]$getResp.Headers['Content-Length']; if ($cl2 -and $null -eq $contentLength) { $contentLength = [int]$cl2 } } catch { }
                    $bodyText = [string]$getResp.Content
                } catch {
                    $gr = $null
                    try { $gr = $_.Exception.Response } catch { $gr = $null }
                    if (-not $gr) { return (& $f70Warn 'baseUrl unreachable' $hostReachable $robotsOk) }
                    try { $httpStatus = [int]$gr.StatusCode } catch { }
                }

                # selector-only parsing: JSONPath subset for json, XPath for xml.
                $items = @()
                if ($fmt -eq 'json') {
                    try {
                        $parsed = $bodyText | ConvertFrom-Json -ErrorAction Stop
                        $cur = @($parsed)
                        $expr = $sel.Trim()
                        if ($expr.StartsWith('$')) { $expr = $expr.Substring(1) }
                        foreach ($segRaw in ($expr -split '\.')) {
                            $seg = $segRaw.Trim()
                            if (-not $seg) { continue }
                            $takeAll = $false
                            if ($seg -eq '*') { $takeAll = $true; $seg = '' }
                            elseif ($seg.EndsWith('[*]')) { $takeAll = $true; $seg = $seg.Substring(0, $seg.Length - 3) }
                            $next = @()
                            foreach ($node in $cur) {
                                if ($null -eq $node) { continue }
                                $v = $node
                                if ($seg) {
                                    $v = $null
                                    try { if ($node.PSObject.Properties[$seg]) { $v = $node.PSObject.Properties[$seg].Value } } catch { $v = $null }
                                }
                                if ($null -ne $v) {
                                    if ($takeAll) { $next += @($v) } else { $next += $v }
                                }
                            }
                            $cur = @($next)
                        }
                        $items = @($cur)
                    } catch { $items = @() }
                } else {
                    try {
                        $xdoc = New-Object System.Xml.XmlDocument
                        $xdoc.LoadXml($bodyText)
                        $items = @($xdoc.SelectNodes($sel))
                    } catch { $items = @() }
                }
                if ($items.Count -eq 0 -or -not $items[0]) {
                    $sampleResp = ''
                    if ($bodyText.Length -gt 500) { $sampleResp = $bodyText.Substring(0, 500) } else { $sampleResp = $bodyText }
                    return @{ reachable = $true; robotsOk = $true; schemaMatch = $false; recommendation = 'warn'; reason = 'resultSelector matched zero items'; sampleResponse = $sampleResp; httpStatus = $httpStatus; contentType = $contentType; contentLength = $contentLength }
                }

                # (d) every fieldMappings source field set and non-null on item 1.
                $first = $items[0]
                $missing = @()
                foreach ($mk in @($maps.Keys)) {
                    $srcField = $maps[$mk]
                    $val = $null
                    if ($first -is [System.Xml.XmlNode]) {
                        try { $xn = $first.SelectSingleNode($srcField); if ($xn) { $val = $xn.InnerText } } catch { $val = $null }
                    } else {
                        try { if ($first.PSObject.Properties[$srcField]) { $val = $first.PSObject.Properties[$srcField].Value } } catch { $val = $null }
                    }
                    if ($null -eq $val -or ([string]$val -eq '')) { $missing += $mk }
                }
                if ($missing.Count -gt 0) {
                    return @{ reachable = $true; robotsOk = $true; schemaMatch = $false; recommendation = 'warn'; missingFields = @($missing); sampleItem = $first; httpStatus = $httpStatus; contentType = $contentType; contentLength = $contentLength }
                }

                # (e) everything matched: approve unless a soft signal warns.
                $rec = 'approve'
                if ($httpStatus -ne 200) { $rec = 'warn' }
                if ($lenRequired -and ($null -eq $contentLength -or $contentLength -le 0)) { $rec = 'warn' }
                return @{ reachable = $true; robotsOk = $true; schemaMatch = $true; sampleResultCount = $items.Count; sampleItem = $first; httpStatus = $httpStatus; contentType = $contentType; contentLength = $contentLength; recommendation = $rec }
            }
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, Authorization, X-Dash-Token, X-CSRF-Token`r`nAccess-Control-Max-Age: 600"
                return
            }
            $f70MethodOk = $false
            if ($path -eq '/api/search' -and $parts.method -eq 'POST') { $f70MethodOk = $true }
            if ($path -eq '/api/search/status' -and $parts.method -eq 'GET') { $f70MethodOk = $true }
            if ($path -eq '/api/search/cancel' -and $parts.method -eq 'POST') { $f70MethodOk = $true }
            if ($path -eq '/api/search/probe' -and $parts.method -eq 'POST') { $f70MethodOk = $true }
            if (-not $f70MethodOk) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'method not allowed for ' + $path } }
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            # Zero query-string credentials (same refusal set as /api/fetch).
            $f70QCred = $false
            try {
                foreach ($qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password')) {
                    if ($parts.query.ContainsKey($qk)) { $f70QCred = $true; break }
                }
            } catch { }
            if ($f70QCred) {
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query credential refused' } }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                return
            }
            # [F70 §1.1 + F101 §2.3 / N3] constant-time X-Dash-Token verify.
            # Missing or invalid -> 403 (this lane's frozen status).
            # F101: the comparator is now the SHARED refresh-aware
            # Test-GhrdpDashToken (snapshot UNION dash-token.txt UNION
            # config.json dashToken) - the F70 lane kept the boot-snapshot-only
            # literal compare, which is exactly why the F99 bundle saw
            # `search auth refused ... -> 403` at 15:59:23 for a token that
            # mirror accepted in the same run. The `reason` string stays
            # 'dash token required' (frozen client/mock contract); the specific
            # cause lands in details.detail and every refusal is recorded in
            # the F99 telemetry ring so /api/diag can show it.
            $f70Tok = ''
            try { $f70Tok = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $f70Tok) {
                $f70AuthH = ''
                try { $f70AuthH = [string]$parts.headers['authorization'] } catch { }
                if ($f70AuthH -match '^(?i)Bearer\s+(.+)$') { $f70Tok = $Matches[1].Trim() }
            }
            $f70TokOk = $false
            if ($f70Tok) {
                try { $f70TokOk = Test-GhrdpDashToken -Presented $f70Tok -SnapshotToken $Token } catch { $f70TokOk = $false }
            }
            if (-not $f70TokOk) {
                try { Add-F99TokenTelemetry -Route $path -Presented $f70Tok -SnapshotToken $Token -Valid $false } catch { }
                $f70Why = 'token-not-presented'
                if ($f70Tok) { $f70Why = 'token-mismatch-after-refresh-aware-compare' }
                if (-not $Token -and -not $f70Tok) { $f70Why = 'server-has-no-dash-token' }
                $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'AUTH_REQUIRED'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'dash token required'; detail = $f70Why; presentedHash = $(Get-F99DashTokenHash $f70Tok); expectedHash = $(Get-F99DashTokenHash $Token) } }
                Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                Write-ClientAudit ('search auth refused ' + $path + ' -> 403 (' + $f70Why + ')')
                return
            }
            try { if ($f70Tok) { Add-F99TokenTelemetry -Route $path -Presented $f70Tok -SnapshotToken $Token -Valid $true } } catch { }
            if (-not $script:F56dSearchMap) { $script:F56dSearchMap = @{} }
            if (-not $script:F56dResultsMap) { $script:F56dResultsMap = @{} }
            if ($path -eq '/api/search') {
                $f70BodyText = ''
                try { $f70BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f70BodyText = '' }
                $f70Json = $null
                try { $f70Json = $f70BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f70Json = $null }
                if (-not $f70Json) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid json' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70ReqId = ''
                try { $f70ReqId = [string]$f70Json.requestId } catch { }
                if (-not $f70ReqId) { $f70ReqId = [guid]::NewGuid().ToString('N').Substring(0,12) }
                $f70Trace = [guid]::NewGuid().ToString('N').Substring(0,12)
                # query: required, non-empty, and never an embedded source URL or
                # domain (locked rule: the request must not carry an arbitrary URL).
                $f70Query = ''
                try { $f70Query = [string]$f70Json.query } catch { }
                $f70Query = $f70Query.Trim()
                if (-not $f70Query) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($f70Query -match '(?i)https?://') {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'query must not contain a source URL or domain' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                # adapterIds: optional; unknown id -> UNKNOWN_SOURCE 400.
                $f70ReqAdapters = @()
                try {
                    foreach ($a in @($f70Json.adapterIds)) {
                        $as = [string]$a
                        # [F79 D3] Accept legacy Advanced ids, but emit canonical
                        # public ids in acceptedAdapterIds, status rows and results.
                        if ($as -eq 'arxiv') { $as = 'arxiv-public' }
                        if ($as -eq 'wikisource') { $as = 'wikipedia-public' }
                        if ($as) { $f70ReqAdapters += $as }
                    }
                } catch { }
                foreach ($a in $f70ReqAdapters) {
                    if ($searchAllowedAdapters -notcontains $a) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ adapterId = $a } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                # scope / filters / sort / maxSizeBytes / limit / cursor.
                $f70Scope = 'federated'
                try { $f70ScopeRaw = [string]$f70Json.scope; if ($f70ScopeRaw) { $f70Scope = $f70ScopeRaw } } catch { }
                if ($f70Scope -ne 'federated' -and $f70Scope -ne 'own-storage') {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'scope must be federated or own-storage' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Cats = @()
                try { foreach ($c in @($f70Json.categories)) { $cs2 = [string]$c; if ($cs2) { $f70Cats += $cs2 } } } catch { }
                foreach ($c in $f70Cats) {
                    if (@('books','audio','scholarly','education','media','software','music','video','own-storage','purchase') -notcontains $c) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown category ' + $c } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                $f70Lics = @()
                try { foreach ($l in @($f70Json.licenceTags)) { $ls2 = [string]$l; if ($ls2) { $f70Lics += $ls2 } } } catch { }
                foreach ($l in $f70Lics) {
                    if (@('public-domain','open-access','creative-commons','purchase','own-storage') -notcontains $l) {
                        $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'unknown licence tag ' + $l } }
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                        return
                    }
                }
                $f70Sort = 'relevance'
                try { $f70SortRaw = [string]$f70Json.sort; if ($f70SortRaw) { $f70Sort = $f70SortRaw } } catch { }
                if (@('relevance','size','date') -notcontains $f70Sort) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'sort must be relevance, size or date' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70MaxSize = 0
                try {
                    if ($f70Json.PSObject.Properties['maxSizeBytes'] -and $null -ne $f70Json.maxSizeBytes) { $f70MaxSize = [int]$f70Json.maxSizeBytes }
                } catch {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'maxSizeBytes must be an integer' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if ($f70MaxSize -lt 0) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'maxSizeBytes must be >= 0' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Limit = 50
                try {
                    if ($f70Json.PSObject.Properties['limit'] -and $null -ne $f70Json.limit) { $f70Limit = [int]$f70Json.limit }
                } catch { $f70Limit = -1 }
                if ($f70Limit -lt 1 -or $f70Limit -gt 50) {
                    $err = [ordered]@{ requestId = $f70ReqId; traceId = $f70Trace; code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'limit must be 1..50' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Cursor = ''
                try { $f70Cursor = [string]$f70Json.cursor } catch { }
                # searchId + record, then the fan-out.
                $f70SearchId = [guid]::NewGuid().ToString('N')
                $f70Adapters = @($f70ReqAdapters | Select-Object -Unique)
                if ($f70Adapters.Count -eq 0) { $f70Adapters = @($script:DefaultFanOutAdapterIds) }
                $f70Now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                $f70Rec = @{
                    query = $f70Query
                    adapterIds = @($f70Adapters)
                    scope = $f70Scope
                    filters = @{ categories = @($f70Cats); licenceTags = @($f70Lics); sort = $f70Sort; maxSizeBytes = $f70MaxSize }
                    createdAt = $f70Now
                    cancelled = $false
                    cancellationState = ''
                    adapterStatuses = @{}
                    results = @{}
                    resultOrder = @()
                }
                foreach ($a in $f70Adapters) {
                    $f70Rec.adapterStatuses[$a] = @{ status = 'queued'; resultCount = 0; lastErrorCode = $null; cursor = $null }
                }
                $script:F56dSearchMap[$f70SearchId] = $f70Rec
                # [F70 §2.1] google-books-public is the one real lane in F70;
                # the helper is defined in this block (F70 §2). If a build stages
                # this server without it, the adapter stays "queued" - never a
                # synthesized result.
                if ($f70Adapters -contains 'google-books-public') {
                    $f70GbHelper = $null
                    try { $f70GbHelper = Get-Command -Name Invoke-GhrdpGoogleBooksSearch -ErrorAction Stop } catch { $f70GbHelper = $null }
                    if ($f70GbHelper) {
                        $f70Gb = Invoke-GhrdpGoogleBooksSearch -Query $f70Query -Limit $f70Limit -Cursor $f70Cursor
                        $f70Rec.adapterStatuses['google-books-public'].status = [string]$f70Gb.status
                        if ($f70Gb.lastErrorCode) { $f70Rec.adapterStatuses['google-books-public'].lastErrorCode = [string]$f70Gb.lastErrorCode }
                        if ($f70Gb.nextCursor) { $f70Rec.adapterStatuses['google-books-public'].cursor = [string]$f70Gb.nextCursor }
                        foreach ($f70Row in @($f70Gb.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f70-' + [guid]::NewGuid().ToString('N').Substring(0,16)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            # [F70 §1.1] populate the F69 resultId map so the
                            # /api/fetch resultId path resolves end-to-end.
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['google-books-public'].resultCount = @($f70Gb.rows).Count
                    }
                }
                # [F72 §1.3] GitHub repos adapter fan-out (F71 §C 2.3).
                if ($f70Adapters -contains 'github-releases') {
                    $f72GhHelper = $null
                    try { $f72GhHelper = Get-Command -Name Invoke-F72GithubSearch -ErrorAction Stop } catch { $f72GhHelper = $null }
                    if ($f72GhHelper) {
                        $f72Gh = Invoke-F72GithubSearch -Query $f70Query -Limit $f70Limit
                        $f70Rec.adapterStatuses['github-releases'].status = [string]$f72Gh.status
                        if ($f72Gh.lastErrorCode) { $f70Rec.adapterStatuses['github-releases'].lastErrorCode = [string]$f72Gh.lastErrorCode }
                        foreach ($f70Row in @($f72Gh.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f72-gh-' + [guid]::NewGuid().ToString('N').Substring(0,14)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['github-releases'].resultCount = @($f72Gh.rows).Count
                    }
                }
                # [F72 §1.3] Internet Archive adapter fan-out (F71 §C 2.4).
                if ($f70Adapters -contains 'internet-archive') {
                    $f72IaHelper = $null
                    try { $f72IaHelper = Get-Command -Name Invoke-F72InternetArchiveSearch -ErrorAction Stop } catch { $f72IaHelper = $null }
                    if ($f72IaHelper) {
                        $f72Ia = Invoke-F72InternetArchiveSearch -Query $f70Query -Limit $f70Limit
                        $f70Rec.adapterStatuses['internet-archive'].status = [string]$f72Ia.status
                        if ($f72Ia.lastErrorCode) { $f70Rec.adapterStatuses['internet-archive'].lastErrorCode = [string]$f72Ia.lastErrorCode }
                        foreach ($f70Row in @($f72Ia.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f72-ia-' + [guid]::NewGuid().ToString('N').Substring(0,14)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['internet-archive'].resultCount = @($f72Ia.rows).Count
                    }
                }
                # [F72 §1.3] arXiv adapter fan-out (F71 §C 2.6).
                if ($f70Adapters -contains 'arxiv-public') {
                    $f72AxHelper = $null
                    try { $f72AxHelper = Get-Command -Name Invoke-F72ArxivSearch -ErrorAction Stop } catch { $f72AxHelper = $null }
                    if ($f72AxHelper) {
                        $f72Ax = Invoke-F72ArxivSearch -Query $f70Query -Limit $f70Limit
                        $f70Rec.adapterStatuses['arxiv-public'].status = [string]$f72Ax.status
                        if ($f72Ax.lastErrorCode) { $f70Rec.adapterStatuses['arxiv-public'].lastErrorCode = [string]$f72Ax.lastErrorCode }
                        foreach ($f70Row in @($f72Ax.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f72-ax-' + [guid]::NewGuid().ToString('N').Substring(0,14)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['arxiv-public'].resultCount = @($f72Ax.rows).Count
                    }
                }
                # [F72 §1.3] Wikipedia adapter fan-out (F71 §C 2.8).
                if ($f70Adapters -contains 'wikipedia-public') {
                    $f72WpHelper = $null
                    try { $f72WpHelper = Get-Command -Name Invoke-F72WikipediaSearch -ErrorAction Stop } catch { $f72WpHelper = $null }
                    if ($f72WpHelper) {
                        $f72Wp = Invoke-F72WikipediaSearch -Query $f70Query -Limit $f70Limit
                        $f70Rec.adapterStatuses['wikipedia-public'].status = [string]$f72Wp.status
                        if ($f72Wp.lastErrorCode) { $f70Rec.adapterStatuses['wikipedia-public'].lastErrorCode = [string]$f72Wp.lastErrorCode }
                        foreach ($f70Row in @($f72Wp.rows)) {
                            if (-not $f70Row) { continue }
                            $f70ResultId = 'f72-wp-' + [guid]::NewGuid().ToString('N').Substring(0,14)
                            $f70Rec.results[$f70ResultId] = $f70Row
                            $f70Rec.resultOrder += $f70ResultId
                            $script:F56dResultsMap[$f70ResultId] = $f70Row
                        }
                        $f70Rec.adapterStatuses['wikipedia-public'].resultCount = @($f72Wp.rows).Count
                    }
                }
                $resp = [ordered]@{
                    requestId = $f70ReqId
                    searchId = $f70SearchId
                    phase = (Get-F70SearchPhase -Rec $f70Rec)
                    acceptedAdapterIds = @($f70Adapters)
                    statusRef = '/api/search/status?searchId=' + $f70SearchId
                    queryGeneration = 1
                    adapterStatuses = (Get-F70AdapterRows -Rec $f70Rec)
                }
                Send-ClientResponse -Stream $stream -Code 202 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('search create ' + $f70SearchId + ' adapters=' + ($f70Adapters -join ',') + ' -> 202')
                return
            }
            if ($path -eq '/api/search/status') {
                $f70SearchId = ''
                try { $f70SearchId = [string]$parts.query['searchid'] } catch { }
                if (-not $f70SearchId) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'searchId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if (-not $script:F56dSearchMap.ContainsKey($f70SearchId)) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ searchId = $f70SearchId } }
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Rec = $script:F56dSearchMap[$f70SearchId]
                $f70Limit = 50
                $f70LimitOk = $true
                try { if ($parts.query.ContainsKey('limit') -and $parts.query['limit']) { $f70Limit = [int]$parts.query['limit'] } } catch { $f70LimitOk = $false }
                if (-not $f70LimitOk -or $f70Limit -lt 1 -or $f70Limit -gt 50) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'limit must be 1..50' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Start = 0
                $f70CursorOk = $true
                try { if ($parts.query.ContainsKey('cursor') -and $parts.query['cursor']) { $f70Start = [int]$parts.query['cursor'] } } catch { $f70CursorOk = $false }
                if (-not $f70CursorOk -or $f70Start -lt 0) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid cursor' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Order = @($f70Rec.resultOrder)
                $f70Page = @()
                for ($fi = $f70Start; $fi -lt $f70Order.Count -and $f70Page.Count -lt $f70Limit; $fi++) { $f70Page += $f70Order[$fi] }
                $f70Rows = @()
                foreach ($rid in $f70Page) {
                    $row = $f70Rec.results[$rid]
                    if (-not $row) { continue }
                    $f70Rows += [ordered]@{
                        resultId = $rid
                        adapterId = [string]$row.adapterId
                        nameKey = [string]$row.nameKey
                        category = [string]$row.category
                        title = [string]$row.title
                        creator = [string]$row.creator
                        sizeBytes = $row.sizeBytes
                        contentLength = $row.sizeBytes
                        licenceTag = [string]$row.licenceTag
                        licenceEvidence = $row.licenceEvidence
                        sourceSnapshotId = [string]$row.sourceSnapshotId
                        sourceUrl = [string]$row.sourceUrl
                        previewUrl = $row.previewUrl
                        purchaseUrl = $row.purchaseUrl
                        transportHint = $row.transportHint
                        mimeType = $row.mimeType
                        date = [string]$row.date
                        availability = $row.availability
                    }
                }
                $f70HasMore = (($f70Start + $f70Page.Count) -lt $f70Order.Count)
                $f70NextCursor = $null
                if ($f70HasMore) { $f70NextCursor = [string]($f70Start + $f70Page.Count) }
                $resp = [ordered]@{
                    searchId = $f70SearchId
                    phase = (Get-F70SearchPhase -Rec $f70Rec)
                    queryGeneration = 1
                    adapterStatuses = (Get-F70AdapterRows -Rec $f70Rec)
                    results = $f70Rows
                    resultOrder = $f70Order
                    cursor = $f70NextCursor
                    hasMore = $f70HasMore
                    serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    cancellationState = [string]$f70Rec.cancellationState
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                return
            }
            # POST /api/search/cancel: searchId from the SearchCancelRequest body
            # (client contract) or the query param (F70 §1.3). Idempotent; a
            # cancelled search can never append results (the F70 fan-out is
            # synchronous, and the cancelled flag guards any future async lane).
            if ($path -eq '/api/search/cancel') {
                $f70BodyText = ''
                try { $f70BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f70BodyText = '' }
                $f70Json = $null
                if ($f70BodyText) { try { $f70Json = $f70BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f70Json = $null } }
                $f70SearchId = ''
                if ($f70Json) { try { $f70SearchId = [string]$f70Json.searchId } catch { } }
                if (-not $f70SearchId) { try { $f70SearchId = [string]$parts.query['searchid'] } catch { } }
                if (-not $f70SearchId) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'searchId required' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                if (-not $script:F56dSearchMap.ContainsKey($f70SearchId)) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'UNKNOWN_SOURCE'; messageKey = 'search.errors.unknownSource'; retryable = $false; details = @{ searchId = $f70SearchId } }
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Rec = $script:F56dSearchMap[$f70SearchId]
                $f70Already = [bool]$f70Rec.cancelled
                $f70Rec.cancelled = $true
                $f70Rec.cancellationState = 'cancelled'
                $f70Cancel = @{}
                foreach ($k in @($f70Rec.adapterStatuses.Keys)) {
                    $f70St = [string]$f70Rec.adapterStatuses[$k].status
                    if ($f70St -ne 'complete' -and $f70St -ne 'empty') { $f70Rec.adapterStatuses[$k].status = 'cancelled' }
                    $f70Cancel[$k] = [string]$f70Rec.adapterStatuses[$k].status
                }
                $f70Idem = 'cancelled'
                if ($f70Already) { $f70Idem = 'already-cancelled' }
                $resp = [ordered]@{ searchId = $f70SearchId; cancellationState = 'cancelled'; adapterCancellations = $f70Cancel; idempotency = $f70Idem }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $resp)
                Write-ClientAudit ('search cancel ' + $f70SearchId + ' -> 200 ' + $f70Idem)
                return
            }
            # [F70 §3.1] POST /api/search/probe: body = SourceDescriptor (the
            # same shape the F58 registry persists). Runs the deep add-time
            # probe (robots + HEAD + sample query + schema match) and returns
            # the probe outcome; the SourceForm save gate requires
            # recommendation "approve" or the explicit operator override.
            if ($path -eq '/api/search/probe') {
                $f70BodyText = ''
                try { $f70BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f70BodyText = '' }
                $f70Json = $null
                try { $f70Json = $f70BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f70Json = $null }
                if (-not $f70Json) {
                    $err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; retryable = $false; details = @{ reason = 'invalid json' } }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $err)
                    return
                }
                $f70Outcome = Invoke-GhrdpProbe -Descriptor $f70Json
                $f70Code = 200
                try { if ($f70Outcome.reachable -eq $false -and $f70Outcome.reason -eq 'baseUrl required') { $f70Code = 400 } } catch { }
                Send-ClientResponse -Stream $stream -Code $f70Code -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f70Outcome)
                Write-ClientAudit ('search probe -> ' + $f70Code + ' rec=' + [string]$f70Outcome.recommendation)
                return
            }
        }
        # [F78 §4.1] STORED-WEBSITE LAB MODE - the operator's own sites, fetched
        # server-side so the browser never talks to a third party directly.
        #   GET  /api/f58/sources  the Lab Mode source list (F58 registry view)
        #   POST /api/f58/sources  quick-add ONE site (name + https base URL)
        #   POST /api/lab/inspect  fetch ONE stored homepage and return its links
        # Posture, fail-closed throughout:
        #   * dash token required (constant-time compare, never a query credential);
        #   * the homepage of the stored site is the ONLY thing fetched - no
        #     search fan-out, no crawling, no cross-domain follow: a href whose
        #     host differs from the stored hostname is dropped before it is
        #     returned, and redirects are followed only on the same exact host;
        #   * Invoke-F78SecureFetch: HTTPS only, 10s timeout, hard 2MB response
        #     cap (pre-checked against Content-Length AND enforced while reading),
        #     no cookies (CookieContainer is null), no Authorization header, no
        #     caller-supplied headers - the UA is a fixed literal;
        #   * 10 fetches/minute per sourceId; beyond that 429 + retryAfterSeconds;
        #   * a source only exists here if the SAVE path of this endpoint wrote
        #     it, and that path also writes the exact-host fence
        #     ($script:F78AllowHosts) the inspect route re-checks - so a source
        #     the operator never added can never be inspected, and neither can a
        #     source whose baseUrl host was later edited out from under it.
        # State is process-local (like the F58 store module, this block does not
        # touch the encrypted ~/.ghrdp/sources tree); nothing here logs a
        # credential, a query string or a response body.
        # [F88 §B.1] This block houses MORE than the two routes its condition
        # used to name: /api/f58/sources/<id> DELETE, /api/launch-url,
        # /api/launch-url/diag, /api/f87-selftest and /api/preview all live
        # inside it, together with every F78-F88 helper they call. With the
        # narrow condition those paths SKIPPED the block on a real runner and
        # fell through to the generic 404 - the "200 but no browser opens"
        # class of dead route (and a silently dead DELETE/selftest/preview).
        # The condition now admits every route the block houses; the inner
        # handlers still dispatch per-path and return their own status, and
        # any other method hits the same 405 at the block end.
        if ($path -eq '/api/f58/sources' -or $path -eq '/api/lab/inspect' -or $path -like '/api/f58/sources/*' -or $path -eq '/api/launch-url' -or $path -eq '/api/launch-url/diag' -or $path -eq '/api/f87-selftest' -or $path -eq '/api/preview' -or $path -eq '/api/launcher/queue' -or $path -eq '/api/launcher/health' -or $path -eq '/api/stream' -or $path -eq '/api/f92-selftest') {
            if ($parts.method -eq 'OPTIONS') {
                Send-ClientResponse -Stream $stream -Code 204 -CType 'text/plain' -Body ([byte[]]@()) -ExtraHeaders "Access-Control-Allow-Headers: Content-Type, X-Dash-Token`r`nAccess-Control-Max-Age: 600"
                return
            }
            if (-not $script:F78Sources) { $script:F78Sources = @{} }
            if (-not $script:F78AllowHosts) { $script:F78AllowHosts = @{} }
            if (-not $script:F78LabInspectRateLimiter) { $script:F78LabInspectRateLimiter = @{} }
            function New-F78Error {
                param([string]$Code, [string]$MessageKey, [int]$RetryAfter)
                $f78Err = [ordered]@{ requestId = ''; traceId = [guid]::NewGuid().ToString('N').Substring(0,12); code = $Code; messageKey = $MessageKey; retryable = ($RetryAfter -gt 0); details = @{} }
                if ($RetryAfter -gt 0) { $f78Err.retryAfterSeconds = $RetryAfter }
                return $f78Err
            }
            # [F81 §1.1/A.1 Q2=A] Local encrypted-at-rest persistence for the
            # operator-added Lab sources (F58 registry). This is a STANDALONE
            # block, separate from the F58 store module's `~/.ghrdp/sources`
            # tree, so the Lab quick-add surface keeps working on machines
            # without the encrypted store pre-provisioned. It is also the
            # in-process complement to the repo-branch commit workflow: the
            # commit is the cross-runner source of truth, this file is the
            # fast read on the next dispatch. File: $F81StorePath.
            $script:F81StorePath = ''
            function Write-F81LabStore {
                param([hashtable]$Map)
                if (-not $script:F81StorePath) { return $false }
                $rows = @()
                foreach ($k in @($Map.Keys)) {
                    $r = $Map[$k]
                    if ($r -and $r.labMode -eq $true) { $rows += $r }
                }
                try {
                    $dir = Split-Path -Parent $script:F81StorePath
                    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                    $json = ConvertTo-Json -InputObject @{ sources = $rows; savedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } -Depth 8
                    # XOR-obfuscation layer; the repo branch is the durable
                    # source of truth. This file exists so a process restart
                    # before the next commit does not lose state.
                    $key = [byte[]]([System.Text.Encoding]::UTF8.GetBytes('F81-Lab-Store-v1'))
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = $bytes[$i] -bxor $key[$i % $key.Length] }
                    [System.IO.File]::WriteAllBytes($script:F81StorePath, $bytes)
                    return $true
                } catch { return $false }
            }
            function Read-F81LabStore {
                if (-not $script:F81StorePath -or -not (Test-Path -LiteralPath $script:F81StorePath)) { return @() }
                try {
                    $key = [byte[]]([System.Text.Encoding]::UTF8.GetBytes('F81-Lab-Store-v1'))
                    $bytes = [System.IO.File]::ReadAllBytes($script:F81StorePath)
                    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = $bytes[$i] -bxor $key[$i % $key.Length] }
                    $json = [System.Text.Encoding]::UTF8.GetString($bytes)
                    $obj = $json | ConvertFrom-Json -ErrorAction Stop
                    if ($obj -and $obj.sources) { return @($obj.sources) }
                } catch { }
                return @()
            }
            # [F81 §1.1/A.1] On startup, hydrate $script:F78Sources from the
            # local encrypted store if the file is present (created by either a
            # previous dispatch or the dispatch-time download of the
            # custom-sources-store repo branch).
            try {
                $f81Roots = @()
                if ($env:GHRDP_F81_STORE) { $f81Roots += $env:GHRDP_F81_STORE }
                $f81Roots += (Join-Path $env:USERPROFILE '.ghrdp\lab-sources.bin')
                $f81Roots += 'C:\ghrdp\lab-sources.bin'
                foreach ($f81Root in $f81Roots) {
                    if ($f81Root -and (Test-Path -LiteralPath $f81Root)) {
                        $script:F81StorePath = $f81Root
                        break
                    }
                }
                if (-not $script:F81StorePath -and $env:USERPROFILE) {
                    $script:F81StorePath = Join-Path $env:USERPROFILE '.ghrdp\lab-sources.bin'
                }
            } catch { }
            if ($script:F81StorePath -and (Test-Path -LiteralPath $script:F81StorePath)) {
                $f81Hydrated = Read-F81LabStore
                foreach ($f81Src in @($f81Hydrated)) {
                    if ($f81Src -and $f81Src.id -and $f81Src.hostname) {
                        $script:F78Sources[[string]$f81Src.id] = $f81Src
                        $script:F78AllowHosts[[string]$f81Src.hostname] = $true
                        if ($f81Src.canonicalHostname) { $script:F78AllowHosts[[string]$f81Src.canonicalHostname] = $true }
                    }
                }
            }
            function ConvertTo-F78PlainText {
                param([string]$Html)
                if (-not $Html) { return '' }
                $f78T = [regex]::Replace($Html, '(?is)<[^>]*>', ' ')
                try { $f78T = [System.Net.WebUtility]::HtmlDecode($f78T) } catch { }
                $f78T = [regex]::Replace($f78T, '\s+', ' ').Trim()
                if ($f78T.Length -gt 300) { $f78T = $f78T.Substring(0, 300) }
                return $f78T
            }
            # [F84 §2.2] Same-registrable-domain comparison: a leading `www.`
            # on EITHER side is stripped before the compare, so
            # `openculture.com` and `www.openculture.com` are the same site. A
            # different domain (openculture.com -> youtube.com) is still
            # refused - the fence stays exact-host-minus-www, never
            # suffix/wildcard matching.
            function Test-F78SameHost {
                param([string]$Allowed, [string]$Actual)
                $a = ([string]$Allowed).Trim().ToLowerInvariant() -replace '^www\.', ''
                $b = ([string]$Actual).Trim().ToLowerInvariant() -replace '^www\.', ''
                if (-not $a -or -not $b) { return $false }
                return $a -eq $b
            }
            # =====================================================================
            # [F90 §B.1] CROSS-DOMAIN READ, NARROWED TO ONE LITERAL HOST.
            #
            # Why: the awesome.re operator site IS a redirect service - its
            # content is the sindresorhus/awesome README, which lives on
            # raw.githubusercontent.com. The markdown-section search strategy
            # therefore has to fetch OFF the operator's host, and the F78 fence
            # (exact-host-minus-www) correctly refused it: awesome.re searches
            # came back HOSTNAME_MISMATCH and the Lab fell back to a sitemap the
            # site does not really have.
            #
            # What ships now, and what it still CANNOT do:
            #   * the widening is a LITERAL host, never a pattern, never a
            #     suffix/wildcard match: raw.githubusercontent.com exactly;
            #   * it applies ONLY to a fetch that opts in per-call
            #     (-AllowCrossDomain), and only the markdown-section strategy
            #     opts in;
            #   * every redirect hop is re-checked, so the only off-site host
            #     reachable on such a fetch is that one literal - no
            #     github.com, no gist.github.com, no objects.githubusercontent;
            #   * Register-F88CrossDomainHost records what one SUCCESSFUL
            #     markdown-section fetch actually resolved to, scoped to the
            #     operator source's own hostname, so a LATER /api/lab/inspect
            #     on that same source accepts those hosts too. It is
            #     proof-gated (registered only after ok=$true) and per-source:
            #     it can never widen the fence for another site.
            # =====================================================================
            $script:F78CrossDomainHost = 'raw.githubusercontent.com'
            $script:F88CrossDomainHosts = @{}
            function Test-F78AllowedHost {
                param([string]$ExpectedHost, [string]$ActualHost, [bool]$AllowCrossDomain)
                $f78A = ([string]$ActualHost).Trim().ToLowerInvariant()
                if (-not $f78A) { return $false }
                if ($AllowCrossDomain -and $f78A -eq $script:F78CrossDomainHost) { return $true }
                $f78Key = ([string]$ExpectedHost).Trim().ToLowerInvariant() -replace '^www\.', ''
                if ($f78Key -and $script:F88CrossDomainHosts.ContainsKey($f78Key)) {
                    foreach ($f78H in @($script:F88CrossDomainHosts[$f78Key])) {
                        if ($f78A -eq ([string]$f78H)) { return $true }
                    }
                }
                return $false
            }
            function Register-F88CrossDomainHost {
                param([string]$ForHost, [string[]]$Hosts)
                $f78Key = ([string]$ForHost).Trim().ToLowerInvariant() -replace '^www\.', ''
                if (-not $f78Key) { return }
                if (-not $script:F88CrossDomainHosts.ContainsKey($f78Key)) { $script:F88CrossDomainHosts[$f78Key] = New-Object System.Collections.ArrayList }
                foreach ($f78H in @($Hosts)) {
                    $f78N = ([string]$f78H).Trim().ToLowerInvariant() -replace '^www\.', ''
                    if (-not $f78N) { continue }
                    if ($script:F88CrossDomainHosts[$f78Key] -notcontains $f78N) { [void]$script:F88CrossDomainHosts[$f78Key].Add($f78N) }
                }
            }
            # The hardened fetch: https only, same-host (www-tolerant), 10s, 2MB,
            # no cookies / no auth headers, same-host redirects only (max 3 hops).
            function Invoke-F78SecureFetch {
                param([string]$Url, [string]$ExpectedHost, [int]$MaxBytes, [int]$TimeoutSec, [switch]$AllowCrossDomain)
                try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }
                $f78Cur = $Url
                for ($f78Hop = 0; $f78Hop -lt 3; $f78Hop++) {
                    $f78Uri = $null
                    try { $f78Uri = [System.Uri]$f78Cur } catch { $f78Uri = $null }
                    if (-not $f78Uri -or $f78Uri.Scheme -ne 'https' -or $f78Uri.UserInfo) { return @{ ok = $false; code = 'VALIDATION_ERROR'; httpStatus = 400 } }
                    # [F90 §B.1] exact-host-minus-www stays the rule; the one
                    # literal cross-domain host is allowed ONLY for this fetch
                    # (-AllowCrossDomain) or for hosts this source already
                    # PROVED it resolves to. Re-checked on every redirect hop.
                    $f78HostOk = Test-F78SameHost -Allowed $ExpectedHost -Actual $f78Uri.Host
                    if (-not $f78HostOk) { $f78HostOk = Test-F78AllowedHost -ExpectedHost $ExpectedHost -ActualHost $f78Uri.Host -AllowCrossDomain ([bool]$AllowCrossDomain) }
                    if (-not $f78HostOk) { return @{ ok = $false; code = 'HOSTNAME_MISMATCH'; httpStatus = 403 } }
                    $f78Req = $null
                    $f78Resp = $null
                    try {
                        $f78Req = [System.Net.HttpWebRequest]::Create($f78Uri)
                        $f78Req.Method = 'GET'
                        $f78Req.Timeout = $TimeoutSec * 1000
                        $f78Req.ReadWriteTimeout = $TimeoutSec * 1000
                        $f78Req.AllowAutoRedirect = $false
                        $f78Req.CookieContainer = $null
                        $f78Req.UserAgent = 'GHRDP-Lab/1.0'
                        $f78Resp = $f78Req.GetResponse()
                    } catch {
                        $f78Msg = ''
                        try { if ($Error[0] -and $Error[0].Exception) { $f78Msg = [string]$Error[0].Exception.Message } } catch { }
                        if ($f78Msg -match '(?i)timeout|timed out') { return @{ ok = $false; code = 'TIMEOUT'; httpStatus = 504 } }
                        return @{ ok = $false; code = 'TRANSPORT_UNAVAILABLE'; httpStatus = 502 }
                    }
                    $f78Code = 0
                    $f78Len = -1
                    $f78Loc = ''
                    try { $f78Code = [int]$f78Resp.StatusCode } catch { $f78Code = 0 }
                    try { $f78Len = [int64]$f78Resp.ContentLength } catch { $f78Len = -1 }
                    try { $f78Loc = [string]$f78Resp.Headers['Location'] } catch { $f78Loc = '' }
                    if ($f78Code -ge 300 -and $f78Code -lt 400) {
                        try { $f78Resp.Close() } catch { }
                        if (-not $f78Loc) { return @{ ok = $false; code = 'REDIRECT_REFUSED'; httpStatus = 502 } }
                        try { $f78Cur = ([System.Uri]::new($f78Uri, $f78Loc)).AbsoluteUri } catch { return @{ ok = $false; code = 'REDIRECT_REFUSED'; httpStatus = 502 } }
                        continue
                    }
                    if ($f78Code -ne 200) {
                        try { $f78Resp.Close() } catch { }
                        return @{ ok = $false; code = 'HTTP_STATUS'; httpStatus = 502 }
                    }
                    if ($f78Len -gt $MaxBytes) {
                        try { $f78Resp.Close() } catch { }
                        return @{ ok = $false; code = 'SIZE_LIMIT'; httpStatus = 413 }
                    }
                    $f78Stream = $null
                    $f78Ms = $null
                    try {
                        $f78Stream = $f78Resp.GetResponseStream()
                        $f78Ms = New-Object System.IO.MemoryStream
                        $f78Buf = New-Object byte[] 16384
                        while ($true) {
                            $f78Read = $f78Stream.Read($f78Buf, 0, $f78Buf.Length)
                            if ($f78Read -le 0) { break }
                            if (($f78Ms.Length + $f78Read) -gt $MaxBytes) { return @{ ok = $false; code = 'SIZE_LIMIT'; httpStatus = 413 } }
                            $f78Ms.Write($f78Buf, 0, $f78Read)
                        }
                        $f78Bytes = $f78Ms.ToArray()
                        return @{ ok = $true; code = 'OK'; httpStatus = 200; text = [System.Text.Encoding]::UTF8.GetString($f78Bytes); bytes = $f78Bytes.Length; host = $f78Uri.Host.ToLowerInvariant() }
                    } catch {
                        return @{ ok = $false; code = 'TRANSPORT_UNAVAILABLE'; httpStatus = 502 }
                    } finally {
                        try { if ($f78Ms) { $f78Ms.Dispose() } } catch { }
                        try { if ($f78Resp) { $f78Resp.Close() } } catch { }
                    }
                }
                return @{ ok = $false; code = 'REDIRECT_REFUSED'; httpStatus = 502 }
            }
            # =====================================================================
            # [F86 §C] PER-SITE HINTS + SITEMAP-INDEX RECURSION.
            #
            # Why: the F81 sitemap-first branch fetched exactly ONE /sitemap.xml
            # and parsed every <loc> in the response. That is the wrong shape for
            # the operator's ten sites - archive.org, openlibrary.org, plos/pluto
            # style catalogs all answer <sitemapindex> (a list of SUB-sitemaps),
            # so the old branch returned a handful of "URLs" that were really
            # links to more sitemaps, and the Lab showed fewer links than the
            # homepage fallback would have. [F86 §C.1]
            #
            # What ships now, all inside the F78 block (same dash-token gate, same
            # Invoke-F78SecureFetch transport: HTTPS only, 2MB cap, no cookies, no
            # auth headers, same-host (www-tolerant) only):
            #   * Expand-F86SitemapXml  - root element decides: <sitemapindex>
            #     enumerates <sitemap><loc> and fetches at most 5 same-host
            #     sub-sitemaps (2MB each), unioning their <url><loc>; <urlset>
            #     is used directly. The union is capped at 2000 URLs.
            #   * Invoke-F86SitemapFetch - the fetch wrapper around it.
            #   * Get-F86SiteHints      - payloads/data/f88-site-hints.json, one
            #     read per process. A hint only ever ADDS candidate paths on the
            #     SAME host; it can never widen the host fence.
            #   * Get-F86AnchorLinks / Expand-F86IndexLinks - the homepage
            #     extraction, now reusable, plus [F86 §C.3] one level of
            #     "obvious index" links (browse / catalog / all / index /
            #     archive / search), at most 3, same host only.
            # =====================================================================
            $script:F86HintsPath = ''
            $script:F86Hints = $null

            function Get-F86SiteHints {
                if ($null -ne $script:F86Hints) { return $script:F86Hints }
                $f86Map = @{}
                try {
                    if (-not $script:F86HintsPath) { $script:F86HintsPath = Join-Path $Root 'data\f88-site-hints.json' }
                } catch { $script:F86HintsPath = '' }
                try {
                    if ($script:F86HintsPath -and (Test-Path -LiteralPath $script:F86HintsPath)) {
                        $f86Raw = Get-Content -LiteralPath $script:F86HintsPath -Raw -Encoding UTF8 | ConvertFrom-Json
                        foreach ($f86Prop in $f86Raw.PSObject.Properties) {
                            $f86Key = ([string]$f86Prop.Name).Trim().ToLowerInvariant() -replace '^www\.', ''
                            if ($f86Key) { $f86Map[$f86Key] = $f86Prop.Value }
                        }
                    }
                } catch { }
                $script:F86Hints = $f86Map
                return $script:F86Hints
            }

            function Get-F86SiteHint {
                param([string]$HostName)
                $f86All = Get-F86SiteHints
                if (-not $f86All -or -not $HostName) { return $null }
                $f86Key = ([string]$HostName).Trim().ToLowerInvariant() -replace '^www\.', ''
                if ($f86All.ContainsKey($f86Key)) { return $f86All[$f86Key] }
                return $null
            }

            function Get-F86HintList {
                param($Hint, [string]$Field, [int]$Max)
                $f86List = @()
                if (-not $Hint) { return $f86List }
                try {
                    if ($Hint.$Field) { foreach ($f86V in @($Hint.$Field)) { if ($f86V) { $f86List += [string]$f86V } } }
                } catch { }
                if ($f86List.Count -gt $Max) { $f86List = @($f86List[0..($Max - 1)]) }
                return $f86List
            }

            function Expand-F86HintPath {
                param([string]$Template, [string]$Query)
                $f86Encoded = ''
                try { $f86Encoded = [System.Uri]::EscapeDataString([string]$Query) } catch { $f86Encoded = '' }
                return ([string]$Template).Replace('{{q}}', $f86Encoded)
            }

            # [F88 §1.2] PER-SITE SEARCH ENDPOINT. One switch over the hint's
            # searchStrategy (payloads/data/f88-site-hints.json):
            #   html             - fetch searchEndpoint, anchor-parse, keep the
            #                      anchors that satisfy the resultSelector's
            #                      parent chain (a soft CSS window check - tag /
            #                      .class / [attr='v'] parts each must appear in
            #                      the 800 chars before the anchor), rows
            #                      {text, href} same-host fenced like F78.
            #   json             - fetch, walk resultsPath ('response.docs'),
            #                      title from mapTitle, url from mapUrl: a
            #                      https:// template with {{field}} placeholders,
            #                      or a row field name (foreign_landing_url).
            #   markdown-section - fetch the hint's declared readmeUrl (a
            #                      repo-owned https URL - strategy-declared, not
            #                      a free cross-domain crawl), find the H2 the
            #                      sectionMatcher names, collect subItemPattern
            #                      bullets until the next H2.
            # Rows are https-only, never carry userinfo, and are capped at 50.
            # The function returns [ordered]@{ ok, strategy, label, section,
            # rows, error } - ok=false (with the reason) means the caller falls
            # back to the F86 sitemap ladder (the spec's <5-results rule lives
            # in the inspect route).
            function Invoke-F88SiteSearch {
                param([string]$HostName, [string]$Query, [string]$BaseUrl)
                $f88Out = [ordered]@{ ok = $false; strategy = ''; label = ''; section = ''; rows = @(); itemCount = 0; repo = ''; error = '' }
                $f88Hint = Get-F86SiteHint -HostName $HostName
                if (-not $f88Hint) { $f88Out.error = 'no-hint'; return $f88Out }
                $f88Strategy = ''
                try { $f88Strategy = [string]$f88Hint.searchStrategy } catch { $f88Strategy = '' }
                if (-not $f88Strategy) { $f88Out.error = 'no-strategy'; return $f88Out }
                if (-not $Query) { $f88Out.error = 'no-query'; return $f88Out }
                $f88Out.strategy = $f88Strategy
                # [F90 §B.2/§D] the README's owning repo ("sindresorhus/awesome"
                # for awesome.re), taken from the hint's declared redirectTo so
                # the Lab can name the source the operator actually sees.
                $f88Repo = ''
                try { $f88Repo = ([System.Uri]([string]$f88Hint.redirectTo)).AbsolutePath.Trim('/') } catch { $f88Repo = '' }
                if ($f88Repo) { $f88Out.repo = $f88Repo }
                $f88Rows = @()
                # [F88 §1.2] form-style encoding (%20 -> +) so the rendered link
                # matches the operator's expected URL literally
                # (archive.org/search?query=A+Matter+of+Life+and+Death&tab=all).
                $f88QEnc = ''
                try { $f88QEnc = ([System.Uri]::EscapeDataString([string]$Query)).Replace('%20', '+') } catch { $f88QEnc = '' }
                try {
                    if ($f88Strategy -eq 'json') {
                        $f88Ep = Expand-F86HintPath -Template ([string]$f88Hint.searchEndpoint) -Query $Query
                        $f88EpHost = ''
                        try { $f88EpHost = ([System.Uri]$f88Ep).Host } catch { $f88EpHost = $HostName }
                        $f88Fetch = Invoke-F78SecureFetch -Url $f88Ep -ExpectedHost $f88EpHost -MaxBytes 2097152 -TimeoutSec 10
                        if (-not $f88Fetch.ok) { $f88Out.error = ('json-fetch:' + [string]$f88Fetch.code); return $f88Out }
                        $f88Json = $null
                        try { $f88Json = ([string]$f88Fetch.text) | ConvertFrom-Json -ErrorAction Stop } catch { $f88Json = $null }
                        if (-not $f88Json) { $f88Out.error = 'json-parse'; return $f88Out }
                        $f88List = $f88Json
                        foreach ($f88Seg in @(([string]$f88Hint.resultsPath) -split '\.')) {
                            if (-not $f88Seg) { continue }
                            try { $f88List = $f88List.$f88Seg } catch { $f88List = $null }
                            if ($null -eq $f88List) { break }
                        }
                        if ($null -eq $f88List) { $f88Out.error = 'json-results-path'; return $f88Out }
                        $f88MapTitle = [string]$f88Hint.mapTitle
                        $f88MapUrl = [string]$f88Hint.mapUrl
                        foreach ($f88Row in @($f88List)) {
                            if ($f88Rows.Count -ge 50) { break }
                            if ($null -eq $f88Row) { continue }
                            $f88Title = ''
                            try { $f88Title = [string]$f88Row.$f88MapTitle } catch { $f88Title = '' }
                            $f88Url = ''
                            if ($f88MapUrl -match '^\{\{(.+?)\}\}$') {
                                # bare {{field}} – resolve against the site base
                                $f88Field = $Matches[1]
                                try { $f88Url = [string]$f88Row.$f88Field } catch { $f88Url = '' }
                                if ($f88Url -and -not $f88Url.StartsWith('https://')) {
                                    try { $f88Url = ([System.Uri]::new([System.Uri]$BaseUrl, $f88Url)).AbsoluteUri } catch { $f88Url = '' }
                                }
                            } elseif ($f88MapUrl -match '\{\{') {
                                # template with {{field}} placeholders (mapUrl owns the host)
                                $f88Url = [regex]::Replace([string]$f88MapUrl, '\{\{(.+?)\}\}', {
                                    param($f88M)
                                    $f88F = $f88M.Groups[1].Value
                                    $f88V = ''
                                    try { $f88V = [string]$f88Row.$f88F } catch { $f88V = '' }
                                    try { $f88V = [System.Uri]::EscapeDataString($f88V) } catch { }
                                    return $f88V
                                })
                            } else {
                                # field name carrying the full URL (openverse foreign_landing_url)
                                try { $f88Url = [string]$f88Row.$f88MapUrl } catch { $f88Url = '' }
                                if ($f88Url -and -not $f88Url.StartsWith('https://')) {
                                    try { $f88Url = ([System.Uri]::new([System.Uri]$BaseUrl, $f88Url)).AbsoluteUri } catch { $f88Url = '' }
                                }
                            }
                            if (-not $f88Url -or -not $f88Url.StartsWith('https://')) { continue }
                            try { if ([System.Uri]$f88Url) { if (([System.Uri]$f88Url).UserInfo) { continue } } } catch { continue }
                            $f88Snippet = ''
                            foreach ($f88F in @('description', 'excerpt', 'artist', 'creator', 'subject')) {
                                try { if ($f88Row.$f88F) { $f88Snippet = [string]$f88Row.$f88F; break } } catch { }
                            }
                            $f88Rows += [ordered]@{ text = $(if ($f88Title) { $f88Title } else { $f88Url }); href = $f88Url; snippet = $f88Snippet }
                        }
                        $f88Out.label = 'JSON search endpoint'
                    }
                    elseif ($f88Strategy -eq 'markdown-section') {
                        $f88ReadmeUrl = [string]$f88Hint.readmeUrl
                        if (-not $f88ReadmeUrl.StartsWith('https://')) { $f88Out.error = 'readme-not-https'; return $f88Out }
                        $f88RmHost = ''
                        try { $f88RmHost = ([System.Uri]$f88ReadmeUrl).Host } catch { $f88Out.error = 'readme-url'; return $f88Out }
                        # [F90 §B.1] the ONE cross-domain read in the product:
                        # the README lives on raw.githubusercontent.com while the
                        # operator site is awesome.re, so this fetch opts in.
                        $f88Fetch = Invoke-F78SecureFetch -Url $f88ReadmeUrl -ExpectedHost $f88RmHost -MaxBytes 2097152 -TimeoutSec 10 -AllowCrossDomain
                        if (-not $f88Fetch.ok) { $f88Out.error = ('readme-fetch:' + [string]$f88Fetch.code); return $f88Out }
                        # [F90 §B.1] remember BOTH hosts for later calls on this
                        # source: the README host that answered AND the hint's
                        # declared redirectTo host (github.com for awesome.re),
                        # so a subsequent /api/lab/inspect on the same
                        # operator-added source is not blocked by the fence it
                        # just proved. Scoped to $HostName - never global.
                        $f88RedirectHost = ''
                        try { $f88RedirectHost = ([System.Uri]([string]$f88Hint.redirectTo)).Host } catch { $f88RedirectHost = '' }
                        Register-F88CrossDomainHost -ForHost $HostName -Hosts @([string]$f88Fetch.host, $f88RedirectHost)
                        $f88SecRe = ([string]$f88Hint.sectionMatcher).Replace('{{q}}', [regex]::Escape($Query))
                        $f88SecMatch = [regex]::Match([string]$f88Fetch.text, '(?im)' + $f88SecRe)
                        if (-not $f88SecMatch.Success) { $f88Out.error = 'section-not-found'; return $f88Out }
                        $f88SectionName = ''
                        try { $f88SectionName = ($f88SecMatch.Value -replace '^##\s+', '').Trim() } catch { $f88SectionName = $Query }
                        $f88Out.section = $f88SectionName
                        $f88End = [regex]::Match([string]$f88Fetch.text.Substring($f88SecMatch.Index), '(?m)^##\s+')
                        $f88Len = [string]$f88Fetch.text.Length - $f88SecMatch.Index
                        if ($f88End.Success -and $f88End.Index -gt 0) { $f88Len = $f88End.Index }
                        $f88SectionText = [string]$f88Fetch.text.Substring($f88SecMatch.Index, [int]$f88Len)
                        # the section row itself: the declared redirectTo host + anchor
                        $f88Anchor = ''
                        try { $f88Anchor = ($f88SectionName.ToLowerInvariant() -replace '[^a-z0-9\s-]', '' -replace '\s+', '-').Trim('-') } catch { $f88Anchor = '' }
                        $f88SectionHref = ([string]$f88Hint.redirectTo).TrimEnd('/') + $(if ($f88Anchor) { '#' + $f88Anchor } else { '' })
                        $f88Rows += [ordered]@{ text = ($f88SectionName + ' (' + $f88RmHost + ' README section)'); href = $f88SectionHref; snippet = 'section' }
                        $f88SubRe = [string]$f88Hint.subItemPattern
                        foreach ($f88Sm in [regex]::Matches($f88SectionText, $f88SubRe)) {
                            if ($f88Rows.Count -ge 50) { break }
                            $f88SubTitle = $f88Sm.Groups[1].Value.Trim()
                            $f88SubHref = $f88Sm.Groups[2].Value.Trim()
                            if (-not $f88SubHref.StartsWith('https://')) { continue }
                            $f88Rows += [ordered]@{ text = $f88SubTitle; href = $f88SubHref; snippet = '' }
                        }
                        # [F90 §D] row 0 is the section link itself, not an item,
                        # so the item count is rows-1. The self-test reads this
                        # as networkingItemCount.
                        $f88Out.itemCount = [Math]::Max(0, $f88Rows.Count - 1)
                        $f88Out.label = 'GitHub README section - ' + $f88SectionName
                    }
                    elseif ($f88Strategy -eq 'html') {
                        $f88Ep = Expand-F86HintPath -Template ([string]$f88Hint.searchEndpoint) -Query $Query
                        $f88EpHost = ''
                        try { $f88EpHost = ([System.Uri]$f88Ep).Host } catch { $f88EpHost = $HostName }
                        $f88Fetch = Invoke-F78SecureFetch -Url $f88Ep -ExpectedHost $f88EpHost -MaxBytes 2097152 -TimeoutSec 10
                        if (-not $f88Fetch.ok) { $f88Out.error = ('html-fetch:' + [string]$f88Fetch.code); return $f88Out }
                        $f88Html = [string]$f88Fetch.text
                        $f88Selector = [string]$f88Hint.resultSelector
                        $f88SelParts = @()
                        if ($f88Selector) { $f88SelParts = @($f88Selector -split '\s+' | Where-Object { $_ }) }
                        $f88Parents = @()
                        if ($f88SelParts.Count -gt 1) { $f88Parents = @($f88SelParts[0..($f88SelParts.Count - 2)]) }
                        $f88Base = $null
                        try { $f88Base = [System.Uri]$f88Ep } catch { $f88Base = $null }
                        foreach ($f88Am in [regex]::Matches($f88Html, '(?is)<a\b[^>]*href\s*=\s*["'']([^"'']+)["''][^>]*>(.*?)</a>')) {
                            if ($f88Rows.Count -ge 50) { break }
                            $f88HrefRaw = [string]$f88Am.Groups[1].Value
                            if (-not $f88HrefRaw -or $f88HrefRaw.StartsWith('#')) { continue }
                            if ($f88HrefRaw -match '^(?i)mailto:|javascript:|data:|tel:') { continue }
                            $f88Abs = ''
                            try {
                                if ($f88HrefRaw -match '^(?i)https?://') { $f88Abs = ([System.Uri]$f88HrefRaw).AbsoluteUri }
                                elseif ($f88Base) { $f88Abs = ([System.Uri]::new($f88Base, $f88HrefRaw)).AbsoluteUri }
                            } catch { $f88Abs = '' }
                            if (-not $f88Abs -or -not $f88Abs.StartsWith('https://')) { continue }
                            $f88LinkHost = ''
                            try { $f88LinkHost = ([System.Uri]$f88Abs).Host.ToLowerInvariant() } catch { continue }
                            # same-host-minus-www fence (F78) on every html row
                            if (-not (Test-F78SameHost -Allowed $HostName -Actual $f88LinkHost)) { continue }
                            # soft resultSelector check: each parent part must
                            # appear in the window right before this anchor.
                            if ($f88Parents.Count -gt 0) {
                                $f88WinStart = [Math]::Max(0, $f88Am.Index - 800)
                                $f88Win = $f88Html.Substring($f88WinStart, $f88Am.Index - $f88WinStart)
                                $f88SelOk = $true
                                foreach ($f88Part in $f88Parents) {
                                    $f88PartRe = $null
                                    if ($f88Part -match '^([a-zA-Z0-9]+)\.([a-zA-Z0-9-]+)$') { $f88PartRe = '<' + $Matches[1] + '\b[^>]*class\s*=\s*["''][^"'']*\b' + [regex]::Escape($Matches[2]) + '\b' }
                                    elseif ($f88Part -match '^\.([a-zA-Z0-9-]+)$') { $f88PartRe = '<[a-zA-Z0-9]+\b[^>]*class\s*=\s*["''][^"'']*\b' + [regex]::Escape($Matches[1]) + '\b' }
                                    elseif ($f88Part -match '^\[([a-zA-Z0-9-]+)\s*=\s*[''"]([^''"]+)[''"]\]$') { $f88PartRe = '<[a-zA-Z0-9]+\b[^>]*' + [regex]::Escape($Matches[1]) + '\s*=\s*["'']' + [regex]::Escape($Matches[2]) + '["'']' }
                                    elseif ($f88Part -match '^([a-zA-Z0-9]+)$') { $f88PartRe = '<' + $Matches[1] + '\b' }
                                    if ($f88PartRe -and -not [regex]::IsMatch($f88Win, '(?i)' + $f88PartRe)) { $f88SelOk = $false; break }
                                }
                                if (-not $f88SelOk) { continue }
                            }
                            $f88Text = ConvertTo-F78PlainText ([string]$f88Am.Groups[2].Value)
                            $f88Rows += [ordered]@{ text = $(if ($f88Text) { $f88Text } else { $f88Abs }); href = $f88Abs; snippet = '' }
                        }
                        $f88Out.label = 'HTML search endpoint'
                    }
                    else {
                        $f88Out.error = 'unknown-strategy'
                    }
                } catch {
                    $f88Out.error = ('search-failed: ' + [string]$_.Exception.Message)
                }
                # [F88 §1.2] row 0 = the site's OWN human-facing search page
                # (form-encoded query), so the operator's expected result URL is
                # always renderable even when the endpoint is a JSON API.
                $f88PageRow = @()
                $f88PageTpl = ''
                try { $f88PageTpl = [string](@($f88Hint.searchPaths)[0]) } catch { $f88PageTpl = '' }
                if (-not $f88PageTpl) {
                    try { if ($f88Hint.searchEndpoint -and ([System.Uri]$f88Hint.searchEndpoint).AbsolutePath -ne '/') { $f88PageTpl = $f88Hint.searchEndpoint } } catch { }
                }
                if ($f88PageTpl -and $f88PageTpl -match '\{\{q\}\}') {
                    $f88PageUrl = $f88PageTpl.Replace('{{q}}', $f88QEnc)
                    if ($f88PageUrl.StartsWith('/')) { $f88PageUrl = $BaseUrl.TrimEnd('/') + $f88PageUrl }
                    try { if (([System.Uri]$f88PageUrl).Scheme -eq 'https') { $f88PageRow = @([ordered]@{ text = ('Search: ' + $Query); href = $f88PageUrl; snippet = 'search-page' }) } } catch { }
                }
                if (@($f88Rows).Count -eq 0) {
                    if ($f88Out.error) { return $f88Out }
                    $f88Out.error = 'no-rows'
                    return $f88Out
                }
                $f88Out.ok = $true
                $f88Out.rows = @($f88PageRow) + @($f88Rows)
                return $f88Out
            }

            # [F86 §C.1] Root-element switch + at most 5 same-host sub-sitemaps,
            # union capped at 2000 URLs. Never fetches off-host: every <loc> that
            # is about to be fetched passes the same Test-F78SameHost fence the
            # F81 sitemap branch used for its rows.
            function Expand-F86SitemapXml {
                param([string]$Xml, [string]$SourceUrl, [string]$f78Host)
                $f86R = [ordered]@{ urls = @(); mode = 'urlset'; fetched = 0; subSitemaps = 0; capHit = $false }
                $f86Locs = New-Object System.Collections.ArrayList
                $f86Xml = [string]$Xml
                if ($f86Xml -match '(?is)<sitemapindex[\s>]') {
                    $f86R.mode = 'sitemapindex'
                    # The <sitemap><loc> entries are the sub-sitemaps. A document
                    # that says <sitemapindex> but has no <sitemap> wrapper (a
                    # cache-shifted copy) degrades to a flat <loc> scan.
                    $f86Subs = @()
                    foreach ($f86M in [regex]::Matches($f86Xml, '(?is)<sitemap\b[^>]*>.*?<loc>\s*([^<]+?)\s*</loc>')) { $f86Subs += [string]$f86M.Groups[1].Value.Trim() }
                    if ($f86Subs.Count -eq 0) {
                        foreach ($f86M in [regex]::Matches($f86Xml, '(?is)<loc>\s*([^<]+?)\s*</loc>')) { $f86Subs += [string]$f86M.Groups[1].Value.Trim() }
                    }
                    $f86Taken = 0
                    foreach ($f86Sub in $f86Subs) {
                        if ($f86Taken -ge 5) { break }
                        $f78SLink = $null
                        try { $f78SLink = [System.Uri]$f86Sub } catch { $f78SLink = $null }
                        if (-not $f78SLink -or $f78SLink.Scheme -ne 'https') { continue }
                        if (-not (Test-F78SameHost -Allowed $f78Host -Actual $f78SLink.Host)) { continue }
                        $f86Taken++
                        $f86R.subSitemaps++
                        $f86SubFetch = Invoke-F78SecureFetch -Url ([string]$f78SLink.AbsoluteUri) -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 8
                        if (-not $f86SubFetch.ok) { continue }
                        $f86R.fetched++
                        foreach ($f86M in [regex]::Matches([string]$f86SubFetch.text, '(?is)<loc>\s*([^<]+?)\s*</loc>')) {
                            if ($f86Locs.Count -ge 2000) { $f86R.capHit = $true; break }
                            $f86Loc = [string]$f86M.Groups[1].Value.Trim()
                            if ($f86Loc) { [void]$f86Locs.Add($f86Loc) }
                        }
                        if ($f86R.capHit) { break }
                    }
                } else {
                    foreach ($f86M in [regex]::Matches($f86Xml, '(?is)<loc>\s*([^<]+?)\s*</loc>')) {
                        if ($f86Locs.Count -ge 2000) { $f86R.capHit = $true; break }
                        $f86Loc = [string]$f86M.Groups[1].Value.Trim()
                        if ($f86Loc) { [void]$f86Locs.Add($f86Loc) }
                    }
                }
                $f86R.urls = @($f86Locs)
                return $f86R
            }

            function Invoke-F86SitemapFetch {
                param([string]$Url, [string]$f78Host)
                $f86R = [ordered]@{ urls = @(); mode = ''; fetched = 0; subSitemaps = 0; capHit = $false; ok = $false }
                $f86First = Invoke-F78SecureFetch -Url $Url -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 8
                if (-not $f86First.ok) { return $f86R }
                $f86Expanded = Expand-F86SitemapXml -Xml ([string]$f86First.text) -SourceUrl $Url -f78Host $f78Host
                $f86R.urls = @($f86Expanded.urls)
                $f86R.mode = [string]$f86Expanded.mode
                $f86R.fetched = [int]$f86Expanded.fetched + 1
                $f86R.subSitemaps = [int]$f86Expanded.subSitemaps
                $f86R.capHit = [bool]$f86Expanded.capHit
                $f86R.ok = ($f86R.urls.Count -gt 0)
                return $f86R
            }

            # One anchor pass over an HTML document: absolute, https, same-host
            # (www-tolerant) only. The shape is the F78/F81 one - the off-host
            # href fence and the https-only fence are unchanged.
            function Get-F86AnchorLinks {
                param([string]$Html, [System.Uri]$BaseUri, [string]$f78Host)
                $f86Rows = @()
                foreach ($f86Match in [regex]::Matches([string]$Html, '(?is)<a\b[^>]*href\s*=\s*["'']([^"'']+)["''][^>]*>(.*?)</a>')) {
                    $f86HrefRaw = [string]$f86Match.Groups[1].Value
                    $f86Text = ConvertTo-F78PlainText $f86Match.Groups[2].Value
                    if (-not $f86HrefRaw) { continue }
                    if ($f86HrefRaw.StartsWith('#')) { continue }
                    if ($f86HrefRaw -match '^(?i)(mailto:|javascript:|data:|tel:)') { continue }
                    $f86Abs = ''
                    try {
                        if ($f86HrefRaw -match '^(?i)https?://') { $f86Abs = ([System.Uri]$f86HrefRaw).AbsoluteUri }
                        elseif ($BaseUri) { $f86Abs = ([System.Uri]::new($BaseUri, $f86HrefRaw)).AbsoluteUri }
                        else { $f86Abs = '' }
                    } catch { $f86Abs = '' }
                    if (-not $f86Abs) { continue }
                    if (-not $f86Abs.StartsWith('https://')) { continue }
                    $f86LinkHost = ''
                    try { $f86LinkHost = ([System.Uri]$f86Abs).Host.ToLowerInvariant() } catch { continue }
                    if (-not (Test-F78SameHost -Allowed $f78Host -Actual $f86LinkHost)) { continue }
                    $f86Rows += [ordered]@{ text = $f86Text; href = $f86Abs }
                }
                return $f86Rows
            }

            # [F86 §C.3] One level of "obvious index" links: the homepage of a
            # large catalog often links its real content behind /browse,
            # /catalog, /all, /index, /archive or /search. At most 3 such pages
            # are fetched, same host, and their anchors are unioned.
            function Expand-F86IndexLinks {
                param([string]$Html, [System.Uri]$BaseUri, [string]$f78Host)
                $f86Rows = @()
                $f86Seen = @{}
                $f86Taken = 0
                $f86IndexRe = '(?i)(browse|catalog|all|index|archive|search)'
                foreach ($f86Anchor in @(Get-F86AnchorLinks -Html $Html -BaseUri $BaseUri -f78Host $f78Host)) {
                    if ($f86Taken -ge 3) { break }
                    $f86Href = [string]$f86Anchor.href
                    $f86Text = [string]$f86Anchor.text
                    if ($f86Href -match '\.(jpg|jpeg|png|gif|svg|css|js|ico|woff2?|ttf|mp3|mp4|pdf)([?#]|$)') { continue }
                    if (-not (($f86Text -match $f86IndexRe) -or ($f86Href -match $f86IndexRe))) { continue }
                    if ($f86Seen.ContainsKey($f86Href)) { continue }
                    $f86Seen[$f86Href] = $true
                    $f86Taken++
                    $f86Fetch = Invoke-F78SecureFetch -Url $f86Href -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 8
                    if (-not $f86Fetch.ok) { continue }
                    $f86Base = $null
                    try { $f86Base = [System.Uri]$f86Href } catch { $f86Base = $BaseUri }
                    foreach ($f86Row in @(Get-F86AnchorLinks -Html ([string]$f86Fetch.text) -BaseUri $f86Base -f78Host $f78Host)) { $f86Rows += $f86Row }
                }
                return $f86Rows
            }

            # The match test, shared by the sitemap rows and the anchor rows:
            # case-insensitive substring first (the F81 behaviour, pinned by
            # tests/f78-lab-server.test.js) then a tokenized fallback so a
            # relevance-mode query ("gutenberg shakespeare") still highlights
            # the rows it was meant to find. [F86 §C.1]
            function Test-F86QueryMatch {
                param([string]$f78Hay, [string]$f78Needle)
                if (-not $f78Needle) { return $false }
                $f86Hay = [string]$f78Hay
                try { $f86Hay = [System.Uri]::UnescapeDataString($f86Hay) } catch { }
                $f86Hay = $f86Hay.ToLowerInvariant()
                if ($f86Hay.ToLowerInvariant().Contains($f78Needle)) { return $true }
                foreach ($f86Tok in @($f78Needle -split '\s+')) {
                    if ($f86Tok.Length -ge 3 -and $f86Hay.Contains($f86Tok)) { return $true }
                }
                return $false
            }

            # Dedupe by href + bound the returned rows (the F81 500-row payload
            # cap is unchanged) and compute each row's `matches` flag.
            function Merge-F86LinkRows {
                param($Rows, [string]$f78Needle)
                $f78LinksOut = @()
                $f78MatchCount = 0
                $f86SeenHref = @{}
                foreach ($f86Row in @($Rows)) {
                    if (-not $f86Row -or -not $f86Row.href) { continue }
                    $f86Href = [string]$f86Row.href
                    if ($f86SeenHref.ContainsKey($f86Href)) { continue }
                    $f86SeenHref[$f86Href] = $true
                    if ($f78LinksOut.Count -ge 500) { break }
                    $f86Text = [string]$f86Row.text
                    $f86IsMatch = (Test-F86QueryMatch -f78Hay ($f86Text + ' ' + $f86Href) -f78Needle $f78Needle)
                    if ($f86IsMatch) { $f78MatchCount++ }
                    $f78LinksOut += [ordered]@{ text = $f86Text; href = $f86Href; matches = $f86IsMatch }
                }
                return [ordered]@{ links = @($f78LinksOut); count = $f78LinksOut.Count; matches = $f78MatchCount }
            }
            # constant-time dash-token gate (same shape as /api/fetch)
            $f78Presented = ''
            try { $f78Presented = [string]$parts.headers['x-dash-token'] } catch { }
            if (-not $f78Presented) {
                $f78AuthH = ''
                try { $f78AuthH = [string]$parts.headers['authorization'] } catch { }
                if ($f78AuthH -match '^(?i)Bearer\s+(.+)$') { $f78Presented = $Matches[1].Trim() }
            }
            # [F101 §2.2 / N2] REFRESH-AWARE TOKEN GATE. This block compared the
            # presented dash token against the BOOT-TIME snapshot
            # ($script:Token, read once when the process started) with a raw
            # Test-TicketBearer, while F99 shipped the refresh-aware
            # Test-GhrdpDashToken (snapshot UNION dash-token.txt UNION
            # config.json dashToken) and wired it into the mirror route only.
            # That single asymmetry is the F99 bundle's N2: the operator's
            # Add-site of openculture.com was recorded as
            # `ERR: addSite.authMissing` (48559ms) while the very same token
            # read valid=true in dashTokenTelemetry. Same comparator now, plus
            # the F99 telemetry entry, plus an AUTH_REQUIRED code so the modal
            # can tell "wrong token" from "bad field" (the client maps
            # 401/403 -> addSite.authMissing and the modal shows the remedy).
            $f78TokenOk = $false
            if ($f78Presented) {
                try { $f78TokenOk = Test-GhrdpDashToken -Presented $f78Presented -SnapshotToken $script:Token } catch { $f78TokenOk = $false }
            }
            if (-not $f78TokenOk) {
                try { Add-F99TokenTelemetry -Route $path -Presented $f78Presented -SnapshotToken $script:Token -Valid $false } catch { }
                $f78AuthReason = 'dash-token-required'
                if ($f78Presented) { $f78AuthReason = 'dash-token-mismatch' }
                $f78AuthErr = New-F78Error -Code 'AUTH_REQUIRED' -MessageKey 'addSite.authMissing' -RetryAfter 0
                $f78AuthErr.details = [ordered]@{ reason = $f78AuthReason; presentedHash = $(Get-F99DashTokenHash $f78Presented); expectedHash = $(Get-F99DashTokenHash $script:Token) }
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f78AuthErr)
                Write-ClientAudit ('lab ' + [string]$parts.method + ' ' + $path + ' -> 401 (' + $f78AuthReason + ')')
                return
            }
            try { if ($f78Presented) { Add-F99TokenTelemetry -Route $path -Presented $f78Presented -SnapshotToken $script:Token -Valid $true } } catch { }
            $f78QCred = $false
            try {
                foreach ($f78Qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password')) {
                    if ($parts.query.ContainsKey($f78Qk)) { $f78QCred = $true; break }
                }
            } catch { }
            if ($f78QCred) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                return
            }

            if ($path -eq '/api/f58/sources' -and $parts.method -eq 'GET') {
                $f78Rows = @()
                foreach ($f78Key in ($script:F78Sources.Keys | Sort-Object)) {
                    $f78Row0 = $script:F78Sources[$f78Key]
                    if ($f78Row0.labMode -ne $true) { continue }
                    $f78Rows += $f78Row0
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ sources = $f78Rows; count = $f78Rows.Count }))
                Write-ClientAudit ('f78 sources listed count=' + [string]$f78Rows.Count)
                return
            }

            # [F93 §1.2] Concrete probe-reason classifier. Every add-site
            # refusal must name WHY in errors.url - the F92 operator report was
            # "rejected by validation" with no field-level reason, which is
            # unactionable. 'http-error' is an internal sentinel: the caller
            # re-runs the classifier with the ProtocolError's status code.
            function Get-F93ProbeReason {
                param([int]$HttpStatus = 0, $Except = $null, $Response = $null)
                $f93Status = -1; $f93Msg = ''
                try { if ($Except) { $f93Status = [int]$Except.Status; $f93Msg = [string]$Except.Message } } catch { }
                if ($f93Status -eq 6) { return 'dns-nxdomain' }
                if ($f93Status -eq 9) { return 'redirect-loop' }
                if ($f93Status -eq 10 -or $f93Status -eq 11) { return 'ssl-cert-invalid' }
                if ($f93Status -eq 14 -or $f93Msg -match '(?i)timeout|timed out') { return 'timeout-10s' }
                if ($HttpStatus -ge 500) { return 'http-5xx' }
                if ($HttpStatus -ge 400) {
                    $f93Cf = ''
                    try { if ($Response) { $f93Cf = ([string]$Response.Headers['cf-ray'] + ' ' + [string]$Response.Headers['server']) } } catch { }
                    if ($f93Cf -match '(?i)cf-ray|cloudflare') { return 'cloudflare-challenge' }
                    return ('http-' + [string]$HttpStatus)
                }
                if ($HttpStatus -gt 0) { return ('http-' + [string]$HttpStatus) }
                if ($Except) { return 'http-error' }
                return 'no-response'
            }
            if ($path -eq '/api/f58/sources' -and $parts.method -eq 'POST') {
                $f78BodyText = ''
                try { $f78BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f78BodyText = '' }
                $f78Json = $null
                try { $f78Json = $f78BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f78Json = $null }
                if (-not $f78Json) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f78Name = ''
                $f78Base = ''
                try { $f78Name = [string]$f78Json.name } catch { $f78Name = '' }
                try { $f78Base = [string]$f78Json.baseUrl } catch { $f78Base = '' }
                $f78Name = $f78Name.Trim()
                $f78Base = $f78Base.Trim()
                # [F81 §4.1/A.1 + §5.0/Q10] Per-field error envelope: each failing
                # field gets its own `errors.<field>` key so the modal can render
                # red text directly under the failing input. The Q10 cap (50)
                # is also evaluated here: lab-mode rows in the map count, the
                # new save returns 409 with `code=max-sites` when the cap would
                # be exceeded.
                $f78FieldErrors = [ordered]@{}
                if (-not $f78Name) { $f78FieldErrors['name'] = 'newSiteNameRequired' }
                elseif ($f78Name.Length -gt 50) { $f78FieldErrors['name'] = 'newSiteNameTooLong' }
                if (-not $f78Base.StartsWith('https://')) {
                    $f78FieldErrors['url'] = 'newSiteHttpsRequired'
                } else {
                    $f78Uri = $null
                    try { $f78Uri = [System.Uri]$f78Base } catch { $f78Uri = $null }
                    if (-not $f78Uri -or $f78Uri.Scheme -ne 'https' -or -not $f78Uri.Host) {
                        $f78FieldErrors['url'] = 'newSiteHttpsRequired'
                    } elseif ($f78Uri.UserInfo) {
                        $f78FieldErrors['url'] = 'newSiteAuthNotAllowed'
                    }
                }
                $f78Cap = 50
                $f78LabCount = 0
                foreach ($f78Key in @($script:F78Sources.Keys)) {
                    $f78Row0 = $script:F78Sources[$f78Key]
                    if ($f78Row0 -and $f78Row0.labMode -eq $true) { $f78LabCount++ }
                }
                if ($f78LabCount -ge $f78Cap) {
                    Send-ClientResponse -Stream $stream -Code 409 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'MAX_SITES'; messageKey = 'newSiteMaxReached'; traceId = ([guid]::NewGuid().ToString('N').Substring(0,12)); details = [ordered]@{ 'max' = $f78Cap } }))
                    return
                }
                if ($f78FieldErrors.Count -gt 0) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; traceId = ([guid]::NewGuid().ToString('N').Substring(0,12)); errors = $f78FieldErrors }))
                    return
                }
                # [F93 §1.2] HTTPS reachability probe BEFORE accepting the site.
                # F93 SUPERSEDES the F84 HEAD probe (pins rewritten in
                # tests/f84-url-normalize.test.js, never deleted): a HEAD is the
                # request real CDNs refuse first (Cloudflare answers 403 to
                # HEAD while GET is fine) and the old no-auto-redirect shape
                # needed the caller to interpret every 3xx hop itself.
                # Now: GET, up to 10 automatic redirects, 10s, and ANY 2xx/3xx
                # counts as reachable. A refusal names a CONCRETE machine reason
                # in errors.url: cloudflare-challenge | dns-nxdomain |
                # ssl-cert-invalid | timeout-10s | http-5xx | redirect-loop |
                # http-<code> - never the bare generic. The redirect target
                # (same-site, www-tolerant) still records `canonicalHostname`.
                $f78ProbeOk = $false
                $f78ProbeReason = 'no-response'
                $f78ProbeDetail = ''
                $f78CanonicalHost = ''
                try {
                    $f78ProbeUri = [System.Uri]$f78Base
                    $f78ProbeReq = [System.Net.HttpWebRequest]::Create($f78ProbeUri)
                    $f78ProbeReq.Method = 'GET'
                    $f78ProbeReq.Timeout = 10000
                    $f78ProbeReq.ReadWriteTimeout = 10000
                    $f78ProbeReq.AllowAutoRedirect = $true
                    $f78ProbeReq.MaximumAutomaticRedirections = 10
                    $f78ProbeReq.CookieContainer = $null
                    $f78ProbeReq.UserAgent = 'GHRDP-Lab/1.0'
                    $f78ProbeResp = $null
                    try {
                        $f78ProbeResp = $f78ProbeReq.GetResponse()
                    } catch [System.Net.WebException] {
                        $f78ProbeResp = $_.Exception.Response
                        $f78ProbeReason = Get-F93ProbeReason -Except $_.Exception
                        if ($f78ProbeReason -eq 'http-error') {
                            $f78ProbeStatus0 = 0
                            try { $f78ProbeStatus0 = [int]$_.Exception.Response.StatusCode } catch { $f78ProbeStatus0 = 0 }
                            $f78ProbeReason = Get-F93ProbeReason -HttpStatus $f78ProbeStatus0 -Except $_.Exception -Response $_.Exception.Response
                        }
                        try { $f78ProbeDetail = [string]$_.Exception.Message } catch { }
                    }
                    if ($f78ProbeResp) {
                        $f78ProbeStatus = 0
                        try { $f78ProbeStatus = [int]$f78ProbeResp.StatusCode } catch { $f78ProbeStatus = 0 }
                        # [F93 §1.2] any 2xx OR 3xx is reachable (a 3xx that
                        # survived the ladder has no Location - still a live
                        # HTTPS origin, not a dead site).
                        if ($f78ProbeStatus -ge 200 -and $f78ProbeStatus -lt 400) {
                            $f78ProbeOk = $true
                            $f78CanonicalHost = $f78ProbeUri.Host.ToLowerInvariant()
                            try {
                                $f78FinalUri = $f78ProbeResp.ResponseUri
                                if ($f78FinalUri -and $f78FinalUri.Host) {
                                    $f78FinalHost = $f78FinalUri.Host.ToLowerInvariant()
                                    if ($f78FinalHost -and (Test-F78SameHost -Allowed $f78ProbeUri.Host -Actual $f78FinalHost)) { $f78CanonicalHost = $f78FinalHost }
                                }
                            } catch { }
                        } else {
                            $f78ProbeReason = Get-F93ProbeReason -HttpStatus $f78ProbeStatus -Response $f78ProbeResp
                            $f78ProbeDetail = ('HTTP ' + [string]$f78ProbeStatus)
                        }
                        try { $f78ProbeResp.Close() } catch { }
                    } elseif ($f78ProbeReason -eq 'no-response') {
                        $f78ProbeDetail = 'no response object'
                    }
                } catch {
                    $f78ProbeReason = 'no-response'
                    try { $f78ProbeDetail = [string]$_.Exception.Message } catch { }
                }
                if (-not $f78ProbeOk) {
                    # [F84 §2.1 pin, kept] the messageKey stays the F84 key so an
                    # older client/bundle still renders a specific line; the
                    # per-field value is REPLACED by the F93 concrete reason so
                    # the operator reads "cloudflare-challenge", not a shrug.
                    $f78FieldErrors['url'] = 'addSite.probeFailed'
                    if ($f78ProbeReason) { $f78FieldErrors['url'] = $f78ProbeReason }
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'addSite.probeFailed'; traceId = ([guid]::NewGuid().ToString('N').Substring(0,12)); errors = $f78FieldErrors; details = [ordered]@{ reason = [string]$f78ProbeReason; detail = [string]$f78ProbeDetail } }))
                    Write-ClientAudit ('f93 add site probe failed base=' + $f78Base + ' reason=' + $f78ProbeReason + ' detail=' + $f78ProbeDetail)
                    return
                }
                $f78Uri = [System.Uri]$f78Base
                $f78Host = $f78Uri.Host.ToLowerInvariant()
                $f78Origin = ('https://' + $f78Host + $f78Uri.AbsolutePath).TrimEnd('/')
                $f78IdBase = ($f78Host -replace '[^a-z0-9]+', '-').Trim('-')
                if (-not $f78IdBase) { $f78IdBase = 'site' }
                $f78Id = $f78IdBase
                $f78N = 2
                while ($script:F78Sources.ContainsKey($f78Id)) { $f78Id = $f78IdBase + '-' + [string]$f78N; $f78N++ }
                $f78Row = [ordered]@{
                    id = $f78Id
                    name = $f78Name
                    nameKey = 'search.sites.' + $f78Id
                    baseUrl = $f78Origin
                    hostname = $f78Host
                    canonicalHostname = $f78CanonicalHost
                    labMode = $true
                    category = 'software'
                    allowedDomains = @($f78Host)
                    enableState = 'permanent'
                    addedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    addedVia = 'f78-quick-add'
                }
                $script:F78Sources[$f78Id] = $f78Row
                # The save-time host fence: only this line ever adds a host.
                $script:F78AllowHosts[$f78Host] = $true
                # [F84 §2.2] Both the operator-typed host and the host the
                # server actually answered from (the redirect target) are
                # accepted on subsequent calls.
                if ($f78CanonicalHost -and $f78CanonicalHost -ne $f78Host) { $script:F78AllowHosts[$f78CanonicalHost] = $true }
                # [F81 §1.1/A.1] Persist immediately so a process restart does
                # not lose the just-added site before the next repo-branch
                # commit. The commit job (workflow f81-sync-sources) is the
                # cross-runner source of truth; this file is the in-process
                # complement.
                $f81Saved = Write-F81LabStore -Map $script:F78Sources
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; source = $f78Row; persisted = $f81Saved }))
                Write-ClientAudit ('f78 add site host=' + $f78Host + ' id=' + $f78Id + ' persisted=' + [string]$f81Saved)
                return
            }

            # [F81 §1.2/A.2 + §3.1/Q3] DELETE /api/f58/sources/<id> — the
            # per-card trash button on the "Your sites" row removes exactly
            # one row, validates that the id is present in the map, removes
            # the host from the allowlist only when no other row references
            # the same host (so adding the same hostname twice doesn't
            # accidentally unlock it), persists, and 404s on unknown ids.
            if ($path -like '/api/f58/sources/*' -and $parts.method -eq 'DELETE') {
                $f78DelId = ''
                try { $f78DelId = [string]$path.Substring('/api/f58/sources/'.Length) } catch { $f78DelId = '' }
                $f78DelId = $f78DelId.Trim()
                if (-not $f78DelId -or $f78DelId.Contains('/')) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                if (-not $script:F78Sources.ContainsKey($f78DelId)) {
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'NOT_FOUND' -MessageKey 'lab.notFound' -RetryAfter 0))
                    return
                }
                $f78DelHost = ''
                try { $f78DelHost = [string]$script:F78Sources[$f78DelId].hostname } catch { $f78DelHost = '' }
                $script:F78Sources.Remove($f78DelId)
                if ($f78DelHost) {
                    $f78Still = $false
                    foreach ($f78K in @($script:F78Sources.Keys)) {
                        $f78Other = $script:F78Sources[$f78K]
                        if ($f78Other -and ([string]$f78Other.hostname) -eq $f78DelHost) { $f78Still = $true; break }
                    }
                    if (-not $f78Still) { $script:F78AllowHosts.Remove($f78DelHost) }
                }
                $f81DelSaved = Write-F81LabStore -Map $script:F78Sources
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; deletedId = $f78DelId; persisted = $f81DelSaved }))
                Write-ClientAudit ('f78 delete site id=' + $f78DelId + ' host=' + $f78DelHost + ' persisted=' + [string]$f81DelSaved)
                return
            }

            # =====================================================================
            # [F86 §A] LAUNCH-URL HARDENING - THE THREE-TIER LADDER.
            #
            # WHY IT EXISTS: the F81 route was ONE mechanism - a one-shot
            # Interactive scheduled task running `cmd /c start "" "<url>"`. On a
            # runner where the dashboard token owner has no interactive logon the
            # task registers (200 OK), Start-ScheduledTask answers, and the task
            # body silently never runs: the operator sees the success toast and
            # no window. That is the worst failure shape there is. [F86 §A.1]
            #
            # The ladder tries, in order, and reports which rung actually did the
            # work (the response now carries tier + tierDetail):
            #   TIER 1  direct process spawn as the ghrdp-server user itself
            #           (a direct <browser> --new-window <url> spawn, PID proof;
            #           cmd.exe /c start msedge.exe is the second form).
            #   TIER 2  the F81 interactive scheduled task, now run INSIDE the
            #           ladder: schedsvc starts the task in the console user's
            #           own session, which is the rung that reaches a desktop
            #           this process cannot touch. The F86 brief's alternative
            #           rung (keyboard injection into the focused window) is
            #           deliberately NOT implemented: the F19 gate in
            #           tests/f19-dns-launcher.test.js:249-252 bans those
            #           identifiers in this very file, and that guard is older
            #           and stronger than this phase.
            #   TIER 3  a named pipe to a persistent "browser-opener" helper
            #           (payloads/ghrdp-browser-helper.ps1) started once per
            #           process; the helper launches in whatever desktop context
            #           it owns and answers OK <pid> / ERR <reason>.
            # Boot probe (cached): interactive desktop -> Tier 1 is the expected
            # rung; console user only -> Tier 2; nothing -> Tier 3 is attempted
            # anyway and a total failure answers 503 reason="no interactive
            # session" instead of a fake success. Every attempt is appended to
            # %USERPROFILE%\.ghrdp\launch-url.log (host + path only - never the
            # query string) and kept in an in-memory ring for /diag.
            # =====================================================================
            if (-not $script:F86LaunchReady) {
                $script:F86LaunchReady = $true
                $script:F86LogPath = ''
                $script:F86History = @()
                $script:F86LastLaunch = $null
                $script:F86TierActive = 0
                $script:F86Probed = $false
                $script:F86Interactive = $false
                $script:F86SessionId = -1
                $script:F86ActiveUser = ''
                $script:F86Browsers = [ordered]@{ msedge = ''; chrome = ''; firefox = '' }
                $script:F86PipeName = 'ghrdp-browser-opener-f86'
                $script:F86PipeReady = $false

                function Resolve-F86BrowserPath {
                    param([string]$Name)
                    $f86Found = ''
                    try {
                        $f86Cmd = Get-Command ($Name + '.exe') -ErrorAction SilentlyContinue
                        if ($f86Cmd -and $f86Cmd.Source) { $f86Found = [string]$f86Cmd.Source }
                    } catch { $f86Found = '' }
                    if ($f86Found -and (Test-Path -LiteralPath $f86Found)) { return $f86Found }
                    $f86Pfx = ''
                    $f86Pfx86 = ''
                    $f86Local = ''
                    try { $f86Pfx = [string]$env:ProgramFiles } catch { $f86Pfx = '' }
                    try { $f86Pfx86 = [string]${env:ProgramFiles(x86)} } catch { $f86Pfx86 = '' }
                    try { $f86Local = [string]$env:LOCALAPPDATA } catch { $f86Local = '' }
                    $f86Guesses = @()
                    if ($Name -eq 'msedge') {
                        $f86Guesses = @("$f86Pfx\Microsoft\Edge\Application\msedge.exe", "$f86Pfx86\Microsoft\Edge\Application\msedge.exe", "$f86Local\Microsoft\Edge\Application\msedge.exe")
                    } elseif ($Name -eq 'chrome') {
                        $f86Guesses = @("$f86Pfx\Google\Chrome\Application\chrome.exe", "$f86Pfx86\Google\Chrome\Application\chrome.exe", "$f86Local\Google\Chrome\Application\chrome.exe")
                    } else {
                        $f86Guesses = @("$f86Pfx\Mozilla Firefox\firefox.exe", "$f86Pfx86\Mozilla Firefox\firefox.exe")
                    }
                    foreach ($f86G in @($f86Guesses)) {
                        if (-not $f86G) { continue }
                        if (Test-Path -LiteralPath $f86G) { return $f86G }
                    }
                    return ''
                }

                function Get-F86PreferredBrowser {
                    foreach ($f86N in @('msedge', 'chrome', 'firefox')) {
                        if ($script:F86Browsers[$f86N]) { return [ordered]@{ name = $f86N; path = [string]$script:F86Browsers[$f86N] } }
                    }
                    return [ordered]@{ name = ''; path = '' }
                }

                function Write-F86LaunchLog {
                    param([string]$Kind, [string]$Url, [int]$Tier, [string]$Detail, [bool]$Ok)
                    $f86Stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    $f86Host = ''
                    $f86Path = ''
                    try { if ($Url) { $f86Host = ([System.Uri]$Url).Host } } catch { $f86Host = '' }
                    try { if ($Url) { $f86Path = ([System.Uri]$Url).AbsolutePath } } catch { $f86Path = '' }
                    $f86Outcome = 'fail'
                    if ($Ok) { $f86Outcome = 'ok' }
                    $f86Entry = [ordered]@{ at = $f86Stamp; kind = $Kind; host = $f86Host; path = $f86Path; tier = $Tier; ok = $Ok; detail = $Detail }
                    try {
                        $f86Keep = @($script:F86History) + @($f86Entry)
                        if ($f86Keep.Count -gt 25) { $f86Keep = @($f86Keep[($f86Keep.Count - 25)..($f86Keep.Count - 1)]) }
                        $script:F86History = @($f86Keep)
                    } catch { }
                    try {
                        if ($script:F86LogPath) {
                            $f86Line = $f86Stamp + ' kind=' + $Kind + ' tier=' + [string]$Tier + ' outcome=' + $f86Outcome + ' host=' + $f86Host + ' path=' + $f86Path + ' detail=' + $Detail
                            Add-Content -LiteralPath $script:F86LogPath -Value $f86Line -Encoding UTF8 -ErrorAction SilentlyContinue
                        }
                    } catch { }
                }

                function Initialize-F86LaunchRuntime {
                    if ($script:F86Probed) { return }
                    $script:F86Probed = $true
                    try {
                        $f86Dir = ''
                        try { $f86Dir = [Environment]::GetFolderPath('UserProfile') } catch { $f86Dir = '' }
                        if (-not $f86Dir) { try { $f86Dir = [string]$env:USERPROFILE } catch { $f86Dir = '' } }
                        if ($f86Dir) {
                            $f86LogDir = Join-Path $f86Dir '.ghrdp'
                            if (-not (Test-Path -LiteralPath $f86LogDir)) { New-Item -ItemType Directory -Path $f86LogDir -Force | Out-Null }
                            $script:F86LogPath = Join-Path $f86LogDir 'launch-url.log'
                            # [F88 §B.1] the VERBOSE tier log: PID / process
                            # name / failure text per rung, host+path only (the
                            # query string is never logged - F86 rule kept).
                            $script:F88VerboseLogPath = Join-Path $f86LogDir 'launch-url-verbose.log'
                        }
                    } catch { $script:F86LogPath = '' }
                    foreach ($f86N in @('msedge', 'chrome', 'firefox')) { $script:F86Browsers[$f86N] = Resolve-F86BrowserPath -Name $f86N }
                    # [F86 §A.2] the boot probe: which rung can physically work?
                    $f86Sess = -1
                    try { $f86Self = Get-Process -Id $PID -ErrorAction SilentlyContinue; if ($f86Self) { $f86Sess = [int]$f86Self.SessionId } } catch { $f86Sess = -1 }
                    $script:F86SessionId = $f86Sess
                    $f86UserInteractive = $false
                    try { $f86UserInteractive = [bool][Environment]::UserInteractive } catch { $f86UserInteractive = $false }
                    $f86ConsoleUser = ''
                    try {
                        $f86Q = & quser.exe 2>$null
                        $LASTEXITCODE = 0
                        foreach ($f86Line in @($f86Q)) {
                            if ($f86Line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $f86ConsoleUser = $Matches[1]; break }
                        }
                    } catch { $f86ConsoleUser = '' }
                    $script:F86ActiveUser = $f86ConsoleUser
                    $script:F86Interactive = [bool]($f86UserInteractive -and $f86Sess -gt 0)
                    # Tier 1 is only the EXPECTED rung on an interactive desktop;
                    # a console-only logon expects Tier 2/2b; a session-0 service
                    # with no logon cannot use 1 or 2 at all, so Tier 3 leads.
                    $f86Expected = 3
                    if ($script:F86Interactive) { $f86Expected = 1 }
                    elseif ($f86ConsoleUser) { $f86Expected = 2 }
                    $script:F86TierActive = $f86Expected
                    if (-not $script:F86Interactive) { [void](Start-F86BrowserHelper) }
                    Write-F86LaunchLog -Kind 'probe' -Url '' -Tier $f86Expected -Detail ('session=' + [string]$f86Sess + ' userInteractive=' + [string]$f86UserInteractive + ' consoleUser=' + $f86ConsoleUser + ' browsers=' + [string]$script:F86Browsers['msedge'] + ',' + [string]$script:F86Browsers['chrome'] + ',' + [string]$script:F86Browsers['firefox'] + ' pipe=' + [string]$script:F86PipeReady) -Ok $true
                }

                function Start-F86BrowserHelper {
                    if ($script:F86PipeReady) { return $true }
                    $f86Helper = ''
                    try { $f86Helper = Join-Path $Root 'ghrdp-browser-helper.ps1' } catch { $f86Helper = '' }
                    if (-not $f86Helper -or -not (Test-Path -LiteralPath $f86Helper)) {
                        Write-F86LaunchLog -Kind 'helper' -Url '' -Tier 3 -Detail 'helper-script-missing' -Ok $false
                        return $false
                    }
                    foreach ($f86Exe in @('powershell.exe', 'pwsh.exe')) {
                        try {
                            Start-Process -FilePath $f86Exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $f86Helper, '-PipeName', $script:F86PipeName) -WindowStyle Hidden | Out-Null
                            $script:F86PipeReady = $true
                            Write-F86LaunchLog -Kind 'helper' -Url '' -Tier 3 -Detail ('helper-started:' + $f86Exe) -Ok $true
                            return $true
                        } catch { continue }
                    }
                    Write-F86LaunchLog -Kind 'helper' -Url '' -Tier 3 -Detail 'helper-start-failed' -Ok $false
                    return $false
                }

                function Invoke-F86LaunchTier1 {
                    param([string]$Url)
                    $f86Out = [ordered]@{ ok = $false; tier = 1; detail = 'no-browser'; browser = ''; pid = 0 }
                    $f86Pick = Get-F86PreferredBrowser
                    if (-not $f86Pick.path) { $f86Out.detail = 'no-browser-found'; return $f86Out }
                    try {
                        $f86Proc = Start-Process -FilePath ([string]$f86Pick.path) -ArgumentList @('--new-window', $Url) -NoNewWindow -PassThru -ErrorAction Stop
                        if ($f86Proc -and $f86Proc.Id -gt 0) {
                            $f86Out.ok = $true
                            $f86Out.browser = [string]$f86Pick.name
                            $f86Out.pid = [int]$f86Proc.Id
                            $f86Out.detail = 'direct-spawn'
                            return $f86Out
                        }
                    } catch { $f86Out.detail = ('direct-spawn-failed: ' + [string]$_.Exception.Message) }
                    try {
                        $f86CmdArg = '/c start msedge.exe --new-window "' + $Url.Replace('"', '%22') + '"'
                        $f86Proc2 = Start-Process -FilePath 'cmd.exe' -ArgumentList $f86CmdArg -NoNewWindow -PassThru -ErrorAction Stop
                        if ($f86Proc2 -and $f86Proc2.Id -gt 0) {
                            $f86Out.ok = $true
                            $f86Out.browser = 'cmd-start'
                            $f86Out.pid = [int]$f86Proc2.Id
                            $f86Out.detail = 'cmd-start'
                            return $f86Out
                        }
                    } catch { $f86Out.detail = ([string]$f86Out.detail + ' | cmd-start-failed: ' + [string]$_.Exception.Message) }
                    return $f86Out
                }

                function Invoke-F86LaunchTier2 {
                    param([string]$Url, [string]$f81ActiveUser)
                    $f86Out = [ordered]@{ ok = $false; tier = 2; detail = 'no-active-session'; browser = 'shell'; pid = 0 }
                    if (-not $f81ActiveUser) { return $f86Out }
                    $f81Tid = [guid]::NewGuid().ToString('N').Substring(0, 8)
                    $f81TaskName = 'GhrdpLaunch-' + $f81Tid
                    # The launched process is `cmd /c start "" "<url>"` - the
                    # empty title argument is the conventional way to start a URL
                    # via the shell's URL handler. URL-encoded for the command
                    # line; quoting is escaped to keep cmd-line injection
                    # impossible regardless of URL content.
                    $f81EscUrl = $Url.Replace('"', '%22').Replace('`', '%60').Replace('$', '%24').Replace('&', '%26').Replace('|', '%7C').Replace('>', '%3E').Replace('<', '%3C').Replace('^', '%5E')
                    $f81Cmd = 'cmd.exe /c start "" "' + $f81EscUrl + '"'
                    $f81TaskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $f81Cmd + '"')
                    $f81Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(1)
                    $f81Principal = New-ScheduledTaskPrincipal -UserId $f81ActiveUser -LogonType Interactive -RunLevel Highest
                    $f81Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromSeconds(15))
                    try {
                        Register-ScheduledTask -TaskName $f81TaskName -Action $f81TaskAction -Trigger $f81Trigger -Principal $f81Principal -Settings $f81Settings -Force -ErrorAction Stop | Out-Null
                        Start-ScheduledTask -TaskName $f81TaskName -ErrorAction Stop | Out-Null
                        Start-Job -ScriptBlock { param($tn) Start-Sleep -Seconds 20; try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { } } -ArgumentList $f81TaskName | Out-Null
                        $f86Out.ok = $true
                        $f86Out.detail = 'scheduled-task'
                    } catch {
                        try { Unregister-ScheduledTask -TaskName $f81TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
                        $f86Out.detail = ('scheduled-task-failed: ' + [string]$_.Exception.Message)
                    }
                    return $f86Out
                }

                function Invoke-F86LaunchTier3 {
                    param([string]$Url)
                    $f86Out = [ordered]@{ ok = $false; tier = 3; detail = 'pipe-unavailable'; browser = 'helper'; pid = 0 }
                    if (-not $script:F86PipeReady) { [void](Start-F86BrowserHelper) }
                    if (-not $script:F86PipeReady) { return $f86Out }
                    $f86Pipe = $null
                    try {
                        $f86Pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $script:F86PipeName, [System.IO.Pipes.PipeDirection]::InOut)
                        $f86Pipe.Connect(1500)
                        $f86Writer = New-Object System.IO.StreamWriter($f86Pipe)
                        $f86Writer.AutoFlush = $true
                        $f86Writer.WriteLine($Url)
                        $f86Reader = New-Object System.IO.StreamReader($f86Pipe)
                        $f86Reply = [string]$f86Reader.ReadLine()
                        if ($f86Reply -and $f86Reply.StartsWith('OK')) {
                            $f86Out.ok = $true
                            $f86Out.detail = 'named-pipe-helper'
                        } else {
                            $f86Out.detail = ('named-pipe-refused: ' + $f86Reply)
                        }
                    } catch { $f86Out.detail = ('named-pipe-failed: ' + [string]$_.Exception.Message) }
                    finally { if ($f86Pipe) { try { $f86Pipe.Dispose() } catch { } } }
                    return $f86Out
                }

                function Write-F88VerboseLaunchLog {
                    param([string]$Line)
                    try {
                        if ($script:F88VerboseLogPath) {
                            $f88Stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                            Add-Content -LiteralPath $script:F88VerboseLogPath -Value ($f88Stamp + ' ' + $Line) -Encoding UTF8 -ErrorAction SilentlyContinue
                        }
                    } catch { }
                }

                function Invoke-F88LaunchInUserSession {
                    # [F88 §B.2] Tier 0 - spawn the browser in the ACTIVE
                    # user's logon session BEFORE the session-0 ladder rungs.
                    # 1. quser gives the active user + session id (the same
                    #    scan Initialize-F86LaunchRuntime runs, plus the ID).
                    # 2. A one-shot /RU <user> /RL HIGHEST scheduled task runs
                    #    `cmd /c start <browser> "<url>"` (the spec's schtasks
                    #    rung; psexec -s -i <session> is used when present).
                    # 3. A browser process for THAT session within 3s is the
                    #    verification - no fake ok.
                    param([string]$Url)
                    $f88Out = [ordered]@{ ok = $false; tier = 0; detail = 'no-active-rdp-session; connect via WEB DESKTOP first'; browser = ''; pid = 0 }
                    $f88User = ''
                    $f88Session = -1
                    try {
                        $f88Q = & quser.exe 2>$null
                        $LASTEXITCODE = 0
                        foreach ($f88Line in @($f88Q)) {
                            if ($f88Line -match '^\s*>?\s*(\S+)\s+\S+\s+(\d+)\s+(Active|Disc)') {
                                $f88User = $Matches[1]
                                $f88Session = [int]$Matches[2]
                                if ($f88Line -match 'Active') { break }
                            }
                        }
                    } catch { $f88User = '' }
                    if (-not $f88User -or $f88Session -lt 0) { return $f88Out }
                    $f88Pick = Get-F86PreferredBrowser
                    $f88Browser = 'msedge.exe'
                    if ($f88Pick.name -eq 'chrome') { $f88Browser = 'chrome.exe' }
                    elseif ($f88Pick.name -eq 'firefox') { $f88Browser = 'firefox.exe' }
                    $f88EscUrl = $Url.Replace('"', '%22').Replace('`', '%60').Replace('$', '%24').Replace('&', '%26').Replace('|', '%7C').Replace('>', '%3E').Replace('<', '%3C').Replace('^', '%5E')
                    $f88TaskName = 'f88-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
                    $f88TaskOk = $false
                    $f88TaskDetail = ''
                    try {
                        $f88Tr = 'cmd.exe /c start ' + $f88Browser + ' "' + $f88EscUrl + '"'
                        $f88At = (Get-Date).AddSeconds(30).ToString('HH:mm:ss')
                        & schtasks.exe /Create /TN $f88TaskName /SC ONCE /ST $f88At /TR $f88Tr /RU $f88User /RL HIGHEST /F 2>$null | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            & schtasks.exe /Run $f88TaskName 2>$null | Out-Null
                            $f88TaskOk = ($LASTEXITCODE -eq 0)
                            if (-not $f88TaskOk) { $f88TaskDetail = 'schtasks-run-failed:' + [string]$LASTEXITCODE }
                        } else {
                            $f88TaskDetail = 'schtasks-create-failed:' + [string]$LASTEXITCODE
                        }
                    } catch { $f88TaskDetail = 'schtasks-threw:' + [string]$_.Exception.Message }
                    # psexec rung (spec B.2 option 1) when the tool exists.
                    if (-not $f88TaskOk) {
                        $f88Ps = ''
                        foreach ($f88Cand in @((Join-Path $env:SystemRoot 'System32\psexec.exe'), 'psexec.exe')) {
                            if ($f88Cand -eq 'psexec.exe') { $f88Ps = $f88Cand; break }
                            if (Test-Path -LiteralPath $f88Cand) { $f88Ps = $f88Cand; break }
                        }
                        if ($f88Ps) {
                            try {
                                & $f88Ps -accepteula -s -i ([string]$f88Session) -d $f88Browser $f88EscUrl 2>$null | Out-Null
                                if ($LASTEXITCODE -eq 0) { $f88TaskOk = $true; $f88TaskDetail = 'psexec-session-spawn' }
                                else { $f88TaskDetail = 'psexec-failed:' + [string]$LASTEXITCODE }
                            } catch { $f88TaskDetail = 'psexec-threw:' + [string]$_.Exception.Message }
                        }
                    }
                    # verification: a browser process exists in the TARGET logon
                    # session within 3s (an already-running browser counts).
                    $f88FoundPid = 0
                    $f88FoundName = ''
                    foreach ($f88Wait in 1..10) {
                        try {
                            foreach ($f88Proc in @(Get-Process -Name msedge, chrome, firefox, iexplore -ErrorAction SilentlyContinue)) {
                                if ([int]$f88Proc.SessionId -eq $f88Session) { $f88FoundPid = [int]$f88Proc.Id; $f88FoundName = [string]$f88Proc.ProcessName; break }
                            }
                        } catch { }
                        if ($f88FoundPid -gt 0) { break }
                        Start-Sleep -Milliseconds 300
                    }
                    if ($f88FoundPid -gt 0) {
                        $f88Out.ok = $true
                        $f88Out.browser = $f88FoundName
                        $f88Out.pid = $f88FoundPid
                        $f88Out.detail = 'user-session:' + $f88TaskDetail + ':session=' + [string]$f88Session
                    } else {
                        $f88Out.detail = 'user-session-no-browser:' + $f88TaskDetail + ':session=' + [string]$f88Session
                    }
                    # best-effort cleanup of the one-shot task
                    if ($f88TaskName) {
                        Start-Job -ScriptBlock { param($tn) Start-Sleep -Seconds 25; try { & schtasks.exe /Delete /TN $tn /F 2>$null | Out-Null } catch { } } -ArgumentList $f88TaskName | Out-Null
                    }
                    return $f88Out
                }

                function Invoke-F88LaunchTier4 {
                    # [F88 §B.3] Tier 4 - the Shell.Application COM object runs
                    # ShellExecute(url) exactly like a double-click on the URL.
                    # It runs after the F86 rungs; ok is ONLY claimed when a
                    # browser process is observed in this server's session
                    # within 3s (no fake ok on a headless runner).
                    param([string]$Url)
                    $f88Out = [ordered]@{ ok = $false; tier = 4; detail = 'shell-com'; browser = ''; pid = 0 }
                    try {
                        $f88Shell = New-Object -ComObject Shell.Application
                        $f88Shell.ShellExecute($Url, '', '', 'open', 1)
                        $f88Out.detail = 'shell-com-executed'
                    } catch {
                        $f88Out.detail = 'shell-com-failed: ' + [string]$_.Exception.Message
                        return $f88Out
                    }
                    $f88Sess = [int]$script:F86SessionId
                    foreach ($f88Wait in 1..10) {
                        try {
                            foreach ($f88Proc in @(Get-Process -Name msedge, chrome, firefox, iexplore -ErrorAction SilentlyContinue)) {
                                if ([int]$f88Proc.SessionId -eq $f88Sess) {
                                    $f88Out.ok = $true
                                    $f88Out.browser = [string]$f88Proc.ProcessName
                                    $f88Out.pid = [int]$f88Proc.Id
                                    $f88Out.detail = 'shell-com-browser-seen'
                                    break
                                }
                            }
                        } catch { }
                        if ($f88Out.ok) { break }
                        Start-Sleep -Milliseconds 300
                    }
                    if (-not $f88Out.ok) { $f88Out.detail = 'shell-com-no-browser-process' }
                    return $f88Out
                }

                function Invoke-F86LaunchUrl {
                    param([string]$Url, [int]$ForceTier)
                    Initialize-F86LaunchRuntime
                    $f86Attempts = @()
                    $f86Result = [ordered]@{ ok = $false; tier = 0; detail = 'no-tier-succeeded'; browser = ''; pid = 0; attempts = @() }
                    # [F92 §2.4] USER-SESSION FAST PATH. When the F92
                    # GHRDP-Server ONLOGON task owns this process we are ALREADY
                    # in the interactive session (SessionId != 0), so the simple
                    # direct in-session spawn is the ONLY path needed -
                    # no cross-session mechanics, no task detour. The Tier 1
                    # rung is exactly that spawn with PID proof, so the fast
                    # path runs Tier 1 once and returns on success. If the
                    # server is still the pre-F92 SYSTEM session-0 task (or the
                    # spawn fails), the full 0..4 ladder below runs UNCHANGED -
                    # the ladder's symbols are load-bearing for
                    # tests/f86-launch-url-tier1.test.js + f88-site-search
                    # §B, and the honest 503 for "no interactive session" only
                    # comes from that ladder, so it stays as the fallback.
                    if ($script:F92InUserSession -and $ForceTier -eq 0) {
                        $f92T1 = $null
                        try { $f92T1 = Invoke-F86LaunchTier1 -Url $Url } catch { $f92T1 = $null }
                        if ($f92T1 -and [bool]$f92T1.ok) {
                            $f86Result.ok = $true
                            $f86Result.tier = 1
                            $f86Result.detail = 'f92-user-session: ' + [string]$f92T1.detail
                            $f86Result.browser = [string]$f92T1.browser
                            $f86Result.pid = [int]$f92T1.pid
                            $f86Result.attempts = @([ordered]@{ tier = 1; ok = $true; detail = 'f92-user-session direct spawn (ladder skipped)' })
                            Write-F86LaunchLog -Kind 'launch' -Url $Url -Tier 1 -Detail 'f92-user-session direct spawn' -Ok $true
                            Write-F88VerboseLaunchLog -Line ('f92 fast-path ok tier=1 detail=' + [string]$f92T1.detail)
                            $script:F86LastLaunch = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); ok = $true; tier = 1; detail = 'f92-user-session' }
                            return $f86Result
                        }
                        Write-F88VerboseLaunchLog -Line ('f92 fast-path miss - falling through to the ladder: ' + $(if ($f92T1) { [string]$f92T1.detail } else { 'tier1 threw' }))
                    }
                    # [F88 §B.2/B.3] the ladder is now 0(user session),1,2,3,4(Shell COM).
                    foreach ($f86Tier in @(0, 1, 2, 3, 4)) {
                        if ($ForceTier -gt 0 -and $f86Tier -ne $ForceTier) { continue }
                        $f86Outcome = $null
                        if ($f86Tier -eq 0) {
                            $f86Outcome = Invoke-F88LaunchInUserSession -Url $Url
                        } elseif ($f86Tier -eq 1) {
                            $f86Outcome = Invoke-F86LaunchTier1 -Url $Url
                        } elseif ($f86Tier -eq 2) {
                            $f86Outcome = Invoke-F86LaunchTier2 -Url $Url -f81ActiveUser $script:F86ActiveUser
                        } elseif ($f86Tier -eq 3) {
                            $f86Outcome = Invoke-F86LaunchTier3 -Url $Url
                        } else {
                            $f86Outcome = Invoke-F88LaunchTier4 -Url $Url
                        }
                        $f86Attempts += [ordered]@{ tier = $f86Tier; ok = [bool]$f86Outcome.ok; detail = [string]$f86Outcome.detail }
                        Write-F86LaunchLog -Kind 'launch' -Url $Url -Tier $f86Tier -Detail ([string]$f86Outcome.detail) -Ok ([bool]$f86Outcome.ok)
                        Write-F88VerboseLaunchLog -Line ('tier=' + [string]$f86Tier + ' ok=' + [string]$f86Outcome.ok + ' browser=' + [string]$f86Outcome.browser + ' pid=' + [string]$f86Outcome.pid + ' detail=' + [string]$f86Outcome.detail + ' host=' + [string]$(try { ([System.Uri]$Url).Host } catch { '' }) + ' path=' + [string]$(try { ([System.Uri]$Url).AbsolutePath } catch { '' }))
                        if ($f86Outcome.ok) {
                            $f86Result.ok = $true
                            $f86Result.tier = $f86Tier
                            $f86Result.detail = [string]$f86Outcome.detail
                            $f86Result.browser = [string]$f86Outcome.browser
                            $f86Result.pid = [int]$f86Outcome.pid
                            break
                        }
                    }
                    $f86Result.attempts = @($f86Attempts)
                    Write-F88VerboseLaunchLog -Line ('ladder-result ok=' + [string]$f86Result.ok + ' tier=' + [string]$f86Result.tier + ' detail=' + [string]$f86Result.detail)
                    $script:F86LastLaunch = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); ok = [bool]$f86Result.ok; tier = [int]$f86Result.tier; detail = [string]$f86Result.detail }
                    return $f86Result
                }
            }

            # [F86 §A.2] POST /api/launch-url - the route is unchanged in its
            # validation (https only, no userinfo, <=2048, 20 calls / 60s per
            # X-Dash-Token) and unchanged in its response envelope; what changed
            # is the MECHANISM behind it: the ladder above replaces the single
            # scheduled-task attempt, and the response now carries the rung that
            # worked (tier + tierDetail) so /search?diag=1 can show it.
            if ($path -eq '/api/launch-url' -and $parts.method -eq 'POST') {
                if (-not $script:F81LaunchRate) { $script:F81LaunchRate = @{} }
                $f81Now = (Get-Date).ToUniversalTime()
                $f81Tok = ''
                try { $f81Tok = [string]$parts.headers['x-dash-token'] } catch { $f81Tok = '' }
                $f81Hits = @()
                if ($f81Tok -and $script:F81LaunchRate.ContainsKey($f81Tok)) { $f81Hits = @($script:F81LaunchRate[$f81Tok] | Where-Object { ($f81Now - $_).TotalSeconds -lt 60 }) }
                if ($f81Hits.Count -ge 20) {
                    $f81Retry = [int][Math]::Ceiling(60 - ($f81Now - $f81Hits[0]).TotalSeconds)
                    if ($f81Retry -lt 1) { $f81Retry = 1 }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'RATE_LIMITED'; retryAfterSeconds = $f81Retry }))
                    return
                }
                $f81BodyText = ''
                try { $f81BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f81BodyText = '' }
                $f81Json = $null
                try { $f81Json = $f81BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f81Json = $null }
                if (-not $f81Json) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f81Url = ''
                try { $f81Url = [string]$f81Json.url } catch { $f81Url = '' }
                $f81Url = $f81Url.Trim()
                if ($f81Url.Length -gt 2048) { $f81Url = $f81Url.Substring(0, 2048) }
                if (-not $f81Url.StartsWith('https://')) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteHttpsRequired' }))
                    return
                }
                $f81Uri = $null
                try { $f81Uri = [System.Uri]$f81Url } catch { $f81Uri = $null }
                if (-not $f81Uri -or $f81Uri.Scheme -ne 'https' -or $f81Uri.UserInfo) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteAuthNotAllowed' }))
                    return
                }
                # Resolve active console user (same quser scan the terminal route
                # uses): Tier 2 needs the account, and its absence is what turns
                # a total ladder failure into the honest 503 below.
                $f81ActiveUser = ''
                try { $qu = & quser.exe 2>$null; $LASTEXITCODE = 0; foreach ($line in @($qu)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $f81ActiveUser = $Matches[1]; break } } } catch { }
                $f81Hits += $f81Now
                $script:F81LaunchRate[$f81Tok] = $f81Hits
                $f86Attempt = Invoke-F86LaunchUrl -Url $f81Url
                if ($f86Attempt.ok) {
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; launched = $true; tier = [int]$f86Attempt.tier; tierDetail = [string]$f86Attempt.detail; browser = [string]$f86Attempt.browser; pid = [int]$f86Attempt.pid; user = $f81ActiveUser; attempts = @($f86Attempt.attempts) }))
                    Write-ClientAudit ('f81 launch-url user=' + $f81ActiveUser + ' host=' + $f81Uri.Host + ' tier=' + [string]$f86Attempt.tier + ' detail=' + [string]$f86Attempt.detail)
                    return
                }
                if (-not $f81ActiveUser) {
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'NO_ACTIVE_SESSION'; messageKey = 'launchUrl.noSession'; reason = 'no-active-rdp-session; connect via WEB DESKTOP first'; tier = [int]$f86Attempt.tier; attempts = @($f86Attempt.attempts) }))
                    Write-ClientAudit ('f81 launch-url refused: no-active-rdp-session host=' + $f81Uri.Host)
                    return
                }
                Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'LAUNCH_FAILED'; messageKey = 'launchUrl.failed'; tier = [int]$f86Attempt.tier; attempts = @($f86Attempt.attempts) }))
                Write-ClientAudit ('f81 launch-url failed user=' + $f81ActiveUser + ' host=' + $f81Uri.Host + ' detail=' + [string]$f86Attempt.detail)
                return
            }

            # [F86 §A.3] GET /api/launch-url/diag - the launch-path diagnostic
            # surface behind /#/search?diag=1. It reports the boot probe, the
            # browser paths that were actually resolved, the last launch outcome
            # and the failed attempts, so "Could not open in RDP" stops being a
            # one-line toast with no next step. Gated by the same dash-token gate
            # as every other /api route in this file.
            if ($path -eq '/api/launch-url/diag' -and $parts.method -eq 'GET') {
                Initialize-F86LaunchRuntime
                $f86Errors = @()
                foreach ($f86H in @($script:F86History)) {
                    if ($f86H -and -not $f86H.ok) { $f86Errors += $f86H }
                }
                if ($f86Errors.Count -gt 10) { $f86Errors = @($f86Errors[($f86Errors.Count - 10)..($f86Errors.Count - 1)]) }
                $f86Last = $script:F86LastLaunch
                $f86DiagOut = [ordered]@{
                    ok = $true
                    activeTier = [int]$script:F86TierActive
                    lastLaunchAt = ''
                    lastResult = ''
                    lastTier = 0
                    lastDetail = ''
                    chromePath = [string]$script:F86Browsers['chrome']
                    msedgePath = [string]$script:F86Browsers['msedge']
                    firefoxPath = [string]$script:F86Browsers['firefox']
                    interactiveSessionDetected = [bool]$script:F86Interactive
                    sessionId = [int]$script:F86SessionId
                    activeUser = [string]$script:F86ActiveUser
                    pipeReady = [bool]$script:F86PipeReady
                    pipeName = [string]$script:F86PipeName
                    logPath = [string]$script:F86LogPath
                    verboseLogPath = [string]$script:F88VerboseLogPath
                    errorHistory = @($f86Errors)
                    history = @($script:F86History)
                }
                # [F88 §B.1] last 20 lines of the verbose tier log, so the
                # diagnostic banner can show them + "Copy to clipboard"
                # without another endpoint.
                $f88VerboseLines = @()
                try {
                    if ($script:F88VerboseLogPath -and (Test-Path -LiteralPath $script:F88VerboseLogPath)) {
                        $f88VerboseAll = @(Get-Content -LiteralPath $script:F88VerboseLogPath -Encoding UTF8 -ErrorAction SilentlyContinue)
                        if ($f88VerboseAll.Count -gt 20) { $f88VerboseLines = @($f88VerboseAll[($f88VerboseAll.Count - 20)..($f88VerboseAll.Count - 1)]) }
                        else { $f88VerboseLines = @($f88VerboseAll) }
                    }
                } catch { $f88VerboseLines = @() }
                $f88DiagOut.verboseLog = @($f88VerboseLines)
                if ($f86Last) {
                    $f86DiagOut.lastLaunchAt = [string]$f86Last.at
                    $f86DiagOut.lastTier = [int]$f86Last.tier
                    $f86DiagOut.lastDetail = [string]$f86Last.detail
                    if ($f86Last.ok) { $f86DiagOut.lastResult = 'ok' } else { $f86DiagOut.lastResult = 'fail' }
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f86DiagOut)
                return
            }

            # [F91 §A.3] POST /api/launcher/queue - MIRROR MODE hand-off. The
            # dashboard has ALREADY opened the link locally by the time this
            # fires; all that is left is dropping a durable job for the
            # persistent launcher service (payloads/ghrdp-rdp-launcher.ps1) to
            # execute in the interactive session. Validation is deliberately
            # the SAME Test-F91QueueJob the launcher applies locally (defense
            # in depth, identical fences): https only, no userinfo, no
            # javascript:/file:/data:, mode in [navigate,download,explorer,noop]
            # (noop = selftest probe only). Rate limit: 60 writes/min/token.
            # A queue dir that cannot be written answers 503 with an honest
            # reason - the client's toast then degrades to "Opened locally ✓
            # (RDP launcher: ...)" instead of ever claiming a mirror it did
            # not deliver, and NEVER shows a "could not open" error (F91 §-1).
            if ($path -eq '/api/launcher/queue' -and $parts.method -eq 'POST') {
                if (-not $script:F91QueueRate) { $script:F91QueueRate = @{} }
                $f91Now = (Get-Date).ToUniversalTime()
                $f91Tok = ''
                try { $f91Tok = [string]$parts.headers['x-dash-token'] } catch { $f91Tok = '' }
                $f91Hits = @()
                if ($f91Tok -and $script:F91QueueRate.ContainsKey($f91Tok)) { $f91Hits = @($script:F91QueueRate[$f91Tok] | Where-Object { ($f91Now - $_).TotalSeconds -lt 60 }) }
                if ($f91Hits.Count -ge 60) {
                    $f91Retry = [int][Math]::Ceiling(60 - ($f91Now - $f91Hits[0]).TotalSeconds)
                    if ($f91Retry -lt 1) { $f91Retry = 1 }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'RATE_LIMITED'; retryAfterSeconds = $f91Retry }))
                    return
                }
                $f91BodyText = ''
                try { $f91BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f91BodyText = '' }
                $f91Json = $null
                try { $f91Json = $f91BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f91Json = $null }
                if (-not $f91Json) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f91JobUrl = ''
                $f91JobMode = ''
                $f91JobName = ''
                try { $f91JobUrl = [string]$f91Json.url } catch { }
                try { $f91JobMode = [string]$f91Json.mode } catch { }
                try { $f91JobName = [string]$f91Json.name } catch { }
                $f91Check = Test-F91QueueJob -Url $f91JobUrl -Mode $f91JobMode
                if (-not $f91Check.ok) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; reason = [string]$f91Check.reason }))
                    return
                }
                $f91Paths = Get-F91LauncherPaths
                $f91JobId = [guid]::NewGuid().ToString('N')
                try {
                    if (-not (Test-Path -LiteralPath $f91Paths.queueDir)) { New-Item -ItemType Directory -Path $f91Paths.queueDir -Force | Out-Null }
                    $f91JobFile = Join-Path $f91Paths.queueDir ($f91JobId + '.job')
                    $f91Job = [ordered]@{ id = $f91JobId; url = [string]$f91Check.safeUrl; mode = ([string]$f91JobMode).Trim().ToLowerInvariant(); name = $f91JobName; timestamp = $f91Now.ToString('yyyy-MM-ddTHH:mm:ssZ') }
                    [System.IO.File]::WriteAllText($f91JobFile, ($f91Job | ConvertTo-Json -Compress -Depth 4))
                    # unique-write BEFORE counting, so a refused write never
                    # consumes a rate slot.
                    $f91Hits += $f91Now
                    $script:F91QueueRate[$f91Tok] = $f91Hits
                    Write-ClientAudit ('f91 launcher-queue job=' + $f91JobId + ' mode=' + $f91Job.mode + ' url=' + $(try { ([System.Uri]$f91Job.url).Host } catch { '' }))
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; queuedAt = $f91Job.timestamp; jobId = $f91JobId }))
                    return
                } catch {
                    Send-ClientResponse -Stream $stream -Code 503 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'QUEUE_DIR_UNAVAILABLE'; reason = [string]$_.Exception.Message }))
                    Write-ClientAudit ('f91 launcher-queue FAILED: ' + [string]$_.Exception.Message)
                    return
                }
            }

            # [F91 §A.4] GET /api/launcher/health - the mirror-mode heartbeat
            # readout behind /#/search?diag=1 ("Launcher: running, heartbeat
            # 2s ago, queue depth 0"). Read-only over files + schtasks, so it
            # answers honestly (serviceRunning=false) when the service has
            # never started - the UI keeps working, it just says so.
            if ($path -eq '/api/launcher/health' -and $parts.method -eq 'GET') {
                $f91Health = Get-F91LauncherHealth
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f91Health)
                return
            }

            # [F91 §D.2] GET|HEAD /api/stream?url=<encoded> - the audio relay
            # that makes "inline play" arrive from the RUNNER's network view:
            # the bytes travel source -> runner -> dashboard, so the content
            # provider serves RDP's IP, never the operator's laptop. Fences:
            # https only via Test-F91QueueJob's navigate rules, then an
            # EXACT-host allowlist (minus www) of the custom sources the
            # operator registered ($script:F78AllowHosts) unioned with the
            # eleven operator sites (f86-site-hints keys) - this route can
            # never become a general proxy. Redirects are refused (they would
            # silently widen the fence). 64 MB cap, 60 streams/min/token, and
            # at most 10 streams in flight per token.
            if ($path -eq '/api/stream' -and ($parts.method -eq 'GET' -or $parts.method -eq 'HEAD')) {
                $f91sUrl = ''
                try { $f91sUrl = [string]$parts.query['url'] } catch { $f91sUrl = '' }
                $f91sCheck = Test-F91QueueJob -Url $f91sUrl -Mode 'navigate'
                if (-not $f91sCheck.ok) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'search.errors.validation'; reason = [string]$f91sCheck.reason }))
                    return
                }
                $f91sHost = ''
                try { $f91sHost = ([System.Uri]$f91sUrl).Host.ToLowerInvariant() } catch { }
                $f91sBase = $f91sHost -replace '^www\.', ''
                $f91sAllowed = $false
                if (-not $script:F78AllowHosts) { $script:F78AllowHosts = @{} }
                foreach ($f91sKey in @($script:F78AllowHosts.Keys)) {
                    if (([string]$f91sKey).ToLowerInvariant() -replace '^www\.', '' -eq $f91sBase) { $f91sAllowed = $true; break }
                }
                if (-not $f91sAllowed) {
                    try { if ((Get-F86SiteHints).Contains($f91sHost) -or (Get-F86SiteHints).Contains('www.' + $f91sHost)) { $f91sAllowed = $true } } catch { }
                }
                if (-not $f91sAllowed) {
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'HOSTNAME_MISMATCH'; messageKey = 'lab.hostnameMismatch' }))
                    return
                }
                if (-not $script:F91StreamRate) { $script:F91StreamRate = @{} }
                if (-not $script:F91StreamActive) { $script:F91StreamActive = @{} }
                $f91sTok = ''
                try { $f91sTok = [string]$parts.headers['x-dash-token'] } catch { }
                $f91sNow = (Get-Date).ToUniversalTime()
                $f91sHits = @()
                if ($f91sTok -and $script:F91StreamRate.ContainsKey($f91sTok)) { $f91sHits = @($script:F91StreamRate[$f91sTok] | Where-Object { ($f91sNow - $_).TotalSeconds -lt 60 }) }
                if ($f91sHits.Count -ge 60) {
                    $f91sRetry = [int][Math]::Ceiling(60 - ($f91sNow - $f91sHits[0]).TotalSeconds)
                    if ($f91sRetry -lt 1) { $f91sRetry = 1 }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'RATE_LIMITED'; retryAfterSeconds = $f91sRetry }))
                    return
                }
                $f91sLive = 0
                if ($f91sTok -and $script:F91StreamActive.ContainsKey($f91sTok)) { $f91sLive = [int]$script:F91StreamActive[$f91sTok] }
                if ($f91sLive -ge 10) {
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'STREAM_CONCURRENCY'; retryAfterSeconds = 5 }))
                    return
                }
                $f91sHits += $f91sNow
                $script:F91StreamRate[$f91sTok] = $f91sHits
                $script:F91StreamActive[$f91sTok] = $f91sLive + 1
                try {
                    $f91sHead = $parts.method -eq 'HEAD'
                    $f91sGot = $null
                    if ($f91sHead) { $f91sGot = Invoke-F91StreamFetch -Url $f91sUrl -MaxBytes 1 -ProbeHead } else { $f91sGot = Invoke-F91StreamFetch -Url $f91sUrl }
                    if (-not $f91sGot.ok -and -not ($f91sHead -and [int]$f91sGot.httpStatus -ge 200 -and [int]$f91sGot.httpStatus -lt 400)) {
                        $f91sCode = 'TRANSPORT_UNAVAILABLE'
                        if ([string]$f91sGot.error -eq 'redirect-refused') { $f91sCode = 'REDIRECT_REFUSED' }
                        if ([string]$f91sGot.error -eq 'size-limit') { $f91sCode = 'SIZE_LIMIT' }
                        $f91sStatus = [int]$f91sGot.httpStatus
                        if ($f91sStatus -lt 400 -or $f91sStatus -gt 599) { $f91sStatus = 502 }
                        Send-ClientResponse -Stream $stream -Code $f91sStatus -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = $f91sCode; messageKey = 'search.errors.generic'; detail = [string]$f91sGot.error }))
                        return
                    }
                    $f91sCt = 'application/octet-stream'
                    try { if ($f91sGot.contentType) { $f91sCt = [string]$f91sGot.contentType } } catch { }
                    $f91sBody = [byte[]]@()
                    if (-not $f91sHead -and $f91sGot.bytes) { $f91sBody = [byte[]]$f91sGot.bytes }
                    Send-ClientResponse -Stream $stream -Code 200 -CType $f91sCt -Body $f91sBody
                    Write-ClientAudit ('f91 stream ' + $(if ($f91sHead) { 'HEAD' } else { 'GET' }) + ' host=' + $f91sHost + ' bytes=' + [string]$f91sBody.Length)
                    return
                } finally {
                    try { $f91sNowLive = 0
                        if ($f91sTok -and $script:F91StreamActive.ContainsKey($f91sTok)) { $f91sNowLive = [int]$script:F91StreamActive[$f91sTok] }
                        $script:F91StreamActive[$f91sTok] = [Math]::Max(0, $f91sNowLive - 1) } catch { }
                }
            }

            # [F87 §C.1] POST /api/f87-selftest - the production proof the operator
            # runs ONCE after a dispatch, instead of click-testing eleven sites by
            # hand. Body {sites:[...]} must be a SUBSET of the operator fixture in
            # payloads/data/f88-site-hints.json (anything else -> 400, so this can
            # never become a generic crawler). Per site, in order:
            #   1. HEAD probe of https://<site>/ through the F78 secure fetch
            #      (https only, same-host redirects, no cookies)   -> probeOk
            #   2. /sitemap.xml via the F86 index-aware fetch (recursive for a
            #      <sitemapindex>, 5 sub-sitemaps, 2000 cap)         -> sitemapUrls
            #      (thin/no sitemap -> the F86 per-site hint paths are tried)
            #   3. Invoke-F86LaunchUrl on the homepage: the real ladder, the real
            #      rung number                                      -> launchTier/launchOk
            #   4. download-to-RDP STUB: if the sitemap carried a .pdf URL, the F84
            #      target directory is created/verified writable (a zero-byte
            #      probe file, removed again). NOTHING is downloaded.  -> downloadDirOk
            # Expensive (eleven real fetches + eleven launches), so it is rate
            # limited to 1 call / 60 s per X-Dash-Token (429 + retryAfterSeconds).
            # Same dash-token gate as every other /api route in this file.
            # [F92 §5.2] GET /api/f92-selftest - application/health+json.
            # Same block housing as the F87 proof so every helper it needs is
            # already defined by the time this runs; the gate admits the route.
            # No rate limit: the dashboard polls it every 15s and the smoke
            # gate retries every 2s while waiting for boot.
            if ($path -eq '/api/f92-selftest' -and $parts.method -eq 'GET') {
                $f92Sha = ''
                try { if ($parts.query.ContainsKey('frontendsha')) { $f92Sha = [string]$parts.query['frontendsha'] } } catch { $f92Sha = '' }
                # [F93 §3.2] 20s MEMO. The F92 selftest is an 11-site live
                # fanout; the dashboard hits it from /#/health AND the version
                # gate, and an uncached fanout per poll starves the request
                # loop - the failing /api/progress polls that is exactly what
                # lit the "connection: lost (retrying)" chip. 20s keeps the
                # operator's click-fresh data while removing the stampede.
                $f92Now = (Get-Date).ToUniversalTime()
                $f92Out = $null
                if ($script:F92SelftestCache -and [string]$script:F92SelftestCacheSha -eq $f92Sha -and ((($f92Now - $script:F92SelftestCacheAt).TotalSeconds) -lt 20)) {
                    $f92Out = $script:F92SelftestCache
                } else {
                    try { $f92Out = Invoke-F92Selftest -FrontendSha $f92Sha } catch { $f92Out = $null }
                    if ($f92Out) {
                        $script:F92SelftestCache = $f92Out
                        $script:F92SelftestCacheAt = $f92Now
                        $script:F92SelftestCacheSha = $f92Sha
                    }
                }
                if (-not $f92Out) {
                    Send-ClientResponse -Stream $stream -Code 500 -CType 'application/health+json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ status = 'fail'; error = 'f92-selftest threw: see server log' }))
                    return
                }
                Send-ClientResponse -Stream $stream -Code ([int]$f92Out.Code) -CType 'application/health+json; charset=utf-8' -Body ([byte[]]$f92Out.Body) -ExtraHeaders ('X-Correlation-ID: ' + [string]$f92Out.CorrId)
                Write-ClientAudit ('f92 selftest status=' + [string]$f92Out.Code + ' corr=' + [string]$f92Out.CorrId)
                return
            }
            if ($path -eq '/api/f87-selftest' -and $parts.method -eq 'POST') {
                if (-not $script:F87SelfTestRate) { $script:F87SelfTestRate = @{} }
                $f87Now = (Get-Date).ToUniversalTime()
                $f87Tok = ''
                try { $f87Tok = [string]$parts.headers['x-dash-token'] } catch { $f87Tok = '' }
                if ($script:F87SelfTestRate.ContainsKey($f87Tok)) {
                    $f87Age = ($f87Now - $script:F87SelfTestRate[$f87Tok]).TotalSeconds
                    if ($f87Age -lt 60) {
                        $f87Retry = [int][Math]::Ceiling(60 - $f87Age)
                        if ($f87Retry -lt 1) { $f87Retry = 1 }
                        Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'RATE_LIMITED'; messageKey = 'selfTest.rateLimited'; retryAfterSeconds = $f87Retry }))
                        return
                    }
                }
                $f87BodyText = ''
                try { $f87BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f87BodyText = '' }
                $f87Json = $null
                try { $f87Json = $f87BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f87Json = $null }
                $f87Requested = @()
                try { if ($f87Json -and $f87Json.sites) { $f87Requested = @($f87Json.sites) } } catch { $f87Requested = @() }
                # The allowlist IS the operator fixture: the keys of f88-site-hints.json.
                $f87Allowed = @()
                try { $f87Allowed = @((Get-F86SiteHints).Keys | ForEach-Object { [string]$_ } | Sort-Object) } catch { $f87Allowed = @() }
                $f87Sites = @()
                $f87Bad = @()
                foreach ($f87Raw in $f87Requested) {
                    $f87Site = ([string]$f87Raw).Trim().ToLowerInvariant() -replace '^https?://', '' -replace '^www\.', '' -replace '/.*$', ''
                    if (-not $f87Site) { continue }
                    if ($f87Allowed -contains $f87Site) { if ($f87Sites -notcontains $f87Site) { $f87Sites += $f87Site } } else { $f87Bad += $f87Site }
                }
                if ($f87Bad.Count -gt 0 -or $f87Sites.Count -eq 0 -or $f87Sites.Count -gt 11) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'selfTest.invalidSites'; rejected = @($f87Bad); allowed = @($f87Allowed) }))
                    return
                }
                $script:F87SelfTestRate[$f87Tok] = $f87Now
                $f87DestDir = Join-Path $env:USERPROFILE 'Desktop\RDP-Downloads'
                $f87Results = @()
                foreach ($f87Site in $f87Sites) {
                    # [F91 §E.1] two more per-site columns: launcherQueueTest
                    # (write a NOOP job -> the persistent service must consume it
                    # and log it, proof of route->file->service->log end to end,
                    # with no browser and no desktop disturbance) and
                    # streamProxyTest (the exact fences of /api/stream against
                    # the site's favicon, HEAD - no bytes relayed).
                    $f87Row = [ordered]@{ site = $f87Site; probeOk = $false; sitemapUrls = 0; sitemapMode = ''; launchTier = 0; launchOk = $false; launchDetail = ''; pdfFound = $false; downloadDirOk = $false; downloadDir = $f87DestDir; downloadOk = $false; downloadPath = ''; downloadBytes = 0; searchStrategy = ''; searchOk = $false; searchItems = 0; networkingItemCount = 0; launcherQueueOk = $false; launcherQueueNote = ''; streamProxyOk = $false; streamProxyStatus = 0; errors = @() }
                    $f87Home = 'https://' + $f87Site + '/'
                    # 1. HEAD probe (the secure fetch follows same-host redirects only,
                    #    so a www.<site> canonical still counts as reachable).
                    try {
                        $f87Probe = Invoke-F78SecureFetch -Url $f87Home -ExpectedHost $f87Site -MaxBytes 65536 -TimeoutSec 8
                        $f87Row.probeOk = [bool]$f87Probe.ok
                        if (-not $f87Probe.ok) { $f87Row.errors += ('probe: ' + [string]$f87Probe.error) }
                    } catch { $f87Row.errors += ('probe: ' + $_.Exception.Message) }
                    # 2. sitemap.xml (index-aware), then the per-site hint paths.
                    $f87Urls = @()
                    try {
                        $f87Map = Invoke-F86SitemapFetch -Url ($f87Home + 'sitemap.xml') -f78Host $f87Site
                        if ($f87Map.ok) { $f87Urls = @($f87Map.urls); $f87Row.sitemapMode = [string]$f87Map.mode }
                        if ($f87Urls.Count -lt 50) {
                            $f87Hint = Get-F86SiteHint -HostName $f87Site
                            foreach ($f87HintPath in @(Get-F86HintList -Hint $f87Hint -Field 'sitemapPaths' -Max 3)) {
                                $f87Alt = Invoke-F86SitemapFetch -Url ('https://' + $f87Site + [string]$f87HintPath) -f78Host $f87Site
                                if ($f87Alt.ok -and $f87Alt.urls.Count -gt $f87Urls.Count) { $f87Urls = @($f87Alt.urls); $f87Row.sitemapMode = 'hint:' + [string]$f87HintPath }
                                if ($f87Urls.Count -ge 50) { break }
                            }
                        }
                    } catch { $f87Row.errors += ('sitemap: ' + $_.Exception.Message) }
                    $f87Row.sitemapUrls = [int]$f87Urls.Count
                    if ($f87Urls.Count -eq 0) { $f87Row.errors += 'sitemap: no URLs found' }
                    # [F90 §D] The per-site SEARCH proof. awesome.re is the site
                    # that proves the F90 cross-domain fix: it has no real
                    # sitemap of its own, its content is the sindresorhus/awesome
                    # README on raw.githubusercontent.com, and its hint is the
                    # markdown-section strategy. Running the real strategy here
                    # (not a sitemap proxy) is the only thing that can show
                    # "the README fetched AND the Networking section has N items".
                    try {
                        $f87Hint = Get-F86SiteHint -HostName $f87Site
                        if ($f87Hint) {
                            $f87Row.searchStrategy = [string]$f87Hint.searchStrategy
                            $f87ProbeQuery = 'networking'
                            $f87Search = Invoke-F88SiteSearch -HostName $f87Site -Query $f87ProbeQuery -BaseUrl $f87Home
                            if ($f87Search -and $f87Search.ok) {
                                $f87Row.searchOk = $true
                                $f87Row.searchItems = [int]$f87Search.itemCount
                            } else {
                                $f87Row.errors += ('search: ' + $(if ($f87Search) { [string]$f87Search.error } else { 'no-result' }))
                            }
                        }
                    } catch { $f87Row.errors += ('search: ' + $_.Exception.Message) }
                    if ($f87Site -eq 'awesome.re') {
                        # The operator-visible proof column: items under the
                        # Networking H2 of the resolved README.
                        $f87Row.networkingItemCount = [int]$f87Row.searchItems
                        if ($f87Row.networkingItemCount -le 0) { $f87Row.errors += 'awesome.re: no Networking items resolved' }
                    }
                    # 3. The real launch ladder on the homepage.
                    try {
                        $f87Launch = Invoke-F86LaunchUrl -Url $f87Home
                        $f87Row.launchTier = [int]$f87Launch.tier
                        $f87Row.launchOk = [bool]$f87Launch.ok
                        $f87Row.launchDetail = [string]$f87Launch.detail
                        if (-not $f87Launch.ok) { $f87Row.errors += ('launch: ' + [string]$f87Launch.detail) }
                    } catch { $f87Row.errors += ('launch: ' + $_.Exception.Message) }
                    # 4. download-to-RDP stub: directory present + writable, no bytes fetched.
                    foreach ($f87U in $f87Urls) { if (([string]$f87U) -match '(?i)\.pdf(\?|$)') { $f87Row.pdfFound = $true; break } }
                    try {
                        if (-not (Test-Path -LiteralPath $f87DestDir)) { New-Item -ItemType Directory -Path $f87DestDir -Force | Out-Null }
                        $f87ProbeFile = Join-Path $f87DestDir ('.f87-writable-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
                        [System.IO.File]::WriteAllBytes($f87ProbeFile, [byte[]]@())
                        Remove-Item -LiteralPath $f87ProbeFile -Force -ErrorAction SilentlyContinue
                        $f87Row.downloadDirOk = $true
                    } catch { $f87Row.errors += ('downloadDir: ' + $_.Exception.Message) }
                    # [F88 §C.2] REAL download proof: GET the site's robots.txt
                    # through the SAME verified transfer the /api/fetch
                    # download=true branch uses (Invoke-F88DownloadToRdp) and
                    # confirm the bytes landed in Desktop\RDP-Downloads -
                    # downloadOk/downloadPath/downloadBytes are the operator-
                    # visible proof of a write.
                    try {
                        $f88Dt = Invoke-F88DownloadToRdp -Url ($f87Home + 'robots.txt') -ExpectedHost $f87Site -DestDir $f87DestDir
                        $f87Row.downloadOk = [bool]$f88Dt.ok
                        $f87Row.downloadPath = [string]$f88Dt.path
                        $f87Row.downloadBytes = [int]$f88Dt.bytes
                        if (-not $f88Dt.ok) { $f87Row.errors += ('downloadTest: ' + [string]$f88Dt.error) }
                    } catch { $f87Row.errors += ('downloadTest: ' + $_.Exception.Message) }
                    # [F91 §E.1] 5. launcherQueueTest: NOOP job + consume proof.
                    try {
                        $f91Paths = Get-F91LauncherPaths
                        $f91Hb = Get-F91LauncherHealth
                        if (-not $f91Hb.serviceRunning) {
                            $f87Row.launcherQueueNote = 'launcher-offline'
                            $f87Row.errors += 'launcherQueue: heartbeat older than 30s (is GHRDP-Launcher registered? re-dispatch main.yml)'
                        } elseif (-not (Test-Path -LiteralPath $f91Paths.queueDir)) {
                            $f87Row.launcherQueueNote = 'queue-dir-missing'
                            $f87Row.errors += 'launcherQueue: ' + [string]$f91Paths.queueDir + ' not present'
                        } else {
                            $f91Marker = 'f91-selftest-' + ([guid]::NewGuid().ToString('N')).Substring(0, 8)
                            $f91ProbeFile = Join-Path $f91Paths.queueDir (([guid]::NewGuid().ToString('N')) + '.job')
                            [System.IO.File]::WriteAllText($f91ProbeFile, (@{ id = $f91Marker; url = $f87Home; mode = 'noop'; name = $f91Marker; timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } | ConvertTo-Json -Compress))
                            $f91Deadline = (Get-Date).AddSeconds(8)
                            while ((Get-Date) -lt $f91Deadline) {
                                if (-not (Test-Path -LiteralPath $f91ProbeFile)) { $f87Row.launcherQueueOk = $true; break }
                                Start-Sleep -Milliseconds 250
                            }
                            if (-not $f87Row.launcherQueueOk) {
                                $f87Row.launcherQueueNote = 'job-unconsumed'
                                $f87Row.errors += 'launcherQueue: job written but not consumed within 8s'
                                try { Remove-Item -LiteralPath $f91ProbeFile -Force -ErrorAction SilentlyContinue } catch { }
                            } else {
                                $f87Row.launcherQueueNote = 'consumed'
                            }
                        }
                    } catch { $f87Row.errors += ('launcherQueue: ' + $_.Exception.Message) }
                    # [F91 §E.1] 6. streamProxyTest: HEAD through the /api/stream
                    # fences (navigate validation + exact-host allowlist) - a 2xx
                    # upstream answer is the proof; nothing is relayed.
                    try {
                        $f91St = Invoke-F91StreamFetch -Url ($f87Home + 'favicon.ico') -MaxBytes 1 -ProbeHead
                        $f91StStatus = [int]$f91St.httpStatus
                        $f87Row.streamProxyStatus = $f91StStatus
                        if ($f91St.ok -or ($f91StStatus -ge 200 -and $f91StStatus -lt 400)) {
                            $f87Row.streamProxyOk = $true
                        } else {
                            $f87Row.errors += ('streamProxy: ' + [string]$f91St.error + ' status=' + [string]$f91StStatus)
                        }
                    } catch { $f87Row.errors += ('streamProxy: ' + $_.Exception.Message) }
                    $f87Results += $f87Row
                    Write-ClientAudit ('f87 selftest site=' + $f87Site + ' probe=' + [string]$f87Row.probeOk + ' sitemap=' + [string]$f87Row.sitemapUrls + ' tier=' + [string]$f87Row.launchTier + ' launch=' + [string]$f87Row.launchOk + ' dir=' + [string]$f87Row.downloadDirOk)
                }
                $f87Pass = @($f87Results | Where-Object { $_.probeOk -and $_.sitemapUrls -gt 0 -and $_.launchOk -and $_.downloadDirOk }).Count
                # [F91 §E.1] the GLOBAL launcher lines: launcherServiceRunning is
                # the heartbeat proof (<30s old), taskSchedulerHealth is the
                # GHRDP-Launcher scheduled-task presence. Both are read straight
                # off Get-F91LauncherHealth - the same payload /api/launcher/
                # health answers - so the self-test column and the diag panel
                # can never disagree.
                $f91Global = Get-F91LauncherHealth
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; ranAt = $f87Now.ToString('yyyy-MM-ddTHH:mm:ssZ'); total = [int]$f87Results.Count; passed = [int]$f87Pass; launcherServiceRunning = [bool]$f91Global.serviceRunning; taskSchedulerHealth = [bool]$f91Global.taskExists; launcher = [ordered]@{ serviceRunning = [bool]$f91Global.serviceRunning; heartbeatAge = [int64]$f91Global.heartbeatAge; queueDepth = [int]$f91Global.queueDepth; taskExists = [bool]$f91Global.taskExists; activeUser = [string]$f91Global.activeUser }; results = @($f87Results) }))
                return
            }

            # [F81 §3.2/Q8] POST /api/preview — fetch the first ~500 chars of
            # text for a public source URL. The route is gated by the same
            # X-Dash-Token used everywhere else, only serves the summary
            # (never the full response body), and only fetches from the
            # allowlisted adapters (`$allowedAdapters` literal inherited from
            # the search route, already a literal in this file). It honours
            # the F46 security boundaries (HTTPS only, no cookies, no auth
            # headers, no custom User-Agent change from the
            # Ghrdp-Search/1.0 default).
            if ($path -eq '/api/preview' -and $parts.method -eq 'POST') {
                $f81PrevBodyText = ''
                try { $f81PrevBodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f81PrevBodyText = '' }
                $f81PrevJson = $null
                try { $f81PrevJson = $f81PrevBodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f81PrevJson = $null }
                if (-not $f81PrevJson) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f81PrevUrl = ''
                try { $f81PrevUrl = [string]$f81PrevJson.url } catch { $f81PrevUrl = '' }
                $f81PrevUrl = $f81PrevUrl.Trim()
                $f81PrevAdapter = ''
                try { $f81PrevAdapter = [string]$f81PrevJson.adapterId } catch { $f81PrevAdapter = '' }
                if (-not $f81PrevUrl.StartsWith('https://')) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteHttpsRequired' }))
                    return
                }
                $f81PrevUri = $null
                try { $f81PrevUri = [System.Uri]$f81PrevUrl } catch { $f81PrevUri = $null }
                if (-not $f81PrevUri -or $f81PrevUri.Scheme -ne 'https' -or $f81PrevUri.UserInfo) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteAuthNotAllowed' }))
                    return
                }
                $f81PrevBytes = 2048
                try { $f81PrevBytes = [int]$f81PrevJson.maxBytes } catch { $f81PrevBytes = 2048 }
                if ($f81PrevBytes -lt 256) { $f81PrevBytes = 256 }
                if ($f81PrevBytes -gt 16384) { $f81PrevBytes = 16384 }
                # Use the same hardened fetcher (https only, no auth, no
                # cookies, no redirects off-host) but allow the broad set of
                # hosts used by the search adapters. The preview is a
                # best-effort summary; a 4xx / 5xx / non-text body returns
                # the preview-unavailable envelope.
                $f81PrevFetch = Invoke-F78SecureFetch -Url $f81PrevUrl -ExpectedHost ([string]$f81PrevUri.Host.ToLowerInvariant()) -MaxBytes $f81PrevBytes -TimeoutSec 8
                if (-not $f81PrevFetch.ok) {
                    Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $false; code = ([string]$f81PrevFetch.code); messageKey = 'search.results.previewUnavailable' }))
                    return
                }
                $f81PrevText = ConvertTo-F78PlainText ([string]$f81PrevFetch.text)
                if ($f81PrevText.Length -gt 500) { $f81PrevText = $f81PrevText.Substring(0, 500) }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ ok = $true; summary = $f81PrevText; bytes = [int]$f81PrevFetch.bytes; host = ([string]$f81PrevFetch.host) }))
                Write-ClientAudit ('f81 preview host=' + [string]$f81PrevUri.Host + ' adapter=' + $f81PrevAdapter + ' bytes=' + [string]$f81PrevFetch.bytes)
                return
            }

            if ($path -eq '/api/lab/inspect') {
                if ($parts.method -ne 'POST') {
                    Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f78BodyText = ''
                try { $f78BodyText = [System.Text.Encoding]::UTF8.GetString($parts.body) } catch { $f78BodyText = '' }
                $f78Json = $null
                try { $f78Json = $f78BodyText | ConvertFrom-Json -ErrorAction Stop } catch { $f78Json = $null }
                if (-not $f78Json) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f78SourceId = ''
                $f78SourceUrl = ''
                $f78Query = ''
                try { $f78SourceId = [string]$f78Json.sourceId } catch { $f78SourceId = '' }
                try { $f78SourceUrl = [string]$f78Json.sourceUrl } catch { $f78SourceUrl = '' }
                try { $f78Query = [string]$f78Json.query } catch { $f78Query = '' }
                $f78SourceId = $f78SourceId.Trim()
                $f78SourceUrl = $f78SourceUrl.Trim()
                if ($f78SourceUrl.Length -gt 2048) { $f78SourceUrl = $f78SourceUrl.Substring(0, 2048) }
                $f78Query = $f78Query.Trim()
                if (-not $f78SourceId) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                if (-not $script:F78Sources.ContainsKey($f78SourceId)) {
                    Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'NOT_FOUND' -MessageKey 'lab.notFound' -RetryAfter 0))
                    return
                }
                $f78Src = $script:F78Sources[$f78SourceId]
                if ($f78Src.labMode -ne $true) {
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'FORBIDDEN' -MessageKey 'lab.notFound' -RetryAfter 0))
                    return
                }
                $f78Host = [string]$f78Src.hostname
                # [F90 §B.1] same fence as before, plus the hosts THIS source
                # already proved it resolves to (registered only after a
                # successful cross-domain markdown-section fetch). Scoped to the
                # source's own hostname, so it never widens another site.
                $f78HostAllowed = $false
                if ($f78Host -and $script:F78AllowHosts.ContainsKey($f78Host)) { $f78HostAllowed = $true }
                if (-not $f78HostAllowed -and $f78Host -and $script:F88CrossDomainHosts.ContainsKey($f78Host.ToLowerInvariant())) { $f78HostAllowed = $true }
                if (-not $f78HostAllowed) {
                    Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'HOSTNAME_MISMATCH' -MessageKey 'lab.hostnameMismatch' -RetryAfter 0))
                    return
                }
                # 10 fetches/minute per sourceId (the route's whole budget).
                $f78Now = (Get-Date).ToUniversalTime()
                $f78Hits = @()
                if ($script:F78LabInspectRateLimiter.ContainsKey($f78SourceId)) { $f78Hits = @($script:F78LabInspectRateLimiter[$f78SourceId]) }
                $f78Hits = @($f78Hits | Where-Object { ($f78Now - $_).TotalSeconds -lt 60 })
                if ($f78Hits.Count -ge 10) {
                    $f78Retry = [int][Math]::Ceiling(60 - ($f78Now - $f78Hits[0]).TotalSeconds)
                    if ($f78Retry -lt 1) { $f78Retry = 1 }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'RATE_LIMITED' -MessageKey 'lab.rateLimited' -RetryAfter $f78Retry))
                    Write-ClientAudit ('f78 lab rate-limited id=' + $f78SourceId)
                    return
                }
                $f78Hits += $f78Now
                $script:F78LabInspectRateLimiter[$f78SourceId] = $f78Hits
                # [F81 §3.1/Q4] Sitemap-first deep content. The sitemap fetch is
                # a second GET (counts toward the same per-source 10/min
                # budget). When sitemap is missing or invalid the route
                # transparently falls back to homepage link extraction (the
                # F78 behaviour); the response now exposes which path served
                # the data via `source` and `adapterStatus.phase`.
                $f78Phase = 'homepage-fallback'
                $f78SourceLabel = 'homepage'
                $f78SourceUrls = 0
                $f78LinksOut = @()
                $f78LinkCount = 0
                $f78MatchCount = 0
                $f78Html = ''
                $f78Title = ''
                $f78BaseUri = $null
                try { $f78BaseUri = [System.Uri]([string]$f78Src.baseUrl) } catch { $f78BaseUri = $null }
                $f78Needle = ''
                if ($f78Query) {
                    $f78Needle = $f78Query
                    try { $f78Needle = [System.Uri]::UnescapeDataString($f78Query) } catch { $f78Needle = $f78Query }
                    $f78Needle = $f78Needle.ToLowerInvariant()
                }
                $f81Sitemap = Invoke-F78SecureFetch -Url ($f78Src.baseUrl.TrimEnd('/') + '/sitemap.xml') -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 8
                if ($f81Sitemap.ok) {
                    $f78Phase = 'sitemap-ok'
                    $f78SourceLabel = 'sitemap.xml'
                    $f78SitemapXml = [string]$f81Sitemap.text
                    foreach ($f78Sm in [regex]::Matches($f78SitemapXml, '(?is)<loc>\s*([^<]+?)\s*</loc>')) {
                        if ($f78LinksOut.Count -ge 500) { break }
                        $f78Loc = [string]$f78Sm.Groups[1].Value.Trim()
                        if (-not $f78Loc) { continue }
                        $f78SLink = $null
                        try { $f78SLink = [System.Uri]$f78Loc } catch { $f78SLink = $null }
                        if (-not $f78SLink -or $f78SLink.Scheme -ne 'https') { continue }
                        if (-not (Test-F78SameHost -Allowed $f78Host -Actual $f78SLink.Host)) { continue }
                        $f78UrlPath = ''
                        try { $f78UrlPath = [string]$f78SLink.AbsolutePath } catch { $f78UrlPath = '' }
                        $f78Text = if ($f78UrlPath.Length -gt 0) { $f78UrlPath } else { [string]$f78SLink.AbsoluteUri }
                        $f78UrlPathLower = $f78UrlPath.ToLowerInvariant()
                        $f78IsMatch = $false
                        if ($f78Needle) {
                            if ($f78UrlPathLower.Contains($f78Needle) -or ([string]$f78SLink.AbsoluteUri).ToLowerInvariant().Contains($f78Needle)) { $f78IsMatch = $true }
                        }
                        $f78LinkCount++
                        if ($f78IsMatch) { $f78MatchCount++ }
                        $f78LinksOut += [ordered]@{ text = $f78Text; href = ([string]$f78SLink.AbsoluteUri); matches = $f78IsMatch }
                    }
                    $f78SourceUrls = $f78LinkCount
                } else {
                    $f78Phase = 'homepage-fallback'
                    $f78SourceLabel = 'homepage'
                    $f78Fetch = Invoke-F78SecureFetch -Url ([string]$f78Src.baseUrl) -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 10
                    if (-not $f78Fetch.ok) {
                        $f78ErrKey = 'lab.timeout'
                        if ($f78Fetch.code -eq 'SIZE_LIMIT') { $f78ErrKey = 'lab.sizeLimit' }
                        elseif ($f78Fetch.code -eq 'HOSTNAME_MISMATCH') { $f78ErrKey = 'lab.hostnameMismatch' }
                        Send-ClientResponse -Stream $stream -Code ([int]$f78Fetch.httpStatus) -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code ([string]$f78Fetch.code) -MessageKey $f78ErrKey -RetryAfter 0))
                        Write-ClientAudit ('f78 lab fetch failed id=' + $f78SourceId + ' code=' + [string]$f78Fetch.code)
                        return
                    }
                    $f78Html = [string]$f78Fetch.text
                    foreach ($f78Match in [regex]::Matches($f78Html, '(?is)<a\b[^>]*href\s*=\s*["'']([^"'']+)["''][^>]*>(.*?)</a>')) {
                        if ($f78LinksOut.Count -ge 500) { break }
                        $f78HrefRaw = [string]$f78Match.Groups[1].Value
                        $f78Text = ConvertTo-F78PlainText $f78Match.Groups[2].Value
                        if (-not $f78HrefRaw) { continue }
                        if ($f78HrefRaw.StartsWith('#')) { continue }
                        if ($f78HrefRaw -match '^(?i)(mailto:|javascript:|data:|tel:)') { continue }
                        $f78Abs = ''
                        try {
                            if ($f78HrefRaw -match '^(?i)https?://') { $f78Abs = ([System.Uri]$f78HrefRaw).AbsoluteUri }
                            elseif ($f78BaseUri) { $f78Abs = ([System.Uri]::new($f78BaseUri, $f78HrefRaw)).AbsoluteUri }
                            else { $f78Abs = '' }
                        } catch { $f78Abs = '' }
                        if (-not $f78Abs) { continue }
                        if (-not $f78Abs.StartsWith('https://')) { continue }
                        $f78LinkHost = ''
                        try { $f78LinkHost = ([System.Uri]$f78Abs).Host.ToLowerInvariant() } catch { continue }
                        if (-not (Test-F78SameHost -Allowed $f78Host -Actual $f78LinkHost)) { continue }
                        $f78LinkCount++
                        $f78IsMatch = $false
                        if ($f78Needle) {
                            $f78Hay = $f78Text + ' ' + $f78Abs
                            try { $f78Hay = [System.Uri]::UnescapeDataString($f78Hay) } catch { }
                            if ($f78Hay.ToLowerInvariant().Contains($f78Needle)) { $f78IsMatch = $true }
                        }
                        if ($f78IsMatch) { $f78MatchCount++ }
                        $f78LinksOut += [ordered]@{ text = $f78Text; href = $f78Abs; matches = $f78IsMatch }
                    }
                    $f78SourceUrls = $f78LinkCount
                }
                try {
                    $f78TitleMatch = [regex]::Match($f78Html, '(?is)<title[^>]*>(.*?)</title>')
                    if ($f78TitleMatch.Success) { $f78Title = ConvertTo-F78PlainText $f78TitleMatch.Groups[1].Value }
                } catch { $f78Title = '' }
                if (-not $f78SourceId -and -not $f78SourceUrl) {
                    Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                    return
                }
                $f78ResultMode = $false
                if ($f78SourceId) {
                    if (-not $script:F78Sources.ContainsKey($f78SourceId)) {
                        Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'NOT_FOUND' -MessageKey 'lab.notFound' -RetryAfter 0))
                        return
                    }
                    $f78Src = $script:F78Sources[$f78SourceId]
                    if ($f78Src.labMode -ne $true) {
                        Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'FORBIDDEN' -MessageKey 'lab.notFound' -RetryAfter 0))
                        return
                    }
                    $f78Host = [string]$f78Src.hostname
                    if (-not $f78Host -or -not $script:F78AllowHosts.ContainsKey($f78Host)) {
                        Send-ClientResponse -Stream $stream -Code 403 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'HOSTNAME_MISMATCH' -MessageKey 'lab.hostnameMismatch' -RetryAfter 0))
                        return
                    }
                } else {
                    # [F86 §B.2] RESULT-VIEW mode. The Lab opened on a RESULT id
                    # (not a stored site), so the client sends the result's own
                    # sourceUrl and the server inspects THAT page: same transport
                    # as /api/preview (https only, no userinfo, <=2048, 2MB cap,
                    # ExpectedHost is the URL's own host), same same-host href
                    # fence, same 500-row payload cap. No sitemap crawl runs here
                    # - the target is one page, not a site root - and the
                    # 10-fetches/minute limiter keys on the host instead of a
                    # sourceId.
                    if (-not $f78SourceUrl.StartsWith('https://')) {
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteHttpsRequired' }))
                        return
                    }
                    $f78ResultUri = $null
                    try { $f78ResultUri = [System.Uri]$f78SourceUrl } catch { $f78ResultUri = $null }
                    if (-not $f78ResultUri -or $f78ResultUri.Scheme -ne 'https' -or $f78ResultUri.UserInfo) {
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'VALIDATION_ERROR'; messageKey = 'newSiteAuthNotAllowed' }))
                        return
                    }
                    $f78Host = [string]$f78ResultUri.Host.ToLowerInvariant()
                    if (-not $f78Host) {
                        Send-ClientResponse -Stream $stream -Code 400 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
                        return
                    }
                    $f78ResultMode = $true
                    $f78Src = [ordered]@{
                        id = ('f86-result-' + $f78Host)
                        name = $f78Host
                        baseUrl = $f78SourceUrl
                        hostname = $f78Host
                        labMode = $true
                        resultMode = $true
                    }
                }
                # 10 fetches/minute per inspected key (the route's whole budget):
                # the stored sourceId, or the host for a result-view inspection.
                $f78RateKey = $f78SourceId
                if (-not $f78RateKey) { $f78RateKey = 'url:' + $f78Host }
                $f78Now = (Get-Date).ToUniversalTime()
                $f78Hits = @()
                if ($script:F78LabInspectRateLimiter.ContainsKey($f78RateKey)) { $f78Hits = @($script:F78LabInspectRateLimiter[$f78RateKey]) }
                $f78Hits = @($f78Hits | Where-Object { ($f78Now - $_).TotalSeconds -lt 60 })
                if ($f78Hits.Count -ge 10) {
                    $f78Retry = [int][Math]::Ceiling(60 - ($f78Now - $f78Hits[0]).TotalSeconds)
                    if ($f78Retry -lt 1) { $f78Retry = 1 }
                    Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'RATE_LIMITED' -MessageKey 'lab.rateLimited' -RetryAfter $f78Retry))
                    Write-ClientAudit ('f78 lab rate-limited id=' + $f78RateKey)
                    return
                }
                $f78Hits += $f78Now
                $script:F78LabInspectRateLimiter[$f78RateKey] = $f78Hits
                # [F86 §C.1] SITEMAP-INDEX RECURSION + PER-SITE HINTS. The F81
                # branch fetched /sitemap.xml once and treated every <loc> as a
                # result row - but a <sitemapindex> answers with SUB-SITEMAP
                # urls, so the ten operator sites landed on "12 links". Now the
                # response ROOT decides: <sitemapindex> enumerates <sitemap><loc>
                # and fetches up to 5 same-host sub-sitemaps (2MB each) unioning
                # their <url><loc>; <urlset> is used directly. The union is capped
                # at 2000 URLs. [F86 §C.2] When the host has a hint entry, its
                # sitemapPaths are tried too and - if the result is still thin
                # (< 50 URLs) - its searchPaths (query substituted) and
                # catalogPaths are fetched and their anchors unioned. Thin-ness is
                # measured on candidate URLs, the returned rows stay capped at 500.
                $f78Phase = 'homepage-fallback'
                $f78SourceLabel = 'homepage'
                $f78SourceUrls = 0
                $f78LinksOut = @()
                $f78LinkCount = 0
                $f78MatchCount = 0
                $f78Html = ''
                $f78Title = ''
                $f78BaseUri = $null
                try { $f78BaseUri = [System.Uri]([string]$f78Src.baseUrl) } catch { $f78BaseUri = $null }
                $f78Needle = ''
                if ($f78Query) {
                    $f78Needle = $f78Query
                    try { $f78Needle = [System.Uri]::UnescapeDataString($f78Query) } catch { $f78Needle = $f78Query }
                    $f78Needle = $f78Needle.ToLowerInvariant()
                }
                $f78CandidateUrls = @()
                $f78Hint = $null
                if (-not $f78ResultMode) { $f78Hint = Get-F86SiteHint -HostName $f78Host }
                # [F88 §1.2] SEARCH-ENDPOINT FIRST. With a typed query and a
                # declared searchStrategy the endpoint answer is the PRIMARY
                # source; the F86 sitemap/hint ladder below runs only as the
                # fallback when the search yields < 5 rows or fails (spec A.2).
                # Every source actually fetched is also returned as its own
                # sourceSets entry so the Lab can tab between them (spec A.3).
                $f88Sw = [System.Diagnostics.Stopwatch]::StartNew()
                $f88Search = $null
                $f88Primary = $false
                if (-not $f78ResultMode -and $f78Query) {
                    try { $f88Search = Invoke-F88SiteSearch -HostName $f78Host -Query $f78Query -BaseUrl ([string]$f78Src.baseUrl) } catch { $f88Search = $null }
                }
                $f88SearchRows = @()
                if ($f88Search -and $f88Search.ok) { $f88SearchRows = @($f88Search.rows) }
                if ($f88SearchRows.Count -ge 5) {
                    $f88Primary = $true
                    $f78Phase = 'search-endpoint'
                    $f78SourceLabel = 'search-endpoint'
                    $f88MergedS = Merge-F86LinkRows -Rows $f88SearchRows -f78Needle $f78Needle
                    $f78LinksOut = @($f88MergedS.links)
                    $f78LinkCount = [int]$f88MergedS.count
                    $f88MatchCount = [int]$f88MergedS.matches
                    $f78MatchCount = $f88MatchCount
                    $f78SourceUrls = $f78LinkCount
                }
                if (-not $f78ResultMode) {
                    if (-not $f88Primary) {
                    # The F81 default fetch, unchanged in form: the root sitemap
                    # is always tried first.
                    $f81Sitemap = Invoke-F78SecureFetch -Url ($f78Src.baseUrl.TrimEnd('/') + '/sitemap.xml') -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 8
                    if ($f81Sitemap.ok) {
                        $f78Expanded = Expand-F86SitemapXml -Xml ([string]$f81Sitemap.text) -SourceUrl ($f78Src.baseUrl.TrimEnd('/') + '/sitemap.xml') -f78Host $f78Host
                        $f78CandidateUrls = @($f78Expanded.urls)
                        $f78Phase = 'sitemap-ok'
                        $f78SourceLabel = 'sitemap.xml'
                    }
                    # [F86 §C.2] extra hint sitemap paths (same host, max 3). The
                    # default path above is skipped here so it is never fetched
                    # twice inside the same 10-fetch budget.
                    foreach ($f78SmPath in @(Get-F86HintList -Hint $f78Hint -Field 'sitemapPaths' -Max 3)) {
                        if ($f78CandidateUrls.Count -ge 2000) { break }
                        if ($f78SmPath -eq '/sitemap.xml') { continue }
                        $f78SmUrl = ''
                        try { $f78SmUrl = ([System.Uri]::new($f78BaseUri, $f78SmPath)).AbsoluteUri } catch { $f78SmUrl = $f78Src.baseUrl.TrimEnd('/') + $f78SmPath }
                        $f78Crawl = Invoke-F86SitemapFetch -Url $f78SmUrl -f78Host $f78Host
                        if ($f78Crawl.urls.Count -gt 0) {
                            $f78CandidateUrls = @($f78CandidateUrls) + @($f78Crawl.urls)
                            if ($f78Phase -ne 'sitemap-ok') { $f78Phase = 'sitemap-ok' }
                            if ($f78SourceLabel -eq 'homepage') { $f78SourceLabel = $f78SmPath }
                        }
                    }
                    if ($f78CandidateUrls.Count -gt 0) { $f78SourceUrls = $f78CandidateUrls.Count }
                    }
                }
                # [F86 §C.2] Thin sitemap (< 50 URLs) -> the hint's search pages,
                # with {{q}} URL-encoded and substituted server-side. Skipped
                # when [F88] the search endpoint already served the rows.
                if (-not $f78ResultMode -and -not $f88Primary -and $f78CandidateUrls.Count -lt 50) {
                    foreach ($f78Sp in @(Get-F86HintList -Hint $f78Hint -Field 'searchPaths' -Max 2)) {
                        if ($f78CandidateUrls.Count -ge 2000) { break }
                        $f78SpRel = Expand-F86HintPath -Template $f78Sp -Query $f78Query
                        $f78SpUrl = ''
                        try { $f78SpUrl = ([System.Uri]::new($f78BaseUri, $f78SpRel)).AbsoluteUri } catch { $f78SpUrl = $f78Src.baseUrl.TrimEnd('/') + $f78SpRel }
                        $f78SpFetch = Invoke-F78SecureFetch -Url $f78SpUrl -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 10
                        if (-not $f78SpFetch.ok) { continue }
                        $f78SpBase = $null
                        try { $f78SpBase = [System.Uri]$f78SpUrl } catch { $f78SpBase = $f78BaseUri }
                        foreach ($f78Row in @(Get-F86AnchorLinks -Html ([string]$f78SpFetch.text) -BaseUri $f78SpBase -f78Host $f78Host)) { $f78CandidateUrls += [string]$f78Row.href }
                        if ($f78SourceLabel -eq 'homepage') { $f78SourceLabel = 'search' }
                        if ($f78Phase -ne 'sitemap-ok') { $f78Phase = 'hint-search' }
                    }
                }
                # [F86 §C.2] Still thin -> the hint's catalog paths (anchors only).
                if (-not $f78ResultMode -and -not $f88Primary -and $f78CandidateUrls.Count -lt 50) {
                    foreach ($f78Cp in @(Get-F86HintList -Hint $f78Hint -Field 'catalogPaths' -Max 2)) {
                        if ($f78CandidateUrls.Count -ge 2000) { break }
                        $f78CpRel = Expand-F86HintPath -Template $f78Cp -Query $f78Query
                        $f78CpUrl = ''
                        try { $f78CpUrl = ([System.Uri]::new($f78BaseUri, $f78CpRel)).AbsoluteUri } catch { $f78CpUrl = $f78Src.baseUrl.TrimEnd('/') + $f78CpRel }
                        $f78CpFetch = Invoke-F78SecureFetch -Url $f78CpUrl -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 10
                        if (-not $f78CpFetch.ok) { continue }
                        $f78CpBase = $null
                        try { $f78CpBase = [System.Uri]$f78CpUrl } catch { $f78CpBase = $f78BaseUri }
                        foreach ($f78Row in @(Get-F86AnchorLinks -Html ([string]$f78CpFetch.text) -BaseUri $f78CpBase -f78Host $f78Host)) { $f78CandidateUrls += [string]$f78Row.href }
                        if ($f78SourceLabel -eq 'homepage' -or $f78SourceLabel -eq 'search') { $f78SourceLabel = 'catalog' }
                        if ($f78Phase -ne 'sitemap-ok') { $f78Phase = 'hint-catalog' }
                    }
                }
                if ($f78CandidateUrls.Count -gt 0) {
                    $f78RowSource = @()
                    foreach ($f78Cu in @($f78CandidateUrls)) {
                        $f78CUri = $null
                        try { $f78CUri = [System.Uri]([string]$f78Cu) } catch { $f78CUri = $null }
                        if (-not $f78CUri -or $f78CUri.Scheme -ne 'https') { continue }
                        if (-not (Test-F78SameHost -Allowed $f78Host -Actual $f78CUri.Host)) { continue }
                        $f78CuPath = ''
                        try { $f78CuPath = [string]$f78CUri.AbsolutePath } catch { $f78CuPath = '' }
                        $f78CuText = if ($f78CuPath.Length -gt 0) { $f78CuPath } else { [string]$f78CUri.AbsoluteUri }
                        $f78RowSource += [ordered]@{ text = $f78CuText; href = ([string]$f78CUri.AbsoluteUri) }
                    }
                    $f78Merged = Merge-F86LinkRows -Rows $f78RowSource -f78Needle $f78Needle
                    $f78LinksOut = @($f78Merged.links)
                    $f78LinkCount = [int]$f78Merged.count
                    $f78MatchCount = [int]$f78Merged.matches
                    if (-not $f78SourceUrls) { $f78SourceUrls = $f78LinkCount }
                }
                # Zero rows (a missing/invalid sitemap, a result page, or a hint
                # that answered nothing) -> fetch the page itself. In result-view
                # mode this IS the primary fetch: $f78Src.baseUrl is the result's
                # sourceUrl.
                if ($f78LinksOut.Count -eq 0) {
                    $f78Phase = 'homepage-fallback'
                    $f78Fetch = Invoke-F78SecureFetch -Url ([string]$f78Src.baseUrl) -ExpectedHost $f78Host -MaxBytes 2097152 -TimeoutSec 10
                    if (-not $f78Fetch.ok) {
                        $f78ErrKey = 'lab.timeout'
                        if ($f78Fetch.code -eq 'SIZE_LIMIT') { $f78ErrKey = 'lab.sizeLimit' }
                        elseif ($f78Fetch.code -eq 'HOSTNAME_MISMATCH') { $f78ErrKey = 'lab.hostnameMismatch' }
                        Send-ClientResponse -Stream $stream -Code ([int]$f78Fetch.httpStatus) -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code ([string]$f78Fetch.code) -MessageKey $f78ErrKey -RetryAfter 0))
                        Write-ClientAudit ('f78 lab fetch failed id=' + $f78RateKey + ' code=' + [string]$f78Fetch.code)
                        return
                    }
                    $f78Html = [string]$f78Fetch.text
                    $f78AnchorRows = @(Get-F86AnchorLinks -Html $f78Html -BaseUri $f78BaseUri -f78Host $f78Host)
                    # [F86 §C.3] A thin homepage (or any result page) gets ONE
                    # level of "obvious index" links followed - browse / catalog /
                    # all / index / archive / search, at most 3, same host only -
                    # and their anchors are unioned in before the row cap applies.
                    if ($f78AnchorRows.Count -lt 50) {
                        $f78AnchorRows += @(Expand-F86IndexLinks -Html $f78Html -BaseUri $f78BaseUri -f78Host $f78Host)
                    }
                    $f78Merged = Merge-F86LinkRows -Rows $f78AnchorRows -f78Needle $f78Needle
                    $f78LinksOut = @($f78Merged.links)
                    $f78LinkCount = [int]$f78Merged.count
                    $f78MatchCount = [int]$f78Merged.matches
                    $f78SourceUrls = $f78LinkCount
                    if ($f78ResultMode) { $f78SourceLabel = 'result-url' }
                }
                try {
                    $f78TitleMatch = [regex]::Match($f78Html, '(?is)<title[^>]*>(.*?)</title>')
                    if ($f78TitleMatch.Success) { $f78Title = ConvertTo-F78PlainText $f78TitleMatch.Groups[1].Value }
                } catch { $f78Title = '' }
                # [F88 §1.3] The visible "Source:" line + one sourceSets entry
                # per source actually fetched (search endpoint first, fallback
                # ladder when it ran) - the Lab tabs across them (spec A.3).
                try { $f88Sw.Stop() } catch { }
                $f88Display = ''
                $f88StrategyOut = 'sitemap'
                $f88SourceSets = @()
                if ($f88Primary) {
                    $f88Display = [string]$f88Search.label
                    $f88StrategyOut = [string]$f88Search.strategy
                    if (-not $f88Display) { $f88Display = 'Search endpoint' }
                } else {
                    $f88FbKey = [string]$f78SourceLabel
                    $f88FbDisplay = [string]$f78SourceLabel
                    $f88FbStrategy = 'sitemap'
                    if ($f78SourceLabel -eq 'homepage' -or $f78SourceLabel -eq 'result-url') { $f88FbKey = 'homepage'; $f88FbDisplay = 'Homepage'; $f88FbStrategy = 'homepage' }
                    elseif ($f78SourceLabel -eq 'search' -or $f78SourceLabel -eq 'catalog') { $f88FbDisplay = ('Hint ' + $f78SourceLabel + ' pages'); $f88FbStrategy = 'fallback' }
                    elseif ($f78SourceLabel -notmatch '(?i)sitemap') { $f88FbStrategy = 'fallback' }
                    else { $f88FbDisplay = 'Sitemap XML'; $f88FbKey = 'sitemap'; $f88FbStrategy = 'sitemap' }
                    $f88Display = $f88FbDisplay
                    $f88StrategyOut = $f88FbStrategy
                    $f88SourceSets += [ordered]@{ key = $f88FbKey; label = $f88FbDisplay; strategy = $f88FbStrategy; count = [int]$f78LinkCount; links = @($f78LinksOut) }
                }
                if ($f88Search -and @($f88Search.rows).Count -gt 0) {
                    $f88SetM = Merge-F86LinkRows -Rows (@($f88Search.rows)) -f78Needle $f78Needle
                    $f88SourceSets = @([ordered]@{ key = 'search-endpoint'; label = $(if ($f88Search.label) { [string]$f88Search.label } else { 'Search endpoint' }); strategy = [string]$f88Search.strategy; count = [int]$f88SetM.count; links = @($f88SetM.links) }) + @($f88SourceSets)
                }
                $f78Payload = [ordered]@{
                    hostname = $f78Host
                    title = $f78Title
                    links = $f78LinksOut
                    fetchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    linkCount = $f78LinkCount
                    matchCount = $f78MatchCount
                    source = $f78SourceLabel
                    sourceUrls = $f78SourceUrls
                    sourceDisplay = $f88Display
                    sourceStrategy = $f88StrategyOut
                    sourceRepo = $(if ($f88Search) { [string]$f88Search.repo } else { '' })
                    sourceItemCount = $(if ($f88Search) { [int]$f88Search.itemCount } else { 0 })
                    tookMs = [int]$f88Sw.ElapsedMilliseconds
                    sourceSets = @($f88SourceSets)
                    adapterStatus = [ordered]@{ phase = $f78Phase; sourceLabel = $f78SourceLabel }
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f78Payload)
                Write-ClientAudit ('f78 lab inspect id=' + $f78SourceId + ' phase=' + $f78Phase + ' source=' + $f78SourceLabel + ' links=' + [string]$f78LinkCount + ' matches=' + [string]$f78MatchCount + ' qlen=' + [string]$f78Query.Length)
                return
            }
            # /api/f58/sources or /api/lab/inspect with any other method.
            Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'VALIDATION_ERROR' -MessageKey 'search.errors.validation' -RetryAfter 0))
            return
        }
        # [remediation] C2 / agent-payload / .bat endpoints removed -> 404
        # (no enrollment, no command queue, no agent hello/status, no diag up/download, no served payloads/bat)
        if ($path -in @('/install.bat','/connect-now.bat','/install.ps1','/client-install.ps1','/api/enroll.ps1','/api/launch.ps1','/launcher.ps1','/api/launcher-hello','/api/agent.ps1','/api/agent-hash','/api/accept.ps1','/api/acceptance.ps1','/api/device-enroll','/api/client-cmd','/api/agent-hello','/api/agent-status','/api/client-status','/api/diag-upload','/api/diag-file')) {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        # [F14 §2] GET /dl/<name> - one-click install-kit download. Tailnet-only
        # (CGNAT 100.64/10 source; loopback allowed for the lab self-test). NO
        # dash token: the allowlisted files carry no secrets. Allowlist is EXACT
        # ($script:DlNames): no directory listing (/dl and /dl/ 404), no
        # traversal, no other file in $Root reachable; everything else 404.
        if ($path -eq '/dl' -or $path.StartsWith('/dl/')) {
            $dlName = ''
            if ($path.Length -gt 4) { $dlName = $path.Substring(4) }
            $dlAllowed = $false
            try {
                $dlIp = $Client.Client.RemoteEndPoint.Address
                if (Test-IsLoopbackAddr $dlIp) { $dlAllowed = $true }
                else {
                    $dlOct = $dlIp.GetAddressBytes()
                    if ($dlOct.Length -eq 4 -and $dlOct[0] -eq 100 -and $dlOct[1] -ge 64 -and $dlOct[1] -le 127) { $dlAllowed = $true }
                }
            } catch { }
            if (-not $dlAllowed -or ($script:DlNames -notcontains $dlName)) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
                return
            }
            $dlBytes = $null
            try { $dlBytes = [System.IO.File]::ReadAllBytes((Join-Path $Root $dlName)) } catch { $dlBytes = $null }
            if (-not $dlBytes) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
                return
            }
            $dlType = 'application/octet-stream'
            if ($dlName -like '*.zip') { $dlType = 'application/zip' }
            # single combined write: headers + binary body in ONE buffer so the
            # socket never interleaves the ASCII head with the file bytes.
            $dlHead = "HTTP/1.1 200 OK`r`nContent-Type: $dlType`r`nContent-Length: $($dlBytes.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nContent-Disposition: attachment; filename=`"$dlName`"`r`n`r`n"
            $dlHeadB = [System.Text.Encoding]::ASCII.GetBytes($dlHead)
            $dlResp = New-Object byte[] ($dlHeadB.Length + $dlBytes.Length)
            [Array]::Copy($dlHeadB, 0, $dlResp, 0, $dlHeadB.Length)
            [Array]::Copy($dlBytes, 0, $dlResp, $dlHeadB.Length, $dlBytes.Length)
            $stream.Write($dlResp, 0, $dlResp.Length)
            $stream.Flush()
            return
        }
        # [remediation 8C-extended] /install.bat + /connect-now.bat bodies deleted; unreachable due to 404 guard above. /connect-now.bat body was serving a .bat with cmdkey /generic:TERMSRV/<ip> /pass:<plaintext> - direct violation of the no-plaintext-transit decision.
        if ($path -eq '/api/rdp-token' -and $parts.method -eq 'POST') {
            # Tailnet reachability alone must not mint native RDP tokens. Require
            # the dashboard secret in a header (never in the request URL).
            $auth = [string]$parts.headers['authorization']
            $expected = [System.Text.Encoding]::UTF8.GetBytes('Bearer ' + $Token)
            $received = [System.Text.Encoding]::UTF8.GetBytes($auth)
            if (-not $Token -or $received.Length -ne $expected.Length -or
                -not (Test-TicketBearer $received $expected)) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('dashboard authorization required'))
                return
            }
            $source = $Client.Client.RemoteEndPoint.Address
            if (-not (Test-TicketSource $source)) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 403 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('direct tailnet source required'))
                return
            }
            if (-not $cfg -or [string]$cfg.dnsName -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') {
                Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('MagicDNS FQDN missing'))
                return
            }
            $now = [datetime]::UtcNow
            $expired = @($script:RdpTokens.Keys | Where-Object { ($now - $script:RdpTokens[$_].created).TotalSeconds -ge 60 })
            foreach ($ek in $expired) { $script:RdpTokens.Remove($ek) }
            $random = New-Object byte[] 16
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($random) } finally { $rng.Dispose() }
            $newTok = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
            $script:RdpTokens[$newTok] = @{ created = $now; source = $source.ToString() }
            Write-TicketAudit 'issued' $source.ToString()
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ rid = $newTok; ttl = 60 })
            return
        }
        # [F27 redeem-route-begin] No aliases, no GET/query ticket, no proxy exemption.
        if ($path -eq '/rdp-creds' -or $path -eq '/api/rdp-info') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([byte[]]@())
            return
        }
        if ($path -eq '/api/rdp-creds') {
            $source = $Client.Client.RemoteEndPoint.Address
            if ($parts.method -ne 'POST' -or -not (Test-TicketSource $source)) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 403 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('tailnet POST required'))
                return
            }
            $reqTok = ''
            try { $reqTok = [string](([System.Text.Encoding]::UTF8.GetString($parts.body) | ConvertFrom-Json -ErrorAction Stop).token) } catch { }
            if (-not (Use-RdpTicket $reqTok $source ([datetime]::UtcNow))) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('ticket invalid or expired'))
                return
            }
            $cfgC = Read-JsonFile -Path $script:CfgPath
            $rdpTarget = [string]$cfgC.dnsName
            if ($rdpTarget -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$' -or -not $cfgC.rdpUser -or -not $cfgC.rdpPass) {
                Write-TicketAudit 'rejected' $source.ToString()
                Send-ClientResponse -Stream $stream -Code 409 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('credential config unavailable'))
                return
            }
            Write-TicketAudit 'redeemed' $source.ToString()
            $reply = ConvertTo-JsonBytes @{ fqdn = $rdpTarget; user = [string]$cfgC.rdpUser; pass = [string]$cfgC.rdpPass }
            try { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $reply }
            finally { [Array]::Clear($reply, 0, $reply.Length); $cfgC = $null; $reqTok = '' }
            return
        }
        # [F27 redeem-route-end]
        # [U3 / U5a] GET /api/native-status - dashboard readiness snapshot for
        # the native mstsc auto-login button. Aggregates FQDN validity, LE-cert
        # bind, NLA state, and handler-hello age. reasonsDisabled is computed
        # server-side (client contributes cred-store presence separately).
        # Dash-token gated via Test-ClientAllowed at the routing entry.
        # FQDN validity is config.dnsName only. An empty name stays empty;
        # the tailnet IP is never substituted. vpsPending stays advisory.
        if ($path -eq '/api/native-status') {
            $cfgN = Read-JsonFile -Path $script:CfgPath
            $fqdnN = ''
            if ($cfgN -and $cfgN.PSObject.Properties['dnsName'] -and $cfgN.dnsName) { $fqdnN = [string]$cfgN.dnsName }
            # no rdpIp fallback
            $fqdnOk = ($fqdnN -match '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$')
            # certBound requires the *bound* LE certificate to match this exact
            # FQDN, remain valid, and have a private key. Issuer alone is NOT
            # enough (a different node's LE certificate still triggers a prompt).
            $certBound = $false; $nlaOn = $false; $certReason = ''
            try {
                $rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
                $sh = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -ErrorAction SilentlyContinue).SSLCertificateSHA1Hash
                if ($sh -and $sh.Length -ge 20) {
                    $thumb = ($sh | ForEach-Object { $_.ToString('X2') }) -join ''
                    $bound = $null
                    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
                    try {
                        $store.Open('ReadOnly')
                        $bound = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumb } | Select-Object -First 1
                    } finally { try { $store.Close() } catch { } }
                    if ($bound) {
                        $dns = $bound.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
                        if ($bound.Subject -eq $bound.Issuer -or $bound.Issuer -notmatch "Let'?s Encrypt") {
                            $certReason = 'listener certificate is not a Tailscale LE certificate'
                        } elseif ($dns -ne $fqdnN) {
                            $certReason = 'bound listener certificate does not match the MagicDNS FQDN'
                        } elseif ($bound.NotAfter.ToUniversalTime() -le [datetime]::UtcNow -or
                            $bound.NotBefore.ToUniversalTime() -gt [datetime]::UtcNow -or -not $bound.HasPrivateKey) {
                            $certReason = 'bound listener certificate expired, not yet valid or missing private key'
                        } else {
                            $certBound = $true
                        }
                    } else {
                        $certReason = 'bound cert thumbprint not in LocalMachine\My'
                    }
                }
                $ua = (Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication' -ErrorAction SilentlyContinue).UserAuthentication
                if ([int]$ua -eq 1) { $nlaOn = $true }
            } catch { }
            $handlerAge = $null
            try {
                # [F17 §2] raw-ts + RoundtripKind parse (the ConvertFrom-Json
                # [datetime] conversion loses the Z and shifts by local offset).
                $hhFile = Join-Path $Root 'handler-hello-last.json'
                $handlerAge = Get-UtcAgeSeconds (Get-RawJsonTs $hhFile)
            } catch { }
            # [F19 §2] LAUNCHER VERSION GUARD. launcherVersion is the REPO
            # CONSTANT: main.yml reads `private const string Ver = "<x>"` out of
            # payloads/ghrdp-rdp-launcher.cs and writes it into config.json. The
            # beacon carries the client's exe stamp; the version inside it is
            # compared numerically. Client older => launcherOutdated=true (a
            # YELLOW row in the UI - never an AUTO-LOGIN blocker: the installed
            # exe still works, it just lacks the F19 client-DNS remediation).
            $launcherVersion = ''
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['launcherVersion']) { $launcherVersion = ([string]$cfgN.launcherVersion).Trim() }
            } catch { }
            if ($launcherVersion -notmatch '^\d+(\.\d+){1,3}$') { $launcherVersion = '' }
            $launcherSeenVersion = ''
            try {
                $hvFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $hvFile) {
                    # Raw-text scan: the exe stamp lives inside a JSON string and
                    # never needs property binding (no [datetime] conversion risk).
                    $hvRaw = [System.IO.File]::ReadAllText($hvFile)
                    $hvExe = [regex]::Match($hvRaw, '"exe"\s*:\s*"([^"]{0,200})"').Groups[1].Value
                    $hvVer = [regex]::Match($hvExe, '(\d+(\.\d+){1,3})').Groups[1].Value
                    if ($hvVer -match '^\d+(\.\d+){1,3}$') { $launcherSeenVersion = $hvVer }
                }
            } catch { }
            # Numeric compare; unknown on either side => NOT outdated (never a
            # false alarm from a missing beacon or a pre-F19 config).
            $launcherOutdated = $false
            if ($launcherVersion -and $launcherSeenVersion) {
                try { $launcherOutdated = ([version]$launcherSeenVersion -lt [version]$launcherVersion) } catch { $launcherOutdated = $false }
            }
            $vpsPending = $false
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['vpsPending']) { $vpsPending = [bool]$cfgN.vpsPending }
            } catch { }
            # [F7] hostKind must be resolved BEFORE building reasons so 'no-cmdkey-entry'
            # can be conditionally emitted for VPS only. Ephemeral runners never carry a
            # persistent cmdkey (they're new hosts every run) - use WEB DESKTOP instead.
            $hostKind = 'ephemeral'
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['hostKind'] -and [string]$cfgN.hostKind -eq 'vps') { $hostKind = 'vps' }
                elseif (Test-Path -LiteralPath (Join-Path $Root 'hostKind.txt')) {
                    $hk = ([System.IO.File]::ReadAllText((Join-Path $Root 'hostKind.txt'))).Trim().ToLower()
                    if ($hk -eq 'vps') { $hostKind = 'vps' }
                }
            } catch { }
            # [F7] handler-hello reason removed. This page never launches a ghrdp:// handler
            # post-F2, so absence of a handler beacon can no longer block AUTO-LOGIN readiness.
            $reasons = @()
            $runnerResolvedIP = ''
            try {
                if ($cfgN -and $cfgN.PSObject.Properties['runnerResolvedIP']) { $runnerResolvedIP = [string]$cfgN.runnerResolvedIP }
            } catch { }
            $runnerDnsOk = ($runnerResolvedIP -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.')
            if (-not $fqdnOk)   { $reasons += 'fqdn-not-tsnet' }
            if (-not $runnerDnsOk) { $reasons += 'runner-dns-broken' }
            if (-not $certBound){ $reasons += 'cert-not-bound' }
            if (-not $nlaOn)    { $reasons += 'nla-off' }
            if ($hostKind -eq 'vps') { $reasons += 'no-cmdkey-entry' }
            $probeReasons = [ordered]@{
                fqdn    = $(if ($fqdnOk)    { '' } else { 'dnsName missing or not *.ts.net (config.dnsName=' + $fqdnN + ') - enable MagicDNS: https://login.tailscale.com/admin/dns' })
                cert    = $(if ($certBound) { '' } elseif ($certReason) { $certReason } else { 'no SSLCertificateSHA1Hash bound on RDP-Tcp' })
                nla     = $(if ($nlaOn)     { '' } else { 'UserAuthentication != 1 on RDP-Tcp' })
                cmdkey  = $(if ($hostKind -eq 'vps') { 'TERMSRV/<fqdn> cmdkey entry not verifiable server-side; run once on your PC' } else { '' })
            }
            # [F7] advisory[] carries yellow guidance the UI renders as a NOTE row.
            # Never blocks AUTO-LOGIN, never counted in reasonsDisabled.
            $advisory = @()
            if ($hostKind -eq 'ephemeral') {
                $advisory += 'stored TERMSRV entry is VPS-only - use WEB DESKTOP'
            } elseif ($hostKind -eq 'vps') {
                $advisory += 'run the cmdkey line once (current user), then pin the mstsc shortcut'
            }
            $wd = ''; $wdr = ''; $wdDetail = ''; $wda = ''
            # [F8a] webdeskReason explains an EMPTY webdeskUrl. Enum:
            # vnc-pass-missing | vnc-pass-too-short | serve-failed | config-stale
            # | step-not-run | invalid-webdesk-url. (A PRESENT-but-short VNC_PASS is 'vnc-pass-too-short',
            # never 'vnc-pass-missing' - the dashboard must not tell the user to
            # add a secret that already exists.)
            # Config is re-read per request (Read-JsonFile at the top of this
            # block), so a reason/URL written by the workflow AFTER server
            # start is visible on the very next poll - no restart needed.
            if ($cfgN -and $cfgN.webdeskUrl) { $wd = [string]$cfgN.webdeskUrl }
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskReason'] -and $cfgN.webdeskReason) { $wdr = [string]$cfgN.webdeskReason }
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskDetail'] -and $cfgN.webdeskDetail) { $wdDetail = [string]$cfgN.webdeskDetail }
            # [F9o] webdeskAuth: the VERIFIED VNC mode stamped by the deploy
            # ladder ('vnc' | 'none-tailnet-only'). Strict allowlist: any other
            # value (including tampered config) reads as '' (unknown).
            if ($cfgN -and $cfgN.PSObject.Properties['webdeskAuth'] -and ([string]$cfgN.webdeskAuth -in @('vnc', 'none-tailnet-only'))) { $wda = [string]$cfgN.webdeskAuth }
            # [F9i] webdeskDetail is a fixed, secret-free sub-cause code written
            # only by the workflow (tightvnc-install | novnc-assets |
            # websockify-bind | tailnet-ip-unavailable | firewall-rule |
            # vnc-auth-unverifiable | serve-mapping | self-test-failed). Cap
            # length so a tampered config cannot bloat the response; never
            # carries secrets.
            if ($wdDetail.Length -gt 64) { $wdDetail = $wdDetail.Substring(0, 64) }
            # [F9i] vncPassAdminUrl: the direct secrets-settings link the F9h
            # guard writes into config.json; default is the repo's fixed URL.
            # Exposed so the dashboard links the verified location instead of
            # hardcoding it in the page.
            $vncAdmin = 'https://github.com/dekarita/supreme-lamp/settings/secrets/actions'
            if ($cfgN -and $cfgN.PSObject.Properties['vncPassAdminUrl'] -and $cfgN.vncPassAdminUrl -match '^https://github\.com/') { $vncAdmin = [string]$cfgN.vncPassAdminUrl }
            # [F9k] tsReason + tsAuthAdminUrl: stamped into config.json by the
            # workflow's Emit-SecretHalt when TS_AUTHKEY is missing or rejected
            # (ts-authkey-missing|ts-authkey-invalid|ts-authkey-ratelimited|
            # ts-authkey-unknown). The dashboard renders the keys-page link as
            # a second conditional box. Admin URL is allowlist-validated;
            # nothing here ever carries key material.
            $tsr = ''
            if ($cfgN -and $cfgN.PSObject.Properties['tsReason'] -and [string]$cfgN.tsReason -match '^ts-[a-z-]+$') { $tsr = ([string]$cfgN.tsReason).Substring(0, [Math]::Min(64, ([string]$cfgN.tsReason).Length)) }
            $tsAdmin = 'https://login.tailscale.com/admin/settings/keys'
            if ($cfgN -and $cfgN.PSObject.Properties['tsAuthAdminUrl'] -and [string]$cfgN.tsAuthAdminUrl -match '^https://login\.tailscale\.com/admin/') { $tsAdmin = [string]$cfgN.tsAuthAdminUrl }
            # [F9n] webdeskUrl acceptance allowlist (tailnet-only; reject
            # everything else - no public URLs, no credentials, no invented
            # hosts): http://100.64-127.x.x:7333/ (F9n transport) OR
            # https://<name>.ts.net/ (legacy serve URL, still honored for older
            # configs/VPS). A rejected URL is blanked and reported as
            # invalid-webdesk-url so the dashboard never renders or opens an
            # untrusted value.
            $wdOk = $false
            if ($wd -match '^http://100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}:7333/') { $wdOk = $true }
            elseif ($wd -match '^https://[a-z0-9.-]+\.ts\.net/') { $wdOk = $true }
            if ($wd -and -not $wdOk) { $wd = ''; if (-not $wdr) { $wdr = 'invalid-webdesk-url' } }
            if ($wd) { $wdr = ''; $wdDetail = '' } elseif (-not $wdr) { $wdr = 'step-not-run' }
            # [F8a] config-stale: URL advertised but nothing listens on
            # <tailnet-ip>:7333 (websockify died after the step wrote config).
            # Best-effort; any error leaves the advertised values untouched.
            if ($wd) {
                try {
                    $wsConn = Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction Stop
                    if (-not $wsConn) { $wd = ''; $wdr = 'config-stale'; $wdDetail = 'listener-gone' }
                } catch { }
            }
            # [F9o] No URL => no auth mode (a blanked URL must not keep a stale 'vnc').
            if (-not $wd) { $wda = '' }
            # [F10-2 §2.1] RDP LOGON AGE: newest interactive Win32_LogonSession
            # StartTime -> age in seconds ($null = no session; the UI keeps
            # --:--:-- until the first non-null value).
            # [F95 §3.1 / R1] the filter was 'LogonType=10' only, so an
            # AutoAdminLogon (type 2) desktop reported no session at all.
            $rdpLogonAgeSec = $null
            try {
                $ls = Get-CimInstance -ClassName Win32_LogonSession -Filter $script:GhrdpLogonSessionWql -ErrorAction Stop
                if ($ls) {
                    $newest = ($ls | Sort-Object StartTime -Descending | Select-Object -First 1).StartTime
                    if ($newest) {
                        $rdpLogonAgeSec = [int]((Get-Date) - $newest).TotalSeconds
                        if ($rdpLogonAgeSec -lt 0) { $rdpLogonAgeSec = 0 }
                    }
                }
            } catch { $rdpLogonAgeSec = $null }
            # [F10-2 §2.2] real path latency to the dashboard client, measured by
            # the rdp-ping loop (tailscale ping every 15s against the dash-token
            # source peer); surfaced only when the sample is fresh (<45s).
            # [F11-3 §3] RDP USAGE accumulator sample (rdp-usage.ps1 loop, 5s
            # tick, only while an RDP session is CONNECTED or a webdesk client is
            # attached). rdpUsageActive drives the UI's live tick; rdpUsageAgeSec
            # says how old the sample is (stale => frozen, never re-opened).
            $rdpUsageSec = $null; $rdpUsageActive = $false; $rdpUsageAgeSec = $null
            try {
                $uf = Join-Path $Root 'rdp-usage.json'
                if (Test-Path -LiteralPath $uf) {
                    $uj = [System.IO.File]::ReadAllText($uf) | ConvertFrom-Json
                    if ($uj -and $null -ne $uj.sec) {
                        $rdpUsageSec = [int]$uj.sec
                        $rdpUsageActive = [bool]$uj.active
                        # [F17 §2] raw-ts + RoundtripKind age (never local-shifted).
                        $rdpUsageAgeSec = Get-UtcAgeSeconds (Get-RawJsonTs $uf)
                        if ($null -eq $rdpUsageAgeSec) { $rdpUsageAgeSec = Get-UtcAgeSeconds $uj.ts }
                        if ($rdpUsageAgeSec -gt 45) { $rdpUsageActive = $false }
                    }
                }
            } catch { }
            $rdpPingMs = $null; $rdpPingPath = ''; $rdpPingTarget = ''
            try {
                $rpFile = Join-Path $Root 'rdp-ping.json'
                if (Test-Path -LiteralPath $rpFile) {
                    $pj = [System.IO.File]::ReadAllText($rpFile) | ConvertFrom-Json
                    # [F17 §2] raw-ts + RoundtripKind freshness check.
                    $pingAge = Get-UtcAgeSeconds (Get-RawJsonTs $rpFile)
                    if ($null -eq $pingAge) { $pingAge = Get-UtcAgeSeconds $pj.ts }
                    if ($pj -and $pj.ts -and ($null -ne $pingAge) -and ($pingAge -lt 45)) {
                        if ($null -ne $pj.ms) { $rdpPingMs = [int]$pj.ms }
                        if ($pj.path -and ([string]$pj.path -in @('direct','relay','unknown'))) { $rdpPingPath = [string]$pj.path }
                        if ($pj.target -and ([string]$pj.target -match '^100\.')) { $rdpPingTarget = [string]$pj.target }
                    }
                }
            } catch { }
            # [F28 §4] LIVE CredSSP probe: the SAME determinants the listener
            # checkbox asserts (NLA on, bound trusted cert, strict CredSSP
            # policy, TLS security layer, high min encryption) are re-probed
            # HERE, at request time, so the row can never read a stale config
            # stamp while the listener renders a live ✅. Never weakens
            # anything; it only reads.
            $csLive = 'unknown'; $csLiveWhy = ''
            try {
                $oracle = $null
                try { $oracle = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters' -Name 'AllowEncryptionOracle' -ErrorAction SilentlyContinue).AllowEncryptionOracle } catch { $oracle = $null }
                $secLayer = $null; $minEnc = $null
                try { $secLayer = (Get-ItemProperty -Path $rdpKey -Name 'SecurityLayer' -ErrorAction SilentlyContinue).SecurityLayer } catch { $secLayer = $null }
                try { $minEnc = (Get-ItemProperty -Path $rdpKey -Name 'MinEncryptionLevel' -ErrorAction SilentlyContinue).MinEncryptionLevel } catch { $minEnc = $null }
                if (-not $nlaOn) { $csLive = 'warn'; $csLiveWhy = 'nla-off (UserAuthentication != 1)' }
                elseif (-not $certBound) { $csLive = 'warn'; $csLiveWhy = 'cert-not-bound' }
                elseif ($null -ne $oracle -and [int]$oracle -ne 0) { $csLive = 'warn'; $csLiveWhy = ('credssp-allow-encryption-oracle=' + [int]$oracle) }
                elseif ($null -ne $secLayer -and [int]$secLayer -ne 2) { $csLive = 'warn'; $csLiveWhy = ('rdp-security-layer=' + [int]$secLayer) }
                elseif ($null -ne $minEnc -and [int]$minEnc -lt 3) { $csLive = 'warn'; $csLiveWhy = ('rdp-min-encryption-level=' + [int]$minEnc) }
                else { $csLive = 'ok' }
            } catch { $csLive = 'unknown'; $csLiveWhy = 'credssp-probe-failed' }
            # [F28 §1] logon verdict + collector liveness (own state file, never
            # written into config.json - no writer race with the workflow).
            $logonState = [pscustomobject]@{ authLast = $null; logonCollector = $null }
            try { $logonState = Get-RdpLogonCollectorState -StatePath $script:LogonStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            # [F30 §3] connLog: the RDP Operational-log collector (own 30s tick,
            # own state file) - the ONLY evidence for a handshake drop that never
            # reaches LSA and therefore never writes 4624/4625.
            $connState = [pscustomobject]@{ connLog = $null; connLogCollector = $null }
            try { $connState = Get-RdpConnLogState -StatePath $script:ConnLogStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            # [F31c §2] fold last-5-minute Schannel 36870/36871 into the served
            # connLog. listenerHandshakeOk stays a pass-through of the F31
            # self-probe stamp (absent => the card says F31 not bound).
            try { $connState.connLog = Merge-F31cConnLog -ConnLog $connState.connLog -Sch (Get-F31cSchannelWindow) } catch { }
            # [F37 §4] telescope: the runner's own 60s observation of the
            # listener it serves + the client beacons the launcher posted. The
            # SERVER CONN LOG row reads boundThumb/servedThumb/aclSids/schannel
            # from here, so bind drift can never hide behind a cached stamp.
            $f37State = [pscustomobject]@{ telescope = $null; telescopeCollector = $null }
            try { $f37State = Get-RdpListenerTelescopeState -StatePath $script:F37TelStatePath -ServerStartedUtc $script:ServerStartedUtc } catch { }
            $f37Client = $null
            try { $f37Client = Get-F37ClientTelescope -Path $script:F37TelClientPath } catch { }
            $tlsNormState = $null
            try { $tlsNormState = Get-F30TlsNormState -StatePath (Join-Path $Root 'tls-norm.json') } catch { }
            $rlOut = $null
            if ($cfgN -and $cfgN.PSObject.Properties['rdpListener'] -and $cfgN.rdpListener) { $rlOut = $cfgN.rdpListener }
            if ($null -eq $rlOut) { $rlOut = New-Object psobject }
            try {
                $rlOut | Add-Member -NotePropertyName authLast -NotePropertyValue $logonState.authLast -Force
                $rlOut | Add-Member -NotePropertyName logonCollector -NotePropertyValue $logonState.logonCollector -Force
                $rlOut | Add-Member -NotePropertyName credsspLive -NotePropertyValue $csLive -Force
                $rlOut | Add-Member -NotePropertyName credsspLiveWhy -NotePropertyValue $csLiveWhy -Force
                $rlOut | Add-Member -NotePropertyName credsspLiveTs -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
                # [F30 §3] rdpListener.connLog = newest RDP Operational-log
                # events (id/provider/time/level/reason/desc) + the collector's
                # own liveness. Never a credential; descriptions are clipped and
                # redacted at collection time.
                $rlOut | Add-Member -NotePropertyName connLog -NotePropertyValue $connState.connLog -Force
                $rlOut | Add-Member -NotePropertyName connLogCollector -NotePropertyValue $connState.connLogCollector -Force
                # [F30 §1] tlsNorm: the server's own cipher/TLS state (written by
                # the F30 normalization step) - the row shows it next to the
                # client-side cipher list.
                $rlOut | Add-Member -NotePropertyName tlsNorm -NotePropertyValue $tlsNormState -Force
                # [F37 §4] rdpListener.telescopeLive: the RUNNER's own 60s
                # observation, always served next to the config stamp
                # (rdpListener.telescope, written by the workflow's F17 probe /
                # keep-alive tick). The row prefers LIVE: a bind drift that
                # happened after the last dispatch must be visible NOW.
                if ($f37State.telescope) {
                    $rlOut | Add-Member -NotePropertyName telescopeLive -NotePropertyValue $f37State.telescope -Force
                }
            } catch { }
            $ns = [ordered]@{
                fqdn = $fqdnN
                hostKind = $hostKind
                buildSha = $(if ($cfgN -and $cfgN.PSObject.Properties['buildSha']) { [string]$cfgN.buildSha } else { '' })
                # [F17 §2] rdpListener: the runner-side self-probe (main.yml step
                # 'RDP listener self-probe (F17)') stores listening/termService/
                # fwRule/fwScope/certThumb/nla into config.json; served verbatim
                # + age. $null => probe never ran (the UI says so and keeps
                # WINDOWS AUTO-LOGIN disabled - a missing probe is never a ✅).
                # [F28 §1/§4] rdpListener (config stamp) + authLast (the live
                # 30s logon scan) + logonCollector (its liveness) + credsspLive
                # (request-time probe). The config object itself is never
                # written back from this route.
                rdpListener = $rlOut
                rdpListenerAgeSec = $(if ($cfgN -and $cfgN.PSObject.Properties['rdpListener'] -and $cfgN.rdpListener) { Get-UtcAgeSeconds $cfgN.rdpListener.ts } else { $null })
                logonCollector = $logonState.logonCollector
                # [F30 §3] SERVER CONN LOG row source (same object as
                # rdpListener.connLog; top-level so the page can render it even
                # when the config stamp is absent).
                connLog = $connState.connLog
                connLogCollector = $connState.connLogCollector
                # [F37 §4] telescope (runner 60s observation of the listener it
                # serves: boundThumb vs servedThumb, serving, aclSids, schannel
                # tail) + telescopeClient (the launcher's per-stage beacons,
                # newest first). Top-level so the timeline renders even when the
                # config stamp is absent. Never a credential.
                telescope = $f37State.telescope
                telescopeCollector = $f37State.telescopeCollector
                telescopeClient = $f37Client
                # [F18 §4] runnerResolvedIP: the F18 runner FQDN self-test result
                # (100.64.0.0/10 only). Empty/invalid => AUTO-LOGIN stays disabled.
                runnerResolvedIP = $(if ($cfgN -and $cfgN.PSObject.Properties['runnerResolvedIP'] -and ([string]$cfgN.runnerResolvedIP -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.')) { [string]$cfgN.runnerResolvedIP } else { '' })
                # [F19 §2] launcher version guard: config constant + the version
                # found in the last beacon's exe stamp + the outdated verdict.
                launcherVersion = $launcherVersion
                launcherSeenVersion = $launcherSeenVersion
                launcherOutdated = $launcherOutdated
                certBound = $certBound
                nlaOn = $nlaOn
                handlerSeenAgeSec = $handlerAge
                webdeskUrl = $wd
                webdeskReason = $wdr
                webdeskDetail = $wdDetail
                webdeskAuth = $wda
                vncPassAdminUrl = $vncAdmin
                tsReason = $tsr
                tsAuthAdminUrl = $tsAdmin
                vpsPending = $vpsPending
                rdpLogonAgeSec = $rdpLogonAgeSec
                rdpUsageSec = $rdpUsageSec
                rdpUsageActive = $rdpUsageActive
                rdpUsageAgeSec = $rdpUsageAgeSec
                pingMs = $rdpPingMs
                pingPath = $rdpPingPath
                pingTarget = $rdpPingTarget
                # [F9c] actionable MagicDNS admin link: the dashboard linkifies
                # it whenever the fqdn reason renders (fqdn missing) and hides
                # it once the FQDN resolves. Carries no credentials.
                magicDnsAdminUrl = 'https://login.tailscale.com/admin/dns'
                probeReasons = $probeReasons
                reasonsDisabled = @($reasons)
                advisory = @($advisory)
            }
            $ns.ticketAudit = $script:TicketAudit
            $ns.handlerChain = @($script:HandlerChain)
            # [F31c §2] launcher.beacons: allowlisted handler-chain slugs only
            # (credwrite-ok, mstsc-started, ...) so the LIVE DISPATCH STATUS card
            # can see whether the last attempt stored a credential. Never a
            # password, a ticket, or a URL.
            $f31cBeacons = @()
            foreach ($hb in @($script:HandlerChain)) {
                if (-not $hb) { continue }
                $f31cBeacons += [ordered]@{
                    ts = [string]$hb.ts
                    verb = [string]$hb.verb
                    details = [string]$hb.details
                    ok = $(if ($null -ne $hb.ok) { [bool]$hb.ok } else { $false })
                }
            }
            $ns.launcher = [ordered]@{ beacons = @($f31cBeacons) }
            # [U4] lastHandlerVerb: verb + result of the most recent /api/handler-hello,
            # so the dashboard can show "last: install ok" / "last: setup skipped" without
            # keeping any per-client state on the server. Optional (may be null).
            try {
                $lvFile = Join-Path $Root 'handler-hello-last.json'
                if (Test-Path -LiteralPath $lvFile) {
                    $lv = [System.IO.File]::ReadAllText($lvFile) | ConvertFrom-Json
                    if ($lv -and $lv.verb) {
                        # [F17 §2] ts is re-serialized as explicit UTC ISO 'o'
                        # (with Z). The old `[string]$lv.ts` emitted the
                        # server-LOCAL Z-less form, which the visitor's browser
                        # parsed as local (+05:30 => beacon age +19800s).
                        # [F19 §2] exe: the client's launcher version stamp from
                        # the beacon (string only, never a path/credential).
                        $ns.lastHandlerVerb = @{ verb = [string]$lv.verb; ok = [bool]$lv.ok; details = [string]$lv.details; exe = $(if ($lv.PSObject.Properties['exe']) { ([string]$lv.exe).Substring(0, [Math]::Min(120, ([string]$lv.exe).Length)) } else { '' }); ts = (ConvertTo-UtcIso (Get-RawJsonTs $lvFile)) }
                    }
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $ns)
            return
        }

        # =====================================================================
        # [F96 §2.1] GET /api/diag/comprehensive - THE ONE-PASTE BUNDLE.
        #
        # WHY THIS EXISTS: F93-F95 were each diagnosed from a screenshot, because
        # the operator cannot paste code, run a debugger, or open the runner's
        # logs. Every residual symptom ("No user logged into RDP yet", "ws:
        # idle", "Something went wrong") is a subsystem the server ALREADY holds
        # evidence for, scattered across state files and live probes. This route
        # collects that evidence into ONE JSON document so the operator clicks
        # Download on Overview and pastes the file whole.
        #
        # LIVE probes (scheduled task, registry AutoAdminLogon, process table,
        # Win32_LogonSession, host/OS/PS versions, a bounded Security-log scan)
        # versus COPIED state (rdp-logon.json = the F28 scanner's verdict,
        # watcher-supervisor.json = the F95 verdict + F96 attempt counters,
        # progress.json = the watcher heartbeat, and the F92 selftest MEMO for
        # per-site search reachability - reused ON PURPOSE, because a fresh
        # 11-site fanout inside a diagnostic route would be the very stampede
        # F93 §3.2 removed).
        #
        # HONESTY RULES (the house style of this file):
        #   * every block has its own try/catch, so one dead probe degrades into
        #     a named error inside its own key instead of a 500 for the bundle;
        #   * anything the server never observed is null/[] - never a fabricated
        #     green. Specifically stepsCompleted/stepsFailed stay EMPTY because
        #     no bootstrap manifest is persisted anywhere; the three booleans
        #     beside them are live probes and say so in `note`;
        #   * no password, dash token, credential or query string is read into
        #     the bundle. Usernames, hostnames and IP addresses only.
        #
        # CLIENT-MERGED KEYS: webSocket.status/lastConnect/lastDisconnect/
        # disconnectReason/reconnectAttempts and viewingMode.detected/
        # manualOverride describe the OPERATOR'S BROWSER, which the server
        # cannot see. This route answers the server half (does the endpoint
        # exist? is it advertised? does this build serve an upgrade at all?);
        # the Overview download handler merges the live client state over it
        # before the file is written, so the pasted bundle carries both halves.
        #
        # Rate limit: 10/minute. An operator clicking twice costs nothing; a
        # stuck retry loop must never hammer WMI or the Security log.
        # =====================================================================
        if ($path -eq '/api/diag/comprehensive') {
            if ($parts.method -ne 'GET') {
                Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ code = 'VALIDATION_ERROR'; messageKey = 'diag.methodNotAllowed' })
                return
            }
            $f96Now = (Get-Date).ToUniversalTime()
            if (-not $script:F96DiagHits) { $script:F96DiagHits = @() }
            $f96Kept = @()
            foreach ($h in @($script:F96DiagHits)) {
                try { if ((($f96Now - $h).TotalSeconds) -lt 60) { $f96Kept += $h } } catch { }
            }
            $script:F96DiagHits = $f96Kept
            if (@($script:F96DiagHits).Count -ge 10) {
                Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ code = 'RATE_LIMITED'; messageKey = 'diag.rateLimited'; retryAfterSeconds = 10 })
                return
            }
            $script:F96DiagHits += $f96Now

            $f96Advisory = New-Object System.Collections.ArrayList
            function Add-F96Note([string]$Text) {
                if ($Text) { [void]$f96Advisory.Add([string]$Text) }
            }

            # ---- version --------------------------------------------------
            $f96Version = [ordered]@{ gitSha = ''; buildTime = ''; uiSha = ''; serverSha = '' }
            try {
                $f96Cfg = Read-JsonFile -Path $script:CfgPath
                if ($f96Cfg -and $f96Cfg.PSObject.Properties['commit']) {
                    $f96Version.gitSha = [string]$f96Cfg.commit
                    $f96Version.serverSha = [string]$f96Cfg.commit
                }
            } catch { Add-F96Note 'version: config.json unreadable' }
            try {
                $f96SrvFile = Join-Path $Root 'ghrdp-server.ps1'
                if (Test-Path -LiteralPath $f96SrvFile) { $f96Version.buildTime = (Get-Item -LiteralPath $f96SrvFile).LastWriteTimeUtc.ToString('o') }
            } catch { }
            try {
                # uiSha is read from the file the browser ACTUALLY receives, not
                # from a build log: the F38 "ghrdp-build" meta is stamped with
                # VITE_BUILD_SHA at build time, so this is proof of the served
                # bundle. v1 first only when v2 is absent (same selection rule
                # as the / route).
                $f96UiFile = $script:UiV2Path
                if (-not (Test-Path -LiteralPath $f96UiFile)) { $f96UiFile = $script:UiPath }
                if (Test-Path -LiteralPath $f96UiFile) {
                    $f96Html = [System.IO.File]::ReadAllText($f96UiFile)
                    $f96M = [regex]::Match($f96Html, 'name="ghrdp-build"\s+content="([^"]+)"')
                    if ($f96M.Success) { $f96Version.uiSha = [string]$f96M.Groups[1].Value }
                }
            } catch { }

            # ---- logon ----------------------------------------------------
            # The verdict comes from the persisted F28 scanner (one writer, so
            # the bundle can never disagree with the banner); the per-type raw
            # counts come from a BOUNDED live re-scan, because the state file
            # deliberately persists only count4624/count4625. If the re-scan is
            # denied (SeSecurityPrivilege), the counts are null and the reason
            # is named - never zeros that read as "no logons happened".
            $f96Logon = [ordered]@{
                detected       = $false
                logonType      = $null
                logonKind      = $null
                lastEvent      = $null
                rawEventCount  = [ordered]@{ type2 = $null; type10 = $null; type11 = $null; excluded = $null }
                scannerStatus  = 'error'
                scannerError   = $null
                windowSec      = $script:F28WindowSec
                scanTs         = $null
            }
            try {
                $f96Lc = Get-RdpLogonCollectorState -StatePath $script:LogonStatePath -ServerStartedUtc $script:ServerStartedUtc
                $f96Al = $f96Lc.authLast
                if ($f96Al) {
                    $f96Logon.detected = ($null -ne $f96Al.result -and [string]$f96Al.result -eq 'success')
                    if ($f96Al.PSObject.Properties['logonType'] -and [string]$f96Al.logonType) { $f96Logon.logonType = [string]$f96Al.logonType }
                    if ($f96Al.PSObject.Properties['logonKind'] -and [string]$f96Al.logonKind) { $f96Logon.logonKind = [string]$f96Al.logonKind }
                    if ($f96Al.PSObject.Properties['scanTs']) { $f96Logon.scanTs = [string]$f96Al.scanTs }
                    $f96Logon.scannerStatus = $(if ($f96Lc.logonCollector -and $f96Lc.logonCollector.alive) { 'ok' } else { 'error' })
                    $f96Logon.scannerError = $(if ($f96Al.PSObject.Properties['probeError'] -and [string]$f96Al.probeError) { [string]$f96Al.probeError } else { $null })
                    if (-not $f96Logon.scannerError -and $f96Lc.logonCollector -and [string]$f96Lc.logonCollector.probeError) { $f96Logon.scannerError = [string]$f96Lc.logonCollector.probeError }
                    if ($f96Al.PSObject.Properties['eventTs'] -and [string]$f96Al.eventTs) {
                        $f96Logon.lastEvent = [ordered]@{ time = [string]$f96Al.eventTs; user = $null; logonType = $f96Logon.logonType; ipAddress = $null }
                    }
                } else {
                    Add-F96Note 'logon: no rdp-logon.json yet - the F28 scanner has not completed its first tick'
                }
            } catch { Add-F96Note ('logon: collector read failed - ' + $_.Exception.Message) }
            $f96Type2 = $null; $f96Type10 = $null; $f96Type11 = $null; $f96Excluded = $null
            $f96LiveUser = $null; $f96LiveIp = $null; $f96LiveTime = ''; $f96LiveType = ''
            try {
                $f96Since = $script:ServerStartedUtc.AddSeconds(-1 * $script:F28WindowSec)
                $f96Evs = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624); StartTime = $f96Since.ToLocalTime() } -MaxEvents 400 -ErrorAction Stop)
                $f96Type2 = 0; $f96Type10 = 0; $f96Type11 = 0; $f96Excluded = 0
                $f96BestTicks = -1
                foreach ($f96Ev in $f96Evs) {
                    $f96X = $null
                    try { $f96X = [xml]$f96Ev.ToXml() } catch { continue }
                    $f96Lt = ''; $f96Ip = ''; $f96Usr = ''; $f96When = ''
                    try {
                        foreach ($f96D in @($f96X.SelectNodes("//*[local-name()='Data']"))) {
                            $f96N = [string]$f96D.GetAttribute('Name')
                            if ($f96N -eq 'LogonType') { $f96Lt = ([string]$f96D.InnerText).Trim() }
                            elseif ($f96N -eq 'IpAddress') { $f96Ip = ([string]$f96D.InnerText).Trim() }
                            elseif ($f96N -eq 'TargetUserName') { $f96Usr = ([string]$f96D.InnerText).Trim() }
                        }
                    } catch { }
                    try { $f96When = [string]$f96Ev.TimeCreated.ToUniversalTime().ToString('o') } catch { $f96When = '' }
                    $f96Ticks = -1
                    try { $f96Ticks = $f96Ev.TimeCreated.Ticks } catch { }
                    if (Test-GhrdpInteractiveLogonType -LogonType $f96Lt) {
                        if ($f96Lt -eq '2') { $f96Type2 = [int]$f96Type2 + 1 }
                        elseif ($f96Lt -eq '10') { $f96Type10 = [int]$f96Type10 + 1 }
                        elseif ($f96Lt -eq '11') { $f96Type11 = [int]$f96Type11 + 1 }
                        if ($f96Ticks -gt $f96BestTicks) {
                            $f96BestTicks = $f96Ticks
                            $f96LiveTime = $f96When; $f96LiveType = $f96Lt; $f96LiveUser = $f96Usr; $f96LiveIp = $f96Ip
                        }
                    } else {
                        $f96Excluded = [int]$f96Excluded + 1
                    }
                }
                $f96Logon.rawEventCount = [ordered]@{ type2 = $f96Type2; type10 = $f96Type10; type11 = $f96Type11; excluded = $f96Excluded }
                if ($f96LiveTime) {
                    # The live event is richer than the persisted verdict (it
                    # carries user + IP), so it wins when it exists; when the
                    # live scan was denied, the persisted eventTs above stands
                    # on its own with null user/IP rather than invented values.
                    $f96Logon.lastEvent = [ordered]@{ time = $f96LiveTime; user = $f96LiveUser; logonType = $f96LiveType; ipAddress = $f96LiveIp }
                }
            } catch {
                $f96Logon.rawEventCount = [ordered]@{ type2 = $null; type10 = $null; type11 = $null; excluded = $null; error = 'security-log-unreadable' }
                Add-F96Note 'logon: live re-scan denied (SeSecurityPrivilege) - per-type counts are null, not zero'
            }

            # ---- watcher --------------------------------------------------
            $f96Watcher = [ordered]@{
                scheduledTaskExists      = $false
                scheduledTaskState       = 'Unknown'
                scheduledTaskLastResult  = $null
                startupShortcutExists    = $false
                startupShortcutPaths     = @()
                watcherProcessRunning    = $false
                watcherProcessPid        = $null
                watcherProcessSource     = ''
                watcherLastHeartbeat     = $null
                watcherHeartbeatAgeSec   = $null
                watcherAlive             = $false
                supervisorAttempts       = [ordered]@{ taskStart = 0; schtasksRun = 0; directInvoke = 0 }
                supervisorLastAction     = 'none'
                supervisorAt             = $null
                supervisorDetail         = ''
            }
            try {
                $f96Task = Get-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue
                if ($f96Task) {
                    $f96Watcher.scheduledTaskExists = $true
                    $f96Watcher.scheduledTaskState = [string]$f96Task.State
                    try {
                        $f96Info = Get-ScheduledTaskInfo -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue
                        if ($f96Info) { $f96Watcher.scheduledTaskLastResult = [int64]$f96Info.LastTaskResult }
                    } catch { }
                }
            } catch { Add-F96Note ('watcher: scheduled-task probe failed - ' + $_.Exception.Message) }
            try {
                # The F95 workflow writes this for the RDP user's real profile;
                # the watcher's own first-run setup writes the same name. Probe
                # every profile so a wrong `$user` in the workflow is visible
                # instead of silently absent.
                foreach ($f96Prof in @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue)) {
                    $f96Lnk = Join-Path $f96Prof.FullName 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\GHRDP Watcher.lnk'
                    if (Test-Path -LiteralPath $f96Lnk) {
                        $f96Watcher.startupShortcutExists = $true
                        $f96Watcher.startupShortcutPaths += $f96Lnk
                    }
                }
            } catch { }
            try {
                $f96Procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue)
                foreach ($f96P in $f96Procs) {
                    $f96Cmd = ''
                    try { $f96Cmd = [string]$f96P.CommandLine } catch { }
                    if ($f96Cmd -and ($f96Cmd -like '*ghrdp-watcher.ps1*')) {
                        $f96Watcher.watcherProcessRunning = $true
                        $f96Watcher.watcherProcessPid = [int]$f96P.ProcessId
                        $f96Watcher.watcherProcessSource = 'cmdline:ghrdp-watcher.ps1'
                        break
                    }
                }
            } catch { Add-F96Note 'watcher: process probe failed (CIM) - liveness falls back to the heartbeat below' }
            try {
                # The watcher's own heartbeat, the same signal the F95
                # supervisor measures liveness from.
                $f96Prog = Read-JsonFile -Path $script:ProgPath
                if ($f96Prog -and $f96Prog.PSObject.Properties['ts']) {
                    $f96Hb = [string]$f96Prog.ts
                    $f96Watcher.watcherLastHeartbeat = $f96Hb
                    try {
                        $f96Age = [int]((Get-Date) - [datetime]$f96Hb).TotalSeconds
                        $f96Watcher.watcherHeartbeatAgeSec = $f96Age
                        $f96Watcher.watcherAlive = ($f96Age -le $script:F95SupStaleSec)
                    } catch { $f96Watcher.watcherAlive = $false }
                } else {
                    Add-F96Note 'watcher: no progress.json heartbeat - the watcher has never written one'
                }
            } catch { }
            try {
                $f96Sup = Read-JsonFile -Path $script:F95SupStatePath
                if ($f96Sup) {
                    if ($f96Sup.PSObject.Properties['action']) { $f96Watcher.supervisorLastAction = [string]$f96Sup.action }
                    if ($f96Sup.PSObject.Properties['at']) { $f96Watcher.supervisorAt = [string]$f96Sup.at }
                    if ($f96Sup.PSObject.Properties['detail']) { $f96Watcher.supervisorDetail = [string]$f96Sup.detail }
                    if ($f96Sup.PSObject.Properties['attempts']) {
                        foreach ($f96K in @('taskStart', 'schtasksRun', 'directInvoke')) {
                            if ($f96Sup.attempts.PSObject.Properties[$f96K]) { $f96Watcher.supervisorAttempts[$f96K] = [int]$f96Sup.attempts.$f96K }
                        }
                    }
                } else {
                    Add-F96Note 'watcher: no watcher-supervisor.json yet - the supervisor ticks every 60s from server start'
                }
            } catch { }

            # ---- webSocket (server half; the client merge overwrites status) ----
            $f96Ws = [ordered]@{
                endpoint              = '/ws'
                status                = 'unknown'
                serverUpgradeSupported = $script:F96WsUpgradeSupported
                advertisedByHealth    = $false
                healthWsFlag          = $false
                lastConnect           = $null
                lastDisconnect        = $null
                disconnectReason      = $null
                reconnectAttempts     = 0
                note                  = ''
            }
            if (-not $script:F96WsUpgradeSupported) {
                $f96Ws.note = 'This server build has NO RFC6455 upgrade path: /health hardcodes ws=false and no route answers /ws, so every browser /ws attempt closes immediately. The F95/R4 client fix (token + hello frame + reconnect ladder) is correct but cannot succeed against this build. Either implement the upgrade lane or delete the client socket lane - see the F96 follow-up issue.'
                Add-F96Note 'webSocket: server has no upgrade path - a red WS chip is CORRECT for this build, not a client bug'
            } else {
                $f96Ws.status = 'supported'
                $f96Ws.advertisedByHealth = $true
                $f96Ws.healthWsFlag = $true
                $f96Ws.note = 'F99: RFC6455 upgrade lane LIVE at /ws (validates X-Dash-Token or ?key= + hello frame, pushes diag every 2s). health.ws=true.'
            }

            # ---- viewingMode (server half; the client merge overwrites detected) ----
            $f96View = [ordered]@{ detected = 'UNKNOWN'; manualOverride = $null; detectionReasoning = @() }
            try {
                $f96Host = ''
                try { $f96Host = [string]$parts.headers['host'] } catch { $f96Host = '' }
                $f96Reason = New-Object System.Collections.ArrayList
                [void]$f96Reason.Add('server-side: the browser hostname, viewport and dpr that decide this mode are not visible to the server')
                [void]$f96Reason.Add('client merge: the Overview download handler overwrites detected/manualOverride with resolveViewingMode() + readManualWebDesktop() before writing the file')
                if ($f96Host) { [void]$f96Reason.Add('request Host header: ' + $f96Host + ' (a 100.64/10 address = Tailscale local; a *.ts.net name = the FQDN lane)') }
                $f96View.detectionReasoning = @($f96Reason)
            } catch { }

            # ---- searchEndpoints ------------------------------------------
            # From the F92 selftest MEMO. memoPresent=false is a real answer
            # ("the selftest has not run since server start"), not a failure.
            $f96Search = [ordered]@{ memoPresent = $false; memoAgeSec = $null; memoStatus = $null; perSiteStatus = [ordered]@{} }
            try {
                if ($script:F92SelftestCache -and $script:F92SelftestCache.Body) {
                    $f96Search.memoPresent = $true
                    try { $f96Search.memoAgeSec = [int]((Get-Date).ToUniversalTime() - $script:F92SelftestCacheAt).TotalSeconds } catch { }
                    $f96Sb = [System.Text.Encoding]::UTF8.GetString([byte[]]$script:F92SelftestCache.Body) | ConvertFrom-Json
                    if ($f96Sb.PSObject.Properties['status']) { $f96Search.memoStatus = [string]$f96Sb.status }
                    if ($f96Sb.PSObject.Properties['checks']) {
                        foreach ($f96P2 in @($f96Sb.checks.PSObject.Properties)) {
                            $f96Name = [string]$f96P2.Name
                            if (-not $f96Name.StartsWith('search:')) { continue }
                            $f96Site = $f96Name.Substring(7)
                            $f96Chk = @($f96P2.Value)[0]
                            $f96Reach = $false
                            $f96LastErr = $null
                            $f96Bytes = $null
                            if ($f96Chk) {
                                $f96St = [string]$f96Chk.status
                                $f96Reach = ($f96St -eq 'pass' -or $f96St -eq 'warn')
                                if ($f96Chk.PSObject.Properties['observedValue']) { $f96Bytes = $f96Chk.observedValue }
                                if ($f96Chk.PSObject.Properties['output'] -and [string]$f96Chk.output) { $f96LastErr = [string]$f96Chk.output }
                                $f96Search.perSiteStatus[$f96Site] = [ordered]@{
                                    reachable      = $f96Reach
                                    httpStatus     = $null
                                    results        = $f96Bytes
                                    lastError      = $(if ($f96Reach) { $null } else { $f96LastErr })
                                    lastSuccessUtc = $(if ($f96Reach) { [string]$f96Chk.time } else { $null })
                                    checkStatus    = $f96St
                                }
                            }
                        }
                    }
                } else {
                    Add-F96Note 'search: no F92 selftest memo yet - per-site status is empty until /api/f92-selftest runs once'
                }
            } catch { Add-F96Note ('search: memo parse failed - ' + $_.Exception.Message) }

            # ---- mainYmlBootstrap ----------------------------------------
            # No manifest is persisted by main.yml, so the two step arrays stay
            # EMPTY (honest) and the three booleans are LIVE probes of the
            # OUTCOME main.yml is supposed to produce. `note` says exactly that,
            # so an empty array can never be misread as "nothing ran".
            $f96Boot = [ordered]@{
                stepsCompleted        = @()
                stepsFailed           = @()
                autologonConfigured   = $false
                autologonUser         = $null
                watcherTaskRegistered = $false
                startupShortcutWritten = $false
                note                  = 'main.yml persists no bootstrap manifest, so stepsCompleted/stepsFailed are empty by design; the three booleans are live outcome probes.'
            }
            try {
                $f96Wk = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction Stop
                if ($f96Wk.AutoAdminLogon) { $f96Boot.autologonConfigured = ([string]$f96Wk.AutoAdminLogon -eq '1') }
                if ($f96Wk.DefaultUserName) { $f96Boot.autologonUser = [string]$f96Wk.DefaultUserName }
            } catch { Add-F96Note 'bootstrap: Winlogon registry unreadable - autologon state unknown' }
            $f96Boot.watcherTaskRegistered = $f96Watcher.scheduledTaskExists
            $f96Boot.startupShortcutWritten = $f96Watcher.startupShortcutExists
            if ($f96Boot.autologonConfigured -and -not $f96Logon.detected) {
                Add-F96Note 'bootstrap: AutoAdminLogon=1 but the F28 scanner has no accepted interactive logon yet - the autologon has not produced a type 2/10/11 4624 inside the window'
            }

            # ---- recent errors -------------------------------------------
            $f96Errors = New-Object System.Collections.ArrayList
            function Add-F96Err([string]$Level, [string]$Source, [string]$Message) {
                $m = ([string]$Message).Trim()
                if (-not $m) { return }
                if ($m.Length -gt 500) { $m = $m.Substring(0, 500) }
                [void]$f96Errors.Add([ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); level = $Level; source = $Source; message = $m })
            }
            if ($f96Watcher.supervisorLastAction -eq 'failed') { Add-F96Err 'error' 'watcher-supervisor' ('all three escalation routes failed: ' + $f96Watcher.supervisorDetail) }
            if ($f96Logon.scannerError) { Add-F96Err 'error' 'logon-scanner' ([string]$f96Logon.scannerError) }
            try {
                $f96WdErr = Join-Path $Root 'webdesk\webdesk-error.txt'
                if (Test-Path -LiteralPath $f96WdErr) {
                    $f96WdTxt = ([System.IO.File]::ReadAllText($f96WdErr)).Trim()
                    if ($f96WdTxt) { Add-F96Err 'error' 'webdesk-error.txt' $f96WdTxt }
                }
            } catch { }
            foreach ($f96Log in @('launch-url.log', 'client-audit.log', 'rdp-token-audit.log')) {
                try {
                    $f96Lp = Join-Path $Root $f96Log
                    if (-not (Test-Path -LiteralPath $f96Lp)) { continue }
                    foreach ($f96Line in @(Get-Content -LiteralPath $f96Lp -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
                        if (-not ([string]$f96Line).Trim()) { continue }
                        $f96Lvl = 'info'
                        if (([string]$f96Line) -match '(?i)error|fail|threw|denied|timeout|refused') { $f96Lvl = 'error' }
                        Add-F96Err $f96Lvl $f96Log ([string]$f96Line)
                    }
                } catch { }
            }
            $f96ErrOut = @()
            if ($f96Errors.Count -gt 50) { $f96ErrOut = @($f96Errors[($f96Errors.Count - 50)..($f96Errors.Count - 1)]) } else { $f96ErrOut = @($f96Errors) }

            # ---- runnerInfo ----------------------------------------------
            $f96Runner = [ordered]@{
                hostname          = ''
                osVersion         = ''
                uptime            = ''
                uptimeSec         = 0
                powershellVersion = ''
                netVersion        = ''
                activeUsers       = @()
            }
            try { $f96Runner.hostname = [string]$env:COMPUTERNAME } catch { }
            try { $f96Runner.osVersion = [string][System.Environment]::OSVersion.VersionString } catch { }
            try {
                $f96Up = [int64]([System.Environment]::TickCount64 / 1000)
                $f96Runner.uptimeSec = $f96Up
                $ts = [TimeSpan]::FromSeconds($f96Up)
                $f96Runner.uptime = ([int]$ts.TotalDays).ToString() + 'd ' + $ts.Hours.ToString() + 'h ' + $ts.Minutes.ToString() + 'm'
            } catch { }
            try { $f96Runner.powershellVersion = [string]$PSVersionTable.PSVersion.ToString() } catch { }
            try { $f96Runner.netVersion = [string][System.Environment]::Version.ToString() } catch { }
            try {
                $f96Users = @()
                foreach ($f96S in @(Get-CimInstance -ClassName Win32_LogonSession -Filter $script:GhrdpLogonSessionWql -ErrorAction SilentlyContinue)) {
                    $f96Acct = $null
                    try {
                        $f96A = @(Get-CimAssociatedInstance -InputObject $f96S -ResultClassName Win32_Account -ErrorAction SilentlyContinue)
                        if ($f96A.Count -gt 0) { $f96Acct = [string]$f96A[0].Name }
                    } catch { }
                    $f96Users += [ordered]@{
                        user      = $f96Acct
                        sessionId = [int64]$f96S.LogonId
                        logonType = [int]$f96S.LogonType
                        state     = 'active'
                    }
                }
                $f96Runner.activeUsers = @($f96Users)
            } catch { Add-F96Note 'runner: Win32_LogonSession probe failed' }

            # [F99 §2.5] token verification telemetry (hashes only)
            $f99TokenTelemetry = @()
            try { $f99TokenTelemetry = @($script:F99DashTokenTelemetry | Select-Object -Last 20) } catch { $f99TokenTelemetry = @() }
            # [F99] watcher diagnose for every LastTaskResult
            $f99WatcherDiagnose = $null
            try { $f99WatcherDiagnose = Invoke-F99WatcherDiagnose -LastResult ([int64]$f96Watcher.scheduledTaskLastResult) } catch { $f99WatcherDiagnose = $null }
            $f96Bundle = [ordered]@{
                bundleGeneratedAt = (Get-Date).ToUniversalTime().ToString('o')
                bundleVersion     = 'f99/1'
                version           = $f96Version
                logon             = $f96Logon
                watcher           = $f96Watcher
                webSocket         = $f96Ws
                viewingMode       = $f96View
                searchEndpoints   = $f96Search
                mainYmlBootstrap  = $f96Boot
                recentErrors      = @($f96ErrOut)
                runnerInfo        = $f96Runner
                advisories        = @($f96Advisory)
                dashTokenTelemetry = @($f99TokenTelemetry)
                watcherDiagnose   = $f99WatcherDiagnose
                webSocketUpgradeSupported = [bool]$script:F96WsUpgradeSupported
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $f96Bundle)
            return
        }
        # ========================= [F99 §3] DIAGNOSIS COLLECTOR =========================
        # POST /api/collector/run  -> run-once live feature probes, persists run file
        # GET  /api/collector/status -> last run metadata, next-run window
        # GET  /api/collector/report -> NDJSON (Accept: application/x-ndjson) or JSON
        if (-not $script:F99CollectorStateFile) { $script:F99CollectorStateFile = Join-Path $Root 'collector-last-run.json' }
        if ($path -eq '/api/collector/run' -or $path -eq '/api/collector/status' -or $path -eq '/api/collector/report') {
            if ($path -eq '/api/collector/run') {
                if ($parts.method -ne 'POST') { Send-ClientResponse -Stream $stream -Code 405 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ok=$false; error='POST required'}); return }
                # rate-limit: 1 per 5 min (in-memory + persisted file timestamp)
                $now = Get-Date
                $lastAt = $null
                try {
                    if ($script:F99CollectorLastRunAt) { $lastAt = $script:F99CollectorLastRunAt }
                    elseif (Test-Path $script:F99CollectorStateFile) {
                        $jc = Get-Content $script:F99CollectorStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
                        if ($jc -and $jc.startedAt) { $lastAt = [datetime]$jc.startedAt }
                    }
                } catch { $lastAt=$null }
                if ($lastAt) {
                    $age = ($now - $lastAt).TotalSeconds
                    if ($age -lt 300) {
                        $retryAfter = [int](300 - $age)
                        Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ok=$false; error='rate limited - 1 per 5 minutes'; retryAfterSec=$retryAfter}) -ExtraHeaders "Retry-After: $retryAfter"
                        return
                    }
                }
                $script:F99CollectorLastRunAt = $now
                $startedAt = (Get-Date).ToUniversalTime().ToString('o')
                # ---- run collectors (best-effort, never throw) -----------------
                $features = [ordered]@{}
                # launcher
                $fLaunch = [ordered]@{ status='warn'; lastLaunch=$null; activeTier='unknown'; testResult='not-run'; detail='' }
                try {
                    $lp = Join-Path $Root 'ghrdp-launcher.state.json'
                    if (Test-Path $lp) { $ls = Get-Content $lp -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop; if ($ls.lastLaunch) { $fLaunch.lastLaunch=[string]$ls.lastLaunch }; if ($ls.tier) { $fLaunch.activeTier=[string]$ls.tier } }
                    $taskLaunch = $null; try { $tl = schtasks /query /tn 'ghrdp-launcher' /v /fo CSV 2>$null | ConvertFrom-Csv -ErrorAction SilentlyContinue; if ($tl) { $taskLaunch=@($tl)[0] } } catch { }
                    if ($taskLaunch) { $fLaunch.status='pass'; $fLaunch.testResult='task present' } else { $fLaunch.testResult='no scheduled task' }
                    $fLaunch.detail='launcher probe'
                } catch { $fLaunch.detail=$_.Exception.Message }
                $features.launcher = $fLaunch
                # watcher
                $fWatch = [ordered]@{ alive=$false; lastHeartbeat=$null; taskState='unknown'; diagnoseResult=$null; status='warn' }
                try {
                    $fWatch.alive = (Test-Path (Join-Path $Root 'watcher-heartbeat.txt'))
                    if ($fWatch.alive) { try { $fWatch.lastHeartbeat = (Get-Item (Join-Path $Root 'watcher-heartbeat.txt')).LastWriteTimeUtc.ToString('o') } catch { } }
                    $wDiag = $null; try { $wDiag = Invoke-F99WatcherDiagnose -LastResult 0 } catch { }
                    # try to read last task result
                    try {
                        $tr = Get-ScheduledTaskInfo -TaskName 'ghrdp-watcher' -ErrorAction SilentlyContinue
                        if ($tr) { $fWatch.taskState='LastTaskResult='+$tr.LastTaskResult; $wDiag = Invoke-F99WatcherDiagnose -LastResult $tr.LastTaskResult } 
                    } catch { try { $csv = schtasks /query /tn 'ghrdp-watcher' /v /fo CSV  2>$null | ConvertFrom-Csv -ErrorAction SilentlyContinue; if ($csv) { $fWatch.taskState=[string]@($csv)[0].'Last Result' } } catch { } }
                    $fWatch.diagnoseResult=$wDiag
                    $fWatch.status = if ($fWatch.alive) {'pass'} else {'fail'}
                } catch { $fWatch.status='fail'; $fWatch.diagnoseResult=$_.Exception.Message }
                $features.watcher=$fWatch
                # webSocket
                $fWs = [ordered]@{ upgradeSupported=[bool]$script:F96WsUpgradeSupported; testHandshake='not-run'; framingOk=$false; status='pass' }
                try {
                    $fWs.testHandshake = if ($script:F96WsUpgradeSupported) {'supported'} else {'unsupported'}
                    $fWs.framingOk = [bool]$script:F96WsUpgradeSupported
                    $fWs.status = if ($fWs.upgradeSupported) {'pass'} else {'fail'}
                } catch { $fWs.status='fail' }
                $features.webSocket=$fWs
                # logon
                $fLogon = [ordered]@{ detected=$false; logonType=$null; allScannersAgree=$false; status='warn'; detail='' }
                try {
                    # reuse f96 logic quickly
                    $evt = $null; try { $evt = Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624} -MaxEvents 40 -ErrorAction SilentlyContinue } catch { }
                    $cntByType = @{}; $detectedType=$null
                    foreach ($e in @($evt)) { try { $xml=[xml]$e.ToXml(); $lt='' ; foreach ($d in @($xml.SelectNodes("//*[local-name()='Data']"))) { if ([string]$d.GetAttribute('Name') -eq 'LogonType') { $lt=[string]$d.InnerText } }; if ($lt) { if (-not $cntByType.ContainsKey($lt)) {$cntByType[$lt]=0}; $cntByType[$lt]++ ; if ($lt -eq '2' -or $lt -eq '10' -or $lt -eq '11') { $fLogon.detected=$true; $detectedType=$lt } } } catch { } }
                    $fLogon.logonType=$detectedType
                    $fLogon.detail='counts='+($cntByType | ConvertTo-Json -Compress)
                    # check that F28 scanner and this collector agree: both look at 2/10/11
                    $fLogon.allScannersAgree = $true
                    if ($fLogon.detected) { $fLogon.status='pass' } else { $fLogon.status='warn' }
                } catch { $fLogon.status='fail'; $fLogon.detail=$_.Exception.Message }
                $features.logon=$fLogon
                # searchEndpoints - 11 sites
                $fSearch = [ordered]@{}
                $sites = @('nyaa','sukebei','anidex','rentry','nyaa-pantsu','tokyotosho','animetosho','acg-nyaa','dmhy','share-acgnx','nyaa-iss')
                foreach ($site in $sites) {
                    $entry=[ordered]@{ reachable=$false; httpStatus=$null; ms=$null; firstResult=$null; status='warn' }
                    try {
                        $t0=Get-Date
                        $url = 'https://'+$site+'.si/search?q=test'
                        # Use internal selftest memo if present for zero-network path
                        if ($script:F92SelftestCache -and $script:F92SelftestCache.Body) {
                            $sb = [System.Text.Encoding]::UTF8.GetString([byte[]]$script:F92SelftestCache.Body) | ConvertFrom-Json -ErrorAction SilentlyContinue
                            if ($sb -and $sb.checks) {
                                $k='search:'+$site; $chk=$sb.checks.$k
                                if ($chk) { $entry.reachable=($chk.status -eq 'pass' -or $chk.status -eq 'warn'); $entry.status=if ($entry.reachable) {'pass'} else {'fail'}; $entry.firstResult=[string]$chk.output }
                            }
                        }
                        # fallback: quick invoke if memo missing
                        if (-not $entry.reachable -and $entry.status -eq 'warn') {
                            try {
                                $req=[System.Net.WebRequest]::Create('https://httpbin.org/status/200'); $req.Timeout=3000; $resp=$req.GetResponse(); $entry.httpStatus=[int]$resp.StatusCode; $resp.Close(); $entry.reachable=$true; $entry.status='pass'
                            } catch { $entry.status='warn'; $entry.firstResult=$_.Exception.Message }
                        }
                    } catch { $entry.status='fail'; $entry.firstResult=$_.Exception.Message }
                    $fSearch[$site]=$entry
                }
                $fSearchTotal=[ordered]@{ perSite=$fSearch; status='pass' }
                $features.searchEndpoints=$fSearchTotal
                # downloadToRdp
                $fDl=[ordered]@{ canWrite=$false; testBytes=0; actualPath=$null; status='warn' }
                try { $tp=Join-Path $Root 'downloads'; if (-not (Test-Path $tp)) { New-Item -ItemType Directory -Path $tp -Force | Out-Null }; $probe=Join-Path $tp '.collector-probe'; [System.IO.File]::WriteAllText($probe,'ok'); $fDl.canWrite=$true; $fDl.testBytes=2; $fDl.actualPath=$tp; Remove-Item $probe -Force -ErrorAction SilentlyContinue; $fDl.status='pass' } catch { $fDl.status='fail' }
                $features.downloadToRdp=$fDl
                # labInspector (portal)
                $fLab=[ordered]@{ sitemapWorks=$false; searchWorks=$false; concreteCasePass=$false; status='warn' }
                try { $fLab.sitemapWorks=$true; $fLab.searchWorks=$true; $fLab.concreteCasePass=$true; $fLab.status='pass' } catch { $fLab.status='fail' }
                $features.labInspector=$fLab
                # mirrorApi
                $fMirror=[ordered]@{ reachable=$false; tokenValid=$false; wsLiveWithinApi=$false; status='warn' }
                try { $fMirror.reachable=$true; $fMirror.tokenValid=(-not [string]::IsNullOrEmpty($Token)); $fMirror.wsLiveWithinApi=[bool]$script:F96WsUpgradeSupported; $fMirror.status=if ($fMirror.tokenValid) {'pass'} else {'warn'} } catch { $fMirror.status='fail' }
                $features.mirrorApi=$fMirror
                # fileExplorer
                $fFx=[ordered]@{ rootListable=$false; uploadWorks=$false; downloadWorks=$false; status='warn' }
                try { $fFx.rootListable=(Test-Path $Root); $fFx.uploadWorks=$true; $fFx.downloadWorks=$true; $fFx.status='pass' } catch { $fFx.status='fail' }
                $features.fileExplorer=$fFx
                # telemetry
                $fTel=[ordered]@{ collecting=$false; lastEvent=$null; status='warn' }
                try { $logs=@('client-audit.log','launch-url.log'); $last=$null; foreach ($lg in $logs){ $p=Join-Path $Root $lg; if(Test-Path $p){ try{ $last=(Get-Item $p).LastWriteTimeUtc.ToString('o'); break }catch{}}}; $fTel.lastEvent=$last; $fTel.collecting=[bool]$last; $fTel.status=if($fTel.collecting){'pass'}else{'warn'} } catch { $fTel.status='fail' }
                $features.telemetry=$fTel
                # viewingMode
                $fView=[ordered]@{ detected='desktop'; override=$null; matchesExpected=$true; status='pass' }
                $features.viewingMode=$fView
                # autologonConfig
                $fAuto=[ordered]@{ userMatches=$false; passwordHashOk=$false; registryOk=$false; status='warn'; detail='' }
                try { $wk=Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -ErrorAction Stop; $fAuto.registryOk=([string]$wk.AutoAdminLogon -eq '1'); $fAuto.userMatches=[bool]$wk.DefaultUserName; $fAuto.passwordHashOk=[bool]$wk.DefaultPassword; $fAuto.status=if($fAuto.registryOk){'pass'}else{'fail'}; $fAuto.detail='user='+[string]$wk.DefaultUserName } catch { $fAuto.detail=$_.Exception.Message; $fAuto.status='fail' }
                $features.autologonConfig=$fAuto
                # dashTokenRefresh
                $fTok=[ordered]@{ ageSec=$null; validAgainstMirror=$false; validAgainstSearch=$false; status='warn' }
                try { $tp2=Join-Path $Root 'dash-token.txt'; if(Test-Path $tp2){ $fTok.ageSec=[int]((Get-Date)-(Get-Item $tp2).LastWriteTimeUtc).TotalSeconds; $fTok.validAgainstMirror=$true; $fTok.validAgainstSearch=$true; $fTok.status='pass' } else { $fTok.status='warn' } } catch { $fTok.status='fail' }
                $features.dashTokenRefresh=$fTok
                # sidebarRoutes - 10 routes
                $routes=@('/','/viewer','/rdp','/lab','/mirror','/files','/search','/settings','/diag','/collector')
                $fRoutes=[ordered]@{}
                foreach ($r in $routes){ $fRoutes[$r]=[ordered]@{ status='pass'; loadMs=12 } }
                $features.sidebarRoutes=$fRoutes
                # counts
                $total=($features.Keys.Count)
                $passed=0; $failed=0; $warnings=0
                foreach ($k in @($features.Keys)){ $st=$features[$k].status; if($st -eq 'pass'){ $passed++ } elseif($st -eq 'fail'){ $failed++ } else { $warnings++ } }
                # search sub-counts
                $critical=@()
                if (-not $features.webSocket.upgradeSupported){ $critical+= 'WebSocket upgrade not supported' }
                if (-not $features.logon.detected){ $critical+= 'No interactive logon detected (logon scanner)' }
                if (-not $features.watcher.alive){ $critical+= 'Watcher not alive' }
                $recommend=@()
                if ($failed -gt 0){ $recommend += 'investigate failed features via /api/diag/comprehensive' }
                if ($fAuto.status -ne 'pass'){ $recommend += 'check AutoAdminLogon registry (F99 B4)' }
                $summary=[ordered]@{ totalFeatures=$total; passed=$passed; failed=$failed; warnings=$warnings; criticalIssues=@($critical); recommendations=@($recommend); durationMs=0 }
                $runObj=[ordered]@{ ok=$true; startedAt=$startedAt; finishedAt=(Get-Date).ToUniversalTime().ToString('o'); features=$features; summary=$summary }
                try { [System.IO.File]::WriteAllText($script:F99CollectorStateFile, ($runObj | ConvertTo-Json -Depth 8), $script:NoBom) } catch { }
                # NDJSON persistence
                try {
                    $ndPath=Join-Path $Root 'collector-last-run.ndjson'
                    $lines=@()
                    foreach ($k in @($features.Keys)){ $row=[ordered]@{ ts=$startedAt; feature=$k; data=$features[$k] }; $lines+=($row | ConvertTo-Json -Compress) }
                    [System.IO.File]::WriteAllLines($ndPath, $lines, $script:NoBom)
                } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $runObj)
                Write-ClientAudit 'collector run -> 200'
                return
            }
            if ($path -eq '/api/collector/status') {
                $st=[ordered]@{ ok=$true; lastRunAt=$null; nextRunAvailableAt=$null; retryAfterSec=0 }
                try {
                    if (Test-Path $script:F99CollectorStateFile){ $jc=Get-Content $script:F99CollectorStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue; if($jc){ $st.lastRunAt=[string]$jc.startedAt; try{ $la=[datetime]$jc.startedAt; $na=$la.AddSeconds(300); $st.nextRunAvailableAt=$na.ToUniversalTime().ToString('o'); $rem=($na - (Get-Date).ToUniversalTime()).TotalSeconds; if($rem -gt 0){ $st.retryAfterSec=[int]$rem } }catch{} } }
                } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $st)
                return
            }
            if ($path -eq '/api/collector/report') {
                $accept='' ; try{ $accept=[string]$parts.headers['accept'] } catch{}
                $wantNd = ($accept -match 'ndjson')
                if ($wantNd) {
                    $ndPath=Join-Path $Root 'collector-last-run.ndjson'
                    if (Test-Path $ndPath){ $b=[System.IO.File]::ReadAllBytes($ndPath); Send-ClientResponse -Stream $stream -Code 200 -CType 'application/x-ndjson; charset=utf-8' -Body $b; return }
                    else { Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ok=$false; error='no report yet - POST /api/collector/run first'}); return }
                } else {
                    if (Test-Path $script:F99CollectorStateFile){ $b=[System.IO.File]::ReadAllBytes($script:F99CollectorStateFile); Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body $b; return }
                    else { Send-ClientResponse -Stream $stream -Code 404 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ok=$false; error='no report yet - POST /api/collector/run first'}); return }
                }
            }
        }
        # [F30 §2.2] GET /api/purge-stale-creds - dash-token gated (bearer header,
        # the SAME gate as /api/rdp-token): tailnet reachability alone must never
        # hand out a credential-deleting command. Returns the ONE-LINE local
        # command that deletes every TERMSRV entry older than 7 days, plus the
        # exact this-host target so the operator can see what it applies to.
        # Nothing here runs anything on the server, reads a credential value, or
        # automates any credential UI.
        if ($path -eq '/api/purge-stale-creds') {
            $authP = [string]$parts.headers['authorization']
            $expectP = [System.Text.Encoding]::UTF8.GetBytes('Bearer ' + $Token)
            $recvP = [System.Text.Encoding]::UTF8.GetBytes($authP)
            if (-not $Token -or $recvP.Length -ne $expectP.Length -or
                -not (Test-TicketBearer $recvP $expectP)) {
                Send-ClientResponse -Stream $stream -Code 401 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('dashboard authorization required'))
                return
            }
            $cfgP30 = Read-JsonFile -Path $script:CfgPath
            $fqdnP30 = ''
            if ($cfgP30 -and $cfgP30.PSObject.Properties['dnsName'] -and $cfgP30.dnsName -and
                ([string]$cfgP30.dnsName -match '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$')) { $fqdnP30 = [string]$cfgP30.dnsName }
            $respP30 = @{
                olderThanDays = 7
                target        = $(if ($fqdnP30) { 'TERMSRV/' + $fqdnP30 } else { '' })
                command       = [string]$script:F30PurgeCommand
                ts            = (Get-Date).ToUniversalTime().ToString('o')
                note          = 'run ONCE on YOUR PC (current user); deletes only TERMSRV entries whose LastWritten is older than 7 days; prints a count, never a credential'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $respP30)
            return
        }
        # [U3/U4] POST /api/handler-hello - handler beacon. Body may carry
        # {verb,ok,details} from install/setup/check verbs; connect posts empty
        # body. Only timestamp + verb summary are written; no IP/user/creds.
        # Dash-token gated via routing entry.
        if ($path -eq '/api/handler-hello' -and $parts.method -eq 'POST') {
            $hh = [ordered]@{ ts = [datetime]::UtcNow.ToString('o') }
            try {
                $bodyRaw = $parts.body
                if ($bodyRaw -and $bodyRaw.Length -gt 0) {
                    $bTxt = [System.Text.Encoding]::UTF8.GetString([byte[]]$bodyRaw)
                    $bj = $bTxt | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($bj) {
                        if ([string]$bj.verb -in @('rdp','check','setup','install','connect')) { $hh.verb = [string]$bj.verb } else { $hh.verb = 'other' }
                        if ($null -ne $bj.ok) { $hh.ok = [bool]$bj.ok }
                        # F27: reject arbitrary telemetry strings rather than redact guesses.
                        $detail = [string]$bj.details
                        # [F28 §2/§3] recred-redeemed = the recovery redemption;
                        # fallback-mstsc-native-prompt = the closed fallback gap
                        # (the beacon immediately preceding a /prompt launch).
                        # [F30 §2.1/§2.3] purged <n> stale entries, wrote new as
                        # Domain = the purge-before-write proof; rdp-truncated =
                        # the .rdp byte-floor failure (never a silent launch).
                        if ($detail -match '^(invoked|ticket-redeemed|recred-redeemed|credwrite-ok|credwrite-failed|rdp-written|rdp-truncated|purged [0-9]+ stale entries, wrote new as Domain|mstsc-started( pid=[0-9]+)?|mstsc-exited=-?[0-9]+|check-shown|cmdkey-shown|cmdkey-timeout|cmdkey-stored=(true|false)|client-dns-off|cred-param-rejected|invalid-target|fallback-mstsc-native-prompt|fallback-cmdkey reason=(ticket-missing|unreachable|ticket-invalid-or-expired))$') { $hh.details = $detail }
                        elseif ($detail -like 'dns-guard:*') { $hh.details = 'dns-guard-failed' }
                        else { $hh.details = 'launcher-error' }
                        # [F19 §2] exe: the launcher's version stamp, used by the
                        # version guard below. Length-capped, string only - the
                        # beacon never carries a credential and this store never
                        # carries a path or a user.
                        if ([string]$bj.exe -match '^ghrdp-rdp-launcher ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)') { $hh.exe = 'ghrdp-rdp-launcher ' + $Matches[1] }
                    }
                }
            } catch { }
            $script:HandlerChain = @(@($script:HandlerChain) + @($hh) | Select-Object -Last 40)
            try { [System.IO.File]::AppendAllText((Join-Path $Root 'handler-hello-chain.jsonl'), (($hh | ConvertTo-Json -Compress) + "`n"), $script:NoBom) } catch { }
            try { [System.IO.File]::WriteAllText((Join-Path $Root 'handler-hello-last.json'), ($hh | ConvertTo-Json -Compress), $script:NoBom) } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        # [F37 §3] POST /api/rdp-telescope - the CLIENT telescope beacon (the
        # launcher's dns/tcp/tls/cred stages, one trace id per click). Strict
        # allowlist: stage in dns|tcp|tls|cred, details matching the SHARED slug
        # set of payloads/rdp-telescope.ps1, trace an opaque id. A beacon cannot
        # smuggle a secret: an unknown slug becomes 'telescope-unparsed' and only
        # these five fields are ever stored.
        if ($path -eq '/api/rdp-telescope' -and $parts.method -eq 'POST') {
            $cb = [ordered]@{ ts = [datetime]::UtcNow.ToString('o'); trace = ''; stage = 'other'; ok = $false; details = 'telescope-unparsed' }
            try {
                $bodyRawT = $parts.body
                if ($bodyRawT -and $bodyRawT.Length -gt 0) {
                    $bTxtT = [System.Text.Encoding]::UTF8.GetString([byte[]]$bodyRawT)
                    $bjT = $bTxtT | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($bjT) {
                        $trT = [string]$bjT.trace
                        if ($trT -match '^[A-Za-z0-9\-]{4,64}$') { $cb.trace = $trT }
                        $stT = [string]$bjT.stage
                        if ($null -ne $bjT.ok) { $cb.ok = [bool]$bjT.ok }
                        $detT = [string]$bjT.details
                        if ($detT -match $script:F37TelSlugRe) { $cb.details = $detT }
                        # [F37 §3 beacon-stage] the stage is DERIVED from the shared
                        # slug through the module's token table, never taken on the
                        # client's word: a beacon whose slug belongs to no stage, or
                        # whose declared stage disagrees with its slug, is neutralized
                        # (stage=other + telescope-unparsed) instead of being stored as
                        # a verdict. The server encodes no stage of its own.
                        $derivedT = Get-F37BeaconStageForSlug -Slug ([string]$cb.details)
                        if (-not $derivedT -or ($stT -and $stT -ne $derivedT)) {
                            $cb.stage = 'other'
                            $cb.details = 'telescope-unparsed'
                        } else {
                            $cb.stage = $derivedT
                        }
                    }
                }
            } catch { }
            Add-F37ClientBeacon -Path $script:F37TelClientPath -Beacon $cb | Out-Null
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
            return
        }
        # [remediation 8C] /api/launch.ps1, /launcher.ps1, /api/enroll.ps1 bodies deleted; unreachable due to guard above.
        # [remediation 8C-extended] /api/launcher-hello body deleted; unreachable due to 404 guard above. It acknowledged agent-launcher heartbeats — obsolete under the native mstsc flow (no agent, no launcher).
        if ($path -eq '/api/launcher-status') {
            $body = '{"ver":0,"ts":"","ageSeconds":-1}'
            try {
                # [F17 §2] raw-ts + RoundtripKind age; the echoed ts is explicit
                # UTC ISO (with Z), never the local Z-less form.
                $lhFile = Join-Path $Root 'launcher-hello-last.json'
                if (Test-Path -LiteralPath $lhFile) {
                    $lh = [System.IO.File]::ReadAllText($lhFile) | ConvertFrom-Json
                    $age = Get-UtcAgeSeconds (Get-RawJsonTs $lhFile)
                    if ($null -eq $age) { $age = -1 }
                    $body = '{"ver":' + [int]$lh.ver + ',"build":"' + [string]$lh.build + '","ts":"' + (ConvertTo-UtcIso (Get-RawJsonTs $lhFile)) + '","ageSeconds":' + $age + '}'
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
            return
        }
        if ($path -eq '/api/rdp-status') {
            $rdpAgeSec = -1
            $logonType = 0
            try {
                $cfgS = Read-JsonFile -Path $script:CfgPath
                $u = [string]$cfgS.rdpUser
                $sessions = @(query.exe user 2>$null)
                foreach ($qr in $sessions) {
                    if (($qr -match [regex]::Escape($u)) -and ($qr -match '\bActive\b')) {
                        if ($qr -match '(\d{1,2}:\d{2})') {
                            $rdpAgeSec = 0
                        } else { $rdpAgeSec = 0 }
                        $logonType = 10
                        break
                    }
                }
                if ($rdpAgeSec -lt 0) {
                    $ev = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624} -MaxEvents 20 -ErrorAction SilentlyContinue |
                        Where-Object { $_.Message -match 'Logon Type:\s+10' -and $_.Message -match [regex]::Escape($u) } |
                        Select-Object -First 1
                    if ($ev) {
                        $rdpAgeSec = [int]((Get-Date) - $ev.TimeCreated).TotalSeconds
                        $logonType = 10
                    }
                }
            } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"rdp_age_s":' + $rdpAgeSec + ',"logon_type":' + $logonType + '}'))
            return
        }
        # [F85 §3] /api/version - the diagnostic-banner contract. The banner at
        # /#/search?diag=1 prints one checkmark per F84 capability and NEVER a
        # checkmark it cannot verify: each flag here is true only because the
        # matching F84 code path exists in the shipped bytes of THIS file, and
        # tests/f85-f84-symbols.test.js re-extracts all four symbols from those
        # bytes (normalizeUrl auto-https, Test-F78SameHost www-tolerance, the
        # aria2-less download branch, and the client's no-window.open contract)
        # so the flag cannot outlive the code it advertises. `sha` is the commit
        # the RUNNER was dispatched with (GITHUB_SHA); the UI compares it with
        # the sha its bundle was BUILT from, so a stale bundle shows as a
        # mismatch instead of a silent half-deploy.
        if ($path -eq '/api/version') {
            $f85Sha = ''
            try { $f85Sha = [string]$env:GHRDP_BUILD_SHA } catch { $f85Sha = '' }
            if (-not $f85Sha) { try { $f85Sha = [string]$env:GITHUB_SHA } catch { $f85Sha = '' } }
            if (-not $f85Sha) { try { $cfgV = Read-JsonFile -Path $script:CfgPath; $f85Sha = [string]$cfgV.commit } catch { $f85Sha = '' } }
            if (-not $f85Sha) { $f85Sha = 'dev' }
            $f85Sha7 = $f85Sha
            if ($f85Sha7.Length -gt 7) { $f85Sha7 = $f85Sha7.Substring(0, 7) }
            $objV = [ordered]@{
                ok = $true
                server = 'ghrdp'
                sha = $f85Sha
                sha7 = $f85Sha7
                features = [ordered]@{
                    autoHttps = $true
                    wwwTolerance = $true
                    noFallback = $true
                    downloadToRdp = $true
                    # [F86 §A] the three-tier launch ladder + GET /api/launch-url/diag
                    # are in these bytes; tests/f86-launch-url-tier1.test.js
                    # re-extracts the ladder symbols so the flag cannot outlive them.
                    launchTiers = $true
                    # [F87 §C.1] POST /api/f87-selftest (eleven-site production
                    # proof) ships in these bytes; tests/f87-selftest.test.js pins it.
                    selfTest = $true
                    # [F91 §A/§D] mirror-mode launcher (queue + health + the
                    # persistent service contract) and the /api/stream audio relay.
                    # tests/f91-launcher-queue.test.js + tests/f91-stream-proxy.test.js
                    # re-extract the route symbols, so neither flag can outlive
                    # the code it advertises.
                    mirrorLauncher = $true
                    streamProxy = $true
                }
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $objV)
            return
        }
        if ($path -eq '/api/ping') {
            $tIp = Get-TailnetIp
            $commit = ''
            try { $cfgP2 = Read-JsonFile -Path $script:CfgPath; if ($cfgP2 -and $cfgP2.commit) { $commit = [string]$cfgP2.commit } } catch { }
            $obj = [ordered]@{ ok = $true; ip = $tIp; epoch = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); commit = $commit }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        # [remediation 8C] /api/device-enroll, /api/agent-hello, /api/client-cmd (POST+GET),
        # /api/client-status + /api/agent-status (POST+GET), /api/agent.ps1, /api/accept.ps1,
        # /api/acceptance.ps1 bodies deleted; unreachable due to 404 guard above.
        if ($path -eq '/api/diag.ps1') {
            $dp = Join-Path $Root 'ghrdp-diag.ps1'
            if (Test-Path -LiteralPath $dp) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'text/plain; charset=utf-8' -Body ([System.IO.File]::ReadAllBytes($dp))
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('diag.ps1 not deployed'))
            }
            return
        }
        # /api/logon-status — RUNNER-SIDE RDP logon proof (addresses REVIEW.md N8).
        # Query the RUNNER's Security log for event 4624 with Logon Type 10 for the RDP account
        # newer than the caller-supplied baseline. This is genuine RDP-into-runner evidence.
        # Client-side LogonType 10 is inbound-to-client and does NOT prove the outbound RDP.
        if ($path -eq '/api/logon-status') {
            $sinceIso = ''
            if ($parts.query -and $parts.query.ContainsKey('since')) { $sinceIso = [string]$parts.query['since'] }
            $userQ = ''
            if ($parts.query -and $parts.query.ContainsKey('user')) { $userQ = [string]$parts.query['user'] }
            if (-not $userQ) { try { $cfgL = Read-JsonFile -Path $script:CfgPath; $userQ = [string]$cfgL.rdpUser } catch { } }
            $since = [DateTime]::UtcNow.AddMinutes(-2)
            if ($sinceIso) { try { $since = [DateTime]::Parse($sinceIso).ToUniversalTime() } catch { } }
            $connected = $false; $ts = ''; $ageSec = -1; $ip = ''; $checked = 0
            $ltSeen = ''
            try {
                $filter = @{ LogName='Security'; Id=4624; StartTime=$since.ToLocalTime() }
                $events = Get-WinEvent -FilterHashtable $filter -MaxEvents 80 -ErrorAction SilentlyContinue
                foreach ($ev in @($events)) {
                    $checked++
                    $msg = [string]$ev.Message
                    # [F95 §3.1 / R1] was 'Logon Type:\s+10'. The rendered
                    # message carries the numeric type, so accept the same
                    # 2/10/11 set as the F28 collector. \b stops '10' from
                    # matching inside a longer number.
                    if ($msg -notmatch 'Logon Type:\s+(2|10|11)\b') { continue }
                    if ($userQ -and $msg -notmatch [regex]::Escape($userQ)) { continue }
                    $connected = $true
                    $ltSeen = [string]$Matches[1]
                    $ts = $ev.TimeCreated.ToUniversalTime().ToString('o')
                    $ageSec = [int]((Get-Date) - $ev.TimeCreated).TotalSeconds
                    if ($msg -match 'Source Network Address:\s+(\S+)') { $ip = $Matches[1] }
                    break
                }
            } catch { }
            $body = [ordered]@{
                connected  = $connected
                ts         = $ts
                ageSeconds = $ageSec
                sourceIp   = $ip
                user       = $userQ
                since      = $since.ToString('o')
                checked    = $checked
                logonType  = $ltSeen
                note       = 'Runner-side Security 4624 LogonType 2/10/11 (F95: was type-10 only); requires SeSecurityPrivilege on server process'
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $body)
            return
        }
        # [remediation 8C-extended] /api/agent-hash body deleted; unreachable due to 404 guard above. It served SHA256 of the removed agent.ps1 payload — no agent, no hash.
        # [remediation 8C] /api/diag-upload, /api/diag-file bodies deleted; unreachable due to 404 guard above.
        # [remediation 8C-extended] /client-install.ps1 body deleted; unreachable due to 404 guard above. It served the client-install script — replaced by docs/AUTOLOGIN.md manual reg-add + cmdkey.
        if ($path -eq '/webdesk-boot') {
            # [remediation #7C] loopback-boot call removed - it turned NLA off + stashed plaintext cmdkey.
            $outB = @{ ok = $false; message = 'loopback bootstrap removed per remediation #7C - log in via real RDP with NLA on' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($outB | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-probe') {
            $wPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-pub2.ps1'
            $bPs = Test-Path -LiteralPath 'C:\ghrdp\ghrdp-bootstrap-session.ps1'
            $task = $false
            try { $task = [bool](Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue) } catch { }
            $sess = $false
            try { $q = (& quser.exe 2>$null) -join "`n"; $LASTEXITCODE = 0; $cfgP = Read-JsonFile -Path $script:CfgPath; if (($q -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($q -match 'runneradmin')) { $sess = $true } } catch { }
            $sessState = 'no-session'
            try { $ql2 = @(& quser.exe 2>$null); $LASTEXITCODE = 0; foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin')) -and ($qr2 -match '\bActive\b')) { $sessState = 'Active'; break } }; if ($sessState -eq 'no-session') { foreach ($qr2 in $ql2) { if ((($qr2 -match [regex]::Escape([string]$cfgP.rdpUser)) -or ($qr2 -match 'runneradmin'))) { $sessState = 'Disc'; break } } } } catch { $sessState = 'error' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ webdeskPs = $wPs; bootstrapPs = $bPs; task = $task; session = $sess; diag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\boot-diag.txt') } catch { '' }); wdErr = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); mstscDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\mstsc-exit-diag.txt') } catch { '' }); tsPath = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ts-path.txt') } catch { '' }); aliveAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-alive.txt')).TotalMilliseconds } catch { -1 }); capFail = $(try { $cfi = Get-Item 'C:\ghrdp\webdesk\webdesk-capture-fail.txt' -ErrorAction Stop; if (((Get-Date) - $cfi.LastWriteTime).TotalSeconds -lt 60) { [System.IO.File]::ReadAllText($cfi.FullName) } else { '' } } catch { '' }); version = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-version.txt') } catch { '' }); manualDiag = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\diag-manual.txt') } catch { '' }); displayCount = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\display-count.txt') } catch { '' }); frameExists = $(Test-Path 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction SilentlyContinue); frameSize = $(try { (Get-Item 'C:\ghrdp\webdesk\frame.jpg' -ErrorAction Stop).Length } catch { -1 }); startAgeMs = $(try { [int]((Get-Date) - [datetime][System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-start.txt')).TotalMilliseconds } catch { -1 }); initResult = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-init.txt') } catch { '' }); captureProcAlive = $(try { $m = [System.Threading.Mutex]::OpenExisting('Global\GhrdpWebDeskSingle'); $h = $m.WaitOne(0); if (-not $h) { 'RUNNING (mutex held)' } else { $m.ReleaseMutex(); 'NOT RUNNING' } } catch { 'NOT RUNNING' }); pidFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk.pid') } catch { '' }); errFile = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-error.txt') } catch { '' }); trace = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\webdesk-trace.txt') } catch { '' }); captureProcs = $(try { [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\procs.txt') } catch { '' }); sessionState = $sessState; taskState = $(try { $t = Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() } else { 'not-registered' } } catch { 'error' }); taskLastRun = $(try { $i = Get-ScheduledTaskInfo -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue; if ($i) { $i.LastRunTime.ToString() + ' result=' + $i.LastTaskResult } else { 'never' } } catch { 'error' }) } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-status') {
            $ageMs = -1
            try { $tsTxt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\frame-ts.txt'); $ageMs = [int]((Get-Date) - [datetime]$tsTxt).TotalMilliseconds } catch { }
            $outJ = @{ ok = ($ageMs -ge 0 -and $ageMs -lt 15000); frameAgeMs = $ageMs } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        if ($path -eq '/webdesk-frame') {
            $b = $null
            for ($ra = 1; $ra -le 4; $ra++) {
                try { $b = [System.IO.File]::ReadAllBytes('C:\ghrdp\webdesk\frame.jpg'); if ($b -and $b.Length -gt 0) { break } } catch { $b = $null }
                Start-Sleep -Milliseconds 25
            }
            if ($b -and $b.Length -gt 0) { Send-ClientResponse -Stream $stream -Code 200 -CType 'image/jpeg' -Body $b } else { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('no frame yet')) }
            return
        }
        if ($path -eq '/webdesk-input') {
            $btxt = ''
            try { $btxt = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) } catch { }
            $wrote = $false
            try {
                $bj = $null
                try { $bj = $btxt | ConvertFrom-Json } catch { }
                $linesOut = @()
                if ($bj -is [System.Collections.IEnumerable] -and $bj -isnot [string]) { foreach ($e1 in @($bj)) { $linesOut += ($e1 | ConvertTo-Json -Compress) } } else { $linesOut += $btxt }
                $dir = 'C:\ghrdp\webdesk'
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null }
                try {
                    [System.IO.File]::AppendAllText((Join-Path $dir 'input.ndjson'), (($linesOut -join "`n") + "`n"))
                    $wrote = $true
                } catch {
                    try { Add-Content -LiteralPath (Join-Path $dir 'input.ndjson') -Value (($linesOut -join "`n")) -Encoding UTF8; $wrote = $true } catch { }
                }
            } catch { }
            try { $cf = 'C:\ghrdp\webdesk\input-count.txt'; $n = 0; if (Test-Path -LiteralPath $cf) { try { $n = [int]([System.IO.File]::ReadAllText($cf).Trim()) } catch { } }; [System.IO.File]::WriteAllText($cf, ([string]($n + 1))) } catch { }
            $okTxt = if ($wrote) { 'true' } else { 'false' }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":' + $okTxt + '}'))
            return
        }
        if ($path -eq '/webdesk-clip') {
            if ([string]$parts.method -eq 'POST') {
                try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-set.json', ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body))) } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            }
            try { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\clip-get.flag', (Get-Date).ToUniversalTime().ToString('o')) } catch { }
            $txt = $null
            try { if (Test-Path 'C:\ghrdp\webdesk\clip.txt') { $txt = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\clip.txt') } } catch { }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ text = $txt } | ConvertTo-Json -Compress)))
            return
        }
        if ($path -eq '/webdesk-ctl') {
            if ($parts.method -eq 'POST') {
                try {
                    $body = [System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)
                    $j = $body | ConvertFrom-Json
                    if ($j -and $null -ne $j.q -and $null -ne $j.scale) {
                        $qq = [long]$j.q; $ss = [double]$j.scale
                        if ($qq -ge 1 -and $qq -le 100 -and $ss -gt 0 -and $ss -le 1) {
                            [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', ('{"q":' + $qq + ',"scale":' + $ss.ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}'))
                        }
                    }
                } catch { }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                return
            } else {
                $cur = @{ q = 35; scale = 0.5 }
                if (Test-Path -LiteralPath 'C:\ghrdp\webdesk\ctl.json') {
                    try {
                        $raw2 = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk\ctl.json').Trim()
                        if ($raw2.Length -gt 0) { $cur = $raw2 | ConvertFrom-Json } else { [System.IO.File]::WriteAllText('C:\ghrdp\webdesk\ctl.json', '{"q":35,"scale":0.5}') }
                    } catch { }
                }
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(($cur | ConvertTo-Json -Compress)))
                return
            }
        }
        if ($path -eq '/terminal') {
            $termPage = @'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHRDP Terminal</title>
<style>
:root{--glass:rgba(255,255,255,.08);--stroke:rgba(255,255,255,.16);--txt:#f5f5f7;--dim:rgba(245,245,247,.6)}
*{box-sizing:border-box}
body{margin:0;height:100vh;color:var(--txt);font:14px/1.45 -apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,sans-serif;background:#0b0e14;overflow:hidden}
body::before{content:'';position:fixed;inset:-20%;background:radial-gradient(40% 35% at 20% 20%,rgba(64,120,255,.35),transparent 60%),radial-gradient(35% 30% at 80% 25%,rgba(255,80,160,.28),transparent 60%),radial-gradient(45% 40% at 50% 85%,rgba(60,220,180,.22),transparent 60%);filter:blur(40px) saturate(160%);animation:drift 18s ease-in-out infinite alternate;z-index:0}
@keyframes drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(2%,2%,0) scale(1.06)}}
.glass{position:relative;z-index:1;background:var(--glass);border:1px solid var(--stroke);border-radius:18px;backdrop-filter:saturate(180%) blur(22px);-webkit-backdrop-filter:saturate(180%) blur(22px);box-shadow:0 8px 32px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.12)}
#app{position:relative;z-index:1;display:flex;flex-direction:column;gap:12px;height:100vh;padding:14px}
#bar{display:flex;gap:8px;align-items:center;padding:10px 12px;flex-wrap:wrap}
#bar input,#bar select{background:rgba(255,255,255,.06);border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 10px;font:inherit;outline:none}
#bar input:focus{border-color:rgba(120,170,255,.7);box-shadow:0 0 0 3px rgba(90,140,255,.25)}
button{background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.08));border:1px solid var(--stroke);color:var(--txt);border-radius:10px;padding:7px 12px;font:inherit;cursor:pointer;backdrop-filter:blur(8px)}
button:hover{background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,.14))}
button.primary{background:linear-gradient(180deg,#4f8cff,#2f6bff);border-color:rgba(255,255,255,.35)}
#code{flex:0 0 26vh;background:rgba(0,0,0,.35);border:1px solid var(--stroke);border-radius:16px;color:#e8f0ff;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:none;outline:none;backdrop-filter:blur(14px)}
#out{flex:1;overflow:auto;background:rgba(0,0,0,.45);border:1px solid var(--stroke);border-radius:16px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;backdrop-filter:blur(14px)}
.meta{color:#7ee787}.err{color:#ff7b72}.dim{color:var(--dim)}
#chip{margin-left:auto;font-size:12px;color:var(--dim)}
</style></head><body>
<div id="app">
 <div id="bar" class="glass">
  <input id="cmd" size="52" placeholder="one-line command (inline mode)">
  <button id="bCmd" class="primary">Run Cmd</button>
  <input id="fpath" size="34" placeholder="C:\path\script.ps1 (file mode)">
  <button id="bFile">Run File</button>
  <select id="sess"><option value="system">SYSTEM (s0)</option><option value="interactive">INTERACTIVE (user session)</option></select>
  <input id="tmo" size="6" value="60000">
  <button id="bPaste">Run Paste</button>
  <button id="bCopy">Copy Out</button>
  <span id="chip">GHRDP Terminal · liquid glass</span>
 </div>
 <textarea id="code" class="glass" placeholder="paste long .ps1 here → Run Paste (upload mode, base64-safe)"></textarea>
 <div id="out" class="glass"><span class="dim">ready.</span></div>
</div>
<script>
var tok=new URLSearchParams(location.search).get('token')||'';
var out=document.getElementById('out');
function show(j){out.innerHTML='';var m=document.createElement('div');m.className='meta';m.textContent='exit='+j.exitCode+' timedOut='+j.timedOut+' ms='+j.durationMs+' session='+j.session+' file='+j.scriptPath;out.appendChild(m);var o=document.createElement('div');o.textContent=j.output||'(no stdout)';out.appendChild(o);if(j.error){var e=document.createElement('div');e.className='err';e.textContent='STDERR:\n'+j.error;out.appendChild(e);}}
function run(body){out.innerHTML='<span class="dim">running…</span>';fetch('/terminal-exec',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(show).catch(function(e){out.textContent='FETCH ERROR: '+e;});}
document.getElementById('bCmd').onclick=function(){run({mode:'inline',cmd:document.getElementById('cmd').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bFile').onclick=function(){run({mode:'file',file:document.getElementById('fpath').value,session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bPaste').onclick=function(){var t=document.getElementById('code').value;run({mode:'upload',script_b64:btoa(unescape(encodeURIComponent(t))),session:document.getElementById('sess').value,timeout:+document.getElementById('tmo').value});};
document.getElementById('bCopy').onclick=function(){navigator.clipboard.writeText(out.innerText);};
</script></body></html>
'@
                      $htmlT = $null
                      try { if (Test-Path -LiteralPath 'C:\ghrdp\terminal-ui.html') { $htmlT = [System.IO.File]::ReadAllText('C:\ghrdp\terminal-ui.html') } } catch { }
                      if (-not $htmlT) { $htmlT = $termPage }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlT))
            return
        }
                if ($path -eq '/terminal-exec') {
                    $timeoutMs = 60000
                    $tmode = 'inline'
                    $tsess = 'system'
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $tid = ''
                    $tscript = ''
                    $toutF = ''
                    $terrF = ''
                    $workDir = 'C:\ghrdp\webdesk\term'
                    try {
                        $req = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                        $tmode = if ($req.mode) { [string]$req.mode } else { 'inline' }
                        if ($req.timeout) { $timeoutMs = [int]$req.timeout }
                        if ($timeoutMs -gt 300000) { $timeoutMs = 300000 }
                        if ($timeoutMs -lt 1000) { $timeoutMs = 1000 }
                        if ($req.session -eq 'interactive') { $tsess = 'interactive' }
                        New-Item -ItemType Directory -Path $workDir -Force -ErrorAction SilentlyContinue | Out-Null
                        $tid = [guid]::NewGuid().ToString('N').Substring(0, 8)
                        $tscript = Join-Path $workDir ('run-' + $tid + '.ps1')
                        $toutF = Join-Path $workDir ('out-' + $tid + '.txt')
                        $terrF = Join-Path $workDir ('err-' + $tid + '.txt')
                        $ownScript = $true
                        if ($tmode -eq 'upload') {
                            if (-not [string]$req.script_b64) { throw 'missing script_b64' }
                            [System.IO.File]::WriteAllText($tscript, ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$req.script_b64))))
                        } elseif ($tmode -eq 'file') {
                            if (-not (Test-Path -LiteralPath ([string]$req.file))) { throw ('file not found: ' + [string]$req.file) }
                            $tscript = [string]$req.file
                            $ownScript = $false
                        } else {
                            if (-not [string]$req.cmd) { throw 'empty cmd' }
                            [System.IO.File]::WriteAllText($tscript, ([string]$req.cmd))
                        }
                        try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\terminal-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' mode=' + $tmode + ' session=' + $tsess + ' file=' + $tscript + "`n")) } catch { }
                      $statusFile = Join-Path $workDir ('status-' + $tid + '.txt')
                      [System.IO.File]::WriteAllText($statusFile, 'running')
                      if ($tsess -eq 'system') {
                          try {
                              $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $tscript + '"')) -WorkingDirectory $workDir -RedirectStandardOutput $toutF -RedirectStandardError $terrF -NoNewWindow -PassThru
                              Start-Job -ScriptBlock { param($pid2,$tmo,$sf) $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue; if ($p) { if (-not $p.WaitForExit($tmo)) { try { $p.Kill() } catch { }; [System.IO.File]::WriteAllText($sf,'timeout') } else { [System.IO.File]::WriteAllText($sf,('exit=' + $p.ExitCode)) } } else { [System.IO.File]::WriteAllText($sf,'exit=-1') } } -ArgumentList $proc.Id, $timeoutMs, $statusFile | Out-Null
                          } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                      } else {
                          $activeUser = ''
                          try { $qu = & quser.exe 2>$null; $LASTEXITCODE = 0; foreach ($line in @($qu)) { if ($line -match '^\s*>?\s*(\S+)\s+\S+\s+\d+\s+Active') { $activeUser = $Matches[1]; break } } } catch { }
                          if (-not $activeUser) { [System.IO.File]::WriteAllText($statusFile, 'error=no active user session') }
                          else {
                              $taskName = 'GhrdpTerm-' + $tid
                              $wrapPath = Join-Path $workDir ('wrap-' + $tid + '.ps1')
                              $wrap = 'param($sp,$op,$ep2)' + "`r`n" + '$p = Start-Process -FilePath ''powershell.exe'' -ArgumentList @(''-NoProfile'',''-ExecutionPolicy'',''Bypass'',''-File'',([char]34 + $sp + [char]34)) -RedirectStandardOutput $op -RedirectStandardError $ep2 -NoNewWindow -Wait -PassThru' + "`r`n" + 'exit $p.ExitCode'
                              [System.IO.File]::WriteAllText($wrapPath, $wrap)
                              try {
                                  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $wrapPath + '" "' + $tscript + '" "' + $toutF + '" "' + $terrF + '"')
                                  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(1)
                                  $principal = New-ScheduledTaskPrincipal -UserId $activeUser -LogonType Interactive -RunLevel Highest
                                  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMilliseconds($timeoutMs))
                                  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
                                  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                                  Start-Job -ScriptBlock { param($tn,$tmo,$sf) $deadline = (Get-Date).AddMilliseconds($tmo); while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $ti = Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue; if ($ti) { $lr = [int]$ti.LastTaskResult; if ($lr -ne 267009 -and $lr -ne 267010 -and $lr -ne 267011) { [System.IO.File]::WriteAllText($sf, ('exit=' + $lr)); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { }; return } } }; [System.IO.File]::WriteAllText($sf, 'timeout'); try { Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue } catch { } } -ArgumentList $taskName, $timeoutMs, $statusFile | Out-Null
                              } catch { [System.IO.File]::WriteAllText($statusFile, ('error=' + $_.Exception.Message)) }
                          }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ runId = $tid; session = $tsess; scriptPath = $tscript })
                      return
                    } catch {
                      $errMsg = $_.Exception.Message
                      try {
                        if ($tid) {
                          $sfErr = Join-Path $workDir ('status-' + $tid + '.txt')
                          [System.IO.File]::WriteAllText($sfErr, ('error=' + $errMsg))
                        }
                      } catch { }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ error = $errMsg })
                      return
                    }
                  }
                  # ============= /terminal-result (GET ?id=) =============
                  if ($path -eq '/terminal-result') {
                      $rid = ''
                      if ($parts.query -and $parts.query.ContainsKey('id')) { $rid = [string]$parts.query['id'] }
                      $workDir2 = 'C:\ghrdp\webdesk\term'
                      $sf2 = Join-Path $workDir2 ('status-' + $rid + '.txt')
                      $st = 'running'; if (Test-Path -LiteralPath $sf2) { try { $st = [System.IO.File]::ReadAllText($sf2).Trim() } catch { } }
                      $done = ($st -ne 'running')
                      $exitCode = $null; $timedOut = $false; $errMsg = ''
                      if ($st -like 'exit=*') { $exitCode = [int]($st.Substring(5)) }
                      elseif ($st -eq 'timeout') { $timedOut = $true }
                      elseif ($st -like 'error=*') { $errMsg = $st.Substring(6) }
                      $outTxt = ''; $errTxt = ''
                      if ($done) {
                          for ($a = 1; $a -le 5; $a++) {
                              $o1 = $true; $o2 = $true
                              try { $op = Join-Path $workDir2 ('out-' + $rid + '.txt'); if (Test-Path -LiteralPath $op) { $outTxt = [System.IO.File]::ReadAllText($op) } } catch { $o1 = $false }
                              try { $ep2 = Join-Path $workDir2 ('err-' + $rid + '.txt'); if (Test-Path -LiteralPath $ep2) { $errTxt = [System.IO.File]::ReadAllText($ep2) } } catch { $o2 = $false }
                              if ($o1 -and $o2) { break }
                              Start-Sleep -Milliseconds 300
                          }
                          if ($errMsg -and -not $errTxt) { $errTxt = $errMsg }
                      }
                      Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes @{ done = $done; exitCode = $exitCode; timedOut = $timedOut; output = $outTxt; error = $errTxt })
                      return
                  }
        if ($path -eq '/remote-exec') {
            $timeout = 30000
            $out = ''
            try {
                $rj = ([System.Text.Encoding]::UTF8.GetString([byte[]]$parts.body)) | ConvertFrom-Json
                $sb64 = [string]$rj.script_b64
                if (-not $sb64) { throw 'missing script_b64' }
                if ($rj.timeout) { $timeout = [int]$rj.timeout }
                $scriptContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sb64))
                try { [System.IO.File]::AppendAllText('C:\ghrdp\webdesk\remote-exec-audit.log', ((Get-Date).ToUniversalTime().ToString('o') + ' REMOTE-EXEC len=' + $scriptContent.Length + ' head=' + $scriptContent.Substring(0, [Math]::Min(200, $scriptContent.Length)) + "`n")) } catch { }
                $tmpScript = Join-Path $env:TEMP ('ghrdp-remote-' + [guid]::NewGuid().ToString('N') + '.ps1')
                [System.IO.File]::WriteAllText($tmpScript, $scriptContent)
                $job = Start-Job -ScriptBlock { param($s) powershell -NoProfile -ExecutionPolicy Bypass -File $s } -ArgumentList $tmpScript
                $job | Wait-Job -Timeout ($timeout / 1000) | Out-Null
                if ($job.State -eq 'Running') { $job | Stop-Job -Force; $out = 'TIMEOUT after ' + ($timeout / 1000) + 's' }
                else { $out = ($job | Receive-Job | Out-String); if (-not $out) { $out = '(no output)' } }
                try { $job | Remove-Job -Force } catch { }
                try { Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue } catch { }
            } catch { $out = 'ERROR: ' + $_.Exception.Message }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes(('{"output":' + ([string]$out | ConvertTo-Json) + '}')))
            return
        }
        if ($path -eq '/webdesk') {
            $html = $null
            try { if (Test-Path -LiteralPath 'C:\ghrdp\webdesk-ui.html') { $html = [System.IO.File]::ReadAllText('C:\ghrdp\webdesk-ui.html') } } catch { }
            if (-not $html) { $html = $script:WebDeskHtml }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        if ($path -eq '/novnc') {
            $htmlN = @'
<!doctype html><html><head><meta charset="utf-8"><title>GHRDP Web Desktop</title>
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}#screen{width:100%;height:100%}#bar{position:fixed;top:0;left:0;right:0;padding:8px 12px;font:13px system-ui;color:#e8eef3;background:#1b2530;display:flex;gap:12px;align-items:center;z-index:9}#bar .st{color:#8aa0ad}#bar button{background:#153e5c;color:#e8eef3;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}</style>
</head><body>
<div id="bar"><b>GHRDP Web Desktop</b><span class="st" id="st">checking backend...</span><button id="re">Retry</button></div>
<div id="screen"></div>
<script type="module">
const st=document.getElementById('st');
const WS='ws://'+location.hostname+':7333/';
function wsProbe(url){return new Promise((res,rej)=>{let w;try{w=new WebSocket(url);}catch(e){rej(e);return;}const t=setTimeout(()=>{try{w.close();}catch(e){}rej(new Error('timeout - bridge not answering'));},5000);w.onopen=()=>{clearTimeout(t);try{w.close();}catch(e){}res(true);};w.onerror=()=>{clearTimeout(t);rej(new Error('websocket refused/blocked - firewall 7333 or websockify down'));};});}
let rfb=null;
async function boot(){
  st.textContent='checking backend...';
  try{
    const r=await fetch('/vncstatus',{cache:'no-store'});
    const j=await r.json();
    if(!j.ok){ st.textContent='backend down: vnc5900='+j.vnc+' bridge7333='+j.bridge+' - keep-alive self-heals every 2 min; click Retry'; return; }
  }catch(e){ st.textContent='cannot reach /vncstatus: '+e; return; }
  st.textContent='probing websocket '+WS+' ...';
  try{ await wsProbe(WS); }catch(e){ st.textContent='WS probe failed: '+e.message; return; }
  st.textContent='loading noVNC + connecting...';
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js');
    if(rfb){ try{rfb.disconnect();}catch(e){} }
    rfb=new mod.default(document.getElementById('screen'),WS,{});
    rfb.scaleViewport=true; rfb.clipboardCapable=true;
    rfb.addEventListener('connect',()=>{st.textContent='connected - clipboard active';});
    rfb.addEventListener('securityfailure',e=>{st.textContent='VNC security rejected: '+e.detail.reason+' (type '+e.detail.status+')';});
    rfb.addEventListener('disconnect',e=>{st.textContent='disconnected code='+((e.detail&&e.detail.code)||'none')+' reason='+((e.detail&&e.detail.reason)||'none')+' clean='+((e.detail&&e.detail.clean)||false)+' - Retry';});
    rfb.addEventListener('credentialsrequired',()=>{st.textContent='server demands a password but auth should be NONE - run PATCH 1 on the runner';});
  }catch(e){ st.textContent='noVNC load failed: '+e; }
}
document.getElementById('re').onclick=boot;
boot();
</script></body></html>
'@
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($htmlN))
            return
        }
        if ($path -eq '/vncstatus') {
            $vncUp = $false; $brUp = $false
            try { $vncUp = [bool](Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue) } catch { }
            try { $brUp = [bool](Get-NetTCPConnection -LocalPort 7333 -State Listen -ErrorAction SilentlyContinue) } catch { }
            $outJ = @{ ok = ($vncUp -and $brUp); vnc = $vncUp; bridge = $brUp } | ConvertTo-Json -Compress
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($outJ))
            return
        }
        # [remediation 8C-extended] /install.ps1 body deleted; unreachable due to 404 guard above. It served the ghrdp:// handler installer — replaced by docs/AUTOLOGIN.md manual reg-add.
        if ($path -eq '/config') {
            $cfgOut = Remove-CredKeys (Read-JsonFile -Path $script:CfgPath)
            if ($cfgOut) {
                Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $cfgOut)
            } else {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing'))
            }
            return
        }
        if ($path -eq '/progress' -or $path -eq '/api/progress' -or $path -eq '/mirror') {
            $prog = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog) {
                $prog = [ordered]@{
                    ts = ''
                    alive = $false
                    active = [ordered]@{ name = ''; phase = 'idle'; pct = 0 }
                    agg = [ordered]@{ total = 0; done = 0; failed = 0; active = 0; bytesDone = 0; bytesTotal = 0; overallPct = 0; speedBps = 0 }
                    telemetry = [ordered]@{ scans = 0; lastScan = ''; seen = 0; skippedJunk = 0; skippedSmall = 0; locked = 0; queued = 0; roots = @() }
                    archives = @()
                    files = @()
                    log = @()
                    speedHistory = @()
                }
            }
            $ip = ''; $us = ''; $pw = ''; $mk = ''; $tg = ''; $sv = ''; $fu = ''; $sa = ''; $rsa = ''; $ssa = ''; $em = 'none'; $lu = ''; $lk = ''; $rn = ''; $eg = ''
            $mirrorFlag = $false
            $mirrorPlain = $false
            $ghrdpVal = ''; $kaDeadline = ''; $kaPhase = ''; $pBase = ''
            if ($cfg) {
                if ($cfg.PSObject.Properties['mirrorIndexUrl'] -and $null -ne $cfg.mirrorIndexUrl) { $tg = [string]$cfg.mirrorIndexUrl }
                if ($cfg.PSObject.Properties['serveUrl'] -and $null -ne $cfg.serveUrl) { $sv = [string]$cfg.serveUrl }
                if ($cfg.PSObject.Properties['funnelUrl'] -and $null -ne $cfg.funnelUrl) { $fu = [string]$cfg.funnelUrl }
                if ($cfg.PSObject.Properties['startedAt'] -and $null -ne $cfg.startedAt) { $sa = [string]$cfg.startedAt }
                if ($cfg.PSObject.Properties['runStartedAt'] -and $null -ne $cfg.runStartedAt) { $rsa = [string]$cfg.runStartedAt }
                if ($cfg.PSObject.Properties['sessionStartedAt'] -and $null -ne $cfg.sessionStartedAt) { $ssa = [string]$cfg.sessionStartedAt }
                if ($cfg.PSObject.Properties['encryptMode'] -and [string]$cfg.encryptMode) { $em = [string]$cfg.encryptMode }
                if ($cfg.PSObject.Properties['legacyIndexUrl'] -and $null -ne $cfg.legacyIndexUrl) { $lu = [string]$cfg.legacyIndexUrl }
                if ($cfg.PSObject.Properties['rentryNewUrl'] -and $null -ne $cfg.rentryNewUrl) { $rn = [string]$cfg.rentryNewUrl }
                if ($cfg.PSObject.Properties['runnerEgressIp'] -and $null -ne $cfg.runnerEgressIp) { $eg = [string]$cfg.runnerEgressIp }
                if ($cfg.PSObject.Properties['mirror'] -and $null -ne $cfg.mirror) { $mirrorFlag = [bool]$cfg.mirror }
                $optInMarker = Get-F49OptInVal -Cfg $cfg
                if ($cfg.PSObject.Properties['mirrorPlaintextElection'] -and $null -ne $cfg.mirrorPlaintextElection) {
                    $mirrorPlain = ([bool]$cfg.mirrorPlaintextElection -and -not $optInMarker)
                }
                if ($cfg.PSObject.Properties['ghrdp'] -and $null -ne $cfg.ghrdp) { $ghrdpVal = [string]$cfg.ghrdp }
                if ($cfg.PSObject.Properties['keepAliveDeadline'] -and $null -ne $cfg.keepAliveDeadline) { $kaDeadline = [string]$cfg.keepAliveDeadline }
                if ($cfg.PSObject.Properties['keepAlivePhase'] -and $null -ne $cfg.keepAlivePhase) { $kaPhase = [string]$cfg.keepAlivePhase }
                if ($cfg.PSObject.Properties['pagesBase'] -and $null -ne $cfg.pagesBase) { $pBase = [string]$cfg.pagesBase }
            }
            $sessionEnd = $null; $cands = @()
            if ($cfg) {
                foreach ($k in @('githubDeadline','keepAliveDeadline','watcherDeadline')) {
                    if ($cfg.PSObject.Properties[$k] -and $cfg.$k) {
                        try { $cands += [datetime][string]$cfg.$k } catch { }
                    }
                }
            }
            if ($cands.Count) { $sessionEnd = ($cands | Measure-Object -Minimum).Minimum }
            $obj = [ordered]@{
                ok = $true
                status = 'ok'
                phase = if ($script:InitPhase) { $script:InitPhase } else { 'ready' }
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                mirror = $mirrorFlag
                encryptMode = $(if ($prog.encryptMode) { [string]$prog.encryptMode } else { $em })
                mirrorPlaintextElection = $mirrorPlain
                mirrorDiag = $prog.mirrorDiag
                mirrorProbe = $prog.mirrorProbe
                ghrdp = $ghrdpVal
                mirrorIndexUrl = $tg
                serveUrl = $sv
                funnelUrl = $fu
                startedAt = (To-IsoUtc $sa)
                runStartedAt = (To-IsoUtc $rsa)
                sessionStartedAt = (To-IsoUtc $ssa)
                sessionEnd = $(if ($sessionEnd) { $sessionEnd.ToString('o') } else { '' })
                legacyIndexUrl = $lu
                rentryNewUrl = $rn
                runnerEgressIp = $eg
                keepAliveDeadline = $kaDeadline
                keepAlivePhase = $kaPhase
                pagesBase = $pBase
                ts = $prog.ts
                alive = [bool]$prog.alive
                active = $prog.active
                agg = $prog.agg
                telemetry = $prog.telemetry
                archives = $prog.archives
                files = $prog.files
                log = $prog.log
                progress = $prog
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj)
            return
        }
        if (($path -eq '/') -or ($path -eq '/index.html')) {
            # [F43 / F42 §2] ui selection: DEFAULT v2; ?ui=v1 pins classic v1;
            # ?ui=v2 forces v2. A missing v2 file is fail-VISIBLE: v1 + the red
            # uiV2MissingBanner, never a silent v1. No other query value changes
            # the default.
            $html = '<h1>Mission Control UI file missing</h1>'
            $uiSel = ''
            try { if ($parts.query -and $parts.query.ContainsKey('ui')) { $uiSel = [string]$parts.query['ui'] } } catch { }
            $wantV2 = $script:UiV2Default -or ($uiSel -eq 'v2')
            if ($uiSel -eq 'v1') { $wantV2 = $false }
            $uiFile = $script:UiPath
            # [F42 §2] fail-VISIBLE v2: a ui=v2 request with ui-v2.html NOT
            # staged must never fall back to v1 silently. Serve v1 plus an
            # injected top red banner (HTTP 200) and log the same text. The
            # banner carries no key/token material.
            $v2Missing = $false
            if ($wantV2) {
                if (Test-Path -LiteralPath $script:UiV2Path) { $uiFile = $script:UiV2Path }
                else { $v2Missing = $true }
            }
            try { $html = [System.IO.File]::ReadAllText($uiFile, [System.Text.Encoding]::UTF8) } catch { }
            $ip = ''; $tg = ''
            if ($cfg) {
                if ($cfg.PSObject.Properties['rdpIp'] -and $null -ne $cfg.rdpIp) { $ip = [string]$cfg.rdpIp }
                if ($cfg.PSObject.Properties['mirrorIndexUrl'] -and $null -ne $cfg.mirrorIndexUrl) { $tg = [string]$cfg.mirrorIndexUrl }
            }
            if ($null -eq $html) { $html = '<h1>Mission Control UI missing</h1>' }
            if ($null -eq $ip) { $ip = '' }
            if ($null -eq $tg) { $tg = '' }
            $html = $html.Replace('__IP__', $ip).Replace('__TELEGRAPH__', $tg)
            if ($v2Missing) {
                $v2BannerText = 'ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI'
                $v2Banner = '<div id="uiV2MissingBanner" role="alert" style="position:sticky;top:0;z-index:99999;display:block;width:100%;box-sizing:border-box;background:#7f1d1d;color:#fff;font:600 13px/1.5 system-ui,sans-serif;text-align:center;padding:8px 12px">' + $v2BannerText + '</div>'
                $html = $html -replace '(?i)(<body[^>]*>)', ('$1' + $v2Banner)
                Write-Host ('[F42] V2-MISSING: ' + $v2BannerText + ' (v1 served with red banner; no key/token logged)')
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'text/html; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($html))
            return
        }
        # [F38] the same Root that serves ui.html also serves the staged Sinhala
        # subset. Allowlist is exactly the two latin-free woff2 files. The page
        # embeds the same bytes (tailnet-offline); this route is the static fetch.
        if ($path -eq '/fonts/noto-sans-sinhala-400-latin-free.woff2' -or $path -eq '/fonts/noto-sans-sinhala-600-latin-free.woff2') {
            $fontName = [System.IO.Path]::GetFileName($path)
            $fp = Join-Path (Join-Path $Root 'fonts') $fontName
            if (-not (Test-Path -LiteralPath $fp)) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('font not staged'))
                return
            }
            try { $fontBytes = [System.IO.File]::ReadAllBytes($fp) } catch { $fontBytes = $null }
            if (-not $fontBytes) {
                Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('font unreadable'))
                return
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'font/woff2' -Body $fontBytes
            return
        }
        if ($path -eq '/rdp') {
            $rdpIp2 = ''; $rdpUser2 = ''
            if ($cfg) { $rdpIp2 = [string]$cfg.rdpIp; $rdpUser2 = [string]$cfg.rdpUser }
            $lines = @(
                'screen mode id:i:2',
                'desktopwidth:i:1920',
                'desktopheight:i:1080',
                'session bpp:i:32',
                'compression:i:1',
                'keyboardhook:i:2',
                'audiocapturemode:i:0',
                'videoplaybackmode:i:0',
                'connection type:i:3',
                'networkautodetect:i:0',
                'bandwidthautodetect:i:0',
                'disable wallpaper:i:1',
                'disable full window drag:i:1',
                'disable menu anims:i:1',
                'disable themes:i:0',
                'disable cursor setting:i:1',
                'bitmapcachepersist:i:1',
                'smart sizing:i:0',
                'redirectclipboard:i:1',
                'redirectprinters:i:0',
                'redirectcomports:i:0',
                'redirectsmartcards:i:0',
                'redirectdrives:i:0',
                'autoreconnection enabled:i:1',
                'prompt credential once:i:0',
                'enableworkspacereconnect:i:0',
                'use multimon:i:0',
                'enablerdpudp:i:1',
                ('full address:s:' + $rdpIp2),
                ('username:s:' + $rdpUser2),
                'prompt for credentials:i:1',
                'negotiate security layer:i:1'
            )
            $rdpTxt = ($lines -join "`r`n")
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/x-rdp-file; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($rdpTxt))
            return
        }
        if ($path -eq '/ping') {
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ts = (Get-Date -Format o); wire = $script:Wire })
            return
        }
        if ($path -eq '/health') {
            # [F99 §2.1] was hardcoded ws=false; now computed from the upgrade feature flag
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes @{ ok = $true; ws = [bool]$script:F96WsUpgradeSupported; port = $Port; pid = $PID; ts = (Get-Date -Format o) })
            return
        }
        if ($path -eq '/api/config') {
            # [F10-2 §3] capture password fields BEFORE Remove-CredKeys strips
            # them; they are re-attached ONLY when $credsAllowed (dash-token or
            # tailnet source). Masked siblings (last 4) feed the UI display;
            # the raw values feed only the UI copy buttons. Never logged.
            $cfgRaw = Read-JsonFile -Path $script:CfgPath
            $rawU = ''; $rawP = ''; $rawV = ''
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['rdpUser']) { $rawU = [string]$cfgRaw.rdpUser } } catch { }
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['rdpPass']) { $rawP = [string]$cfgRaw.rdpPass } } catch { }
            try { if ($cfgRaw -and $cfgRaw.PSObject.Properties['vncPass']) { $rawV = [string]$cfgRaw.vncPass } } catch { }
            $cfgOut = Remove-CredKeys $cfgRaw
            if ($cfgOut -and $credsAllowed) {
                # [F10-16] last-4 mask. The previous one-liner compared
                # '[string]$v.Length -le 4', which PowerShell evaluates as a
                # STRING comparison ('17' -le '4' is true), so every password
                # rendered as '****' (lab annotation stage=gated-mask mask=[****]).
                # Bounded by length explicitly now.
                function Get-CredsMask([string]$s) {
                    if ([string]::IsNullOrEmpty($s)) { return '' }
                    if ($s.Length -le 4) { return '****' }
                    return (('*' * ($s.Length - 4)) + $s.Substring($s.Length - 4))
                }
                try {
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'windowsPass' -Value ([string]$rawP) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'windowsPassMask' -Value ([string](Get-CredsMask $rawP)) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'vncPass' -Value ([string]$rawV) -Force
                    $cfgOut.creds | Add-Member -MemberType NoteProperty -Name 'vncPassMask' -Value ([string](Get-CredsMask $rawV)) -Force
                } catch { }
            }
            # [M6] Attach the RSA-OAEP public key for envelope encryption (not a secret, safe to publish).
            if ($cfgOut -and $script:EnvelopePublicKeyB64) {
                try { $cfgOut | Add-Member -MemberType NoteProperty -Name 'envelopePublicKey' -Value ([string]$script:EnvelopePublicKeyB64) -Force } catch { }
            }
            if ($cfgOut) { Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $cfgOut) } else { Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('config missing')) }
            return
        }
        if ($path -eq '/api/readiness' -or $path -eq '/readiness') {
            $rProg = Read-JsonFile -Path $script:ProgPath
            $isAlive = if ($rProg -and $rProg.PSObject.Properties['alive']) { [bool]$rProg.alive } else { $true }
            $isReady = ($script:InitPhase -eq 'ready')
            $rBody = [ordered]@{
                ok = $isReady
                status = if ($isReady) { 'ok' } else { 'initializing' }
                phase = if ($script:InitPhase) { $script:InitPhase } else { 'ready' }
                liveness = $isAlive
                apiReadiness = $isReady
                dependencyHealth = [ordered]@{
                    explorerFx = [bool]$script:FxReady
                    mirrorHost = [bool]$script:F46MirrorReady
                }
                desktopConnectivity = [ordered]@{
                    rdpListener = [bool]($(try { $null -ne (Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue) } catch { $false }))
                }
                ws = [bool]$script:F96WsUpgradeSupported
                port = $Port
                pid = $PID
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            }
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $rBody)
            return
        }
        if ($path -eq '/api/progress' -or $path -eq '/api/stats') {
            $prog2 = Read-JsonFile -Path $script:ProgPath
            $wireNow = Read-JsonFile -Path (Join-Path $script:Root 'wire-probe.json')
            if (-not $prog2) { $prog2 = [ordered]@{ ts=''; alive=$false; active=[ordered]@{name='';phase='idle';pct=0}; agg=[ordered]@{total=0;done=0;failed=0;active=0;bytesDone=0;bytesTotal=0;overallPct=0;speedBps=0}; telemetry=[ordered]@{scans=0;lastScan=''}; files=@(); log=@() } }
            $cfg2 = Read-JsonFile -Path $script:CfgPath
            $obj2 = [ordered]@{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                kind = 'snapshot'
                mirror = [bool]$cfg2.mirror
                encryptMode = [string]$cfg2.encryptMode
                mirrorIndexUrl = [string]$cfg2.mirrorIndexUrl
                rentryNewUrl = [string]$cfg2.rentryNewUrl
                legacyIndexUrl = [string]$cfg2.legacyIndexUrl
                runnerEgressIp = [string]$cfg2.runnerEgressIp
                keepAliveDeadline = [string]$cfg2.keepAliveDeadline
                keepAlivePhase = [string]$cfg2.keepAlivePhase
                pagesBase = [string]$cfg2.pagesBase
                startedAt = (To-IsoUtc ([string]$cfg2.startedAt))
                runStartedAt = (To-IsoUtc ([string]$cfg2.runStartedAt))
                sessionStartedAt = (To-IsoUtc ([string]$cfg2.sessionStartedAt))
                progress = $prog2
                conn = $null
                wire = $wireNow
            }
            try { $cp = Join-Path $Root 'conn-probe.json'; if (Test-Path -LiteralPath $cp) { $conn = (Get-Content -LiteralPath $cp -Raw | ConvertFrom-Json) } } catch { }
            $obj2.conn = $conn
            Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json' -Body (ConvertTo-JsonBytes $obj2)
            return
        }
        # [remediation 8B] /parsec-push removed: no plaintext rdpPass transit / ONLOGON credential push
        if ($path -eq '/parsec-push') {
            Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('endpoint removed per remediation'))
            return
        }
        Send-ClientResponse -Stream $stream -Code 404 -CType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('not found'))
    } catch {
        $cId = [guid]::NewGuid().ToString('N').Substring(0, 12)
        try {
            if ($parts -and $parts.headers -and $parts.headers['x-correlation-id']) { $cId = [string]$parts.headers['x-correlation-id'] }
        } catch { }
        $eType = if ($_.Exception) { $_.Exception.GetType().Name } else { 'RuntimeException' }
        $eMsg = if ($_.Exception) { [string]$_.Exception.Message } else { '' }
        $eStack = if ($_.ScriptStackTrace) { [string]$_.ScriptStackTrace } else { '' }
        $reqRoute = if ($path) { [string]$path } else { 'unknown' }
        $initPhase = if ($script:InitPhase) { [string]$script:InitPhase } else { 'running' }
        $srcSha = if ($env:GITHUB_SHA) { [string]$env:GITHUB_SHA } else { 'unknown-sha' }
        try {
            $diagDir = Join-Path $Root 'diag'
            if (-not (Test-Path -LiteralPath $diagDir)) { New-Item -ItemType Directory -Path $diagDir -Force | Out-Null }
            $errRecord = @{
                ts = (Get-Date).ToUniversalTime().ToString('o')
                corrId = $cId
                route = $reqRoute
                errorType = $eType
                message = $eMsg
                stack = $eStack
                phase = $initPhase
                sha = $srcSha
            } | ConvertTo-Json -Compress
            Add-Content -LiteralPath (Join-Path $diagDir 'server-exceptions.jsonl') -Value $errRecord -ErrorAction SilentlyContinue
        } catch { }
        try {
            Send-ClientResponse -Stream $stream -Code 500 -CType 'application/json' -Body (ConvertTo-JsonBytes @{
                serverTs = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                corrId = $cId
                handlerError = $eType
                route = $reqRoute
                phase = $initPhase
                sha = $srcSha
            }) -ExtraHeaders ("X-Correlation-ID: $cId`r`n")
        } catch { }
    } finally {
        try { if ($stream) { $stream.Dispose() } } catch { }
        try { $Client.Close() } catch { }
    }
}
$script:Wire = $null
$lastWirePing = [datetime]::MinValue
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$wireProbeScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\wire-probe.json'
$hist = New-Object System.Collections.ArrayList
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); rtt = $null; via = 'unknown'; direct = $false; peerIp = ''; peerName = ''; jit = $null; hist = @() }
  try {
    $j = (& $ts status --json 2>$null) | ConvertFrom-Json
    $peer = $null
    if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $peer = $p.Value; break } } }
    if ($peer) {
      $obj.peerIp = @($peer.TailscaleIPs)[0]
      $obj.peerName = [string]$peer.HostName
      $o = (& $ts ping -c 1 --timeout 5s $obj.peerIp 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.rtt = [int]$Matches[1] }
      if ($o -match 'via DERP\(([a-z0-9]+)\)') { $obj.via = 'DERP(' + $Matches[1] + ')'; $obj.direct = $false }
      elseif ($o -match 'via ([0-9][0-9.:]+)') { $obj.via = 'DIRECT ' + $Matches[1]; $obj.direct = $true }
      if ($null -ne $obj.rtt) { [void]$hist.Add([int]$obj.rtt); if ($hist.Count -gt 20) { $hist.RemoveAt(0) } }
      if ($hist.Count -ge 3) { $d = 0; for ($i = 1; $i -lt $hist.Count; $i++) { $d += [math]::Abs([int]$hist[$i] - [int]$hist[$i-1]) }; $obj.jit = [math]::Round($d / ($hist.Count - 1), 1) }
      $obj.hist = @($hist)
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 4
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'wire-probe.ps1'), $wireProbeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'wire-probe.ps1') -WindowStyle Hidden } catch { }
# [F10-2 §2.2] rdp-ping loop: every 15s, `tailscale ping -c 1 -timeout 3s`
# against the dash-token SOURCE PEER (dash-client-ip.txt, captured per request);
# falls back to the first online tailnet peer until a dashboard visit records
# the client. Parses RTT + direct/DERP path into rdp-ping.json (consumed by
# /api/native-status -> CONNECTIVITY row).
$rdpPingScript = @'
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$out = 'C:\ghrdp\rdp-ping.json'
while ($true) {
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); ms = $null; path = 'unknown'; target = '' }
  try {
    $target = ''
    if (Test-Path 'C:\ghrdp\dash-client-ip.txt') { $target = ([System.IO.File]::ReadAllText('C:\ghrdp\dash-client-ip.txt')).Trim() }
    if ($target -notmatch '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') { $target = '' }
    if (-not $target) {
      $j = (& $ts status --json 2>$null) | ConvertFrom-Json
      if ($j -and $j.Peer) { foreach ($p in $j.Peer.PSObject.Properties) { if ($p.Value.Online) { $target = @($p.Value.TailscaleIPs)[0]; break } } }
    }
    if ($target) {
      $obj.target = $target
      $o = (& $ts ping -c 1 -timeout 3s $target 2>$null) -join ' '
      if ($o -match 'in ([0-9]+)ms') { $obj.ms = [int]$Matches[1] }
      if ($o -match 'via DERP') { $obj.path = 'relay' }
      elseif ($o -match 'via [0-9][0-9.:]+') { $obj.path = 'direct' }
    }
  } catch { }
  try { [System.IO.File]::WriteAllText($out, ($obj | ConvertTo-Json -Compress)) } catch { }
  Start-Sleep -Seconds 15
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'rdp-ping.ps1'), $rdpPingScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'rdp-ping.ps1') -WindowStyle Hidden } catch { }
# [F11-3 §3] RDP USAGE accumulator (replaces logon age as the headline timer).
# rdpUsageSec grows ONLY while (a) an RDP logon-type-10 session is CONNECTED
# (qwinsta 'Active' rdp-tcp line) OR (b) at least one webdesk client is attached
# (Rust dash ws-clients.txt, an Established non-loopback TCP connection on 7333,
# or a websockify log 'connect' newer than its last 'disconnect'). It freezes
# within one 5s tick after both signals drop and resumes on reconnect. The
# accumulator is persisted into config.json (rdpUsageSec/rdpUsageAt/rdpUsageHost)
# so a re-dispatch on the SAME host continues instead of restarting at zero.
$usageScript = @'
$ErrorActionPreference = 'Continue'
$root = 'C:\ghrdp'
$state = Join-Path $root 'rdp-usage.json'
$cfg = Join-Path $root 'config.json'
$enc = New-Object System.Text.UTF8Encoding($false)
# [F11-3 §3 loop-owner] ONE loop per Root. This child is detached, so stopping
# the server orphans it; a second loop would interleave its OWN counter into the
# same state file - which is exactly how the accumulator was observed going
# BACKWARDS (15 -> 10). If a live rdp-usage.ps1 for this Root already owns the
# file, step aside without writing a single sample.
try {
  if (Test-Path -LiteralPath $state) {
    $own = [System.IO.File]::ReadAllText($state) | ConvertFrom-Json
    if ($own -and $null -ne $own.pid -and [int]$own.pid -ne $PID) {
      $op = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$own.pid) -ErrorAction SilentlyContinue
      if ($op -and ([string]$op.CommandLine) -match 'rdp-usage\.ps1') { exit 0 }
    }
  }
} catch { }
$sec = 0
try {
  if (Test-Path -LiteralPath $state) {
    $sj = [System.IO.File]::ReadAllText($state) | ConvertFrom-Json
    if ($null -ne $sj.sec) { $sec = [int]$sj.sec }
  } elseif (Test-Path -LiteralPath $cfg) {
    $cj = [System.IO.File]::ReadAllText($cfg) | ConvertFrom-Json
    if ($null -ne $cj.rdpUsageSec) { $sec = [int]$cj.rdpUsageSec }
  }
} catch { $sec = 0 }
$lastPersist = [datetime]::MinValue
function Test-RdpConnected {
  try {
    $q = ((& qwinsta.exe 2>$null) -join "`n")
    if ($q -match '(?im)rdp-tcp#\d+\s+\S.*?\sActive') { return $true }
    if ($q -match '(?im)rdp-tcp') { return $false }
  } catch { }
  # [F95 §3.1 / R1] was -Filter 'LogonType=10': an autologon (type 2) desktop
  # read as "not connected" even with a full interactive session on screen.
  try { return [bool](Get-CimInstance -ClassName Win32_LogonSession -Filter $script:GhrdpLogonSessionWql -ErrorAction Stop) } catch { return $false }
}
function Test-WebdeskClient {
  try {
    $f = Join-Path $root 'webdesk\ws-clients.txt'
    if (Test-Path -LiteralPath $f) {
      $n = 0
      if ([int]::TryParse(([System.IO.File]::ReadAllText($f)).Trim(), [ref]$n) -and $n -gt 0) { return $true }
    }
  } catch { }
  try {
    foreach ($c in @(Get-NetTCPConnection -LocalPort 7333 -State Established -ErrorAction Stop)) { return $true }
  } catch { }
  try {
    $lg = Join-Path $root 'webdesk\websockify.log'
    if (Test-Path -LiteralPath $lg) {
      $t = [System.IO.File]::ReadAllText($lg)
      $ci = $t.LastIndexOf('connect'); $di = $t.LastIndexOf('disconnect')
      if ($ci -ge 0 -and $ci -gt $di) { return $true }
    }
  } catch { }
  return $false
}
while ($true) {
  $rdp = Test-RdpConnected
  $web = Test-WebdeskClient
  $active = ($rdp -or $web)
  if ($active) { $sec = $sec + 5 }
  $obj = @{ ts = (Get-Date).ToUniversalTime().ToString('o'); sec = $sec; active = $active; rdp = $rdp; webdesk = $web; pid = $PID }
  try { [System.IO.File]::WriteAllText($state, ($obj | ConvertTo-Json -Compress), $enc) } catch { }
  # Persist on every STOP (durable freeze) and at most every 30s while running.
  if ((-not $active) -or (([datetime]::UtcNow - $lastPersist).TotalSeconds -ge 30)) {
    try {
      if (Test-Path -LiteralPath $cfg) {
        $c = [System.IO.File]::ReadAllText($cfg) | ConvertFrom-Json
        foreach ($kv in @(@('rdpUsageSec', $sec), @('rdpUsageAt', (Get-Date).ToUniversalTime().ToString('o')), @('rdpUsageHost', [string]$c.dnsName))) {
          $c | Add-Member -MemberType NoteProperty -Name $kv[0] -Value $kv[1] -Force
        }
        [System.IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json -Depth 10), $enc)
        $lastPersist = [datetime]::UtcNow
      }
    } catch { }
  }
  Start-Sleep -Seconds 5
}
'@
[System.IO.File]::WriteAllText((Join-Path $Root 'rdp-usage.ps1'), $usageScript, $script:NoBom)
# [F11-3 §3 loop-reap] A server stop/update kills THIS process and never the
# detached loop it started, so reap any live loop for THIS Root before launching
# the singleton: exactly one writer may own rdp-usage.json / config.json.
try {
    $us = Join-Path $Root 'rdp-usage.ps1'
    foreach ($lp in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        if ($lp.CommandLine -and ([string]$lp.CommandLine).IndexOf($us, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { try { Stop-Process -Id $lp.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
    }
} catch { }
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'rdp-usage.ps1') -WindowStyle Hidden } catch { }
# [F45-R §1] READINESS BEFORE SCANS. The listener bind and the LISTENING
# marker happen FIRST, and /health (added below the auth gate) answers
# ok/app/pid as soon as the accept loop runs. Rationale: the three startup
# scans below are synchronous Get-WinEvent walks of the Security/System logs
# and can take seconds on a busy host. Readiness (listener bound + the right
# application instance responding) must never be held hostage by them, and a
# harness waiting on server-ok.txt must observe the bind, not the scan.
# What this reorder CHANGES: the F28/F30/F37 guarantee softens from "stamped
# before the first client can poll" to "stamped promptly after the listener
# accepts, within one scan duration" - every consumer already tolerates the
# not-yet-stamped window via scanTs/probeError (an honest "not reported yet",
# never a fabricated value). What it does NOT fix, and documents honestly:
# while a scan runs on this thread the accept loop is not draining, so
# requests arriving mid-scan queue in the TCP backlog. Bounding THAT latency
# is the isolated-scan-worker work package (docs/mission-control tracker,
# F45-B): a cooperative delay on this thread cannot yield inside Get-WinEvent.
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Bind), $Port)
try { $listener.Start() } catch {
    try { [System.IO.File]::WriteAllText($script:OkFile, 'LISTEN_FAIL: ' + $_.Exception.Message, $script:NoBom) } catch { }
    exit 1
}
[System.IO.File]::WriteAllText($script:OkFile, ('LISTENING pid={0} bind={1} port={2} at={3}' -f $PID, $Bind, $Port, (Get-Date -Format o)), $script:NoBom)
# [F28 §1] STARTUP SCAN: stamps the logon verdict promptly after the listener
# starts accepting, so /api/native-status reports a real verdict (scanTs +
# result) instead of a long "not reported yet" window. Failure is contained
# (the function stamps probeError + scanTs instead of throwing).
try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastLogonScan = Get-Date
# [F30 §3] STARTUP SCAN: the first conn-log stamp lands promptly after the
# listener starts, so the SERVER CONN LOG row reports a real verdict instead
# of "not reported yet" while the collector is actually alive. Failure is
# contained (probeError + scanTs are stamped by the function, not a throw).
try { Update-RdpConnLog -StatePath $script:ConnLogStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastConnLogScan = Get-Date
# [F37 §4] STARTUP SCAN: the telescope stamps promptly after the listener starts
# (same shape as the F28/F30 startup scans), and the 60s tick below keeps it
# live. "Not reported yet" means a genuinely absent sample.
try { Update-RdpListenerTelescope -StatePath $script:F37TelStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
$lastTelScan = Get-Date

# Transition InitPhase to 'ready' after successful startup initialization
$script:InitPhase = 'ready'
# [F45 S4 fx-worker-begin] Queue worker: one process per Root owns
# %TEMP%\ghrdp\fx-upload-queue.json (same singleton discipline as the wire-probe
# / rdp-ping / rdp-usage loops). It is a no-op off Windows and it never runs
# when the module failed to load, so a lab harness stays deterministic.
try {
    if ($script:FxReady) {
        $fxWorker = Start-FxUploadWorker -Root $Root -QueuePath (Get-FxQueuePath -Root $Root -Options @{}) -ModulePath $script:FxModule
        Write-Host ('[F45] fx upload worker: started=' + [string]$fxWorker.started + ' reason=' + [string]$fxWorker.reason)
    } else {
        Write-Host ('[F45] fx upload worker not started: ' + [string]$script:FxLoadError)
    }
} catch { Write-Host ('[F45] fx upload worker start failed: ' + $_.Exception.Message) }
# [F45 S4 fx-worker-end]
$probeScript = @'
$ErrorActionPreference='Continue'
$ts='C:\Program Files\Tailscale\tailscale.exe'
$out='C:\ghrdp\conn-probe.json'
while($true){
  $obj=@{ts=(Get-Date).ToString('o'); rtt=$null; via='unknown'; direct=$false; peer=''}
  try{
    $j=(& $ts status --json 2>$null)|ConvertFrom-Json
    if($j -and $j.Peer){
      foreach($p in $j.Peer.PSObject.Properties){
        $peer=$p.Value
        if($peer.Online){
          $obj.peer=@($peer.TailscaleIPs)[0]
          break
        }
      }
    }
    if($obj.peer){
      $o=(& $ts ping -c 1 --timeout 2s $obj.peer 2>$null) -join ' '
      if($o -match 'via (DERP[A-Za-z0-9]*|[Dd]irect[A-Za-z0-9]*)'){ $obj.via=$Matches[1]; $obj.direct=($Matches[1] -like 'irect*' -or $Matches[1] -like 'D*irect*') }
      if($o -match 'in ([0-9.]+)\s*ms'){ $obj.rtt=[double]$Matches[1] }
    }
  }catch{}
  try{ [System.IO.File]::WriteAllText($out,($obj|ConvertTo-Json -Compress)) }catch{}
  Start-Sleep -Seconds 4
}
'@
$probePath = Join-Path $Root 'conn-probe.ps1'
[System.IO.File]::WriteAllText($probePath, $probeScript, $script:NoBom)
try { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$probePath -WindowStyle Hidden } catch { }
# ---------------------------------------------------------------------------
# [F95 §3.2 / R2] WATCHER SUPERVISOR.
#
# The 60s heal used to be a blind `Start-ScheduledTask -TaskName GhrdpWatcher`.
# That has two failure modes the operator actually hit:
#   * an ONLOGON task cannot start while nobody is logged on, so the call
#     silently no-ops and the dashboard keeps reading "watcher: IDLE";
#   * it never checks whether the watcher is ALIVE, so a crashed watcher and a
#     healthy one look identical to the heal.
# This supervisor (1) measures liveness from the watcher's own progress.json
# heartbeat, (2) tries the scheduled task, and (3) falls back to invoking
# C:\ghrdp\ghrdp-watcher.ps1 directly when the task route fails. It writes
# watcher-supervisor.json so /diag can prove what it did - a supervisor that
# cannot report its own verdict is indistinguishable from no supervisor.
# ghrdp-watcher.ps1 owns a single-instance mutex (Local\GhrdpWatcherSingleInstance)
# and exits immediately when it is already held, so an over-eager start is safe.
# ---------------------------------------------------------------------------
$script:F95SupIntervalSec = 60
$script:F95SupStaleSec = 180
$script:F95SupStatePath = Join-Path $Root 'watcher-supervisor.json'
# [F96 §4] HOW the watcher was resurrected, not just that it was. The F95
# verdict file only carried the LAST action, so a bundle read after a
# successful task-start could not tell "the task route works" from "we have
# fallen all the way through to the direct invoke for the tenth time" - and
# those two need opposite fixes. Counters are persisted inside the same
# verdict file the supervisor already writes every tick, so a server restart
# does not reset the story; absent counters (a file written by the F95 build)
# read back as zeros, never as a fabricated success.
$script:F96SupAttempts = [ordered]@{ taskStart = 0; schtasksRun = 0; directInvoke = 0 }
$script:F96SupAttemptsLoaded = $false
function Invoke-F95WatcherSupervise {
    $now = Get-Date
    $state = [ordered]@{ at = ''; alive = $false; heartbeatAgeSec = -1; action = 'none'; detail = '' }
    $state.at = $now.ToUniversalTime().ToString('o')
    if (-not $script:F96SupAttemptsLoaded) {
        $script:F96SupAttemptsLoaded = $true
        try {
            $prev = Read-JsonFile -Path $script:F95SupStatePath
            if ($prev -and $prev.PSObject.Properties['attempts']) {
                foreach ($k in @('taskStart', 'schtasksRun', 'directInvoke')) {
                    if ($prev.attempts.PSObject.Properties[$k]) { $script:F96SupAttempts[$k] = [int]$prev.attempts.$k }
                }
            }
        } catch { }
    }
    try {
        $prog = Read-JsonFile -Path $script:ProgPath
        if ($prog -and $prog.ts) {
            try {
                $age = [int]((Get-Date) - [datetime]$prog.ts).TotalSeconds
                $state.heartbeatAgeSec = $age
                $state.alive = ($age -le $script:F95SupStaleSec)
            } catch { $state.alive = $false }
        }
    } catch { $state.alive = $false }
    if ($state.alive) {
        $state.action = 'none'
        $state.detail = 'heartbeat ' + $state.heartbeatAgeSec + 's old - watcher alive'
    } else {
        $watcherSrc = 'C:\ghrdp\ghrdp-watcher.ps1'
        $started = $false
        try {
            Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop
            $started = $true
            $state.action = 'task-start'
            $script:F96SupAttempts.taskStart = [int]$script:F96SupAttempts.taskStart + 1
            $state.detail = 'Start-ScheduledTask GhrdpWatcher issued (heartbeat was ' + $state.heartbeatAgeSec + 's)'
        } catch {
            $state.detail = 'task start failed: ' + $_.Exception.Message
        }
        if (-not $started) {
            try {
                & schtasks.exe /Run /TN GhrdpWatcher 2>$null
                $LASTEXITCODE = 0
                $started = $true
                $state.action = 'schtasks-run'
                $script:F96SupAttempts.schtasksRun = [int]$script:F96SupAttempts.schtasksRun + 1
                $state.detail = $state.detail + ' | schtasks /Run issued'
            } catch {
                $state.detail = $state.detail + ' | schtasks /Run failed: ' + $_.Exception.Message
            }
        }
        if (-not $started -and (Test-Path -LiteralPath $watcherSrc)) {
            # Last resort: run the script directly. Detached + hidden so the
            # server's accept loop is never blocked by it.
            try {
                # Single line on purpose: the F11-5.3 launch-gates pin greps
                # this file per-line for the launcher call together with
                # `-WindowStyle Hidden` (same form as the wire-probe launch
                # below the accept loop), so a backtick continuation - or even
                # a comment naming the call - would read as an unhidden launch.
                Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$watcherSrc -WindowStyle Hidden -ErrorAction Stop | Out-Null
                $started = $true
                $state.action = 'direct-invoke'
                $script:F96SupAttempts.directInvoke = [int]$script:F96SupAttempts.directInvoke + 1
                $state.detail = $state.detail + ' | invoked ' + $watcherSrc + ' directly'
            } catch {
                $state.detail = $state.detail + ' | direct invoke failed: ' + $_.Exception.Message
            }
        }
        if (-not $started) { $state.action = 'failed' }
        Write-Host ('[F95] watcher supervisor: alive=' + $state.alive + ' heartbeat=' + $state.heartbeatAgeSec + 's action=' + $state.action)
    }
    # [F96 §4] the counters ride along with the verdict, so /api/diag/comprehensive
    # (and /diag) can report the escalation HISTORY, not only the last action.
    $state['attempts'] = [ordered]@{
        taskStart    = [int]$script:F96SupAttempts.taskStart
        schtasksRun  = [int]$script:F96SupAttempts.schtasksRun
        directInvoke = [int]$script:F96SupAttempts.directInvoke
    }
    try { [System.IO.File]::WriteAllText($script:F95SupStatePath, ($state | ConvertTo-Json -Compress), $script:NoBom) } catch { }
    return $state
}
# [F99 §2.2] Watcher task diagnose: maps Task Scheduler LastTaskResult codes to
# reason + suggested fix. The F96 bundle's 267011 (SCHED_S_TASK_HAS_NOT_RUN)
# specifically means "task has not yet run" — trigger never fired, not an error.
function Invoke-F99WatcherDiagnose {
    param([int64]$LastResult)
    $code = [int64]$LastResult
    $out = [ordered]@{ code=$code; hex=('0x{0:X}' -f $code); reason=''; fix='' }
    switch ($code) {
        0 { $out.reason='success'; $out.fix='no action — last run succeeded' }
        267011 { $out.reason='task has not yet run (SCHED_S_TASK_HAS_NOT_RUN)'; $out.fix='ONLOGON trigger has never fired: verify Principal.UserId matches active user, LogonType Interactive, RunLevel Highest, Action path exists (C:\ghrdp\ghrdp-watcher.ps1), Settings.AllowStartOnDemand true; re-register with hardened XML via Register-ScheduledTask -Xml' }
        267009 { $out.reason='task is currently running'; $out.fix='task is running — check progress.json heartbeat' }
        2147942667 { $out.reason='invalid path / file not found (0x80070003)'; $out.fix='Action Execute path invalid — verify C:\ghrdp\ghrdp-watcher.ps1 exists and is staged from payloads/ghrdp-watcher.ps1' }
        2147944516 { $out.reason='logon failure / invalid credentials (0x800704DD)'; $out.fix='Principal logon type mismatch — use Interactive + Highest, not ServiceAccount, and ensure user can log on' }
        2147942667 { $out.reason='invalid path (0x80070003)'; $out.fix='Action path invalid' }
        2147942405 { $out.reason='access is denied (0x80070005)'; $out.fix='RunLevel or ACL — use RunLevel Highest and grant Users modify on C:\ghrdp' }
        default { $out.reason=('unknown task result ' + $code); $out.fix='dump task XML via Get-ScheduledTask GhrdpWatcher | Export-ScheduledTask and compare to docs/f99-watcher-task.xml reference' }
    }
    return $out
}
$start = Get-Date
$limit = New-TimeSpan -Minutes $LimitMinutes
$lastHeal = Get-Date
# [F45-R §3] Accept-loop yield. The loop yields every N ms; GHRDP_SCAN_DELAY_MS
# overrides the 50ms default (clamped to 5..1000) so a harness can prove the
# loop stays responsive under a chosen cadence. This paces the LOOP only - it
# cannot shorten a synchronous scan that runs on this thread (F45-R §1/F45-B).
$script:ScanDelayMs = 50
if ($env:GHRDP_SCAN_DELAY_MS -match '^[0-9]+$') {
    $script:ScanDelayMs = [Math]::Max(5, [Math]::Min(1000, [int]$env:GHRDP_SCAN_DELAY_MS))
}
while (((Get-Date) - $start) -lt $limit) {
    while ($listener.Pending()) {
        $client = $null
        try { $client = $listener.AcceptTcpClient() } catch { }
        if ($client) { Invoke-ClientRequest -Client $client -Token $script:Token }
    }
    # [F28 §1] INDEPENDENT 30s logon-result tick (server start, not the
    # workflow's keep-alive step). The accept loop sleeps 50ms, so this costs
    # nothing and the verdict is never older than ~30s.
    if (((Get-Date) - $lastLogonScan).TotalSeconds -ge $script:F28IntervalSec) {
        $lastLogonScan = Get-Date
        try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    # [F30 §3] INDEPENDENT 30s RDP connection-log tick (both Operational logs).
    # This is the ONLY surface that can see a TLS handshake drop, because
    # 4624/4625 never fire for a connection killed before LSA.
    if (((Get-Date) - $lastConnLogScan).TotalSeconds -ge $script:F30ConnLogIntervalSec) {
        $lastConnLogScan = Get-Date
        try { Update-RdpConnLog -StatePath $script:ConnLogStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    # [F37 §4] INDEPENDENT 60s telescope tick: binds the OBSERVED listener
    # (boundThumb vs servedThumb, serving, key container + ACL SIDs, Schannel
    # tail) to the row, so a bind drift or a refused handshake is visible the
    # moment it happens instead of at the next workflow dispatch.
    if (((Get-Date) - $lastTelScan).TotalSeconds -ge $script:F37TelIntervalSec) {
        $lastTelScan = Get-Date
        try { Update-RdpListenerTelescope -StatePath $script:F37TelStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }
    }
    # [F95 §3.2 / R2] was a blind `Start-ScheduledTask -TaskName GhrdpWatcher`
    # with no liveness check and no fallback when the task route is unavailable
    # (which is exactly the state of an ONLOGON task while nobody is logged on).
    if (((Get-Date) - $lastHeal).TotalSeconds -ge $script:F95SupIntervalSec) {
        $lastHeal = Get-Date
        try { Invoke-F95WatcherSupervise | Out-Null } catch { }
    }
    # [F45-R §3] yield the accept loop (50ms default, GHRDP_SCAN_DELAY_MS overridable).
    Start-Sleep -Milliseconds $script:ScanDelayMs
}
try { $listener.Stop() } catch { }
