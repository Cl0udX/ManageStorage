// Validación de hora: con internet, el equipo debe tener la fecha/hora/zona correctas (si no, las ventas quedarían en
// la semana equivocada). Sin internet no se puede comprobar: se vuelve a comprobar en cuanto haya conexión.
import { NetworkError } from './api/api-client.js';
import { evaluateClock } from '../shared/time.js';

let lastSkewMs = null;
export const lastSkewSeconds = () => (lastSkewMs == null ? undefined : Math.round(lastSkewMs / 1000));

/** @returns {Promise<ReturnType<typeof evaluateClock> & {serverNow?:number}>} */
export async function checkClock(api, { nowFn = () => Date.now(), local } = {}) {
  const t0 = nowFn();
  let res;
  try { res = await api.time(); } catch (e) {
    if (e instanceof NetworkError) return { ok: true, unknown: true, reason: null, skewMs: 0 };
    throw e;
  }
  const t1 = nowFn();
  const out = evaluateClock({ serverNow: res.now, serverTz: res.timezone, t0, t1, local: local ?? new Date(t1) });
  if (!out.unknown) lastSkewMs = out.skewMs;
  return { ...out, serverNow: res.now };
}
