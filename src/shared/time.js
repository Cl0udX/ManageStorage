// Utilidades de hora (puras; corren igual en Node y en el navegador).

/** Desfase en minutos de una zona horaria IANA respecto a UTC en un instante (p. ej. America/Bogota → -300). */
export function tzOffsetMinutes(timeZone, date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wall - (date.getTime() - date.getMilliseconds())) / 60000);
}

export const isValidTimeZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; } };

/**
 * ¿La hora de este equipo es la correcta? Compara contra la hora del servidor (corrigiendo el tiempo de ida y vuelta)
 * y el desfase de zona horaria contra el de la zona del negocio. No depende del país: la zona la define el servidor.
 * @returns {{ok:boolean, unknown?:boolean, reason:null|'clock'|'timezone', skewMs:number, serverTz:string}}
 */
export function evaluateClock({ serverNow, serverTz, t0, t1, local = new Date(t1), maxSkewMs = 5 * 60_000, maxRttMs = 15_000 }) {
  const rtt = t1 - t0;
  if (!(rtt >= 0) || rtt > maxRttMs) return { ok: true, unknown: true, reason: null, skewMs: 0, serverTz }; // red demasiado lenta para medir
  const skewMs = Math.round((t0 + rtt / 2) - serverNow); // + ⇒ el equipo está ADELANTADO
  if (Math.abs(skewMs) > maxSkewMs) return { ok: false, reason: 'clock', skewMs, serverTz };
  if (isValidTimeZone(serverTz) && -local.getTimezoneOffset() !== tzOffsetMinutes(serverTz, new Date(serverNow))) return { ok: false, reason: 'timezone', skewMs, serverTz };
  return { ok: true, reason: null, skewMs, serverTz };
}

/** ¿Hay que sugerir instalar la app? (iPhone/iPad en Safari, sin instalar: Safari borra datos de sitios sin uso por 7 días.) */
export function needsInstallHint({ ua = '', standalone = false, maxTouchPoints = 0, platform = '' }) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return ios && !standalone;
}
