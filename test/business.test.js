import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, line, rawOp, makeNet } from './helpers.js';
import { ApiClient, ApiError } from '../src/client/api/api-client.js';
import { MemoryStore } from '../src/client/persistence/memory-store.js';
import { login, LocalAuthError } from '../src/client/auth/session.js';
import { weeklyReport, weekStart, addDays } from '../src/domain/report.js';
import { hashPassword } from '../src/server/auth/auth.js';

function authKit(w, deviceId = 'device-offline-login-1') {
  const net = makeNet(w.baseUrl);
  const store = new MemoryStore();
  const api = new ApiClient({ baseUrl: w.baseUrl, fetch: (u, i) => net.fetch(u, i), getToken: async () => (await store.load()).meta.session?.token ?? null });
  const run = (username, password) => login({ api, store, username, password, deviceId, deviceName: 't', isOnline: () => true });
  return { net, store, api, run };
}

test('login sin conexión: primer login online guarda verificador; después funciona offline', async () => {
  const w = await world();
  try {
    const k = authKit(w);
    // Sin internet y sin haber entrado nunca en este dispositivo: no se puede
    k.net.online = false;
    await assert.rejects(k.run('staffa', 'pass-a'), (e) => e instanceof LocalAuthError && e.code === 'first_login_needs_internet');

    k.net.online = true;
    const first = await k.run('staffa', 'pass-a');
    assert.equal(first.mode, 'online');
    const { meta } = await k.store.load();
    assert.ok(!JSON.stringify(meta).includes('pass-a'), 'la contraseña nunca se guarda');
    assert.ok(meta.local_auth.staffa.hash);

    k.net.online = false;
    const off = await k.run('staffa', 'pass-a');
    assert.equal(off.mode, 'offline');
    assert.equal(off.session.user.username, 'staffa');
    assert.equal(off.session.token, first.session.token, 'conserva el token para sincronizar al volver internet');
    await assert.rejects(k.run('staffa', 'otra'), (e) => e instanceof LocalAuthError && e.code === 'invalid_credentials');
    await assert.rejects(k.run('staffb', 'pass-b'), (e) => e.code === 'first_login_needs_internet');
  } finally { await w.close(); }
});

test('login online: si el servidor dice que la contraseña es incorrecta, el verificador viejo no la salva', async () => {
  const w = await world();
  try {
    const k = authKit(w);
    await k.run('staffa', 'pass-a');
    w.db.prepare("UPDATE users SET password_hash=? WHERE username='staffa'").run(hashPassword('nueva-clave'));
    await assert.rejects(k.run('staffa', 'pass-a'), (e) => e instanceof ApiError && e.status === 401);
    assert.equal((await k.run('staffa', 'nueva-clave')).mode, 'online');
    k.net.online = false; // y el verificador local se actualizó con la clave nueva
    await assert.rejects(k.run('staffa', 'pass-a'), (e) => e.code === 'invalid_credentials');
    assert.equal((await k.run('staffa', 'nueva-clave')).mode, 'offline');
  } finally { await w.close(); }
});

test('ganancias semanales: ventas − costo de lo vendido − gastos; anuladas no cuentan', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    A.net.online = false;
    const sale = await A.engine.sellProducts([{ product_id: 'p1', qty: 10 }]); // 10 × (5000 − 3000)
    await A.engine.sellProducts([{ product_id: 'p1', qty: 2 }]);
    await A.engine.expense(4000, 'hielo');
    await A.engine.restock('p1', 20); // compra: inventario, no resta ganancia
    A.net.online = true; await A.engine.sync();

    const view = await A.engine.getView();
    const wk = weeklyReport(Object.values(view.records), weekStart(new Date()));
    assert.deepEqual([wk.sales, wk.cogs, wk.gross, wk.expenses, wk.net, wk.purchases], [60000, 36000, 24000, 4000, 20000, 60000]);
    assert.equal(wk.byProduct[0].qty, 12);
    assert.equal(wk.byProduct[0].profit, 24000);
    assert.equal(view.stock.p1, 100 - 12 + 20);

    // El costo sube después: la venta ya hecha conserva el costo con que se vendió
    await A.engine.updateEntity('product', 'p1', { cost: 4500 });
    await A.engine.sync();
    const wk2 = weeklyReport(Object.values((await A.engine.getView()).records), weekStart(new Date()));
    assert.equal(wk2.cogs, 36000);

    await A.engine.voidOp(sale.op_id, 'error'); await A.engine.sync();
    const wk3 = weeklyReport(Object.values((await A.engine.getView()).records), weekStart(new Date()));
    // queda solo la venta de 2 unidades: 2×5000 ventas, 2×3000 costo, 4000 de gastos
    assert.deepEqual([wk3.sales, wk3.cogs, wk3.net], [10000, 6000, 10000 - 6000 - 4000]);
    assert.equal(w.stock(), 100 - 2 + 20);
  } finally { await w.close(); }
});

test('semana lunes–domingo en hora local; registros de otra semana no cuentan', () => {
  const wed = new Date(2026, 9, 7, 15, 0); // mié 7 oct 2026
  const mon = weekStart(wed);
  assert.deepEqual([mon.getDay(), mon.getDate(), mon.getHours()], [1, 5, 0]);
  const sun = new Date(2026, 9, 11, 23, 59);
  assert.equal(weekStart(sun).getDate(), 5);
  assert.equal(weekStart(new Date(2026, 9, 12, 0, 0)).getDate(), 12);
  const mk = (d, amount) => ({ kind: 'sale', created_at: d.toISOString(), amount, cost: amount / 2, lines: [{ product_id: 'x', qty: 1, unit_price: amount, unit_cost: amount / 2 }] });
  const r = weeklyReport([mk(new Date(2026, 9, 4, 23, 59), 100), mk(new Date(2026, 9, 5, 0, 0), 200), mk(sun, 400), mk(new Date(2026, 9, 12, 0, 0), 800)], mon);
  assert.equal(r.sales, 600);
  assert.equal(addDays(mon, 7).getDate(), 12);
});

test('corregir cantidad registra solo la diferencia; costo negativo en una venta se rechaza', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    await A.engine.setQuantity('p1', 80);
    assert.equal((await A.engine.getView()).stock.p1, 80);
    assert.equal(await A.engine.setQuantity('p1', 80), null, 'sin cambio no genera operación');
    await A.engine.sync();
    assert.equal(w.stock(), 80);
    const bad = await A.api.push([rawOp(A.deviceId, 2, { payload: { lines: [{ product_id: 'p1', qty: 1, unit_price: 5, unit_cost: -1 }] } })]);
    assert.equal(bad.results[0].status, 'rejected');
  } finally { await w.close(); }
});

// ---------- Actualización de la app / compatibilidad ----------
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncEngine } from '../src/client/sync/engine.js';

