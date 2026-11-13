@echo off
rem Double-click to install vrun. Runs install.ps1 next to this file without
rem changing the PowerShell execution policy of the machine.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "VRUN_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %VRUN_EXIT%
