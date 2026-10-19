<#
.SYNOPSIS
    Idempotent Windows Runner Migration Helper for Supreme Lamp Lab.
.DESCRIPTION
    Safely inspects C:\actions-runner, checks active runner processes and services,
    verifies user desktop session access, and configures an At Logon scheduled task
    for interactive desktop execution.
#>

[CmdletBinding()]
param (
    [string]$RunnerPath = "C:\actions-runner",
    [string]$TargetUser = $env:USERNAME,
    [switch]$Rollback,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Supreme Lamp Lab - Runner Migration Helper ===" -ForegroundColor Cyan
Write-Host "Target Runner Path : $RunnerPath"
Write-Host "Target User        : $TargetUser"

if (-not (Test-Path $RunnerPath)) {
    Write-Error "Runner path '$RunnerPath' does not exist. Aborting."
    exit 1
}

$fullRunnerPath = (Resolve-Path $RunnerPath).Path.TrimEnd('\')
if ($fullRunnerPath -ne "C:\actions-runner" -and -not $Force) {
    Write-Error "Migration helper strictly targets C:\actions-runner to avoid ambiguous target modifications. Use -Force to override."
    exit 1
}

# 1. Inspection & Diagnostic
Write-Host "`n[1/5] Inspecting processes, services, and scheduled tasks..." -ForegroundColor Yellow

$runnerProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($fullRunnerPath, [StringComparison]::OrdinalIgnoreCase)
}

$runnerServices = Get-CimInstance Win32_Service | Where-Object {
    $_.PathName -and $_.PathName.IndexOf($fullRunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$runnerTasks = Get-ScheduledTask | Where-Object {
    $_.Actions | Where-Object { $_.Execute -and $_.Execute.IndexOf($fullRunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

Write-Host "Found $($runnerProcesses.Count) running process(es) matching runner path."
foreach ($proc in $runnerProcesses) {
    Write-Host " - PID: $($proc.ProcessId) | Name: $($proc.Name) | SessionID: $($proc.SessionId)"
}

Write-Host "Found $($runnerServices.Count) service(s) matching runner path."
foreach ($svc in $runnerServices) {
    Write-Host " - Service Name: $($svc.Name) | State: $($svc.State) | StartMode: $($svc.StartMode) | Account: $($svc.StartName)"
}

Write-Host "Found $($runnerTasks.Count) scheduled task(s) matching runner path."
foreach ($task in $runnerTasks) {
    Write-Host " - Task Name: $($task.TaskName) | State: $($task.State)"
}

# Rollback Logic
if ($Rollback) {
    Write-Host "`n[ROLLBACK] Reverting migration changes..." -ForegroundColor Magenta
    $taskName = "SupremeLampRunnerTask"
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task: $taskName"
    }
    foreach ($svc in $runnerServices) {
        if ($svc.StartMode -eq "Disabled") {
            Set-Service -Name $svc.Name -StartupType Automatic
            Write-Host "Re-enabled service: $($svc.Name)"
        }
    }
    Write-Host "Rollback complete." -ForegroundColor Green
    exit 0
}

# 2. Check current execution context to prevent self-termination
$currentPid = $PID
$isExecutingInsideRunner = $runnerProcesses | Where-Object { $_.ProcessId -eq $currentPid }
if ($isExecutingInsideRunner) {
    Write-Warning "Running inside an active runner process (PID: $currentPid)."
    Write-Warning "Refusing to stop active runner service/process from within its own execution context."
    Write-Host "MIGRATION STATUS: BLOCKED_SELF_EXECUTION" -ForegroundColor Red
    Write-Host "Please execute this script from an independent administrative PowerShell console on the VM."
    exit 2
}

# 3. User Permission and Directory Access Check
Write-Host "`n[2/5] Checking directory access permissions..." -ForegroundColor Yellow
try {
    $testFile = Join-Path $fullRunnerPath ".migration_perm_check"
    [System.IO.File]::WriteAllText($testFile, "test")
    [System.IO.File]::Delete($testFile)
    Write-Host "Access check passed: User $TargetUser has write permission to $fullRunnerPath."
} catch {
    Write-Error "User $TargetUser does not have required permissions in $fullRunnerPath: $_"
    exit 1
}

# 4. Service Migration (Disable Session 0 service after idle)
Write-Host "`n[3/5] Handling existing Windows Service..." -ForegroundColor Yellow
foreach ($svc in $runnerServices) {
    if ($svc.State -eq "Running") {
        Write-Host "Stopping service '$($svc.Name)'..."
        Stop-Service -Name $svc.Name -Force
    }
    Write-Host "Disabling service '$($svc.Name)' startup..."
    Set-Service -Name $svc.Name -StartupType Disabled
}

# 5. Configure At Logon Scheduled Task
Write-Host "`n[4/5] Creating persistent At Logon scheduled task for interactive desktop session..." -ForegroundColor Yellow
$taskName = "SupremeLampRunnerTask"
$actionScript = Join-Path $fullRunnerPath "run.cmd"

if (-not (Test-Path $actionScript)) {
    Write-Error "Runner executable script '$actionScript' not found."
    exit 1
}

$action = New-ScheduledTaskAction -Execute $actionScript -WorkingDirectory $fullRunnerPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TargetUser
$principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Write-Host "Scheduled task '$taskName' registered successfully." -ForegroundColor Green

# 6. Summary and Instructions
Write-Host "`n[5/5] Migration Complete!" -ForegroundColor Green
Write-Host @"
================================================================================
IMPORTANT NOTE:
- The scheduled task is configured to run ONLY when user '$TargetUser' logs on interactively.
- Scheduled tasks DO NOT automatically log in or unlock Windows.
- Ensure the user '$TargetUser' is logged into the Windows GUI desktop session (Session ID > 0).
- Existing runner registration files in $fullRunnerPath were preserved.
================================================================================
"@
