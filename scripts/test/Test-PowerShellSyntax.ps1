<#
.SYNOPSIS
Parses every .ps1 under the given paths with the PowerShell language parser
and fails on any syntax error (file:line:column + message as annotations).
#>
param([string[]]$Paths = @('scripts'))
$ErrorActionPreference = 'Stop'
$files = @()
foreach ($p in $Paths) { if (Test-Path -LiteralPath $p) { $files += Get-ChildItem -LiteralPath $p -Recurse -Filter '*.ps1' -File } }
$bad = 0
foreach ($f in $files) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count) {
        foreach ($e in $errors) {
            $bad++
            Write-Host ("::error file={0},line={1},col={2}::PowerShell parse error: {3}" -f $f.FullName, $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
        }
    } else {
        Write-Host ("OK  {0}" -f $f.FullName)
    }
}
Write-Host ("parsed {0} file(s), {1} error(s)" -f $files.Count, $bad)
if ($files.Count -eq 0) { Write-Host '::error::no PowerShell files found to parse'; exit 1 }
if ($bad -gt 0) { exit 1 }
