// Consola de solo lectura sobre la base de datos (no puede modificar nada: SQLite en modo readOnly).
//   node scripts/db.js tables              tablas y cantidad de filas
//   node scripts/db.js schema [tabla]      esquema (CREATE ...)
//   node scripts/db.js devices             equipos: tipo, IP, ubicación, última vez
//   node scripts/db.js device <inicio_id>  TODO lo que se sabe de un equipo (+ historial de IPs)
//   node scripts/db.js accesos [N]         inicios de sesión (buenos y fallidos) con IP y navegador
//   node scripts/db.js stock               stock actual por producto (suma de movimientos)
//   node scripts/db.js ops [N]             últimas N operaciones del log (default 20)
//   node scripts/db.js "SELECT ..."        cualquier consulta de lectura
// Opciones: --json (salida JSON). la base sale de DB_PATH (.env).
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/server/config.js';

const SECRET_COLS = new Set(['password_hash', 'token_hash']);
const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const db = new DatabaseSync(config.dbPath, { readOnly: true });

const mask = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, SECRET_COLS.has(k) ? '***' : v])));
const show = (rows) => (asJson ? console.log(JSON.stringify(mask(rows), null, 2)) : rows.length ? console.table(mask(rows)) : console.log('(sin filas)'));

const [cmd, arg] = args;
const SHORT = {
  devices: () => db.prepare('SELECT equipo, tipo, modo, usuario, ip, ciudad, departamento, pais, proveedor_internet, ultima_vez FROM dispositivos ORDER BY ultima_vez DESC').all(),
  device: () => {
    const rows = db.prepare("SELECT * FROM dispositivos WHERE id_completo LIKE ? || '%'").all(arg ?? '');
    if (rows.length !== 1) return [{ error: rows.length ? 'varios equipos coinciden: usa más caracteres del id' : 'no existe ese equipo (mira ./ms db devices)' }];
    const out = Object.entries(rows[0]).filter(([, v]) => v !== null).map(([campo, valor]) => ({ campo, valor }));
    const hist = db.prepare(`SELECT ip AS campo,
        coalesce(ciudad, '?') || ', ' || coalesce(pais, '?') || ' · ' || coalesce(proveedor_internet, '?') || ' · ' || coalesce(host, '') ||
        ' · ' || primera_vez || ' → ' || ultima_vez || ' · ' || veces || ' veces' AS valor
      FROM historial_ips WHERE equipo = ? ORDER BY ultima_vez DESC`).all(rows[0].equipo);
    return [...out, ...hist];
  },
  accesos: () => db.prepare('SELECT * FROM accesos ORDER BY cuando DESC LIMIT ?').all(Number(arg) || 20),
  tables: () => db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all()
    .map(({ name, type }) => ({ tabla: type === 'view' ? `${name} (vista)` : name, filas: db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c })),
  schema: () => db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (? IS NULL OR tbl_name=?) ORDER BY type DESC, name").all(arg ?? null, arg ?? null),
  stock: () => db.prepare(`SELECT e.id, json_extract(e.data,'$.name') AS producto, json_extract(e.data,'$.cost') AS costo,
      json_extract(e.data,'$.price') AS precio, COALESCE(SUM(m.delta),0) AS stock
      FROM entities e LEFT JOIN inventory_movements m ON m.org_id=e.org_id AND m.product_id=e.id
      WHERE e.type='product' GROUP BY e.org_id, e.id ORDER BY producto`).all(),
  ops: () => db.prepare(`SELECT o.seq, o.op_type, o.status, o.reason, COALESCE(d.label, d.platform, o.device_id) AS equipo,
      o.device_seq, o.created_at, o.received_at FROM operations o LEFT JOIN devices d ON d.id = o.device_id ORDER BY o.seq DESC LIMIT ?`).all(Number(arg) || 20),
};

try {
  if (!cmd) { console.log('uso: node scripts/db.js tables | schema [tabla] | stock | ops [N] | "SELECT ..."'); process.exit(1); }
  show(SHORT[cmd] ? SHORT[cmd]() : db.prepare(args.join(' ')).all());
} catch (e) {
  console.error('error:', e.message); process.exit(1);
}
