<#
.SYNOPSIS
Bounded, read-only evidence about what THIS machine's mstsc actually did.

.DESCRIPTION
Written after run 39569844830 attempt 1: the server's Security/TS logs
proved no RDP connection request ever arrived (no 4624/4625 for the lab
user, no off-cadence RemoteConnectionManager 261), while mstsc stayed
alive on the client with an empty main-window title. Server logs cannot
say why the client never dialed; the client's own RDPClient operational
log, its visible system dialogs and mstsc's sockets can.

Collects, for a bounded window starting at mstsc launch:
  * Microsoft-Windows-TerminalServices-RDPClient/Operational rows
    (id, time, level, first message line) - mstsc's own account of the
    connection attempt (1024 resolved, 1025 connected, 1026/1027
    disconnect reasons, 1033/1041/1105 ...).
  * visible top-level windows OWNED BY mstsc/LogonUI/CredentialUIBroker/
    consent, or titled like an RDP/security dialog. Deliberately filtered:
    this is the operator's interactive session; unrelated window titles
    (browser tabs etc.) are never read out.
  * mstsc's TCP connections (was a socket to 3389 even opened? state?).
  * client RDP policy FACTS as integers/booleans only (saved-password and
    prompt policies, CredSSP saved-credential delegation allowlist
    presence/count/wildcard) - no hostnames from the operator's lists.
Emits one JSON line. Read-only; changes nothing on the client machine.
#>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$SinceUtc
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$doc = [ordered]@{ pid = $ProcessId; sinceUtc = $SinceUtc }
$sinceLocal = [DateTime]::MinValue
try { $sinceLocal = [DateTime]::Parse($SinceUtc).ToLocalTime() } catch { $sinceLocal = [DateTime]::Now.AddMinutes(-10) }

# ---- RDPClient operational log ---------------------------------------------
$doc.rdpClientLogReadable = $false
$rows = @()
try {
    $raw = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TerminalServices-RDPClient/Operational'; StartTime = $sinceLocal } -MaxEvents 30 -ErrorAction Stop)
    $doc.rdpClientLogReadable = $true
    $doc.rdpClientCount = $raw.Count
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
} catch { $doc.rdpClientError = $_.Exception.Message }
$doc.rdpClientEvents = $rows

# ---- visible system/RDP windows (filtered) ----------------------------------
$winRows = @()
try {
    $src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SlabWinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] List() {
    var acc = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      int n = GetWindowTextW(h, sb, 512);
      if (n <= 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      acc.Add(pid + "\t" + sb.ToString());
      return acc.Count < 400;
    }, IntPtr.Zero);
    return acc.ToArray();
  }
}
'@
    if (-not ('SlabWinEnum' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
    $procCache = @{}
    foreach ($line in [SlabWinEnum]::List()) {
        $parts = $line -split "`t", 2
        if ($parts.Count -lt 2) { continue }
        $wpid = 0; [void][int]::TryParse($parts[0], [ref]$wpid)
        $title = [string]$parts[1]
        if (-not $procCache.ContainsKey($wpid)) {
            try { $procCache[$wpid] = [string](Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { $procCache[$wpid] = '?' }
        }
        $pname = $procCache[$wpid]
        $relevantProcess = $pname -in @('mstsc', 'LogonUI', 'CredentialUIBroker', 'consent', 'LogonUI.exe')
        $relevantTitle = $title -match 'Remote Desktop|Windows Security|Certificate|credential|Smart Card'
        if (-not ($relevantProcess -or $relevantTitle)) { continue }
        if ($title.Length -gt 120) { $title = $title.Substring(0, 120) }
        $winRows += [ordered]@{ process = $pname; pid = $wpid; title = $title }
        if ($winRows.Count -ge 20) { break }
    }
} catch { $doc.windowEnumError = $_.Exception.Message }
$doc.windows = $winRows

# ---- mstsc sockets ------------------------------------------------------------
$tcpRows = @()
try {
    foreach ($c in @(Get-NetTCPConnection -OwningProcess $ProcessId -ErrorAction SilentlyContinue)) {
        $tcpRows += [ordered]@{ remote = "$($c.RemoteAddress):$($c.RemotePort)"; state = [string]$c.State }
        if ($tcpRows.Count -ge 8) { break }
    }
} catch { $doc.tcpError = $_.Exception.Message }
$doc.tcpConnections = $tcpRows

# ---- client RDP policy facts (integers/booleans only) ------------------------
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
$doc | ConvertTo-Json -Depth 6 -Compress
exit 0
