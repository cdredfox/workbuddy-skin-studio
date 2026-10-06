@echo off
REM WorkBuddy Skin Studio - Windows double-click entry (recommended)
REM Thin wrapper around scripts\apply.ps1 so behavior stays identical:
REM restart WorkBuddy with CDP port 9223 (skip if already debuggable),
REM then inject the skin. PowerShell is invoked with -ExecutionPolicy Bypass,
REM so no Set-ExecutionPolicy setup is needed for double-click use.
REM
REM Usage:
REM   Start.bat                restore last-used skin (default theme: miku-light)
REM   Start.bat mice-cat    apply a specific theme id
setlocal
set "ROOT=%~dp0"
set "THEME=%~1"

if defined THEME (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1" -Theme "%THEME%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1"
)

if errorlevel 1 (
  echo.
  echo [skin-studio] apply failed. See messages above.
  pause
)
endlocal
