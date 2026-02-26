@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..\..") do set "REPO_ROOT=%%~fI"
set "ENTRYPOINT=%REPO_ROOT%\apps\tui\dist\index.js"

where node >nul 2>nul
if errorlevel 1 (
  echo [mimex] Node.js was not found on PATH.
  echo [mimex] Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [mimex] pnpm was not found on PATH.
  echo [mimex] Install pnpm, then run this launcher again.
  pause
  exit /b 1
)

pushd "%REPO_ROOT%" >nul

if not defined MIMEX_WORKSPACE_PATH set "MIMEX_WORKSPACE_PATH=%REPO_ROOT%\data\workspaces\local"

if not exist "%ENTRYPOINT%" (
  echo [mimex] Building @mimex/tui...
  call pnpm --filter @mimex/tui build
  if errorlevel 1 (
    echo [mimex] Build failed. Fix errors and try again.
    popd >nul
    pause
    exit /b 1
  )
)

set "RUN_CMD=cd /d ""%REPO_ROOT%"" && node ""apps\tui\dist\index.js"""
start "Mimex TUI" cmd /k "%RUN_CMD%"

popd >nul
exit /b 0
