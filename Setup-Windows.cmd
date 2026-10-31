@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action setup
set "osmanthus_exit=%ERRORLEVEL%"
if not defined CI pause
exit /b %osmanthus_exit%
