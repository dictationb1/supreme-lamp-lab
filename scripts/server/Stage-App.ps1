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
    [string]$LabOut = ''
)
$ErrorActionPreference = 'Stop'
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
$labKeep = $keep
. $labKeep.StageScript -DefineOnly
. $labKeep.Transport -DefineOnly
$keep = $labKeep
foreach ($fn in @('Stage-F60FromCheckout', 'Stage-F60UiBundle', 'Get-F60ReleaseAssetInfo', 'Get-F60File')) {
    if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw "STAGE_FUNCTION_MISSING: $fn not defined after dot-sourcing the app scripts" }
}

if (Test-Path -LiteralPath $keep.StageRoot) {
    Write-Host "[stage] removing previous $($keep.StageRoot) (ephemeral hosted runner)"
    Remove-Item -LiteralPath $keep.StageRoot -Recurse -Force
}
$fromCheckout = Stage-F60FromCheckout -Root $keep.StageRoot -Workspace $keep.AppDir -BuildSha $keep.Sha
$bundle = Stage-F60UiBundle -Root $keep.StageRoot -Workspace $keep.AppDir -Tag 'ui-dist' -BundleSha $keep.Sha -Repo $keep.Repo -Token $keep.Token

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
    serverSha256    = (Get-FileHash -LiteralPath $server -Algorithm SHA256).Hash.ToLowerInvariant()
    uiHtmlSha256    = (Get-FileHash -LiteralPath $ui -Algorithm SHA256).Hash.ToLowerInvariant()
}
$json = $result | ConvertTo-Json -Depth 4
Write-Host $json
if ($keep.Out) { [System.IO.File]::WriteAllText($keep.Out, $json) }
Write-Host "::notice title=App staged::sha=$($keep.Sha) staged=$($result.staged) bundle=$($result.uiBundle)"
