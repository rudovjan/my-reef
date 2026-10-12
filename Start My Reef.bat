@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/en/download, then open this file again.
  pause
  exit /b 1
)
node start.mjs
set "reef_exit=%errorlevel%"
pause
exit /b %reef_exit%
