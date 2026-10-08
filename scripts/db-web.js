// Visor web de SOLO LECTURA de la base de datos (tipo pgAdmin, mínimo). Se corre a demanda, no es un servicio.
// Escucha únicamente en 127.0.0.1 y exige un token aleatorio en la URL; se usa por túnel SSH:
//   ssh -t -L 8096:127.0.0.1:8096 <tu-servidor> "cd <carpeta-del-proyecto> && ./ms db-web"     (con -t, Ctrl+C también cierra el visor del servidor)
// y abrir la URL con ?t=TOKEN que imprime. La BD se abre readOnly (SQLite rechaza cualquier escritura).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/server/config.js';

const PORT = Number(process.env.DB_WEB_PORT ?? 8096);
const TOKEN = randomBytes(16).toString('hex');
const db = new DatabaseSync(config.dbPath, { readOnly: true });
const SECRET_COLS = new Set(['password_hash', 'token_hash']);
const PAGE = 50;
const IDLE_MS = 30 * 60_000; // se cierra solo tras 30 min sin uso (así no queda un visor abierto olvidado)
let idleTimer = null;
const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { console.log('Visor cerrado por inactividad (30 min).'); process.exit(0); }, IDLE_MS); };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all().map((r) => r.name);
const isView = (n) => db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(n)?.type === 'view';

function grid(rows, url) {
  if (!rows.length) return '<p><i>(sin filas)</i></p>';
  const cols = Object.keys(rows[0]);
  const text = (k, v) => (SECRET_COLS.has(k) ? '***' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cards = url?.searchParams.get('v') === 'cards';
  let toggle = '';
  if (url) {
    const u = new URL(url); u.searchParams.set('v', cards ? 'table' : 'cards');
    toggle = `<p class="tg"><a href="${esc(u.pathname + u.search)}">${cards ? '☰ Ver como tabla' : '🗂 Ver como tarjetas (una por fila, con todos los campos)'}</a></p>`;
  }
  if (cards) {
    // Una tarjeta por fila: clave/valor en vertical, con el texto completo (los campos vacíos se ocultan).
    return toggle + `<div class="cards">${rows.map((r) => {
      const filled = cols.filter((c) => r[c] !== null && r[c] !== undefined);
      return `<div class="card"><table class="kv">${filled.map((c) => `<tr><th>${esc(c)}</th><td>${esc(text(c, r[c]))}</td></tr>`).join('')}</table>${filled.length < cols.length ? `<small>(${cols.length - filled.length} campos vacíos ocultos)</small>` : ''}</div>`;
    }).join('')}</div>`;
  }
  // Tabla: cada columna conserva su ancho natural (no se aprieta); si no cabe, se desplaza. Valor completo al pasar el mouse.
  const cell = (k, v) => (v === null || v === undefined ? '<td class="nul" title="NULL">NULL</td>' : `<td title="${esc(text(k, v))}">${esc(text(k, v))}</td>`);
  return toggle + `<div class="w"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => cell(c, r[c])).join('')}</tr>`).join('')}</table></div>`;
}

function page(body, sql = '') {
  const nav = tables().map((t) => `<a href="/t/${esc(t)}?t=${TOKEN}">${esc(t)}</a>`).join(' · ');
  return `<!doctype html><meta charset="utf-8"><title>DB (solo lectura)</title><style>
