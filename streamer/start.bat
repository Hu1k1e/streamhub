@echo off
setlocal

:: Kill any existing processes holding streamer ports (6987=HTTP, 6988=DHT, 6989=BT TCP)
echo [Streamer] Releasing ports...
for %%P in (6987 6988 6989) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%P " 2^>nul') do (
        echo [Streamer] Killing PID %%a on port %%P
        taskkill /PID %%a /F >nul 2>&1
    )
)
timeout /t 3 /nobreak >nul

:loop
echo [Streamer] Starting server.js ...
node server.js
echo [Streamer] Process exited with code %ERRORLEVEL%. Restarting in 3 seconds...
:: Release ports again before restarting
for %%P in (6987 6988 6989) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%P " 2^>nul') do (
        taskkill /PID %%a /F >nul 2>&1
    )
)
timeout /t 3 /nobreak >nul
goto loop