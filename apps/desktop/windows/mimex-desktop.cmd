@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..\..") do set "REPO_ROOT=%%~fI"

where node >nul 2>nul
if errorlevel 1 (
  echo [mimex-desktop] Node.js was not found on PATH.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [mimex-desktop] pnpm was not found on PATH.
  pause
  exit /b 1
)

pushd "%REPO_ROOT%" >nul
call pnpm desktop:dev
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

if not "%EXIT_CODE%"=="0" (
  echo [mimex-desktop] Launch failed.
  pause
)

exit /b %EXIT_CODE%
