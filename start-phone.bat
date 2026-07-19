@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem One-click phone mode: release server + CloudPub tunnel (two windows).

if not exist ".env" (
  echo Missing .env — run setup.bat first, or copy .env.example and fill keys.
  pause
  exit /b 1
)

echo Starting WebCLI release + CloudPub...
echo   Window 1: start-prod.bat   ^(http://127.0.0.1:8787^)
echo   Window 2: publish-release.bat  ^(HTTPS URL for phone^)
echo.
echo Keep both windows open. PC must stay awake.
echo.

start "WebCLI release" cmd /k "%~dp0start-prod.bat"
timeout /t 3 /nobreak >nul
start "WebCLI CloudPub" cmd /k "%~dp0publish-release.bat"

echo Launched. You can close this window.
timeout /t 5 >nul
exit /b 0
