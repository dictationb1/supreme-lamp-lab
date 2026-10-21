<#
.SYNOPSIS
Adds or removes TERMSRV/<host> credentials for mstsc auto-login.

.DESCRIPTION
The password is read from the environment variable named by -PasswordEnv so
it never appears on a process command line (cmdkey /pass: would expose it to
every local process listing). Uses CredWriteW / CredDeleteW directly.

Both credential kinds are written for the same target, from the same fresh
blob, and both are removed at cleanup: CRED_TYPE_DOMAIN_PASSWORD (2) - what
mstsc itself stores and what the app's production launcher writes as its
primary entry (ghrdp-rdp-launcher.cs, hardened in its F30 round after mixed
stale Domain/Generic entries broke auto-login) - plus CRED_TYPE_GENERIC (1),
the legacy cmdkey /generic kind. CredWrite keys by (target, type), so one
kind can never overwrite a stale value of the other.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('set', 'remove')][string]$Action,
    [Parameter(Mandatory = $true)][string]$TargetHost,
    [string]$User = '',
    [string]$PasswordEnv = 'RDP_LAB_PASSWORD'
)
$ErrorActionPreference = 'Stop'

# Surface the failing statement as an annotation: job logs live on a blob host
# that some tooling cannot read, annotations are readable via api.github.com.
trap {
    $m = ($_.Exception.Message -replace '[\r\n]+', ' ')
    $pos = ''
    if ($_.InvocationInfo) { $pos = ('{0}:{1} {2}' -f $_.InvocationInfo.ScriptName, $_.InvocationInfo.ScriptLineNumber, ($_.InvocationInfo.Line -replace '[\r\n]+', ' ').Trim()) }
    Write-Host ('::error title=Set-RdpCredential failed::' + $m + ' @ ' + $pos)
    exit 1
}
$src = @'
using System;
using System.Runtime.InteropServices;
public static class SlabCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);
  public static void Write(string target, string user, string pass, int type) {
    byte[] blob = System.Text.Encoding.Unicode.GetBytes(pass);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = type; // 2 = CRED_TYPE_DOMAIN_PASSWORD, 1 = CRED_TYPE_GENERIC
    c.TargetName = target; c.UserName = user; c.Persist = 2; // LOCAL_MACHINE persistence for this user
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target, int type) {
    if (CredDeleteW(target, type, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == 1168) return false; // ERROR_NOT_FOUND
    throw new System.ComponentModel.Win32Exception(e);
  }
}
'@
if (-not ('SlabCred' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
$target = "TERMSRV/$TargetHost"
# 2 = CRED_TYPE_DOMAIN_PASSWORD (mstsc's own kind; launcher primary),
# 1 = CRED_TYPE_GENERIC (legacy cmdkey /generic kind)
$credTypes = @(2, 1)
if ($Action -eq 'set') {
    $pass = [Environment]::GetEnvironmentVariable($PasswordEnv)
    if (-not $pass) { Write-Output "MISSING_CONFIG: env $PasswordEnv is empty"; exit 3 }
    if (-not $User) { Write-Output 'MISSING_CONFIG: -User is required'; exit 3 }
    foreach ($t in $credTypes) { [SlabCred]::Write($target, $User, $pass, $t) }
    $ident = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $sid = (Get-Process -Id $PID).SessionId
    Write-Output "CREDENTIAL_SET $target user=$User types=DomainPassword,Generic identity=$ident session=$sid"
} else {
    $parts = @()
    foreach ($t in $credTypes) { $parts += ("type$t=" + [SlabCred]::Delete($target, $t)) }
    Write-Output ("CREDENTIAL_REMOVED $target " + ($parts -join ' '))
}
exit 0
