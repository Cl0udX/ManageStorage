// Frontend PWA. Todo dato de usuario se pinta con textContent (sin innerHTML → sin XSS).
import { IdbStore } from '../persistence/idb-store.js';
import { ApiClient, ApiError } from '../api/api-client.js';
import { SyncEngine } from '../sync/engine.js';
import { login, refreshToken, LocalAuthError } from '../auth/session.js';
import { weeklyReport, reportBetween, weekStart, addDays, salesByDay } from '../../domain/report.js';
import { PAYMENT_METHODS, RECORD_RETENTION_DAYS } from '../../shared/constants.js';
import { getClientInfo } from './client-info.js';
import { appConfig } from '../config.js';
import { checkClock } from '../clock.js';
import { protectStorage, shouldSuggestInstall } from '../storage-guard.js';

const $ = (id) => document.getElementById(id);
const store = new IdbStore();
const api = new ApiClient({
  getToken: async () => (await store.load()).meta.session?.token ?? null,
  getEpoch: async () => (await store.load()).meta.epoch ?? null,
  getClientInfo,
});
let engine = null;
let session = null;
let deviceId = null;
let sessionPassword = null; // solo en memoria: permite renovar el token solo cuando vuelve internet
let lastSyncOk = null;
let tab = 'sell';
let weekOffset = 0;
let clockBlocked = false;     // la hora/zona del equipo no es la correcta (con internet no se deja usar)
const weekCache = new Map(); // semanas más antiguas que lo guardado en el equipo, pedidas al servidor
let searchTerm = '';
let historyDays = 7;
const cart = new Map();

const money = (n) => new Intl.NumberFormat(appConfig.locale, { style: 'currency', currency: appConfig.currency, maximumFractionDigits: 0 }).format(n);
const METHOD_NAME = { 'pm-cash': 'Efectivo', 'pm-transfer': 'Transferencia', none: 'Sin indicar' };
const methodName = (id) => METHOD_NAME[id ?? 'none'] ?? 'Otro';
const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const FIELD = { name: 'nombre', price: 'precio de venta', cost: 'costo' };
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== '') e.append(k);
  return e;
};
const btn = (text, onclick, cls = '') => el('button', { type: 'button', textContent: text, onclick, className: cls });

// ---------- Diálogos ----------
function appendFields(form, fields) {
  for (const f of fields) {
    const input = el('input', {
      name: f.name, type: f.type ?? 'text', value: f.value ?? '', required: f.required !== false,
      ...(f.type === 'number' ? { min: f.min ?? 0, step: 1, inputMode: 'numeric' } : {}),
      ...(f.type === 'password' ? { autocomplete: 'current-password' } : {}),
    });
    form.append(el('label', {}, f.label, f.hint ? el('small', { textContent: f.hint }) : '', input));
  }
}
function readFields(form, fields) {
  const out = {};
  for (const f of fields) { const v = form.elements[f.name].value; out[f.name] = f.type === 'number' ? Number(v) : v.trim(); }
  return out;
}

function askForm(title, fields, submit = 'Guardar') {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const form = el('form');
    form.append(el('h3', { textContent: title }));
    appendFields(form, fields);
    form.append(el('div', { className: 'row' }, btn('Cancelar', () => dlg.close('cancel'), 'secondary'), el('button', { type: 'submit', textContent: submit })));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); dlg.close('ok'); });
    dlg.append(form);
    dlg.addEventListener('close', () => { const out = readFields(form, fields); dlg.remove(); resolve(dlg.returnValue === 'ok' ? out : null); });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input')?.focus();
  });
}

