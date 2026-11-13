param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$candidates = @()
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $candidates += $found.Source }
if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
if ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
$nodeExe = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $major = [int](& $candidate -p "process.versions.node.split('.')[0]")
        if ($LASTEXITCODE -eq 0 -and $major -ge 24) { $nodeExe = $candidate; break }
    } catch { }
}
if (-not $nodeExe) { throw '未找到 Node.js 24 或更新版本。请安装后再启动，或在 Codex 中运行本脚本。' }
$envArgument = '--env-file-if-exists=' + (Join-Path $PSScriptRoot '.env')
if ($Foreground) {
    & $nodeExe $envArgument (Join-Path $PSScriptRoot 'server\index.mjs')
} else {
    & $nodeExe $envArgument (Join-Path $PSScriptRoot 'scripts\launch.mjs')
}
if ($LASTEXITCODE -ne 0) { throw '入史启动失败，请根据上面的提示检查配置或端口。' }
