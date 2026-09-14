@echo off
rem =====================================================================
rem  Open Bridge - one-click launcher (double-click this file)
rem
rem  1) it ASKS WHICH WORKSPACE DIRECTORY to serve. That directory is the
rem     boundary the AI sees - not the folder this launcher sits in.
rem     Quotes are harmless, Enter reuses the last directory, and a
rem     directory can also be passed as the first argument (handy in a
rem     desktop shortcut or a scheduled task):
rem         start-open-bridge.cmd "D:\work\my-project"
rem  2) it keeps a visible console: the server's own log and its three URLs.
rem
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
set "LAUNCHER_DIR=%~dp0"
if "%LAUNCHER_DIR:~-1%"=="\" set "LAUNCHER_DIR=%LAUNCHER_DIR:~0,-1%"
set "LAST_DIR_FILE=%~dp0start-open-bridge.last-dir"

echo.
echo  Open Bridge - one-click launcher
echo  ================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

rem ---- which directory? ------------------------------------------------------
set "PREVIOUS="
if exist "%LAST_DIR_FILE%" for /f "usebackq delims=" %%P in ("%LAST_DIR_FILE%") do set "PREVIOUS=%%P"
if defined PREVIOUS if not exist "%PREVIOUS%\" set "PREVIOUS="

set "WORKSPACE=%~1"
if defined WORKSPACE goto :have_dir

echo  Workspace directory the AI may work in - for example:
echo    "D:\work\my-project"     (quotes only needed for paths with spaces)
if defined PREVIOUS (echo  Press Enter to reuse: %PREVIOUS%) else (echo  Press Enter to use this launcher's own folder.)
echo.
set /p "WORKSPACE= > "

:have_dir
rem Order matters here. `set "X=%X:"=%"` cannot run on an EMPTY value: cmd
rem rewrites that line with unbalanced quotes and the rest of the file dies on
rem the parse error, which is exactly what a bare Enter used to do. So the
rem fallbacks run first and the quote strip always sees something defined.
if not defined WORKSPACE set "WORKSPACE=%PREVIOUS%"
if not defined WORKSPACE set "WORKSPACE=%LAUNCHER_DIR%"
if not defined WORKSPACE goto :quit
set "WORKSPACE=%WORKSPACE:"=%"
if "%WORKSPACE:~-1%"=="\" set "WORKSPACE=%WORKSPACE:~0,-1%"
for %%I in ("%WORKSPACE%") do set "WORKSPACE=%%~fI"

if not exist "%WORKSPACE%\" (
  echo.
  echo  [!] Not a directory: "%WORKSPACE%"
  set /p "CREATE=      create it now? [Y/n] "
  if /i "%CREATE%"=="n" goto :quit
  mkdir "%WORKSPACE%" 2>nul
  if not exist "%WORKSPACE%\" (
    echo.
    echo  [X] Could not create "%WORKSPACE%" - check the path and the permissions.
    echo.
    pause
    exit /b 1
  )
)
echo %WORKSPACE%>"%LAST_DIR_FILE%" 2>nul

echo.
echo  workspace : %WORKSPACE%
echo  stop      : Ctrl+C ^(clean^) or close this window
echo.

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

echo  [3/3] starting the server - the console URL is printed below.
echo        Nothing opens by itself; add --open if you want the browser to.
echo.
node bin\open-bridge.js serve --root "%WORKSPACE%" %*
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

:quit
endlocal
exit /b 0

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
