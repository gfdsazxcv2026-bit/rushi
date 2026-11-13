$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $PSScriptRoot 'public\rushi-seal.ico'
function Draw-CenteredGlyph($graphics, $text, $familyName, $brush, $centerX, $centerY, $maxWidth, $maxHeight) {
    $family = New-Object System.Drawing.FontFamily $familyName
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $matrix = New-Object System.Drawing.Drawing2D.Matrix
    try {
        $path.AddString($text, $family, 0, 100, [System.Drawing.PointF]::Empty, [System.Drawing.StringFormat]::GenericTypographic)
        $bounds = $path.GetBounds()
        $scale = [Math]::Min($maxWidth/$bounds.Width, $maxHeight/$bounds.Height)
        $matrix.Translate([single]($centerX-($bounds.X+$bounds.Width/2)*$scale), [single]($centerY-($bounds.Y+$bounds.Height/2)*$scale))
        $matrix.Scale([single]$scale, [single]$scale)
        $path.Transform($matrix)
        $graphics.FillPath($brush, $path)
    } finally {
        $matrix.Dispose()
        $path.Dispose()
        $family.Dispose()
    }
}
$imageData = @()
foreach ($size in @(16, 32, 48, 256)) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = 'AntiAlias'
    $graphics.TextRenderingHint = 'AntiAliasGridFit'
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 242, 229))
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(50, 65, 47))
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(159, 59, 40))
    $graphics.FillEllipse($paper, 0, 0, ($size-1), ($size-1))
    Draw-CenteredGlyph $graphics '史' '华文行楷' $ink ($size*0.5) ($size*0.5) ($size*0.68) ($size*0.72)
    # White-script seal sits in the right-side whitespace, clear of the main strokes.
    $graphics.FillRectangle($red, [single]($size*0.83), [single]($size*0.39), [single]($size*0.10), [single]($size*0.22))
    $sealBorder = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(245, 242, 229)), ([single]($size*0.0035))
    $graphics.DrawRectangle($sealBorder, [single]($size*0.838), [single]($size*0.398), [single]($size*0.084), [single]($size*0.204))
    Draw-CenteredGlyph $graphics '入' '华文隶书' $paper ($size*0.88) ($size*0.452) ($size*0.066) ($size*0.074)
    Draw-CenteredGlyph $graphics '史' '华文隶书' $paper ($size*0.88) ($size*0.548) ($size*0.066) ($size*0.074)
    $sealBorder.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $imageData += ,@{ size=$size; bytes=$stream.ToArray() }
    if ($size -eq 256) { $bitmap.Save((Join-Path $PSScriptRoot 'public\desktop-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    $stream.Dispose()
    $paper.Dispose()
    $ink.Dispose()
    $red.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
$iconFile = [System.IO.File]::Create($iconPath)
$writer = New-Object System.IO.BinaryWriter $iconFile
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$imageData.Count)
    $offset = 6 + 16*$imageData.Count
    foreach ($item in $imageData) {
        $dimension = if ($item.size -eq 256) { 0 } else { $item.size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$item.bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $item.bytes.Length
    }
    foreach ($item in $imageData) { $writer.Write([byte[]]$item.bytes) }
} finally { $writer.Dispose() }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '入史.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
    $previous = $shell.CreateShortcut($shortcutPath)
    if ($previous.Description -ne '入史：自动启动本地服务并打开历史互动阅读网站') {
        throw '桌面已有其他同名快捷方式，请先重命名它，再安装入史图标。'
    }
}
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'open-rushi.vbs') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = $iconPath + ',0'
$shortcut.Description = '入史：自动启动本地服务并打开历史互动阅读网站'
$shortcut.WindowStyle = 7
$shortcut.Save()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RushiDesktopIconRefresh {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
[RushiDesktopIconRefresh]::SHChangeNotify(0x00002000, 0x00001005, $shortcutPath, [IntPtr]::Zero)
Write-Output ('桌面图标已创建：' + $shortcutPath)
