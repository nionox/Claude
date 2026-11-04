#!/bin/sh
cd "$(dirname "$0")" || exit 1
echo "Instalando lo necesario (solo la primera vez)..."
npm install --no-audit --no-fund
echo ""
echo "Abre en tu computadora:  http://localhost:3000"
echo "Abre en tu celular (misma Wi-Fi) con la IP de tu equipo, puerto 3000"
echo ""
PORT=3000 npm start
