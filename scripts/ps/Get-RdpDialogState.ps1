<#
.SYNOPSIS
Enumerate the relevant top-level and owned/modal windows of a lab-launched
process tree in the correct Windows session (read-only lab diagnostics).

.DESCRIPTION
Why this exists (run 39575343527 attempt 2): the one-time RDP-file consent
dialog ("Opening Remote Desktop Connection" / "I understand and allow RDP
files to open on this device for my account") sat in front of mstsc for the
whole attempt while Get-Process's MainWindowHandle heuristic reported
hasWindow=false - that heuristic only tracks the process's unowned top-level
"main window", so an owned/modal dialog is invisible to it. This enumerator
does not use MainWindowHandle at all.

For the launched root process (and its descendants, plus the system dialog
hosts LogonUI / CredentialUIBroker / consent - all restricted to the root's
Windows session) it records, per window:
  * hwnd, owning pid + process name, session id, visibility;
  * owner window (hwnd + owner's pid) - modal/owned dialogs have one;
  * window class name (#32770 is the dialog class);
  * title (capped);
  * identifiable child controls: class + text for Button/Static/CheckBox
    (capped), plus checked state for check boxes. Edit controls report only
    whether they hold text - never the text itself (it could be typed).

Filtering: every window owned by a tree/dialog-host process is included
regardless of title; windows of other processes are included only when the
title looks RDP/security related. Unrelated windows (browser tabs etc.) are
never read out. Read-only; never interacts with, moves or closes a window.
Emits one JSON line.
#>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$SessionId = -1,
    [int]$MaxControlsPerWindow = 14
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$doc = [ordered]@{ rootPid = $ProcessId; capturedAtUtc = [DateTime]::UtcNow.ToString('o'); windows = @() }

# ---- root process + session -------------------------------------------------
$rootSession = $SessionId
$rootName = ''
try {
    $root = Get-Process -Id $ProcessId -ErrorAction Stop
    $rootName = [string]$root.ProcessName
    if ($rootSession -lt 0) { $rootSession = [int]$root.SessionId }
} catch {
    $doc.rootError = $_.Exception.Message
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $doc | ConvertTo-Json -Depth 6 -Compress
    exit 0
}
$doc.rootName = $rootName
$doc.sessionId = $rootSession

# ---- process tree (root descendants) + dialog hosts in the same session ------
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$pids.Add($ProcessId)
$hostNames = @('LogonUI', 'CredentialUIBroker', 'consent')
try {
    $procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
        Select-Object ProcessId, ParentProcessId, SessionId, Name)
    $byParent = @{}
    foreach ($p in $procs) {
        $pp = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = @() }
        $byParent[$pp] += $p
    }
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    $queue.Enqueue($ProcessId)
    $guard = 0
    while ($queue.Count -gt 0 -and $guard -lt 500) {
        $guard++
        $cur = $queue.Dequeue()
        foreach ($c in @($byParent[$cur])) {
            if ($null -eq $c) { continue }
            if (-not $pids.Contains([int]$c.ProcessId)) { [void]$pids.Add([int]$c.ProcessId); $queue.Enqueue([int]$c.ProcessId) }
        }
    }
    foreach ($p in $procs) {
        if ([int]$p.SessionId -eq $rootSession -and $hostNames -contains [string]$p.Name -and -not $pids.Contains([int]$p.ProcessId)) {
            [void]$pids.Add([int]$p.ProcessId)
        }
    }
} catch {
    $doc.treeError = $_.Exception.Message
}
$doc.treePids = @($pids)

# ---- window enumeration (top-level + owned/modal + child controls) -----------
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class SlabDialogEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  const uint GW_OWNER = 4;
  const uint BM_GETCHECK = 0x00F0;

  static string Cap(string s, int n) {
    if (s == null) return "";
    var sb = new StringBuilder(s.Length);
    foreach (char c in s) {
      if (c == '\t' || c == '\r' || c == '\n' || c == '\u0001' || c == '\u0002') { sb.Append(' '); continue; }
      sb.Append(c);
      if (sb.Length >= n) break;
    }
    return sb.ToString();
  }
  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  static string Class(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }

  public static string[] List(int rootPid, int maxControls) {
    var acc = new List<string>();
    var tops = new List<IntPtr>();
    EnumWindows((h, l) => { if (acc.Count < 400) tops.Add(h); return true; }, IntPtr.Zero);
    foreach (var h in tops) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      IntPtr owner = GetWindow(h, GW_OWNER);
      uint ownerPid = 0;
      if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out ownerPid);
      string title = Title(h);
      string cls = Class(h);
      bool visible = IsWindowVisible(h);
      // window row:  hwnd \t pid \t ownerPid \t ownerHwnd \t visible \t class \t title
      var ctrlRows = new List<string>();
      EnumChildWindows(h, (c, l2) => {
        if (ctrlRows.Count >= maxControls) return false;
        string ccls = Class(c);
        string ctext = "";
        string checkedState = "";
        if (ccls == "Edit" || ccls == "RichEdit20W" || ccls == "RichEdit50W") {
          // never read edit CONTENT (it could be typed); only whether it has text
          string probe = Title(c);
          ctext = probe.Length > 0 ? "[has-text]" : "[empty]";
        } else {
          ctext = Cap(Title(c), 160);
          if (ccls == "Button") {
            IntPtr st = SendMessage(c, BM_GETCHECK, IntPtr.Zero, IntPtr.Zero);
            checkedState = st.ToInt32() == 1 ? "checked" : (st.ToInt32() == 2 ? "indeterminate" : "unchecked");
          }
        }
        if (ctext.Length > 0 || checkedState.Length > 0) {
          ctrlRows.Add(ccls + "\u0001" + ctext + "\u0001" + checkedState);
        }
        return true;
      }, IntPtr.Zero);
      // record: hwnd|pid|ownerPid|ownerHwnd|visible|class|title|controls(joined by \u0002, fields \u0001)
      string rec = string.Join("\t", new string[] {
        "0x" + h.ToInt64().ToString("X"), pid.ToString(), ownerPid.ToString(),
        "0x" + owner.ToInt64().ToString("X"), visible ? "1" : "0", cls, Cap(title, 240),
        string.Join("\u0002", ctrlRows.ToArray())
      });
      acc.Add(rec);
    }
    return acc.ToArray();
  }
}
'@
try {
    if (-not ('SlabDialogEnum' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
    $rows = [SlabDialogEnum]::List($ProcessId, [Math]::Max(1, $MaxControlsPerWindow))
    $procCache = @{}
    $hostNamesLc = @($hostNames | ForEach-Object { $_.ToLowerInvariant() })
    foreach ($line in $rows) {
        $parts = $line -split "`t", 8
        if ($parts.Count -lt 8) { continue }
        $wpid = 0; [void][int]::TryParse($parts[1], [ref]$wpid)
        $opid = 0; [void][int]::TryParse($parts[2], [ref]$opid)
        $visible = $parts[4] -eq '1'
        $title = [string]$parts[6]
        $inTree = $pids.Contains($wpid)
        if (-not $procCache.ContainsKey($wpid)) {
            try {
                $p = Get-Process -Id $wpid -ErrorAction Stop
                $procCache[$wpid] = @{ name = [string]$p.ProcessName; session = [int]$p.SessionId }
            } catch { $procCache[$wpid] = @{ name = '?'; session = -1 } }
        }
        $pname = $procCache[$wpid].name
        $psess = $procCache[$wpid].session
        $relevantTitle = $title -match 'Remote Desktop|Windows Security|Certificate|credential|Smart Card|RDP file|Opening'
        $relevantProc = $hostNamesLc -contains $pname.ToLowerInvariant()
        if (-not ($inTree -or $relevantProc -or $relevantTitle)) { continue }
        if ($psess -ge 0 -and $psess -ne $rootSession -and -not $inTree) { continue }
        $controls = @()
        foreach ($crow in @($parts[7] -split [char]2)) {
            if (-not $crow) { continue }
            $cf = $crow -split [char]1, 3
            if ($cf.Count -lt 2) { continue }
            $cstate = ''
            if ($cf.Count -ge 3) { $cstate = [string]$cf[2] }
            $controls += [ordered]@{
                class = [string]$cf[0]
                text  = [string]$cf[1]
                state = $cstate
            }
        }
        $winRow = [ordered]@{
            hwnd      = [string]$parts[0]
            pid       = $wpid
            process   = $pname
            sessionId = $psess
            ownerPid  = $opid
            ownerHwnd = [string]$parts[3]
            visible   = $visible
            className = [string]$parts[5]
            title     = $title
            controls  = $controls
        }
        $doc.windows += $winRow
        if ($doc.windows.Count -ge 30) { break }
    }
} catch {
    $doc.enumError = $_.Exception.Message
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$doc | ConvertTo-Json -Depth 6 -Compress
exit 0
