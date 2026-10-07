// Servidor HTTP mínimo: API JSON + estáticos de la PWA. Sin dependencias.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthError, authenticate, login, logout, revokeDevice, listDevices, touchDevice, sanitizeInfo } from '../auth/auth.js';
import { normalizeIp, applyKnownGeo, lookupGeo } from './geo.js';
import { pushOps, pullOps, snapshot, listConflicts, resolveConflict, movementsCsv, weekReport } from '../sync/service.js';
import { makeBuildInfo } from './build.js';
import { getEpoch, isStrictEpoch } from '../sync/reset.js';
import { PROTO } from '../../shared/constants.js';
import { config } from '../config.js';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
// Solo estas carpetas se exponen; el código del servidor nunca se sirve.
const PUBLIC_DIRS = [join(ROOT, 'public'), join(ROOT, 'src', 'shared'), join(ROOT, 'src', 'domain'), join(ROOT, 'src', 'client')];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(data);
}

async function readJson(req, limit = 2_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new AuthError(413, 'payload_too_large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError(400, 'bad_json'); }
}

// Rate limit de login en memoria (por IP). Suficiente para un solo proceso.
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(); const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n += 1; return h.n <= max;
  };
}

const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escJson = (v) => JSON.stringify(String(v)).slice(1, -1);

/** index.html y manifest.webmanifest llevan marcadores {{…}} que se rellenan con la configuración (.env). */
function renderTemplate(text, html) {
  const e = html ? escHtml : escJson;
  return text.replaceAll('{{APP_NAME}}', e(config.appName)).replaceAll('{{APP_SHORT_NAME}}', e(config.appShortName))
    .replaceAll('{{THEME_COLOR}}', e(config.themeColor)).replaceAll('{{LOCALE}}', e(config.locale))
    .replaceAll('{{APP_CONFIG}}', escHtml(JSON.stringify(config.publicConfig)));
}

async function serveStatic(pathname, res, buildInfo) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  let file;
  if (rel.startsWith('/src/')) file = join(ROOT, rel);
  else file = join(ROOT, 'public', rel);
  file = resolve(file);
  if (!PUBLIC_DIRS.some((d) => file === d || file.startsWith(d + sep))) return send(res, 404, { error: 'not_found' });
  try {
    let buf = await readFile(file);
    if (file === join(ROOT, 'public', 'index.html') || file === join(ROOT, 'public', 'manifest.webmanifest')) buf = Buffer.from(renderTemplate(buf.toString('utf8'), file.endsWith('.html')));
    if (file === join(ROOT, 'public', 'sw.js')) {
      const { build, files } = buildInfo();
      buf = Buffer.from(buf.toString('utf8').replace("'__BUILD__'", JSON.stringify(build)).replace('/*__FILES__*/[]', JSON.stringify(files)));
    }
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (file.endsWith(`${sep}sw.js`)) headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers });
    res.end(buf);
  } catch { send(res, 404, { error: 'not_found' }); }
}

