const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
const TZ = process.env.TZ_NEGOCIO || 'America/Lima';

const DIAS_PRUEBA = 15;
const DIAS_ATRAS = 7;
const DIA_MS = 24 * 60 * 60 * 1000;
const LIMITE_PRUEBA = 25;
const MSG_VENCIDA = 'La prueba o la suscripción de esta empresa venció. Renueva el plan para seguir registrando. Tus datos siguen guardados.';

// Planes mensuales en soles. Cambia aquí los precios y límites.
const PLANES = {
  basico: { nombre: 'Básico', precio: 49, limite: 25 },
  pro: { nombre: 'Pro', precio: 99, limite: 100 },
  ilimitado: { nombre: 'Ilimitado', precio: 179, limite: Infinity },
};

if (!SUPERADMIN_PASSWORD) {
  console.warn('Aviso: SUPERADMIN_PASSWORD no está definida. No podrás activar planes desde la API.');
}

// ---------- Almacenamiento ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'fotos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tareo2.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT NOT NULL,
    codigo       TEXT NOT NULL UNIQUE,
    email        TEXT NOT NULL UNIQUE,
    pass_hash    TEXT NOT NULL,
    pass_salt    TEXT NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'prueba',
    trial_hasta  TEXT NOT NULL,
    pagado_hasta TEXT,
    creado       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trabajadores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    dni         TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    creado      TEXT NOT NULL,
    UNIQUE (empresa_id, dni)
  );
  CREATE TABLE IF NOT EXISTS reportes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    dni         TEXT NOT NULL,
    fecha       TEXT NOT NULL,
    horas       REAL NOT NULL,
    actividad   TEXT NOT NULL,
    foto        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    enviado     TEXT NOT NULL,
    UNIQUE (empresa_id, dni, fecha)
  );
