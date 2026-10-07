// Reglas de aplicación de una operación sobre el estado del servidor.
// Se ejecuta DENTRO de una transacción abierta por el llamador. Devuelve {status, reason, effects}.
import { OP, RECORD_KIND, ENTITY_FIELDS } from '../../shared/constants.js';
import { buildRecord, movementsOf, reverseMovements, entityDefaults } from '../../domain/state.js';
import { checkFieldValue } from '../../shared/validate.js';
import { nowIso } from '../db/db.js';

const rejected = (reason) => ({ status: 'rejected', reason, effects: [] });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function getEntity(db, org_id, type, id) {
  const r = db.prepare('SELECT * FROM entities WHERE org_id=? AND type=? AND id=?').get(org_id, type, id);
  if (!r) return null;
  return { ...r, data: JSON.parse(r.data), field_meta: JSON.parse(r.field_meta) };
}

export const entityEffect = (type, e) => ({
  t: 'entity', entity_type: type, id: e.id, data: e.data, version: e.version, field_meta: e.field_meta,
});

function saveEntity(db, org_id, type, id, data, version, field_meta, created = false) {
  if (created) {
    db.prepare('INSERT INTO entities (org_id,type,id,data,version,field_meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(org_id, type, id, JSON.stringify(data), version, JSON.stringify(field_meta), nowIso(), nowIso());
  } else {
    db.prepare('UPDATE entities SET data=?, version=?, field_meta=?, updated_at=? WHERE org_id=? AND type=? AND id=?')
      .run(JSON.stringify(data), version, JSON.stringify(field_meta), nowIso(), org_id, type, id);
  }
  return { id, data, version, field_meta };
}

function insertMovements(db, ctx, op, record_id, movements, reason) {
  const st = db.prepare('INSERT INTO inventory_movements (org_id,product_id,delta,reason,record_id,op_id,created_at) VALUES (?,?,?,?,?,?,?)');
  for (const m of movements) st.run(ctx.org_id, m.product_id, m.delta, reason, record_id, op.op_id, op.created_at);
}

export function applyOp(db, ctx, op) {
  switch (op.op_type) {
    case OP.ENTITY_CREATE: return applyCreate(db, ctx, op);
    case OP.ENTITY_UPDATE: return applyUpdate(db, ctx, op);
    case OP.OP_VOID: return applyVoid(db, ctx, op);
    default: return applyRecord(db, ctx, op);
  }
}

function applyCreate(db, ctx, op) {
  if (getEntity(db, ctx.org_id, op.entity_type, op.entity_id)) return rejected('entity_exists');
  const data = entityDefaults(op.entity_type, op.payload.data);
  const field_meta = Object.fromEntries(Object.keys(data).map((f) => [f, { v: 1, d: op.device_id }]));
  const e = saveEntity(db, ctx.org_id, op.entity_type, op.entity_id, data, 1, field_meta, true);
  return { status: 'applied', reason: null, effects: [entityEffect(op.entity_type, e)] };
}

/** Merge por campo: aplica lo que no choca, y registra conflicto explícito (con ambos valores) para el resto. */
function applyUpdate(db, ctx, op) {
  const ent = getEntity(db, ctx.org_id, op.entity_type, op.entity_id);
  if (!ent) return rejected('unknown_entity');
  const base = op.base_version;
  const toApply = {};
  const conflicts = [];
  for (const [f, v] of Object.entries(op.payload.changes)) {
    if (same(ent.data[f], v)) continue; // ya tiene ese valor: fusión sin efecto
    const meta = ent.field_meta[f] ?? { v: 0, d: null };
    // Seguro si nadie lo tocó desde la versión base, o si lo escribió este mismo dispositivo
    // (sus ops están totalmente ordenadas por device_seq → no es concurrencia).
    if (meta.v <= base || meta.d === op.device_id) toApply[f] = v;
    else conflicts.push({ field: f, client_value: v, server_value: ent.data[f] });
  }
  const effects = [];
  let cur = ent;
  if (Object.keys(toApply).length) {
    const version = ent.version + 1;
    const data = { ...ent.data, ...toApply };
    const field_meta = { ...ent.field_meta };
    for (const f of Object.keys(toApply)) field_meta[f] = { v: version, d: op.device_id };
    cur = saveEntity(db, ctx.org_id, op.entity_type, op.entity_id, data, version, field_meta);
    effects.push(entityEffect(op.entity_type, cur));
  }
  for (const c of conflicts) {
    const conflict = {
      id: `${op.op_id}:${c.field}`, op_id: op.op_id, entity_type: op.entity_type, entity_id: op.entity_id,
      field: c.field, base_version: base, server_version: ent.version,
      server_value: c.server_value, client_value: c.client_value, status: 'open', created_at: nowIso(),
    };
    db.prepare(`INSERT OR IGNORE INTO conflicts (id,org_id,op_id,entity_type,entity_id,field,base_version,server_version,server_value,client_value,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(conflict.id, ctx.org_id, op.op_id, op.entity_type, op.entity_id, c.field, base, ent.version,
        JSON.stringify(c.server_value), JSON.stringify(c.client_value), 'open', conflict.created_at);
    effects.push({ t: 'conflict', conflict });
  }
  const status = conflicts.length === 0 ? 'applied' : Object.keys(toApply).length ? 'partial' : 'conflict';
  return { status, reason: conflicts.length ? `conflict:${conflicts.map((c) => c.field).join(',')}` : null, effects };
}

function applyRecord(db, ctx, op) {
  if (db.prepare('SELECT 1 FROM records WHERE org_id=? AND id=?').get(ctx.org_id, op.entity_id)) return rejected('record_exists');
  const record = buildRecord(op);
  for (const l of record.lines) {
    if (!getEntity(db, ctx.org_id, 'product', l.product_id)) return rejected(`unknown_product:${l.product_id}`);
  }
  const movements = movementsOf(record);
  db.prepare('INSERT INTO records (org_id,id,kind,op_id,data,voided,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(ctx.org_id, record.id, record.kind, op.op_id, JSON.stringify(record), op.created_at);
  insertMovements(db, ctx, op, record.id, movements, record.kind);
  return { status: 'applied', reason: null, effects: [{ t: 'record', record, movements }] };
}

/** Anular = movimientos compensatorios + marca. Nunca se borra nada. Idempotente. */
function applyVoid(db, ctx, op) {
  const row = db.prepare('SELECT * FROM records WHERE org_id=? AND op_id=?').get(ctx.org_id, op.payload.target_op_id);
  if (!row) return rejected('target_unknown');
  if (row.voided) return { status: 'applied', reason: 'already_voided', effects: [] };
  const record = JSON.parse(row.data);
  const movements = reverseMovements(record);
  record.voided = true;
  db.prepare('UPDATE records SET voided=1, data=? WHERE org_id=? AND id=?').run(JSON.stringify(record), ctx.org_id, row.id);
  insertMovements(db, ctx, op, row.id, movements, 'void');
  return { status: 'applied', reason: null, effects: [{ t: 'void', record_id: row.id, movements, by_op_id: op.op_id }] };
}

/** Resolución explícita de un conflicto de estado (solo online, solo owner). */
export function applyResolution(db, ctx, conflictId, choice, value) {
  const c = db.prepare('SELECT * FROM conflicts WHERE id=? AND org_id=?').get(conflictId, ctx.org_id);
  if (!c) return { error: 'not_found', status: 404 };
  if (c.status !== 'open') return { error: 'already_resolved', status: 409 };
  const serverValue = JSON.parse(c.server_value);
  const clientValue = JSON.parse(c.client_value);
  let final;
  if (choice === 'server') final = serverValue;
  else if (choice === 'client') final = clientValue;
  else if (choice === 'value') {
    const err = checkFieldValue(ENTITY_FIELDS[c.entity_type][c.field], value);
    if (err) return { error: `bad_value:${err}`, status: 400 };
    final = value;
  } else return { error: 'bad_choice', status: 400 };

  const effects = [];
  const ent = getEntity(db, ctx.org_id, c.entity_type, c.entity_id);
  if (ent && !same(ent.data[c.field], final)) {
    const version = ent.version + 1;
    const field_meta = { ...ent.field_meta, [c.field]: { v: version, d: 'resolution' } };
    const saved = saveEntity(db, ctx.org_id, c.entity_type, c.entity_id, { ...ent.data, [c.field]: final }, version, field_meta);
    effects.push(entityEffect(c.entity_type, saved));
  }
  db.prepare('UPDATE conflicts SET status=?, resolution=?, resolved_value=?, resolved_by=?, resolved_at=? WHERE id=?')
    .run('resolved', choice, JSON.stringify(final), ctx.user_id, nowIso(), c.id);
  effects.push({ t: 'conflict_resolved', id: c.id, resolution: choice });
  return { effects, final };
}
