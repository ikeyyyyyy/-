@echo off
rem ===========================================================================
rem  English Essay Grader - one-click launcher (Windows)
rem  Double-click this file: it starts the local server and opens the browser.
rem  Keep this window open while using the pages; close it to stop the server.
rem  (Messages are ASCII-only on purpose: non-ASCII text in .cmd files can be
rem   garbled by the console code page.)
rem ===========================================================================
chcp 65001 >nul
title English Essay Grader
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] Node.js not found.
  echo       Install Node.js 18 or newer first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting English Essay Grader ...
echo   The browser will open automatically when the server is ready.
echo   Keep this window open. Close it (or press Ctrl+C) to stop the server.
echo.

set EG_OPEN=1
node backend/server.js

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