`);

// ---------- Utilidades ----------
const s = (v) => String(v ?? '').trim();

function hoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function fechaMinima() {
  const d = new Date(hoy() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - DIAS_ATRAS);
  return d.toISOString().slice(0, 10);
}

function estadoEmpresa(e) {
  const ahora = Date.now();
  if (e.pagado_hasta && new Date(e.pagado_hasta).getTime() > ahora) {
    return { estado: 'activa', hasta: e.pagado_hasta };
  }
  if (new Date(e.trial_hasta).getTime() > ahora) {
    return { estado: 'prueba', hasta: e.trial_hasta };
  }
  return { estado: 'vencida', hasta: e.pagado_hasta || e.trial_hasta };
}

function diasRestantes(hasta) {
  return Math.max(0, Math.ceil((new Date(hasta).getTime() - Date.now()) / DIA_MS));
}

function limiteTrabajadores(e) {
  if (estadoEmpresa(e).estado === 'prueba') return LIMITE_PRUEBA;
  return PLANES[e.plan]?.limite ?? LIMITE_PRUEBA;
}

function crearHash(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pass, salt, 64).toString('hex') };
}

function claveCorrecta(pass, e) {
  const calculada = crypto.scryptSync(pass, e.pass_salt, 64);
  const guardada = Buffer.from(e.pass_hash, 'hex');
  return calculada.length === guardada.length && crypto.timingSafeEqual(calculada, guardada);
}

function generarCodigo(nombre) {
  const base = nombre
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 20) || 'empresa';
  let codigo;
  do {
    codigo = `${base}-${crypto.randomInt(100, 1000)}`;
  } while (db.prepare('SELECT 1 FROM empresas WHERE codigo = ?').get(codigo));
  return codigo;
}

function borrarArchivo(file) {
  if (file) fs.unlink(file.path, () => {});
}

// ---------- Sesiones de empresa (cookie) ----------
const sesiones = new Map(); // token -> empresa_id (se pierden al reiniciar el servidor)

function leerCookie(req, nombre) {
  const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(nombre + '='));
  return c ? c.slice(nombre.length + 1) : null;
}

function empresaSesion(req) {
  const id = sesiones.get(leerCookie(req, 'sesion'));
  return id ? db.prepare('SELECT * FROM empresas WHERE id = ?').get(id) : undefined;
}

// Cookie con "Secure" cuando la conexión llega por HTTPS (detrás del proxy)
function atributosCookie(req) {
  return req.secure ? '; Secure' : '';
}

function iniciarSesion(req, res, empresaId) {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, empresaId);
  res.setHeader('Set-Cookie', `sesion=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${atributosCookie(req)}`);
}

function cerrarSesion(req, res) {
  sesiones.delete(leerCookie(req, 'sesion'));
  res.setHeader('Set-Cookie', `sesion=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${atributosCookie(req)}`);
}

function requiereEmpresa(req, res, next) {
  const e = empresaSesion(req);
  if (!e) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  req.empresa = e;
  next();
}

function requiereVigente(req, res, next) {
  if (estadoEmpresa(req.empresa).estado === 'vencida') return res.status(402).json({ error: MSG_VENCIDA });
  next();
}

function superadminOK(req) {
  if (!SUPERADMIN_PASSWORD) return false;
  const a = Buffer.from(String(req.headers['x-superadmin'] || ''));
  const b = Buffer.from(SUPERADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Fotos ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomUUID() + (file.mimetype === 'image/png' ? '.png' : '.jpg')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
});

const subirFoto = (req, res, next) =>
  upload.single('foto')(req, res, (err) => {
    if (err) {
      borrarArchivo(req.file);
      return res.status(400).json({ error: 'La foto no se pudo subir (máximo 5 MB, JPG o PNG)' });
    }
    next();
  });

// ---------- App ----------
const app = express();
// Detrás de un proxy HTTPS (Caddy), confía en X-Forwarded-Proto para saber si la conexión es segura
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== Empresas =====

app.post('/api/empresas/registro', (req, res) => {
  const nombre = s(req.body.nombre);
  const email = s(req.body.email).toLowerCase();
  const pass = String(req.body.password || '');

  if (nombre.length < 3) return res.status(400).json({ error: 'Escribe el nombre de la empresa' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'El correo no es válido' });
  if (pass.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (db.prepare('SELECT 1 FROM empresas WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
  }

  const { salt, hash } = crearHash(pass);
  const ahora = new Date();
  const trial = new Date(ahora.getTime() + DIAS_PRUEBA * DIA_MS);
  const info = db.prepare(`INSERT INTO empresas (nombre, codigo, email, pass_hash, pass_salt, plan, trial_hasta, creado)
                           VALUES (?, ?, ?, ?, ?, 'prueba', ?, ?)`)
    .run(nombre, generarCodigo(nombre), email, hash, salt, trial.toISOString(), ahora.toISOString());

  iniciarSesion(req, res, Number(info.lastInsertRowid));
  res.status(201).json({ ok: true });
});

app.post('/api/empresas/login', (req, res) => {
  const e = db.prepare('SELECT * FROM empresas WHERE email = ?').get(s(req.body.email).toLowerCase());
  if (!e || !claveCorrecta(String(req.body.password || ''), e)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  iniciarSesion(req, res, e.id);
  res.json({ ok: true });
});

app.post('/api/empresas/logout', (req, res) => {
  cerrarSesion(req, res);
  res.json({ ok: true });
});

app.get('/api/empresas/yo', requiereEmpresa, (req, res) => {
  const e = req.empresa;
  const est = estadoEmpresa(e);
  const mes = hoy().slice(0, 7);
  const trabajadores = db.prepare('SELECT COUNT(*) AS n FROM trabajadores WHERE empresa_id = ?').get(e.id).n;
  const resumen = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(horas), 0) AS horas
                              FROM reportes WHERE empresa_id = ? AND fecha LIKE ?`).get(e.id, mes + '%');
  const limite = limiteTrabajadores(e);

  res.json({
    nombre: e.nombre,
    email: e.email,
    codigo: e.codigo,
    plan: e.plan,
    planNombre: PLANES[e.plan]?.nombre || 'Prueba gratuita',
    estado: est.estado,
    hasta: est.hasta,
    diasRestantes: diasRestantes(est.hasta),
    trabajadores,
    limite: limite === Infinity ? null : limite,
    reportesMes: resumen.n,
    horasMes: resumen.horas,
    planes: Object.entries(PLANES).map(([id, p]) => ({
      id, nombre: p.nombre, precio: p.precio, limite: p.limite === Infinity ? null : p.limite,
    })),
  });
});

app.get('/api/empresas/trabajadores', requiereEmpresa, (req, res) => {
  res.json(db.prepare('SELECT dni, nombre, creado FROM trabajadores WHERE empresa_id = ? ORDER BY nombre')
    .all(req.empresa.id));
});

app.post('/api/empresas/trabajadores', requiereEmpresa, requiereVigente, (req, res) => {
  const dni = s(req.body.dni);
  const nombre = s(req.body.nombre);
  if (!/^\d{8}$/.test(dni)) return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
  if (nombre.length < 3) return res.status(400).json({ error: 'Escribe el nombre completo' });

  const limite = limiteTrabajadores(req.empresa);
  const n = db.prepare('SELECT COUNT(*) AS n FROM trabajadores WHERE empresa_id = ?').get(req.empresa.id).n;
  if (n >= limite) {
    return res.status(403).json({ error: `Tu plan permite hasta ${limite} trabajadores. Cambia de plan para agregar más.` });
  }
  if (db.prepare('SELECT 1 FROM trabajadores WHERE empresa_id = ? AND dni = ?').get(req.empresa.id, dni)) {
    return res.status(409).json({ error: 'Ese DNI ya está registrado en tu empresa' });
  }

  db.prepare('INSERT INTO trabajadores (empresa_id, dni, nombre, creado) VALUES (?, ?, ?, ?)')
    .run(req.empresa.id, dni, nombre, new Date().toISOString());
  res.status(201).json({ ok: true });
});

