<#
.SYNOPSIS
Stages the supreme-lamp backend + dashboard from an exact-SHA checkout using
the app's OWN staging functions (scripts/f60-stage-and-start.ps1), without
starting anything. The lab's backend-supervisor.js starts and owns the server
process afterwards (Start-F60ColdProcesses does not track PIDs).

.NOTES
Parameter names are deliberately prefixed (Lab*) because dot-sourcing the app
scripts binds THEIR param blocks in this scope ($Root, $Workspace,
$UiReleaseTag, $UiBundleSha, ...), which would silently replace ours.
#>
param(
    [Parameter(Mandatory = $true)][string]$LabAppDir,
    [Parameter(Mandatory = $true)][string]$LabSha,
    [string]$LabStageRoot = 'C:\ghrdp',
    [string]$LabAppRepo = 'dictationb1/supreme-lamp',
    [string]$LabOut = '',
    # [CANDIDATE] Path to a LOCALLY BUILT single-file UI (index.html). When set,
    # the release-asset download is SKIPPED and this build is staged instead,
    # with its own sha256 recorded. Use for a patched candidate: the bundle
    # under test must be the bytes built from the patched tree, never an
    # upstream release asset (which would present patched server code with an
    # unpatched UI, or vice versa).
    [string]$LabLocalUi = '',
    # [CANDIDATE] Free-form identity for the staged build (e.g. the lab revision
    # and patch-series id). Recorded in the stage result; never a secret.
    [string]$LabUiIdentity = ''
)
$ErrorActionPreference = 'Stop'

# Surface the failing statement as an annotation: job logs live on a blob host
# that some tooling cannot read, annotations are readable via api.github.com.
trap {
    $m = ($_.Exception.Message -replace '[\r\n]+', ' ')
    $pos = ''
    if ($_.InvocationInfo) { $pos = ('{0}:{1} {2}' -f $_.InvocationInfo.ScriptName, $_.InvocationInfo.ScriptLineNumber, ($_.InvocationInfo.Line -replace '[\r\n]+', ' ').Trim()) }
    Write-Host ('::error title=Stage-App failed::' + $m + ' @ ' + $pos)
    if ($env:GITHUB_OUTPUT) { ('stage_error=' + $m + ' @ ' + $pos) | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
    exit 1
}
$ProgressPreference = 'SilentlyContinue'

$keep = @{ AppDir = (Resolve-Path -LiteralPath $LabAppDir).Path; Sha = $LabSha; StageRoot = $LabStageRoot; Repo = $LabAppRepo; Out = $LabOut }
if ($keep.Sha -notmatch '^[0-9a-f]{40}$') { throw "STAGE_SHA_INVALID: $($keep.Sha)" }

$head = (& git -C $keep.AppDir rev-parse HEAD).Trim()
if ($head -ne $keep.Sha) { throw "STAGE_CHECKOUT_MISMATCH: $($keep.AppDir) HEAD=$head expected $($keep.Sha)" }

if (-not $env:GH_TOKEN) { throw 'MISSING_CONFIG: GH_TOKEN is required to read the ui-dist release' }
$keep.Token = $env:GH_TOKEN
$keep.StageScript = Join-Path $keep.AppDir 'scripts\f60-stage-and-start.ps1'
$keep.Transport = Join-Path $keep.AppDir 'scripts\f60-bootstrap.ps1'
foreach ($f in @($keep.StageScript, $keep.Transport)) { if (-not (Test-Path -LiteralPath $f)) { throw "STAGE_SCRIPT_MISSING: $f" } }

# $keep is the only state read after these dot-sources (they rebind their own params here)
# ORDER MATTERS: both app scripts define Stage-F60UiBundle with DIFFERENT signatures
#   f60-bootstrap.ps1       (Root, Tag, BundleSha, Owner, Repo, Token, NodeExe)
#   f60-stage-and-start.ps1 (Root, Workspace, Tag, BundleSha, Repo='owner/name', Token)
# and they are simple functions, so a mismatched -Workspace is silently swallowed into
# $args. Loading the transport last (run 39544022089) bound the bootstrap variant:
# Owner was empty, the URL became /repos//owner/name/... and curl -f reported
# "release ui-dist not readable". Neither variant is called any more (see the UI
# bundle block below); the order is kept so the stage script's definitions win.
$labKeep = $keep
. $labKeep.Transport -DefineOnly
. $labKeep.StageScript -DefineOnly
$keep = $labKeep
foreach ($fn in @('Stage-F60FromCheckout', 'Get-F60ReleaseAssetInfo', 'Get-F60File')) {
    if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw "STAGE_FUNCTION_MISSING: $fn not defined after dot-sourcing the app scripts" }
}

