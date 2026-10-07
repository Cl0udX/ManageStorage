// Motor de sincronización del cliente: cola local de operaciones + push/pull idempotentes.
import { OP, STATE_SCHEMA, RECORD_RETENTION_DAYS } from '../../shared/constants.js';
import { applyEffects, projectView, emptyState, pruneRecords } from '../../domain/state.js';
import { stateDigest } from '../../domain/digest.js';
import { ApiError, NetworkError } from '../api/api-client.js';

const PUSH_BATCH = 50;

export class SyncEngine {
  /**
   * @param {{store, api, deviceId:string, userId:string, now?:()=>Date, uuid?:()=>string, onChange?:()=>void}} o
   * Estados de `status`: idle | syncing | offline | auth_required | revoked | error
   */
  constructor({ store, api, deviceId, userId, now = () => new Date(), uuid = () => globalThis.crypto.randomUUID(), onChange = () => {} }) {
    Object.assign(this, { store, api, deviceId, userId, now, uuid, onChange });
    this.status = 'idle';
    this.lastError = null;
    this._running = null;
    this.healCount = 0; this.lastHeal = null; this._healedAt = 0;
  }

  // ---------- Lectura ----------
  async getView() {
    const { state, ops, meta } = await this.store.load();
    return projectView(state, ops, meta.cursor);
  }

  async stats() {
    const { ops, meta } = await this.store.load();
    return {
      status: this.status, cursor: meta.cursor,
      pending: ops.filter((o) => o.status === 'pending').length,
      rejected: ops.filter((o) => o.status === 'rejected'),
    };
  }

  // ---------- Escritura local (siempre funciona, online u offline) ----------
  async enqueue(op_type, entity_type, entity_id, payload, base_version = null) {
    const op = await this.store.enqueueOp({
      op_id: this.uuid(), device_id: this.deviceId, user_id: this.userId,
      entity_type, entity_id, op_type, payload, base_version,
      created_at: this.now().toISOString(), status: 'pending',
    });
    this.onChange();
    return op;
  }

  createEntity(entity_type, data, id = this.uuid()) {
    return this.enqueue(OP.ENTITY_CREATE, entity_type, id, { data }).then((op) => ({ op, id }));
  }

  async updateEntity(entity_type, id, changes) {
    const view = await this.getView();
    const ent = view.entities[entity_type]?.[id];
    if (!ent) throw new Error(`unknown ${entity_type} ${id}`);
    return this.enqueue(OP.ENTITY_UPDATE, entity_type, id, { changes }, ent.version ?? 0);
  }

  sale(lines, extra = {}) { return this.enqueue(OP.SALE_CREATE, 'sale', this.uuid(), { lines, ...extra }); }
  purchase(lines, extra = {}) { return this.enqueue(OP.PURCHASE_CREATE, 'purchase', this.uuid(), { lines, ...extra }); }
  adjustStock(product_id, delta, reason) { return this.enqueue(OP.STOCK_ADJUST, 'adjustment', this.uuid(), { product_id, delta, reason }); }
  expense(amount, description, extra = {}) { return this.enqueue(OP.EXPENSE_CREATE, 'expense', this.uuid(), { amount, description, ...extra }); }
  /** Vende productos del catálogo: toma precio y costo vigentes de la vista local. items: [{product_id, qty}] */
  async sellProducts(items, extra = {}) {
    const view = await this.getView();
    const lines = items.map(({ product_id, qty }) => {
      const p = view.entities.product[product_id];
      if (!p) throw new Error(`unknown product ${product_id}`);
      return { product_id, qty, unit_price: p.price, unit_cost: p.cost ?? 0 };
    });
    return this.sale(lines, extra);
  }

  /** "Llegó mercancía": suma cantidad al costo vigente del producto. */
  async restock(product_id, qty, extra = {}) {
    const p = (await this.getView()).entities.product[product_id];
    if (!p) throw new Error(`unknown product ${product_id}`);
    return this.purchase([{ product_id, qty, unit_cost: p.cost ?? 0 }], extra);
  }

