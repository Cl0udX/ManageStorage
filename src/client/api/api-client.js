import { PROTO } from '../../shared/constants.js';

// Cliente HTTP. Distingue fallos de RED (reintentables, sin respuesta fiable) de respuestas HTTP.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status; this.code = body?.error ?? null; this.body = body;
  }
}
export class NetworkError extends Error {}

export class ApiClient {
  constructor({ baseUrl = '', fetch = globalThis.fetch?.bind(globalThis), getToken = () => null, getEpoch = () => null, getClientInfo = () => null, timeoutMs = 20_000 } = {}) {
    this.baseUrl = baseUrl; this.fetch = fetch; this.getToken = getToken; this.getEpoch = getEpoch; this.getClientInfo = getClientInfo; this.timeoutMs = timeoutMs;
  }

  async _req(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
    const token = await this.getToken();
    const epoch = await this.getEpoch();
    const info = await this.getClientInfo();
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method, cache: 'no-store',
        headers: { 'X-Proto': String(PROTO), ...(epoch ? { 'X-Epoch': epoch } : {}), ...(info ? { 'X-Client-Info': info } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) { throw new NetworkError(e?.message ?? 'network error'); }
    let json = null;
    try { json = await res.json(); } catch (e) {
      // Cuerpo cortado en una respuesta "ok" = no sabemos qué pasó → tratar como fallo de red y reintentar.
      if (res.ok) throw new NetworkError('truncated response');
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  login(username, password, device_id, device_name, opts) { return this._req('POST', '/api/login', { username, password, device_id, device_name }, opts); }
  weekReport(startIso, endIso) { return this._req('GET', `/api/reports/week?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`); }
  time() { return this._req('GET', '/api/time', undefined, { timeoutMs: 6000 }); }
  logout() { return this._req('POST', '/api/logout', {}); }
  snapshot() { return this._req('GET', '/api/sync/snapshot'); }
  pull(since, limit = 200) { return this._req('GET', `/api/sync/pull?since=${since}&limit=${limit}`); }
  push(ops) { return this._req('POST', '/api/sync/push', { ops }); }
  conflicts() { return this._req('GET', '/api/conflicts'); }
  resolveConflict(id, choice, value) { return this._req('POST', `/api/conflicts/${encodeURIComponent(id)}/resolve`, { choice, value }); }
  devices() { return this._req('GET', '/api/devices'); }
  revokeDevice(id) { return this._req('POST', `/api/devices/${encodeURIComponent(id)}/revoke`, {}); }
}
