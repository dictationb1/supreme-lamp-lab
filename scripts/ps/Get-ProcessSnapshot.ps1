<#
.SYNOPSIS
Emits one JSON document describing processes, a narrow PID subtree, and/or TCP
listeners for the lab's process-identity layer (scripts/lib/proc.js).

.DESCRIPTION
CreationDate comes from Win32_Process and is serialised as round-trip UTC
("o"). Registration and verification both use this script, so identity
comparison is an exact string match from one source.

Callers must ask for the narrowest view they need. A full Win32_Process
enumeration pulls CommandLine/ExecutablePath for every process on the machine
(a PEB read per process) and is measurably expensive on a busy hosted runner;
run 39548093609 attempt 2 timed out after 30s waiting for exactly that.
-Nobody enumeration is therefore opt-in:
  * -ProcessIds 1,2      -> those processes only
  * -DescendantsOf <pid> -> BFS over ParentProcessId only (bounded depth)
  * -NoProcesses         -> skip the process query entirely (listener-only)
The full list is only produced when the caller needs every process (cleanup).

.NOTES
If the listener query fails, the document says so explicitly
(listenersError) instead of returning an empty listener list that a caller
could mistake for "nothing is listening".
#>
param(
    # comma-separated PIDs (a -File argument is always a string)
    [string]$ProcessIds = '',
    [int]$ListenPort = 0,
    [int]$DescendantsOf = 0,
    [switch]$NoProcesses,
    [int]$MaxDepth = 8
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-IsoUtc($dt) {
    if ($null -eq $dt) { return $null }
    try { return ([datetime]$dt).ToUniversalTime().ToString('o') } catch { return $null }
}

function ConvertTo-Row($p) {
    [ordered]@{
        pid        = [int]$p.ProcessId
        ppid       = [int]$p.ParentProcessId
        name       = [string]$p.Name
        exe        = [string]$p.ExecutablePath
        cmdline    = [string]$p.CommandLine
        createTime = (ConvertTo-IsoUtc $p.CreationDate)
        sessionId  = [int]$p.SessionId
    }
}

$idList = @($ProcessIds -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })

$list = @()
$processQueryError = $null
if ($NoProcesses) {
    # listener-only: no process enumeration at all
}
elseif ($idList.Count -gt 0) {
    $filter = ($idList | ForEach-Object { "ProcessId = $_" }) -join ' OR '
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
        $list = @($procs | ForEach-Object { ConvertTo-Row $_ })
    } catch {
        $processQueryError = [string]$_.Exception.Message
    }
}
elseif ($DescendantsOf -gt 0) {
    # Narrow subtree walk: only ParentProcessId filters, never a full scan.
    $seen = @{}
    $frontier = @([int]$DescendantsOf)
    $rows = New-Object System.Collections.ArrayList
    for ($depth = 0; $depth -lt $MaxDepth -and $frontier.Count -gt 0; $depth++) {
        $filter = ($frontier | ForEach-Object { "ParentProcessId = $_" }) -join ' OR '
        try {
            $children = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
        } catch {
            $processQueryError = [string]$_.Exception.Message
            break
        }
        $next = New-Object System.Collections.ArrayList
        foreach ($c in $children) {
            $cid = [int]$c.ProcessId
            if ($seen.ContainsKey($cid)) { continue }
            $seen[$cid] = $true
            [void]$rows.Add((ConvertTo-Row $c))
            [void]$next.Add($cid)
        }
        $frontier = @($next)
    }
    $list = @($rows)
}
else {
    try {
        $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $list = @($procs | ForEach-Object { ConvertTo-Row $_ })
    } catch {
        $processQueryError = [string]$_.Exception.Message
    }
}

$listeners = @()
$listenersError = $null
if ($ListenPort -gt 0) {
    try {
        # Query MSFT_NetTCPConnection directly via CIM (State = 2 is Listen).
        # Unlike CDXML Get-NetTCPConnection -ErrorAction Stop, which throws
        # ObjectNotFound when no socket is listening AND imports NetTCPIP on
        # cold start, Get-CimInstance returns an empty collection cleanly when
        # unused and throws only when WMI/CIM itself fails.
        $listeners = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "State = 2 AND LocalPort = $ListenPort" -ErrorAction Stop | ForEach-Object {
            [ordered]@{ port = [int]$_.LocalPort; address = [string]$_.LocalAddress; pid = [int]$_.OwningProcess }
        })
    } catch {
        # Distinguish "query failed" from "nothing is listening".
        $listenersError = [string]$_.Exception.Message
        $listeners = @()
    }
}

$out = [ordered]@{
    platform           = 'win32'
    currentPid         = $PID
    currentSessionId   = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId
    processes          = @($list)
    listeners          = @($listeners)
    listenersError     = $listenersError
    processQueryError  = $processQueryError
    query              = [ordered]@{ processIds = @($idList); listenPort = $ListenPort; descendantsOf = $DescendantsOf; noProcesses = [bool]$NoProcesses }
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$out | ConvertTo-Json -Depth 6 -Compress
