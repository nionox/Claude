const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TZ = process.env.TZ_NEGOCIO || 'America/Lima';
const DIAS_ATRAS_PERMITIDOS = 7;

if (!ADMIN_PASSWORD) {
  console.error('Falta la variable ADMIN_PASSWORD. Ejemplo: ADMIN_PASSWORD=mi-clave npm start');
  process.exit(1);
}

// ---------- Almacenamiento ----------
const DATA_DIR = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'fotos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tareo.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS trabajadores (
    dni     TEXT PRIMARY KEY,
    nombre  TEXT NOT NULL,
    creado  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reportes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dni        TEXT NOT NULL REFERENCES trabajadores(dni),
    fecha      TEXT NOT NULL,            -- YYYY-MM-DD, el día trabajado
    horas      REAL NOT NULL,
    actividad  TEXT NOT NULL,
    foto       TEXT NOT NULL,            -- nombre del archivo en data/fotos
    mime       TEXT NOT NULL,
    enviado    TEXT NOT NULL,            -- momento del envío (hora del servidor, UTC ISO)
    UNIQUE (dni, fecha)                  -- un solo reporte por día y trabajador
  );
`);

// ---------- Subida de fotos ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomUUID() + (file.mimetype === 'image/png' ? '.png' : '.jpg')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
});

function borrarArchivo(file) {
  if (file) fs.unlink(file.path, () => {});
}

// Fecha de hoy en la zona horaria del negocio (YYYY-MM-DD)
function hoy() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fechaMinima() {
  const d = new Date(hoy() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - DIAS_ATRAS_PERMITIDOS);
  return d.toISOString().slice(0, 10);
}

// ---------- Sesión del administrador (cookie) ----------
const sesionesAdmin = new Set();

function esAdmin(req) {
  const cookie = (req.headers.cookie || '')
    .split(';').map((c) => c.trim()).find((c) => c.startsWith('admin='));
  return Boolean(cookie) && sesionesAdmin.has(cookie.slice('admin='.length));
}

function requiereAdmin(req, res, next) {
  if (esAdmin(req)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Trabajador ---

// Ingreso del trabajador con su DNI (debe estar registrado por el administrador)
app.post('/api/login', (req, res) => {
  const dni = String(req.body?.dni || '').trim();
  if (!/^\d{8}$/.test(dni)) return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });

  const trabajador = db.prepare('SELECT dni, nombre FROM trabajadores WHERE dni = ?').get(dni);
  if (!trabajador) return res.status(404).json({ error: 'DNI no registrado. Consulta con tu supervisor.' });
  res.json(trabajador);
});

// Envío del reporte de jornada con foto obligatoria
app.post(
  '/api/reportes',
  (req, res, next) =>
    upload.single('foto')(req, res, (err) => {
      if (err) {
        borrarArchivo(req.file);
        return res.status(400).json({ error: 'La foto no se pudo subir (máximo 5 MB)' });
      }
      next();
    }),
  (req, res) => {
    const dni = String(req.body.dni || '').trim();
    const fecha = String(req.body.fecha || '');
    const horas = Number(req.body.horas);
    const actividad = String(req.body.actividad || '').trim();

    const trabajador = db.prepare('SELECT nombre FROM trabajadores WHERE dni = ?').get(dni);
    if (!trabajador) { borrarArchivo(req.file); return res.status(404).json({ error: 'DNI no registrado' }); }
    if (!req.file) return res.status(400).json({ error: 'La foto es obligatoria (JPG o PNG)' });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > hoy() || fecha < fechaMinima()) {
      borrarArchivo(req.file);
      return res.status(400).json({ error: `La fecha debe ser hoy o hasta ${DIAS_ATRAS_PERMITIDOS} días atrás` });
    }
    if (!(horas > 0 && horas <= 24)) {
      borrarArchivo(req.file);
      return res.status(400).json({ error: 'Las horas deben estar entre 0 y 24' });
    }
    if (actividad.length < 5 || actividad.length > 500) {
      borrarArchivo(req.file);
      return res.status(400).json({ error: 'Describe la actividad realizada (entre 5 y 500 caracteres)' });
    }
    if (db.prepare('SELECT 1 FROM reportes WHERE dni = ? AND fecha = ?').get(dni, fecha)) {
      borrarArchivo(req.file);
      return res.status(409).json({ error: 'Ya enviaste un reporte para esa fecha' });
    }

    db.prepare(`INSERT INTO reportes (dni, fecha, horas, actividad, foto, mime, enviado)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(dni, fecha, horas, actividad, req.file.filename, req.file.mimetype, new Date().toISOString());

    res.status(201).json({ ok: true, mensaje: 'Reporte enviado correctamente' });
  }
);