test('sw.js sale con versión (build) y lista de archivos inyectadas; precachea TODO lo que el navegador descarga', async () => {
  const w = await world();
  try {
    const sw = await (await fetch(`${w.baseUrl}/sw.js`)).text();
    assert.ok(!sw.includes('__BUILD__') && !sw.includes('__FILES__'), 'sin marcadores sin reemplazar');
    const build = /const BUILD = "([0-9a-f]{12})"/.exec(sw)?.[1];
    assert.ok(build, 'build inyectado');
    const files = JSON.parse(/const FILES = (\[.*?\]);/s.exec(sw)[1]);

    // Todo archivo servible de public/ y src/{client,domain,shared} debe estar en la lista (si falta, no abre offline)
    const root = fileURLToPath(new URL('../', import.meta.url));
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const expected = ['public', 'src/client', 'src/domain', 'src/shared'].flatMap((d) => walk(join(root, d)))
      .map((f) => `/${relative(root, f).split(sep).join('/')}`.replace(/^\/public\//, '/')).filter((u) => u !== '/sw.js' && /\.(html|js|css|webmanifest|png|svg)$/.test(u));
    for (const u of expected) assert.ok(files.includes(u), `falta en precache: ${u}`);
    assert.ok(files.includes('/'));
    for (const u of files) assert.equal((await fetch(w.baseUrl + u)).status, 200, `no se sirve: ${u}`);
    // /api/health publica el mismo build (los clientes pueden compararlo)
    assert.equal((await (await fetch(`${w.baseUrl}/api/health`)).json()).build, build);
    // el código del servidor sigue sin servirse
    assert.equal((await fetch(`${w.baseUrl}/src/server/main.js`)).status, 404);
  } finally { await w.close(); }
});

test('estado local con forma antigua (state_schema distinto): se re-descarga el snapshot sin perder la cola', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 6)]);
    // simula una app vieja: estado guardado sin el esquema actual y con datos incompletos
    await A.store.commit({ state: { entities: { product: {}, category: {}, payment_method: {} }, stock: {}, records: {}, conflicts: {} }, metaPatch: { state_schema: 0 } });
    A.net.online = true;
    assert.equal((await A.engine.sync()).ok, true);
    const v = await A.engine.getView();
    assert.equal(v.entities.product.p1.cost, 3000, 'catálogo repuesto desde el servidor');
    assert.equal(v.stock.p1, 94);
    assert.equal(w.stock(), 94);
    assert.equal(w.opCount('SALE_CREATE'), 1, 'la venta pendiente se envió una sola vez');
    assert.equal((await A.store.load()).meta.state_schema, 2);
  } finally { await w.close(); }
});

test('servidor exige protocolo más nuevo (426): el cliente avisa "update_required" y conserva su cola', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    await A.engine.sale([line('p1', 2)]);
    // se "despliega" una versión que ya no acepta protocolo 1
    const { createApp } = await import('../src/server/http/server.js');
    const strict = createApp(w.db, { trustProxy: false, loginMax: 1000, minProto: 2 });
    await new Promise((r) => strict.listen(0, '127.0.0.1', r));
    const api = new ApiClient({ baseUrl: `http://127.0.0.1:${strict.address().port}`, getToken: () => A.tok.t });
    const engine = new SyncEngine({ store: A.store, api, deviceId: A.deviceId, userId: A.userId });
    const r = await engine.sync();
    assert.equal(r.status, 'update_required');
    assert.equal((await engine.stats()).pending, 1);
    assert.equal(w.stock(), 100, 'nada se aplicó');
    // y la versión actual sigue entendiéndose con el servidor normal
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 98);
    await new Promise((r2) => strict.close(r2));
  } finally { await w.close(); }
});

// ---------- Formas de pago e historial ----------
import { salesByDay } from '../src/domain/report.js';

test('plata por forma de pago: efectivo y transferencia (ventas − gastos − compras), sincronizado entre equipos', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    const B = await w.device('B', 'staffa');
    await A.engine.sync(); await B.engine.sync();
    A.net.online = false;
    await A.engine.sellProducts([{ product_id: 'p1', qty: 4 }], { payment_method_id: 'pm-cash' });      // +20000 efectivo
    await A.engine.sellProducts([{ product_id: 'p1', qty: 2 }], { payment_method_id: 'pm-transfer' });  // +10000 transferencia
    await A.engine.expense(4000, 'hielo', { payment_method_id: 'pm-cash' });                              // −4000 efectivo
    await A.engine.restock('p1', 2, { payment_method_id: 'pm-transfer' });                                // −6000 transferencia
    await A.engine.sellProducts([{ product_id: 'p1', qty: 1 }]);                                          // sin indicar
    A.net.online = true;
    await A.engine.sync(); await B.engine.sync();

    for (const d of [A, B]) {
      const r = weeklyReport(Object.values((await d.engine.getView()).records), weekStart(new Date()));
      assert.deepEqual(r.byMethod['pm-cash'], { in: 20000, out: 4000 });
      assert.deepEqual(r.byMethod['pm-transfer'], { in: 10000, out: 6000 });
      assert.deepEqual(r.byMethod.none, { in: 5000, out: 0 });
      assert.equal(r.sales, 35000);
    }
    const rec = w.db.prepare("SELECT data FROM records WHERE kind='sale' ORDER BY created_at LIMIT 1").get();
    assert.equal(JSON.parse(rec.data).payment_method_id, 'pm-cash');
  } finally { await w.close(); }
});

test('historial por día: agrupa, suma por forma de pago y no cuenta las anuladas', () => {
  const sale = (iso, amount, method, voided = false) => ({ kind: 'sale', created_at: new Date(iso).toISOString(), amount, payment_method_id: method, voided, lines: [] });
  const days = salesByDay([
    sale('2026-10-07T10:00:00', 10000, 'pm-cash'), sale('2026-10-07T15:30:00', 5000, 'pm-transfer'),
    sale('2026-10-07T16:00:00', 99999, 'pm-cash', true), sale('2026-10-06T20:00:00', 7000, 'pm-cash'),
    { kind: 'expense', created_at: new Date('2026-10-07T11:00:00').toISOString(), amount: 1 },
  ]);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-07', '2026-10-06']);
  assert.equal(days[0].total, 15000);
  assert.deepEqual(days[0].byMethod, { 'pm-cash': 10000, 'pm-transfer': 5000 });
  assert.equal(days[0].sales.length, 3, 'la anulada se lista');
  assert.equal(days[0].sales[0].amount, 99999, 'más reciente primero');
  assert.equal(days[1].total, 7000);
});

// ---------- Reinicio de datos (entregar la base "nueva") ----------
import { resetOrgData } from '../src/server/sync/reset.js';

