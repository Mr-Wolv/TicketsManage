@echo off
setlocal
cd /d "%~dp0"
title TicketsManage Setup

echo.
echo  TicketsManage - one-time setup
echo  ==============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found.
  echo  Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo  Node.js 22.13 or newer is required. Installed version:
  node --version
  echo  Download the current LTS from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo  This Node.js build does not provide node:sqlite.
  echo  Install Node.js 24 LTS (or 22.13+) from https://nodejs.org/ and run Setup again.
  node --version
  echo.
  pause
  exit /b 1
)

echo  Installing application dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo.
echo  Installing the dedicated Chromium browser for dashboard sign-in...
call npx playwright install chromium
if errorlevel 1 goto failed

echo.
echo  Building the local interface...
call npm run build:web
if errorlevel 1 goto failed

echo.
echo  Setup complete. Start the application with TicketsManage.bat
echo.
pause
exit /b 0

:failed
echo.
echo  Setup did not finish. Review the error above, then run Setup.bat again.
echo.
pause
exit /b 1
