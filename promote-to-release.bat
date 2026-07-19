@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Promote current git tree to RELEASE (:8787) without killing the live chat.
rem 1) Build while release keeps running
rem 2) Schedule restart as soon as no agent run is busy

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install Node 22+ and retry.
  exit /b 1
)

if not exist ".env" (
  echo Missing .env — need ACCESS_TOKEN to talk to the release API.
  exit /b 1
)

echo.
echo Building release bundle ^(server keeps running^)...
call npm run build
if errorlevel 1 (
  echo Build failed — release not scheduled.
  exit /b 1
)

echo.
echo Scheduling release restart ^(as soon as idle^)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\schedule-deploy.ps1" -Port 8787
if errorlevel 1 (
  echo Could not schedule deploy. Is release up on :8787?
  echo Start it with start-prod.bat ^(loop mode^), then retry.
  exit /b 1
)

echo.
echo Done. If a chat is running, restart waits until it finishes.
echo UI reloads automatically after the new process is up.
echo Cancel: use Cancel on the banner while waiting for idle.
echo.
exit /b 0