if (Test-Path -LiteralPath $keep.StageRoot) {
    Write-Host "[stage] removing previous $($keep.StageRoot) (ephemeral hosted runner)"
    Remove-Item -LiteralPath $keep.StageRoot -Recurse -Force
}
$fromCheckout = Stage-F60FromCheckout -Root $keep.StageRoot -Workspace $keep.AppDir -BuildSha $keep.Sha

if ($LabLocalUi) {
    # --- CANDIDATE: locally built patched UI -----------------------------------
    # The bytes under test come from the patched tree build, not the upstream
    # release. Same acceptance shape as the production rule: index.html must
    # exist and be > 51200 bytes; its sha256 is recorded as the bundle id.
    if (-not (Test-Path -LiteralPath $LabLocalUi)) { throw "UI_BUNDLE_LOCAL_MISSING: $LabLocalUi" }
    $idxSrc = (Resolve-Path -LiteralPath $LabLocalUi).Path
    $bundleBytes = (Get-Item -LiteralPath $idxSrc).Length
    if ($bundleBytes -le 51200) { throw "UI_BUNDLE_TOO_SMALL: local build index.html is $bundleBytes bytes (main.yml requires > 51200)" }
    $localSha = (Get-FileHash -LiteralPath $idxSrc -Algorithm SHA256).Hash.ToLowerInvariant()
    $uiDir = Join-Path $keep.StageRoot 'ui'
    $null = New-Item -ItemType Directory -Path $uiDir -Force
    Copy-Item -LiteralPath $idxSrc -Destination (Join-Path $uiDir 'index.html') -Force
    Copy-Item -LiteralPath $idxSrc -Destination (Join-Path $keep.StageRoot 'ui-v2.html') -Force
    Write-Host "[stage] CANDIDATE UI (locally built) sha256=$localSha ($bundleBytes bytes) identity=$LabUiIdentity -> ui\index.html + ui-v2.html"
    $bundle = @{ asset = ('local-build-' + $localSha.Substring(0, 12)); bytes = $bundleBytes; sha256 = $localSha; identity = [string]$LabUiIdentity; source = 'local-patched-build' }
} else {
    # --- commit-matched UI bundle (upstream release asset) ---------------------
    # Follows the app's PRODUCTION rule (.github/workflows/main.yml "ui-prebuilt" step):
    #   exact asset ui-dist-<sha>.zip + its .sha256 sidecar -> scripts/f59-verify-sha256.mjs
    #   (fail-closed) -> unzip -> out/index.html must exist and be > 51200 bytes
    # using the app's own release transport (Get-F60ReleaseAssetInfo / Get-F60File).
    # The F60 helper Stage-F60UiBundle is NOT used: both copies pass @(...) (an object[])
    # to [ZipFileExtensions]::ExtractToFile, which fails overload resolution on the
    # hosted pwsh ("Cannot find an overload for ExtractToFile ... 3", run 39544601888).
    # That is an app defect, reported in RECOVERY_CHECKPOINT.md.
    $repoParts = $keep.Repo -split '/', 2
    $zipName = 'ui-dist-' + $keep.Sha + '.zip'
    $sideName = $zipName + '.sha256'
    $rel = Get-F60ReleaseAssetInfo -Tag 'ui-dist' -Owner $repoParts[0] -Repo $repoParts[1] -Token $keep.Token
    $assets = @($rel.assets)
    $zipAsset = $assets | Where-Object { [string]$_.name -eq $zipName } | Select-Object -First 1
    $sideAsset = $assets | Where-Object { [string]$_.name -eq $sideName } | Select-Object -First 1
    if (-not $zipAsset) { throw "UI_BUNDLE_MISSING: release ui-dist has no $zipName (never a different commit's bundle)" }
    if (-not $sideAsset) { throw "UI_BUNDLE_UNVERIFIABLE: release ui-dist has no sidecar $sideName" }
    $tmpBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
    $dl = Join-Path $tmpBase ('ui-dl-' + $keep.Sha.Substring(0, 12))
    if (Test-Path -LiteralPath $dl) { Remove-Item -LiteralPath $dl -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $dl -Force
    $sideOut = Join-Path $dl $sideName
    $null = Get-F60File -Url ([string]$sideAsset.url) -Out $sideOut -Label 'ui-dist sidecar' -AuthToken $keep.Token -Accept 'application/octet-stream' -MinBytes 8 -NoPin
    $expected = (([System.IO.File]::ReadAllText($sideOut)) -replace '\s', '').ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "UI_BUNDLE_SIDECAR_INVALID: $sideName does not contain a 64-hex sha256" }
    $zipOut = Join-Path $dl $zipName
    $null = Get-F60File -Url ([string]$zipAsset.url) -Out $zipOut -Label ('ui bundle ' + $zipName) -ExpectedSha $expected -AuthToken $keep.Token -Accept 'application/octet-stream' -MinBytes 51200
    & node (Join-Path $keep.AppDir 'scripts\f59-verify-sha256.mjs') $zipOut $expected --label $zipName
    if ($LASTEXITCODE -ne 0) { throw "UI_BUNDLE_VERIFY_FAILED: scripts/f59-verify-sha256.mjs rejected $zipName" }
    $extract = Join-Path $dl 'out'
    Expand-Archive -LiteralPath $zipOut -DestinationPath $extract -Force
    $idxSrc = Join-Path $extract 'index.html'
    if (-not (Test-Path -LiteralPath $idxSrc)) { throw "UI_BUNDLE_NO_INDEX: $zipName has no top-level index.html" }
    $bundleBytes = (Get-Item -LiteralPath $idxSrc).Length
    if ($bundleBytes -le 51200) { throw "UI_BUNDLE_TOO_SMALL: index.html is $bundleBytes bytes (main.yml requires > 51200)" }
    $uiDir = Join-Path $keep.StageRoot 'ui'
    $null = New-Item -ItemType Directory -Path $uiDir -Force
    Copy-Item -LiteralPath $idxSrc -Destination (Join-Path $uiDir 'index.html') -Force
    Copy-Item -LiteralPath $idxSrc -Destination (Join-Path $keep.StageRoot 'ui-v2.html') -Force
    Write-Host "[stage] UI bundle $zipName sha256=$expected ($bundleBytes bytes) -> ui\index.html + ui-v2.html"
    $bundle = @{ asset = $zipName; bytes = $bundleBytes; sha256 = $expected; source = 'upstream-release-asset' }
}

