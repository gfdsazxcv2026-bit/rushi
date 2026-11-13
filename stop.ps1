$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dataDirectory = Join-Path $PSScriptRoot 'data'
$recordPath = Join-Path $dataDirectory 'server-process.json'
if (-not (Test-Path -LiteralPath $recordPath)) { Write-Host '没有发现由一键启动器管理的入史进程。'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
$processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.pid)
if (-not $processInfo) { Write-Host '入史进程已经停止。'; exit 0 }
$serverFile = Join-Path $PSScriptRoot 'server\index.mjs'
$envArgument = '--env-file-if-exists=' + (Join-Path $PSScriptRoot '.env')
$expectedArguments = @([string]$record.node, $envArgument, $serverFile)
$parts = foreach ($argument in $expectedArguments) {
    $escaped = [regex]::Escape($argument)
    '(?:"' + $escaped + '"|' + $escaped + ')'
}
$expectedCommand = '^\s*' + ($parts -join '\s+') + '\s*$'
$executableMatches = [string]::Equals([string]$processInfo.ExecutablePath, [string]$record.node, [System.StringComparison]::OrdinalIgnoreCase)
if (-not $executableMatches -or -not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch $expectedCommand) {
    throw '进程标识已经变化，为避免停止其他程序，本脚本未执行停止。'
}
Stop-Process -Id ([int]$record.pid)
Write-Host '入史本地服务已停止。数据和阅读记录保留。'
