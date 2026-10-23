<#
.SYNOPSIS
Bootstrap / inspect / roll back a NARROW RDP-file signing identity on the
dedicated lab client VM, so mstsc opens the lab's own .rdp files without the
per-connection "Remote Desktop Connection security warning" review.

.DESCRIPTION
Why this exists (reproduced, lab run 39819073772, job `client`):
  mstsc(3820) showed "Remote Desktop Connection security warning" with
  Publisher: "Unknown publisher" and both "Don't ask me again" boxes unchecked.
  Accepting the first-launch consent does NOT resolve it: the protection is
  per-connection and keyed to the signing identity of the .rdp file.

The supported fix (Microsoft Learn, "RDP file security in Group Policy"):
  Computer Configuration > Administrative Templates > Windows Components >
  Remote Desktop Services > Remote Desktop Connection Client >
  "Specify thumbprints of certificates representing trusted .rdp publishers".

That policy is populated only for a certificate that signs the .rdp file. This
script therefore:
  1. reads the machine's OWN TerminalServer.admx to learn the exact registry
     key / list subkey / value prefix for TS_CLIENT_TRUSTED_CERTIFICATE_THUMBPRINTS_1
     (never assumes a layout that a Windows build may change),
  2. creates ONE dedicated self-signed code-signing certificate (RSA 3072,
     SHA-256, EKU Code Signing) in LocalMachine\My and pins its public part in
     LocalMachine\Root so the signature validates as trusted,
  3. pins ONLY that thumbprint in the trusted-.rdp-publisher policy,
  4. proves it with a signed probe .rdp opened by the real mstsc.exe, using the
     lab's own dialog enumerator to check that no security-review dialog exists.

WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
  * it never sets AllowUnsignedFiles / AllowSignedFiles (nothing is blocked --
    this adds trust for one publisher, it does not change what may run);
  * it never sets RedirectionWarningDialogVersion (the "silence the dialog"
    stopgap that disables the protection instead of satisfying it);
  * it never touches NLA/TLS, certificate verification, or credentials;
  * it trusts exactly one thumbprint, not "all publishers";
  * every write is idempotent and reversible with -Mode Rollback, and the
    identity it creates is recorded in $StateDir\identity.json.

.PARAMETER Mode
  Status    read-only: build, admin state, ADMX-derived policy layout, current
            policy values, candidate signing certs, recorded identity.
  Bootstrap create/refresh the identity + policy, then verify (no probe).
  Probe     sign a throwaway .rdp and open it with mstsc to prove the security
            review dialog is gone.
  Sign      sign one file (-File) with the recorded identity and verify it.
  Rollback  remove the policy entries and certificates this script created.

.EXAMPLE
  .\Initialize-RdpFileSigning.ps1 -Mode Status
.EXAMPLE
  .\Initialize-RdpFileSigning.ps1 -Mode Bootstrap
.EXAMPLE
  .\Initialize-RdpFileSigning.ps1 -Mode Probe -ProbeSeconds 12
.EXAMPLE
  .\Initialize-RdpFileSigning.ps1 -Mode Rollback
#>
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Bootstrap', 'Probe', 'Sign', 'Rollback')]
    [string]$Mode = 'Status',
    [string]$File = '',
    [string]$Thumbprint = '',
    [string]$Subject = 'CN=supreme-lamp RDP file signing (lab client)',
    [int]$ValidYears = 2,
    [int]$ProbeSeconds = 12,
    [string]$StateDir = (Join-Path $env:ProgramData 'slab-rdp-signing')
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$PolicyRoot = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$PolicyRootBare = 'SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
$AdmxPath = Join-Path $env:SystemRoot 'PolicyDefinitions\TerminalServer.admx'
$IdentityPath = Join-Path $StateDir 'identity.json'
$Result = [ordered]@{
    script            = 'Initialize-RdpFileSigning'
    mode              = $Mode
    generatedAt       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    computer          = $env:COMPUTERNAME
    user              = "$env:USERDOMAIN\$env:USERNAME"
    powershell        = $PSVersionTable.PSVersion.ToString()
    isAdmin           = $false
    osBuild           = $null
    admxPolicyFound   = $false
    admxKey           = $null
    admxValuePrefix   = $null
    admxLayout       = $null
    policyKey         = $null
    policyValues      = $null
    identity          = $null
    actions           = @()
    probe             = $null
    ok                = $false
    code              = 'NOT_RUN'
    detail            = $null
}

