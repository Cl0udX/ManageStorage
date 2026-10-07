// Almacén local en IndexedDB (navegador). Cada método es UNA transacción IDB → atómico y
// sobrevive a cierres/reinicios. Stores: kv ('meta','state') y ops (keyPath op_id).
import { emptyState } from '../../domain/state.js';
import { defaultMeta } from './memory-store.js';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class IdbStore {
  constructor({ name = 'manage-storage', idb = globalThis.indexedDB } = {}) {
    this.name = name; this.idb = idb; this._db = null;
  }

  _open() {
    this._db ??= new Promise((res, rej) => {
      const r = this.idb.open(this.name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('ops', { keyPath: 'op_id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._db;
  }

  async _run(mode, fn) {
    const db = await this._open();
    return new Promise((res, rej) => {
      const tx = db.transaction(['kv', 'ops'], mode);
      let out;
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error ?? new Error('tx aborted'));
      // Solo se hace await de requests IDB dentro de fn, para que la transacción siga activa.
      fn(tx.objectStore('kv'), tx.objectStore('ops')).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch {} rej(e); });
    });
  }

  async load() {
    return this._run('readonly', async (kv, ops) => ({
      meta: { ...defaultMeta(), ...((await req(kv.get('meta'))) ?? {}) },
      state: (await req(kv.get('state'))) ?? emptyState(),
      ops: await req(ops.getAll()),
    }));
  }

  async enqueueOp(op) {
    return this._run('readwrite', async (kv, ops) => {
      const meta = { ...defaultMeta(), ...((await req(kv.get('meta'))) ?? {}) };
      const stored = { ...op, device_seq: meta.next_device_seq };
      meta.next_device_seq += 1;
      await req(ops.put(stored));
      await req(kv.put(meta, 'meta'));
      return stored;
    });
  }

  async putOps(list) {
    return this._run('readwrite', async (_kv, ops) => { for (const o of list) await req(ops.put(o)); });
  }

  async commit({ state, metaPatch, deleteOpIds = [], putOps = [] }) {
    return this._run('readwrite', async (kv, ops) => {
      if (state) await req(kv.put(state, 'state'));
      if (metaPatch) {
        const meta = { ...defaultMeta(), ...((await req(kv.get('meta'))) ?? {}), ...metaPatch };
        await req(kv.put(meta, 'meta'));
      }
      for (const id of deleteOpIds) await req(ops.delete(id));
      for (const o of putOps) await req(ops.put(o));
    });
  }

  async setMeta(patch) { return this.commit({ metaPatch: patch }); }
}
