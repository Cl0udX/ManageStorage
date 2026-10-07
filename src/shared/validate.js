// Validadores puros compartidos. Devuelven null si es válido, o un string con el motivo.
import { OP, RECORD_KIND, ENTITY_FIELDS, MAX_LINES } from './constants.js';

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function checkFieldValue(type, value) {
  switch (type) {
    case 'string': return isStr(value) ? null : 'expected non-empty string';
    case 'string?': return value === null || (typeof value === 'string' && value.length <= 200) ? null : 'expected string|null';
    case 'int': return isInt(value) && value >= 0 ? null : 'expected non-negative integer';
    case 'bool': return typeof value === 'boolean' ? null : 'expected boolean';
    default: return 'unknown field type';
  }
}

export function checkFields(entityType, data, { requireName }) {
  const spec = ENTITY_FIELDS[entityType];
  if (!spec) return 'unknown_entity_type';
  if (!isObj(data)) return 'data_not_object';
  for (const [k, v] of Object.entries(data)) {
    if (!(k in spec)) return `field_not_allowed:${k}`;
    const e = checkFieldValue(spec[k], v);
    if (e) return `field_invalid:${k}:${e}`;
  }
  if (requireName && !('name' in data)) return 'name_required';
  return null;
}

/** Envoltorio de la operación. Si falla, la op no se puede ni persistir con garantías. */
export function validateEnvelope(op) {
  if (!isObj(op)) return 'op_not_object';
  if (typeof op.op_id !== 'string' || !ID_RE.test(op.op_id)) return 'bad_op_id';
  if (typeof op.device_id !== 'string' || !ID_RE.test(op.device_id)) return 'bad_device_id';
  if (!isInt(op.device_seq) || op.device_seq < 1) return 'bad_device_seq';
  if (!Object.values(OP).includes(op.op_type)) return 'bad_op_type';
  if (typeof op.entity_type !== 'string' || !ID_RE.test(op.entity_type)) return 'bad_entity_type';
  if (typeof op.entity_id !== 'string' || !ID_RE.test(op.entity_id)) return 'bad_entity_id';
  if (!isObj(op.payload)) return 'bad_payload';
  if (typeof op.created_at !== 'string' || Number.isNaN(Date.parse(op.created_at))) return 'bad_created_at';
  if (op.base_version != null && !isInt(op.base_version)) return 'bad_base_version';
  return null;
}

function checkLines(lines, priceField, optionalCost = false) {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_LINES) return 'bad_lines';
  for (const l of lines) {
    if (!isObj(l) || typeof l.product_id !== 'string' || !ID_RE.test(l.product_id)) return 'bad_line_product';
    if (!isInt(l.qty) || l.qty < 1) return 'bad_line_qty';
    if (!isInt(l[priceField]) || l[priceField] < 0) return `bad_line_${priceField}`;
    if (optionalCost && l.unit_cost !== undefined && (!isInt(l.unit_cost) || l.unit_cost < 0)) return 'bad_line_unit_cost';
  }
  return null;
}

/** Validación semántica del payload según op_type. */
export function validatePayload(op) {
  const p = op.payload;
  switch (op.op_type) {
    case OP.ENTITY_CREATE: {
      if (!ENTITY_FIELDS[op.entity_type]) return 'unknown_entity_type';
      return checkFields(op.entity_type, p.data, { requireName: true });
    }
    case OP.ENTITY_UPDATE: {
      if (!ENTITY_FIELDS[op.entity_type]) return 'unknown_entity_type';
      if (!isObj(p.changes) || Object.keys(p.changes).length === 0) return 'no_changes';
      if (!isInt(op.base_version)) return 'base_version_required';
      return checkFields(op.entity_type, p.changes, { requireName: false });
    }
    case OP.SALE_CREATE:
    case OP.PURCHASE_CREATE: {
      if (op.entity_type !== RECORD_KIND[op.op_type]) return 'entity_type_mismatch';
      const e = checkLines(p.lines, op.op_type === OP.SALE_CREATE ? 'unit_price' : 'unit_cost', op.op_type === OP.SALE_CREATE);
      if (e) return e;
      if (p.payment_method_id != null && typeof p.payment_method_id !== 'string') return 'bad_payment_method';
      if (p.note != null && (typeof p.note !== 'string' || p.note.length > 500)) return 'bad_note';
      return null;
    }
    case OP.STOCK_ADJUST: {
      if (op.entity_type !== 'adjustment') return 'entity_type_mismatch';
      if (typeof p.product_id !== 'string' || !ID_RE.test(p.product_id)) return 'bad_product';
      if (!isInt(p.delta) || p.delta === 0) return 'bad_delta';
      if (!isStr(p.reason)) return 'bad_reason';
      return null;
    }
    case OP.EXPENSE_CREATE: {
      if (op.entity_type !== 'expense') return 'entity_type_mismatch';
      if (!isInt(p.amount) || p.amount < 1) return 'bad_amount';
      if (!isStr(p.description)) return 'bad_description';
      if (p.payment_method_id != null && typeof p.payment_method_id !== 'string') return 'bad_payment_method';
      return null;
    }
    case OP.OP_VOID: {
      if (typeof p.target_op_id !== 'string' || !ID_RE.test(p.target_op_id)) return 'bad_target';
      if (p.reason != null && (typeof p.reason !== 'string' || p.reason.length > 500)) return 'bad_reason';
      return null;
    }
    default:
      return 'bad_op_type';
  }
}
