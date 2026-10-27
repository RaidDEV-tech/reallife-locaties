@echo off
echo [FutureRP Fisher] Dependencies installeren...
call npm install
if errorlevel 1 ( echo [FOUT] npm install mislukt & pause & exit /b 1 )
echo [FutureRP Fisher] Portable .exe bouwen...
call npx electron-builder --win --x64
if errorlevel 1 ( echo [FOUT] electron-builder mislukt & pause & exit /b 1 )
echo.
echo [FutureRP Fisher] Klaar! Je exe staat in dist\FutureRP-Fisher.exe
echo Kopieer hem naar ..\website\downloads\ voor de website.
pause
