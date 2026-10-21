<#
.SYNOPSIS
Bounded, read-only evidence about what THIS machine's mstsc actually did.

.DESCRIPTION
Written after run 39569844830 attempt 1 (server logs proved no RDP connection
request ever arrived) and run 39575343527 attempt 2 (a known RDP-file consent
dialog was visible while the verdict burned 90s on a generic timeout and one
probe even reported hasWindow=false). Collects, for a bounded window starting
at mstsc launch:

  * Microsoft-Windows-TerminalServices-RDPClient/Operational rows (id, time,
    level, first message line) - mstsc's own account of the attempt. The raw
    query outcome is recorded WITHOUT conflation: zero matching events, an
    unavailable/absent channel, access denial and other query errors are
    different facts (scripts/lib/eventlog.js classifies them; "no events
    matched" is never reported as "channel unreadable").
  * the relevant top-level and owned/modal windows of the lab-launched
    process tree in the correct session, with identifiable control texts
    (delegated to Get-RdpDialogState.ps1 - window ownership and control text
    are what distinguish the RDP-file consent dialog from a publisher review,
    a certificate warning, a credentials prompt or a connection error;
    Process.MainWindowHandle is deliberately not trusted for this).
  * mstsc's TCP connections (was a socket to 3389 even opened? state?).
  * client RDP policy FACTS as integers/booleans only (saved-password and
    prompt policies, CredSSP saved-credential delegation allowlist
    presence/count/wildcard) - no hostnames from the operator's lists.

Emits one JSON line. Read-only; changes nothing on the client machine.
#>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$SinceUtc,
    [int]$SessionId = -1
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$doc = [ordered]@{ pid = $ProcessId; sinceUtc = $SinceUtc }
$sinceLocal = [DateTime]::MinValue
try { $sinceLocal = [DateTime]::Parse($SinceUtc).ToLocalTime() } catch { $sinceLocal = [DateTime]::Now.AddMinutes(-10) }

# ---- RDPClient operational log ---------------------------------------------
# Raw facts only. classifyEventQuery() in scripts/lib/eventlog.js owns the
# interpretation:
#   "No events were found that match the specified selection criteria."
#     (FullyQualifiedErrorId NoMatchingLogsFound)  -> zero matching events,
#     channel readable - NOT an error, NOT an unreadable channel.
#   "There is not an event log ... that matches"   -> channel-missing.
#   "Access is denied" / UnauthorizedAccess        -> access-denied.
#   anything else                                  -> query-error.
$logName = 'Microsoft-Windows-TerminalServices-RDPClient/Operational'
$doc.rdpClientLog = [ordered]@{
    listed = $false; listLogError = ''; listLogErrorId = ''; listLogExceptionType = ''
    queryError = ''; queryErrorId = ''; queryExceptionType = ''
    eventsMatched = $null; events = @()
}
try {
    $null = Get-WinEvent -ListLog $logName -ErrorAction Stop
    $doc.rdpClientLog.listed = $true
} catch {
    $doc.rdpClientLog.listLogError = $_.Exception.Message
    $doc.rdpClientLog.listLogErrorId = [string]$_.FullyQualifiedErrorId
    $doc.rdpClientLog.listLogExceptionType = [string]$_.Exception.GetType().FullName
}
if ($doc.rdpClientLog.listed) {
    try {
        $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $sinceLocal } -MaxEvents 30 -ErrorAction Stop)
        $doc.rdpClientLog.eventsMatched = $raw.Count
        $rows = @()
        foreach ($ev in $raw) {
            $first = ''
            try { $first = ([string]$ev.Message -split "`r?`n")[0].Trim() } catch { }
            if ($first.Length -gt 240) { $first = $first.Substring(0, 240) }
            $rows += [ordered]@{
                id        = [int]$ev.Id
                recordId  = [long]$ev.RecordId
                timeUtc   = $ev.TimeCreated.ToUniversalTime().ToString('o')
                level     = [string]$ev.LevelDisplayName
                message   = $first
            }
            if ($rows.Count -ge 12) { break }
        }
        $doc.rdpClientLog.events = $rows
    } catch {
        # zero matches lands here too - keep the raw error so the classifier
        # can tell it apart from a broken/unreadable channel
        $doc.rdpClientLog.queryError = $_.Exception.Message
        $doc.rdpClientLog.queryErrorId = [string]$_.FullyQualifiedErrorId
        $doc.rdpClientLog.queryExceptionType = [string]$_.Exception.GetType().FullName
    }
}

# ---- relevant top-level + owned/modal windows of the launched tree ----------
$doc.windows = @()
try {
    $enumScript = Join-Path $PSScriptRoot 'Get-RdpDialogState.ps1'
    $enumArgs = @{ ProcessId = $ProcessId; ErrorAction = 'Stop' }
    if ($SessionId -ge 0) { $enumArgs.SessionId = $SessionId }
    $enumOut = (& $enumScript @enumArgs | Out-String).Trim()
    $enum = $enumOut | ConvertFrom-Json
    if ($enum -and $enum.windows) { $doc.windows = @($enum.windows) }
    if ($enum -and $enum.enumError) { $doc.windowEnumError = [string]$enum.enumError }
} catch {
    $doc.windowEnumError = $_.Exception.Message
}

# ---- mstsc sockets ----------------------------------------------------------
$tcpRows = @()
try {
    foreach ($c in @(Get-NetTCPConnection -OwningProcess $ProcessId -ErrorAction SilentlyContinue)) {
        $tcpRows += [ordered]@{ remote = "$($c.RemoteAddress):$($c.RemotePort)"; state = [string]$c.State }
        if ($tcpRows.Count -ge 8) { break }
    }
} catch { $doc.tcpError = $_.Exception.Message }
$doc.tcpConnections = $tcpRows

# ---- client RDP policy facts (integers/booleans only) -----------------------
function Get-PolicyInt([string]$path, [string]$name) {
    try {
        $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name
        return [int]$v
    } catch { return $null }
}
function Get-DelegationFacts([string]$subKey) {
    $path = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation\$subKey"
    try {
        $item = Get-Item -Path $path -ErrorAction Stop
        $names = @($item.GetValueNames() | Where-Object { $_ })
        $wildcard = $false
        foreach ($n in $names) { if ([string]$item.GetValue($n) -eq 'TERMSRV/*') { $wildcard = $true } }
        return @{ present = $true; entries = $names.Count; termsrvWildcard = $wildcard }
    } catch { return @{ present = $false; entries = 0; termsrvWildcard = $false } }
}
$tsPol = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$tsPolCu = 'HKCU:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$doc.policy = @{
    disablePasswordSavingMachine = Get-PolicyInt $tsPol 'DisablePasswordSaving'
    disablePasswordSavingUser    = Get-PolicyInt $tsPolCu 'DisablePasswordSaving'
    promptForPasswordMachine     = Get-PolicyInt $tsPol 'fPromptForPassword'
    allowSavedCredentials        = Get-DelegationFacts 'AllowSavedCredentials'
    allowSavedCredentialsNtlm    = Get-DelegationFacts 'AllowSavedCredentialsWhenNTLMOnly'
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$doc | ConvertTo-Json -Depth 8 -Compress
exit 0
