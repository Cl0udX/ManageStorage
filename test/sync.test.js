import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, line, rawOp } from './helpers.js';
import { ApiClient, ApiError } from '../src/client/api/api-client.js';
import { FileStore } from '../src/client/persistence/file-store.js';
import { join } from 'node:path';

const stockOf = async (d, pid = 'p1') => (await d.engine.getView()).stock[pid] ?? 0;

test('CRÍTICO: A vende 10 y B vende 5 offline → stock 85, ninguna operación se pierde', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const B = await w.device('B', 'staffb');
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal((await B.engine.sync()).ok, true);
    assert.equal(await stockOf(A), 100);
    assert.equal(await stockOf(B), 100);

    A.net.online = false; B.net.online = false;
    await A.engine.sale([line('p1', 10)]);
    await B.engine.sale([line('p1', 5)]);
    // Offline: cada uno ve su proyección local optimista
    assert.equal(await stockOf(A), 90);
    assert.equal(await stockOf(B), 95);
    // Intentar sincronizar offline no rompe nada ni pierde la cola
    const off = await A.engine.sync();
    assert.equal(off.ok, false); assert.equal(off.status, 'offline');
    assert.equal((await A.engine.stats()).pending, 1);

    A.net.online = true; B.net.online = true;
    await A.engine.sync(); await B.engine.sync(); await A.engine.sync();

    assert.equal(w.stock(), 85);
    assert.equal(w.opCount('SALE_CREATE'), 2);
    assert.equal(await stockOf(A), 85);
    assert.equal(await stockOf(B), 85);
    assert.equal((await A.engine.stats()).pending, 0);
    assert.equal((await B.engine.stats()).pending, 0);
  } finally { await w.close(); }
});

test('idempotencia: la misma operación enviada dos veces se aplica una sola vez', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 10)]);
    A.net.online = true;
    const { ops } = await A.store.load();
    const r1 = await A.api.push(ops);
    const r2 = await A.api.push(ops);
    assert.equal(r1.results[0].duplicate, undefined);
    assert.equal(r2.results[0].duplicate, true);
    assert.equal(r2.results[0].seq, r1.results[0].seq);
    assert.equal(w.stock(), 90);
    assert.equal(w.opCount('SALE_CREATE'), 1);
    // y el motor, que aún las ve pendientes, converge sin duplicar
    await A.engine.sync();
    assert.equal(w.stock(), 90);
    assert.equal(await stockOf(A), 90);
  } finally { await w.close(); }
});

test('conexión perdida durante sync: respuesta perdida tras procesar → reintento no duplica', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    await A.engine.sale([line('p1', 10)]);
    A.net.dropResponse = 1; // el servidor procesa el push pero el cliente no recibe la respuesta
    const r = await A.engine.sync();
    assert.equal(r.ok, false); assert.equal(r.status, 'offline');
    assert.equal(w.stock(), 90, 'el servidor ya la aplicó');
    assert.equal((await A.engine.stats()).pending, 1, 'el cliente sigue sin saberlo');
    assert.equal(await stockOf(A), 90, 'sin doble conteo en la vista local');

    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 90);
    assert.equal(w.opCount('SALE_CREATE'), 1);
    assert.equal(await stockOf(A), 90);
    assert.equal((await A.engine.stats()).pending, 0);
  } finally { await w.close(); }
});

test('conexión perdida antes de enviar: se conserva y se envía después', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    await A.engine.sale([line('p1', 4)]);
    A.net.failBefore = 1;
    assert.equal((await A.engine.sync()).ok, false);
    assert.equal(w.stock(), 100);
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 96);
  } finally { await w.close(); }
});

test('dispositivo reiniciado antes de sync: la cola sobrevive en disco y continúa device_seq', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa', { file: true });
    await A.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 7)]);
    await A.engine.sale([line('p1', 3)]);

    // "Reinicio": se descarta todo y se reabre el almacén desde el archivo
    const reopened = new FileStore(join(w.dir, `${A.deviceId}.json`));
    const engine2 = A.makeEngine(reopened);
    const s = await engine2.stats();
    assert.equal(s.pending, 2);
    assert.equal((await engine2.getView()).stock.p1, 90);
    await engine2.sale([line('p1', 1)]);
    const seqs = (await reopened.load()).ops.map((o) => o.device_seq).sort();
    assert.deepEqual(seqs, [1, 2, 3]);

    A.net.online = true;
    assert.equal((await engine2.sync()).ok, true);
    assert.equal(w.stock(), 89);
    assert.equal((await engine2.stats()).pending, 0);
  } finally { await w.close(); }
});

