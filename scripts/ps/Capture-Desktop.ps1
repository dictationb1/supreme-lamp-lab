<#
.SYNOPSIS
Captures the interactive desktop (all screens) of the CURRENT session to a PNG.

.DESCRIPTION
Exit codes: 0 = written; 2 = capture failed (e.g. no interactive desktop /
session 0 / locked workstation). The caller validates the PNG separately; this
script never fabricates an image.
#>
param(
    [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "virtual screen has no area ($($bounds.Width)x$($bounds.Height))" }
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $g.Dispose(); $bmp.Dispose()
    }
    $sid = (Get-Process -Id $PID).SessionId
    Write-Output ("CAPTURED {0}x{1} session={2} path={3}" -f $bounds.Width, $bounds.Height, $sid, $Path)
    exit 0
} catch {
    Write-Output ("CAPTURE_FAILED: " + $_.Exception.Message)
    exit 2
}
