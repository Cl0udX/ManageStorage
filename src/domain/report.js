// Reportes puros (sin I/O): corren en el dispositivo, así funcionan sin conexión.
// Ganancia = ventas − costo de lo vendido − gastos. (Las compras de mercancía NO restan:
// son inventario; su costo entra cuando se vende.) Las ventas anuladas no cuentan.

/** Lunes 00:00 (hora local) de la semana de `date`. */
export function weekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

const lineCost = (l) => l.qty * (l.unit_cost ?? 0);

/** @param {Iterable<object>} records registros de la vista  @param {Date} start lunes de la semana */
export function weeklyReport(records, start) { return reportBetween(records, start, addDays(start, 7)); }

/** Igual que weeklyReport pero con un rango explícito [start, end) (lo usa el servidor, que puede estar en otra zona horaria). */
export function reportBetween(records, start, end) {
  const out = { start, end, sales: 0, cogs: 0, gross: 0, expenses: 0, net: 0, purchases: 0, salesCount: 0, byProduct: {}, byMethod: {} };
  // Plata por forma de pago: entra con las ventas, sale con gastos y compras de mercancía. null ⇒ 'none' (sin indicar).
  const money = (r) => (out.byMethod[r.payment_method_id ?? 'none'] ??= { in: 0, out: 0 });
  for (const r of records) {
    const t = new Date(r.created_at);
    if (r.voided || t < start || t >= end) continue;
    if (r.kind === 'sale') {
      out.sales += r.amount;
      money(r).in += r.amount;
      out.cogs += r.cost ?? r.lines.reduce((s, l) => s + lineCost(l), 0);
      out.salesCount += 1;
      for (const l of r.lines) {
        const p = (out.byProduct[l.product_id] ??= { product_id: l.product_id, qty: 0, revenue: 0, cost: 0, profit: 0 });
        p.qty += l.qty; p.revenue += l.qty * l.unit_price; p.cost += lineCost(l); p.profit = p.revenue - p.cost;
      }
    } else if (r.kind === 'expense') { out.expenses += r.amount; money(r).out += r.amount; }
    else if (r.kind === 'purchase') { out.purchases += r.amount; money(r).out += r.amount; }
  }
  out.gross = out.sales - out.cogs;
  out.net = out.gross - out.expenses;
  out.byProduct = Object.values(out.byProduct).sort((a, b) => b.profit - a.profit);
  return out;
}

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Historial agrupado por día (más reciente primero), para un tipo de registro: sale | purchase | expense. Las anuladas se listan pero no suman. */
export function recordsByDay(records, kind = 'sale') {
  const kinds = Array.isArray(kind) ? kind : [kind]; // uno o varios tipos (p. ej. ['purchase', 'adjustment'])
  const days = new Map();
  for (const r of records) {
    if (!kinds.includes(r.kind)) continue;
    const at = new Date(r.created_at);
    const key = dayKey(at);
    let d = days.get(key);
    if (!d) {
      const date = new Date(at); date.setHours(0, 0, 0, 0);
      d = { day: key, date, total: 0, byMethod: {}, sales: [] };
      days.set(key, d);
    }
    d.sales.push(r);
    if (!r.voided) {
      d.total += r.amount;
      const m = r.payment_method_id ?? 'none';
      d.byMethod[m] = (d.byMethod[m] ?? 0) + r.amount;
    }
  }
  return [...days.values()].sort((a, b) => b.date - a.date)
    .map((d) => ({ ...d, sales: d.sales.sort((a, b) => b.created_at.localeCompare(a.created_at)) }));
}

export const salesByDay = (records) => recordsByDay(records, 'sale');

/**
 * Rango [from, to) de un período del historial, en hora local: today | yesterday | week (lunes–domingo) | month |
 * all (sin límites) | "YYYY-MM-DD" (un día específico).
 */
export function periodRange(period, now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  switch (period) {
    case 'today': return { from: today, to: addDays(today, 1) };
    case 'yesterday': return { from: addDays(today, -1), to: today };
    case 'week': { const w = weekStart(now); return { from: w, to: addDays(w, 7) }; }
    case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
    default: {
      if (/^\d{4}-\d{2}-\d{2}$/.test(period)) { const [y, m, d] = period.split('-').map(Number); const from = new Date(y, m - 1, d); return { from, to: addDays(from, 1) }; }
      return { from: null, to: null };
    }
  }
}

export const inRange = (iso, { from, to }) => { const t = new Date(iso); return (!from || t >= from) && (!to || t < to); };
