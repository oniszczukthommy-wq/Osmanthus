@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-audio.ps1"
set "osmanthus_exit=%ERRORLEVEL%"
if not defined CI pause
exit /b %osmanthus_exit%
