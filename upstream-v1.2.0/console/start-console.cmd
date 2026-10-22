@echo off
chcp 65001 >nul
title 语忆AI
cd /d "%~dp0.."

rem Keep this file pure ASCII. cmd.exe parses it with the system codepage,
rem so Chinese text here turns into garbage commands.

rem Shared copy: use whatever "node" is on PATH.
set "NODE=node"

netstat -ano | findstr ":7788" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Console already running, opening the page...
  start "" http://127.0.0.1:7788
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo   语忆AI  -  http://127.0.0.1:7788
echo   Close this window to stop the console.
echo.
start "" http://127.0.0.1:7788
"%NODE%" console\server.mjs
echo.
echo Console stopped.
pause >nul