function Get-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Get-OsBuild {
    try {
        $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        return ("{0}.{1}" -f $cv.CurrentBuild, $cv.UBR)
    } catch { return $null }
}

# ---------------------------------------------------------------- ADMX reading
# Learn the policy's real registry shape from the machine's own ADMX instead of
# hardcoding a layout. Returns $null when the policy is not present (older OS).
function Get-ThumbprintPolicyLayout {
    if (-not (Test-Path -LiteralPath $AdmxPath)) { return $null }
    try {
        [xml]$admx = Get-Content -LiteralPath $AdmxPath -Raw -ErrorAction Stop
    } catch { return $null }
    $policies = @($admx.policyDefinitions.policies.policy)
    $target = $policies | Where-Object { $_.name -eq 'TS_CLIENT_TRUSTED_CERTIFICATE_THUMBPRINTS_1' } | Select-Object -First 1
    if (-not $target) { return $null }
    $layout = [ordered]@{
        policyName  = [string]$target.name
        class       = [string]$target.class
        policyKey   = [string]$target.key
        valueName   = [string]$target.valueName
        listKey     = $null
        valuePrefix = ''
        elementType = $null
    }
    $elements = @()
    if ($target.elements) { $elements = @($target.elements.ChildNodes) }
    $listEl = $elements | Where-Object { $_.LocalName -eq 'list' } | Select-Object -First 1
    if ($listEl) {
        $layout.elementType = 'list'
        if ($listEl.key) { $layout.listKey = [string]$listEl.key }
        if ($listEl.valuePrefix) { $layout.valuePrefix = [string]$listEl.valuePrefix }
    } else {
        $textEl = $elements | Where-Object { $_.LocalName -eq 'text' } | Select-Object -First 1
        if ($textEl) {
            $layout.elementType = 'text'
            if ($textEl.valuePrefix) { $layout.valuePrefix = [string]$textEl.valuePrefix }
        }
    }
    return [pscustomobject]$layout
}

