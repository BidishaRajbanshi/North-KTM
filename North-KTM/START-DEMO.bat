@echo off
REM Double-click to start SewerSafe (blockchain + backend + dashboard). Close this window to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install the LTS version from https://nodejs.org then double-click this again.
  echo.
  pause
  exit /b 1
)
node scripts\start.js
echo.
pause
