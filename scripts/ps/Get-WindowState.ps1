<#
.SYNOPSIS
Reports one process's top-level window state as JSON (lab diagnostics).

.DESCRIPTION
Used while mstsc is connecting: the main-window title distinguishes a live
session window ("<host> - Remote Desktop Connection") from the mstsc start
dialog ("Remote Desktop Connection") without needing the screenshot blob.
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
