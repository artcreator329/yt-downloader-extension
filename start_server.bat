@echo off
title YouTube Downloader Engine (Windows)
cd /d "%~dp0"

echo ======================================================
echo    YouTube Downloader - Native Companion Engine (Windows)
echo ======================================================

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Python is not installed. Please install Python 3 from python.org or the Microsoft Store.
    pause
    exit /b
)

if not exist "server\venv" (
    echo Setting up isolated Python environment...
    python -m venv server\venv
    server\venv\Scripts\pip.exe install -r server\requirements.txt
)

echo Starting engine on http://localhost:8989...
echo Downloads will be saved to your Downloads folder.
server\venv\Scripts\python.exe server\server.py
pause
