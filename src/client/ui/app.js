// Frontend PWA. Todo dato de usuario se pinta con textContent (sin innerHTML → sin XSS).
import { IdbStore } from '../persistence/idb-store.js';
import { ApiClient, ApiError } from '../api/api-client.js';
import { SyncEngine } from '../sync/engine.js';
import { login, refreshToken, LocalAuthError } from '../auth/session.js';
import { weeklyReport, reportBetween, weekStart, addDays, recordsByDay, periodRange, inRange } from '../../domain/report.js';
import { PAYMENT_METHODS, RECORD_RETENTION_DAYS } from '../../shared/constants.js';
import { getClientInfo } from './client-info.js';
import { appConfig } from '../config.js';
import { weightedAverageCost } from '../../domain/state.js';
import { CONFIRM_WORD, isConfirmation } from './confirm.js';
import { checkClock } from '../clock.js';
import { protectStorage, shouldSuggestInstall } from '../storage-guard.js';

// SIN ZOOM: iOS Safari manda el pellizco como eventos "gesture*"; se cancelan (junto con el viewport y touch-action del CSS).
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });

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
let historyDays = 14;
const cart = new Map();
let productSearch = '';      // buscador de la pestaña Productos
let expandedProduct = null;  // producto con sus acciones desplegadas (uno a la vez)
let currentView = null; // última vista pintada (para actualizar el total sin redibujar la lista)

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
      name: f.name, type: f.type ?? 'text', value: f.value ?? '', required: f.required !== false, readOnly: !!f.readonly,
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
/** Confirmación ESCRITA: el botón queda apagado hasta que la persona escriba "confirmar". Para Anular y Quitar. */
function confirmTyped({ title, detail, action }) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const form = el('form');
    form.append(el('h3', { textContent: title }), el('p', { textContent: detail }));
    const input = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, placeholder: CONFIRM_WORD });
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', `Escribe ${CONFIRM_WORD} para continuar`);
    form.append(el('label', {}, `Para continuar, escribe "${CONFIRM_WORD}"`, input));
    const go = el('button', { type: 'submit', textContent: action, className: 'danger', disabled: true });
    input.addEventListener('input', () => { go.disabled = !isConfirmation(input.value); });
    form.append(el('div', { className: 'row' }, btn('Cancelar', () => dlg.close('cancel'), 'secondary'), go));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); if (isConfirmation(input.value)) dlg.close('ok'); });
    dlg.append(form);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok'); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}
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
  currentView = view;
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

function cartTotals(view) {
  let total = 0, units = 0;
  for (const [id, qty] of [...cart]) {
    const p = view.entities.product[id];
    if (!p || p.archived) { cart.delete(id); continue; }
    total += qty * p.price; units += qty;
  }
  return { total, units };
}

/** Solo la barra de Total/Borrar/Cobrar (sin redibujar la lista: así no se cierra el teclado mientras escriben). */
function updateCheckout(view = currentView) {
  if (!view) return;
  const { total, units } = cartTotals(view);
  $('checkout').hidden = units === 0;
  $('cart-total').textContent = money(total);
}

const setCart = (id, n) => { if (n > 0) cart.set(id, n); else cart.delete(id); };

function renderSell(view) {
  const list = $('sell-list');
  // Si la persona está escribiendo una cantidad, no se redibuja la lista (se cerraría el teclado): solo se actualiza el total.
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return updateCheckout(view);
  list.replaceChildren();
  const all = activeProducts(view);
  const q = norm(searchTerm.trim());
  const products = q ? all.filter((p) => norm(p.name).includes(q)) : all;
  if (!all.length) list.append(el('p', { className: 'muted', textContent: 'Todavía no hay productos. Ve a "Productos" y agrega el primero.' }));
  else if (!products.length) list.append(el('p', { className: 'muted', textContent: `No encontré "${searchTerm.trim()}".` }));

  updateCheckout(view); // el total cuenta TODO el carrito, aunque el buscador esté filtrando
  for (const p of products) {
    const qty = cart.get(p.id) ?? 0;
    const stock = view.stock[p.id] ?? 0;
    const bump = (d) => { setCart(p.id, Math.max(0, (cart.get(p.id) ?? 0) + d)); render(); };
    // La cantidad se puede ESCRIBIR (no hace falta tocar + muchas veces); + y − siguen funcionando.
    const input = el('input', { className: 'qty-input', type: 'number', inputMode: 'numeric', min: 0, step: 1, value: String(qty) });
    input.setAttribute('aria-label', `Cantidad de ${p.name}`);
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => { const n = Number.parseInt(input.value, 10); setCart(p.id, Number.isSafeInteger(n) && n > 0 ? n : 0); updateCheckout(); });
    input.addEventListener('blur', () => { input.value = String(cart.get(p.id) ?? 0); });
    list.append(el('div', { className: `card sellcard ${stock <= 0 ? 'low' : ''}` },
      el('div', { className: 'sell-text' }, el('div', { className: 'name', textContent: p.name, title: p.name }),
        el('div', { className: 'meta' }, `${money(p.price)} · Quedan `, el('span', { className: 'qty', textContent: String(stock) }))),
      el('div', { className: 'stepper' }, btn('−', () => bump(-1), 'secondary'), input, btn('+', () => bump(1)))));
  }
}