test('operaciones simultáneas desde varios dispositivos: ninguna se pierde', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const B = await w.device('B', 'staffb');
    await Promise.all([A.engine.sync(), B.engine.sync()]);
    A.net.online = false; B.net.online = false;
    for (let i = 0; i < 20; i++) { await A.engine.sale([line('p1', 1)]); await B.engine.sale([line('p1', 2)]); }
    A.net.online = true; B.net.online = true;
    await Promise.all([A.engine.sync(), B.engine.sync()]);
    await Promise.all([A.engine.sync(), B.engine.sync()]);
    assert.equal(w.opCount('SALE_CREATE'), 40);
    assert.equal(w.stock(), 100 - 20 - 40);
    assert.equal(await stockOf(A), 40);
    assert.equal(await stockOf(B), 40);
  } finally { await w.close(); }
});

test('conflicto de edición: campos distintos se fusionan; el mismo campo genera conflicto explícito sin perder datos', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const B = await w.device('B', 'staffb');
    const O = await w.device('O', 'owner');
    for (const d of [A, B, O]) await d.engine.sync();
    A.net.online = false; B.net.online = false;
    await A.engine.updateEntity('product', 'p1', { price: 6000 });
    await B.engine.updateEntity('product', 'p1', { price: 7000, name: 'Cerveza Premium' });
    A.net.online = true; B.net.online = true;
    await A.engine.sync();
    await B.engine.sync();

    // price: A ganó primero; B queda como conflicto. name: se fusionó.
    assert.deepEqual([w.entity().price, w.entity().name], [6000, 'Cerveza Premium']);
    const open = w.db.prepare("SELECT * FROM conflicts WHERE status='open'").all();
    assert.equal(open.length, 1);
    assert.equal(open[0].field, 'price');
    assert.equal(JSON.parse(open[0].server_value), 6000);
    assert.equal(JSON.parse(open[0].client_value), 7000, 'el valor de B no se perdió');
    const bOp = w.db.prepare("SELECT status, payload FROM operations WHERE op_id=?").get(open[0].op_id);
    assert.equal(bOp.status, 'partial');
    assert.equal(JSON.parse(bOp.payload).changes.price, 7000, 'la op original sigue intacta en el log');

    await B.engine.sync();
    assert.equal(Object.keys((await B.engine.getView()).conflicts).length, 1);
    assert.equal((await B.engine.getView()).entities.product.p1.price, 6000);

    // Solo el owner puede resolver
    await assert.rejects(B.api.resolveConflict(open[0].id, 'client'), (e) => e instanceof ApiError && e.status === 403);
    await O.api.resolveConflict(open[0].id, 'client');
    assert.equal(w.entity().price, 7000);
    assert.equal(w.db.prepare("SELECT status FROM conflicts WHERE id=?").get(open[0].id).status, 'resolved');
    await A.engine.sync(); await B.engine.sync();
    assert.equal((await A.engine.getView()).entities.product.p1.price, 7000);
    assert.equal((await B.engine.getView()).entities.product.p1.price, 7000);
    assert.equal(Object.values((await B.engine.getView()).conflicts).filter((c) => c.status === 'open').length, 0);
  } finally { await w.close(); }
});

test('ediciones sucesivas del mismo dispositivo no chocan consigo mismas', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    A.net.online = false;
    await A.engine.updateEntity('product', 'p1', { price: 6000 });
    await A.engine.updateEntity('product', 'p1', { price: 6500 });
    A.net.online = true;
    await A.engine.sync();
    assert.equal(w.entity().price, 6500);
    assert.equal(w.db.prepare('SELECT COUNT(*) c FROM conflicts').get().c, 0);
  } finally { await w.close(); }
});

