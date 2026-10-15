@echo off
setlocal
cd /d "%~dp0"
python "%~dp0iniciar.py"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo A aplicacao nao foi iniciada. Consulte portable-local\logs.
  pause
)
exit /b %EXIT_CODE%
