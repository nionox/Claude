@echo off
title Enlace publico - Tareo digital
cd /d "%~dp0"
if not exist cloudflared.exe (
  echo No se encuentra cloudflared.exe en esta carpeta.
  echo Copialo aqui y vuelve a abrir este archivo.
  pause
  exit /b
)
echo ======================================================
echo  Espera unos 10 segundos.
echo  Busca el recuadro "Your quick Tunnel has been created"
echo  y debajo la direccion que termina en trycloudflare.com
echo  Esa es la direccion que compartes.
echo  NO cierres esta ventana mientras otros usan la app.
echo ======================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000
pause
