// Apertura de SQLite + esquema. Único módulo que conoce el motor (migrable a PostgreSQL).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  created_at TEXT NOT NULL, disabled_at TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id), name TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
  last_device_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions(device_id);

-- Estado/configuración (product, category, payment_method, ...). Merge por campo.
CREATE TABLE IF NOT EXISTS entities (
  org_id TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL,
  data TEXT NOT NULL, version INTEGER NOT NULL, field_meta TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, type, id)
);

-- Log de operaciones (append-only). seq = orden del servidor.
CREATE TABLE IF NOT EXISTS operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL, op_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL, user_id TEXT, device_seq INTEGER,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, op_type TEXT NOT NULL,
  payload TEXT NOT NULL, base_version INTEGER,
  created_at TEXT NOT NULL, received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','partial','conflict','rejected')),
  reason TEXT, effects TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_device_seq ON operations(org_id, device_id, device_seq);
CREATE INDEX IF NOT EXISTS operations_org_seq ON operations(org_id, seq);

-- Hechos acumulativos (venta, compra, ajuste, gasto). Inmutables salvo 'voided'.
CREATE TABLE IF NOT EXISTS records (
  org_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, op_id TEXT NOT NULL,
  data TEXT NOT NULL, voided INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS records_op ON records(org_id, op_id);

-- Inventario = SUM(delta). Nunca se actualiza un "stock", solo se agregan movimientos.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, product_id TEXT NOT NULL,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, record_id TEXT, op_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS movements_product ON inventory_movements(org_id, product_id);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, op_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
  base_version INTEGER, server_version INTEGER,
  server_value TEXT, client_value TEXT,
  status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_value TEXT,
  resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflicts_org ON conflicts(org_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, at TEXT NOT NULL,
  actor_user_id TEXT, device_id TEXT, action TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Migraciones aditivas (seguras de repetir): columnas nuevas de `devices`, caché de ubicación por IP y la vista legible.
function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  for (const col of ['label', 'platform', 'user_agent', 'first_ip', 'last_ip', 'geo_city', 'geo_region', 'geo_country', 'geo_isp', 'geo_lat', 'geo_lon', 'geo_tz', 'geo_asn', 'ip_host', 'client_info', 'info_updated_at']) {
    if (!have.has(col)) db.exec(`ALTER TABLE devices ADD COLUMN ${col} TEXT`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ip_geo (
    ip TEXT PRIMARY KEY, ok INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, isp TEXT, looked_up_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS device_ips (
    device_id TEXT NOT NULL, ip TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (device_id, ip));`);
  db.exec('CREATE INDEX IF NOT EXISTS records_created ON records(org_id, created_at)');
  const geoCols = new Set(db.prepare('PRAGMA table_info(ip_geo)').all().map((c) => c.name));
  for (const col of ['lat', 'lon', 'tz', 'asn', 'hostname']) if (!geoCols.has(col)) db.exec(`ALTER TABLE ip_geo ADD COLUMN ${col} TEXT`);
  const j = (d, k) => `json_extract(d.client_info, '$.${k}')`;
  db.exec(`DROP VIEW IF EXISTS dispositivos; DROP VIEW IF EXISTS historial_ips; DROP VIEW IF EXISTS accesos;
  CREATE VIEW dispositivos AS
    SELECT substr(d.id, 1, 8) AS equipo, COALESCE(d.label, '(sin nombre)') AS nombre, d.platform AS tipo, u.username AS usuario,
           CASE ${j(0, 'standalone')} WHEN 1 THEN 'app instalada' WHEN 0 THEN 'pestaña del navegador' END AS modo,
           ${j(0, 'model')} AS modelo, ${j(0, 'screen')} AS pantalla, ${j(0, 'tz')} AS zona_horaria, ${j(0, 'lang')} AS idioma,
           ${j(0, 'conn')} AS conexion, ${j(0, 'cores')} AS nucleos, ${j(0, 'mem')} AS memoria_gb, ${j(0, 'app')} AS version_app, ${j(0, 'skew')} AS desfase_reloj_s,
           CASE ${j(0, 'persisted')} WHEN 1 THEN 'sí' WHEN 0 THEN 'no' END AS almacenamiento_protegido,
           d.last_ip AS ip, d.ip_host AS host_ip, d.geo_city AS ciudad, d.geo_region AS departamento, d.geo_country AS pais,
           d.geo_isp AS proveedor_internet, d.geo_asn AS asn, d.geo_lat AS latitud, d.geo_lon AS longitud, d.geo_tz AS zona_horaria_ip,
           d.first_ip AS ip_primera_vez, d.created_at AS primera_vez, d.last_seen_at AS ultima_vez,
           d.last_device_seq AS operaciones_enviadas, CASE WHEN d.revoked_at IS NULL THEN 'activo' ELSE 'revocado' END AS estado,
           d.user_agent AS user_agent, d.id AS id_completo
    FROM devices d LEFT JOIN users u ON u.id = d.user_id;
  CREATE VIEW historial_ips AS
    SELECT substr(i.device_id, 1, 8) AS equipo, d.platform AS tipo, i.ip, g.city AS ciudad, g.region AS departamento, g.country AS pais,
           g.isp AS proveedor_internet, g.hostname AS host, i.first_seen AS primera_vez, i.last_seen AS ultima_vez, i.hits AS veces
    FROM device_ips i LEFT JOIN devices d ON d.id = i.device_id LEFT JOIN ip_geo g ON g.ip = i.ip;
  CREATE VIEW accesos AS
    SELECT a.at AS cuando, a.action AS evento, json_extract(a.detail, '$.username') AS usuario, json_extract(a.detail, '$.ip') AS ip,
           g.city AS ciudad, g.country AS pais, json_extract(a.detail, '$.ua') AS navegador, substr(a.device_id, 1, 8) AS equipo
    FROM audit_log a LEFT JOIN ip_geo g ON g.ip = json_extract(a.detail, '$.ip') WHERE a.action LIKE 'login.%';`);
}

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Transacción serializable (un solo escritor). Revierte si `fn` lanza. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();

export function audit(db, { org_id = null, actor_user_id = null, device_id = null, action, detail = null }) {
  db.prepare('INSERT INTO audit_log (org_id, at, actor_user_id, device_id, action, detail) VALUES (?,?,?,?,?,?)')
    .run(org_id, nowIso(), actor_user_id, device_id, action, detail == null ? null : JSON.stringify(detail));
}
