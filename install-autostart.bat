@echo off
setlocal
cd /d "%~dp0"

rem Register WebCLI release + CloudPub to start at Windows logon.

set "TASK_NAME=WebCLI"
set "REPO=%~dp0"
set "REPO=%REPO:~0,-1%"
set "LAUNCHER=%REPO%\start-phone.bat"

if not exist "%LAUNCHER%" (
  echo Missing start-phone.bat next to this script.
  pause
  exit /b 1
)

echo.
echo Registering scheduled task "%TASK_NAME%"...
echo   Trigger:  at your logon ^(delay 45s for network/Node^)
echo   Action:   start-phone.bat  ^(release :8787 + CloudPub^)
echo   Path:     %LAUNCHER%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$launcher = '%LAUNCHER%'; $repo = '%REPO%'; $user = $env:USERNAME;" ^
  "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $launcher + '\"') -WorkingDirectory $repo;" ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user; $trigger.Delay = 'PT45S';" ^
  "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero);" ^
  "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;" ^
  "Register-ScheduledTask -TaskName '%TASK_NAME%' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null;" ^
  "Write-Host 'Registered.'; Get-ScheduledTask -TaskName '%TASK_NAME%' | Format-List TaskName, State"

if errorlevel 1 (
  echo.
  echo Failed to register the task.
  pause
  exit /b 1
)

echo.
echo OK — WebCLI will start after you sign in to Windows.
echo To remove: uninstall-autostart.bat
echo To test now: start-phone.bat
echo.
pause
exit /b 0
