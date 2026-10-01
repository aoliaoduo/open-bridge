@echo off
setlocal
rem Thin project bootstrap. Dependency/build/start orchestration lives in Node/TS.
title Open Bridge - this project :8123
where node >nul 2>nul
if errorlevel 1 goto :nonode
node "%~dp0windows\launcher-bootstrap.mjs" project
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo  Open Bridge project launcher exited with code %EXITCODE%.
  echo  This window stays open so the message above can be read.
  echo.
  pause
)
endlocal
exit /b %EXITCODE%

:nonode
echo  [X] Node.js was not found in PATH.
echo      Install Node 22 or newer from https://nodejs.org and try again.
echo.
pause
endlocal
exit /b 1
