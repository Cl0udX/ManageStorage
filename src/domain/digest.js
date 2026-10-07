// Huella (hash) del estado de negocio: catálogo/config, stock y las últimas ventas/compras/gastos.
// El servidor la calcula sobre su base y el cliente sobre su copia: si difieren (p. ej. alguien editó o borró
// filas directamente en la base de datos, o una copia local se corrompió), el cliente descarga un snapshot nuevo.
// Corre idéntica en Node y en el navegador (crypto.subtle). Ignora lo puramente local (`pending`, `field_meta`).

const canon = (obj) => JSON.stringify(Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1))));

/** `recordsFrom` (ISO): solo cuentan los registros desde esa fecha; la fija el servidor para que ambos lados comparen lo mismo. */
export async function stateDigest(state, { recordsFrom = null } = {}) {
  const lines = [];
  for (const [type, bucket] of Object.entries(state.entities)) {
    for (const [id, e] of Object.entries(bucket)) {
      const { id: _id, version, field_meta: _fm, pending: _p, ...data } = e;
      lines.push(`e|${type}|${id}|${version ?? 0}|${canon(data)}`);
    }
  }
  for (const [pid, n] of Object.entries(state.stock)) if (n) lines.push(`s|${pid}|${n}`);
  for (const r of Object.values(state.records)) {
    if (recordsFrom && r.created_at < recordsFrom) continue;
    lines.push(`r|${r.id}|${r.kind}|${r.voided ? 1 : 0}|${r.amount}`);
  }
  lines.sort();
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n')));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
