@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_ar.ps1" %*
pause
