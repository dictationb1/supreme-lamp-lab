<#
Run the exact staged application installer only when it cannot overwrite or
terminate anything outside this test. The caller separately snapshots files so
cleanup can remove only objects created by this installation and launch.
#>
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
trap {
    $m = $_.Exception.Message -replace '[\r\n]+', ' '
    Write-Host "::error title=Production handler enrollment::$m"
    exit 1
}
$resolved = (Resolve-Path -LiteralPath $InstallerPath).Path
$actual = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
if ($actual -ine $ExpectedSha256) { throw "INSTALLER_HASH_MISMATCH: $actual" }
$reg = 'HKCU:\Software\Classes\ghrdp'
if (Test-Path -LiteralPath $reg) { throw 'HANDLER_PREEXISTING: refusing to replace HKCU\Software\Classes\ghrdp' }
$oldDir = Join-Path $env:LOCALAPPDATA 'ghrdp'
$newDir = Join-Path $env:LOCALAPPDATA 'GhrdpLauncher'
$oldHelper = Join-Path $oldDir 'ghrdp-connect.ps1'
$newHelper = Join-Path $newDir 'launch.ps1'
foreach ($f in @($oldHelper, $newHelper)) { if (Test-Path -LiteralPath $f) { throw "HANDLER_HELPER_PREEXISTING: $f" } }

# The production installer intentionally stops stale mstsc/helper processes.
# Refuse to run it if any such process exists; never let setup kill an
# unrelated interactive session. This is a narrow query, not a full PEB walk.
$procs = @(Get-CimInstance Win32_Process -Filter "Name='mstsc.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop)
$conflicts = @($procs | Where-Object {
    $_.Name -ieq 'mstsc.exe' -or ($_.ProcessId -ne $PID -and [string]$_.CommandLine -match '(?i)ghrdp-connect|GhrdpLauncher\\launch\.ps1')
})
if ($conflicts.Count) { throw "HANDLER_INSTALL_PROCESS_CONFLICT: $($conflicts.Count) matching process(es); installer not run" }

$hostExe = (Get-Process -Id $PID).Path
$child = Start-Process -FilePath $hostExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $resolved + '"')) -WindowStyle Hidden -Wait -PassThru
$code = $child.ExitCode
if ($code -ne 0) { throw "PRODUCTION_INSTALLER_EXIT_$code" }
if (-not (Test-Path -LiteralPath $reg)) { throw 'HANDLER_REGISTRY_ABSENT_AFTER_INSTALL' }
foreach ($f in @($oldHelper, $newHelper)) { if (-not (Test-Path -LiteralPath $f)) { throw "HANDLER_HELPER_ABSENT_AFTER_INSTALL: $f" } }
$oldHash = (Get-FileHash -LiteralPath $oldHelper -Algorithm SHA256).Hash.ToLowerInvariant()
$newHash = (Get-FileHash -LiteralPath $newHelper -Algorithm SHA256).Hash.ToLowerInvariant()
if ($oldHash -ne $newHash) { throw 'HANDLER_HELPER_COPIES_DIFFER' }
$command = (& reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve 2>$null) -join ' '
if ($LASTEXITCODE -ne 0 -or $command -notmatch 'GhrdpLauncher\\launch\.ps1') { throw 'HANDLER_COMMAND_READBACK_FAILED' }
$report = [ordered]@{
    schema = 'slab-production-handler-install/1'; installedAt = [datetime]::UtcNow.ToString('o')
    installerSha256 = $actual.ToLowerInvariant(); helperSha256 = $oldHash
    registered = $true; commandVerified = $true; preexistingRegistry = $false; preexistingHelpers = $false
    processConflictsBeforeInstall = 0
}
$json = $report | ConvertTo-Json -Depth 4
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false)) }
Write-Host $json
