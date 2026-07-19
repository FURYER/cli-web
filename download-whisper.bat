@echo off
setlocal
cd /d "%~dp0"

rem Pre-download Whisper weights via Hugging Face mirror (hf-mirror.com).
rem Override: set HF_ENDPOINT=https://huggingface.co
rem           set WHISPER_MODEL=medium

if not defined HF_ENDPOINT set "HF_ENDPOINT=https://hf-mirror.com"
if not defined WHISPER_MODEL set "WHISPER_MODEL=large-v3"

echo.
echo Whisper model download
echo   HF_ENDPOINT=%HF_ENDPOINT%
echo   WHISPER_MODEL=%WHISPER_MODEL%
echo.

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found on PATH.
  pause
  exit /b 1
)

%PY% -X utf8 "packages\server\scripts\download_whisper_model.py"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Download failed. Try a VPN/proxy, or set HTTP_PROXY / HTTPS_PROXY, then re-run.
  pause
  exit /b %ERR%
)
echo OK. You can close this window and use voice in WebCLI.
pause
exit /b 0
