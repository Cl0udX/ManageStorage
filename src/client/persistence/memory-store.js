// Almacén local en memoria. Misma interfaz que IdbStore. FileStore lo extiende para simular
// persistencia real (reinicio del dispositivo) en tests/Node.
import { emptyState } from '../../domain/state.js';

export const defaultMeta = () => ({ next_device_seq: 1, cursor: null, state_schema: null, epoch: null, session: null, device_id: null });

export class MemoryStore {
  constructor(initial) {
    this.meta = initial?.meta ?? defaultMeta();
    this.state = initial?.state ?? emptyState();
    this.ops = new Map((initial?.ops ?? []).map((o) => [o.op_id, o]));
  }

  async _persist() {}

  async load() {
    return structuredClone({ meta: this.meta, state: this.state, ops: [...this.ops.values()] });
  }

  /** Atómico: asigna device_seq y guarda la op en un solo paso. */
  async enqueueOp(op) {
    const stored = { ...structuredClone(op), device_seq: this.meta.next_device_seq };
    this.ops.set(stored.op_id, stored);
    this.meta.next_device_seq += 1;
    await this._persist();
    return structuredClone(stored);
  }

  async putOps(ops) {
    for (const o of ops) this.ops.set(o.op_id, structuredClone(o));
    await this._persist();
  }

  /** Atómico: estado + cursor/meta + purga de ops ya reflejadas. */
  async commit({ state, metaPatch, deleteOpIds = [], putOps = [] }) {
    if (state) this.state = structuredClone(state);
    if (metaPatch) this.meta = { ...this.meta, ...structuredClone(metaPatch) };
    for (const id of deleteOpIds) this.ops.delete(id);
    for (const o of putOps) this.ops.set(o.op_id, structuredClone(o));
    await this._persist();
  }

  async setMeta(patch) {
    this.meta = { ...this.meta, ...structuredClone(patch) };
    await this._persist();
  }
}
