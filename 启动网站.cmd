@echo off
rem ============================================================
rem  PaperInsight launcher - starts the local server and opens
rem  the site in your default browser.  (ASCII only on purpose.)
rem ============================================================
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if not exist "%ProgramFiles%\nodejs\node.exe" if not "%NODE_EXE%"=="node" goto run
where node >nul 2>&1
if errorlevel 1 if "%NODE_EXE%"=="node" (
  echo.
  echo   Node.js was not found in PATH.
  echo   Please install Node.js 18+ from https://nodejs.org and retry.
  echo.
  pause
  exit /b 1
)

:run
"%NODE_EXE%" "scripts\launch.mjs"
if errorlevel 1 pause
exit /b 0