function Resolve-PolicyTarget {
    param($Layout)
    # Prefer the ADMX list key (numbered values), else the documented default.
    $key = $PolicyRootBare + '\TrustedCertThumbprints'
    $prefix = 'sha256:'
    if ($Layout) {
        if ($Layout.listKey) { $key = [string]$Layout.listKey }
        elseif ($Layout.policyKey) { $key = [string]$Layout.policyKey }
        if ($null -ne $Layout.valuePrefix) { $prefix = [string]$Layout.valuePrefix }
    }
    return [pscustomobject]@{ key = $key; keyPath = ('HKLM:\' + $key); valuePrefix = $prefix }
}

function Get-PolicySnapshot {
    param($Target)
    $snap = [ordered]@{ keyPath = $Target.keyPath; exists = $false; values = @(); thumbprintLike = @() }
    if (Test-Path -LiteralPath $Target.keyPath) {
        $snap.exists = $true
        $props = Get-ItemProperty -LiteralPath $Target.keyPath -ErrorAction SilentlyContinue
        if ($props) {
            foreach ($n in $props.PSObject.Properties.Name) {
                if ($n -like 'PS*') { continue }
                $v = [string]$props.$n
                $snap.values += [pscustomobject]@{ name = $n; value = $v }
                if ($v -match '(?i)[0-9a-f]{40,64}') { $snap.thumbprintLike += $v }
            }
        }
    }
    # also report the two Allow* policies so the report can show nothing was blocked
    $allow = [ordered]@{ AllowUnsignedFiles = $null; AllowSignedFiles = $null }
    if (Test-Path -LiteralPath $PolicyRoot) {
        $p = Get-ItemProperty -LiteralPath $PolicyRoot -ErrorAction SilentlyContinue
        if ($p) {
            if ($null -ne $p.AllowUnsignedFiles) { $allow.AllowUnsignedFiles = $p.AllowUnsignedFiles }
            if ($null -ne $p.AllowSignedFiles) { $allow.AllowSignedFiles = $p.AllowSignedFiles }
        }
    }
    $snap['allowPolicies'] = $allow
    return [pscustomobject]$snap
}

function Get-NormalizedThumbprint {
    param([string]$Value)
    if (-not $Value) { return '' }
    return (($Value -replace '[^0-9A-Fa-f]', '').ToUpperInvariant())
}

# --------------------------------------------------------------- identity I/O
function Read-Identity {
    if (-not (Test-Path -LiteralPath $IdentityPath)) { return $null }
    try { return (Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-Identity {
    param($Identity)
    if (-not (Test-Path -LiteralPath $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    }
    ($Identity | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $IdentityPath -Encoding UTF8
}

function Find-SigningCert {
    param([string]$Thumbprint)
    $want = Get-NormalizedThumbprint $Thumbprint
    if (-not $want) { return $null }
    foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My')) {
        $c = Get-ChildItem -Path $store -ErrorAction SilentlyContinue |
            Where-Object { (Get-NormalizedThumbprint $_.Thumbprint) -eq $want } |
            Select-Object -First 1
        if ($c) { return $c }
    }
    return $null
}

# --------------------------------------------------------------- trust writing
function Set-TrustedPublisherPolicy {
    param($Target, [string]$Thumb)
    $entry = $Target.valuePrefix + $Thumb
    if (-not (Test-Path -LiteralPath $Target.keyPath)) {
        New-Item -Path $Target.keyPath -Force | Out-Null
    }
    $existing = @()
    $props = Get-ItemProperty -LiteralPath $Target.keyPath -ErrorAction SilentlyContinue
    if ($props) {
        foreach ($n in $props.PSObject.Properties.Name) {
            if ($n -like 'PS*') { continue }
            $existing += [pscustomobject]@{ name = $n; value = [string]$props.$n }
        }
    }
    # Replace only entries that reference a lab identity we recorded before, and
    # always keep exactly one entry for the current thumbprint.
    $keep = @()
    foreach ($e in $existing) {
        $hex = Get-NormalizedThumbprint $e.value
        if ($hex -eq $Thumb) { continue }               # re-added below
        $keep += $e
    }
    $i = 1
    foreach ($e in $keep) {
        New-ItemProperty -LiteralPath $Target.keyPath -Name ([string]$i) -Value $e.value -PropertyType String -Force | Out-Null
        $i++
    }
    New-ItemProperty -LiteralPath $Target.keyPath -Name ([string]$i) -Value $entry -PropertyType String -Force | Out-Null
    return [pscustomobject]@{ entry = $entry; keyPath = $Target.keyPath; index = $i; kept = $keep.Count }
}

function Sign-RdpFile {
    param([string]$Path, [string]$Thumb)
    $rdpsign = Join-Path $env:SystemRoot 'System32\rdpsign.exe'
    if (-not (Test-Path -LiteralPath $rdpsign)) {
        return [pscustomobject]@{ ok = $false; code = 'RDPSIGN_NOT_FOUND'; detail = $rdpsign }
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ ok = $false; code = 'RDP_FILE_MISSING'; detail = $Path }
    }
    # rdpsign resolves the certificate from the store OF THE CALLING ACCOUNT, and
    # the exact switch set differs between builds. Try the documented shapes in
    # order and record which one worked; a failure is the rdpsign message, never
    # a silent "unsigned but probably fine".
    #   measured 2026-10-22 (Server 2022 20348.5756): /sha256 /sha1 failed with
    #   0x80092004 "Unable locate the certificate specified" while the cert was
    #   only in LocalMachine\My - the calling account could not see it.
    $attempts = @(
        @{ name = 'sha256+sha1'; args = @('/sha256', '/sha1', $Thumb, $Path) },
        @{ name = 'sha1';        args = @('/sha1', $Thumb, $Path) },
        @{ name = 'sha256';      args = @('/sha256', $Thumb, $Path) },
        @{ name = 'plain';       args = @($Thumb, $Path) }
    )
    $tried = @()
    $finalOut = @()
    $used = $null
    $exitCode = 1
    foreach ($a in $attempts) {
        $out = & $rdpsign @($a.args) 2>&1
        $exitCode = $LASTEXITCODE
        $tried += [pscustomobject]@{ switch = $a.name; exitCode = $exitCode; output = (($out | Out-String) -replace '\s+', ' ').Trim() }
        $finalOut = $out
        if ($exitCode -eq 0) { $used = $a.name; break }
    }
    $sig = $null
    try { $sig = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop } catch { $sig = $null }
    $sigStatus = if ($sig) { [string]$sig.Status } else { 'UNKNOWN' }
    $signer = if ($sig -and $sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { $null }
    $sigThumb = if ($sig -and $sig.SignerCertificate) { Get-NormalizedThumbprint $sig.SignerCertificate.Thumbprint } else { $null }
    # rdpsign's exit code is the authority for an .rdp; Get-AuthenticodeSignature
    # may report NotSigned because .rdp is not a SIP-verified extension, so it is
    # recorded as a second opinion and never used to override a success.
    $ok = ($exitCode -eq 0)
    $text = (($finalOut | Out-String) -replace '\s+', ' ').Trim()
    return [pscustomobject]@{
        ok               = $ok
        code             = $(if ($ok) { 'SIGNED' } else { 'SIGN_FAILED' })
        exitCode         = $exitCode
        switchUsed       = $used
        attempts         = $tried
        authenticodeStatus = $sigStatus
        signer           = $signer
        thumbprint       = $sigThumb
        output           = $text.Substring(0, [Math]::Min(400, $text.Length))
    }
}

function New-ProbeRdpFile {
    param([string]$Path)
    # A syntactically valid file whose target is a tailnet address that is NOT
    # this run's server: the security review happens BEFORE any connection, so
    # an unreachable target makes the probe safe and still meaningful.
    $lines = @(
        'full address:s:100.64.0.1',
        'username:s:slabrdp',
        'prompt for credentials:i:0',
        'promptcredentialonce:i:0',
        'authentication level:i:0',
        'enablecredsspsupport:i:1',
        'screen mode id:i:1',
        'desktopwidth:i:1024',
        'desktopheight:i:768',
        'redirectclipboard:i:0',
        'redirectdrives:i:0',
        'redirectprinters:i:0',
        'redirectsmartcards:i:0',
        'autoreconnection enabled:i:0'
    )
    Set-Content -LiteralPath $Path -Value ($lines -join "`r`n") -Encoding ASCII
    return (Get-Item -LiteralPath $Path).Length
}

# ------------------------------------------------------------------- main body
$Result.isAdmin = Get-IsAdmin
$Result.osBuild = Get-OsBuild

$layout = Get-ThumbprintPolicyLayout
if ($layout) {
    $Result.admxPolicyFound = $true
    $Result.admxKey = $layout.listKey
    $Result.admxValuePrefix = $layout.valuePrefix
    $Result.admxLayout = $layout
}
$target = Resolve-PolicyTarget -Layout $layout
$Result.policyKey = $target.keyPath
$Result.policyValues = Get-PolicySnapshot -Target $target
$recorded = Read-Identity
if ($recorded) { $Result.identity = $recorded }

$mstsc = Join-Path $env:SystemRoot 'System32\mstsc.exe'

switch ($Mode) {
    'Status' {
        $certs = @((Get-ChildItem -Path Cert:\CurrentUser\My -ErrorAction SilentlyContinue) + (Get-ChildItem -Path Cert:\LocalMachine\My -ErrorAction SilentlyContinue) |
            Where-Object { $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') } |
            Select-Object -First 10 |
            ForEach-Object {
                [pscustomobject]@{
                    subject    = $_.Subject
                    thumbprint = $_.Thumbprint
                    notAfter   = $_.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    sha256     = $_.SignatureAlgorithm.FriendlyName
                }
            })
        $Result['codeSigningCerts'] = $certs
        $Result['rootPinned'] = $false
        if ($recorded -and $recorded.thumbprint) {
            $Result['rootPinned'] = [bool](Get-ChildItem -Path Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
                Where-Object { (Get-NormalizedThumbprint $_.Thumbprint) -eq (Get-NormalizedThumbprint $recorded.thumbprint) })
        }
        $Result.ok = $true
        $Result.code = 'STATUS_ONLY'
    }
    'Bootstrap' {
        if (-not $Result.isAdmin) {
            $Result.code = 'NOT_ADMIN'
            $Result.detail = 'Bootstrap writes machine policy and LocalMachine certificate stores; it needs an elevated (Administrator) runner account'
            break
        }
        $cert = $null
        if ($recorded -and $recorded.thumbprint) {
            $cert = Find-SigningCert -Thumbprint $recorded.thumbprint
            # A certificate created by an earlier run of THIS script landed in
            # LocalMachine\My; rdpsign cannot resolve it from the calling account
            # (measured 0x80092004), so a recorded machine-only identity is
            # replaced by a signing-account one instead of being reported as fine.
            if ($cert -and ([string]$cert.PSPath) -notmatch 'CurrentUser') {
                $Result.actions += "recorded certificate $($cert.Thumbprint) is machine-only and unusable for signing; creating a signing-account identity"
                $cert = $null
            }
        }
        if (-not $cert) {
            # The signing certificate lives in the RUNNER ACCOUNT's personal store
            # (CurrentUser\My): rdpsign resolves it from the calling account, not
            # from LocalMachine (measured: 0x80092004 when it was only machine-wide).
            # The machine store keeps the PUBLIC part so any launcher account on
            # this VM can validate the signature.
            $cert = New-SelfSignedCertificate -Type CodeSigningCert `
                -Subject $Subject `
                -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
                -KeyExportPolicy NonExportable `
                -CertStoreLocation 'Cert:\CurrentUser\My' `
                -NotAfter (Get-Date).AddYears($ValidYears) `
                -ErrorAction Stop
            $Result.actions += "created code-signing certificate $($cert.Thumbprint) in CurrentUser\My (signing account store)"
        } else {
            $Result.actions += "reused recorded certificate $($cert.Thumbprint)"
        }
        # Pin the PUBLIC part in Root so the Authenticode signature validates as
        # trusted on this VM. Scoped to this one self-signed certificate.
        $cerPath = Join-Path $StateDir 'rdp-signing.cer'
        if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
        Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT -Force | Out-Null
        $inRoot = Get-ChildItem -Path Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
            Where-Object { (Get-NormalizedThumbprint $_.Thumbprint) -eq (Get-NormalizedThumbprint $cert.Thumbprint) }
        if (-not $inRoot) {
            Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
            $Result.actions += "imported the public certificate into LocalMachine\Root (trust scoped to this thumbprint only)"
        }
        $thumb = Get-NormalizedThumbprint $cert.Thumbprint
        $written = Set-TrustedPublisherPolicy -Target $target -Thumb $thumb
        $Result.actions += "pinned $($written.entry) at $($written.keyPath)\$($written.index) ($($written.kept) unrelated entr(ies) preserved)"
        $identity = [pscustomobject]@{
            createdBy  = 'scripts/ps/Initialize-RdpFileSigning.ps1'
            createdAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            computer   = $env:COMPUTERNAME
            subject    = $cert.Subject
            thumbprint = $thumb
            notAfter   = $cert.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            policyKey  = $target.keyPath
            policyValue= $written.entry
            cerPath    = $cerPath
            rollback   = 'powershell -File scripts/ps/Initialize-RdpFileSigning.ps1 -Mode Rollback'
        }
        Write-Identity -Identity $identity
        $Result.identity = $identity
        $Result.policyValues = Get-PolicySnapshot -Target $target
        $Result.ok = $true
        $Result.code = 'BOOTSTRAP_OK'
    }
    'Probe' {
        $idRec = Read-Identity
        if (-not $idRec -or -not $idRec.thumbprint) {
            $Result.code = 'NO_IDENTITY'
            $Result.detail = 'no recorded signing identity; run -Mode Bootstrap first'
            break
        }
        if (-not (Test-Path -LiteralPath $mstsc)) {
            $Result.code = 'MSTSC_NOT_FOUND'
            $Result.detail = $mstsc
            break
        }
        $probeFile = Join-Path $StateDir 'probe.rdp'
        $null = New-ProbeRdpFile -Path $probeFile
        $sig = Sign-RdpFile -Path $probeFile -Thumb $idRec.thumbprint
        $Result.actions += "signed probe.rdp: $($sig.code) via=$($sig.switchUsed) authenticode=$($sig.authenticodeStatus)"
        if (-not $sig.ok) {
            $Result.probe = @{ signed = $false; signature = $sig }
            $Result.code = 'PROBE_SIGN_FAILED'
            $Result.detail = $sig.output
            break
        }
        $p = Start-Process -FilePath $mstsc -ArgumentList @($probeFile) -PassThru
        Start-Sleep -Seconds ([Math]::Max(4, [Math]::Min(60, $ProbeSeconds)))
        $dialogJson = $null
        try {
            $enumerator = Join-Path $PSScriptRoot 'Get-RdpDialogState.ps1'
            if (Test-Path -LiteralPath $enumerator) {
                $dialogJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $enumerator -ProcessId $p.Id 2>$null
            }
        } catch { $dialogJson = $null }
        $still = $null
        try { $still = -not $p.HasExited } catch { $still = $null }
        try { if ($still) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { }
        $reviewDialog = $false
        $dialogText = ''
        if ($dialogJson) {
            $dialogText = ((@($dialogJson) | Out-String))
            if ($dialogText -match '(?i)security review|security warning|Unknown publisher|rdp_file_security_review|consent') { $reviewDialog = $true }
        }
        $Result.probe = [pscustomobject]@{
            signedFile            = $probeFile
            signatureExitCode     = $sig.exitCode
            signatureSwitch       = $sig.switchUsed
            signatureAttempts     = $sig.attempts
            signatureStatus       = $sig.authenticodeStatus
            signatureThumbprint   = $sig.thumbprint
            mstscPid              = $p.Id
            mstscAliveAfterSeconds= $still
            securityDialogFound   = $reviewDialog
            dialogEvidence        = $dialogText.Substring(0, [Math]::Min(1200, $dialogText.Length))
        }
        if ($reviewDialog) {
            $Result.code = 'PROBE_SECURITY_DIALOG_PRESENT'
            $Result.detail = 'a signed .rdp still produced a security warning: the pinned thumbprint/prefix does not match what mstsc checks'
            $Result.ok = $false
        } else {
            $Result.code = 'PROBE_NO_SECURITY_DIALOG'
            $Result.ok = $true
        }
    }
    'Sign' {
        if (-not $File) { $Result.code = 'NO_FILE'; $Result.detail = '-File is required'; break }
        $thumb = $Thumbprint
        if (-not $thumb) {
            $rec = Read-Identity
            if ($rec) { $thumb = $rec.thumbprint }
        }
        if (-not $thumb) { $Result.code = 'NO_IDENTITY'; $Result.detail = 'no -Thumbprint and no recorded identity'; break }
        $sig = Sign-RdpFile -Path $File -Thumb (Get-NormalizedThumbprint $thumb)
        $Result['signature'] = $sig
        $Result.ok = $sig.ok
        $Result.code = $sig.code
        $Result.detail = $sig.output
    }
    'Rollback' {
        if (-not $Result.isAdmin) {
            $Result.code = 'NOT_ADMIN'
            $Result.detail = 'Rollback removes machine policy and certificates; it needs elevation'
            break
        }
        $rec = Read-Identity
        if (Test-Path -LiteralPath $target.keyPath) {
            Remove-Item -LiteralPath $target.keyPath -Recurse -Force -ErrorAction SilentlyContinue
            $Result.actions += "removed $($target.keyPath)"
        }
        if ($rec -and $rec.thumbprint) {
            $thumb = Get-NormalizedThumbprint $rec.thumbprint
            foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\My', 'Cert:\LocalMachine\Root')) {
                Get-ChildItem -Path $store -ErrorAction SilentlyContinue |
                    Where-Object { (Get-NormalizedThumbprint $_.Thumbprint) -eq $thumb } |
                    ForEach-Object {
                        Remove-Item -LiteralPath $_.PSPath -Force -ErrorAction SilentlyContinue
                        $Result.actions += "removed certificate $thumb from $store"
                    }
            }
        }
        if (Test-Path -LiteralPath $IdentityPath) {
            Remove-Item -LiteralPath $IdentityPath -Force -ErrorAction SilentlyContinue
            $Result.actions += "removed $IdentityPath"
        }
        $Result.ok = $true
        $Result.code = 'ROLLBACK_OK'
    }
}

# single-line JSON so a workflow can parse it without secrets or noise
$Result | ConvertTo-Json -Compress -Depth 8
