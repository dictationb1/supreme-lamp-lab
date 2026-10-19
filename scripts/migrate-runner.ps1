<#
.SYNOPSIS
Migrates a self-hosted Windows GitHub Runner from a background service (Session 0)
to an interactive scheduled task executing At Logon for a specific user.

.DESCRIPTION
The runner requires an interactive desktop session (Session > 0) to execute GUI automation
tasks (like browser testing or application launching). A runner operating as a Windows Service
always runs in Session 0 (Session Isolation), even if configured with a specific user account.

This script automates safely disabling the Windows Service and recreating it as a Windows Scheduled Task
that triggers when the target user logs in.

.PARAMETER RunnerPath
The installation path of the GitHub runner (default: C:\actions-runner)

.PARAMETER TargetUser
The Windows account username that the runner should execute under (e.g., Administrator or lab-user).
Defaults to the currently executing user.
#>

param (
    [string]$RunnerPath = "C:\actions-runner",
    [string]$TargetUser = $env:USERNAME
)

$ErrorActionPreference = 'Stop'

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

# 1. Verify Elevation
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Log "This script requires Administrator privileges to manage services and scheduled tasks." "ERROR"
    throw "Elevation Required"
}

# 2. Check Path
if (-not (Test-Path $RunnerPath)) {
    Write-Log "Runner path not found: $RunnerPath" "ERROR"
    throw "Runner Path Not Found"
}

# 3. Verify Runner Directory ACL
$acl = Get-Acl $RunnerPath
$accessRules = $acl.Access | Where-Object { $_.IdentityReference -match $TargetUser -and ($_.FileSystemRights -match "FullControl" -or $_.FileSystemRights -match "Modify") }
if ($accessRules.Count -eq 0) {
    Write-Log "User '$TargetUser' may not have Write/Modify permissions on '$RunnerPath'. This could cause execution failures." "WARN"
}

# 4. Locate existing Service and backup state
$serviceNamePattern = "actions.runner.*"
$services = Get-Service | Where-Object { $_.Name -like $serviceNamePattern }

if ($services.Count -eq 0) {
    Write-Log "No GitHub Actions runner service found matching pattern '$serviceNamePattern'." "WARN"
    Write-Log "Proceeding to set up the scheduled task assuming manual initial configuration." "INFO"
} elseif ($services.Count -gt 1) {
    Write-Log "Multiple runner services found. Ambiguous target for migration. Aborting." "ERROR"
    $services | ForEach-Object { Write-Log "- $($_.Name)" "ERROR" }
    throw "Ambiguous Service Target"
} else {
    $targetService = $services[0]
    Write-Log "Found active runner service: $($targetService.Name)" "INFO"

    # Backup service config
    $backupPath = "$RunnerPath\service_backup.json"
    $serviceBackup = @{
        Name = $targetService.Name
        DisplayName = $targetService.DisplayName
        Status = $targetService.Status
        StartType = $targetService.StartType
    }
    $serviceBackup | ConvertTo-Json | Out-File -FilePath $backupPath
    Write-Log "Backed up previous service state to $backupPath" "INFO"

    # Stop and Disable Service safely
    if ($targetService.Status -eq 'Running') {
        Write-Log "Stopping service $($targetService.Name)..." "INFO"
        Stop-Service -Name $targetService.Name -Force
    }

    Write-Log "Disabling service $($targetService.Name) to prevent Session 0 startup..." "INFO"
    Set-Service -Name $targetService.Name -StartupType Disabled
}

# 5. Scheduled Task Configuration
$taskName = "GitHubRunnerInteractive_$TargetUser"
$taskPath = "\"

Write-Log "Configuring Scheduled Task: $taskName for user $TargetUser" "INFO"

# Check if task already exists
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Log "Scheduled task '$taskName' already exists. Removing old task..." "INFO"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Define Actions, Triggers, and Settings
$action = New-ScheduledTaskAction -Execute "$RunnerPath\run.cmd" -WorkingDirectory $RunnerPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TargetUser

# Crucial settings for interactive execution:
# 1. LogonType = Interactive (Runs only when user is logged on)
# 2. RunLevel = Highest (Admin privileges if needed by tests)
$principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType Interactive -RunLevel Highest

# Ensure it doesn't stop if running longer than 3 days, and restarts if it fails.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Days 0)

# Register the new task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

Write-Log "Successfully migrated GitHub Actions runner to an interactive At Logon Scheduled Task." "INFO"
Write-Log "" "INFO"
Write-Log "========================================================================" "INFO"
Write-Log "ACTION REQUIRED ON THE VM:" "INFO"
Write-Log "1. Ensure the user '$TargetUser' is actively logged into the Windows Desktop." "INFO"
Write-Log "2. The scheduled task will trigger next time the user logs in." "INFO"
Write-Log "3. To start immediately without logging out/in, execute the task manually:" "INFO"
Write-Log "   Start-ScheduledTask -TaskName '$taskName'" "INFO"
Write-Log "========================================================================" "INFO"
