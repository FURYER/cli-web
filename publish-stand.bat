@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Publish TEST STAND via CloudPub (port 8788) with auto-restart.

where clo >nul 2>&1
if errorlevel 1 (
  echo CloudPub CLI ^(clo^) not found on PATH.
  echo Install from https://cloudpub.ru and reopen the terminal.
  pause
  exit /b 1
)

echo.
echo ========================================
echo   CloudPub STAND tunnel ^(auto-restart^)
echo ========================================
echo   Target: http://127.0.0.1:8788
echo   Name:   webcli-stand
echo   Keep this window open.
echo.

:wait_backend
powershell -NoProfile -Command "try { (Invoke-WebRequest http://127.0.0.1:8788/api/health -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Waiting for stand on :8788 ...
  timeout /t 2 /nobreak >nul
  goto wait_backend
)

:run_tunnel
echo.
echo [%TIME%] Starting clo publish...
clo publish -n "webcli-stand" http 8788
set "EXITCODE=!ERRORLEVEL!"
echo.
echo [%TIME%] CloudPub exited ^(code !EXITCODE!^) — reconnecting in 3s...
timeout /t 3 /nobreak >nul

:wait_backend_again
powershell -NoProfile -Command "try { (Invoke-WebRequest http://127.0.0.1:8788/api/health -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Waiting for stand on :8788 ...
  timeout /t 2 /nobreak >nul
  goto wait_backend_again
)
goto run_tunnel