/** Diálogo con botones grandes de elección (p. ej. Efectivo / Transferencia). Devuelve {choice, ...campos} o null. */
function askChoice({ title, lines = [], total, hint, fields = [], choices }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const form = el('form');
    form.append(el('h3', { textContent: title }));
    if (lines.length) form.append(el('ul', { className: 'list' }, ...lines.map((t) => el('li', { textContent: t }))));
    if (total) form.append(el('p', { className: 'total', textContent: total }));
    appendFields(form, fields);
    if (hint) form.append(el('p', { className: 'muted', textContent: hint }));
    let chosen = null;
    // type="button": Enter nunca elige una forma de pago por accidente; se valida el formulario antes de aceptar.
    form.append(el('div', { className: 'choices' }, ...choices.map((c) => btn(c.label, () => { if (!form.reportValidity()) return; chosen = c.id; dlg.close('ok'); }, 'big'))));
    form.append(btn('Cancelar', () => dlg.close('cancel'), 'secondary'));
    form.addEventListener('submit', (ev) => ev.preventDefault());
    dlg.append(form);
    dlg.addEventListener('close', () => { const out = { ...readFields(form, fields), choice: chosen }; dlg.remove(); resolve(dlg.returnValue === 'ok' && chosen ? out : null); });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input')?.focus();
  });
}
const PAY_CHOICES = PAYMENT_METHODS.map((m) => ({ id: m.id, label: m.id === 'pm-cash' ? '💵 Efectivo' : '🏦 Transferencia' }));

let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}
const confirmBox = async (title, yes = 'Sí') => (await askForm(title, [], yes)) !== null;
const okInt = (n) => Number.isSafeInteger(n) && n >= 0;

// ---------- Arranque ----------
async function init() {
  if (!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches) document.documentElement.style.setProperty('--green', appConfig.themeColor);
  const { meta } = await store.load();
  deviceId = meta.device_id;
  if (!deviceId) { deviceId = crypto.randomUUID(); await store.setMeta({ device_id: deviceId }); }
  session = meta.session;
  protectStorage(); // pide almacenamiento persistente (evita que el navegador lo limpie)
  await enter();
  addEventListener('online', () => { guardClock(); autoSync(); });
  addEventListener('offline', () => render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { guardClock(); autoSync(); } });
  setInterval(guardClock, 5 * 60_000);
  setInterval(async () => {
    if (!engine) return;
    const st = await engine.stats();
    if (st.pending > 0 || st.status !== 'idle' || Date.now() - (lastSyncAt ?? 0) > 45_000) autoSync();
  }, 15_000);
  setupUpdates();
}

// ---------- Validación de hora ----------
// Con internet, el equipo debe tener fecha, hora y zona correctas (la zona la define el servidor: sirve para cualquier país).
// Si no, no se deja entrar ni seguir usando la app hasta corregirla. Sin internet no se puede comprobar: se comprueba al volver.
async function guardClock() {
  if (!navigator.onLine) return true;
  let r;
  try { r = await checkClock(api); } catch { return true; } // si el servidor no responde bien, no se bloquea a nadie
  if (!r.ok) { showClockBlock(r); return false; }
  if (clockBlocked) { clockBlocked = false; $('clock-view').hidden = true; resume(); }
  return true;
}

function showClockBlock(r) {
  clockBlocked = true;
  $('login-view').hidden = true; $('app-view').hidden = true; $('clock-view').hidden = false;
  const span = (ms) => { const m = Math.round(Math.abs(ms) / 60_000); return m >= 120 ? `${Math.round(m / 60)} horas` : `${m} minutos`; };
  const real = new Date(r.serverNow).toLocaleString(navigator.language, { timeZone: r.serverTz, dateStyle: 'full', timeStyle: 'short' });
  $('clock-msg').textContent = r.reason === 'clock'
    ? `La hora de este equipo está ${span(r.skewMs)} ${r.skewMs > 0 ? 'adelantada' : 'atrasada'}. La hora correcta es: ${real} (${r.serverTz}).`
    : `La zona horaria de este equipo no es la del negocio (${r.serverTz}). La hora correcta es: ${real}.`;
}

function resume() { if (engine) { $('app-view').hidden = false; autoSync(); } else if (session) startEngine(); else showLogin(); }

async function enter() {
  const wasBlocked = clockBlocked;
  // Si el servidor tarda en dar la hora (red lenta), no se hace esperar a la persona: se abre y se sigue comprobando por detrás.
  const ok = await Promise.race([guardClock(), new Promise((r) => setTimeout(() => r('slow'), 3000))]);
  if ((ok === true || ok === 'slow') && !wasBlocked) resume();
}