app.get('/api/empresas/reportes', requiereEmpresa, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.dni, COALESCE(t.nombre, '(trabajador eliminado)') AS nombre,
           r.fecha, r.horas, r.actividad, r.enviado
    FROM reportes r
    LEFT JOIN trabajadores t ON t.empresa_id = r.empresa_id AND t.dni = r.dni
    WHERE r.empresa_id = ?
    ORDER BY r.fecha DESC, r.enviado DESC
    LIMIT 500`).all(req.empresa.id));
});

app.get('/api/empresas/foto/:id', requiereEmpresa, (req, res) => {
  const fila = db.prepare('SELECT foto FROM reportes WHERE id = ? AND empresa_id = ?').get(req.params.id, req.empresa.id);
  if (!fila) return res.status(404).end();
  res.sendFile(path.join(PHOTO_DIR, path.basename(fila.foto)));
});

app.get('/api/empresas/excel', requiereEmpresa, async (req, res) => {
  try {
    const e = req.empresa;
    const filas = db.prepare(`
      SELECT r.id, r.dni, COALESCE(t.nombre, '(trabajador eliminado)') AS nombre,
             r.fecha, r.horas, r.actividad, r.enviado, r.foto, r.mime
      FROM reportes r
      LEFT JOIN trabajadores t ON t.empresa_id = r.empresa_id AND t.dni = r.dni
      WHERE r.empresa_id = ?
      ORDER BY r.fecha, nombre`).all(e.id);

    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    const ws = wb.addWorksheet('Reportes');
    ws.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'DNI', key: 'dni', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'Fecha trabajada', key: 'fecha', width: 16 },
      { header: 'Horas', key: 'horas', width: 9 },
      { header: 'Actividad', key: 'actividad', width: 50 },
      { header: 'Enviado (hora Lima)', key: 'enviado', width: 22 },
      { header: 'Foto de sustento', key: 'foto', width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const f of filas) {
      const row = ws.addRow({
        id: f.id, dni: f.dni, nombre: f.nombre, fecha: f.fecha, horas: f.horas,
        actividad: f.actividad,
        enviado: new Date(f.enviado).toLocaleString('es-PE', { timeZone: TZ }),
      });
      row.height = 90;
      row.alignment = { vertical: 'top', wrapText: true };
      try {
        const buffer = fs.readFileSync(path.join(PHOTO_DIR, path.basename(f.foto)));
        const imageId = wb.addImage({ buffer, extension: f.mime === 'image/png' ? 'png' : 'jpeg' });
        ws.addImage(imageId, { tl: { col: 7, row: row.number - 1 }, ext: { width: 120, height: 90 } });
      } catch {
        row.getCell(8).value = 'Foto no encontrada';
      }
    }

    const resumen = wb.addWorksheet('Resumen');
    resumen.columns = [
      { header: 'DNI', key: 'dni', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'Días reportados', key: 'dias', width: 16 },
      { header: 'Total horas', key: 'total', width: 14 },
    ];
    resumen.getRow(1).font = { bold: true };
    const trabajadores = db.prepare('SELECT dni, nombre FROM trabajadores WHERE empresa_id = ? ORDER BY nombre').all(e.id);
    trabajadores.forEach((t, i) => {
      const r = i + 2;
      resumen.addRow({
        dni: t.dni,
        nombre: t.nombre,
        dias: { formula: `COUNTIF(Reportes!B:B,A${r})` },
        total: { formula: `SUMIF(Reportes!B:B,A${r},Reportes!E:E)` },
      });
    });

    const nombreArchivo = `tareo_${e.codigo}_${hoy()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el Excel' });
  }
});

// ===== Trabajadores =====

function buscarTrabajador(codigo, dni) {
  const empresa = db.prepare('SELECT * FROM empresas WHERE codigo = ?').get(codigo);
  if (!empresa) return { error: 'Código de empresa no válido', status: 404 };
  if (!/^\d{8}$/.test(dni)) return { error: 'El DNI debe tener 8 dígitos', status: 400 };
  const trabajador = db.prepare('SELECT dni, nombre FROM trabajadores WHERE empresa_id = ? AND dni = ?').get(empresa.id, dni);
  if (!trabajador) return { error: 'Tu DNI no está registrado en esta empresa. Avisa a tu supervisor.', status: 404 };
  return { empresa, trabajador };
}

