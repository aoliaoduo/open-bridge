@echo off
setlocal
rem Thin Windows double-click bootstrap. This cmd file intentionally accepts no
rem workspace/flag arguments: cmd expands %NAME% before a batch file can preserve
rem a legal Windows path containing literal percent pairs. Use the Node CLI for
rem programmatic launch: open-bridge launch --root "C:\path" [flags].
title Open Bridge
where node >nul 2>nul
if errorlevel 1 goto :nonode
if not "%~1"=="" goto :unsupported_args
node "%~dp0windows\launcher-bootstrap.mjs" one-click
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  Open Bridge launcher exited with code %EXITCODE%.
  echo  This window stays open so the message above can be read.
  echo.
  pause
)
endlocal
exit /b %EXITCODE%

:unsupported_args
echo  [X] This double-click wrapper does not accept workspace paths or flags.
echo      cmd.exe cannot preserve every legal Windows path, including literal %%NAME%% text.
echo      Use: open-bridge launch --root "C:\path\to\workspace" [flags]
endlocal
exit /b 2

:nonode
echo  [X] Node.js was not found in PATH.
echo      Install Node 22 or newer from https://nodejs.org and try again.
echo.
pause
endlocal
exit /b 1