// ---------- Instalación (protege los datos en iPhone/iPad) ----------
async function maybeInstallHint() {
  if (!shouldSuggestInstall()) return;
  const { meta } = await store.load();
  if (meta.install_hint_at && Date.now() - meta.install_hint_at < 86_400_000) return; // una vez al día como máximo
  const b = $('install-banner');
  b.replaceChildren('Para que tus datos no se borren, instala la app: toca el botón Compartir (el cuadrado con una flecha) y elige "Agregar a pantalla de inicio". ',
    btn('Entendido', async () => { b.hidden = true; await store.setMeta({ install_hint_at: Date.now() }); }, 'small'));
  b.hidden = false;
}

// ---------- Actualización de la app ----------
// El Service Worker instala la versión nueva en segundo plano (paquete completo). Aquí decidimos CUÁNDO activarla:
// nunca a mitad de una venta o con un diálogo abierto. Los datos no se tocan: viven en IndexedDB.
let swReg = null;
let waitingWorker = null;
let reloading = false;
const safeToReload = () => cart.size === 0 && !document.querySelector('dialog[open]');

function applyUpdate() {
  if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  else checkForUpdate();
}

function showUpdateBanner() {
  const b = $('update-banner');
  b.replaceChildren('Hay una versión nueva de la app. ', btn('Actualizar ahora', applyUpdate, 'small'));
  b.hidden = false;
}

function onUpdateReady(worker) {
  waitingWorker = worker;
  if (safeToReload()) applyUpdate(); else showUpdateBanner();
}

function checkForUpdate() { swReg?.update().catch(() => {}); } // sin internet falla en silencio: se reintenta luego

async function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller; // false en la primera instalación: no recargar
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  try { swReg = await navigator.serviceWorker.register('/sw.js'); } catch (e) { console.warn('SW', e); return; }
  if (swReg.waiting && hadController) onUpdateReady(swReg.waiting);
  swReg.addEventListener('updatefound', () => {
    const w = swReg.installing;
    w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady(w); });
  });
  checkForUpdate();
  setInterval(checkForUpdate, 15 * 60_000);
  addEventListener('online', checkForUpdate);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkForUpdate();
    if (waitingWorker && safeToReload()) applyUpdate();
  });
}

function showLogin() { $('login-view').hidden = false; $('app-view').hidden = true; }

async function startEngine() {
  const mine = new SyncEngine({ store, api, deviceId, userId: session.user.id, onChange: () => render().catch(console.error) });
  engine = mine;
  $('login-notice').hidden = true;
  $('who').textContent = `Sesión: ${session.user.username} · ${session.org.name}`;
  const first = autoSync();
  // Con internet se espera (máx. 2,5 s) a que el servidor confirme la sesión ANTES de enseñar datos locales:
  // si la sesión ya no vale, se va directo al login y no se trabaja con información vieja. Sin internet, se abre al instante.
  if (navigator.onLine) await Promise.race([first, new Promise((r) => setTimeout(r, 2500))]);
  if (engine !== mine) return; // mientras tanto se pidió volver a iniciar sesión
  $('login-view').hidden = true; $('app-view').hidden = false;
  render().catch(console.error);
  maybeInstallHint();
}

/** Con internet, si el servidor rechaza la sesión: al login. Lo pendiente sigue guardado y se envía al entrar. */
function requireLogin() {
  const user = session?.user?.username ?? '';
  engine = null; session = null; sessionPassword = null; cart.clear();
  showLogin();
  $('login-form').elements.username.value = user;
  $('login-error').textContent = '';
  $('login-notice').hidden = false;
}

