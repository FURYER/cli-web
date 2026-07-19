@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

rem =============================================================================
rem  WebCLI — one-shot setup for a friend's Windows PC
rem
rem  Installs: Git, Node.js 22, Python, ffmpeg, CloudPub CLI (clo),
rem            npm deps, Whisper (faster-whisper), creates .env
rem
rem  Friend still needs to:
rem    1) clo login   (or clo set token <token from cloudpub.ru)
rem    2) Fill AGENT_API_KEY + ACCESS_TOKEN when prompted (or edit .env)
rem       — Cursor IDE/SDK separately NOT needed; @cursor/sdk comes via npm
rem    3) start-prod.bat   +   publish-release.bat
rem       (or start-phone.bat)
rem =============================================================================

set "REPO_URL=https://github.com/FURYER/cli-web.git"
set "REPO_DIR=%USERPROFILE%\Documents\GitHub\cli-web"
set "CLO_VERSION=3.2.2"
set "CLO_ZIP=clo-%CLO_VERSION%-stable-windows-x86_64.zip"
set "CLO_URL=https://cloudpub.ru/download/stable/%CLO_ZIP%"
set "CLO_DIR=%LOCALAPPDATA%\Programs\cloudpub-cli"
set "NEED_PATH_REFRESH=0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

echo.
echo ========================================
echo   WebCLI setup
echo ========================================
echo.

rem --- If this bat already lives inside a cloned repo, use that folder -------
if exist "%~dp0package.json" (
  set "REPO_DIR=%~dp0"
  rem strip trailing backslash for nicer echoes
  if "!REPO_DIR:~-1!"=="\" set "REPO_DIR=!REPO_DIR:~0,-1!"
  echo Using existing repo: !REPO_DIR!
) else (
  echo Target folder: %REPO_DIR%
)

rem --- winget -----------------------------------------------------------------
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] winget not found.
  echo Install "App Installer" from Microsoft Store, then re-run this script.
  pause
  exit /b 1
)

call :ensure_winget Git.Git "Git" git
call :ensure_winget OpenJS.NodeJS.22 "Node.js 22" node
call :ensure_winget Python.Python.3.12 "Python 3.12" py
call :ensure_winget Gyan.FFmpeg.Essentials "ffmpeg" ffmpeg

if "!NEED_PATH_REFRESH!"=="1" call :refresh_path
call :ensure_tool_paths

rem --- verify core tools ------------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git still not on PATH. Close this window, open a new cmd, re-run setup.bat
  pause
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node still not on PATH. Close this window, open a new cmd, re-run setup.bat
  pause
  exit /b 1
)

for /f "tokens=1 delims=v" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo Node: !NODE_VER!
echo Git: 
git --version

rem --- CloudPub CLI -----------------------------------------------------------
call :ensure_cloudpub
call :refresh_path
call :ensure_tool_paths

where clo >nul 2>&1
if errorlevel 1 (
  if exist "%CLO_DIR%\clo.exe" set "PATH=%PATH%;%CLO_DIR%"
)
where clo >nul 2>&1
if errorlevel 1 (
  echo [WARN] clo not on PATH yet. It is installed at:
  echo   %CLO_DIR%
  echo Open a NEW terminal after setup, or use: "%CLO_DIR%\clo.exe"
) else (
  echo CloudPub CLI found.
)

rem --- clone ------------------------------------------------------------------
if not exist "%REPO_DIR%\package.json" (
  echo.
  echo Cloning %REPO_URL% ...
  if not exist "%USERPROFILE%\Documents\GitHub" mkdir "%USERPROFILE%\Documents\GitHub"
  if exist "%REPO_DIR%\.git" (
    pushd "%REPO_DIR%"
    git pull --ff-only
    popd
  ) else (
    if exist "%REPO_DIR%" (
      echo [ERROR] Folder exists but is not a git repo: %REPO_DIR%
      pause
      exit /b 1
    )
    git clone "%REPO_URL%" "%REPO_DIR%"
    if errorlevel 1 (
      echo [ERROR] git clone failed. Is the repo public?
      pause
      exit /b 1
    )
  )
) else (
  echo Repo already present — skipping clone.
)

cd /d "%REPO_DIR%"

rem --- .env -------------------------------------------------------------------
echo.
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
  ) else (
    (
      echo AGENT_API_KEY=
      echo ACCESS_TOKEN=
    ) > ".env"
  )
  echo Created .env — enter keys ^(leave blank to edit later / auto-generate ACCESS_TOKEN^):
  if exist "%REPO_DIR%\scripts\write-env-keys.ps1" (
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%REPO_DIR%\scripts\write-env-keys.ps1" -EnvPath "%REPO_DIR%\.env"
  ) else (
    echo   Helper script missing — opening notepad. Fill AGENT_API_KEY and ACCESS_TOKEN, save, close.
    notepad "%REPO_DIR%\.env"
  )
) else (
  echo .env already exists — not overwriting.
)

rem --- npm --------------------------------------------------------------------
echo.
echo npm install ...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo npm run build ...
call npm run build
if errorlevel 1 (
  echo [ERROR] build failed.
  pause
  exit /b 1
)

