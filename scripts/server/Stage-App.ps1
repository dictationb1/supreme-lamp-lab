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
# "release ui-dist not readable". Transport first, cold-lane stage script second,
# then assert the bound signature so a shadowed definition fails loudly.
$labKeep = $keep
. $labKeep.Transport -DefineOnly
. $labKeep.StageScript -DefineOnly
$keep = $labKeep
foreach ($fn in @('Stage-F60FromCheckout', 'Stage-F60UiBundle', 'Get-F60ReleaseAssetInfo', 'Get-F60File')) {
    if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) { throw "STAGE_FUNCTION_MISSING: $fn not defined after dot-sourcing the app scripts" }
}
$uiParams = (Get-Command -Name 'Stage-F60UiBundle').Parameters
if (-not $uiParams.ContainsKey('Workspace') -or $uiParams.ContainsKey('Owner')) {
    throw ('STAGE_FUNCTION_SHADOWED: Stage-F60UiBundle is bound to the wrong definition (params: ' + (($uiParams.Keys | Sort-Object) -join ',') + ')')
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
