@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required and was not found.
  where winget >nul 2>&1 && (
    echo Installing Node.js with winget...
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  ) || (
    echo Install Node.js 18 or newer from https://nodejs.org and re-run this script.
    exit /b 1
  )
)
node "%~dp0scripts\setup.js" %*