// ---------- Sincronización automática ----------
let lastSyncAt = null;
async function autoSync() {
  if (!engine || clockBlocked) return;
  if (!navigator.onLine) { lastSyncOk = false; return render(); }
  let r = await engine.sync();
  if (r.status === 'auth_required' && sessionPassword) {
    try { session = await refreshToken({ api, store, username: session.user.username, password: sessionPassword, deviceId, deviceName: '' }); r = await engine.sync(); }
    catch { /* si no se pudo renovar sola, se pide iniciar sesión */ }
  }
  if (r.status === 'auth_required') return requireLogin();
  lastSyncOk = r.ok; lastSyncAt = Date.now();
  if (engine.lastHeal) { engine.lastHeal = null; toast('Se actualizaron datos desde el servidor ✓'); }
  if (engine.lastReset) {
    const n = engine.lastReset.kept; engine.lastReset = null; cart.clear();
    toast(n ? `Se actualizó la base de datos. Tus ${n} cambios sin enviar se conservaron y se están enviando.` : 'Se actualizó la base de datos: datos nuevos descargados.');
  }
  await render();
}

// ---------- Pintar ----------
async function render() {
  if (!engine) return;
  const view = await engine.getView();
  const st = await engine.stats();
  renderStatus(st);
  renderSell(view);
  renderHistory(view);
  renderProducts(view, st);
  renderProfit(view);
}

function renderStatus(st) {
  const s = $('status');
  const offline = !navigator.onLine || st.status === 'offline';
  if (st.status === 'revoked') { s.textContent = '⛔ Este equipo fue desactivado'; s.className = 'status bad'; }
  else if (st.pending > 0) { s.textContent = `⏳ ${st.pending} ${st.pending === 1 ? 'cambio espera' : 'cambios esperan'} internet`; s.className = 'status wait'; }
  else if (offline) { s.textContent = '📴 Sin internet · todo guardado aquí'; s.className = 'status wait'; }
  else { s.textContent = '✓ Todo guardado'; s.className = 'status ok'; }

  const b = $('banner');
  b.replaceChildren();
  b.hidden = true;
  if (st.status === 'revoked') {
    b.hidden = false; b.textContent = 'Este equipo ya no tiene permiso para sincronizar. Tus datos siguen guardados aquí; habla con el administrador.';
  } else if (st.status === 'update_required') {
    b.hidden = false;
    b.append('Tu app es muy vieja para hablar con el servidor. Tus datos están guardados. ', btn('Actualizar', applyUpdate, 'small'));
  } else if (st.status === 'error') {
    b.hidden = false; b.textContent = 'No se pudo sincronizar. Seguimos intentando; tus datos están guardados.';
  }
}

const activeProducts = (view) => Object.values(view.entities.product).filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name, appConfig.locale));
const productName = (view, id) => view.entities.product[id]?.name ?? 'Producto';

function renderSell(view) {
  const list = $('sell-list'); list.replaceChildren();
  const all = activeProducts(view);
  const q = norm(searchTerm.trim());
  const products = q ? all.filter((p) => norm(p.name).includes(q)) : all;
  if (!all.length) list.append(el('p', { className: 'muted', textContent: 'Todavía no hay productos. Ve a "Productos" y agrega el primero.' }));
  else if (!products.length) list.append(el('p', { className: 'muted', textContent: `No encontré "${searchTerm.trim()}".` }));

  // El total cuenta TODO el carrito, aunque el buscador esté filtrando.
  let total = 0, units = 0;
  for (const [id, qty] of [...cart]) {
    const p = view.entities.product[id];
    if (!p || p.archived) { cart.delete(id); continue; }
    total += qty * p.price; units += qty;
  }
  for (const p of products) {
    const qty = cart.get(p.id) ?? 0;
    const stock = view.stock[p.id] ?? 0;
    const bump = (d) => { const n = Math.max(0, (cart.get(p.id) ?? 0) + d); if (n) cart.set(p.id, n); else cart.delete(p.id); render(); };
    list.append(el('div', { className: `card ${stock <= 0 ? 'low' : ''}` },
      el('div', {}, el('div', { className: 'name', textContent: p.name }),
        el('div', { className: 'meta' }, `${money(p.price)} · Quedan `, el('span', { className: 'qty', textContent: String(stock) }))),
      el('div', { className: 'stepper' }, btn('−', () => bump(-1), 'secondary'), el('output', { textContent: String(qty) }), btn('+', () => bump(1)))));
  }
  $('checkout').hidden = units === 0;
  $('cart-total').textContent = money(total);
}

