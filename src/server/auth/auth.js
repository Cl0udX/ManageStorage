// Autenticación: scrypt, sesiones opacas (solo se guarda su hash), dispositivos revocables.
import { scryptSync, randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { tx, nowIso, audit } from '../db/db.js';
import { parseUserAgent } from '../http/ua.js';

const SESSION_DAYS = 30;
const DAY = 86400_000;

export class AuthError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// Hash de relleno para igualar tiempos cuando el usuario no existe.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export function createOrganization(db, { name, ownerUsername, ownerPassword }) {
  const org_id = randomUUID();
  const user_id = randomUUID();
  tx(db, () => {
    db.prepare('INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)').run(org_id, name, nowIso());
    db.prepare('INSERT INTO users (id,org_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(user_id, org_id, ownerUsername, hashPassword(ownerPassword), 'owner', nowIso());
    audit(db, { org_id, actor_user_id: user_id, action: 'org.created', detail: { name } });
  });
  return { org_id, user_id };
}

export function createUser(db, { org_id, username, password, role = 'staff' }) {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id,org_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, org_id, username, hashPassword(password), role, nowIso());
  audit(db, { org_id, action: 'user.created', detail: { username, role } });
  return id;
}

/** Login + registro/reanudación del dispositivo. Devuelve el token en claro UNA vez. */
// Nombre que le pone una persona al equipo ("Celular de la caja"). Los clientes viejos mandaban el user-agent: se ignora.
const cleanLabel = (v) => {
  const t = String(v ?? '').trim().slice(0, 60);
  return t && !/^Mozilla\//.test(t) ? t : null;
};

