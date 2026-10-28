@echo off
rem ============================================================
rem  Local preview for the birthday site.
rem  Just double-click this file. Keep the window open.
rem
rem  NOTE: port 8000 does NOT work on this PC -- Windows reserves
rem  the range 7903-8002, so any program gets WinError 10013.
rem  If 8080 is ever taken by something else, change the number
rem  below to 3000 / 5500 / 8081.
rem ============================================================

cd /d "%~dp0code"

echo.
echo    Site preview ................... http://localhost:8080/
echo    Full birthday story ............ http://localhost:8080/?bday=1
echo.
echo    Keep this window open. Close it to stop the server.
echo.

python -m http.server 8080