test('reinicio de datos: se descarta lo ya sincronizado, se CONSERVA lo nunca subido y se envía a la base nueva', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    const B = await w.device('B', 'staffa');
    await A.engine.sync(); await B.engine.sync();
    await A.engine.sale([line('p1', 5)]); await A.engine.sale([line('p1', 1)]); await A.engine.sync(); // device_seq de A llega a 2
    A.net.online = false;
    await A.engine.sale([line('p1', 3)]);                                             // depende de un producto que el reinicio borrará
    await A.engine.createEntity('product', { name: 'Gaseosa', price: 3000, cost: 1500 }, 'nuevo1'); // NO depende de datos viejos
    await A.engine.adjustStock('nuevo1', 10, 'inventario inicial');
    await A.engine.sellProducts([{ product_id: 'nuevo1', qty: 4 }], { payment_method_id: 'pm-cash' });
    assert.equal((await A.engine.stats()).pending, 4);

    const counts = resetOrgData(w.db, w.org.org_id, { dropSessions: true });
    assert.ok(counts.operations >= 3 && counts.devices === 2);
    assert.equal(w.db.prepare('SELECT COUNT(*) c FROM users').get().c, 3, 'los usuarios se conservan');
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM entities WHERE type='product'").get().c, 0);
    assert.deepEqual(w.db.prepare("SELECT id FROM entities WHERE type='payment_method' ORDER BY id").all().map((r) => r.id), ['pm-cash', 'pm-transfer']);
    assert.equal(w.db.prepare('SELECT MIN(seq) s FROM operations').get().s, 1, 'la numeración vuelve a empezar');

    // sin sesión (se borraron): vuelven a entrar y cada equipo se actualiza solo
    A.net.online = true;
    assert.equal((await A.engine.sync()).status, 'auth_required');
    await A.login(); await B.login();
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal((await B.engine.sync()).ok, true);

    assert.equal(A.engine.lastReset.kept, 4, 'lo nunca subido se conservó');
    // lo independiente se aplicó en la base nueva (renumerado desde 1)
    assert.equal(w.stock('nuevo1'), 6);
    assert.deepEqual(w.db.prepare("SELECT device_seq FROM operations WHERE device_id=? ORDER BY device_seq").all(A.deviceId).map((r) => r.device_seq), [1, 2, 3, 4]);
    // lo que dependía de un producto borrado NO se pierde: queda rechazado, visible y con todos sus datos
    const st = await A.engine.stats();
    assert.equal(st.pending, 0);
    assert.equal(st.rejected.length, 1);
    assert.match(st.rejected[0].reason, /unknown_product:p1/);
    assert.equal(st.rejected[0].payload.lines[0].qty, 3, 'los datos originales siguen ahí');
    assert.equal(w.db.prepare("SELECT status FROM operations WHERE op_id=?").get(st.rejected[0].op_id).status, 'rejected');
    assert.equal(w.stock('p1'), 0, 'el producto viejo no reaparece');

    for (const d of [A, B]) {
      const v = await d.engine.getView();
      assert.deepEqual(Object.keys(v.entities.product), ['nuevo1'], 'ni rastro de los productos viejos');
      assert.equal(v.stock.nuevo1, 6);
    }
    // el equipo B (sin nada pendiente) solo se actualizó
    assert.equal(B.engine.lastReset.kept, 0);
    assert.equal((await A.store.load()).meta.state_schema, 2);
  } finally { await w.close(); }
});

test('tras un reinicio, un cliente viejo que no envía época es rechazado (no puede contaminar la base nueva)', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    resetOrgData(w.db, w.org.org_id);
    await A.login();
    const legacy = new ApiClient({ baseUrl: w.baseUrl, getToken: () => A.tok.t }); // sin X-Epoch
    await assert.rejects(legacy.push([rawOp(A.deviceId, 1)]), (e) => e.status === 409 && e.code === 'epoch_changed');
    assert.equal(w.opCount('SALE_CREATE'), 0);
    assert.ok((await legacy.snapshot()).epoch, 'el snapshot sí se puede pedir para obtener la época nueva');
  } finally { await w.close(); }
});

// ---------- Cambios hechos directamente en la base de datos ----------
test('sin cambios externos, la huella coincide siempre: ningún equipo se "autocorrige" de más', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    const B = await w.device('B', 'staffa');
    await A.engine.sync(); await B.engine.sync();
    A.net.online = false; B.net.online = false;
    const s = await A.engine.sellProducts([{ product_id: 'p1', qty: 3 }], { payment_method_id: 'pm-cash' });
    await B.engine.updateEntity('product', 'p1', { price: 7000 });
    await A.engine.updateEntity('product', 'p1', { price: 6000 }); // genera conflicto
    await B.engine.createEntity('product', { name: 'Otro', price: 1000 }, 'px');
    await B.engine.adjustStock('px', 5, 'inicial');
    A.net.online = true; B.net.online = true;
    for (let i = 0; i < 2; i++) { await A.engine.sync(); await B.engine.sync(); }
    await A.engine.voidOp(s.op_id, 'x'); await A.engine.sync(); await B.engine.sync();
    assert.equal(A.engine.healCount + B.engine.healCount, 0);
  } finally { await w.close(); }
});

test('si se edita/borra algo directo en la base de datos, los equipos lo reflejan al conectarse (sin perder lo pendiente)', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    const B = await w.device('B', 'staffa');
    await A.engine.sync();
    await A.engine.sale([line('p1', 10)]);
    await A.engine.createEntity('product', { name: 'De prueba', price: 1000, cost: 500 }, 'prueba1');
    await A.engine.sync(); await B.engine.sync();
    assert.equal((await B.engine.getView()).stock.p1, 90);
    assert.ok((await B.engine.getView()).entities.product.prueba1);

    // === alguien toca la base a mano (lo que NO se debe hacer, pero tiene que corregirse solo) ===
    w.db.exec("DELETE FROM inventory_movements WHERE reason='sale'");                    // se "borra" la venta del stock
    w.db.exec("DELETE FROM records WHERE kind='sale'");                                   // y la venta del historial
    w.db.exec("DELETE FROM entities WHERE id='prueba1'");                                  // y un producto
    w.db.exec("UPDATE entities SET data=json_set(data,'$.price',9999) WHERE id='p1'");     // y un precio, sin subir la versión

    B.net.online = false;
    await B.engine.sale([line('p1', 2)]);                                                  // B tiene una venta real pendiente
    B.net.online = true;
    assert.equal((await B.engine.sync()).ok, true);
    const v = await B.engine.getView();
    assert.equal(B.engine.healCount, 1);
    assert.equal(v.entities.product.prueba1, undefined, 'el producto borrado desaparece del equipo');
    assert.equal(v.entities.product.p1.price, 9999, 'el precio editado llega al equipo');
    assert.deepEqual(Object.values(v.records).filter((r) => r.kind === 'sale' && r.lines[0].qty === 10), [], 'la venta borrada desaparece');
    assert.equal(w.stock(), 100 - 2, 'la venta pendiente de B sí se aplicó');
    assert.equal(v.stock.p1, 98, 'stock del equipo = stock del servidor');
    assert.equal((await B.engine.stats()).pending, 0);

    await A.engine.sync();
    assert.equal(A.engine.healCount, 1);
    assert.equal((await A.engine.getView()).stock.p1, 98);
    assert.equal((await A.engine.getView()).entities.product.prueba1, undefined);
  } finally { await w.close(); }
});

test('comandos de administración: anular y archivar pasan por el registro y llegan a los equipos sin autocorrección', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    const sale = await A.engine.sale([line('p1', 10)]);
    await A.engine.sync();
    const { execFileSync } = await import('node:child_process');
    const run = (...args) => execFileSync(process.execPath, ['scripts/admin.js', ...args], { env: { ...process.env, DB_PATH: w.dbFile }, encoding: 'utf8' });
    assert.ok(w.dbFile, 'el mundo de pruebas expone su archivo');
    const recId = w.db.prepare("SELECT id FROM records WHERE kind='sale'").get().id;
    assert.match(run('void', recId), /anulado/);
    assert.match(run('archive-product', 'p1'), /archivado/);
    await A.engine.sync();
    const v = await A.engine.getView();
    assert.equal(v.stock.p1, 100);
    assert.equal(v.records[recId].voided, true);
    assert.equal(v.entities.product.p1.archived, true);
    assert.equal(A.engine.healCount, 0, 'llegó por el registro, no por corrección');
    assert.match(run('void', recId), /ya estaba anulado/);
    assert.ok(sale.op_id);
  } finally { await w.close(); }
});

