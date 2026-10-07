// Inicio de sesión que funciona SIN conexión.
// Online: valida contra el servidor y guarda un verificador local (PBKDF2 con sal, nunca la contraseña).
// Sin conexión: valida contra ese verificador y deja trabajar; el token del servidor se renueva
// solo cuando vuelve internet. El PRIMER inicio de sesión en cada dispositivo requiere internet
// (el servidor tiene que registrar el dispositivo).
import { NetworkError } from '../api/api-client.js';

const ITERATIONS = 210_000;
const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class LocalAuthError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function derive(password, salt, iterations) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function makeVerifier(password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), iterations: ITERATIONS, hash: b64(await derive(password, salt, ITERATIONS)) };
}

export async function checkVerifier(password, v) {
  const got = await derive(password, unb64(v.salt), v.iterations);
  const want = unb64(v.hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] ?? 0);
  return diff === 0;
}

/**
 * @returns {{mode:'online'|'offline', session:{token:string|null,user:object,org:object,expires_at?:string}}}
 * Lanza ApiError (credenciales malas según el servidor) o LocalAuthError (según el verificador local).
 */
export async function login({ api, store, username, password, deviceId, deviceName, isOnline = () => true, timeoutMs = 6000 }) {
  if (isOnline()) {
    try {
      const r = await api.login(username, password, deviceId, deviceName, { timeoutMs });
      const session = { token: r.token, expires_at: r.expires_at, user: r.user, org: r.org };
      const { meta } = await store.load();
      const local_auth = { ...(meta.local_auth ?? {}), [username]: { ...(await makeVerifier(password)), user: r.user, org: r.org } };
      await store.setMeta({ session, local_auth });
      return { mode: 'online', session };
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e; // el servidor respondió (401/403…): esa respuesta manda
    }
  }
  const { meta } = await store.load();
  const la = meta.local_auth?.[username];
  if (!la) throw new LocalAuthError('first_login_needs_internet');
  if (!(await checkVerifier(password, la))) throw new LocalAuthError('invalid_credentials');
  // Se conserva el token anterior (puede seguir vigente); si venció, el motor lo detecta y se renueva al volver internet.
  const keep = meta.session?.user?.username === username ? meta.session : null;
  const session = keep ?? { token: null, user: la.user, org: la.org };
  await store.setMeta({ session });
  return { mode: 'offline', session };
}

/** Renueva el token del servidor con la contraseña que el usuario acaba de escribir (sin tocar datos locales). */
export async function refreshToken({ api, store, username, password, deviceId, deviceName }) {
  const r = await api.login(username, password, deviceId, deviceName);
  const session = { token: r.token, expires_at: r.expires_at, user: r.user, org: r.org };
  await store.setMeta({ session });
  return session;
}
