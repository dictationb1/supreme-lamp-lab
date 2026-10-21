<#
.SYNOPSIS
Prepares the EPHEMERAL hosted server (windows-latest) as an RDP target for the
lab client: dedicated local user, RDP enabled with NLA, inbound 3389/7331/7332
limited to the Tailscale CGNAT range, and the app's Web Desktop capture engine
(payloads/ghrdp-pub2.ps1) registered to start at that user's logon - the same
mechanism the app's own main.yml uses (GhrdpWebDesk, Interactive principal).

Never run this on a machine you care about; the workflow only runs it on a
GitHub-hosted runner VM that is destroyed after the job.

Writes a status JSON with rdpConfigured=true|false and a reason.
#>
param(
    [string]$User = 'slabrdp',
    [string]$PasswordEnv = 'RDP_LAB_PASSWORD',
    [string]$StageRoot = 'C:\ghrdp',
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$status = [ordered]@{ rdpConfigured = $false; user = $User; reason = $null; steps = @() }
function Save-Status { $j = $status | ConvertTo-Json -Depth 4; Write-Host $j; if ($Out) { [System.IO.File]::WriteAllText($Out, $j) } }

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    $status.reason = 'REFUSED: Prepare-RdpTarget only runs on GitHub-hosted runners'
    Save-Status; Write-Host "::error title=RDP target::$($status.reason)"; exit 1
}
$pass = [Environment]::GetEnvironmentVariable($PasswordEnv)
if (-not $pass) {
    $status.reason = "MISSING_CONFIG: repository secret $PasswordEnv is not set"
    Save-Status; Write-Host "::warning title=RDP target BLOCKED::$($status.reason)"; exit 0
}
try {
    $sec = ConvertTo-SecureString $pass -AsPlainText -Force
    $existing = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
    if ($existing) { Set-LocalUser -Name $User -Password $sec -PasswordNeverExpires $true }
    else { New-LocalUser -Name $User -Password $sec -PasswordNeverExpires -AccountNeverExpires -Description 'supreme-lamp-lab ephemeral RDP account' | Out-Null }
    foreach ($g in @('Remote Desktop Users', 'Administrators')) {
        try { Add-LocalGroupMember -Group $g -Member $User -ErrorAction Stop } catch { if ($_.Exception.Message -notmatch 'already a member') { throw } }
    }
    $status.steps += 'user'
    # Read the account back: creating it is not proof it can log on.
    $acct = Get-LocalUser -Name $User -ErrorAction Stop
    if (-not $acct.Enabled) { throw "RDP_USER_DISABLED_AFTER_CREATE: $User" }
    $inRdp = [bool](Get-LocalGroupMember -Group 'Remote Desktop Users' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\\$User$" })
    $inAdm = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\\$User$" })
    if (-not ($inRdp -or $inAdm)) { throw "RDP_USER_NOT_IN_REMOTE_LOGON_GROUPS: $User" }
    $status.account = @{ enabled = [bool]$acct.Enabled; remoteDesktopUsers = $inRdp; administrators = $inAdm }
    $status.steps += 'user-verified'

    # The verifier (and the backend's own /api/logon-status) read Security
    # 4624/4625. If "Audit Logon" is not enabled those events never exist and
    # a GOOD logon is indistinguishable from a failed one. This host is a
    # disposable hosted runner, so ensure the subcategory here and prove it
    # by reading it back before any logon is attempted.
    function Get-AuditLogonSetting {
        $txt = (& auditpol.exe /get /subcategory:Logon 2>&1 | Out-String)
        $line = ($txt -split "`r?`n" | Where-Object { $_ -match '^\s*Logon\s{2,}\S' } | Select-Object -First 1)
        if ($line) { return ($line -replace '^\s*Logon\s+', '').Trim() }
        return 'unparsed'
    }
    $auditBefore = Get-AuditLogonSetting
    if ($auditBefore -ne 'Success and Failure') {
        & auditpol.exe /set /subcategory:Logon /success:enable /failure:enable | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "AUDITPOL_SET_FAILED: exit $LASTEXITCODE" }
    }
    $auditAfter = Get-AuditLogonSetting
    if ($auditAfter -ne 'Success and Failure') { throw "AUDIT_LOGON_NOT_ENABLED: before='$auditBefore' after='$auditAfter'" }
    $status.auditLogon = @{ before = $auditBefore; after = $auditAfter }
    $status.steps += 'audit-logon'

    Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0
    Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name 'UserAuthentication' -Value 1
    Set-Service -Name TermService -StartupType Automatic
    Start-Service -Name TermService
    $status.steps += 'rdp-enabled-nla'

    Get-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue | Disable-NetFirewallRule -ErrorAction SilentlyContinue
    foreach ($r in @(@{ n = 'slab-rdp-3389'; p = 3389 }, @{ n = 'slab-mc-7331'; p = 7331 }, @{ n = 'slab-webdesk-7332'; p = 7332 })) {
        Remove-NetFirewallRule -Name $r.n -ErrorAction SilentlyContinue
        New-NetFirewallRule -Name $r.n -DisplayName $r.n -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r.p -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
    }
    $status.steps += 'firewall-tailnet-only'

    $pub = Join-Path $StageRoot 'ghrdp-pub2.ps1'
    if (-not (Test-Path -LiteralPath $pub)) { throw "WEBDESK_ENGINE_NOT_STAGED: $pub" }
    New-Item -ItemType Directory -Path (Join-Path $StageRoot 'webdesk') -Force | Out-Null
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $pub + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$User"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$User" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName 'GhrdpWebDesk' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    $status.steps += 'webdesk-logon-task'

    $listen = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
    if (-not $listen) { throw 'RDP_LISTENER_ABSENT: nothing listens on 3389 after enabling TermService' }
    $status.termService = [string](Get-Service -Name TermService).Status
    $status.listener3389 = @($listen | ForEach-Object { [string]$_.LocalAddress })
    $status.rdpConfigured = $true
    $status.reason = 'OK'
} catch {
    $status.reason = 'RDP_PREP_FAILED: ' + $_.Exception.Message
    Save-Status
    Write-Host "::error title=RDP target::$($status.reason)"
    exit 1
}
Save-Status
Write-Host "::notice title=RDP target::user=$User steps=$($status.steps -join ',')"
