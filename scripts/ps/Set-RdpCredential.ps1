<#
.SYNOPSIS
Adds or removes a TERMSRV/<host> generic credential for mstsc auto-login.

.DESCRIPTION
The password is read from the environment variable named by -PasswordEnv so
it never appears on a process command line (cmdkey /pass: would expose it to
every local process listing). Uses CredWriteW / CredDeleteW directly.
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
  public static void Write(string target, string user, string pass) {
    byte[] blob = System.Text.Encoding.Unicode.GetBytes(pass);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; // CRED_TYPE_GENERIC (what cmdkey /generic writes)
    c.TargetName = target; c.UserName = user; c.Persist = 2; // LOCAL_MACHINE persistence for this user
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target) {
    if (CredDeleteW(target, 1, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == 1168) return false; // ERROR_NOT_FOUND
    throw new System.ComponentModel.Win32Exception(e);
  }
}
'@
if (-not ('SlabCred' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
$target = "TERMSRV/$TargetHost"
if ($Action -eq 'set') {
    $pass = [Environment]::GetEnvironmentVariable($PasswordEnv)
    if (-not $pass) { Write-Output "MISSING_CONFIG: env $PasswordEnv is empty"; exit 3 }
    if (-not $User) { Write-Output 'MISSING_CONFIG: -User is required'; exit 3 }
    [SlabCred]::Write($target, $User, $pass)
    Write-Output "CREDENTIAL_SET $target user=$User"
} else {
    $deleted = [SlabCred]::Delete($target)
    Write-Output ("CREDENTIAL_REMOVED $target existed=" + $deleted)
}
exit 0