function dayLabel(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - date) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return date.toLocaleDateString(appConfig.locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

// Filtros del historial: tipo, período, forma de pago y texto.
//   sale = ventas · merch = mercancía (compras + inventario inicial + ajustes/conteos) · expense = gastos
let historyKind = 'sale';
let historyPeriod = 'week'; // today | yesterday | week | month | all | YYYY-MM-DD
let historyMethod = 'all';
let historySearch = '';
const KIND_RECORDS = { sale: ['sale'], merch: ['purchase', 'adjustment'], expense: ['expense'] };
const KIND_NOUN = { sale: ['venta', 'ventas'], merch: ['movimiento', 'movimientos'], expense: ['gasto', 'gastos'] };
const hourOf = (r) => new Date(r.created_at).toLocaleTimeString(appConfig.locale, { hour: 'numeric', minute: '2-digit' });
const adjustLabel = (r) => { const n = (r.note ?? '').toLowerCase(); return n === 'inventario inicial' ? 'Inventario inicial' : n === 'conteo' ? 'Conteo' : r.note || 'Ajuste'; };
const shortDate = (d) => d.toLocaleDateString(appConfig.locale, { day: 'numeric', month: 'short' });

function periodLabel() {
  const r = periodRange(historyPeriod);
  switch (historyPeriod) {
    case 'today': return 'Hoy';
    case 'yesterday': return 'Ayer';
    case 'week': return `Semana del ${shortDate(r.from)} al ${shortDate(addDays(r.to, -1))}`;
    case 'month': return r.from.toLocaleDateString(appConfig.locale, { month: 'long', year: 'numeric' });
    case 'all': return 'Todo lo guardado en este equipo';
    default: return r.from.toLocaleDateString(appConfig.locale, { weekday: 'long', day: 'numeric', month: 'long' });
  }
}

function historyCard(view, r) {
  const adj = r.kind === 'adjustment';
  const delta = adj ? r.lines[0].delta : 0;
  const units = r.lines.reduce((sum, l) => sum + (adj ? Math.abs(l.delta) : l.qty), 0);
  const label = { sale: 'esta venta', purchase: 'esta compra', adjustment: 'este movimiento', expense: 'este gasto' }[r.kind];
  const single = r.lines.length === 1;
  const actions = r.voided ? el('span', { className: 'muted', textContent: 'Anulada' }) : el('span', { className: 'actions' },
    (r.kind === 'purchase' || adj) && single ? btn('Corregir', () => (adj ? correctAdjustmentDialog(r) : correctPurchaseDialog(r)), 'secondary small') : '',
    btn('Anular', () => voidRecord(r, label), 'secondary small'));
  const headline = adj ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)} unidades` : money(r.amount);
  const tag = adj ? adjustLabel(r) : r.kind === 'purchase' ? `Compra · ${methodName(r.payment_method_id)}` : methodName(r.payment_method_id);
  const head = el('div', { className: 'sale-head' },
    el('span', { className: r.voided ? 'void' : '' }, el('strong', { textContent: hourOf(r) }), ' · ', el('strong', { textContent: headline }),
      el('span', { className: 'badge', textContent: tag }), r.pending ? el('span', { className: 'tag', textContent: ' ⏳' }) : ''), actions);
  let body;
  if (r.kind === 'expense') body = el('div', { className: `sale-items ${r.voided ? 'void' : ''}` }, el('div', { className: 'line' }, el('span', { className: 'what', textContent: r.note || 'Gasto' })));
  else if (adj) body = el('div', { className: `sale-items ${r.voided ? 'void' : ''}` }, ...r.lines.map((l) => el('div', { className: 'line' },
    el('span', { className: 'what', textContent: `${l.delta > 0 ? '+' : '−'}${Math.abs(l.delta)} × ${productName(view, l.product_id)}` }),
    el('span', { className: 'muted', textContent: l.unit_cost !== undefined ? `${money(l.unit_cost)} c/u · ${money(Math.abs(l.delta) * l.unit_cost)}` : l.delta > 0 ? 'entran al inventario' : 'salen del inventario' }))));
  else {
    // Cada producto en SU línea: así una venta con muchos productos se lee completa.
    const price = r.kind === 'purchase' ? 'unit_cost' : 'unit_price';
    body = el('div', { className: `sale-items ${r.voided ? 'void' : ''}` }, ...r.lines.map((l) => el('div', { className: 'line' },
      el('span', { className: 'what', textContent: `${l.qty} × ${productName(view, l.product_id)}` }),
      el('span', { className: 'muted', textContent: `${money(l[price])} c/u · ${money(l.qty * l[price])}` }))));
  }
  const notes = [];
  if (r.kind === 'purchase' || adj) for (const l of r.lines) if (l.cost_before !== undefined && l.cost_before !== l.cost_after) notes.push(el('div', { className: 'sale-note', textContent: `Costo de ${productName(view, l.product_id)}: ${money(l.cost_before)} → ${money(l.cost_after)}` }));
  const foot = r.lines.length > 1 ? el('div', { className: 'sale-foot', textContent: `${r.lines.length} productos · ${units} unidades` }) : '';
  return el('li', { className: `sale ${r.kind === 'sale' && single ? 'small' : ''}` }, head, body, ...notes, foot);
}

function renderHistory(view) {
  const box = $('history'); box.replaceChildren();
  document.querySelectorAll('#history-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === historyKind));
  const custom = /^\d{4}-\d{2}-\d{2}$/.test(historyPeriod);
  document.querySelectorAll('#history-period button').forEach((b) => b.classList.toggle('active', !custom && b.dataset.period === historyPeriod));
  $('history-daychip').classList.toggle('active', custom);
  $('history-day-label').textContent = custom ? ` ${shortDate(periodRange(historyPeriod).from)}` : '';
  $('history-search').placeholder = historyKind === 'expense' ? '🔍 Buscar un gasto…' : '🔍 Buscar un producto…';

  // Filtros activos, SIEMPRE visibles (con ✕ para quitarlos): al pasar de una pestaña a otra el filtro se conserva y, sin esto,
  // parecería que "se perdieron los datos".
  const bar = $('history-active'); bar.replaceChildren();
  const fchip = (text, onClear) => { const b = el('button', { type: 'button', className: 'fchip', textContent: `${text}  ✕`, onclick: onClear }); b.setAttribute('aria-label', `Quitar el filtro ${text}`); return b; };
  const clearSearch = () => { historySearch = ''; $('history-search').value = ''; render(); };
  const clearMethod = () => { historyMethod = 'all'; $('history-method').value = 'all'; render(); };
  const chips = [];
  if (historySearch.trim()) chips.push(fchip(`🔍 “${historySearch.trim()}”`, clearSearch));
  if (historyMethod !== 'all') chips.push(fchip(historyMethod === 'pm-cash' ? '💵 Efectivo' : '🏦 Transferencia', clearMethod));
  bar.hidden = chips.length === 0;
  if (chips.length) bar.append(el('span', { className: 'muted', textContent: 'Mostrando solo:' }), ...chips,
    chips.length > 1 ? btn('Quitar todos', () => { historySearch = ''; historyMethod = 'all'; $('history-search').value = ''; $('history-method').value = 'all'; render(); }, 'secondary small') : '');

  const range = periodRange(historyPeriod);
  const q = norm(historySearch.trim());
  const text = (r) => (r.kind === 'expense' ? (r.note ?? '') : `${r.lines.map((l) => productName(view, l.product_id)).join(' ')} ${r.kind === 'adjustment' ? adjustLabel(r) : ''}`);
  const match = (r) => inRange(r.created_at, range) && (historyMethod === 'all' || (r.payment_method_id ?? 'none') === historyMethod) && (!q || norm(text(r)).includes(q));
  const [one, many] = KIND_NOUN[historyKind];
  const days = recordsByDay(Object.values(view.records), KIND_RECORDS[historyKind]).map((d) => ({ ...d, sales: d.sales.filter(match) })).filter((d) => d.sales.length);

  // Resumen de lo que se está viendo (las anuladas no suman; el dinero solo cuenta ventas, compras y gastos)
  const live = days.flatMap((d) => d.sales).filter((r) => !r.voided);
  const byMethod = {};
  for (const r of live) if (r.amount) byMethod[r.payment_method_id ?? 'none'] = (byMethod[r.payment_method_id ?? 'none'] ?? 0) + r.amount;
  const total = live.reduce((sum, r) => sum + r.amount, 0);
  const parts = Object.entries(byMethod).map(([m, v]) => `${methodName(m)} ${money(v)}`).join(' · ');
  $('history-summary').replaceChildren(el('strong', { textContent: periodLabel() }),
    live.length ? ` · ${live.length} ${live.length === 1 ? one : many}${total ? ` · ${money(total)}${parts ? ` (${parts})` : ''}` : ''}` : '');
  if (!days.length) box.append(el('p', { className: 'muted', textContent: chips.length ? `No hay ${many} que coincidan con el filtro de arriba en este período. Quítalo con la ✕ para ver todo.` : `No hay ${many} en este período.` }));

  const shown = historyPeriod === 'all' ? days.slice(0, historyDays) : days;
  for (const d of shown) {
    const dayLive = d.sales.filter((r) => !r.voided);
    const dayTotal = dayLive.reduce((sum, r) => sum + r.amount, 0);
    box.append(el('div', { className: 'dayhead' }, el('strong', { textContent: dayLabel(d.date) }),
      el('span', { className: 'muted', textContent: ` · ${dayLive.length} ${dayLive.length === 1 ? one : many}${dayTotal ? ` · ${money(dayTotal)}` : ''}` })));
    box.append(el('ul', { className: 'list' }, ...d.sales.map((r) => historyCard(view, r))));
  }
  $('history-more').hidden = !(historyPeriod === 'all' && days.length > historyDays);
  if (historyPeriod === 'all' && view.coverage?.records_since) box.append(el('p', { className: 'muted', textContent: `Aquí se ve lo de los últimos ${RECORD_RETENTION_DAYS} días. Las semanas anteriores se consultan en Ganancias.` }));
}

async function correctPurchaseDialog(r) {
  const l = r.lines[0];
  const name = productName(currentView, l.product_id);
  const v = await askChoice({
    title: `Corregir compra: ${name}`,
    fields: [
      { name: 'qty', label: 'Cantidad correcta', type: 'number', min: 1, value: l.qty },
      { name: 'unit_cost', label: 'Costo por unidad correcto', type: 'number', value: l.unit_cost },
    ],
    hint: `Antes: ${l.qty} unidades a ${money(l.unit_cost)} (${methodName(r.payment_method_id)}). Se anula esa compra y se registra la correcta; el stock y el costo promedio se recalculan. ¿Cómo se pagó?`,
    choices: PAY_CHOICES,
  });
  if (!v || !okInt(v.qty) || v.qty < 1 || !okInt(v.unit_cost)) return;
  await run(() => engine.correctPurchase(r, { qty: v.qty, unit_cost: v.unit_cost, payment_method_id: v.choice }));
  toast('Compra corregida ✓');
}

/** Corregir un movimiento de inventario: la cantidad y, si es una entrada (inventario inicial), también su costo por unidad. */
async function correctAdjustmentDialog(r) {
  const l = r.lines[0];
  const entering = l.delta > 0;
  const isEntry = entering && (l.unit_cost !== undefined || (r.note ?? '').toLowerCase() === 'inventario inicial');
  const product = currentView.entities.product[l.product_id];
  const fields = [{ name: 'qty', label: entering ? 'Cantidad correcta que entró' : 'Cantidad correcta que salió', type: 'number', min: 1, value: Math.abs(l.delta) }];
  if (isEntry) fields.push({ name: 'unit_cost', label: 'Costo por unidad correcto', type: 'number', value: l.unit_cost ?? product?.cost ?? 0,
    hint: l.unit_cost === undefined ? 'Este movimiento se hizo antes de guardar su costo: se propone el costo actual del producto.' : undefined });
  const v = await askForm(`Corregir: ${productName(currentView, l.product_id)}`, fields.map((f) => ({ ...f, hint: f.hint ?? (f.name === 'qty' ? `Antes: ${entering ? '+' : '−'}${Math.abs(l.delta)} unidades (${adjustLabel(r)}). Se anula y se registra el correcto; el stock${isEntry ? ' y el costo promedio se recalculan' : ' se recalcula'}.` : undefined) })), 'Corregir');
  if (!v || !okInt(v.qty) || v.qty < 1 || (isEntry && !okInt(v.unit_cost))) return;
  await run(() => engine.correctAdjustment(r, entering ? v.qty : -v.qty, isEntry ? v.unit_cost : undefined));
  toast('Corregido ✓');
}

/** Desde un producto: ir directo al historial de su mercancía. */
function showProductHistory(p) {
  historyKind = 'merch'; historyPeriod = 'all'; historyMethod = 'all'; historySearch = p.name; historyDays = 60;
  $('history-search').value = p.name; $('history-method').value = 'all'; $('history-day').value = '';
  document.querySelector('.tabs button[data-tab="history"]').click();
  render();
}

/** Lápiz junto al nombre: solo sirve para renombrar. */
function pencil(p) {
  const b = btn('✏️', () => renameProduct(p), 'icon');
  b.setAttribute('aria-label', `Cambiar el nombre de ${p.name}`);
  b.title = 'Cambiar el nombre';
  return b;
}

async function renameProduct(p) {
  const v = await askForm('Cambiar el nombre', [{ name: 'name', label: 'Nombre del producto', value: p.name, hint: 'El nombre nuevo se ve también en las ventas y movimientos anteriores.' }], 'Guardar');
  if (v && v.name && v.name !== p.name) await run(() => engine.updateEntity('product', p.id, { name: v.name }));
}

function renderProducts(view, st) {
  const list = $('product-list'); list.replaceChildren();
  const all = activeProducts(view);
  const q = norm(productSearch.trim());
  const shown = q ? all.filter((p) => norm(p.name).includes(q)) : all;
  $('product-count').textContent = !all.length ? '' : q ? `${shown.length} de ${all.length} productos` : `${all.length} ${all.length === 1 ? 'producto' : 'productos'}`;
  if (all.length && !shown.length) list.append(el('p', { className: 'muted', textContent: `No encontré "${productSearch.trim()}".` }));

  // Filas compactas (una línea de nombre + una de costo/precio + las unidades a la derecha). Al tocar una fila se
  // despliegan sus acciones. Así caben muchos productos en pantalla sin quitar ninguna función.
  for (const p of shown) {
    const stock = view.stock[p.id] ?? 0;
    const isOpen = expandedProduct === p.id;
    const toggle = () => { expandedProduct = isOpen ? null : p.id; render(); };
    const main = el('div', { className: 'prow-main', onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      el('div', { className: 'prow-text' }, el('div', { className: 'name', title: p.name }, p.name, p.pending ? el('span', { className: 'tag', textContent: ' ⏳' }) : ''),
        el('div', { className: 'meta', textContent: `Costo ${money(p.cost ?? 0)} · Precio ${money(p.price)}` })),
      el('div', { className: 'stock' }, el('strong', { textContent: String(stock) }), el('small', { textContent: stock === 1 ? 'queda' : 'quedan' })));
    main.setAttribute('role', 'button'); main.tabIndex = 0; main.setAttribute('aria-expanded', String(isOpen));
    const pen = pencil(p); pen.addEventListener('click', (e) => e.stopPropagation()); // el lápiz no despliega la fila
    list.append(el('div', { className: `prow ${isOpen ? 'open' : ''} ${stock <= 0 ? 'low' : ''}` },
      el('div', { className: 'prow-head' }, main, pen),
      isOpen ? el('div', { className: 'prow-actions' },
        btn('Llegó mercancía', () => restock(p), 'small'),
        btn('Precio', () => editProductPrice(p), 'secondary small'),
        btn('Movimientos', () => showProductHistory(p), 'secondary small'),
        btn('Quitar', () => removeProduct(p), 'secondary small')) : ''));
  }

  const openConflicts = Object.values(view.conflicts).filter((c) => c.status === 'open');
  $('conflicts-box').hidden = openConflicts.length === 0;
  const cl = $('conflicts'); cl.replaceChildren();
  const fmt = (c, v) => (c.field === 'name' ? String(v) : money(v));
  for (const c of openConflicts) {
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
  const what = r.amount ? ` de ${money(r.amount)}` : '';
  const ok = await confirmTyped({
    title: `¿Anular ${label}?`,
    detail: `Se va a anular ${label}${what} (${hourOf(r)}). El stock${r.kind === 'purchase' || r.kind === 'adjustment' ? ' y el costo del producto se corrigen' : ' se corrige'} solo y nada se borra: queda marcada como anulada.`,
    action: 'Anular',
  });
  if (ok) await run(() => engine.voidOp(r.op_id, 'anulada desde la app'));
}

async function restock(p) {
  const stock = (await engine.getView()).stock[p.id] ?? 0;
  const v = await askChoice({
    title: `Llegó mercancía: ${p.name}`,
    fields: [
      { name: 'qty', label: '¿Cuántas unidades llegaron?', type: 'number', min: 1 },
      { name: 'unit_cost', label: 'Costo por unidad de ESTA compra', type: 'number', value: p.cost ?? 0, hint: 'Cámbialo si esta vez te costó diferente.' },
    ],
    hint: 'El costo del producto se promedia con lo que ya tenías. ¿Cómo se pagó?', choices: PAY_CHOICES,
  });
  if (!v || !okInt(v.qty) || v.qty < 1 || !okInt(v.unit_cost)) return;
  const next = weightedAverageCost(stock, p.cost ?? 0, v.qty, v.unit_cost);
  await run(() => engine.restock(p.id, v.qty, { unit_cost: v.unit_cost, payment_method_id: v.choice }));
  toast(next !== (p.cost ?? 0) ? `Compra guardada ✓ Nuevo costo promedio: ${money(next)}` : 'Compra guardada ✓');
}

async function removeProduct(p) {
  const ok = await confirmTyped({
    title: `¿Quitar "${p.name}"?`,
    detail: 'El producto desaparece de las listas. Las ventas y los movimientos anteriores se conservan.',
    action: 'Quitar',
  });
  if (ok) await run(() => engine.updateEntity('product', p.id, { archived: true }));
}

/**
 * Solo el PRECIO de venta. El costo y la cantidad NO se editan directamente (descuadraría el inventario y el costo promedio):
 * se corrigen entrada por entrada desde "Movimientos". Única excepción: un producto sin existencias ni entradas todavía
 * (solo tiene un costo de referencia) deja ajustar ese costo. El nombre se cambia con el lápiz ✏️.
 */
async function editProductPrice(p) {
  const view = await engine.getView();
  const stock = view.stock[p.id] ?? 0;
  const hasEntries = Object.values(view.records).some((r) => !r.voided && r.lines.some((l) => l.product_id === p.id)
    && (r.kind === 'purchase' || (r.kind === 'adjustment' && (r.note ?? '').toLowerCase() === 'inventario inicial')));
  const costEditable = stock === 0 && !hasEntries;
  const fields = [{ name: 'price', label: 'A cómo lo vendemos (precio)', type: 'number', value: p.price, hint: 'Cambiarlo no modifica las ventas que ya hiciste.' }];
  if (costEditable) fields.push({ name: 'cost', label: 'Costo de referencia', type: 'number', value: p.cost ?? 0, hint: 'Todavía no hay mercancía de este producto. Cuando registres su primera entrada, el costo sale de ella.' });
  else fields.push({ name: 'note', label: 'Costo y cantidad', required: false, value: 'Se corrigen en "Movimientos"', readonly: true });
  const v = await askForm(`Precio: ${p.name}`, fields, 'Guardar');
  if (!v || !okInt(v.price) || (costEditable && !okInt(v.cost))) return;
  const changes = {};
  if (v.price !== p.price) changes.price = v.price;
  if (costEditable && v.cost !== (p.cost ?? 0)) changes.cost = v.cost;
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
  // Con cantidad: el costo viaja en la ENTRADA de inventario (así se puede corregir después desde "Movimientos" sin descuadrar el promedio).
  // Sin cantidad: queda como costo de referencia del producto hasta que llegue mercancía.
  const { id } = await engine.createEntity('product', { name: v.name, cost: v.qty > 0 ? 0 : v.cost, price: v.price });
  if (v.qty > 0) await engine.adjustStock(id, v.qty, 'inventario inicial', v.cost);
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
$('history-more').addEventListener('click', () => { historyDays += 14; render(); });
// Al cambiar entre Ventas / Mercancía / Gastos se quita el filtro de texto (p. ej. el producto con que se llegó desde Productos).
document.querySelectorAll('#history-kind button').forEach((b) => b.addEventListener('click', () => { historyKind = b.dataset.kind; historySearch = ''; $('history-search').value = ''; historyDays = 14; render(); }));
$('product-search').addEventListener('input', (e) => { productSearch = e.target.value; expandedProduct = null; render(); });
document.querySelectorAll('#history-period button').forEach((b) => b.addEventListener('click', () => { historyPeriod = b.dataset.period; $('history-day').value = ''; historyDays = 14; render(); }));
$('history-day').addEventListener('change', (e) => { historyPeriod = e.target.value || 'week'; render(); });
$('history-search').addEventListener('input', (e) => { historySearch = e.target.value; render(); });
$('history-method').addEventListener('change', (e) => { historyMethod = e.target.value; render(); });
/** Confirmar la venta: cada línea con su precio (se puede cambiar solo para esta venta) y la forma de pago. */
function confirmSale(items, view) {
  return new Promise((resolve) => {
    const dlg = el('dialog');
    const form = el('form');
    form.append(el('h3', { textContent: 'Confirmar venta' }));
    const inputs = [];
    const totalEl = el('p', { className: 'total' });
    const recalc = () => { totalEl.textContent = `Total: ${money(items.reduce((sum, it, i) => sum + it.qty * (Number(inputs[i].value) || 0), 0))}`; };
    const rows = el('div', { className: 'sale-lines' });
    for (const it of items) {
      const p = view.entities.product[it.product_id];
      const input = el('input', { type: 'number', inputMode: 'numeric', min: 0, step: 1, required: true, value: String(p.price) });
      input.setAttribute('aria-label', `Precio de ${p.name}`);
      input.addEventListener('input', recalc);
      input.addEventListener('focus', () => input.select());
      inputs.push(input);
      rows.append(el('div', { className: 'sale-line' }, el('strong', { textContent: `${it.qty} × ${p.name}` }), el('label', { className: 'price-label' }, el('small', { textContent: 'Precio c/u' }), input)));
    }
    form.append(rows, totalEl, el('p', { className: 'muted', textContent: 'Puedes cambiar el precio solo para esta venta (por ejemplo, un descuento). El precio del producto no cambia.' }), el('p', { className: 'muted', textContent: '¿Cómo pagaron?' }));
    let chosen = null;
    const pay = PAY_CHOICES.map((c) => btn(c.label, () => { if (!form.reportValidity()) return; chosen = c.id; dlg.close('ok'); }, 'big'));
    form.append(el('div', { className: 'choices' }, ...pay), btn('Cancelar', () => dlg.close('cancel'), 'secondary'));
    form.addEventListener('submit', (ev) => ev.preventDefault());
    dlg.append(form);
    dlg.addEventListener('close', () => { const prices = inputs.map((i) => Number(i.value)); dlg.remove(); resolve(dlg.returnValue === 'ok' && chosen ? { choice: chosen, prices } : null); });
    document.body.append(dlg);
    dlg.showModal();
    pay[0].focus(); // que no se abra el teclado solo
  });
}

$('cart-pay').addEventListener('click', async () => {
  const view = await engine.getView();
  const items = [...cart].filter(([id]) => view.entities.product[id]).map(([product_id, qty]) => ({ product_id, qty }));
  if (!items.length) return;
  const v = await confirmSale(items, view);
  if (!v) return; // cancelado: el carrito queda como estaba
  const sold = items.map((it, i) => ({ ...it, unit_price: v.prices[i] }));
  cart.clear(); searchTerm = ''; $('search').value = '';
  await run(() => engine.sellProducts(sold, { payment_method_id: v.choice }));
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
