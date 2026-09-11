@echo off
rem =====================================================================
rem  Open Bridge - one-click launcher (double-click this file)
rem
rem  * keeps a visible console: the server's own log and its three URLs
rem  * CLOSING THIS WINDOW STOPS THE SERVER AND WHAT IT STARTED. The ngrok
rem    tunnel, the background services and the persistent shells all share
rem    this console, and Windows terminates the processes attached to a
rem    console when its window closes.
rem  * Ctrl+C is the clean stop: it removes the serve lock and runtime file.
rem
rem  ASCII-only on purpose: cmd.exe reads a batch file in the console's
rem  current codepage, so anything else here would come out as mojibake.
rem =====================================================================
setlocal
cd /d "%~dp0"
title Open Bridge

echo.
echo  Open Bridge - one-click launcher
echo  ================================
echo  workspace : %CD%
echo  stop      : Ctrl+C (clean) or close this window
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules" (
  echo  [1/3] installing dependencies - first run only, this takes a while ...
  call npm install
  if errorlevel 1 goto failed
)

set NEED_BUILD=0
if not exist "dist\cli.js" set NEED_BUILD=1
if not exist "dist\ui\console.html" set NEED_BUILD=1
if "%NEED_BUILD%"=="1" (
  echo  [2/3] building the CLI and the console ...
  call npm run build
  if errorlevel 1 goto failed
)

echo  [3/3] starting the server - the browser opens the console ...
echo.
node bin\open-bridge.js serve --open %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo  open-bridge serve exited with code %EXITCODE% - the log above says why.
  echo  This window stays open so the message can be read.
  echo.
  pause
)
endlocal
exit /b %EXITCODE%

:nonode
echo  [X] Node.js was not found in PATH.
echo      Install Node 22 or newer from https://nodejs.org and double-click again.
echo.
pause
exit /b 1

:failed
echo.
echo  [X] The step above failed; the window stays open so it can be read.
echo.
pause
endlocal
exit /b 1
