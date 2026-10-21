<#
.SYNOPSIS
Reports one process's main-window state as JSON (lab diagnostics).

.DESCRIPTION
PROCESS-LIVENESS PROBE ONLY. Get-Process's MainWindowHandle/MainWindowTitle
use .NET's "main window" heuristic (the process's unowned top-level window);
an owned/modal dialog is invisible to it. Run 39575343527 attempt 2 showed
exactly that split: this probe reported title="" hasWindow=false while
Get-RdpDialogState's enumeration found mstsc hosting the RDP-file consent
dialog. Therefore:
  * alive/responding/sessionId - process facts (this probe's authority);
  * title/hasWindow            - main-window heuristic only; absence proves
                                 NOTHING about connection progress;
  * dialog/connection state    - never inferred here (see
                                 Get-RdpDialogState.ps1 + scripts/lib/dialogs.js).
Read-only; never interacts with the window.
#>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'
try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    $out = [ordered]@{
        alive       = $true
        pid         = $ProcessId
        title       = [string]$p.MainWindowTitle
        responding  = [bool]$p.Responding
        sessionId   = [int]$p.SessionId
        hasWindow   = ($p.MainWindowHandle -ne [IntPtr]::Zero)
        probe       = 'main-window-heuristic'
        connectionProgress = 'not-inferred'
    }
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $out | ConvertTo-Json -Compress
    exit 0
} catch {
    $out = [ordered]@{ alive = $false; pid = $ProcessId; error = $_.Exception.Message }
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $out | ConvertTo-Json -Compress
    exit 0
}