function dayLabel(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - date) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return date.toLocaleDateString(appConfig.locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderHistory(view) {
  const box = $('history'); box.replaceChildren();
  const days = salesByDay(Object.values(view.records));
  if (!days.length) box.append(el('p', { className: 'muted', textContent: 'Aún no hay ventas.' }));
  for (const d of days.slice(0, historyDays)) {
    const parts = Object.entries(d.byMethod).map(([m, v]) => `${methodName(m)} ${money(v)}`).join(' · ');
    box.append(el('div', { className: 'dayhead' }, el('strong', { textContent: dayLabel(d.date) }), el('span', { className: 'muted', textContent: ` · ${money(d.total)}${parts ? ` (${parts})` : ''}` })));
    const ul = el('ul', { className: 'list' });
    for (const r of d.sales) {
      const hour = new Date(r.created_at).toLocaleTimeString(appConfig.locale, { hour: 'numeric', minute: '2-digit' });
      const what = r.lines.map((l) => `${l.qty} × ${productName(view, l.product_id)}`).join(', ');
      ul.append(el('li', {},
        el('span', { className: r.voided ? 'void' : '' }, `${hour} · ${what} · ${money(r.amount)}`,
          el('span', { className: 'badge', textContent: methodName(r.payment_method_id) }), r.pending ? el('span', { className: 'tag', textContent: ' ⏳' }) : ''),
        r.voided ? el('span', { className: 'muted', textContent: 'Anulada' }) : btn('Anular', () => voidRecord(r, 'esta venta'), 'secondary small')));
    }
    box.append(ul);
  }
  $('history-more').hidden = days.length <= historyDays;
  if (days.length <= historyDays && view.coverage?.records_since) box.append(el('p', { className: 'muted', textContent: `Aquí se ven las ventas de los últimos ${RECORD_RETENTION_DAYS} días. Las semanas anteriores se consultan en Ganancias.` }));
}

function renderProducts(view, st) {
  const list = $('product-list'); list.replaceChildren();
  for (const p of activeProducts(view)) {
    const stock = view.stock[p.id] ?? 0;
    list.append(el('div', { className: `card ${stock <= 0 ? 'low' : ''}` },
      el('div', {}, el('div', { className: 'name' }, p.name, p.pending ? el('span', { className: 'tag', textContent: ' ⏳' }) : ''),
        el('div', { className: 'meta' }, `Nos cuesta ${money(p.cost ?? 0)} · Vendemos ${money(p.price)} · Quedan `, el('span', { className: 'qty', textContent: String(stock) }))),
      el('div', { className: 'actions' },
        btn('Llegó mercancía', () => restock(p), 'small'),
        btn('Cambiar', () => editProduct(p), 'secondary small'),
        btn('Corregir cantidad', () => fixQuantity(p, stock), 'secondary small'),
        btn('Quitar', () => removeProduct(p), 'secondary small'))));
  }

  const open = Object.values(view.conflicts).filter((c) => c.status === 'open');
  $('conflicts-box').hidden = open.length === 0;
  const cl = $('conflicts'); cl.replaceChildren();
  const fmt = (c, v) => (c.field === 'name' ? String(v) : money(v));
  for (const c of open) {
    const li = el('li', {}, el('span', { textContent: `${productName(view, c.entity_id)} · ${FIELD[c.field] ?? c.field}: ahora ${fmt(c, c.server_value)}, otro equipo puso ${fmt(c, c.client_value)}` }));
    if (session?.user.role === 'owner') {
      li.append(el('span', { className: 'actions' }, btn(`Dejar ${fmt(c, c.server_value)}`, () => resolve(c.id, 'server'), 'secondary small'), btn(`Usar ${fmt(c, c.client_value)}`, () => resolve(c.id, 'client'), 'small')));
    }
    cl.append(li);
  }

  $('rejected-box').hidden = st.rejected.length === 0;
  const rl = $('rejected'); rl.replaceChildren();
  for (const o of st.rejected) {
    rl.append(el('li', {}, el('span', { textContent: `No se pudo guardar un movimiento (${o.reason}).` }), btn('Descartar', () => engine.dismissRejected(o.op_id), 'secondary small')));
  }
}

function weekRange() {
  const start = addDays(weekStart(new Date()), weekOffset * 7);
  return { start, end: addDays(start, 6) };
}

function renderProfit(view) {
  const { start, end } = weekRange();
  const d = (x) => x.toLocaleDateString(appConfig.locale, { day: 'numeric', month: 'short' });
  $('week-label').textContent = weekOffset === 0 ? `Esta semana (${d(start)} – ${d(end)})` : `Semana del ${d(start)} al ${d(end)}`;
  $('week-next').disabled = weekOffset >= 0;

  const records = Object.values(view.records);
  // Este equipo guarda los últimos RECORD_RETENTION_DAYS días. Una semana anterior se calcula en el servidor (exacto).
  const since = view.coverage?.records_since;
  const fromServer = !!since && start < new Date(since);
  const weekEnd = addDays(start, 7);
  let r, weekExpenses, note = null;
  if (fromServer) {
    const key = start.toISOString(); const hit = weekCache.get(key);
    weekExpenses = [];
    if (hit && !hit.loading && !hit.error) { r = { ...hit.report, start, end: weekEnd }; weekExpenses = hit.expenses; }
    else {
      r = reportBetween([], start, weekEnd);
      if (!hit && navigator.onLine) {
        weekCache.set(key, { loading: true });
        api.weekReport(start.toISOString(), weekEnd.toISOString()).then((res) => weekCache.set(key, res)).catch(() => weekCache.set(key, { error: true })).finally(() => render());
        note = 'Cargando esta semana…';
      } else note = hit?.loading ? 'Cargando esta semana…' : 'Esta semana es anterior a lo que guarda este equipo. Conéctate a internet para verla.';
    }
  } else {
    r = weeklyReport(records, start);
    weekExpenses = records.filter((x) => x.kind === 'expense' && new Date(x.created_at) >= start && new Date(x.created_at) < weekEnd);
  }
  const box = $('profit-cards'); box.replaceChildren();
  if (note) box.append(el('p', { className: 'muted', textContent: note }));
  const stat = (label, value, cls = '') => el('div', { className: `stat ${cls}` }, el('span', { textContent: label }), el('b', { className: value < 0 ? 'neg' : '', textContent: money(value) }));
  box.append(stat('Ganancia de la semana', r.net, 'main'), stat('Vendimos', r.sales), stat('Nos costó lo vendido', r.cogs), stat('Ganancia de las ventas', r.gross), stat('Gastos', r.expenses));
  if (r.purchases) box.append(el('p', { className: 'muted', textContent: `Compraste mercancía por ${money(r.purchases)}. No se resta aquí: ya cuenta en "lo que nos costó" cuando la vendes.` }));

  const mbox = $('money-cards'); mbox.replaceChildren();
  const net = (id) => { const m = r.byMethod[id] ?? { in: 0, out: 0 }; return m.in - m.out; };
  const detail = (id) => { const m = r.byMethod[id] ?? { in: 0, out: 0 }; return `entró ${money(m.in)} · salió ${money(m.out)}`; };
  for (const pm of PAYMENT_METHODS) {
    mbox.append(el('div', { className: 'stat' }, el('span', { textContent: pm.id === 'pm-cash' ? '💵 Efectivo' : '🏦 Transferencias' }),
      el('b', { className: net(pm.id) < 0 ? 'neg' : '', textContent: money(net(pm.id)) }), el('span', { textContent: detail(pm.id) })));
  }
  if (r.byMethod.none) mbox.append(el('div', { className: 'stat' }, el('span', { textContent: 'Sin indicar' }), el('b', { textContent: money(net('none')) }), el('span', { textContent: detail('none') })));
  mbox.append(el('p', { className: 'muted', textContent: 'Entra con las ventas; sale con los gastos y la mercancía que pagaste. Solo cuenta lo anotado esta semana: no incluye plata que ya tenían antes.' }));

  const tb = $('profit-products'); tb.replaceChildren();
  for (const p of r.byProduct) tb.append(el('tr', {}, el('td', { textContent: productName(view, p.product_id) }), el('td', { className: 'num', textContent: String(p.qty) }), el('td', { className: 'num', textContent: money(p.profit) })));
  if (!r.byProduct.length) tb.append(el('tr', {}, el('td', { colSpan: 3, className: 'muted', textContent: 'Sin ventas esta semana.' })));

  const ex = $('expenses'); ex.replaceChildren();
  const inWeek = [...weekExpenses].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const x of inWeek) {
    ex.append(el('li', {}, el('span', { className: x.voided ? 'void' : '', textContent: `${x.note} · ${money(x.amount)}` }),
      x.voided ? el('span', { className: 'muted', textContent: 'Anulado' }) : fromServer ? '' : btn('Anular', () => voidRecord(x, 'este gasto'), 'secondary small')));
  }
  if (!inWeek.length) ex.append(el('li', { className: 'muted', textContent: 'Sin gastos esta semana.' }));
}

