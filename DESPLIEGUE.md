# Despliegue y modelo de negocio (Perú)

Esta guía cubre: cómo publicar la app con HTTPS y cómo convertirla en un producto de pago con 15 días de prueba. El cobro todavía no está implementado.

## 1. Qué le falta al prototipo para ser un producto de pago

Hoy hay un solo administrador y una sola empresa. Para cobrar a varias empresas hace falta:

1. **Multiempresa:** tabla `empresas` (nombre, RUC, `trial_hasta`, `estado`) y que cada trabajador y reporte pertenezca a una empresa.
2. **Cuentas por empresa:** registro con correo y contraseña (hash con bcrypt o argon2), no una clave compartida en variable de entorno.
3. **Control de acceso por suscripción:** un middleware que bloquee la escritura cuando `trial_hasta` venció y la empresa no tiene suscripción activa. Recomiendo permitir seguir viendo y descargando el Excel, para que el cliente no pierda sus datos.
4. **Cobro recurrente:** webhook de la pasarela que actualice el estado de la empresa cuando un pago se aprueba o falla.
5. **Facturación electrónica:** en Perú, cobrar a una empresa exige emitir comprobante electrónico a SUNAT (factura o boleta). Se hace con un proveedor de facturación (por ejemplo Nubefact u otro homologado por SUNAT) conectado a tu sistema.

## 2. Trial de 15 días: cómo funciona

- Al registrarse, la empresa recibe `trial_hasta = hoy + 15 días`.
- Durante el trial tiene todas las funciones.
- Avisos: correo o banner a partir del día 12 y el día 15.
- Al vencer, sin pago: se bloquean los reportes nuevos. Los datos y el Excel siguen disponibles.
- Sin tarjeta al inicio: más fricción en el registro, pero menos abandono de quienes solo van a mirar. Decide según el público.

## 3. Pasarelas de pago en Perú

Compara antes de elegir; las condiciones y comisiones cambian con frecuencia y conviene confirmarlas en cada sitio:

| Opción | Para qué sirve bien | Notas |
|---|---|---|
| **Culqi** | Tarjetas en línea, pensado para negocios digitales | Tiene cobros recurrentes/suscripciones y API sencilla |
| **Mercado Pago** | Tarjetas, Yape y otros medios | Tiene suscripciones; buena cobertura de medios locales |
| **Niubiz** | Empresas más grandes con procesador de tarjetas propio | Proceso de afiliación más largo |

Para empezar, **Culqi o Mercado Pago** son lo más simple de integrar. Ambas exigen registrar tu negocio y, normalmente, RUC.

## 4. Despliegue con HTTPS

### Opción C: Docker en cualquier VPS (recomendada)

En el servidor, con Docker y Docker Compose instalados:

1. Apunta el DNS de tu dominio (registro `A`) a la IP del servidor.
2. Edita `Caddyfile` y pon tu dominio.
3. Arranca:

```bash
SUPERADMIN_PASSWORD='clave-larga-del-dueno' docker compose up -d --build
```

Caddy obtiene el certificado HTTPS automáticamente. Los datos quedan en el volumen `tareo-data`; para respaldarlos: `docker run --rm -v tareo-data:/data -v $(pwd):/backup alpine tar czf /backup/respaldo.tgz /data`.


El celular necesita HTTPS para instalar la PWA y usar la cámara.

### Opción A: VPS con dominio (más control, más barata)

Requisitos: un VPS de Linux (por ejemplo Hetzner, DigitalOcean o similar), un dominio y Caddy como servidor web, que obtiene el certificado HTTPS automáticamente.

Pasos resumidos:

```bash
# En el servidor (Ubuntu 24.04)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs caddy git

git clone <tu-repositorio> /opt/tareo
cd /opt/tareo
npm install --omit=dev
```

Variables de entorno (archivo `/opt/tareo/.env`, con permisos restringidos):

```
ADMIN_PASSWORD=una-clave-larga-y-unica
PORT=3000
TZ_NEGOCIO=America/Lima
```

Proceso permanente con systemd (`/etc/systemd/system/tareo.service`):

```ini
[Unit]
Description=Tareo digital
After=network.target

[Service]
WorkingDirectory=/opt/tareo
EnvironmentFile=/opt/tareo/.env
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tareo
```

Caddy como proxy con HTTPS (`/etc/caddy/Caddyfile`), reemplazando el dominio:

```
tudominio.pe {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

Después apunta el registro DNS `A` de tu dominio a la IP del servidor. Caddy obtiene el certificado solo.

**Copias de seguridad:** todo el estado está en `data/` (base de datos y fotos). Programa una copia diaria de esa carpeta a otro lugar.

### Opción B: plataforma administrada (Render o Railway)

Es más rápido de configurar, pero necesitas un **disco persistente** (volumen) montado en `data/`. Sin disco persistente, la base de datos y las fotos se borran en cada reinicio. Verifica en la plataforma si el volumen está incluido en tu plan y cuánto cuesta.

## 5. Antes de cobrar a clientes reales

- **Protección de datos (Ley 29733):** tienes datos personales y fotos de trabajadores. Necesitas un aviso de privacidad y la base de datos registrada ante la Autoridad Nacional de Protección de Datos Personales, según tu caso. Consulta con un abogado antes de vender.
- **PIN por trabajador:** hoy se identifica solo con DNI.
- **HTTPS y cookie segura:** agrega `; Secure` a la cookie del administrador cuando la app esté en HTTPS.
- **Respaldos probados:** restaura una copia en un servidor de prueba antes de depender de ella.

## 6. Orden sugerido

1. Desplegar en un dominio con HTTPS (esta guía, sección 4).
2. Usar la app con 2 o 3 empresas piloto, sin cobro.
3. Implementar multiempresa y trial (sección 1 y 2).
4. Elegir pasarela e integrar la suscripción (sección 3).
5. Facturación electrónica y aviso de privacidad (sección 5).
