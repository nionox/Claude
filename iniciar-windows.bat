@echo off
title Tareo digital
cd /d "%~dp0"
echo Instalando lo necesario (solo la primera vez)...
call npm.cmd install --no-audit --no-fund
echo.
echo ==============================================
echo  Abre en tu computadora:  http://localhost:3000
echo  Abre en tu celular (misma Wi-Fi):
ipconfig | findstr /R /C:"IPv4"
echo ==============================================
echo.
set PORT=3000
call npm.cmd start
pause