test('dispositivo offline varios días: sesión vencida y cola vieja se recuperan sin pérdida', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const B = await w.device('B', 'staffb');
    await A.engine.sync(); await B.engine.sync();
    A.net.online = false;
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000);
    A.engine.now = () => fiveDaysAgo;
    await A.engine.sale([line('p1', 3)]);
    A.engine.now = () => new Date();

    // Mientras tanto, B trabaja y la sesión de A vence
    for (let i = 0; i < 5; i++) await B.engine.sale([line('p1', 1)]);
    await B.engine.sync();
    w.db.prepare('UPDATE sessions SET expires_at=? WHERE device_id=?').run(new Date(Date.now() - 1000).toISOString(), A.deviceId);

    A.net.online = true;
    const r = await A.engine.sync();
    assert.equal(r.status, 'auth_required');
    assert.equal((await A.engine.stats()).pending, 1, 'la cola se conserva');

    await A.login(); // mismo device_id
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 100 - 3 - 5);
    assert.equal(await stockOf(A), 92);
    const row = w.db.prepare("SELECT created_at, received_at FROM operations WHERE device_id=? AND op_type='SALE_CREATE'").get(A.deviceId);
    assert.equal(row.created_at, fiveDaysAgo.toISOString(), 'la hora de negocio original se conserva');
    assert.ok(row.received_at > row.created_at);
  } finally { await w.close(); }
});

test('cursor demasiado viejo (410): re-snapshot conservando operaciones pendientes', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const B = await w.device('B', 'staffb');
    await A.engine.sync(); await B.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 3)]);
    for (let i = 0; i < 4; i++) await B.engine.sale([line('p1', 1)]);
    await B.engine.sync();
    const head = w.db.prepare('SELECT MAX(seq) s FROM operations').get().s;
    w.db.prepare("INSERT INTO meta (key,value) VALUES ('min_seq',?)").run(String(head)); // log compactado
    A.net.online = true;
    assert.equal((await A.engine.sync()).ok, true);
    assert.equal(w.stock(), 100 - 3 - 4);
    assert.equal(await stockOf(A), 93);
    assert.equal((await A.engine.stats()).pending, 0);
  } finally { await w.close(); }
});

test('anulación: movimientos compensatorios, idempotente, nada se borra', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    const sale = await A.engine.sale([line('p1', 10)]);
    await A.engine.sync();
    assert.equal(w.stock(), 90);
    A.net.online = false;
    await A.engine.voidOp(sale.op_id, 'error de caja');
    assert.equal(await stockOf(A), 100, 'la vista offline ya refleja la anulación');
    A.net.online = true;
    await A.engine.sync();
    assert.equal(w.stock(), 100);
    // Anular otra vez (op distinta) es no-op
    const { results } = await A.api.push([rawOp(A.deviceId, 3, { op_type: 'OP_VOID', entity_type: 'void', entity_id: 'v2', payload: { target_op_id: sale.op_id } })]);
    assert.equal(results[0].reason, 'already_voided');
    assert.equal(w.stock(), 100);
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM operations WHERE op_type='SALE_CREATE'").get().c, 1, 'la venta original sigue en el log');
    assert.equal(w.db.prepare("SELECT COUNT(*) c FROM inventory_movements WHERE reason='void'").get().c, 1);
  } finally { await w.close(); }
});

test('producto creado offline y vendido en el mismo dispositivo: respeta el orden', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    A.net.online = false;
    const { id } = await A.engine.createEntity('product', { name: 'Maní', price: 2000 });
    await A.engine.purchase([{ product_id: id, qty: 10, unit_cost: 1000 }]);
    await A.engine.sale([line(id, 4, 2000)]);
    assert.equal(await stockOf(A, id), 6);
    A.net.online = true;
    await A.engine.sync();
    assert.equal(w.stock(id), 6);
    assert.equal((await A.engine.getView()).entities.product[id].name, 'Maní');
  } finally { await w.close(); }
});

