@echo off
setlocal
cd /d "%~dp0"

if not exist logs mkdir logs

echo ============================================================
echo   BLACK MEET - starting server, TURN relay and tunnel
echo ============================================================
echo.

rem --- Node web app (pages + API + socket.io + SQLite) ---
start "BM app" /min cmd /c "node server\index.js >> logs\node.log 2>&1"

rem --- TURN relay: UDP 3478 + TCP framing ---
start "BM turn" /min cmd /c "node turn.js >> logs\turn.log 2>&1"
start "BM turn-tcp" /min cmd /c "node turn-proxy.js >> logs\turn-proxy.log 2>&1"

rem --- Public tunnel: cloudflare -> ssh localhost.run -> ssh serveo ---
del /q tunnel_url.txt >nul 2>&1
start "BM tunnel" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\tunnel.ps1"

echo Waiting for the server and the public tunnel (up to 90 seconds)...

set "URL="
for /l %%i in (1,1,45) do (
    if exist tunnel_url.txt for /f "usebackq delims=" %%u in ("tunnel_url.txt") do set "URL=%%u"
    if defined URL goto ready
    timeout /t 2 /nobreak >nul
)

:ready
if defined URL (
    echo.
    echo Public URL : %URL%
    echo Already copied to the clipboard.
    timeout /t 2 /nobreak >nul
    start "" "%URL%"
) else (
    echo.
    echo No public tunnel yet - opening the local address instead.
    start "" "http://localhost:3000/black-meet/"
)

echo.
echo Local  : http://localhost:3000/black-meet/
if defined URL echo Public : %URL%
echo.
echo Logs   : logs\node.log, logs\turn.log, logs\turn-proxy.log, and  %%TEMP%%\bm-tunnel\bmt-chain.log
echo.
echo Press any key to STOP all services...
pause >nul

taskkill /FI "WINDOWTITLE eq BM app*"    /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq BM turn*"   /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq BM tunnel*" /T /F >nul 2>&1
echo Stopped. Bye.