test('reinicio CONSERVANDO sesiones: nadie vuelve a iniciar sesión; el equipo se actualiza solo y sigue funcionando', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    await A.engine.sale([line('p1', 5)]); await A.engine.sale([line('p1', 1)]); await A.engine.sync(); // device_seq llega a 2
    A.net.online = false;
    await A.engine.expense(4000, 'hielo', { payment_method_id: 'pm-cash' });                           // pendiente, independiente de lo viejo
    const tokenBefore = A.tok.t;
    const seqBefore = w.db.prepare('SELECT MAX(seq) s FROM operations').get().s;

    const counts = resetOrgData(w.db, w.org.org_id);                                                  // por defecto: conserva sesiones
    assert.equal(counts.sessions_kept, 1);
    assert.equal(w.db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 1);
    assert.equal(w.db.prepare('SELECT last_device_seq s FROM devices').get().s, 0);
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM entities WHERE type='product'").get().c, 0);

    A.net.online = true;
    const r = await A.engine.sync();                       // SIN volver a iniciar sesión (mismo token)
    assert.equal(r.ok, true, `status: ${r.status}`);
    assert.equal(A.tok.t, tokenBefore);
    const v = await A.engine.getView();
    assert.deepEqual([Object.keys(v.entities.product).length, Object.values(v.records).filter((x) => x.kind === 'sale').length], [0, 0]);
    assert.equal(A.engine.lastReset.kept, 1);
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM records WHERE kind='expense'").get().c, 1, 'el gasto sin enviar sí llegó a la base nueva');
    assert.equal(w.opCount('SALE_CREATE'), 0, 'las ventas ya sincronizadas antes del reinicio se fueron con él');

    // sigue funcionando y los números de secuencia no chocan
    await A.engine.createEntity('product', { name: 'Producto Nuevo', price: 3000, cost: 1900 }, 'cost1');
    await A.engine.adjustStock('cost1', 30, 'inventario inicial');
    await A.engine.sellProducts([{ product_id: 'cost1', qty: 2 }], { payment_method_id: 'pm-cash' });
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock('cost1'), 28);
    assert.ok(w.db.prepare('SELECT MIN(seq) s FROM operations').get().s > seqBefore, 'la numeración del log no se reinició');
    assert.equal((await A.engine.stats()).pending, 0);
    assert.equal(A.engine.healCount, 0);
  } finally { await w.close(); }
});

// ---------- Identificar equipos: tipo legible, IP, ubicación, nombre ----------
import { parseUserAgent } from '../src/server/http/ua.js';
import { isPrivateIp, normalizeIp } from '../src/server/http/geo.js';
import { createApp } from '../src/server/http/server.js';
import { openDb } from '../src/server/db/db.js';
import { createOrganization } from '../src/server/auth/auth.js';

test('user-agent → texto que entiende una persona', () => {
  assert.equal(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'), 'iPhone · iOS 18.7 · Safari');
  assert.equal(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Apple'), 'iPhone · iOS 18.7', 'user-agent cortado');
  assert.equal(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), 'Android SM-S911B · Android 14 · Chrome');
  assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Windows · Edge');
  assert.equal(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Mac · macOS · Safari');
  assert.equal(parseUserAgent(''), null);
  assert.equal(isPrivateIp('192.168.1.5') && isPrivateIp('10.0.0.1') && isPrivateIp('127.0.0.1') && isPrivateIp('::1') && isPrivateIp('100.64.0.9'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('no-es-ip'), null);
});

test('identificación pasiva del equipo: IP, tipo, ubicación, host, info del navegador, historial de IPs y accesos — sin nada que escribir', async () => {
  const db = openDb(':memory:');
  createOrganization(db, { name: 'OrgGeo', ownerUsername: 'geo', ownerPassword: 'geo-pass' });
  const lookups = [];
  const fakeGeo = async (url) => {
    lookups.push(url.split('/').pop());
    return { json: async () => ({ success: true, country: 'País de Ejemplo', region: 'Región de Ejemplo', city: 'Ciudad de Ejemplo', latitude: 10.5, longitude: -20.25,
      timezone: { id: 'Europe/Madrid' }, connection: { asn: 64500, isp: 'Proveedor de Ejemplo' } }) };
  };
  const app = createApp(db, { trustProxy: true, loginMax: 1000, geo: { enabled: true, fetch: fakeGeo } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
  const info = encodeURIComponent(JSON.stringify({ tz: 'Europe/Madrid', lang: 'es-ES', screen: '390x844', dpr: 3, standalone: true, touch: 5, cores: 6, app: 'abc123def456', evil: 'x'.repeat(5000), hdr_lang: 'forjado' }));
  const hdr = (token, ip) => ({ authorization: `Bearer ${token}`, 'user-agent': UA, 'x-forwarded-for': ip, 'x-client-info': info, 'accept-language': 'es-ES,es;q=0.9' });
  try {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'curl/8', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify({ username: 'geo', password: 'mala', device_id: 'device-geo-0001' }) });
    assert.equal(bad.status, 401);

    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-forwarded-for': '8.8.8.8' },
      body: JSON.stringify({ username: 'geo', password: 'geo-pass', device_id: 'device-geo-0001' }) });
    const { token } = await r.json();
    for (let i = 0; i < 3; i++) await fetch(`${base}/api/me`, { headers: hdr(token, '8.8.8.8') });
    await new Promise((r2) => setTimeout(r2, 150)); // la consulta de ubicación corre en segundo plano

    const d = db.prepare('SELECT * FROM dispositivos').get();
    assert.deepEqual([d.tipo, d.modo, d.pantalla, d.zona_horaria, d.idioma, d.version_app, d.ip, d.ciudad, d.departamento, d.pais, d.proveedor_internet, d.asn, d.zona_horaria_ip, d.estado],
      ['iPhone · iOS 18.7 · Safari', 'app instalada', '390x844', 'Europe/Madrid', 'es-ES', 'abc123def456', '8.8.8.8', 'Ciudad de Ejemplo', 'Región de Ejemplo', 'País de Ejemplo', 'Proveedor de Ejemplo', 'AS64500', 'Europe/Madrid', 'activo']);
    assert.equal(d.latitud, '10.5');
    const stored = JSON.parse(db.prepare('SELECT client_info FROM devices').get().client_info);
    assert.equal(stored.evil, undefined, 'solo se guardan campos de la lista blanca');
    assert.equal(stored.hdr_lang, 'es-ES', 'lo que ve el servidor en las cabeceras manda sobre lo que diga el cliente');
    assert.deepEqual(lookups, ['8.8.8.8'], 'una consulta por IP, no por petición');

    // el equipo cambia de red: nueva IP → se registra en el historial y se vuelve a ubicar
    await fetch(`${base}/api/me`, { headers: hdr(token, '203.0.113.7') });
    await new Promise((r2) => setTimeout(r2, 150));
    assert.deepEqual(lookups, ['8.8.8.8', '203.0.113.7']);
    const hist = db.prepare('SELECT ip FROM historial_ips ORDER BY ip').all().map((x) => x.ip);
    assert.deepEqual(hist, ['203.0.113.7', '8.8.8.8']);
    const d2 = db.prepare('SELECT ip, ip_primera_vez FROM dispositivos').get();
    assert.deepEqual([d2.ip, d2.ip_primera_vez], ['203.0.113.7', '8.8.8.8']);

    // accesos: el intento fallido queda con su IP y navegador; el bueno también
    const acc = db.prepare('SELECT evento, usuario, ip, navegador FROM accesos ORDER BY cuando, evento').all();
    assert.ok(acc.some((a) => a.evento === 'login.failed' && a.ip === '1.2.3.4' && a.usuario === 'geo'));
    assert.ok(acc.some((a) => a.evento === 'login.ok' && a.ip === '8.8.8.8' && a.navegador === 'iPhone · iOS 18.7 · Safari'));
  } finally { await new Promise((r) => app.close(r)); db.close(); }
});

// ---------- Equipos viejos (sin "época" conocida) ----------
test('equipo viejo SIN época tras un reinicio: conserva lo no enviado, se renumera y no se atasca', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    for (let i = 0; i < 5; i++) await A.engine.sale([line('p1', 1)]);
    await A.engine.sync();                                       // device_seq de A llega a 5
    A.net.online = false;
    await A.engine.expense(7000, 'gasto sin enviar', { payment_method_id: 'pm-transfer' });  // device_seq 6, nunca subido
    await A.store.commit({ metaPatch: { epoch: null, state_schema: null } });                // simula la app de antes de las épocas

    resetOrgData(w.db, w.org.org_id, { dropSessions: true });                               // el servidor olvida al equipo (device_seq vuelve a 0)
    A.net.online = true;
    assert.equal((await A.engine.sync()).status, 'auth_required');
    await A.login();                                                                         // se vuelve a registrar con last_device_seq = 0
    assert.equal((await A.engine.sync()).ok, true, 'antes quedaba atascado: esperaba la secuencia 1 y el equipo enviaba la 6');
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM records WHERE kind='expense'").get().c, 1);
    assert.equal(w.db.prepare("SELECT device_seq s FROM operations WHERE op_type='EXPENSE_CREATE'").get().s, 1);
    assert.equal((await A.engine.stats()).pending, 0);
    await A.engine.expense(1000, 'otro');
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM records WHERE kind='expense'").get().c, 2);
  } finally { await w.close(); }
});