body{font:14px system-ui;margin:1rem;color:#1c1f1a}a{color:#14532d}
.w{overflow:auto;max-width:100%;max-height:72vh;border:1px solid #d6dad0}
table{border-collapse:separate;border-spacing:0;width:max-content}
td,th{border-right:1px solid #e3e6dd;border-bottom:1px solid #e3e6dd;padding:4px 10px;text-align:left;vertical-align:top;font-family:ui-monospace,monospace;font-size:12px;
  white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}
th{background:#eef2ea;position:sticky;top:0;z-index:2}
td:first-child,th:first-child{position:sticky;left:0;background:#f7f9f4;z-index:1}th:first-child{z-index:3}
tr:hover td{background:#fffbe6}.nul{color:#9aa094;font-style:italic}
.tg{margin:.4rem 0}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:.8rem}
.card{border:1px solid #d6dad0;border-radius:8px;padding:.5rem .7rem;background:#fcfdfb}.card small{color:#9aa094}
.kv{width:100%}.kv th{position:static;background:none;color:#5d625a;width:38%;font-weight:600}.kv td,.kv th{white-space:normal;overflow-wrap:anywhere;max-width:none;border:0;border-bottom:1px solid #eef0e8}.kv td:first-child{position:static;background:none}
textarea{width:100%;height:5rem;font:12px ui-monospace,monospace}.err{color:#b91c1c}</style>
<h3>Base de datos · <small>solo lectura</small></h3><p><a href="/?t=${TOKEN}">Inicio</a> · ${nav}</p>
<form action="/q"><input type="hidden" name="t" value="${TOKEN}"><textarea name="sql" placeholder="SELECT ...">${esc(sql)}</textarea><br><button>Ejecutar</button></form>${body}`;
}

const server = http.createServer((req, res) => {
  touch();
  const url = new URL(req.url, 'http://x');
  const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(html); };
  if (url.searchParams.get('t') !== TOKEN) return send(403, 'token inválido');
  try {
    let m;
    if (url.pathname === '/') {
      const rows = tables().map((t) => ({ tabla: `<a href="/t/${esc(t)}?t=${TOKEN}">${esc(t)}</a>`, filas: db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c }));
      return send(200, page(`<table><tr><th>tabla</th><th>filas</th></tr>${rows.map((r) => `<tr><td>${r.tabla}</td><td>${r.filas}</td></tr>`).join('')}</table>`));
    }
    if ((m = /^\/t\/([A-Za-z0-9_]+)$/.exec(url.pathname)) && tables().includes(m[1])) {
      const p = Math.max(0, Number(url.searchParams.get('p') ?? 0) || 0);
      const total = db.prepare(`SELECT COUNT(*) c FROM "${m[1]}"`).get().c;
      const order = isView(m[1]) ? '1' : db.prepare(`PRAGMA table_info("${m[1]}")`).all().some((c) => c.name === 'seq') ? 'seq DESC' : 'rowid DESC';
      const rows = db.prepare(`SELECT * FROM "${m[1]}" ORDER BY ${order} LIMIT ? OFFSET ?`).all(PAGE, p * PAGE);
      const link = (n, label) => `<a href="/t/${m[1]}?t=${TOKEN}&p=${n}">${label}</a>`;
      return send(200, page(`<h4>${esc(m[1])} <small>(${total} filas, más recientes primero)</small></h4><p>${p > 0 ? link(p - 1, '← nuevas') : ''} ${(p + 1) * PAGE < total ? link(p + 1, 'antiguas →') : ''}</p>${grid(rows, url)}`));
    }
    if (url.pathname === '/q') {
      const sql = url.searchParams.get('sql') ?? '';
      try { return send(200, page(grid(db.prepare(sql).all().slice(0, 500), url), sql)); }
      catch (e) { return send(200, page(`<p class="err">${esc(e.message)}</p>`, sql)); }
    }
    return send(404, 'no encontrado');
  } catch (e) { return send(500, esc(e.message)); }
});

// Si el puerto está ocupado por un visor anterior (p. ej. de una sesión SSH que se cortó), se cierra ese y se abre este.
// Solo se cierra un proceso que sea NUESTRO visor (db-web.js); cualquier otro programa no se toca.
const holderPid = () => {
  try { return Number(/pid=(\d+)/.exec(execFileSync('ss', ['-tlnpH', `sport = :${PORT}`], { encoding: 'utf8' }))?.[1]) || null; } catch { return null; }
};
const isOurViewer = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((x) => x.endsWith('db-web.js')); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tookOver = false;

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const pid = holderPid();
  if (tookOver || !pid || pid === process.pid || !isOurViewer(pid)) {
    console.error(`El puerto ${PORT} está ocupado por otro programa${pid ? ` (pid ${pid})` : ''}. No lo cierro porque no es el visor de datos.`);
    process.exit(1);
  }
  tookOver = true;
  console.log(`Había un visor anterior abierto (pid ${pid}); lo cierro y abro uno nuevo…`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30 && holderPid(); i++) await sleep(100);
  if (holderPid()) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya terminó */ } await sleep(300); }
  server.listen(PORT, '127.0.0.1');
});

server.on('listening', () => {
  touch();
  console.log(`Visor de solo lectura. Abre en tu equipo (con el túnel SSH activo):\n  http://127.0.0.1:${PORT}/?t=${TOKEN}\nCtrl+C para cerrar.`);
});
server.listen(PORT, '127.0.0.1');
