// Constantes compartidas cliente/servidor.

export const OP = Object.freeze({
  ENTITY_CREATE: 'ENTITY_CREATE',
  ENTITY_UPDATE: 'ENTITY_UPDATE',
  SALE_CREATE: 'SALE_CREATE',
  PURCHASE_CREATE: 'PURCHASE_CREATE',
  STOCK_ADJUST: 'STOCK_ADJUST',
  EXPENSE_CREATE: 'EXPENSE_CREATE',
  OP_VOID: 'OP_VOID',
});

// Operaciones acumulativas: hechos inmutables que se apilan (nunca LWW).
export const RECORD_KIND = Object.freeze({
  [OP.SALE_CREATE]: 'sale',
  [OP.PURCHASE_CREATE]: 'purchase',
  [OP.STOCK_ADJUST]: 'adjustment',
  [OP.EXPENSE_CREATE]: 'expense',
});

// Entidades de estado/configuración y el tipo de cada campo editable.
export const ENTITY_FIELDS = Object.freeze({
  product: { name: 'string', sku: 'string?', price: 'int', cost: 'int', category_id: 'string?', archived: 'bool' },
  category: { name: 'string', archived: 'bool' },
  payment_method: { name: 'string', archived: 'bool' },
});

export const ENTITY_DEFAULTS = Object.freeze({
  product: { name: '', sku: null, price: 0, cost: 0, category_id: null, archived: false },
  category: { name: '', archived: false },
  payment_method: { name: '', archived: false },
});

// PROTO: versión del protocolo cliente↔servidor. Subirla SOLO si un cambio rompe a clientes viejos (el servidor
// debe seguir aceptando las operaciones de versiones anteriores; ver AGENTS.md §5).
export const PROTO = 1;
// STATE_SCHEMA: forma del estado guardado en el dispositivo. Si cambia de forma no compatible, subirla:
// los equipos descargan un snapshot nuevo (conservando su cola de operaciones pendientes).
export const STATE_SCHEMA = 2; // 2: ventana de registros + coverage

// Cuántos días de ventas/compras/gastos guarda cada equipo (las semanas más antiguas se consultan al servidor).
// El límite NO es de SQLite (maneja millones de filas): es para que cada celular guarde y baje una cantidad razonable.
export const RECORD_RETENTION_DAYS = 180;
// El servidor compara huellas solo sobre los últimos DIGEST_DAYS días: queda siempre dentro de la ventana de todos los equipos.
export const DIGEST_DAYS = 150;

// Formas de pago que ofrece la app. Los ids son estables (se guardan en cada venta/gasto/compra).
export const PAYMENT_METHODS = Object.freeze([
  { id: 'pm-cash', name: 'Efectivo' },
  { id: 'pm-transfer', name: 'Transferencia' },
]);

export const MAX_BATCH = 100;
export const MAX_LINES = 200;
