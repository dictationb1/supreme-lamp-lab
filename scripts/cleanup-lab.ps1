<#
.SYNOPSIS
Lab Lifecycle Preflight and Postflight Process Cleanup Script.

.DESCRIPTION
Safely cleans up stale lab-owned processes registered during previous test runs.
Protects the runner listener, worker, ancestor processes, active runs, and system services.
#>

param (
    [string]$RegistryPath = $env:REGISTRY_PATH,
    [string]$TargetRunId = $env:GITHUB_RUN_ID,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $RegistryPath) {
    $baseDir = if ($env:RUNNER_TOOL_CACHE) { $env:RUNNER_TOOL_CACHE } elseif ($env:TEMP) { $env:TEMP } else { ".." }
    $RegistryPath = Join-Path $baseDir "lab-process-registry.json"
}

Write-Host "=== Lab Process Lifecycle Cleanup ==="
Write-Host "Registry Path : $RegistryPath"
Write-Host "Target Run ID : $(if ($TargetRunId) { $TargetRunId } else { 'All Stale Runs' })"

if (-not (Test-Path $RegistryPath)) {
    Write-Host "No process registry found at $RegistryPath. No cleanup needed."
    exit 0
}

# Collect Ancestor PIDs for protection
$protectedPids = [System.Collections.Generic.HashSet[int]]::new()
$protectedPids.Add($PID) | Out-Null

if ($IsWindows -or ($env:OS -and $env:OS.Contains("Windows"))) {
    try {
        $currPid = $PID
        while ($currPid) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currPid" -ErrorAction SilentlyContinue
            if ($proc -and $proc.ParentProcessId -and $proc.ParentProcessId -ne 0) {
                $protectedPids.Add([int]$proc.ParentProcessId) | Out-Null
                $currPid = [int]$proc.ParentProcessId
            } else {
                break
            }
        }
    } catch {
        Write-Host "Warning: Could not traverse full parent process tree."
    }
}

Write-Host "Protected ancestor PIDs: $($protectedPids -join ', ')"

# Read Registry JSON
try {
    $rawContent = Get-Content -Path $RegistryPath -Raw -Encoding UTF8
    if (-not $rawContent) {
        Write-Host "Registry file is empty."
        exit 0
    }
    $records = $rawContent | ConvertFrom-Json
} catch {
    Write-Host "Warning: Failed to parse registry file at $RegistryPath. Preserving file and skipping cleanup."
    exit 0
}

if (-not $records) {
    Write-Host "No registered process entries found."
    exit 0
}

if ($records -isnot [array]) {
    $records = @($records)
}

$remainingRecords = [System.Collections.Generic.List[PSObject]]::new()
$terminatedCount = 0

foreach ($rec in $records) {
    $recPid = [int]$rec.pid
    $recRunId = [string]$rec.runId
    $recCreateTime = [string]$rec.createTime
    $recName = [string]$rec.processName

    # Check if target run filter applies
    $shouldClean = $false
    if ($TargetRunId) {
        if ($recRunId -eq $TargetRunId) {
            $shouldClean = $true
        }
    } else {
        $currentRunId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { "local-run" }
        if ($recRunId -ne $currentRunId) {
            $shouldClean = $true
        }
    }

    if (-not $shouldClean) {
        $remainingRecords.Add($rec)
        continue
    }

    if ($protectedPids.Contains($recPid)) {
        Write-Host "Skipping process PID $recPid ($recName): Protected ancestor process."
        $remainingRecords.Add($rec)
        continue
    }

    $proc = Get-Process -Id $recPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "Process PID $recPid ($recName) is already terminated. Removing stale registry record."
        continue
    }

    $procNameLower = $proc.ProcessName.ToLower()
    if ($procNameLower -match "runner\.listener" -or $procNameLower -match "runner\.worker" -or $procNameLower -match "explorer" -or $procNameLower -match "svchost") {
        Write-Host "Skipping protected runner/system process PID $recPid ($($proc.ProcessName))."
        $remainingRecords.Add($rec)
        continue
    }

    $actualCreateTime = $null
    try {
        if ($IsWindows -or ($env:OS -and $env:OS.Contains("Windows"))) {
            try {
                if ($proc.StartTime) {
                    $actualCreateTime = $proc.StartTime.ToString('o')
                }
            } catch {}

            if (-not $actualCreateTime) {
                $cimProc = Get-CimInstance Win32_Process -Filter "ProcessId = $recPid" -ErrorAction SilentlyContinue
                if ($cimProc -and $cimProc.CreationDate) {
                    $actualCreateTime = $cimProc.CreationDate.ToString('o')
                }
            }
        } else {
            if ($proc.StartTime) {
                $actualCreateTime = $proc.StartTime.ToString('o')
            }
        }
    } catch {}

    if ($recCreateTime) {
        if (-not $actualCreateTime) {
            Write-Host "Process PID $recPid creation time unverifiable. Skipping termination to protect system safety."
            $remainingRecords.Add($rec)
            continue
        }
        $t1 = [DateTime]::Parse($recCreateTime).ToUniversalTime()
        $t2 = [DateTime]::Parse($actualCreateTime).ToUniversalTime()
        $diffSec = [Math]::Abs(($t1 - $t2).TotalSeconds)
        if ($diffSec -gt 5) {
            Write-Host "Process PID $recPid recycled by OS (Creation time mismatch: registered $recCreateTime vs actual $actualCreateTime). Removing stale record without killing."
            continue
        }
    }

    Write-Host "Terminating verified stale lab process PID $recPid ($recName, Run $recRunId)..."
    try {
        $closed = $proc.CloseMainWindow()
        if ($closed) {
            Start-Sleep -Seconds 1
        }
    } catch {}

    if (-not $proc.HasExited) {
        try {
            Stop-Process -Id $recPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        } catch {}
    }

    $postCheck = Get-Process -Id $recPid -ErrorAction SilentlyContinue
    if (-not $postCheck -or $postCheck.HasExited) {
        Write-Host "Successfully terminated PID $recPid ($recName)."
        $terminatedCount++
    } else {
        Write-Host "Warning: Could not terminate PID $recPid ($recName)."
        $remainingRecords.Add($rec)
    }
}

try {
    $updatedJson = $remainingRecords | ConvertTo-Json -Depth 5
    if (-not $updatedJson -or $remainingRecords.Count -eq 0) {
        $updatedJson = "[]"
    }
    Set-Content -Path $RegistryPath -Value $updatedJson -Encoding UTF8
    Write-Host "Cleanup complete. Terminated $terminatedCount process(es). Remaining registry entries: $($remainingRecords.Count)."
} catch {
    Write-Host "Warning: Failed to update registry file after cleanup: $_"
}
