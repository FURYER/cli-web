@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Publish RELEASE via CloudPub (port 8787) and keep the tunnel alive.
rem The GUI app often quits when :8787 blips during promote — use this CLI loop instead.

where clo >nul 2>&1
if errorlevel 1 (
  echo CloudPub CLI ^(clo^) not found on PATH.
  echo Install from https://cloudpub.ru and reopen the terminal.
  pause
  exit /b 1
)

echo.
echo ========================================
echo   CloudPub RELEASE tunnel ^(auto-restart^)
echo ========================================
echo   Target: http://127.0.0.1:8787
echo   Name:   webcli
echo.
echo   Keep this window open. If clo exits ^(e.g. after promote^),
echo   it restarts automatically in a few seconds.
echo   Prefer this over the CloudPub desktop app.
echo.

:wait_backend
powershell -NoProfile -Command "try { (Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Waiting for release on :8787 ...
  timeout /t 2 /nobreak >nul
  goto wait_backend
)

:run_tunnel
echo.
echo [%TIME%] Starting clo publish...
clo publish -n "webcli" http 8787
set "EXITCODE=!ERRORLEVEL!"
echo.
echo [%TIME%] CloudPub exited ^(code !EXITCODE!^) — reconnecting in 3s...
timeout /t 3 /nobreak >nul

:wait_backend_again
powershell -NoProfile -Command "try { (Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Waiting for release on :8787 ...
  timeout /t 2 /nobreak >nul
  goto wait_backend_again
)
goto run_tunnel
