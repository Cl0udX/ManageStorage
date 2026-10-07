// Configuración visible para el navegador (nombre, idioma, moneda, color). La inyecta el servidor en index.html
// (<meta name="app-config">) a partir del .env; aquí solo hay valores neutros por si no estuviera.
const defaults = { appName: 'Inventario', locale: 'es', currency: 'USD', themeColor: '#14532d' };

export const appConfig = (() => {
  try { return { ...defaults, ...JSON.parse(globalThis.document?.querySelector('meta[name="app-config"]')?.content ?? '{}') }; } catch { return defaults; }
})();
