<#
.SYNOPSIS
Bounded, read-only RDP evidence from the EPHEMERAL hosted server, collected
AFTER the client job finished (the VM is still alive; the backend is stopped).

.DESCRIPTION
Answers one question with server-side ground truth: did the intended RDP
logon actually happen, or did the observer/verifier chain fail to see it?
Collects, for a bounded recent window only:
  * the lab account's state and the effective Audit Logon setting
  * TermService state, the 3389 listener, the tailnet-only firewall rule
  * Security 4624/4625 rows for the lab user (XML <Data> parsed by name:
    TargetUserName, LogonType, IpAddress, Status/SubStatus) with record ids
  * TerminalServices LocalSessionManager (21/22/24/25) and
    RemoteConnectionManager (261/1149) rows
  * qwinsta/quser session lines and the GhrdpWebDesk task state
Emits a JSON document (-Out) plus sanitized one-line annotations (job logs
and artifacts are not reachable from every driving tool; annotations are).
Never prints a password. Each section fails independently; the script always
exits 0 - it is a collector, not a gate.
#>
param(
    [string]$User = 'slabrdp',
    [int]$SinceMinutes = 30,
    [string]$Out = ''
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Protect-Annotation([string]$s) {
    if ($null -eq $s) { return '' }
    return ($s -replace '%', '%25' -replace "`r", '%0D' -replace "`n", '%0A')
}
function Write-Annot([string]$level, [string]$title, [string]$msg) {
    $m = Protect-Annotation $msg
    if ($m.Length -gt 1400) { $m = $m.Substring(0, 1400) + '...[truncated]' }
    Write-Host "::$level title=$title::$m"
}
function Get-EventDataMap($ev) {
    $map = @{}
    try {
        $xml = [xml]$ev.ToXml()
        foreach ($d in @($xml.SelectNodes("//*[local-name()='Data']"))) {
            $n = [string]$d.GetAttribute('Name')
            if ($n) { $map[$n] = [string]$d.InnerText }
        }
        foreach ($d in @($xml.SelectNodes("//*[local-name()='UserData']/*/*"))) {
            $n = [string]$d.LocalName
            if ($n -and -not $map.ContainsKey($n)) { $map[$n] = [string]$d.InnerText }
        }
    } catch { }
    return $map
}

$doc = [ordered]@{ collectedAtUtc = [DateTime]::UtcNow.ToString('o'); user = $User; sinceMinutes = $SinceMinutes }

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    Write-Annot 'error' 'RDP diagnostics' 'REFUSED: Collect-RdpDiagnostics only runs on GitHub-hosted runners (it reads the Security log)'
    exit 0
}

