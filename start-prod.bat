@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install Node 22+ and retry.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    echo Creating .env from .env.example — fill in AGENT_API_KEY and ACCESS_TOKEN.
    copy /y ".env.example" ".env" >nul
  ) else (
    echo Missing .env — create one with AGENT_API_KEY and ACCESS_TOKEN.
    pause
    exit /b 1
  )
)

echo.
echo Building production bundle...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo ========================================
echo   RELEASE  ^(auto-restart on promote^)
echo ========================================
echo   Local:  http://127.0.0.1:8787
echo.
echo   Phone / CloudPub:
echo     publish-release.bat   ^(CLI loop — survives promote^)
echo     Prefer this over the CloudPub desktop app.
echo.
echo   Promote from stand without killing chat:
echo     promote-to-release.bat
echo     ^(builds, then restarts as soon as idle^)
echo.
echo   Keep this window open. PC must stay awake.
echo   Sessions: %%USERPROFILE%%\.webcli\
echo.

:run_loop
echo Freeing port 8787 if busy ^(node only^)...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":8787 .*LISTENING"') do (
  for /f "tokens=1 delims=," %%B in ('tasklist /FI "PID eq %%A" /FO CSV /NH 2^>nul') do (
    if /I "%%~B"=="node.exe" (
      echo Killing node PID %%A on :8787
      taskkill /F /PID %%A >nul 2>&1
    )
  )
)

echo Starting WebCLI ^(production^) on http://127.0.0.1:8787
call npm start
set "EXITCODE=!ERRORLEVEL!"

if "!EXITCODE!"=="75" (
  echo.
  echo Deploy restart requested — starting new build already on disk...
  echo.
  goto run_loop
)

echo.
echo WebCLI stopped ^(exit !EXITCODE!^).
pause
