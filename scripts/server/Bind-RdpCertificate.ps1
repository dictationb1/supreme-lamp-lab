<#
Bind a Tailscale-issued certificate to the disposable server's RDP-Tcp listener.
The private key stays in the ephemeral VM. No authentication-level bypass or
self-signed certificate substitution is permitted.
#>
param(
    [string]$StageRoot = 'C:\ghrdp',
    [string]$AppDir = 'app',
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'REFUSED: Bind-RdpCertificate only runs on an ephemeral GitHub-hosted Windows server'
}
$ts = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $ts)) { $ts = 'tailscale.exe' }
$status = (& $ts status --json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'TAILSCALE_STATUS_FAILED' }
$fqdn = ([string]$status.Self.DNSName).TrimEnd('.')
if ($fqdn -notmatch '^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$') { throw 'MAGIC_DNS_UNAVAILABLE' }

$tlsDir = Join-Path $StageRoot 'tls'
New-Item -ItemType Directory -Path $tlsDir -Force | Out-Null
& icacls.exe $tlsDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)R' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'TLS_DIRECTORY_ACL_FAILED' }
$crt = Join-Path $tlsDir ($fqdn + '.crt')
$key = Join-Path $tlsDir ($fqdn + '.key')
$certOk = $false
$lastCode = 'CERT_NOT_FETCHED'
for ($attempt = 1; $attempt -le 2; $attempt++) {
    Remove-Item -LiteralPath $crt, $key -Force -ErrorAction SilentlyContinue
    $stdout = Join-Path $env:RUNNER_TEMP "capability-cert-$attempt.out"
    $stderr = Join-Path $env:RUNNER_TEMP "capability-cert-$attempt.err"
    $p = Start-Process -FilePath $ts -ArgumentList @('cert', '--cert-file', $crt, '--key-file', $key, $fqdn) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {}; throw 'CERT_FETCH_TIMEOUT' }
    $certOk = ($p.ExitCode -eq 0 -and (Test-Path -LiteralPath $crt) -and (Test-Path -LiteralPath $key))
    if ($certOk) { break }
    $err = if (Test-Path -LiteralPath $stderr) { [System.IO.File]::ReadAllText($stderr) } else { '' }
    $lastCode = if ($err -match 'HTTPS certificates disabled|does not support getting TLS certs') { 'CERT_CAPABILITY_UNAVAILABLE' }
        elseif ($err -match 'invalid hostname|not a valid domain') { 'CERT_INVALID_HOSTNAME' }
        elseif ($err -match 'access denied|unauthorized|forbidden') { 'CERT_AUTH_FAILED' }
        elseif ($err -match 'rate limit|too many requests') { 'CERT_RATE_LIMITED' }
        else { 'CERT_TRANSIENT_FETCH_FAILED' }
    if ($lastCode -ne 'CERT_TRANSIENT_FETCH_FAILED') { break }
    if ($attempt -lt 2) { Start-Sleep -Seconds 5 }
}
if (-not $certOk) { throw "$lastCode`: Tailscale certificate was not issued; refusing a self-signed fallback" }

$loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($crt, $key)
if (-not $loaded.HasPrivateKey) { throw 'CERT_PRIVATE_KEY_MISSING' }
$pfxBytes = $loaded.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, [string]::Empty)
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::MachineKeySet -bor
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, [string]::Empty, $flags)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'LocalMachine')
try { $store.Open('ReadWrite'); $store.Add($cert) } finally { $store.Close() }
$thumb = [string]$cert.Thumbprint
$grant = Join-Path $AppDir 'payloads\Grant-RdpKeyAccess.ps1'
if (-not (Test-Path -LiteralPath $grant)) { throw "APP_KEY_ACCESS_HELPER_MISSING: $grant" }
$keyFile = & $grant -Certificate $cert
if ($LASTEXITCODE -ne 0 -or -not $keyFile) { throw 'CERT_PRIVATE_KEY_ACL_FAILED' }

$rdpKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
Set-ItemProperty -Path $rdpKey -Name 'UserAuthentication' -Value 1 -Type DWord
Set-ItemProperty -Path $rdpKey -Name 'SecurityLayer' -Value 2 -Type DWord
Set-ItemProperty -Path $rdpKey -Name 'MinEncryptionLevel' -Value 3 -Type DWord
$listenerPolicy = Get-ItemProperty -Path $rdpKey -Name 'UserAuthentication','SecurityLayer','MinEncryptionLevel'
if ([int]$listenerPolicy.UserAuthentication -ne 1 -or [int]$listenerPolicy.SecurityLayer -ne 2 -or [int]$listenerPolicy.MinEncryptionLevel -lt 3) { throw 'RDP_SECURITY_POLICY_READBACK_FAILED' }
$setting = Get-CimInstance -Namespace 'root/cimv2/TerminalServices' -ClassName 'Win32_TSGeneralSetting' -Filter "TerminalName='RDP-Tcp'"
$bind = Invoke-CimMethod -InputObject $setting -MethodName 'SetSSLCertificateSHA1Hash' -Arguments @{ SSLCertificateSHA1Hash = $thumb }
if ($bind.ReturnValue -ne 0) {
    $bytes = for ($i = 0; $i -lt $thumb.Length; $i += 2) { [Convert]::ToByte($thumb.Substring($i, 2), 16) }
    New-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash' -PropertyType Binary -Value $bytes -Force | Out-Null
}
$bound = (Get-ItemProperty -Path $rdpKey -Name 'SSLCertificateSHA1Hash').SSLCertificateSHA1Hash
$boundHex = ($bound | ForEach-Object { $_.ToString('X2') }) -join ''
if ($boundHex -ine $thumb) { throw "CERT_BIND_MISMATCH: bound=$boundHex expected=$thumb" }

$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $chainOk = [bool]$chain.Build($cert)
    $chainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
} finally { $chain.Dispose() }
if (-not $chainOk) { throw "CERT_CHAIN_UNTRUSTED: $($chainStatus -join ',')" }
if ($cert.NotAfter.ToUniversalTime() -le [datetime]::UtcNow) { throw 'CERT_EXPIRED' }
$certDns = [string]$cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
if ($certDns -ine $fqdn) { throw "CERT_HOSTNAME_MISMATCH: certificate=$certDns expected=$fqdn" }
Restart-Service -Name TermService -Force
if ((Get-Service -Name TermService).Status -ne 'Running') { throw 'TERMSERVICE_NOT_RUNNING_AFTER_BIND' }
$listener = @(Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue)
if (-not $listener) { throw 'RDP_LISTENER_ABSENT_AFTER_BIND' }
$firewall = Get-NetFirewallRule -Name 'slab-rdp-3389' -ErrorAction Stop
if ($firewall.Enabled -ne 'True') { throw 'RDP_FIREWALL_RULE_DISABLED' }
$credssp = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\CredSSP\Parameters' -Name 'AllowEncryptionOracle' -ErrorAction SilentlyContinue
$credsspOk = ($null -eq $credssp -or $credssp.AllowEncryptionOracle -eq 0)
if (-not $credsspOk) { throw 'CREDSSP_ENCRYPTION_ORACLE_NOT_STRICT' }

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
if ($LASTEXITCODE -ne 0) { throw 'CONFIG_ACL_FAILED_AFTER_CERT_STAMP' }

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