rem --- Python / Whisper -------------------------------------------------------
echo.
echo Installing Whisper ^(faster-whisper^) ...
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo [WARN] Python not found on PATH — skip Whisper. Re-open terminal and run:
  echo   pip install -r packages\server\scripts\requirements-whisper.txt
) else (
  %PY% -m pip install --upgrade pip
  %PY% -m pip install -r "packages\server\scripts\requirements-whisper.txt"
  if errorlevel 1 (
    echo [WARN] Whisper pip install failed. Voice STT may be unavailable until fixed.
  ) else (
    echo Whisper Python packages OK.
    echo First voice use downloads the model ^(large-v3, several GB^).
  )
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [WARN] ffmpeg not on PATH yet — reopen terminal if voice from phone fails.
) else (
  echo ffmpeg OK.
)

rem --- instruction file for the friend ---------------------------------------
set "HELP_FILE=%REPO_DIR%\ЧТО-ДЕЛАТЬ-ДАЛЬШЕ.txt"
if exist "%REPO_DIR%\scripts\write-next-steps.ps1" (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%REPO_DIR%\scripts\write-next-steps.ps1" -RepoDir "%REPO_DIR%" -OutPath "%HELP_FILE%"
) else (
  echo See setup finished messages below. > "%REPO_DIR%\NEXT-STEPS.txt"
  set "HELP_FILE=%REPO_DIR%\NEXT-STEPS.txt"
)

echo.
echo ========================================
echo   Setup finished
echo ========================================
echo   Folder: %REPO_DIR%
echo.
echo   Instruction file:
echo     %HELP_FILE%
echo.
echo   Opening it now...
echo ========================================
echo.
start "" notepad "%HELP_FILE%"
pause
exit /b 0

rem =============================================================================
:ensure_winget
set "PKG_ID=%~1"
set "PKG_NAME=%~2"
set "CHECK_CMD=%~3"
if defined CHECK_CMD (
  where %CHECK_CMD% >nul 2>&1
  if not errorlevel 1 (
    echo   already installed: %PKG_NAME%
    goto :eof
  )
)
echo   installing %PKG_NAME% via winget ^(%PKG_ID%^) ...
winget install --id "%PKG_ID%" -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 (
  echo [WARN] winget ^(source winget^) failed for %PKG_NAME% — retrying default source...
  winget install --id "%PKG_ID%" -e --accept-package-agreements --accept-source-agreements --disable-interactivity
)
if errorlevel 1 (
  echo [WARN] winget install reported an error for %PKG_NAME% — continuing; may already be present.
) else (
  set "NEED_PATH_REFRESH=1"
)
goto :eof

:ensure_cloudpub
where clo >nul 2>&1
if not errorlevel 1 (
  echo CloudPub CLI already on PATH.
  goto :eof
)
if exist "%CLO_DIR%\clo.exe" (
  echo CloudPub CLI already in %CLO_DIR%
  call :add_user_path "%CLO_DIR%"
  goto :eof
)
echo Downloading CloudPub CLI ...
set "TMP_ZIP=%TEMP%\%CLO_ZIP%"
set "TMP_EXTRACT=%TEMP%\cloudpub-cli-extract"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri '%CLO_URL%' -OutFile '%TMP_ZIP%' -UseBasicParsing"
if errorlevel 1 (
  echo [ERROR] Failed to download CloudPub from %CLO_URL%
  echo Install manually: https://cloudpub.ru/docs/
  goto :eof
)
if exist "%TMP_EXTRACT%" rmdir /s /q "%TMP_EXTRACT%"
mkdir "%TMP_EXTRACT%"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Path '%TMP_ZIP%' -DestinationPath '%TMP_EXTRACT%' -Force"
if not exist "%CLO_DIR%" mkdir "%CLO_DIR%"
rem zip may contain clo.exe at root or in a subfolder
for /r "%TMP_EXTRACT%" %%f in (clo.exe) do (
  copy /y "%%f" "%CLO_DIR%\clo.exe" >nul
  goto :clo_copied
)
echo [ERROR] clo.exe not found inside zip.
goto :eof
:clo_copied
call :add_user_path "%CLO_DIR%"
set "PATH=%PATH%;%CLO_DIR%"
echo CloudPub CLI installed to %CLO_DIR%
goto :eof

:add_user_path
set "ADD=%~1"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command ^
  "$add='%ADD%'; $cur=[Environment]::GetEnvironmentVariable('Path','User'); if (-not $cur) { $cur='' }; $parts=$cur -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }; if ($parts -notcontains $add) { [Environment]::SetEnvironmentVariable('Path', (($parts + $add) -join ';'), 'User'); Write-Host '  PATH +=' $add } else { Write-Host '  PATH already has' $add }"
set "NEED_PATH_REFRESH=1"
goto :eof

:refresh_path
echo Refreshing PATH in this window ...
rem Rebuild from Machine+User without dropping System32. Always use full powershell path.
for /f "usebackq delims=" %%p in (`"%PS%" -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
rem Keep Windows basics even if registry Path is weird
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
goto :eof

:ensure_tool_paths
rem Append common install locations if tools are not yet visible in this shell
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
if exist "%LocalAppData%\Programs\Python\Python312\python.exe" set "PATH=%PATH%;%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts"
if exist "%LocalAppData%\Microsoft\WinGet\Links\ffmpeg.exe" set "PATH=%PATH%;%LocalAppData%\Microsoft\WinGet\Links"
if exist "%CLO_DIR%\clo.exe" set "PATH=%PATH%;%CLO_DIR%"
goto :eof
