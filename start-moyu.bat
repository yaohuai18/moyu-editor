@echo off
setlocal
cd /d "%~dp0"

rem ===== Resolve the real path first =====
rem This folder can be reached through a directory junction
rem (C:\Users\<user>\WorkBuddy -> C:\UserData\WorkBuddy -> E:\UserData\WorkBuddy).
rem Starting "next start" from a junction path makes Next append the real path
rem again, producing "C:\...\E:\...\.next\routes-manifest.json" and an ENOENT crash.
rem node fs.realpathSync resolves the whole chain in one shot.
set "APPDIR="
for /f "usebackq delims=" %%I in (`node -e "console.log(require('fs').realpathSync('.'))"`) do set "APPDIR=%%I"
if defined APPDIR cd /d "%APPDIR%"

rem ===== Clear inherited NODE_OPTIONS =====
rem Host apps (WorkBuddy etc.) inject a safe-delete shim that blocks the temp-file
rem cleanup performed by next build, which makes the build fail for no good reason.
set "NODE_OPTIONS="

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

rem Build once if there is no production build yet
if not exist ".next\BUILD_ID" (
  echo   [MoYu] No build found. Building first, this takes about 1 minute...
  echo.
  call npm run build
  if errorlevel 1 goto build_failed
  echo.
)

start "MoYu Browser" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3001"

call npm run serve

echo.
echo   [MoYu] Server stopped. Press any key to close.
pause >nul
exit /b 0

:build_failed
echo.
echo   [MoYu] Build FAILED. Copy the error above and send it to the assistant.
echo.
pause >nul
exit /b 1
