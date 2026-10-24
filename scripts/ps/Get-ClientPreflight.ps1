# Read-only, secret-free client VM inventory for the Mission Control lab.
# The caller applies a hard timeout. Windows PowerShell 5.1 compatible.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Continue'

$proc = Get-Process -Id $PID
$sessionId = [int]$proc.SessionId
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" -ErrorAction SilentlyContinue
$workerCount = @(Get-Process -Name 'Runner.Worker' -ErrorAction SilentlyContinue).Count

$browserCandidates = @(
    @{ name = 'edge'; path = (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') },
    @{ name = 'edge'; path = (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') },
    @{ name = 'chrome'; path = (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') },
    @{ name = 'firefox'; path = (Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe') }
)
$browsers = @()
foreach ($candidate in $browserCandidates) {
    if ($candidate.path -and (Test-Path -LiteralPath $candidate.path -PathType Leaf)) {
        $browsers += [pscustomobject]@{ name = $candidate.name; path = $candidate.path }
    }
}

$mstsc = Join-Path $env:SystemRoot 'System32\mstsc.exe'
$handlerUser = Test-Path 'Registry::HKEY_CURRENT_USER\Software\Classes\ghrdp'
$handlerMachine = Test-Path 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\ghrdp'

$tailscale = [ordered]@{ present = $false; backendState = 'UNAVAILABLE'; selfOnline = $false; error = '' }
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path -LiteralPath $ts -PathType Leaf) {
    $tailscale.present = $true
    try {
        $raw = (& $ts status --json 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $raw) {
            $status = $raw | ConvertFrom-Json
            $tailscale.backendState = [string]$status.BackendState
            $tailscale.selfOnline = [bool]$status.Self.Online
        } else {
            $tailscale.error = "tailscale status exit $LASTEXITCODE"
        }
    } catch {
        $tailscale.error = $_.Exception.Message
    }
    $global:LASTEXITCODE = 0
} else {
    $tailscale.error = 'tailscale.exe not found'
}

[pscustomobject]@{
    schema = 'slab-client-vm-inventory/1'
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    computer = $env:COMPUTERNAME
    account = "$env:USERDOMAIN\$env:USERNAME"
    os = if ($os) { [string]$os.Caption } else { [string][Environment]::OSVersion.VersionString }
    osVersion = [string][Environment]::OSVersion.Version
    powerShell = [string]$PSVersionTable.PSVersion
    sessionId = $sessionId
    userInteractive = [bool][Environment]::UserInteractive
    interactiveDesktop = ($sessionId -gt 0 -and [Environment]::UserInteractive)
    runnerWorkerProcessCount = $workerCount
    responsive = [bool]$proc.Responding
    memoryTotalBytes = if ($os) { [int64]$os.TotalVisibleMemorySize * 1KB } else { 0 }
    memoryFreeBytes = if ($os) { [int64]$os.FreePhysicalMemory * 1KB } else { 0 }
    systemDriveFreeBytes = if ($disk) { [int64]$disk.FreeSpace } else { 0 }
    browsers = $browsers
    nativeLauncher = [pscustomobject]@{
        mstscPath = $mstsc
        mstscPresent = (Test-Path -LiteralPath $mstsc -PathType Leaf)
        ghrdpHandlerUser = $handlerUser
        ghrdpHandlerMachine = $handlerMachine
    }
    tailscale = [pscustomobject]$tailscale
} | ConvertTo-Json -Depth 5 -Compress
