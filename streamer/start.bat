@echo off
setlocal

:: Kill any existing process holding port 6987 (zombie from previous run)
echo [Streamer] Releasing port 6987...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6987 " 2^>nul') do (
    echo [Streamer] Killing PID %%a on port 6987
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:loop
echo [Streamer] Starting server.js ...
node server.js
set EXIT_CODE=%ERRORLEVEL%
echo [Streamer] Process exited with code %EXIT_CODE%. Restarting in 3 seconds...
:: Release port again before restarting
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":6987 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 3 /nobreak >nul
goto loop