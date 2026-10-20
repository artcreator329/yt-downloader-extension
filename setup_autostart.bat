@echo off
title Setup Auto-Start for Windows
cd /d "%~dp0"

echo ======================================================
echo    YouTube Downloader - Windows Auto-Start Setup
echo ======================================================

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_SCRIPT=%STARTUP_FOLDER%\YouTubeDownloaderEngine.vbs"

echo Creating silent background startup launcher in Windows Startup...
(
    echo Set WshShell = CreateObject^("WScript.Shell"^)
    echo WshShell.Run chr^(34^) ^& "%~dp0start_server.bat" ^& chr^(34^), 0
    echo Set WshShell = Nothing
) > "%VBS_SCRIPT%"

echo.
echo SUCCESS! The engine will now run silently in the background on Windows startup.
echo No terminal window will appear.
echo.
pause
