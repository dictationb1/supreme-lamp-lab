<#
Run the application's documented auto-login enrollment (docs/AUTOLOGIN.md,
remediation 8C): compile payloads/ghrdp-rdp-launcher.cs with the in-box csc.exe
and register the ghrdp:// protocol under HKCU - exactly what the app's
payloads/install.cmd does, MINUS the two interactive-only steps (the F15
self-test MessageBox launch and the final pause), which cannot run unattended
and are recorded as skipped in the report.

The application stopped serving an installer (/install.ps1 is a 404-guarded
deleted route upstream), so the inputs come from the application source zip at
the pinned commit, sha256-verified here. Refuses to overwrite any preexisting
registration, launcher binary or legacy helper, and refuses to run beside a
live mstsc/helper process - same guards as the previous installer flow.
#>
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedZipSha256,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
trap {
    $m = $_.Exception.Message -replace '[\r\n]+', ' '
    Write-Host "::error title=Production handler enrollment::$m"
    exit 1
}

$zip = (Resolve-Path -LiteralPath $ZipPath).Path
$actualZip = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($actualZip -ine $ExpectedZipSha256) { throw "APP_ZIP_HASH_MISMATCH: $actualZip" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ghrdp-handler-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $top = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'supreme-lamp-*' } | Select-Object -First 1
    if (-not $top) { throw 'APP_ZIP_LAYOUT_UNEXPECTED: no supreme-lamp-* root after expand' }
    $installCmd = Join-Path $top.FullName 'payloads\install.cmd'
    $launcherCs = Join-Path $top.FullName 'payloads\ghrdp-rdp-launcher.cs'
    if (-not (Test-Path -LiteralPath $installCmd)) { throw 'INSTALL_CMD_MISSING: payloads/install.cmd absent from the app source' }
    if (-not (Test-Path -LiteralPath $launcherCs)) { throw 'LAUNCHER_SOURCE_MISSING: payloads/ghrdp-rdp-launcher.cs absent from the app source' }
    $installCmdHash = (Get-FileHash -LiteralPath $installCmd -Algorithm SHA256).Hash.ToLowerInvariant()
    $launcherCsHash = (Get-FileHash -LiteralPath $launcherCs -Algorithm SHA256).Hash.ToLowerInvariant()

    # Guards: never overwrite anything that predated this attempt.
    $reg = 'HKCU:\Software\Classes\ghrdp'
    if (Test-Path -LiteralPath $reg) { throw 'HANDLER_PREEXISTING: refusing to replace HKCU\Software\Classes\ghrdp' }
    $dir = Join-Path $env:LOCALAPPDATA 'ghrdp'
    $exe = Join-Path $dir 'ghrdp-rdp-launcher.exe'
    if (Test-Path -LiteralPath $exe) { throw "HANDLER_LAUNCHER_PREEXISTING: $exe" }
    $legacy = @((Join-Path $dir 'ghrdp-connect.ps1'), (Join-Path $env:LOCALAPPDATA 'GhrdpLauncher\launch.ps1'))
    foreach ($f in $legacy) { if (Test-Path -LiteralPath $f) { throw "HANDLER_HELPER_PREEXISTING: $f" } }
    # The production installer intentionally stops stale mstsc/helper processes.
    # Refuse to run beside one; never let setup kill an unrelated session.
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='mstsc.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop)
    $conflicts = @($procs | Where-Object {
        $_.Name -ieq 'mstsc.exe' -or ($_.ProcessId -ne $PID -and [string]$_.CommandLine -match '(?i)ghrdp-connect|GhrdpLauncher\\launch\.ps1')
    })
    if ($conflicts.Count) { throw "HANDLER_INSTALL_PROCESS_CONFLICT: $($conflicts.Count) matching process(es); enrollment not run" }

    # Compile with install.cmd's exact csc invocation (in-box .NET 4.x).
    $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (-not (Test-Path -LiteralPath $csc)) { throw 'CSC_NOT_FOUND: no in-box .NET Framework compiler' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    & $csc /nologo /target:winexe /out:"$exe" /r:System.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$launcherCs"
    if ($LASTEXITCODE -ne 0) { throw "CSC_COMPILE_FAILED: exit $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $exe)) { throw 'LAUNCHER_EXE_ABSENT_AFTER_COMPILE' }

    # Register with install.cmd's exact three reg adds (HKCU only, no UAC).
    & reg.exe add 'HKCU\Software\Classes\ghrdp' /ve /d 'URL:ghrdp Protocol' /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'REG_ADD_FAILED: protocol key' }
    & reg.exe add 'HKCU\Software\Classes\ghrdp' /v 'URL Protocol' /d '' /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'REG_ADD_FAILED: URL Protocol value' }
    & reg.exe add 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve /d ('"' + $exe + '" "%1"') /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'REG_ADD_FAILED: command value' }

    # Readback is the truth gate.
    $command = (& reg.exe query 'HKCU\Software\Classes\ghrdp\shell\open\command' /ve 2>$null) -join ' '
    if ($LASTEXITCODE -ne 0 -or $command -notmatch [regex]::Escape('ghrdp-rdp-launcher.exe')) { throw "HANDLER_COMMAND_READBACK_FAILED: $command" }

    $exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $report = [ordered]@{
        schema = 'slab-production-handler-install/2'; installedAt = [datetime]::UtcNow.ToString('o')
        method = 'csc compile + HKCU registration per docs/AUTOLOGIN.md (remediation 8C; the served /install.ps1 route was deleted upstream)'
        appZipSha256 = $actualZip.ToLowerInvariant()
        installCmdSha256 = $installCmdHash
        launcherSourceSha256 = $launcherCsHash
        launcherExeSha256 = $exeHash
        registered = $true; commandVerified = $true
        selfTestSkipped = 'interactive-only (F15 MessageBox + pause): not runnable unattended, recorded truthfully'
        preexistingRegistry = $false; preexistingLauncher = $false
        processConflictsBeforeInstall = 0
    }
    $json = $report | ConvertTo-Json -Depth 4
    if ($Out) { [System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false)) }
    Write-Host $json
} finally {
    try { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force } } catch { }
}
