$ErrorActionPreference = 'Stop'
$registryDir = Join-Path $env:TEMP "supreme-lamp-lab-registry"
$registryPath = Join-Path $registryDir "lab-registry.json"

if (-not (Test-Path $registryPath)) {
    Write-Host "No lab registry found at $registryPath. Nothing to clean."
    exit 0
}

Write-Host "=== Cleaning up registered lab processes ==="
$lockPath = "$registryPath.lock"
$maxRetries = 30
$attempts = 0
$acquired = $false

while ($attempts -lt $maxRetries) {
    try {
        New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
        $acquired = $true
        break
    } catch {
        try {
            $lockItem = Get-Item $lockPath -ErrorAction Stop
            if ((Get-Date) - $lockItem.LastWriteTime -gt (New-TimeSpan -Minutes 5)) {
                Write-Host "Stale lock detected. Overriding."
                Remove-Item -Path $lockPath -Force -Recurse -ErrorAction SilentlyContinue
                continue
            }
        } catch {}
        $attempts++
        Start-Sleep -Seconds 1
    }
}

if (-not $acquired) {
    Write-Host "Failed to acquire registry lock. Cannot cleanup."
    exit 0
}

try {
    $registry = Get-Content $registryPath | ConvertFrom-Json
    $currentRunId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { "local-run" }
    $currentAttempt = if ($env:GITHUB_RUN_ATTEMPT) { $env:GITHUB_RUN_ATTEMPT } else { "1" }

    # Differentiate preflight vs postflight cleanup using environment variable or passed parameter
    $isPostflight = $env:POSTFLIGHT_CLEANUP -eq "true"

    $survivingRegistry = @()
    foreach ($entry in $registry) {
        if (-not $isPostflight -and $entry.runId -eq $currentRunId -and $entry.runAttempt -eq $currentAttempt) {
            # Preflight cleanup should NOT kill processes from the current run (if any exist yet, though they shouldn't).
            $survivingRegistry += $entry
            continue
        }
        if ($isPostflight -and ($entry.runId -ne $currentRunId -or $entry.runAttempt -ne $currentAttempt)) {
            # Postflight cleanup should ONLY kill processes from the current run.
            $survivingRegistry += $entry
            continue
        }

        $proc = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
        if ($proc) {
            try {
                $startTimeUnix = [int][double]::Parse((Get-Date $proc.StartTime -UFormat %s)) * 1000
                $timeDiff = [math]::Abs($entry.creationTime - $startTimeUnix)
                if ($timeDiff -lt 60000) {
                    if (-not $isPostflight) {
                        $ageMinutes = ((Get-Date) - $proc.StartTime).TotalMinutes
                        if ($ageMinutes -lt 30) {
                            Write-Host "Skipping active lab process from another run: $($proc.ProcessName) (PID: $($proc.Id)) - Age: $ageMinutes mins"
                            $survivingRegistry += $entry
                            continue
                        }
                    }
                    Write-Host "Killing registered lab process: $($proc.ProcessName) (PID: $($proc.Id)) - Identity: $($entry.identity)"
                    if ($proc.CloseMainWindow()) {
                        Start-Sleep -Seconds 2
                        $proc = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
                    }
                    if ($proc -and -not $proc.HasExited) {
                        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                    }
                } else {
                    Write-Host "PID reuse detected. Process $($proc.Id) creation time does not match registry. Skipping."
                    $survivingRegistry += $entry
                }
            } catch {
                 Write-Host "Could not determine StartTime for $($proc.Id). Skipping to be safe."
                 $survivingRegistry += $entry
            }
        }
    }
    @($survivingRegistry) | ConvertTo-Json | Out-File $registryPath -Encoding utf8
} finally {
    Remove-Item -Path $lockPath -Force -Recurse -ErrorAction SilentlyContinue
}
Write-Host "Cleanup complete."