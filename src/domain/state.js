// Dominio puro (sin I/O): construcción de registros, efectos y proyección optimista.
// Lo usan servidor (para producir efectos) y cliente (para aplicarlos y proyectar).
import { OP, RECORD_KIND, ENTITY_DEFAULTS } from '../shared/constants.js';

export function emptyState() {
  // coverage.records_since: los registros (ventas/compras/gastos) están completos desde esta fecha (ISO); null = todos.
  return { entities: { product: {}, category: {}, payment_method: {} }, stock: {}, records: {}, conflicts: {}, coverage: { records_since: null } };
}

/** Registro inmutable de una operación acumulativa. `lines[].delta` es el movimiento de stock. */
export function buildRecord(op) {
  const p = op.payload;
  const base = {
    id: op.entity_id,
    kind: RECORD_KIND[op.op_type],
    op_id: op.op_id,
    device_id: op.device_id,
    created_at: op.created_at,
    voided: false,
    note: p.note ?? null,
    payment_method_id: p.payment_method_id ?? null,
  };
  switch (op.op_type) {
    case OP.SALE_CREATE: {
      // unit_cost = lo que nos costaba el producto AL VENDER (así la ganancia histórica no cambia si luego sube el costo)
      const lines = p.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price, unit_cost: l.unit_cost ?? 0, delta: -l.qty }));
      return { ...base, lines, amount: lines.reduce((s, l) => s + l.qty * l.unit_price, 0), cost: lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) };
    }
    case OP.PURCHASE_CREATE: {
      const lines = p.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost, delta: l.qty }));
      return { ...base, lines, amount: lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) };
    }
    case OP.STOCK_ADJUST:
      return { ...base, note: p.reason, lines: [{ product_id: p.product_id, delta: p.delta }], amount: 0 };
    case OP.EXPENSE_CREATE:
      return { ...base, note: p.description, lines: [], amount: p.amount };
    default:
      throw new Error(`not a record op: ${op.op_type}`);
  }
}

export const movementsOf = (rec) => rec.lines.filter((l) => l.delta).map((l) => ({ product_id: l.product_id, delta: l.delta }));
export const reverseMovements = (rec) => movementsOf(rec).map((m) => ({ product_id: m.product_id, delta: -m.delta }));

export function entityDefaults(type, data) {
  return { ...ENTITY_DEFAULTS[type], ...data };
}

function addMovements(state, movements) {
  for (const m of movements) state.stock[m.product_id] = (state.stock[m.product_id] || 0) + m.delta;
}

/** Aplica efectos normalizados (del servidor u optimistas) a un estado. Muta `state`. */
export function applyEffects(state, effects) {
  for (const e of effects) {
    switch (e.t) {
      case 'entity': {
        const bucket = state.entities[e.entity_type];
        if (!bucket) break;
        const cur = bucket[e.id];
        bucket[e.id] = { ...cur, ...e.data, id: e.id, version: e.version ?? cur?.version ?? 0, field_meta: e.field_meta ?? cur?.field_meta };
        break;
      }
      case 'record':
        state.records[e.record.id] = e.record;
        addMovements(state, e.movements);
        break;
      case 'void': {
        const rec = state.records[e.record_id];
        if (rec) rec.voided = true;
        addMovements(state, e.movements);
        break;
      }
      case 'conflict':
        state.conflicts[e.conflict.id] = e.conflict;
        break;
      case 'conflict_resolved':
        if (state.conflicts[e.id]) state.conflicts[e.id] = { ...state.conflicts[e.id], status: 'resolved', resolution: e.resolution };
        break;
      default:
        break;
    }
  }
  return state;
}

/** Efectos optimistas de una op local pendiente, sobre la vista actual. */
export function optimisticEffects(op, view) {
  switch (op.op_type) {
    case OP.ENTITY_CREATE:
      return [{ t: 'entity', entity_type: op.entity_type, id: op.entity_id, data: entityDefaults(op.entity_type, op.payload.data), pending: true }];
    case OP.ENTITY_UPDATE:
      if (!view.entities[op.entity_type]?.[op.entity_id]) return [];
      return [{ t: 'entity', entity_type: op.entity_type, id: op.entity_id, data: op.payload.changes }];
    case OP.SALE_CREATE:
    case OP.PURCHASE_CREATE:
    case OP.STOCK_ADJUST:
    case OP.EXPENSE_CREATE: {
      const record = { ...buildRecord(op), pending: true };
      return [{ t: 'record', record, movements: movementsOf(record) }];
    }
    case OP.OP_VOID: {
      const rec = Object.values(view.records).find((r) => r.op_id === op.payload.target_op_id);
      if (!rec || rec.voided) return [];
      return [{ t: 'void', record_id: rec.id, movements: reverseMovements(rec) }];
    }
    default:
      return [];
  }
}

/** Vista = estado del servidor + ops locales aún no reflejadas por el cursor, en orden de device_seq. */
export function projectView(serverState, ops, cursor) {
  const view = structuredClone(serverState);
  const live = ops
    .filter((o) => o.status === 'pending' || (o.status === 'acked' && o.server_seq > (cursor ?? 0)))
    .sort((a, b) => a.device_seq - b.device_seq);
  for (const op of live) applyEffects(view, optimisticEffects(op, view));
  return view;
}

/** Descarta registros anteriores a `cutoffIso` (el stock no cambia: es un acumulado aparte) y sube `coverage`. */
export function pruneRecords(state, cutoffIso) {
  state.coverage ??= { records_since: null };
  for (const [id, r] of Object.entries(state.records)) if (r.created_at < cutoffIso) delete state.records[id];
  if (!state.coverage.records_since || state.coverage.records_since < cutoffIso) state.coverage.records_since = cutoffIso;
  return state;
}
