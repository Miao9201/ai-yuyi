@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0AI语忆.exe" (
    start "" "%~dp0AI语忆.exe"
    exit /b
)
if exist "%~dp0runtime\python\pythonw.exe" (
    start "" "%~dp0runtime\python\pythonw.exe" -X utf8 "%~dp0launcher.py"
    exit /b
)
start "" pythonw.exe -X utf8 launcher.py
