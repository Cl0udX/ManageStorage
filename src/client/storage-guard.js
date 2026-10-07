// Protección de los datos guardados en el equipo contra el borrado automático del navegador.
// - Pide almacenamiento "persistente" (Chrome/Android/Firefox lo conceden; evita que el sistema lo limpie si falta espacio).
// - Safari en iPhone/iPad borra los datos de un SITIO que no se usa en 7 días, PERO NO los de una app instalada en la
//   pantalla de inicio: por eso se sugiere instalarla.
import { needsInstallHint } from '../shared/time.js';

export const isStandalone = () => globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export async function protectStorage() {
  let persisted = false;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
    if (!persisted) persisted = (await navigator.storage?.persist?.()) ?? false;
  } catch { /* no disponible */ }
  return { persisted, installed: isStandalone() };
}

export const shouldSuggestInstall = () => needsInstallHint({ ua: navigator.userAgent, standalone: isStandalone(), maxTouchPoints: navigator.maxTouchPoints, platform: navigator.platform });