test('equipo viejo SIN época y SIN reinicio: aprende la época y sus pendientes se envían normal', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 2)]);
    await A.store.commit({ metaPatch: { epoch: null, state_schema: null } });
    A.net.online = true;
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 98);
    assert.ok((await A.store.load()).meta.epoch, 'ahora conoce la época');
    assert.equal(A.engine.lastReset, undefined, 'no hubo reinicio');
    assert.equal(w.opCount('SALE_CREATE'), 1);
  } finally { await w.close(); }
});

// ---------- Respaldos ----------
import { createBackup, stamp, pruneBackups } from '../src/server/backup.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

test('respaldo: queda verificado, comprimido, restaurable y la rotación conserva solo los más recientes', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    await A.engine.sale([line('p1', 5)]); await A.engine.sync();
    const dir = mkdtempSync(join(tmpdir(), 'ms-bk-'));
    // 23:55 en UTC-5 = 04:55 UTC del día siguiente: el nombre usa la hora de la zona del negocio
    assert.equal(stamp(new Date('2026-10-08T04:55:00Z'), 'America/Bogota'), '2026-10-07_2355');
    const r = await createBackup({ dbPath: w.dbFile, dir, tz: 'America/Bogota', now: new Date('2026-10-08T04:55:00Z') });
    assert.match(r.file, /app-2026-10-07_2355\.db\.gz$/);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('.tmp') || f.endsWith('.partial')).length, 0, 'no quedan temporales');

    // restaurar = descomprimir y abrir: debe ser la misma base
    const restored = join(dir, 'restaurada.db');
    writeFileSync(restored, gunzipSync(readFileSync(r.file)));
    const db2 = new DatabaseSync(restored, { readOnly: true });
    assert.equal(db2.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db2.prepare("SELECT COUNT(*) c FROM records WHERE kind='sale'").get().c, 1);
    assert.equal(db2.prepare('SELECT SUM(delta) s FROM inventory_movements').get().s, 95);
    db2.close();

    // rotación: con keep=2 solo quedan los 2 más nuevos
    for (const d of ['2026-10-09T04:55:00Z', '2026-10-10T04:55:00Z', '2026-10-11T04:55:00Z']) await createBackup({ dbPath: w.dbFile, dir, tz: 'America/Bogota', keep: 2, now: new Date(d) });
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('app-')).sort(), ['app-2026-10-09_2355.db.gz', 'app-2026-10-10_2355.db.gz']);
    pruneBackups(dir, 'app', 1);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('app-')).length, 1);
  } finally { await w.close(); }
});

// ---------- Ventana de 180 días, sin tope de 2.000 ----------
import { RECORD_RETENTION_DAYS } from '../src/shared/constants.js';

const insertSale = (w, id, daysAgo, amount, voided = 0) => {
  const created_at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const rec = { id, kind: 'sale', op_id: `op-${id}`, created_at, voided: !!voided, amount, cost: amount / 2, payment_method_id: 'pm-cash',
    lines: [{ product_id: 'p1', qty: 1, unit_price: amount, unit_cost: amount / 2, delta: -1 }] };
  w.db.prepare('INSERT INTO records (org_id,id,kind,op_id,data,voided,created_at) VALUES (?,?,?,?,?,?,?)').run(w.org.org_id, id, 'sale', rec.op_id, JSON.stringify(rec), voided, created_at);
};

test('sin tope de 2.000: el equipo recibe TODAS las ventas de los últimos 180 días (y nada más antiguo)', async () => {
  const w = await world();
  try {
    w.db.exec('BEGIN');
    for (let i = 0; i < 2600; i++) insertSale(w, `rec-${i}`, (i % 170) + 0.5, 1000);          // 2.600 ventas dentro de la ventana
    for (let i = 0; i < 40; i++) insertSale(w, `old-${i}`, 200 + i, 1000);                      // 40 ventas más viejas que 180 días
    w.db.exec('COMMIT');
    const A = await w.device('A', 'owner');
    assert.equal((await A.engine.sync()).ok, true);
    const v = await A.engine.getView();
    assert.equal(Object.values(v.records).filter((r) => r.kind === 'sale').length, 2600, 'más de 2.000 y ninguna se pierde');
    assert.equal(Object.keys(v.records).filter((k) => k.startsWith('old-')).length, 0);
    assert.ok(v.coverage.records_since);
    const days = (Date.now() - Date.parse(v.coverage.records_since)) / 86_400_000;
    assert.ok(Math.abs(days - RECORD_RETENTION_DAYS) < 0.1);
    assert.equal(A.engine.healCount, 0, 'la huella coincide con ventana y datos de distinto tamaño');
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(A.engine.healCount, 0);
  } finally { await w.close(); }
});

