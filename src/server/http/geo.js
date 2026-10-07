// Ubicación aproximada a partir de la IP (ciudad/departamento/país/proveedor de internet).
// Consulta un servicio gratuito (ipwho.is, HTTPS, sin clave) enviando SOLO la IP. Es en segundo plano y de mejor
// esfuerzo: nunca retrasa ni rompe una petición. Resultado cacheado en la tabla ip_geo. Se desactiva con GEO_LOOKUP=off.
// OJO: la ubicación por IP es aproximada; en celulares suele ser la ciudad del proveedor de internet, no la calle.
import { isIP } from 'node:net';
import { reverse } from 'node:dns/promises';
import { nowIso } from '../db/db.js';

const OK_TTL_MS = 30 * 86400_000;   // lo encontrado se reutiliza 30 días
const FAIL_TTL_MS = 6 * 3600_000;   // si falló, se reintenta en 6 horas

export function normalizeIp(raw) {
  let ip = String(raw ?? '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

export function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/** Copia a `devices` la ubicación ya conocida de su IP. Devuelve true si no hace falta consultar. */
export function applyKnownGeo(db, device_id, ip) {
  if (!ip || isPrivateIp(ip)) return true;
  const g = db.prepare('SELECT * FROM ip_geo WHERE ip=?').get(ip);
  if (!g) return false;
  db.prepare('UPDATE devices SET geo_city=?, geo_region=?, geo_country=?, geo_isp=?, geo_lat=?, geo_lon=?, geo_tz=?, geo_asn=?, ip_host=? WHERE id=?')
    .run(g.city, g.region, g.country, g.isp, g.lat, g.lon, g.tz, g.asn, g.hostname, device_id);
  return Date.now() - Date.parse(g.looked_up_at) < (g.ok ? OK_TTL_MS : FAIL_TTL_MS);
}

const inflight = new Set();

/** Consulta (si hace falta) y guarda la ubicación de `ip`; actualiza los dispositivos que la usan. */
export async function lookupGeo(db, ip, fetchFn = globalThis.fetch) {
  if (!ip || isPrivateIp(ip) || inflight.has(ip)) return;
  inflight.add(ip);
  try {
    let row = { ok: 0, country: null, region: null, city: null, isp: null, lat: null, lon: null, tz: null, asn: null, hostname: null };
    try {
      const res = await fetchFn(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(4000) });
      const j = await res.json();
      if (j?.success) {
        row = { ...row, ok: 1, country: j.country ?? null, region: j.region ?? null, city: j.city ?? null, isp: j.connection?.isp ?? j.connection?.org ?? null,
          lat: j.latitude != null ? String(j.latitude) : null, lon: j.longitude != null ? String(j.longitude) : null,
          tz: j.timezone?.id ?? null, asn: j.connection?.asn != null ? `AS${j.connection.asn}` : null };
      }
    } catch { /* sin internet / servicio caído: se reintenta más tarde */ }
    try { row.hostname = (await Promise.race([reverse(ip), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]))?.[0] ?? null; } catch { /* sin DNS inverso */ }
    db.prepare('INSERT OR REPLACE INTO ip_geo (ip,ok,country,region,city,isp,lat,lon,tz,asn,hostname,looked_up_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ip, row.ok, row.country, row.region, row.city, row.isp, row.lat, row.lon, row.tz, row.asn, row.hostname, nowIso());
    db.prepare('UPDATE devices SET geo_city=?, geo_region=?, geo_country=?, geo_isp=?, geo_lat=?, geo_lon=?, geo_tz=?, geo_asn=?, ip_host=? WHERE last_ip=?')
      .run(row.city, row.region, row.country, row.isp, row.lat, row.lon, row.tz, row.asn, row.hostname, ip);
  } finally { inflight.delete(ip); }
}
