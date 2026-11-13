param([switch]$Live)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$candidates = @()
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$nodeExe = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $major = [int](& $candidate -p "process.versions.node.split('.')[0]")
        if ($LASTEXITCODE -eq 0 -and $major -ge 24) { $nodeExe = $candidate; break }
    } catch { }
}
if (-not $nodeExe) { throw 'Node.js 24 or newer was not found.' }
$envArgument = '--env-file-if-exists=' + (Join-Path $PSScriptRoot '.env')
$arguments = @($envArgument, (Join-Path $PSScriptRoot 'scripts\check-model.mjs'))
if ($Live) { $arguments += '--live' }
& $nodeExe @arguments
exit $LASTEXITCODE
