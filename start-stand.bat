@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Test stand — parallel to release (start-prod.bat on :8787).
rem Does NOT free or bind release ports. Hot-reload for feature work.

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

set "PORT=8788"
set "API_PORT=8788"
set "VITE_PORT=5174"
set "WEBCLI_STAND=1"
set "WEBCLI_DATA_DIR=%USERPROFILE%\.webcli-stand"

echo.
echo ========================================
echo   TEST STAND  (release untouched)
echo ========================================
echo   UI:   http://127.0.0.1:5174
echo   API:  http://127.0.0.1:8788
echo   Data: %%USERPROFILE%%\.webcli-stand\
echo.
echo   Release stays on :8787 / ~/.webcli
echo   Same .env keys; separate sessions/push data.
echo.

echo Freeing stand ports 8788 / 5174 if busy (not 8787)...
for %%P in (8788 5174) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P .*LISTENING"') do (
    taskkill /F /PID %%A >nul 2>&1
  )
)

echo Starting stand API on :8788...
start "webcli-stand-server" /min cmd /c "set PORT=8788&& set API_PORT=8788&& set WEBCLI_STAND=1&& set WEBCLI_DATA_DIR=%USERPROFILE%\.webcli-stand&& cd /d \"%~dp0\" && npm run dev -w @webcli/server"

echo Waiting for stand API...
set /a tries=0
:wait_api
set /a tries+=1
powershell -NoProfile -Command "try { (Invoke-WebRequest http://127.0.0.1:8788/api/health -UseBasicParsing -TimeoutSec 1).StatusCode } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto api_ok
if !tries! GEQ 40 (
  echo.
  echo Stand API did not start on :8788. Check the "webcli-stand-server" window.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_api

:api_ok
echo Stand API is up.
echo Starting stand UI on :5174...
echo.
echo   Open http://127.0.0.1:5174
echo   Keep this window and webcli-stand-server open.
echo.
echo   Phone / CloudPub for this stand:
echo     use start-stand-prod.bat + publish-stand.bat  ^(stable HTTPS URL^)
echo     ^(Vite :5174 is for local hot reload, not for CloudPub^)
echo.
echo   When features look good: promote-to-release.bat
echo.
call npm run dev -w @webcli/web
echo.
echo Stand UI stopped. Closing stand API window...
taskkill /FI "WINDOWTITLE eq webcli-stand-server*" /F >nul 2>&1
pause