export function createApp(db, { trustProxy = config.trustProxy, loginMax = config.loginMax, minProto = 1, geo = { enabled: config.geoLookup, fetch: globalThis.fetch } } = {}) {
  // IP real del cliente: Caddy pone la suya en X-Forwarded-For (solo confiable porque el servidor escucha en 127.0.0.1).
  const clientIp = (req) => normalizeIp(trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0] : req.socket.remoteAddress)
    ?? normalizeIp(req.socket.remoteAddress);
  // Info que el navegador manda solo (X-Client-Info) + lo que el servidor ve en las cabeceras (idioma, client hints).
  const clientInfo = (req) => {
    let obj = {};
    try { obj = JSON.parse(decodeURIComponent(String(req.headers['x-client-info'] ?? ''))) ?? {}; } catch { /* sin info */ }
    const h = req.headers;
    const merged = { ...obj, hdr_lang: String(h['accept-language'] ?? '').split(',')[0].trim(), ch_platform: String(h['sec-ch-ua-platform'] ?? '').replaceAll('"', ''),
      ch_mobile: String(h['sec-ch-ua-mobile'] ?? ''), ch_brands: String(h['sec-ch-ua'] ?? '').replace(/;v="[^"]*"/g, '').replaceAll('"', '').slice(0, 80) };
    return sanitizeInfo(merged);
  };
  const geoChecked = new Map();
  /** Ubicación por IP en segundo plano (nunca retrasa la petición). */
  const geoFor = (device_id, ip, force) => {
    if (!geo.enabled || !ip) return;
    const last = geoChecked.get(device_id) ?? 0;
    if (!force && Date.now() - last < 10 * 60_000) return;
    geoChecked.set(device_id, Date.now());
    try { if (!applyKnownGeo(db, device_id, ip)) lookupGeo(db, ip, geo.fetch).catch(() => {}); } catch { /* mejor esfuerzo */ }
  };
  // El hash de versión incluye la identidad configurada (nombre, color, moneda…): cambiarla en .env actualiza los equipos instalados.
  const buildInfo = makeBuildInfo(ROOT, () => JSON.stringify(config.publicConfig) + config.appShortName);
  const loginLimiter = makeLimiter(loginMax, 5 * 60_000);

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/time') {
      const tz = db.prepare("SELECT value FROM meta WHERE key='timezone'").get()?.value ?? config.timezone;
      return send(res, 200, { now: Date.now(), timezone: tz });
    }
    if (route === 'GET /api/health') return send(res, 200, { ok: true, build: buildInfo().build, proto: PROTO, min_proto: minProto });
    // Clientes demasiado viejos para este servidor: se les pide actualizar (su cola local queda intacta).
    if (Number(req.headers['x-proto'] ?? 1) < minProto) throw new AuthError(426, 'client_too_old');

    if (route === 'POST /api/login') {
      const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
      if (!loginLimiter(fwd || req.socket.remoteAddress)) throw new AuthError(429, 'too_many_attempts');
      const ip = clientIp(req);
      const out = login(db, await readJson(req), { ip, ua: req.headers['user-agent'] });
      geoFor(out.device_id, ip, true);
      return send(res, 200, out);
    }

    const ctx = authenticate(db, req.headers.authorization);
    {
      const ip = clientIp(req);
      const changed = touchDevice(db, ctx.device_id, { ip, ua: req.headers['user-agent'], info: clientInfo(req) });
      geoFor(ctx.device_id, ip, changed);
    }
    // Época de datos: si la base se reinició, los equipos con una copia de la época anterior deben descartarla.
    // /snapshot queda exento: es justamente como obtienen la época nueva.
    if (url.pathname.startsWith('/api/sync/') && url.pathname !== '/api/sync/snapshot') {
      const sent = req.headers['x-epoch'];
      if ((sent && sent !== getEpoch(db, ctx.org_id)) || (!sent && isStrictEpoch(db, ctx.org_id))) throw new AuthError(409, 'epoch_changed');
    }
    switch (route) {
      case 'POST /api/logout': logout(db, ctx); return send(res, 200, { ok: true });
      case 'GET /api/me': return send(res, 200, { user_id: ctx.user_id, org_id: ctx.org_id, role: ctx.role, device_id: ctx.device_id });
      case 'GET /api/sync/snapshot': return send(res, 200, snapshot(db, ctx));
      case 'GET /api/sync/pull': {
        const r = await pullOps(db, ctx, Number(url.searchParams.get('since') ?? 0), Number(url.searchParams.get('limit') ?? 200));
        return send(res, r.error ? 410 : 200, r);
      }
      case 'POST /api/sync/push': return send(res, 200, pushOps(db, ctx, (await readJson(req)).ops));
      case 'GET /api/reports/week': return send(res, 200, weekReport(db, ctx, url.searchParams.get('start'), url.searchParams.get('end')));
      case 'GET /api/conflicts': return send(res, 200, { conflicts: listConflicts(db, ctx, url.searchParams.get('status') ?? 'open') });
      case 'GET /api/devices': return send(res, 200, { devices: listDevices(db, ctx) });
      case 'GET /api/export/movements.csv': return send(res, 200, movementsCsv(db, ctx), { 'Content-Type': 'text/csv; charset=utf-8' });
      default: break;
    }
    let m;
    if (req.method === 'POST' && (m = /^\/api\/conflicts\/([^/]+)\/resolve$/.exec(url.pathname))) {
      const b = await readJson(req);
      return send(res, 200, resolveConflict(db, ctx, decodeURIComponent(m[1]), b.choice, b.value));
    }
    if (req.method === 'POST' && (m = /^\/api\/devices\/([^/]+)\/revoke$/.exec(url.pathname))) {
      revokeDevice(db, ctx, decodeURIComponent(m[1]));
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not_found' });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      return await serveStatic(url.pathname, res, buildInfo);
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { error: e.code });
      console.error('unhandled', e);
      return send(res, 500, { error: 'internal_error' });
    }
  });
}
