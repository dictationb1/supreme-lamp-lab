<#
Read-only fail-closed posture for mstsc /v:<fqdn>. The production launcher does
not carry an .rdp authentication-level directive, so a pre-existing override
must be proved absent/strict before the lab can claim certificate validation.
No registry value is changed or removed.
#>
param()
$ErrorActionPreference = 'Stop'
$paths = @(
    'HKCU:\Software\Microsoft\Terminal Server Client',
    'HKLM:\Software\Microsoft\Terminal Server Client'
)
$observed = @()
$unsafe = @()
foreach ($p in $paths) {
    $property = Get-ItemProperty -LiteralPath $p -Name 'AuthenticationLevelOverride' -ErrorAction SilentlyContinue
    if ($null -eq $property) { continue }
    $value = $property.AuthenticationLevelOverride
    $row = [pscustomobject]@{ path = $p; value = [string]$value; strict = ($null -ne $value -and [int]$value -eq 2) }
    $observed += $row
    if (-not $row.strict) { $unsafe += $row }
}
$report = [ordered]@{
    schema = 'slab-rdp-client-trust/1'; checkedAt = [datetime]::UtcNow.ToString('o')
    ok = ($unsafe.Count -eq 0); defaultWhenAbsent = 2; overrides = $observed
    unsafe = $unsafe; mutationPerformed = $false
}
$json = $report | ConvertTo-Json -Depth 5
Write-Output $json
if ($unsafe.Count -gt 0) { exit 2 }
exit 0
