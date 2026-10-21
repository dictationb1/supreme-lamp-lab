<#
.SYNOPSIS
Installs the pinned Node.js Windows x64 build into the runner tool cache after
verifying its SHA-256, then prepends it to PATH for later steps.

.DESCRIPTION
-ExpectedSha256 comes from the `static` job output, which verified it against
the GPG-signed SHASUMS256.txt of the release in the same workflow run (and
against config/node-pin.json when that is pinned). A mismatch fails the step;
nothing unverified is executed.
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw "NODE_PIN_INVALID: expected sha256 '$ExpectedSha256' is not 64 hex chars" }
if ($Version -notmatch '^v\d+\.\d+\.\d+$') { throw "NODE_VERSION_INVALID: $Version" }

$base = if ($env:RUNNER_TOOL_CACHE) { $env:RUNNER_TOOL_CACHE } else { $env:TEMP }
$dest = Join-Path $base ("slab-node\" + $Version)
$exe = Join-Path $dest 'node.exe'
$marker = Join-Path $dest '.verified-sha256'

if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $ExpectedSha256)) {
    Write-Host "[node] cached $Version at $dest (archive sha256 previously verified)"
} else {
    $name = "node-$Version-win-x64"
    $zip = Join-Path $env:RUNNER_TEMP "$name.zip"
    $url = "https://nodejs.org/dist/$Version/$name.zip"
    Write-Host "[node] downloading $url"
    & curl.exe -fsSL --retry 3 --connect-timeout 30 --max-time 600 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "NODE_DOWNLOAD_FAILED: curl exit $LASTEXITCODE" }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) { throw "NODE_HASH_MISMATCH: $name.zip sha256 $actual != pinned $ExpectedSha256" }
    Write-Host "[node] sha256 verified: $actual"
    $tmp = Join-Path $env:RUNNER_TEMP ("node-extract-" + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $dest
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $marker -Value $ExpectedSha256 -NoNewline
}
$v = & $exe --version
if ($v -ne $Version) { throw "NODE_VERSION_MISMATCH: $exe reports $v, expected $Version" }
Add-Content -LiteralPath $env:GITHUB_PATH -Value $dest
Write-Host "[node] $v ready at $dest"