test('semanas anteriores a la ventana: el servidor calcula el reporte exacto (el equipo no las tiene)', async () => {
  const w = await world();
  try {
    const old = new Date(Date.now() - 300 * 86_400_000);
    const start = weekStart(old);
    const at = (d) => new Date(start.getTime() + d * 86_400_000 + 3_600_000).toISOString(); // dentro de esa semana
    const put = (id, kind, amount, d, voided = 0, cost = 0) => {
      const rec = { id, kind, op_id: `op-${id}`, created_at: at(d), voided: !!voided, amount, cost, payment_method_id: kind === 'sale' ? 'pm-cash' : 'pm-transfer',
        lines: kind === 'sale' ? [{ product_id: 'p1', qty: 2, unit_price: amount / 2, unit_cost: cost / 2, delta: -2 }] : [], note: kind };
      w.db.prepare('INSERT INTO records (org_id,id,kind,op_id,data,voided,created_at) VALUES (?,?,?,?,?,?,?)').run(w.org.org_id, id, kind, rec.op_id, JSON.stringify(rec), voided, rec.created_at);
    };
    put('s1', 'sale', 10000, 0, 0, 6000); put('s2', 'sale', 4000, 3, 0, 2000); put('s3', 'sale', 99999, 2, 1, 1); // la anulada no cuenta
    put('e1', 'expense', 1500, 4);
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    const v = await A.engine.getView();
    assert.deepEqual(Object.keys(v.records).filter((k) => /^[se]\d$/.test(k)), [], 'el equipo no guarda esa semana');
    assert.ok(start < new Date(v.coverage.records_since), 'y lo sabe: está fuera de lo que cubre');
    const end = addDays(start, 7);
    const res = await A.api.weekReport(start.toISOString(), end.toISOString());
    assert.deepEqual([res.report.sales, res.report.cogs, res.report.gross, res.report.expenses, res.report.net], [14000, 8000, 6000, 1500, 4500]);
    assert.deepEqual(res.report.byMethod['pm-cash'], { in: 14000, out: 0 });
    assert.deepEqual(res.report.byMethod['pm-transfer'], { in: 0, out: 1500 });
    assert.equal(res.expenses.length, 1);
    // rango absurdo ⇒ rechazado
    await assert.rejects(A.api.weekReport(start.toISOString(), addDays(start, 40).toISOString()), (e) => e.status === 400);
    // el resultado es el MISMO que daría el cálculo local con esos registros
    const local = weeklyReport(w.db.prepare('SELECT data FROM records').all().map((r) => JSON.parse(r.data)), start);
    assert.equal(local.net, res.report.net);
  } finally { await w.close(); }
});

test('el equipo poda lo que sale de la ventana y avanza su cobertura (sin falsos "autocorrige")', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'owner');
    await A.engine.sync();
    const st = (await A.store.load()).state;
    st.records.viejo = { id: 'viejo', kind: 'sale', created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(), amount: 1, lines: [], voided: false };
    st.records.reciente = { id: 'reciente', kind: 'sale', created_at: new Date().toISOString(), amount: 1, lines: [], voided: false };
    st.coverage.records_since = null;
    await A.store.commit({ state: st });
    await A.engine.sale([line('p1', 1)]); await A.engine.sync();
    const after = (await A.store.load()).state;
    assert.equal(after.records.viejo, undefined, 'lo viejo se descartó del equipo');
    assert.ok(after.coverage.records_since);
    assert.equal(w.stock(), 99, 'el stock no depende de los registros guardados');
    assert.equal((await A.engine.getView()).stock.p1, 99);
  } finally { await w.close(); }
});

// ---------- Validación de hora y protección de datos del navegador ----------
import { tzOffsetMinutes, evaluateClock, needsInstallHint, isValidTimeZone } from '../src/shared/time.js';
import { checkClock } from '../src/client/clock.js';

test('desfase de zonas horarias (genérico, con horario de verano)', () => {
  assert.equal(tzOffsetMinutes('America/Bogota', new Date('2026-10-07T12:00:00Z')), -300);
  assert.equal(tzOffsetMinutes('America/Bogota', new Date('2026-01-07T12:00:00Z')), -300, 'esa zona no cambia de hora');
  assert.equal(tzOffsetMinutes('Europe/Berlin', new Date('2026-07-01T12:00:00Z')), 120);
  assert.equal(tzOffsetMinutes('Europe/Berlin', new Date('2026-01-01T12:00:00Z')), 60);
  assert.equal(tzOffsetMinutes('Asia/Kolkata', new Date('2026-01-01T12:00:00Z')), 330);
  assert.equal(isValidTimeZone('America/Bogota') && !isValidTimeZone('Marte/Olimpo') && !isValidTimeZone(''), true);
});

test('evaluar el reloj: correcto, adelantado/atrasado, zona equivocada, red lenta', () => {
  // En el test, la zona local del proceso es la del sistema; se prueba con la zona REAL del equipo y con otra distinta.
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = { serverNow: 1_800_000_000_000, t0: 1_800_000_000_000 - 100, t1: 1_800_000_000_000 + 100, serverTz: here };
  assert.deepEqual([evaluateClock(base).ok, evaluateClock(base).reason], [true, null]);
  const ahead = evaluateClock({ ...base, t0: base.t0 + 10 * 60_000, t1: base.t1 + 10 * 60_000 });
  assert.deepEqual([ahead.ok, ahead.reason, Math.round(ahead.skewMs / 60_000)], [false, 'clock', 10], 'equipo 10 min adelantado');
  const behind = evaluateClock({ ...base, t0: base.t0 - 3 * 3600_000, t1: base.t1 - 3 * 3600_000 });
  assert.deepEqual([behind.ok, behind.reason, Math.round(behind.skewMs / 3600_000)], [false, 'clock', -3], 'equipo 3 horas atrasado');
  assert.equal(evaluateClock({ ...base, t0: base.t0 + 4 * 60_000, t1: base.t1 + 4 * 60_000 }).ok, true, 'hasta 5 min se tolera');
  const otherTz = ['America/Bogota', 'Asia/Tokyo'].find((z) => tzOffsetMinutes(z, new Date(base.serverNow)) !== -new Date(base.serverNow).getTimezoneOffset());
  const wrongZone = evaluateClock({ ...base, serverTz: otherTz });
  assert.deepEqual([wrongZone.ok, wrongZone.reason], [false, 'timezone'], 'misma hora absoluta pero zona distinta a la del negocio');
  const slow = evaluateClock({ ...base, t0: base.t0 - 40_000 });
  assert.deepEqual([slow.ok, slow.unknown], [true, true], 'con red muy lenta no se puede medir: no se bloquea');
});