test('protocolo: hueco en device_seq detiene el proceso; payload inválido se guarda como rechazado', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const early = await A.api.push([rawOp(A.deviceId, 3)]);
    assert.ok(early.halted);
    assert.equal(early.halted.expected_device_seq, 1);
    assert.equal(w.opCount('SALE_CREATE'), 0);

    const bad = rawOp(A.deviceId, 1, { payload: { lines: [{ product_id: 'p1', qty: -5, unit_price: 1 }] } });
    const ok = rawOp(A.deviceId, 2);
    const r = await A.api.push([ok, bad]); // desordenadas a propósito
    assert.deepEqual(r.results.map((x) => x.status), ['rejected', 'applied']);
    assert.equal(r.results[0].persisted, true);
    assert.equal(w.db.prepare("SELECT status FROM operations WHERE op_id=?").get(bad.op_id).status, 'rejected');
    assert.equal(w.stock(), 99);
    // una op con seq ya usado no se acepta
    const stale = await A.api.push([rawOp(A.deviceId, 2)]);
    assert.equal(stale.results[0].reason, 'device_seq_stale');
  } finally { await w.close(); }
});

test('aislamiento entre organizaciones', async () => {
  const w = await world();
  try {
    const { createOrganization } = await import('../src/server/auth/auth.js');
    createOrganization(w.db, { name: 'Org2', ownerUsername: 'owner2', ownerPassword: 'owner2-pass' });
    const api2 = new ApiClient({ baseUrl: w.baseUrl });
    const l = await api2.login('owner2', 'owner2-pass', 'device-org2-001', 'x');
    const c2 = new ApiClient({ baseUrl: w.baseUrl, getToken: () => l.token });

    const snap = await c2.snapshot();
    assert.deepEqual(snap.state.entities.product, {}, 'no ve productos de Org1');
    const r = await c2.push([rawOp('device-org2-001', 1)]); // vende p1 de Org1
    assert.match(r.results[0].reason, /unknown_product/);
    assert.equal(w.stock(), 100, 'stock de Org1 intacto');
    const pulled = await c2.pull(0);
    assert.ok(pulled.ops.every((o) => o.device_id === 'device-org2-001'), 'no ve el log de Org1');

    const A = await w.device('A', 'staffa');
    const sale = await A.engine.sale([line('p1', 1)]);
    await A.engine.sync();
    const dup = await c2.push([rawOp('device-org2-001', 2, { op_id: sale.op_id })]);
    assert.equal(dup.results[0].reason, 'op_id_conflict');
    const devs = await c2.devices(); // owner2 solo ve los dispositivos de su organización
    assert.deepEqual(devs.devices.map((d) => d.id), ['device-org2-001']);
  } finally { await w.close(); }
});

test('dispositivo revocado: no puede sincronizar ni iniciar sesión; su cola local se conserva', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    const O = await w.device('O', 'owner');
    await A.engine.sync();
    A.net.online = false;
    await A.engine.sale([line('p1', 2)]);
    await O.api.revokeDevice(A.deviceId);
    A.net.online = true;
    const r = await A.engine.sync();
    assert.equal(r.status, 'revoked');
    assert.equal((await A.engine.stats()).pending, 1);
    assert.equal(w.stock(), 100);
    await assert.rejects(A.login(), (e) => e.status === 403 && e.code === 'device_revoked');
  } finally { await w.close(); }
});

test('autenticación: credenciales inválidas y sin token', async () => {
  const w = await world();
  try {
    const api = new ApiClient({ baseUrl: w.baseUrl });
    await assert.rejects(api.login('staffa', 'mala', 'device-xyz-0001', 'x'), (e) => e.status === 401);
    await assert.rejects(api.snapshot(), (e) => e.status === 401);
  } finally { await w.close(); }
});

test('el inventario se reconstruye desde movimientos y coincide con el snapshot', async () => {
  const w = await world();
  try {
    const A = await w.device('A', 'staffa');
    await A.engine.sync();
    await A.engine.sale([line('p1', 10)]);
    await A.engine.purchase([{ product_id: 'p1', qty: 25, unit_cost: 3000 }]);
    await A.engine.adjustStock('p1', -2, 'merma');
    await A.engine.expense(15000, 'hielo');
    await A.engine.sync();
    const snap = await A.api.snapshot();
    assert.equal(snap.state.stock.p1, 100 - 10 + 25 - 2);
    assert.equal(snap.state.stock.p1, w.stock());
    assert.equal(Object.values(snap.state.records).find((r) => r.kind === 'expense').amount, 15000);
  } finally { await w.close(); }
});
