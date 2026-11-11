@echo off
rem Double-clickable wrapper for scripts\launch.ps1.
rem Arguments are forwarded, so `Claude-3P.cmd -Profile work` works too.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
