param(
    [Parameter(Mandatory)][int]$RootProcessId,
    [Parameter(Mandatory)][string]$RunMarker
)

$ErrorActionPreference = 'Stop'
if ($RunMarker -notmatch '^hussh-calling-rehearsal-[a-zA-Z0-9]+$') { throw 'Invalid run marker' }
$all = @(Get-CimInstance Win32_Process)
$root = $all | Where-Object ProcessId -eq $RootProcessId
# Unknown/exited roots are not ownership evidence. Never kill by a stale PID.
if (-not $root) { return }
if (-not $root.CommandLine.Contains($RunMarker)) { throw 'Rehearsal root identity changed' }
$earliest = $root.CreationDate.ToUniversalTime()
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootProcessId)
$owned = @()
do {
    $found = @($all | Where-Object {
        $ids.Contains([int]$_.ParentProcessId) -and
        -not $ids.Contains([int]$_.ProcessId) -and
        $_.CreationDate.ToUniversalTime() -ge $earliest
    })
    foreach ($item in $found) {
        [void]$ids.Add([int]$item.ProcessId)
        $owned += $item
    }
} while ($found.Count)
$owned += $root
[Array]::Reverse($owned)
foreach ($item in $owned) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId)
    if ($current -and $current.CreationDate -eq $item.CreationDate) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        if ($process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') -ne
            $item.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff')) { continue }
        # Kill and wait on the captured handle, never a subsequently reused PID.
        try { $process.Kill() } catch [System.InvalidOperationException] { continue }
        if (-not $process.WaitForExit(5000)) {
            throw 'Owned rehearsal process did not stop'
        }
    }
}
