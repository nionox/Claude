# Tareo digital

Los trabajadores registran su jornada desde el celular con una foto obligatoria como sustento.
El administrador recibe todo en un panel y descarga un Excel con las fotos incrustadas.

## Requisitos

- Node.js 22.13 o superior

## Puesta en marcha

```bash
npm install
ADMIN_PASSWORD=una-clave-segura npm start
```

- App de trabajadores: http://localhost:3000
- Panel del administrador: http://localhost:3000/admin.html

## Flujo

1. El administrador registra a cada trabajador (DNI de 8 dígitos y nombre) en el panel.
2. El trabajador ingresa con su DNI, elige el día trabajado, las horas, describe la actividad y adjunta una foto (obligatoria).
3. El servidor guarda el reporte con su hora de envío. Solo se acepta un reporte por día y trabajador, y solo fechas de hoy o de los últimos 7 días.
4. El administrador revisa las fotos en el panel y descarga el Excel con dos hojas:
   - **Reportes**: una fila por reporte, con la foto incrustada.
   - **Resumen**: días reportados y total de horas por trabajador (fórmulas).

## Estructura

```
server.js          API, base de datos (SQLite) y generación del Excel
public/index.html  App del trabajador
public/admin.html  Panel del administrador
data/              Base de datos y fotos (se crea al iniciar; no se sube a git)
```

## Limitaciones del prototipo

- **Identificación solo por DNI.** Quien conozca el DNI puede enviar reportes en nombre de otra persona. El siguiente paso recomendado es un PIN por trabajador.
- **La foto puede venir de la galería.** El atributo `capture` abre la cámara en muchos celulares, pero no lo garantiza. Para exigir una foto tomada en el momento haría falta una app nativa o un control adicional.
- **En producción se necesita HTTPS.** Los navegadores solo dan acceso a la cámara en `localhost` o con HTTPS. Pon la app detrás de un proxy con certificado y agrega `; Secure` a la cookie del administrador en `server.js`.
- **Cambia `ADMIN_PASSWORD`** antes de usarlo. Sin esa variable el servidor no arranca.
- Solo se aceptan fotos JPG o PNG de hasta 5 MB.
- Node 22 muestra un aviso de "ExperimentalWarning" por `node:sqlite`; es esperado y no afecta el funcionamiento.
