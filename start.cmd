@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo RuShi Demo - starting local server...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (
  echo Startup failed. Please keep the message above.
  pause
  exit /b 1
)
echo Ready. You can close this window.