app.post('/api/trabajador/ingreso', (req, res) => {
  const codigo = s(req.body.codigo).toLowerCase();
  const dni = s(req.body.dni);
  const r = buscarTrabajador(codigo, dni);
  if (r.error) return res.status(r.status).json({ error: r.error });
  if (estadoEmpresa(r.empresa).estado === 'vencida') {
    return res.status(402).json({ error: 'Esta empresa no tiene el servicio activo. Avisa a tu supervisor.' });
  }
  res.json({ nombre: r.trabajador.nombre, dni: r.trabajador.dni, empresa: r.empresa.nombre, codigo: r.empresa.codigo });
});

app.post('/api/trabajador/reportes', subirFoto, (req, res) => {
  const codigo = s(req.body.codigo).toLowerCase();
  const dni = s(req.body.dni);
  const fecha = s(req.body.fecha);
  const horas = Number(req.body.horas);
  const actividad = s(req.body.actividad);

  const r = buscarTrabajador(codigo, dni);
  if (r.error) { borrarArchivo(req.file); return res.status(r.status).json({ error: r.error }); }
  if (estadoEmpresa(r.empresa).estado === 'vencida') {
    borrarArchivo(req.file);
    return res.status(402).json({ error: 'Esta empresa no tiene el servicio activo. Avisa a tu supervisor.' });
  }
  if (!req.file) return res.status(400).json({ error: 'La foto es obligatoria (JPG o PNG)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy() || fecha < fechaMinima()) {
    borrarArchivo(req.file);
    return res.status(400).json({ error: `La fecha debe ser hoy o hasta ${DIAS_ATRAS} días atrás` });
  }
  if (!(horas > 0 && horas <= 24)) {
    borrarArchivo(req.file);
    return res.status(400).json({ error: 'Las horas deben estar entre 0 y 24' });
  }
  if (actividad.length < 5 || actividad.length > 500) {
    borrarArchivo(req.file);
    return res.status(400).json({ error: 'Describe la actividad realizada (entre 5 y 500 caracteres)' });
  }
  if (db.prepare('SELECT 1 FROM reportes WHERE empresa_id = ? AND dni = ? AND fecha = ?').get(r.empresa.id, dni, fecha)) {
    borrarArchivo(req.file);
    return res.status(409).json({ error: 'Ya enviaste un reporte para esa fecha' });
  }

  db.prepare(`INSERT INTO reportes (empresa_id, dni, fecha, horas, actividad, foto, mime, enviado)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.empresa.id, dni, fecha, horas, actividad, req.file.filename, req.file.mimetype, new Date().toISOString());

  res.status(201).json({ ok: true, mensaje: 'Reporte enviado correctamente' });
});

// ===== Superadministrador: activar planes tras confirmar un pago =====

app.get('/api/superadmin/empresas', (req, res) => {
  if (!superadminOK(req)) return res.status(401).json({ error: 'No autorizado' });
  const filas = db.prepare('SELECT * FROM empresas ORDER BY creado DESC').all();
  res.json(filas.map((e) => {
    const est = estadoEmpresa(e);
    return { codigo: e.codigo, nombre: e.nombre, email: e.email, plan: e.plan, estado: est.estado, hasta: est.hasta };
  }));
});

app.post('/api/superadmin/activar', (req, res) => {
  if (!superadminOK(req)) return res.status(401).json({ error: 'No autorizado' });
  const codigo = s(req.body.codigo).toLowerCase();
  const plan = s(req.body.plan);
  const meses = Number(req.body.meses);
  if (!PLANES[plan]) return res.status(400).json({ error: 'Plan no válido: basico, pro o ilimitado' });
  if (!(meses >= 1 && meses <= 24)) return res.status(400).json({ error: 'Meses entre 1 y 24' });

  const e = db.prepare('SELECT * FROM empresas WHERE codigo = ?').get(codigo);
  if (!e) return res.status(404).json({ error: 'Empresa no encontrada' });

  // Si ya tenía días pagados, se suman a partir de su vencimiento
  const base = e.pagado_hasta && new Date(e.pagado_hasta).getTime() > Date.now()
    ? new Date(e.pagado_hasta).getTime()
    : Date.now();
  const nuevoHasta = new Date(base + meses * 30 * DIA_MS).toISOString();

  db.prepare('UPDATE empresas SET plan = ?, pagado_hasta = ? WHERE id = ?').run(plan, nuevoHasta, e.id);
  res.json({ ok: true, plan, pagado_hasta: nuevoHasta });
});

app.listen(PORT, () => {
  console.log(`Tareo digital en http://localhost:${PORT}`);
  console.log(`Panel de empresas en http://localhost:${PORT}/admin.html`);
});
