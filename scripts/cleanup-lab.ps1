<#
.SYNOPSIS
Owned lab-process cleanup entry point (Windows wrapper).

.DESCRIPTION
The cleanup policy is implemented once, in scripts/cleanup-lab.js, so the
registry is only ever read and modified by one implementation under one lock
(the previous PowerShell copy rewrote the registry without the JS lock and
accepted records with no creation time). This wrapper locates node and
delegates; it fails visibly if node is unavailable instead of silently
skipping cleanup.
#>
param(
    [ValidateSet('preflight', 'postflight')]
    [string]$Mode = 'postflight',
    [int]$DeadlineMs = 60000,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "::error title=Cleanup unavailable::node is not on PATH; owned-process cleanup ($Mode) could not run."
    exit 4
}
$script = Join-Path $PSScriptRoot 'cleanup-lab.js'
$argsList = @($script, '--mode', $Mode, '--deadline-ms', [string]$DeadlineMs)
if ($Out) { $argsList += @('--out', $Out) }
& $node.Source @argsList
exit $LASTEXITCODE