// ---------- Acciones ----------
async function run(fn) { await fn(); autoSync(); }

async function voidRecord(r, label) {
  if (await confirmBox(`¿Anular ${label}? El stock se corrige solo.`, 'Sí, anular')) await run(() => engine.voidOp(r.op_id, 'anulada desde la app'));
}

async function restock(p) {
  const v = await askChoice({
    title: `Llegó mercancía: ${p.name}`, fields: [{ name: 'qty', label: '¿Cuántas unidades llegaron?', type: 'number', min: 1 }],
    hint: `Se paga a ${money(p.cost ?? 0)} c/u. ¿Cómo se pagó?`, choices: PAY_CHOICES,
  });
  if (v && v.qty >= 1 && okInt(v.qty)) await run(() => engine.restock(p.id, v.qty, { payment_method_id: v.choice }));
}

async function fixQuantity(p, current) {
  const v = await askForm(`Corregir cantidad: ${p.name}`, [{ name: 'qty', label: '¿Cuántas hay realmente?', type: 'number', value: current, hint: `Ahora dice ${current}.` }], 'Corregir');
  if (v && okInt(v.qty)) await run(() => engine.setQuantity(p.id, v.qty, 'conteo'));
}

async function removeProduct(p) {
  if (await confirmBox(`¿Quitar "${p.name}" de la lista? Las ventas pasadas se conservan.`, 'Sí, quitar')) await run(() => engine.updateEntity('product', p.id, { archived: true }));
}

