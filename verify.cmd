@echo off
rem moyu-editor one-click verify (see verify.ps1 for details)
rem   verify.cmd          static: typecheck + unit tests
rem   verify.cmd -Full    full:    + next build + api tests
setlocal
set "PS1=%~dp0verify.ps1"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)
set "RC=%errorlevel%"
if not defined VERIFY_NO_PAUSE pause
exit /b %RC%
