@echo off
cd /d "%~dp0"
title MoYu Editor - port 3001

set RUNNING=0
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 set RUNNING=1

if "%RUNNING%"=="1" echo.
if "%RUNNING%"=="1" echo   [MoYu] Server is ALREADY running on port 3001.
if "%RUNNING%"=="1" echo   [MoYu] Opening browser: http://localhost:3001
if "%RUNNING%"=="1" echo.
if "%RUNNING%"=="1" start http://localhost:3001
if "%RUNNING%"=="1" timeout /t 4 /nobreak >nul
if "%RUNNING%"=="1" exit /b 0

echo.
echo   ==================================================
echo     MoYu Editor  --  http://localhost:3001
echo.
echo     Starting... the browser will open in ~6 seconds.
echo.
echo     KEEP THIS WINDOW OPEN while you are using it.
echo     Press Ctrl+C (or close this window) to stop.
echo   ==================================================
echo.

start "MoYu Browser" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3001"

call npm run serve

echo.
echo   [MoYu] Server stopped. Press any key to close.
pause >nul
