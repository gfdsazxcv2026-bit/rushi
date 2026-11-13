$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$recordPath = Join-Path $PSScriptRoot 'data\desktop-launch.json'
try {
    # Reuse the existing readiness check, startup lock and detached server.
    $startupOutput = @(& (Join-Path $PSScriptRoot 'start.ps1'))
    $startupText = $startupOutput -join "`n"
    $address = [regex]::Match($startupText, 'http://[^\s]+').Value
    if (-not $address) { throw '启动器未返回网站地址。' }
    $page = Invoke-WebRequest -Uri $address -UseBasicParsing -TimeoutSec 8
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<title>入史') {
        throw '网站尚未就绪。'
    }
    Start-Process -FilePath $address
    @{ status='browser-open-requested'; url=$address; at=(Get-Date).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
} catch {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
    @{ status='failed'; at=(Get-Date).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    $popup = New-Object -ComObject WScript.Shell
    [void]$popup.Popup('入史未能启动。请双击项目目录里的 start.cmd 查看具体报错，再重试桌面图标。', 0, '入史启动提示', 16)
    exit 1
}
