@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-model.ps1" %*
set "RUSHI_CHECK_EXIT=%ERRORLEVEL%"
pause
exit /b %RUSHI_CHECK_EXIT%