// --- Administrador ---

app.post('/api/admin/login', (req, res) => {
  const clave = String(req.body?.password || '');
  const correcta = Buffer.from(ADMIN_PASSWORD);
  const recibida = Buffer.from(clave);
  const ok = recibida.length === correcta.length && crypto.timingSafeEqual(recibida, correcta);
  if (!ok) return res.status(401).json({ error: 'Clave incorrecta' });

  const token = crypto.randomBytes(32).toString('hex');
  sesionesAdmin.add(token);
  // Agrega "; Secure" si la app se sirve por HTTPS
  res.setHeader('Set-Cookie', `admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('admin='));
  if (cookie) sesionesAdmin.delete(cookie.slice('admin='.length));
  res.setHeader('Set-Cookie', 'admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/sesion', (req, res) => res.json({ autenticado: esAdmin(req) }));

app.get('/api/admin/trabajadores', requiereAdmin, (req, res) => {
  res.json(db.prepare('SELECT dni, nombre, creado FROM trabajadores ORDER BY nombre').all());
});

app.post('/api/admin/trabajadores', requiereAdmin, (req, res) => {
  const dni = String(req.body?.dni || '').trim();
  const nombre = String(req.body?.nombre || '').trim();
  if (!/^\d{8}$/.test(dni)) return res.status(400).json({ error: 'El DNI debe tener 8 dígitos' });
  if (nombre.length < 3) return res.status(400).json({ error: 'Escribe el nombre completo' });
  if (db.prepare('SELECT 1 FROM trabajadores WHERE dni = ?').get(dni)) {
    return res.status(409).json({ error: 'Ese DNI ya está registrado' });
  }
  db.prepare('INSERT INTO trabajadores (dni, nombre, creado) VALUES (?, ?, ?)')
    .run(dni, nombre, new Date().toISOString());
  res.status(201).json({ ok: true });
});

app.get('/api/admin/reportes', requiereAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.dni, t.nombre, r.fecha, r.horas, r.actividad, r.enviado, r.foto
    FROM reportes r JOIN trabajadores t ON t.dni = r.dni
    ORDER BY r.fecha DESC, r.enviado DESC
    LIMIT 500`).all());
});

app.get('/api/admin/foto/:id', requiereAdmin, (req, res) => {
  const fila = db.prepare('SELECT foto FROM reportes WHERE id = ?').get(req.params.id);
  if (!fila) return res.status(404).end();
  res.sendFile(path.join(PHOTO_DIR, path.basename(fila.foto)));
});

app.get('/api/admin/excel', requiereAdmin, async (req, res) => {
  try {
    const filas = db.prepare(`
      SELECT r.id, r.dni, t.nombre, r.fecha, r.horas, r.actividad, r.enviado, r.foto, r.mime
      FROM reportes r JOIN trabajadores t ON t.dni = r.dni
      ORDER BY r.fecha, t.nombre`).all();

    const wb = new ExcelJS.Workbook();
    wb.created = new Date();

    // Hoja 1: un reporte por fila, con la foto incrustada
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
        id: f.id,
        dni: f.dni,
        nombre: f.nombre,
        fecha: f.fecha,
        horas: f.horas,
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

    // Hoja 2: resumen por trabajador (fórmulas que se actualizan solas)
    const resumen = wb.addWorksheet('Resumen');
    resumen.columns = [
      { header: 'DNI', key: 'dni', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'Días reportados', key: 'dias', width: 16 },
      { header: 'Total horas', key: 'total', width: 14 },
    ];
    resumen.getRow(1).font = { bold: true };
    const trabajadores = db.prepare('SELECT dni, nombre FROM trabajadores ORDER BY nombre').all();
    trabajadores.forEach((t, i) => {
      const r = i + 2;
      resumen.addRow({
        dni: t.dni,
        nombre: t.nombre,
        dias: { formula: `COUNTIF(Reportes!B:B,A${r})` },
        total: { formula: `SUMIF(Reportes!B:B,A${r},Reportes!E:E)` },
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tareo_${hoy()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el Excel' });
  }
});

app.listen(PORT, () => {
  console.log(`Tareo digital en http://localhost:${PORT}`);
  console.log(`Administrador en http://localhost:${PORT}/admin.html`);
});
