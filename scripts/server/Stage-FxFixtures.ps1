<#
Stage disposable File Explorer fixtures for the candidate capability run.

Why this exists: the File Explorer (F45/F56) is an INDEX-driven explorer. The
UI's listing/navigation/preview/download all read C:\ghrdp\fx-index.json, and
preview/download resolve the RDP-Storage root to C:\ghrdp\storage\<path> with a
containment check (Resolve-FxLocalPath). "Staging a disposable test directory
through the production mechanism" therefore means:
  1. create real files under C:\ghrdp\storage\lab-fixture\ (the production
     RDP-Storage root base on this ephemeral server);
  2. write C:\ghrdp\fx-index.json (the production index the module reads),
     with stable ids computed exactly like the module (SHA-1(root+path)),
     correct size/mtime/mime/checksum so the UI's meta/preview checks agree
     with the bytes on disk.
The fixtures are owned by the lab run, disposable, and never touch any real
user directory (Downloads/Desktop/Documents stay empty on this ephemeral host).

The output JSON records every fixture with its sha256 so the client-side sweep
can verify a download byte-for-byte (checksum verification requirement).
#>
param(
    [string]$StageRoot = 'C:\ghrdp',
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'REFUSED: Stage-FxFixtures only runs on an ephemeral GitHub-hosted Windows server'
}

function Get-FxStableIdLocal {
    # IDENTICAL to the module's Get-FxStableId (and the S2 client computeId):
    # SHA-1(rootName + path), UTF-8, lowercase hex. Identity only.
    param([string]$RootName, [string]$Path)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($RootName + $Path)))
    } finally { $sha.Dispose() }
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($b.ToString('x2')) }
    return $sb.ToString()
}

$storageBase = Join-Path $StageRoot 'storage'
$fixtureDir = Join-Path $storageBase 'lab-fixture'
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null

$now = [datetime]::UtcNow
$iso = $now.ToString('o')
$fixtures = @()

# Fixture 1: a text file with known, non-secret content (previewable: text/plain).
$txtContent = "lab file explorer fixture`ncreated by Stage-FxFixtures at $iso`nthis file is disposable and owned by the lab run`n"
$txtPath = Join-Path $fixtureDir 'lab-readme.txt'
[System.IO.File]::WriteAllText($txtPath, $txtContent, (New-Object System.Text.UTF8Encoding($false)))
$fixtures += @{ leaf = 'lab-readme.txt'; mime = 'text/plain' }

# Fixture 2: a JSON document (previewable: application/json).
$jsonDoc = [ordered]@{ fixture = $true; kind = 'json'; tags = @('lab', 'fixture'); lines = 12; note = 'disposable lab fixture' }
$jsonPath = Join-Path $fixtureDir 'lab-data.json'
[System.IO.File]::WriteAllText($jsonPath, ($jsonDoc | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
$fixtures += @{ leaf = 'lab-data.json'; mime = 'application/json' }

# Fixture 3: a small valid PNG (previewable: image/png) - 1x1 red pixel PNG.
$pngBytes = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,0x54,0x08,0xD7,0x63,0xF8,0xCF,0xC0,0x00,0x00,0x03,0x01,0x01,0x00,0x18,0xDD,0x8D,0xB0,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82)
$pngPath = Join-Path $fixtureDir 'lab-pixel.png'
[System.IO.File]::WriteAllBytes($pngPath, $pngBytes)
$fixtures += @{ leaf = 'lab-pixel.png'; mime = 'image/png' }

# Fixture 4: a subdirectory entry (the index is path-based; navigation shows it
# as a folder row when the UI groups by path prefix).
$subDir = Join-Path $fixtureDir 'subdir'
New-Item -ItemType Directory -Force -Path $subDir | Out-Null
$subPath = Join-Path $subDir 'lab-nested.txt'
[System.IO.File]::WriteAllText($subPath, "nested lab fixture`n", (New-Object System.Text.UTF8Encoding($false)))
$fixtures += @{ leaf = 'subdir\lab-nested.txt'; mime = 'text/plain' }

$files = @()
foreach ($f in $fixtures) {
    $abs = Join-Path $fixtureDir $f.leaf
    $rel = '/lab-fixture/' + (($f.leaf -replace '\\', '/'))
    $size = (Get-Item -LiteralPath $abs).Length
    $mtime = ([datetime](Get-Item -LiteralPath $abs).LastWriteTimeUtc).ToString('o')
    $sha256 = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLowerInvariant()
    $files += [ordered]@{
        id = (Get-FxStableIdLocal 'RDP-Storage' $rel)
        root = 'RDP-Storage'
        path = $rel
        size = $size
        mtime = $mtime
        mime = [string]$f.mime
        checksum = $sha256
        tags = @('lab-fixture')
        pinned = $false
        trashed = $false
        trashedAt = $null
        recentsTs = $null
        upload = [ordered]@{ phase = $null; status = 'idle'; retries = 0; lastError = $null; bytesSent = 0 }
        gofile = [ordered]@{ code = $null; fileId = $null; directUrl = $null; status = 'none'; uploadedAt = $null; expiryTs = $null; downloads = 0; remoteSize = $null }
    }
}

$index = [ordered]@{
    schemaVersion = 2
    generatedAt = $iso
    runnerId = 'slab-fx-fixture'
    roots = @(
        [ordered]@{ root = 'RDP-Storage'; scannedAt = $iso; totalBytes = ($files | Measure-Object -Property size -Sum).Sum; fileCount = $files.Count; quotaBytes = $null }
    )
    files = $files
    gofileHosts = @()
}
$indexPath = Join-Path $StageRoot 'fx-index.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($indexPath, ($index | ConvertTo-Json -Depth 8), $utf8)

# Read back and verify what the module will read.
$back = [System.IO.File]::ReadAllText($indexPath) | ConvertFrom-Json
if ([int]$back.schemaVersion -ne 2) { throw 'FX_INDEX_READBACK_BAD_SCHEMA' }
if (@($back.files).Count -lt 4) { throw 'FX_INDEX_READBACK_FILECOUNT' }
foreach ($f in $files) {
    $match = @($back.files) | Where-Object { [string]$_.id -eq $f.id } | Select-Object -First 1
    if (-not $match) { throw "FX_INDEX_READBACK_MISSING_ID $($f.id)" }
    if ([int64]$match.size -ne [int64]$f.size) { throw "FX_INDEX_READBACK_SIZE $($f.path)" }
}

$report = [ordered]@{
    schema = 'slab-fx-fixtures/1'; generatedAt = $iso
    stageRoot = $StageRoot
    fixtureDir = $fixtureDir
    indexPath = $indexPath
    indexSha256 = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash.ToLowerInvariant()
    root = 'RDP-Storage'
    files = @($files | ForEach-Object { [ordered]@{ id = $_.id; path = $_.path; size = $_.size; mime = $_.mime; sha256 = $_.checksum } })
}
$json = $report | ConvertTo-Json -Depth 6
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, $utf8) }
Write-Host $json
Write-Host "::notice title=fx fixtures::$($files.Count) disposable files + fx-index.json staged under the production RDP-Storage root"