# ---- account + audit -------------------------------------------------------
try {
    $acct = Get-LocalUser -Name $User -ErrorAction Stop
    $doc.account = @{
        exists             = $true
        enabled            = [bool]$acct.Enabled
        remoteDesktopUsers = [bool](Get-LocalGroupMember -Group 'Remote Desktop Users' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\\$User$" })
        administrators     = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\\$User$" })
    }
} catch { $doc.account = @{ exists = $false; error = $_.Exception.Message } }

try {
    $txt = (& auditpol.exe /get /subcategory:Logon 2>&1 | Out-String)
    $line = ($txt -split "`r?`n" | Where-Object { $_ -match '^\s*Logon\s{2,}\S' } | Select-Object -First 1)
    $doc.auditLogon = if ($line) { ($line -replace '^\s*Logon\s+', '').Trim() } else { 'unparsed: ' + ($txt.Trim() -replace '\s+', ' ') }
} catch { $doc.auditLogon = 'error: ' + $_.Exception.Message }

# ---- service / listener / firewall ----------------------------------------
try { $doc.termService = [string](Get-Service -Name TermService -ErrorAction Stop).Status } catch { $doc.termService = 'error: ' + $_.Exception.Message }
try {
    $l = @(Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue)
    $doc.listener3389 = @($l | ForEach-Object { [string]$_.LocalAddress })
} catch { $doc.listener3389 = @(); $doc.listenerError = $_.Exception.Message }
try {
    $rule = Get-NetFirewallRule -Name 'slab-rdp-3389' -ErrorAction Stop
    $addr = $rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
    $doc.firewall3389 = @{ enabled = [string]$rule.Enabled; profile = [string]$rule.Profile; remoteAddress = @($addr.RemoteAddress) }
} catch { $doc.firewall3389 = @{ error = $_.Exception.Message } }

$since = [DateTime]::Now.AddMinutes(-1 * $SinceMinutes)

# ---- Security 4624/4625 -----------------------------------------------------
# Zero matching events, an unavailable channel and access denial are three
# different facts (see scripts/lib/eventlog.js); "no events matched" is never
# reported as "channel unreadable", and missing events are never proof that no
# connection was attempted.
$secRows = @()
try {
    $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(4624, 4625); StartTime = $since } -MaxEvents 120 -ErrorAction Stop)
    $doc.securityLogState = 'readable'
    $doc.securityCounts = @{
        total4624 = @($raw | Where-Object { $_.Id -eq 4624 }).Count
        total4625 = @($raw | Where-Object { $_.Id -eq 4625 }).Count
    }
    foreach ($ev in $raw) {
        $d = Get-EventDataMap $ev
        $u = [string]$d['TargetUserName']
        $lt = [string]$d['LogonType']
        if ($u -ne $User -and $lt -ne '10') { continue }
        $secRows += [ordered]@{
            id         = [int]$ev.Id
            recordId   = [long]$ev.RecordId
            timeUtc    = $ev.TimeCreated.ToUniversalTime().ToString('o')
            user       = $u
            domain     = [string]$d['TargetDomainName']
            logonType  = $lt
            ipAddress  = [string]$d['IpAddress']
            status     = [string]$d['Status']
            subStatus  = [string]$d['SubStatus']
        }
        if ($secRows.Count -ge 12) { break }
    }
} catch {
    $fqid = [string]$_.FullyQualifiedErrorId
    $emsg = [string]$_.Exception.Message
    if ($emsg -match 'No events were found that match the specified selection criteria' -or $fqid -like 'NoMatchingLogsFound*') {
        $doc.securityLogState = 'readable'
        $doc.securityCounts = @{ total4624 = 0; total4625 = 0 }
        $doc.securityZeroMatchingEvents = $true
    } elseif ($emsg -match 'Access is denied|UnauthorizedAccess' -or $fqid -match 'UnauthorizedAccess') {
        $doc.securityLogState = 'access-denied'
        $doc.securityError = $emsg
    } elseif ($emsg -match 'There is not an event log|does not exist' -or $fqid -match 'ContainerNotFound|LogNotFound') {
        $doc.securityLogState = 'channel-missing'
        $doc.securityError = $emsg
    } else {
        $doc.securityLogState = 'query-error'
        $doc.securityError = $emsg
    }
}
$doc.securityEvents = $secRows