  /** "Corregir cantidad": deja el stock en `newQty` registrando la diferencia como ajuste. */
  async setQuantity(product_id, newQty, reason = 'conteo') {
    const cur = (await this.getView()).stock[product_id] ?? 0;
    if (newQty === cur) return null;
    return this.adjustStock(product_id, newQty - cur, reason);
  }

  voidOp(target_op_id, reason) { return this.enqueue(OP.OP_VOID, 'void', this.uuid(), { target_op_id, reason }); }

  async dismissRejected(op_id) {
    await this.store.commit({ deleteOpIds: [op_id] });
    this.onChange();
  }

  // ---------- Sincronización ----------
  /** Una sola sincronización a la vez; llamadas concurrentes comparten la misma. */
  sync() {
    this._running ??= this._sync().finally(() => { this._running = null; this.onChange(); });
    return this._running;
  }

  async _sync() {
    this.status = 'syncing'; this.onChange();
    try {
      try { await this._syncOnce(); } catch (e) {
        if (!(e instanceof ApiError && e.status === 409 && e.code === 'epoch_changed')) throw e;
        await this._resetLocal(); // la base del servidor se reinició: esta copia local ya no vale
        await this._syncOnce();
      }
      this.status = 'idle'; this.lastError = null;
      return { ok: true, status: this.status };
    } catch (e) {
      this.lastError = e;
      if (e instanceof NetworkError) this.status = 'offline';
      else if (e instanceof ApiError && e.status === 401) this.status = 'auth_required';
      else if (e instanceof ApiError && e.status === 426) this.status = 'update_required';
      else if (e instanceof ApiError && e.status === 403 && e.code === 'device_revoked') this.status = 'revoked';
      else this.status = 'error';
      return { ok: false, status: this.status, error: e };
    }
  }

  async _syncOnce() {
    let { meta } = await this.store.load();
    // Copia anterior a las "épocas" (aún sin época conocida): se pregunta al servidor si seguimos en el mismo mundo ANTES de
    // bajar nada o enviar nada. Si la base se reinició, responde 409 y se aplica la regla de reinicio (_resetLocal).
    if (meta.cursor != null && meta.epoch == null) await this._probeEpoch(meta.cursor);
    ({ meta } = await this.store.load());
    // Equipo nuevo, estado con forma antigua, o sin época conocida ⇒ snapshot nuevo. La cola NO se toca.
    if (meta.cursor == null || meta.state_schema !== STATE_SCHEMA || meta.epoch == null) await this._bootstrap();
    await this._push();
    await this._pull();
  }

