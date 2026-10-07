// Servicio de sincronización: push (idempotente, ordenado), pull, snapshot, conflictos, export.
import { randomUUID } from 'node:crypto';
import { tx, nowIso, audit } from '../db/db.js';
import { validateEnvelope, validatePayload } from '../../shared/validate.js';
import { MAX_BATCH } from '../../shared/constants.js';
import { applyOp, applyResolution } from './apply.js';
import { AuthError } from '../auth/auth.js';
import { getEpoch } from './reset.js';
import { stateDigest } from '../../domain/digest.js';
import { reportBetween } from '../../domain/report.js';
import { RECORD_RETENTION_DAYS, DIGEST_DAYS } from '../../shared/constants.js';

const daysAgoIso = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

function insertOperation(db, ctx, op, result, { device_seq, user_id }) {
  const r = db.prepare(`INSERT INTO operations
    (org_id,op_id,device_id,user_id,device_seq,entity_type,entity_id,op_type,payload,base_version,created_at,received_at,status,reason,effects)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ctx.org_id, op.op_id, op.device_id, user_id, device_seq, op.entity_type, op.entity_id, op.op_type,
      JSON.stringify(op.payload ?? null), op.base_version ?? null, op.created_at, nowIso(),
      result.status, result.reason ?? null, JSON.stringify(result.effects));
  return Number(r.lastInsertRowid);
}

function userInOrg(db, org_id, user_id) {
  return typeof user_id === 'string' && !!db.prepare('SELECT 1 FROM users WHERE id=? AND org_id=?').get(user_id, org_id);
}

/**
 * Procesa un lote de operaciones de UN dispositivo, en orden de device_seq.
 * Cada op es su propia transacción: el progreso parcial se conserva y los reintentos son seguros.
 */
export function pushOps(db, ctx, ops) {
  if (!Array.isArray(ops) || ops.length > MAX_BATCH) throw new AuthError(400, 'bad_batch');
  const sorted = [...ops].sort((a, b) => (a?.device_seq ?? 0) - (b?.device_seq ?? 0));
  const results = [];
  let halted = null;

  for (const op of sorted) {
    const envErr = validateEnvelope(op);
    if (envErr) { results.push({ op_id: op?.op_id ?? null, status: 'rejected', reason: envErr, persisted: false }); continue; }
    if (op.device_id !== ctx.device_id) { results.push({ op_id: op.op_id, status: 'rejected', reason: 'device_mismatch', persisted: false }); continue; }

    try {
      const r = tx(db, () => {
        const existing = db.prepare('SELECT seq, org_id, status, reason FROM operations WHERE op_id=?').get(op.op_id);
        if (existing) {
          if (existing.org_id !== ctx.org_id) return { op_id: op.op_id, status: 'rejected', reason: 'op_id_conflict', persisted: false };
          return { op_id: op.op_id, status: existing.status, reason: existing.reason, seq: existing.seq, duplicate: true, persisted: true };
        }
        const dev = db.prepare('SELECT last_device_seq FROM devices WHERE id=?').get(ctx.device_id);
        if (op.device_seq <= dev.last_device_seq) return { op_id: op.op_id, status: 'rejected', reason: 'device_seq_stale', persisted: false };
        if (op.device_seq !== dev.last_device_seq + 1) return { halted: { expected_device_seq: dev.last_device_seq + 1, got: op.device_seq } };

        const user_id = userInOrg(db, ctx.org_id, op.user_id) ? op.user_id : ctx.user_id;
        const payloadErr = validatePayload(op);
        const result = payloadErr ? { status: 'rejected', reason: payloadErr, effects: [] } : applyOp(db, ctx, op);
        const seq = insertOperation(db, ctx, op, result, { device_seq: op.device_seq, user_id });
        db.prepare('UPDATE devices SET last_device_seq=?, last_seen_at=? WHERE id=?').run(op.device_seq, nowIso(), ctx.device_id);
        return { op_id: op.op_id, status: result.status, reason: result.reason ?? null, seq, persisted: true };
      });
      if (r.halted) { halted = r.halted; break; }
      results.push(r);
    } catch (e) {
      // Fallo interno: esa op se revirtió por completo; el cliente la reintenta. No se marca como rechazada.
      console.error('push internal error', op.op_id, e);
      halted = { error: 'internal_error', op_id: op.op_id };
      break;
    }
  }
  return { results, halted, head: headSeq(db, ctx.org_id) };
}

export const headSeq = (db, org_id) =>
  db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM operations WHERE org_id=?').get(org_id).s;

export async function pullOps(db, ctx, since, limit = 200) {
  since = Number.isSafeInteger(since) && since >= 0 ? since : 0;
  limit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const minSeq = Number(db.prepare("SELECT value FROM meta WHERE key='min_seq'").get()?.value ?? 0);
  if (since < minSeq) return { error: 'cursor_too_old', min_seq: minSeq };
  const rows = db.prepare(`SELECT seq, op_id, device_id, op_type, status, reason, created_at, effects
                           FROM operations WHERE org_id=? AND seq>? ORDER BY seq LIMIT ?`).all(ctx.org_id, since, limit + 1);
  const hasMore = rows.length > limit;
  const ops = rows.slice(0, limit).map((r) => ({ ...r, effects: JSON.parse(r.effects) }));
  const head = headSeq(db, ctx.org_id);
  // Huella del estado en `head`: el cliente, si ya está al día, la compara con la suya y se corrige si difieren.
  const digest_from = daysAgoIso(DIGEST_DAYS);
  const digest = hasMore ? null : await stateDigest(snapshot(db, ctx, DIGEST_DAYS).state, { recordsFrom: digest_from });
  return { ops, has_more: hasMore, head, digest, digest_from, epoch: getEpoch(db, ctx.org_id) };
}

export function stockFor(db, org_id) {
  const stock = {};
  for (const r of db.prepare('SELECT product_id, SUM(delta) AS s FROM inventory_movements WHERE org_id=? GROUP BY product_id').all(org_id)) stock[r.product_id] = r.s;
  return stock;
}

// Lectura consistente (transacción diferida: no toma el candado de escritura).
function readTx(db, fn) {
  db.exec('BEGIN');
  try { return fn(); } finally { db.exec('COMMIT'); }
}

export function snapshot(db, ctx, days = RECORD_RETENTION_DAYS) {
  return readTx(db, () => {
    const entities = { product: {}, category: {}, payment_method: {} };
    for (const r of db.prepare('SELECT * FROM entities WHERE org_id=?').all(ctx.org_id)) {
      (entities[r.type] ??= {})[r.id] = { id: r.id, ...JSON.parse(r.data), version: r.version, field_meta: JSON.parse(r.field_meta) };
    }
    const records = {};
    // Ventana de RECORD_RETENTION_DAYS días, sin tope de cantidad. Lo más antiguo se consulta con weekReport().
    const records_since = daysAgoIso(days);
    for (const r of db.prepare('SELECT data FROM records WHERE org_id=? AND created_at >= ? ORDER BY created_at DESC').all(ctx.org_id, records_since)) {
      const rec = JSON.parse(r.data); records[rec.id] = rec;
    }
    const conflicts = {};
    for (const c of db.prepare("SELECT * FROM conflicts WHERE org_id=? AND status='open'").all(ctx.org_id)) {
      conflicts[c.id] = { ...c, server_value: JSON.parse(c.server_value), client_value: JSON.parse(c.client_value) };
    }
    return { seq: headSeq(db, ctx.org_id), epoch: getEpoch(db, ctx.org_id), state: { entities, stock: stockFor(db, ctx.org_id), records, conflicts, coverage: { records_since } } };
  });
}

export function listConflicts(db, ctx, status = 'open') {
  return db.prepare('SELECT * FROM conflicts WHERE org_id=? AND status=? ORDER BY created_at').all(ctx.org_id, status)
    .map((c) => ({ ...c, server_value: JSON.parse(c.server_value), client_value: JSON.parse(c.client_value) }));
}

export function resolveConflict(db, ctx, id, choice, value) {
  if (ctx.role !== 'owner') throw new AuthError(403, 'forbidden');
  return tx(db, () => {
    const r = applyResolution(db, ctx, id, choice, value);
    if (r.error) throw new AuthError(r.status, r.error);
    const seq = insertOperation(db, ctx, {
      op_id: `resolve:${id}`, device_id: ctx.device_id, entity_type: 'conflict', entity_id: id,
      op_type: 'CONFLICT_RESOLVE', payload: { choice, value: value ?? null }, base_version: null, created_at: nowIso(),
    }, { status: 'applied', reason: null, effects: r.effects }, { device_seq: null, user_id: ctx.user_id });
    audit(db, { org_id: ctx.org_id, actor_user_id: ctx.user_id, device_id: ctx.device_id, action: 'conflict.resolved', detail: { id, choice } });
    return { seq, final: r.final };
  });
}

/** Operación originada en el servidor (seed, admin). Entra al log y llega a todos por pull. */
export function serverApply(db, org_id, user_id, op_type, entity_type, entity_id, payload, base_version = null) {
  const ctx = { org_id, user_id, device_id: 'server' };
  const op = { op_id: randomUUID(), device_id: 'server', entity_type, entity_id, op_type, payload, base_version, created_at: nowIso() };
  return tx(db, () => {
    const err = validatePayload(op);
    if (err) throw new Error(`serverApply invalid: ${err}`);
    const result = applyOp(db, ctx, op);
    if (result.status === 'rejected') throw new Error(`serverApply rejected: ${result.reason}`);
    return insertOperation(db, ctx, op, result, { device_seq: null, user_id });
  });
}

export function movementsCsv(db, ctx) {
  if (ctx.role !== 'owner') throw new AuthError(403, 'forbidden');
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = db.prepare('SELECT id, product_id, delta, reason, record_id, op_id, created_at FROM inventory_movements WHERE org_id=? ORDER BY id').all(ctx.org_id);
  return ['id,product_id,delta,reason,record_id,op_id,created_at', ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n');
}

/** Reporte de un rango [start, end) calculado en el servidor (para semanas más antiguas que lo que guarda el equipo). */
export function weekReport(db, ctx, startIso, endIso) {
  const start = new Date(startIso), end = new Date(endIso);
  if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start || end - start > 8 * 86_400_000) throw new AuthError(400, 'bad_range');
  const records = db.prepare('SELECT data FROM records WHERE org_id=? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC')
    .all(ctx.org_id, start.toISOString(), end.toISOString()).map((r) => JSON.parse(r.data));
  return { report: reportBetween(records, start, end), expenses: records.filter((r) => r.kind === 'expense') };
}
