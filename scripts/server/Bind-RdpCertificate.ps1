<#
Bind a Tailscale-issued certificate to the disposable server's RDP-Tcp listener.
The private key stays in the ephemeral VM. No authentication-level bypass or
self-signed certificate substitution is permitted.

[OBSERVABILITY REPAIR 2026-10-24] This step failed on 16 consecutive capability
runs (every run since it was introduced) and the failure was INVISIBLE: the
script threw before writing $Out, the step has continue-on-error, and the
cert-fetch stdout/stderr files stayed in RUNNER_TEMP where nothing published
them. The supervise step could only report "cert=failure" with no cause, so the
root cause was never diagnosable from evidence. Now the script ALWAYS writes
the diagnostic JSON (stage, code, per-attempt exit codes and sanitized
tailscale output) to $Out, even on failure, and the workflow publishes it.
#>
param(
    [string]$StageRoot = 'C:\ghrdp',
    [string]$AppDir = 'app',
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$diag = [ordered]@{
    schema = 'slab-capability-certificate/2'; generatedAt = [datetime]::UtcNow.ToString('o')
    stage = 'start'; code = 'NOT_RUN'; ok = $false
    fqdn = $null; tailscaleVersion = $null; attempts = @(); error = $null
}
function Save-Diag {
    param([string]$Stage, [string]$Code, [string]$ErrorText)
    $diag.stage = [string]$Stage; $diag.code = [string]$Code
    if ($ErrorText) { $diag.error = ([string]$ErrorText).Substring(0, [Math]::Min(600, ([string]$ErrorText).Length)) }
    $diag.generatedAt = [datetime]::UtcNow.ToString('o')
    if ($Out) {
        try {
            $utf8d = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($Out, ($diag | ConvertTo-Json -Depth 6), $utf8d)
        } catch { }
    }
}
function Redact-TsText {
    # The cert fetch output could echo auth-adjacent state; strip lines that
    # look like a token/secret and cap length. Paths and error text from the
    # CLI are the diagnostic payload and stay.
    param([string]$Text)
    if (-not $Text) { return '' }
    $t = $Text -replace '(?im)^.*(?:token|secret|key-file).*$', '[REDACTED]'
    return $t.Substring(0, [Math]::Min(800, $t.Length))
}
try {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        Save-Diag 'preflight' 'REFUSED_NOT_HOSTED' $null
        throw 'REFUSED: Bind-RdpCertificate only runs on an ephemeral GitHub-hosted Windows server'
    }
    $ts = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $ts)) { $ts = 'tailscale.exe' }
    try { $diag.tailscaleVersion = [string]((& $ts version 2>$null | Select-Object -First 1)) } catch { $diag.tailscaleVersion = $null }
    Save-Diag 'preflight' 'TAILSCALE_LOCATED' $null
    $status = (& $ts status --json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { Save-Diag 'status' 'TAILSCALE_STATUS_FAILED' $null; throw 'TAILSCALE_STATUS_FAILED' }
    $fqdn = ([string]$status.Self.DNSName).TrimEnd('.')
    $diag.fqdn = $fqdn
    if ($fqdn -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') { Save-Diag 'status' 'MAGIC_DNS_UNAVAILABLE' "Self.DNSName='$fqdn'"; throw "MAGIC_DNS_UNAVAILABLE (Self.DNSName='$fqdn')" }
    Save-Diag 'status' 'DNS_OK' $null

    $tlsDir = Join-Path $StageRoot 'tls'
    New-Item -ItemType Directory -Path $tlsDir -Force | Out-Null
    & icacls.exe $tlsDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)R' | Out-Null
    if ($LASTEXITCODE -ne 0) { Save-Diag 'acl' 'TLS_DIRECTORY_ACL_FAILED' $null; throw 'TLS_DIRECTORY_ACL_FAILED' }
    Save-Diag 'acl' 'TLS_ACL_OK' $null
    $crt = Join-Path $tlsDir ($fqdn + '.crt')
    $key = Join-Path $tlsDir ($fqdn + '.key')
    $certOk = $false
    $lastCode = 'CERT_NOT_FETCHED'
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Remove-Item -LiteralPath $crt, $key -Force -ErrorAction SilentlyContinue
        $stdout = Join-Path $env:RUNNER_TEMP "capability-cert-$attempt.out"
        $stderr = Join-Path $env:RUNNER_TEMP "capability-cert-$attempt.err"
        $p = Start-Process -FilePath $ts -ArgumentList @('cert', '--cert-file', $crt, '--key-file', $key, $fqdn) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
        if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {}; Save-Diag 'cert-fetch' 'CERT_FETCH_TIMEOUT' $null; throw 'CERT_FETCH_TIMEOUT' }
        $err = if (Test-Path -LiteralPath $stderr) { Redact-TsText ([System.IO.File]::ReadAllText($stderr)) } else { '' }
        # NOTE: $outText (never $out) - PowerShell variables are case-insensitive,
        # so `$out` would silently clobber the $Out parameter Save-Diag writes to.
        $outText = if (Test-Path -LiteralPath $stdout) { Redact-TsText ([System.IO.File]::ReadAllText($stdout)) } else { '' }
        $certOk = ($p.ExitCode -eq 0 -and (Test-Path -LiteralPath $crt) -and (Test-Path -LiteralPath $key))
        $diag.attempts += [ordered]@{ n = $attempt; exitCode = $p.ExitCode; certPresent = (Test-Path -LiteralPath $crt); keyPresent = (Test-Path -LiteralPath $key); stderr = $err; stdout = $outText }
        if ($certOk) { break }
        $lastCode = if ($err -match 'HTTPS certificates disabled|does not support getting TLS certs') { 'CERT_CAPABILITY_UNAVAILABLE' }
            elseif ($err -match 'invalid hostname|not a valid domain') { 'CERT_INVALID_HOSTNAME' }
            elseif ($err -match 'access denied|unauthorized|forbidden') { 'CERT_AUTH_FAILED' }
            elseif ($err -match 'rate limit|too many requests') { 'CERT_RATE_LIMITED' }
            else { 'CERT_TRANSIENT_FETCH_FAILED' }
        if ($lastCode -ne 'CERT_TRANSIENT_FETCH_FAILED') { break }
        if ($attempt -lt 2) { Start-Sleep -Seconds 5 }
    }
    if (-not $certOk) {
        Save-Diag 'cert-fetch' $lastCode $null
        throw "$lastCode`: Tailscale certificate was not issued; refusing a self-signed fallback"
    }
    Save-Diag 'cert-fetch' 'CERT_FETCHED' $null

    $loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($crt, $key)
    if (-not $loaded.HasPrivateKey) { Save-Diag 'cert-load' 'CERT_PRIVATE_KEY_MISSING' $null; throw 'CERT_PRIVATE_KEY_MISSING' }
    $pfxBytes = $loaded.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, [string]::Empty)
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::MachineKeySet -bor
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, [string]::Empty, $flags)
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
    try { $store.Open('ReadWrite'); $store.Add($cert) } finally { $store.Close() }
    $thumb = [string]$cert.Thumbprint
    Save-Diag 'cert-store' 'CERT_IMPORTED' $null
    $grant = Join-Path $AppDir 'payloads\Grant-RdpKeyAccess.ps1'
    if (-not (Test-Path -LiteralPath $grant)) { Save-Diag 'key-acl' 'APP_KEY_ACCESS_HELPER_MISSING' "path=$grant"; throw "APP_KEY_ACCESS_HELPER_MISSING: $grant" }
    $keyFile = & $grant -Certificate $cert
    if ($LASTEXITCODE -ne 0 -or -not $keyFile) { Save-Diag 'key-acl' 'CERT_PRIVATE_KEY_ACL_FAILED' $null; throw 'CERT_PRIVATE_KEY_ACL_FAILED' }
    Save-Diag 'key-acl' 'KEY_ACL_OK' $null

    $rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
    Set-ItemProperty -Path $rdpKey -Name 'UserAuthentication' -Value 1 -Type DWord
    Set-ItemProperty -Path $rdpKey -Name 'SecurityLayer' -Value 2 -Type DWord
    Set-ItemProperty -Path $rdpKey -Name 'MinEncryptionLevel' -Value 3 -Type DWord
    $listenerPolicy = Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication','SecurityLayer','MinEncryptionLevel'
    if ([int]$listenerPolicy.UserAuthentication -ne 1 -or [int]$listenerPolicy.SecurityLayer -ne 2 -or [int]$listenerPolicy.MinEncryptionLevel -lt 3) { Save-Diag 'listener-policy' 'RDP_SECURITY_POLICY_READBACK_FAILED' $null; throw 'RDP_SECURITY_POLICY_READBACK_FAILED' }
    $setting = Get-CimInstance -Namespace 'root/cimv2/TerminalServices' -ClassName 'Win32_TSGeneralSetting' -Filter "TerminalName='RDP-Tcp'"
    $bind = Invoke-CimMethod -InputObject $setting -MethodName 'SetSSLCertificateSHA1Hash' -Arguments @{ SSLCertificateSHA1Hash = $thumb }
    if ($bind.ReturnValue -ne 0) {
        $bytes = for ($i = 0; $i -lt $thumb.Length; $i += 2) { [Convert]::ToByte($thumb.Substring($i, 2), 16) }
        New-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -PropertyType Binary -Value $bytes -Force | Out-Null
    }
    $bound = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash').SSLCertificateSHA1Hash
    $boundHex = ($bound | ForEach-Object { $_.ToString('X2') }) -join ''
    if ($boundHex -ine $thumb) { Save-Diag 'bind' 'CERT_BIND_MISMATCH' "bound=$boundHex expected=$thumb"; throw "CERT_BIND_MISMATCH: bound=$boundHex expected=$thumb" }
    Save-Diag 'bind' 'CERT_BOUND' $null

    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chainOk = [bool]$chain.Build($cert)
        $chainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
    } finally { $chain.Dispose() }
    if (-not $chainOk) { Save-Diag 'chain' 'CERT_CHAIN_UNTRUSTED' ($chainStatus -join ','); throw "CERT_CHAIN_UNTRUSTED: $($chainStatus -join ',')" }
    if ($cert.NotAfter.ToUniversalTime() -le [datetime]::UtcNow) { Save-Diag 'chain' 'CERT_EXPIRED' $null; throw 'CERT_EXPIRED' }
    $certDns = [string]$cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
    if ($certDns -ine $fqdn) { Save-Diag 'chain' 'CERT_HOSTNAME_MISMATCH' "certificate=$certDns expected=$fqdn"; throw "CERT_HOSTNAME_MISMATCH: certificate=$certDns expected=$fqdn" }
    Save-Diag 'chain' 'CHAIN_OK' $null
    Restart-Service -Name TermService -Force
    if ((Get-Service -Name TermService).Status -ne 'Running') { Save-Diag 'restart' 'TERMSERVICE_NOT_RUNNING_AFTER_BIND' $null; throw 'TERMSERVICE_NOT_RUNNING_AFTER_BIND' }
    $listener = @(Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue)
    if (-not $listener) { Save-Diag 'restart' 'RDP_LISTENER_ABSENT_AFTER_BIND' $null; throw 'RDP_LISTENER_ABSENT_AFTER_BIND' }
    $firewall = Get-NetFirewallRule -Name 'slab-rdp-3389' -ErrorAction Stop
    if ($firewall.Enabled -ne 'True') { Save-Diag 'restart' 'RDP_FIREWALL_RULE_DISABLED' $null; throw 'RDP_FIREWALL_RULE_DISABLED' }
    $credssp = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters' -Name 'AllowEncryptionOracle' -ErrorAction SilentlyContinue
    $credsspOk = ($null -eq $credssp -or $credssp.AllowEncryptionOracle -eq 0)
    if (-not $credsspOk) { Save-Diag 'restart' 'CREDSSP_ENCRYPTION_ORACLE_NOT_STRICT' $null; throw 'CREDSSP_ENCRYPTION_ORACLE_NOT_STRICT' }
    Save-Diag 'postflight' 'ALL_OK' $null

    $listenerState = [ordered]@{
        listening = $true; fwRule = ($firewall.Enabled -eq 'True'); nla = ([int]$listenerPolicy.UserAuthentication -eq 1)
        securityLayer = [int]$listenerPolicy.SecurityLayer; minEncryptionLevel = [int]$listenerPolicy.MinEncryptionLevel
        certOk = $true; certBound = $true; certThumb = $thumb; certChainOk = $chainOk
        certChainStatus = ($chainStatus -join ','); credsspStatus = 'ok'; ok = $true
    }
    $configPath = Join-Path $StageRoot 'config.json'
    $cfg = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $cfg | Add-Member -NotePropertyName rdpListener -NotePropertyValue $listenerState -Force
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json -Depth 12), $utf8)
    & icacls.exe $configPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Save-Diag 'config-stamp' 'CONFIG_ACL_FAILED_AFTER_CERT_STAMP' $null; throw 'CONFIG_ACL_FAILED_AFTER_CERT_STAMP' }

    $report = [ordered]@{
        schema = 'slab-capability-certificate/1'; generatedAt = [datetime]::UtcNow.ToString('o')
        dnsName = $fqdn; certificateDnsName = $certDns; thumbprint = $thumb; issuer = $cert.Issuer; subject = $cert.Subject
        notAfterUtc = $cert.NotAfter.ToUniversalTime().ToString('o'); chainOk = $chainOk
        chainStatus = $chainStatus; privateKeyAcl = [string]$keyFile; boundThumbprint = $boundHex
        nla = ([int]$listenerPolicy.UserAuthentication -eq 1); securityLayer = [int]$listenerPolicy.SecurityLayer
        minEncryptionLevel = [int]$listenerPolicy.MinEncryptionLevel; credsspStrict = $credsspOk; listener3389 = @($listener | ForEach-Object { [string]$_.LocalAddress })
        authenticationLevelBypass = $false
    }
    $json = $report | ConvertTo-Json -Depth 6
    if ($Out) { [System.IO.File]::WriteAllText($Out, $json, $utf8) }
    Write-Host $json
    Write-Host "::notice title=RDP certificate::Tailscale-issued certificate $thumb bound to $fqdn; NLA=1; no authentication-level bypass"
} catch {
    # The diagnostic was written at the failing stage by Save-Diag; if the
    # throw happened before any Save-Diag call, write it now so the workflow
    # publish step always has the cause.
    if ($diag.stage -eq 'start') { Save-Diag 'unexpected' 'UNEXPECTED_FAILURE' ($_.Exception.Message) }
    Write-Host ("::error title=RDP certificate bind FAILED::stage=" + $diag.stage + " code=" + $diag.code + " error=" + ([string]$_.Exception.Message).Replace("`r", ' ').Replace("`n", ' '))
    throw
}
