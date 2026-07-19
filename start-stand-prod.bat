@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Production-style TEST STAND on :8788 — for phone / CloudPub.
rem Does not free or bind release :8787. Hot-reload stand: use start-stand.bat instead.

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
set "WEBCLI_STAND=1"
set "WEBCLI_DATA_DIR=%USERPROFILE%\.webcli-stand"

echo.
echo Building stand bundle...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo Freeing stand port 8788 if busy (not 8787)...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":8788 .*LISTENING"') do (
  taskkill /F /PID %%A >nul 2>&1
)

echo.
echo ========================================
echo   TEST STAND ^(prod-style^)
echo ========================================
echo   Local:  http://127.0.0.1:8788
echo   Data:   %%USERPROFILE%%\.webcli-stand\
echo.
echo   Phone / remote:
echo     1. In another window: publish-stand.bat
echo     2. Open the HTTPS URL CloudPub prints
echo     3. Same ACCESS_TOKEN as .env
echo.
echo   Release stays on :8787 — untouched.
echo.

call npm start
echo.
echo Stand stopped.
pause