test('el servidor publica su hora y la zona del negocio; el cliente la compara (sin sesión)', async () => {
  const w = await world();
  try {
    const t = await (await fetch(`${w.baseUrl}/api/time`)).json();
    assert.ok(Math.abs(t.now - Date.now()) < 5000);
    const prev = process.env.TIMEZONE;
    try {
      delete process.env.TIMEZONE;
      assert.equal((await (await fetch(`${w.baseUrl}/api/time`)).json()).timezone, 'UTC', 'sin configurar: valor neutro');
      process.env.TIMEZONE = 'Europe/Madrid';
      assert.equal((await (await fetch(`${w.baseUrl}/api/time`)).json()).timezone, 'Europe/Madrid', 'sale de TIMEZONE (.env)');
    } finally { if (prev === undefined) delete process.env.TIMEZONE; else process.env.TIMEZONE = prev; }
    w.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('timezone','America/Mexico_City')").run();
    assert.equal((await (await fetch(`${w.baseUrl}/api/time`)).json()).timezone, 'America/Mexico_City');
    w.db.prepare("DELETE FROM meta WHERE key='timezone'").run();

    const api = new ApiClient({ baseUrl: w.baseUrl });
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    w.db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('timezone',?)").run(here); // la zona de esta máquina de pruebas
    assert.equal((await checkClock(api)).ok, true, 'reloj bien');
    const bad = await checkClock(api, { nowFn: () => Date.now() + 30 * 60_000 });             // equipo 30 min adelantado
    assert.deepEqual([bad.ok, bad.reason], [false, 'clock']);
    assert.ok(bad.skewMs > 29 * 60_000);
    const off = await checkClock(new ApiClient({ baseUrl: 'http://127.0.0.1:1' }));          // sin conexión: no se puede comprobar
    assert.deepEqual([off.ok, off.unknown], [true, true]);
  } finally { await w.close(); }
});