  async _probeEpoch(cursor) {
    try {
      const page = await this.api.pull(cursor, 1); // sin cabecera de época: un servidor reiniciado responde 409
      if (page.epoch) await this.store.commit({ metaPatch: { epoch: page.epoch } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) return; // cursor muy viejo: el snapshot que sigue lo resuelve
      throw e;
    }
  }

  /**
   * La base del servidor se reinició (otra "época"). Regla:
   *  - lo que este equipo ya había sincronizado se descarta (el reinicio lo borró a propósito; se archiva por si acaso);
   *  - lo que NUNCA se subió (ventas hechas sin internet, etc.) SE CONSERVA y se envía a la base nueva, renumerado desde 1
   *    porque el servidor nuevo no conoce la numeración anterior de este equipo. Si una operación depende de algo que el
   *    reinicio borró (p. ej. vende un producto que ya no existe), el servidor la guarda como "rechazada" y se le muestra
   *    a la persona en "No se pudieron guardar" con todos sus datos: nunca se pierde en silencio.
   */
  async _resetLocal() {
    const { ops, meta } = await this.store.load();
    const keep = ops.filter((o) => o.status === 'pending').sort((a, b) => a.device_seq - b.device_seq);
    const dropped = ops.filter((o) => o.status !== 'pending');
    const renumbered = keep.map((o, i) => ({ ...o, device_seq: i + 1 }));
    await this.store.commit({
      state: emptyState(),
      metaPatch: {
        cursor: null, epoch: null, state_schema: null, next_device_seq: keep.length + 1,
        discarded_after_reset: dropped.length ? [...(meta.discarded_after_reset ?? []), { at: this.now().toISOString(), ops: dropped }] : (meta.discarded_after_reset ?? []),
      },
      putOps: renumbered,
      deleteOpIds: dropped.map((o) => o.op_id),
    });
    this.lastReset = { kept: keep.length };
    this.onChange();
  }

  /** Snapshot completo. Las ops locales pendientes NO se tocan (se re-proyectan encima). */
  async _bootstrap() {
    const snap = await this.api.snapshot();
    await this.store.commit({ state: snap.state, metaPatch: { cursor: snap.seq, state_schema: STATE_SCHEMA, epoch: snap.epoch ?? null } });
  }

  async _push() {
    for (;;) {
      const { ops } = await this.store.load();
      const pending = ops.filter((o) => o.status === 'pending').sort((a, b) => a.device_seq - b.device_seq).slice(0, PUSH_BATCH);
      if (!pending.length) return;
      const res = await this.api.push(pending);
      const byId = new Map(pending.map((o) => [o.op_id, o]));
      const updated = [];
      for (const r of res.results) {
        const op = byId.get(r.op_id);
        if (!op) continue;
        if (r.status === 'rejected') updated.push({ ...op, status: 'rejected', reason: r.reason, persisted: r.persisted !== false });
        else updated.push({ ...op, status: 'acked', server_seq: r.seq, server_status: r.status, reason: r.reason ?? null });
      }
      if (updated.length) await this.store.putOps(updated);
      if (res.halted) {
        const err = new ApiError(409, { error: `push_halted:${res.halted.error ?? 'gap'}` });
        throw err;
      }
      if (!updated.length) return; // sin progreso: evitar bucle infinito
    }
  }

  async _pull() {
    for (;;) {
      const { state, meta, ops } = await this.store.load();
      let page;
      try {
        page = await this.api.pull(meta.cursor ?? 0);
      } catch (e) {
        // Cursor anterior al horizonte de compactación: nuevo snapshot, conservando la cola local.
        if (e instanceof ApiError && e.status === 410) { await this._bootstrap(); continue; }
        throw e;
      }
      let cursor = meta.cursor ?? 0;
      const next = structuredClone(state);
      for (const entry of page.ops) {
        if (entry.seq <= cursor) continue; // idempotente
        applyEffects(next, entry.effects);
        cursor = entry.seq;
      }
      // El equipo guarda solo los últimos RECORD_RETENTION_DAYS días de ventas/gastos (lo anterior se consulta al servidor).
      pruneRecords(next, new Date(this.now().getTime() - RECORD_RETENTION_DAYS * 86_400_000).toISOString());
      // Estado + cursor + purga de ops ya cubiertas por el cursor: UNA transacción.
      const deleteOpIds = ops.filter((o) => o.status === 'acked' && o.server_seq <= cursor).map((o) => o.op_id);
      await this.store.commit({ state: next, metaPatch: { cursor }, deleteOpIds });
      this.onChange();
      if (page.has_more) continue;
      // Al día con el servidor: ¿mi copia coincide con la suya? Si no (p. ej. se editó/borró algo directo en la base
      // de datos, o la copia local se dañó) se descarga un snapshot nuevo. La cola de operaciones NO se toca.
      // Tope de 1 corrección por minuto: nunca puede quedar en bucle.
      if (page.digest && cursor === page.head && Date.now() - this._healedAt > 60_000 && (await stateDigest(next, { recordsFrom: page.digest_from })) !== page.digest) {
        this._healedAt = Date.now();
        await this._bootstrap();
        this.healCount += 1; this.lastHeal = { at: this.now().toISOString() };
        this.onChange();
        continue;
      }
      return;
    }
  }
}