# ---- TerminalServices session/connection logs -------------------------------
function Get-TsRows([string]$logName, [int[]]$ids, [int]$max) {
    $rows = @()
    try {
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; Id = $ids; StartTime = $since } -MaxEvents $max -ErrorAction Stop)
        foreach ($ev in $raw) {
            $d = Get-EventDataMap $ev
            $rows += [ordered]@{
                log       = ($logName -split '-')[-1]
                id        = [int]$ev.Id
                recordId  = [long]$ev.RecordId
                timeUtc   = $ev.TimeCreated.ToUniversalTime().ToString('o')
                user      = [string]($d['User'], $d['UserName'], $d['Param1'] | Where-Object { $_ } | Select-Object -First 1)
                sessionId = [string]($d['SessionID'], $d['SessionId'] | Where-Object { $_ } | Select-Object -First 1)
                address   = [string]($d['Address'], $d['ClientAddress'] | Where-Object { $_ } | Select-Object -First 1)
            }
        }
    } catch {
        $rows += [ordered]@{ log = ($logName -split '-')[-1]; error = $_.Exception.Message }
    }
    return $rows
}
$doc.tsLocalSessionManager = @(Get-TsRows 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' @(21, 22, 24, 25) 8)
$doc.tsRemoteConnectionManager = @(Get-TsRows 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational' @(261, 1149) 8)

# ---- live sessions + capture task ------------------------------------------
function Invoke-SessionTool([string]$exe) {
    try {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $txt = (& $exe 2>&1 | Out-String)
        $ErrorActionPreference = $prev
        $global:LASTEXITCODE = 0
        return @(($txt -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 8)
    } catch { return @('error: ' + $_.Exception.Message) }
}
$doc.qwinsta = @(Invoke-SessionTool 'qwinsta.exe')
$doc.quser = @(Invoke-SessionTool 'quser.exe')
try {
    $t = Get-ScheduledTask -TaskName 'GhrdpWebDesk' -ErrorAction Stop
    $i = Get-ScheduledTaskInfo -TaskName 'GhrdpWebDesk' -ErrorAction SilentlyContinue
    $doc.webdeskTask = @{
        state         = [string]$t.State
        lastRunUtc    = if ($i) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null }
        lastResult    = if ($i) { $i.LastTaskResult } else { $null }
        numberOfMissedRuns = if ($i) { $i.NumberOfMissedRuns } else { $null }
    }
} catch { $doc.webdeskTask = @{ error = $_.Exception.Message } }

# ---- emit --------------------------------------------------------------------
$json = $doc | ConvertTo-Json -Depth 6
if ($Out) {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Out, $json)
}
Write-Host $json

$forUser4624 = @($secRows | Where-Object { $_.id -eq 4624 -and $_.user -eq $User }).Count
$forUser4625 = @($secRows | Where-Object { $_.id -eq 4625 -and $_.user -eq $User }).Count
$summary = "termService=$($doc.termService) listener3389=[$($doc.listener3389 -join ',')] " +
    "fw3389 enabled=$($doc.firewall3389.enabled) remote=[$($doc.firewall3389.remoteAddress -join ',')] " +
    "account exists=$($doc.account.exists) enabled=$($doc.account.enabled) rdu=$($doc.account.remoteDesktopUsers) adm=$($doc.account.administrators) " +
    "auditLogon='$($doc.auditLogon)' securityLogState=$($doc.securityLogState) " +
    "window4624=$($doc.securityCounts.total4624) window4625=$($doc.securityCounts.total4625) forUser4624=$forUser4624 forUser4625=$forUser4625 " +
    "webdeskTask=$($doc.webdeskTask.state) lastRun=$($doc.webdeskTask.lastRunUtc) result=$($doc.webdeskTask.lastResult)"
Write-Annot 'notice' 'RDP server diagnostics' $summary

if ($secRows.Count) {
    $rowsTxt = ($secRows | ForEach-Object {
        "$($_.id) type=$($_.logonType) user=$($_.domain)\$($_.user) src=$($_.ipAddress) status=$($_.status) sub=$($_.subStatus) rec=$($_.recordId) @$($_.timeUtc)"
    }) -join '; '
    Write-Annot 'notice' 'RDP server security events' $rowsTxt
} else {
    Write-Annot 'warning' 'RDP server security events' "no 4624/4625 for user=$User (or LogonType 10) in the last $SinceMinutes min; securityLogState=$($doc.securityLogState) zeroMatching=$($doc.securityZeroMatchingEvents) error=$($doc.securityError) (missing events are not proof that no connection was attempted)"
}
$tsTxt = (@($doc.tsLocalSessionManager) + @($doc.tsRemoteConnectionManager) | ForEach-Object {
    if ($_.error) { "$($_.log) error=$($_.error)" } else { "$($_.log)/$($_.id) @$($_.timeUtc) user=$($_.user) sess=$($_.sessionId) addr=$($_.address) rec=$($_.recordId)" }
}) -join '; '
Write-Annot 'notice' 'RDP server TS + sessions' ("ts: $tsTxt | qwinsta: " + ($doc.qwinsta -join ' | ') + ' | quser: ' + ($doc.quser -join ' | '))
exit 0
