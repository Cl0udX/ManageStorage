// Entorno de pruebas: servidor real en proceso (SQLite en memoria) + dispositivos con red controlable.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db/db.js';
import { createApp } from '../src/server/http/server.js';
import { createOrganization, createUser } from '../src/server/auth/auth.js';
import { serverApply } from '../src/server/sync/service.js';
import { ApiClient } from '../src/client/api/api-client.js';
import { SyncEngine } from '../src/client/sync/engine.js';
import { MemoryStore } from '../src/client/persistence/memory-store.js';
import { FileStore } from '../src/client/persistence/file-store.js';

/** fetch con fallos inyectables: offline, caída antes de enviar, o respuesta perdida tras procesar. */
export function makeNet(baseUrl) {
  const net = {
    online: true, failBefore: 0, dropResponse: 0, dropWhen: (url) => url.includes('/sync/push'),
    async fetch(url, init) {
      if (!net.online) throw new TypeError('offline');
      if (net.failBefore > 0) { net.failBefore -= 1; throw new TypeError('connection reset before send'); }
      const res = await fetch(url, init);
      if (net.dropResponse > 0 && net.dropWhen(url)) { net.dropResponse -= 1; await res.arrayBuffer(); throw new TypeError('response lost'); }
      return res;
    },
  };
  return net;
}

export async function world({ withProduct = true } = {}) {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'ms-db-')), 'test.db');
  const db = openDb(dbFile);
  const org = createOrganization(db, { name: 'Org1', ownerUsername: 'owner', ownerPassword: 'owner-pass' });
  createUser(db, { org_id: org.org_id, username: 'staffa', password: 'pass-a' });
  createUser(db, { org_id: org.org_id, username: 'staffb', password: 'pass-b' });
  if (withProduct) {
    serverApply(db, org.org_id, org.user_id, 'ENTITY_CREATE', 'product', 'p1', { data: { name: 'Cerveza', price: 5000, cost: 3000 } });
    serverApply(db, org.org_id, org.user_id, 'STOCK_ADJUST', 'adjustment', 'adj-init', { product_id: 'p1', delta: 100, reason: 'inventario inicial' });
  }
  const server = createApp(db, { trustProxy: false, loginMax: 10_000, geo: { enabled: false } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'ms-test-'));
  const pass = { owner: 'owner-pass', staffa: 'pass-a', staffb: 'pass-b' };
  let n = 0;

  const w = {
    db, dbFile, org, baseUrl, server, dir,
    stock: (pid = 'p1', org_id = org.org_id) =>
      db.prepare('SELECT COALESCE(SUM(delta),0) s FROM inventory_movements WHERE org_id=? AND product_id=?').get(org_id, pid).s,
    opCount: (type) => db.prepare('SELECT COUNT(*) c FROM operations WHERE op_type=?').get(type).c,
    entity: (id = 'p1') => {
      const r = db.prepare("SELECT * FROM entities WHERE type='product' AND id=?").get(id);
      return { ...JSON.parse(r.data), version: r.version };
    },
    async device(name, username, { file = false, store } = {}) {
      const deviceId = `device-${name}-${++n}`;
      const net = makeNet(baseUrl);
      const tok = { t: null };
      store ??= file ? new FileStore(join(dir, `${deviceId}.json`)) : new MemoryStore();
      const api = new ApiClient({ baseUrl, fetch: (u, i) => net.fetch(u, i), getToken: () => tok.t, getEpoch: async () => (await store.load()).meta.epoch });
      const d = { name, username, deviceId, net, tok, api, store, userId: null };
      d.login = async () => {
        const r = await api.login(username, pass[username], deviceId, name);
        tok.t = r.token; d.userId = r.user.id;
        return r;
      };
      await d.login();
      d.makeEngine = (st = d.store) => new SyncEngine({ store: st, api, deviceId, userId: d.userId });
      d.engine = d.makeEngine();
      return d;
    },
    async close() { await new Promise((r) => server.close(r)); db.close(); },
  };
  return w;
}

export const line = (product_id, qty, unit_price = 5000) => ({ product_id, qty, unit_price });

/** Operación cruda válida (para probar el protocolo sin pasar por el motor). */
export function rawOp(deviceId, device_seq, over = {}) {
  return {
    op_id: `raw-${deviceId}-${device_seq}-${Math.random().toString(36).slice(2, 8)}`,
    device_id: deviceId, device_seq, user_id: 'x',
    entity_type: 'sale', entity_id: `sale-${deviceId}-${device_seq}`, op_type: 'SALE_CREATE',
    payload: { lines: [line('p1', 1)] }, base_version: null, created_at: new Date().toISOString(),
    ...over,
  };
}
