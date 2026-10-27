@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required to run CustomerVision.
  echo Install the current LTS version from https://nodejs.org and launch this file again.
  echo.
  pause
  exit /b 1
)
title BriteBin CustomerVision
node setup-email.mjs --if-needed
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