export function login(db, { username, password, device_id, device_name }, { ip = null, ua = null } = {}) {
  if (typeof username !== 'string' || typeof password !== 'string' || typeof device_id !== 'string'
      || !/^[A-Za-z0-9_.:-]{8,80}$/.test(device_id)) throw new AuthError(400, 'bad_request');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || user.disabled_at) {
    audit(db, { org_id: user?.org_id ?? null, action: 'login.failed', detail: { username, ip, ua: parseUserAgent(ua) ?? String(ua ?? '').slice(0, 80) } });
    throw new AuthError(401, 'invalid_credentials');
  }
  const token = `ms_${randomBytes(32).toString('base64url')}`;
  const expires_at = new Date(Date.now() + SESSION_DAYS * DAY).toISOString();
  tx(db, () => {
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
    if (dev && dev.org_id !== user.org_id) throw new AuthError(403, 'device_belongs_to_other_org');
    if (dev?.revoked_at) throw new AuthError(403, 'device_revoked');
    if (!dev) {
      db.prepare(`INSERT INTO devices (id,org_id,user_id,name,label,platform,user_agent,first_ip,last_ip,created_at,last_seen_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(device_id, user.org_id, user.id, cleanLabel(device_name) ?? '', cleanLabel(device_name), parseUserAgent(ua), String(ua ?? '').slice(0, 300), ip, ip, nowIso(), nowIso());
    } else {
      db.prepare(`UPDATE devices SET user_id=?, last_seen_at=?, platform=COALESCE(?,platform), user_agent=COALESCE(?,user_agent),
                  first_ip=COALESCE(first_ip,?), last_ip=COALESCE(?,last_ip), label=COALESCE(?,label) WHERE id=?`)
        .run(user.id, nowIso(), parseUserAgent(ua), ua ? String(ua).slice(0, 300) : null, ip, ip, cleanLabel(device_name), device_id);
    }
    db.prepare('INSERT INTO sessions (token_hash,org_id,user_id,device_id,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), user.org_id, user.id, device_id, nowIso(), expires_at);
    audit(db, { org_id: user.org_id, actor_user_id: user.id, device_id, action: 'login.ok', detail: { ip, username, ua: parseUserAgent(ua) } });
    logIp(db, device_id, ip);
  });
  const org = db.prepare('SELECT id,name FROM organizations WHERE id=?').get(user.org_id);
  return { token, expires_at, user: { id: user.id, username: user.username, role: user.role }, org, device_id };
}

/** Resuelve el contexto de la petición a partir del Bearer token. Lanza AuthError. */
export function authenticate(db, header) {
  const m = /^Bearer (ms_[A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (!m) throw new AuthError(401, 'unauthenticated');
  const h = sha256(m[1]);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
  if (!s) throw new AuthError(401, 'unauthenticated');
  if (s.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    throw new AuthError(401, 'session_expired');
  }
  const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(s.device_id);
  if (!dev || dev.revoked_at) throw new AuthError(403, 'device_revoked');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!user || user.disabled_at) throw new AuthError(401, 'unauthenticated');
  // Sesión deslizante: se renueva cuando queda menos de la mitad.
  if (Date.parse(s.expires_at) - Date.now() < (SESSION_DAYS * DAY) / 2) {
    db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .run(new Date(Date.now() + SESSION_DAYS * DAY).toISOString(), h);
  }
  db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(nowIso(), dev.id);
  return { org_id: s.org_id, user_id: user.id, role: user.role, device_id: dev.id, token_hash: h };
}

export function logout(db, ctx) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.token_hash);
}

export function revokeDevice(db, ctx, deviceId) {
  if (ctx.role !== 'owner') throw new AuthError(403, 'forbidden');
  const dev = db.prepare('SELECT * FROM devices WHERE id=? AND org_id=?').get(deviceId, ctx.org_id);
  if (!dev) throw new AuthError(404, 'not_found');
  tx(db, () => {
    db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(nowIso(), deviceId);
    // Las sesiones se conservan a propósito: authenticate() responde 403 device_revoked (no 401),
    // así el cliente sabe que fue revocado y no intenta simplemente re-loguearse.
    audit(db, { org_id: ctx.org_id, actor_user_id: ctx.user_id, device_id: deviceId, action: 'device.revoked' });
  });
}

export function listDevices(db, ctx) {
  if (ctx.role !== 'owner') throw new AuthError(403, 'forbidden');
  return db.prepare('SELECT id,name,user_id,created_at,last_seen_at,revoked_at,last_device_seq FROM devices WHERE org_id=? ORDER BY created_at').all(ctx.org_id);
}

function logIp(db, device_id, ip) {
  if (!ip) return;
  db.prepare(`INSERT INTO device_ips (device_id, ip, first_seen, last_seen) VALUES (?,?,?,?)
              ON CONFLICT(device_id, ip) DO UPDATE SET last_seen=excluded.last_seen, hits=hits+1`).run(device_id, ip, nowIso(), nowIso());
}

// Datos que el navegador informa solo (sin que nadie escriba nada). Lista blanca, valores simples y cortos.
const INFO_KEYS = ['tz', 'lang', 'langs', 'screen', 'dpr', 'standalone', 'touch', 'cores', 'mem', 'conn', 'platform', 'model', 'osv', 'arch', 'app', 'skew', 'persisted', 'hdr_lang', 'ch_platform', 'ch_mobile', 'ch_brands'];
export function sanitizeInfo(raw) {
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of INFO_KEYS) {
    const v = obj[k];
    if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
  }
  return Object.keys(out).length ? JSON.stringify(Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))) : null;
}

/** Actualiza IP/tipo del equipo con cada petición autenticada. Devuelve true si la IP cambió (hay que revisar ubicación). */
export function touchDevice(db, device_id, { ip = null, ua = null, info = null } = {}) {
  const d = db.prepare('SELECT last_ip, platform, client_info FROM devices WHERE id=?').get(device_id);
  if (!d) return false;
  const platform = parseUserAgent(ua);
  const ipChanged = !!ip && ip !== d.last_ip;
  if (ipChanged) {
    if (d.last_ip) db.prepare('UPDATE device_ips SET last_seen=? WHERE device_id=? AND ip=?').run(nowIso(), device_id, d.last_ip);
    logIp(db, device_id, ip);
    db.prepare(`UPDATE devices SET last_ip=?, first_ip=COALESCE(first_ip,?), geo_city=NULL, geo_region=NULL, geo_country=NULL, geo_isp=NULL,
                geo_lat=NULL, geo_lon=NULL, geo_tz=NULL, geo_asn=NULL, ip_host=NULL WHERE id=?`).run(ip, ip, device_id);
  }
  if (platform && platform !== d.platform) db.prepare('UPDATE devices SET platform=?, user_agent=? WHERE id=?').run(platform, String(ua).slice(0, 300), device_id);
  if (info && info !== d.client_info) db.prepare('UPDATE devices SET client_info=?, info_updated_at=? WHERE id=?').run(info, nowIso(), device_id);
  return ipChanged;
}
