@echo off
rem =====================================================================
rem  Open Bridge - this-project launcher (double-click this file)
rem
rem  Starts this repository itself as the AI workspace on the fixed local
rem  port 8123. It never asks for a folder and it never accepts arguments:
rem  the root and port are intentionally stable for a desktop shortcut.
rem
rem  Closing this window stops the server. Ctrl+C is the clean stop.
rem  ASCII-only: cmd.exe reads batch files in the console codepage.
rem =====================================================================
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"
set "PORT=8123"
title Open Bridge - this project :%PORT%

echo.
echo  Open Bridge - this project
echo  ===========================
echo  workspace : %ROOT%
echo  port      : %PORT%
echo  console   : http://127.0.0.1:%PORT%/console/
echo  stop      : Ctrl+C or close this window
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "package.json" (
  echo  [X] package.json was not found in the repository root.
  goto failed
)

if not exist "node_modules" (
  echo  [1/3] installing dependencies - first run only, this takes a while ...
  call npm install
  if errorlevel 1 goto failed
)

rem Build every launch so a double-click always starts the current source.
echo  [2/3] building the CLI and console ...
call npm run build
if errorlevel 1 goto failed

echo  [3/3] starting the server ...
echo  Open the console yourself at http://127.0.0.1:%PORT%/console/
echo.
node bin\open-bridge.js serve --root "%ROOT%" --port %PORT%
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  open-bridge serve exited with code %EXITCODE% - the message above says why.
  echo  If port %PORT% is already in use, stop that process or choose a different launcher port.
  echo.
  pause
)
endlocal
exit /b %EXITCODE%

:nonode
echo  [X] Node.js was not found in PATH.
echo      Install Node 22 or newer from https://nodejs.org and double-click again.
goto failed

:failed
echo.
echo  This window stays open so the message can be read.
echo.
pause
endlocal
exit /b 1
