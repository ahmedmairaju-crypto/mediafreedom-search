@echo off
cd /d "%~dp0"
echo.
echo ===============================================
echo       MediaFreedom Search - Ultra V3
echo ===============================================
echo.
if not exist node_modules (
  echo First run: installing required packages...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Install failed. Check your internet connection and Node.js installation.
    pause
    exit /b 1
  )
)
echo.
echo Starting MediaFreedom Search...
start "MediaFreedom Search Server" cmd /c "npm.cmd start"
timeout /t 2 /nobreak >nul
start "MediaFreedom Search" http://mediafreedom.localhost:3000
pause