test('admin: zona horaria del negocio configurable y validada', async () => {
  const w = await world();
  try {
    const { execFileSync } = await import('node:child_process');
    const run = (...a) => execFileSync(process.execPath, ['scripts/admin.js', ...a], { env: { ...process.env, DB_PATH: w.dbFile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run('set-timezone', 'America/Lima'), /America\/Lima/);
    assert.equal(w.db.prepare("SELECT value FROM meta WHERE key='timezone'").get().value, 'America/Lima');
    assert.throws(() => run('set-timezone', 'Marte/Olimpo'));
  } finally { await w.close(); }
});

test('sugerir instalar la app solo en iPhone/iPad sin instalar (Safari borra datos de sitios sin uso)', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1';
  assert.equal(needsInstallHint({ ua: iphone, standalone: false }), true);
  assert.equal(needsInstallHint({ ua: iphone, standalone: true }), false, 'ya instalada: Safari no la borra');
  assert.equal(needsInstallHint({ ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) Chrome/130 Mobile Safari/537.36', standalone: false }), false);
  assert.equal(needsInstallHint({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPad que se presenta como Mac');
  assert.equal(needsInstallHint({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 0 }), false, 'Mac normal');
});

// ---------- Visor de datos: toma el puerto de un visor anterior, pero nunca cierra otro programa ----------
import { spawn } from 'node:child_process';

const startViewer = (dbFile, port) => {
  const p = spawn(process.execPath, ['scripts/db-web.js'], { env: { ...process.env, DB_PATH: dbFile, DB_WEB_PORT: String(port) } });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  return { p, out: () => out, exited: new Promise((r) => p.on('exit', (code) => r(code))) };
};
const waitFor = async (cond, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('visor: si el puerto lo ocupa un visor anterior, lo cierra y abre uno nuevo; un programa ajeno NO se toca', async () => {
  const w = await world();
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const cleanup = [];
  try {
    const v1 = startViewer(w.dbFile, port); cleanup.push(v1.p);
    assert.ok(await waitFor(() => v1.out().includes('Visor de solo lectura')), 'el primero abre');
    const token1 = /t=([0-9a-f]+)/.exec(v1.out())[1];
    assert.equal((await fetch(`http://127.0.0.1:${port}/?t=${token1}`)).status, 200);

    const v2 = startViewer(w.dbFile, port); cleanup.push(v2.p);                                   // mismo puerto
    assert.ok(await waitFor(() => /Visor de solo lectura/.test(v2.out())), `el segundo abre: ${v2.out()}`);
    assert.match(v2.out(), /Había un visor anterior abierto/);
    assert.equal(await Promise.race([v1.exited, new Promise((r) => setTimeout(() => r('sigue vivo'), 4000))]) !== 'sigue vivo', true, 'el primero se cerró');
    const token2 = /t=([0-9a-f]+)/.exec(v2.out())[1];
    assert.notEqual(token1, token2);
    assert.equal((await fetch(`http://127.0.0.1:${port}/?t=${token2}`)).status, 200, 'responde el nuevo');
    assert.equal((await fetch(`http://127.0.0.1:${port}/?t=${token1}`)).status, 403, 'el token viejo ya no sirve');
    v2.p.kill();

    // un programa que NO es el visor ocupa el puerto: no se cierra, y el visor avisa y sale
    const port2 = port + 1;
    const other = spawn(process.execPath, ['-e', `require("net").createServer().listen(${port2}, "127.0.0.1"); setInterval(() => {}, 1000)`]);
    cleanup.push(other);
    await new Promise((r) => setTimeout(r, 400));
    const v3 = startViewer(w.dbFile, port2);
    assert.equal(await v3.exited, 1);
    assert.match(v3.out(), /no es el visor de datos/);
    assert.equal(other.exitCode, null, 'el programa ajeno sigue vivo');
  } finally { for (const c of cleanup) c.kill(); await w.close(); }
});

// ---------- Configuración (.env), plantillas y despliegue genérico ----------
import { config, ROOT } from '../src/server/config.js';
import { execFileSync as run } from 'node:child_process';

const withEnv = async (vars, fn) => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('sin configurar, los valores por defecto son neutros (nada de un negocio concreto)', async () => {
  await withEnv({ APP_NAME: undefined, APP_SHORT_NAME: undefined, THEME_COLOR: undefined, TIMEZONE: undefined, LOCALE: undefined, CURRENCY: undefined, ORG_NAME: undefined,
    OWNER_USERNAME: undefined, DOMAIN: undefined, PORT: undefined, SERVICE_NAME: undefined, BACKUP_TIME: undefined, BACKUP_TZ: undefined, GEO_LOOKUP: undefined, TRUST_PROXY: undefined }, () => {
    assert.deepEqual([config.appName, config.timezone, config.locale, config.currency, config.orgName, config.ownerUsername, config.port, config.serviceName, config.backupTime, config.backupTz],
      ['Inventario', 'UTC', 'es', 'USD', 'Mi Negocio', 'admin', 8095, 'manage-storage', '23:55', 'UTC']);
    assert.deepEqual([config.geoLookup, config.trustProxy], [true, true]);
  });
  await withEnv({ THEME_COLOR: 'rojo', BACKUP_TIME: '25h', GEO_LOOKUP: 'off', TRUST_PROXY: '0', PORT: 'abc' }, () => {
    assert.deepEqual([config.themeColor, config.backupTime, config.geoLookup, config.trustProxy, config.port], ['#14532d', '23:55', false, false, 8095], 'valores inválidos caen al defecto');
  });
});

test('la identidad (nombre, color, moneda, idioma) sale del .env: index.html y manifest se rellenan, escapados, y cambian la versión de la app', async () => {
  const w = await world();
  try {
    await withEnv({ APP_NAME: 'Mi "Tienda" <b>', APP_SHORT_NAME: 'Tienda', THEME_COLOR: '#112233', LOCALE: 'es-MX', CURRENCY: 'MXN' }, async () => {
      const html = await (await fetch(`${w.baseUrl}/`)).text();
      assert.ok(!html.includes('{{'), 'sin marcadores sin reemplazar');
      assert.ok(html.includes('<title>Mi &quot;Tienda&quot; &lt;b&gt;</title>'), 'el nombre se escapa (sin inyección de HTML)');
      assert.ok(!html.includes('<b>'));
      assert.ok(html.includes('<html lang="es-MX">') && html.includes('content="#112233"'));
      const meta = /<meta name="app-config" content="([^"]*)">/.exec(html)[1].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      assert.deepEqual(JSON.parse(meta), { appName: 'Mi "Tienda" <b>', locale: 'es-MX', currency: 'MXN', themeColor: '#112233' });
      const man = await (await fetch(`${w.baseUrl}/manifest.webmanifest`)).json();
      assert.deepEqual([man.name, man.short_name, man.theme_color, man.background_color], ['Mi "Tienda" <b>', 'Tienda', '#112233', '#112233']);
      const build1 = (await (await fetch(`${w.baseUrl}/api/health`)).json()).build;
      process.env.APP_NAME = 'Otro Nombre';
      const build2 = (await (await fetch(`${w.baseUrl}/api/health`)).json()).build;
      assert.notEqual(build1, build2, 'cambiar la identidad cambia la versión: los equipos instalados se actualizan');
    });
  } finally { await w.close(); }
});

test('plantillas de despliegue: sin rutas ni nombres propios; el instalador y el generador de Caddy usan .env', () => {
  const env = (vars) => ({ ...process.env, ...vars });
  const out = run(process.execPath, ['scripts/install-service.js', '--print'], { cwd: ROOT, encoding: 'utf8', env: env({ SERVICE_NAME: 'demo', APP_NAME: 'Demo App', TIMEZONE: 'Europe/Madrid', BACKUP_TIME: '2:30' }) });
  assert.match(out, /# ===== demo\.service =====/);
  assert.match(out, /# ===== demo-backup\.timer =====/);
  assert.ok(out.includes('OnCalendar=*-*-* 02:30:00 Europe/Madrid'), 'respaldo a la hora y zona configuradas');
  assert.ok(out.includes(`ExecStart=${ROOT}/ms start`) && out.includes('Description=Demo App'));
  assert.ok(!out.includes('@'), 'ningún marcador sin reemplazar');
  const caddy = run(process.execPath, ['scripts/print-caddy.js'], { cwd: ROOT, encoding: 'utf8', env: env({ DOMAIN: 'tienda.example.org', PORT: '9000', APP_NAME: 'Demo App' }), stdio: ['ignore', 'pipe', 'ignore'] });
  assert.ok(caddy.includes('tienda.example.org {') && caddy.includes('reverse_proxy 127.0.0.1:9000'));
});

test('higiene del repositorio: .env.example documenta toda variable que lee el código y .gitignore protege secretos y datos', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  const names = [...read('src/server/config.js').matchAll(/(?:str|num|flag)\('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 15);
  const example = read('.env.example');
  for (const n of new Set(names)) if (n !== 'BACKUP_TZ') assert.match(example, new RegExp(`^${n}=`, 'm'), `falta ${n} en .env.example`);

  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  for (const must of ['.env', 'data/', '*.db', '*.db.gz', 'AGENTS.local.md', 'node_modules/', '!.env.example']) assert.ok(ignore.includes(must), `.gitignore debe incluir ${must}`);

  // Ningún archivo versionable debe traer datos de una instalación concreta: dominios dinámicos ni IPs públicas.
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((e) => (statSync(join(ROOT, d, e)).isDirectory() ? walk(`${d}/${e}`) : [`${d}/${e}`]));
  const files = [...['src', 'scripts', 'public', 'deploy', 'docs', '.opencode'].flatMap(walk), 'README.md', 'AGENTS.md', '.env.example', 'ms', 'package.json', 'opencode.json']
    .filter((f) => /\.(js|json|md|html|css|webmanifest|template|svg)$|\/ms$|^ms$|^\.env\.example$/.test(f));
  const okIp = /^(127\.|10\.|0\.0\.0\.0|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  const bad = [];
  for (const f of files) {
    const t = read(f);
    if (/duckdns\.org/.test(t)) bad.push(`${f}: dominio dinámico`);
    for (const m of t.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) if (!okIp.test(m[0]) && !/^(1\.2\.3\.4|8\.8\.8\.8|255\.)/.test(m[0]) && !/\d+\.\d+\.\d+\.\d+\/ms|node-v/.test(m[0])) bad.push(`${f}: IP ${m[0]}`);
  }
  assert.deepEqual(bad.filter((b) => !/IP \d+\.\d+\.\d+\.\d+$/.test(b) || !/^(src\/shared\/validate|docs\/)/.test(b)), [], 'datos privados en archivos versionables');
});

test('visor de datos: tablas con ancho natural y desplazamiento (no se aprietan) y vista de tarjetas con todos los campos', async () => {
  const w = await world();
  const port = 19_000 + Math.floor(Math.random() * 900);
  const v = startViewer(w.dbFile, port);
  try {
    await w.device('A', 'owner');
    assert.ok(await waitFor(() => v.out().includes('Visor de solo lectura')));
    const t = /t=([0-9a-f]+)/.exec(v.out())[1];
    const html = await (await fetch(`http://127.0.0.1:${port}/t/dispositivos?t=${t}`)).text();
    assert.match(html, /white-space:nowrap/, 'las celdas no parten el texto');
    assert.match(html, /width:max-content/, 'la tabla toma el ancho de su contenido y se desplaza');
    assert.ok(!html.includes('overflow-wrap:anywhere;font-family'), 'ya no se aplastan las columnas');
    assert.match(html, /title="[^"]+"/, 'valor completo al pasar el mouse');
    assert.match(html, /v=cards/, 'hay botón para ver tarjetas');

    const cards = await (await fetch(`http://127.0.0.1:${port}/t/dispositivos?t=${t}&v=cards`)).text();
    assert.match(cards, /<div class="card">/);
    assert.match(cards, /<th>usuario<\/th><td>owner<\/td>/);
    assert.ok(!cards.includes('<th>tipo</th>'), 'un campo vacío (el cliente de pruebas no manda tipo) no aparece');
    assert.ok(!cards.includes('<td class="nul"'), 'en tarjetas los campos vacíos se ocultan');
    assert.match(cards, /campos vacíos ocultos/);
    assert.match(cards, /v=table/, 'y se puede volver a la tabla');
    const q = await (await fetch(`http://127.0.0.1:${port}/q?t=${t}&sql=${encodeURIComponent('select * from dispositivos')}&v=cards`)).text();
    assert.match(q, /<div class="card">/, 'también en los resultados de una consulta');
  } finally { v.p.kill(); await w.close(); }
});