async function editProduct(p) {
  const v = await askForm(`Cambiar: ${p.name}`, [
    { name: 'name', label: 'Nombre', value: p.name },
    { name: 'cost', label: 'A cómo nos sale (costo)', type: 'number', value: p.cost ?? 0 },
    { name: 'price', label: 'A cómo lo vendemos (precio)', type: 'number', value: p.price },
  ]);
  if (!v || !v.name || !okInt(v.cost) || !okInt(v.price)) return;
  const changes = {};
  if (v.name !== p.name) changes.name = v.name;
  if (v.cost !== (p.cost ?? 0)) changes.cost = v.cost;
  if (v.price !== p.price) changes.price = v.price;
  if (Object.keys(changes).length) await run(() => engine.updateEntity('product', p.id, changes));
}

async function resolve(id, choice) {
  try { await api.resolveConflict(id, choice); await engine.sync(); } catch { alert('No se pudo guardar la elección. Revisa tu conexión.'); }
}

async function addProduct() {
  const v = await askForm('Agregar producto', [
    { name: 'name', label: 'Nombre' },
    { name: 'cost', label: 'A cómo nos sale (costo)', type: 'number' },
    { name: 'price', label: 'A cómo lo vendemos (precio)', type: 'number' },
    { name: 'qty', label: 'Cantidad que tenemos', type: 'number', value: 0 },
  ], 'Agregar');
  if (!v || !v.name || !okInt(v.cost) || !okInt(v.price) || !okInt(v.qty)) return;
  const { id } = await engine.createEntity('product', { name: v.name, cost: v.cost, price: v.price });
  if (v.qty > 0) await engine.adjustStock(id, v.qty, 'inventario inicial');
  autoSync();
}

