<# Narrow, bounded mstsc process discovery; no full-machine CommandLine walk. #>
param([datetime]$NotBeforeUtc = [datetime]::MinValue)
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -Filter "Name='mstsc.exe'" -ErrorAction Stop | ForEach-Object {
    $created = $null
    try { $created = $_.CreationDate.ToUniversalTime() } catch {}
    [ordered]@{
        pid = [int]$_.ProcessId
        ppid = [int]$_.ParentProcessId
        name = [string]$_.Name
        createTime = $(if ($created) { $created.ToString('o') } else { $null })
        sessionId = [int]$_.SessionId
        commandLine = [string]$_.CommandLine
        newerThanBaseline = ($null -ne $created -and $created -ge $NotBeforeUtc)
    }
})
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[ordered]@{
    currentSessionId = [int](Get-Process -Id $PID).SessionId
    processes = $rows
} | ConvertTo-Json -Depth 5 -Compress
