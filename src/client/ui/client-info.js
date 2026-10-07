// Datos del equipo que el navegador ya conoce, enviados en silencio al servidor (cabecera X-Client-Info) para poder
// identificar de dónde viene cada equipo. No pide permisos, no muestra nada y no hay nada que escribir.
import { lastSkewSeconds } from '../clock.js';
import { protectStorage } from '../storage-guard.js';

let memo = null;
let storage = null;

async function collect() {
  const n = navigator, s = globalThis.screen, c = n.connection;
  const info = {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: n.language, langs: (n.languages ?? []).slice(0, 3).join(','),
    screen: s ? `${s.width}x${s.height}` : undefined, dpr: globalThis.devicePixelRatio,
    standalone: globalThis.matchMedia?.('(display-mode: standalone)').matches || n.standalone === true, // ¿app instalada o pestaña?
    touch: n.maxTouchPoints, cores: n.hardwareConcurrency, mem: n.deviceMemory, conn: c?.effectiveType, platform: n.userAgentData?.platform ?? n.platform,
  };
  try { // Chrome/Android entrega el modelo del equipo sin pedir permiso
    const hi = await n.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion', 'architecture']);
    if (hi) Object.assign(info, { model: hi.model || undefined, osv: hi.platformVersion || undefined, arch: hi.architecture || undefined });
  } catch { /* no disponible */ }
  try { info.app = (await caches.keys()).find((k) => k.startsWith('shell-'))?.slice(6); } catch { /* sin Cache API */ } // versión de la app instalada
  info.skew = lastSkewSeconds(); // desfase del reloj medido contra el servidor
  storage ??= await protectStorage();
  info.persisted = storage.persisted;
  return encodeURIComponent(JSON.stringify(info));
}

export async function getClientInfo() {
  if (memo && Date.now() - memo.at < 60_000) return memo.value;
  try { memo = { at: Date.now(), value: await collect() }; } catch { memo = { at: Date.now(), value: null }; }
  return memo.value;
}
