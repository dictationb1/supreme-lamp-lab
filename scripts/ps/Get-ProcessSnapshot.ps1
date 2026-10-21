<#
.SYNOPSIS
Emits one JSON document describing processes (and optionally TCP listeners) for
the lab's process-identity layer (scripts/lib/proc.js).

.DESCRIPTION
CreationDate comes from Win32_Process and is serialised as round-trip UTC
("o"). Registration and verification both use this script, so identity
comparison is an exact string match from one source.
#>
param(
    # comma-separated PIDs (a -File argument is always a string)
    [string]$ProcessIds = '',
    [int]$ListenPort = 0
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-IsoUtc($dt) {
    if ($null -eq $dt) { return $null }
    try { return ([datetime]$dt).ToUniversalTime().ToString('o') } catch { return $null }
}

$filter = $null
$idList = @($ProcessIds -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
if ($idList.Count -gt 0) {
    $filter = ($idList | ForEach-Object { "ProcessId = $_" }) -join ' OR '
}
$procs = if ($filter) { @(Get-CimInstance Win32_Process -Filter $filter) } else { @(Get-CimInstance Win32_Process) }

$list = foreach ($p in $procs) {
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

$listeners = @()
if ($ListenPort -gt 0) {
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop | ForEach-Object {
            [ordered]@{ port = [int]$_.LocalPort; address = [string]$_.LocalAddress; pid = [int]$_.OwningProcess }
        })
    } catch {
        $listeners = @()
    }
}

$out = [ordered]@{
    platform         = 'win32'
    currentPid       = $PID
    currentSessionId = [int](Get-Process -Id $PID).SessionId
    processes        = @($list)
    listeners        = @($listeners)
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$out | ConvertTo-Json -Depth 5 -Compress
