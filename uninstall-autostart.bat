@echo off
setlocal
cd /d "%~dp0"

set "TASK_NAME=WebCLI"

echo Removing scheduled task "%TASK_NAME%"...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Unregister-ScheduledTask -TaskName '%TASK_NAME%' -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "if (Get-ScheduledTask -TaskName '%TASK_NAME%' -ErrorAction SilentlyContinue) { Write-Host 'Still present — try Task Scheduler UI.'; exit 1 } else { Write-Host 'OK — autostart disabled.' }"

echo.
pause
exit /b 0