async function addExpense() {
  const v = await askChoice({
    title: 'Anotar un gasto', fields: [{ name: 'description', label: '¿En qué se gastó?' }, { name: 'amount', label: 'Valor', type: 'number', min: 1 }],
    hint: '¿Cómo se pagó?', choices: PAY_CHOICES,
  });
  if (v && v.description && okInt(v.amount) && v.amount > 0) await run(() => engine.expense(v.amount, v.description, { payment_method_id: v.choice }));
}

// ---------- Eventos ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  for (const t of ['sell', 'history', 'products', 'profit']) $(`tab-${t}`).hidden = t !== tab;
  $('checkout').style.display = tab === 'sell' ? '' : 'none';
}));
$('add-product').addEventListener('click', addProduct);
$('add-expense').addEventListener('click', addExpense);
const retryWeek = () => { for (const [k, v] of weekCache) if (v.error) weekCache.delete(k); };
$('week-prev').addEventListener('click', () => { weekOffset -= 1; retryWeek(); render(); });
$('week-next').addEventListener('click', () => { if (weekOffset < 0) { weekOffset += 1; retryWeek(); render(); } });
$('sync-btn').addEventListener('click', () => autoSync());
$('clock-retry').addEventListener('click', () => guardClock());
$('cart-clear').addEventListener('click', () => { cart.clear(); render(); });
$('search').addEventListener('input', (ev) => { searchTerm = ev.target.value; render(); });
$('history-more').addEventListener('click', () => { historyDays += 7; render(); });
$('cart-pay').addEventListener('click', async () => {
  const view = await engine.getView();
  const items = [...cart].filter(([id]) => view.entities.product[id]).map(([product_id, qty]) => ({ product_id, qty }));
  if (!items.length) return;
  const price = (i) => view.entities.product[i.product_id].price;
  const total = items.reduce((sum, i) => sum + i.qty * price(i), 0);
  const v = await askChoice({
    title: 'Confirmar venta',
    lines: items.map((i) => `${i.qty} × ${view.entities.product[i.product_id].name} — ${money(i.qty * price(i))}`),
    total: `Total: ${money(total)}`, hint: '¿Cómo pagaron?', choices: PAY_CHOICES,
  });
  if (!v) return; // cancelado: el carrito queda como estaba
  cart.clear(); searchTerm = ''; $('search').value = '';
  await run(() => engine.sellProducts(items, { payment_method_id: v.choice }));
  toast(`Venta guardada ✓ ${methodName(v.choice)}`);
});

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const username = String(f.get('username')).trim(); const password = String(f.get('password'));
  $('login-error').textContent = '';
  if (!(await guardClock())) return; // hora incorrecta: no se envían credenciales ni se entra
  try {
    const r = await login({ api, store, username, password, deviceId, deviceName: '', isOnline: () => navigator.onLine });
    session = r.session; sessionPassword = password;
    ev.target.reset();
    startEngine();
  } catch (e) {
    $('login-error').textContent =
      e instanceof LocalAuthError && e.code === 'first_login_needs_internet' ? 'Es la primera vez en este equipo: conéctate a internet para entrar.'
      : (e instanceof LocalAuthError || (e instanceof ApiError && e.status === 401)) ? 'Usuario o contraseña incorrectos.'
      : e instanceof ApiError && e.code === 'device_revoked' ? 'Este equipo fue desactivado.'
      : e instanceof ApiError && e.status === 429 ? 'Demasiados intentos. Espera unos minutos.'
      : 'No se pudo entrar. Intenta otra vez.';
  }
});

$('logout-btn').addEventListener('click', async () => {
  const st = await engine.stats();
  const msg = st.pending ? `Hay ${st.pending} cambios sin enviar. Se quedan guardados en este equipo. ¿Cerrar sesión?` : '¿Cerrar sesión?';
  if (!(await confirmBox(msg, 'Cerrar sesión'))) return;
  try { if (navigator.onLine) await api.logout(); } catch { /* la sesión caduca sola */ }
  await store.setMeta({ session: null });
  session = null; engine = null; sessionPassword = null; cart.clear();
  showLogin();
});

init().catch((e) => { console.error(e); showLogin(); });
