@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/.
  echo  Then run Setup.bat once before launching TicketsManage.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo  Dependencies are not installed yet.
  echo  Run Setup.bat once, then double-click TicketsManage.bat again.
  echo.
  pause
  exit /b 1
)

node scripts/launch.cjs
pause