$ui = Join-Path $keep.StageRoot 'ui.html'
if (-not (Test-Path -LiteralPath $ui)) { throw 'STAGE_UI_MISSING: ui.html was not staged' }
$uiText = [System.IO.File]::ReadAllText($ui)
if ($uiText.Contains('__BUILD_SHA__')) { throw 'STAGE_BUILD_SHA_NOT_SUBSTITUTED' }
if (-not $uiText.Contains($keep.Sha)) { throw 'STAGE_BUILD_SHA_ABSENT: ui.html does not carry the pinned sha' }
$server = Join-Path $keep.StageRoot 'ghrdp-server.ps1'
if (-not (Test-Path -LiteralPath $server)) { throw 'STAGE_SERVER_MISSING' }

$result = [ordered]@{
    sha             = $keep.Sha
    stageRoot       = $keep.StageRoot
    staged          = $fromCheckout.staged
    missing         = @($fromCheckout.missing)
    uiBundle        = $bundle.asset
    uiBundleBytes   = $bundle.bytes
    uiBundleSha256  = $bundle.sha256
    uiBundleSource  = [string]$bundle.source
    uiBundleIdentity = [string]$LabUiIdentity
    serverSha256    = (Get-FileHash -LiteralPath $server -Algorithm SHA256).Hash.ToLowerInvariant()
    uiHtmlSha256    = (Get-FileHash -LiteralPath $ui -Algorithm SHA256).Hash.ToLowerInvariant()
}
$json = $result | ConvertTo-Json -Depth 4
Write-Host $json
if ($keep.Out) { [System.IO.File]::WriteAllText($keep.Out, $json) }
Write-Host "::notice title=App staged::sha=$($keep.Sha) staged=$($result.staged) bundle=$($result.uiBundle)"
