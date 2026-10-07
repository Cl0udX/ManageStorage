// Configuración central. Lee ".env" (si existe, en la raíz del proyecto) y expone cada valor con su valor por defecto.
// Las variables de entorno ya definidas (p. ej. por systemd o la terminal) tienen prioridad sobre ".env".
// Todo se lee de forma "perezosa" (en cada uso) para que los tests puedan cambiar process.env.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
try { if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env')); } catch (e) { console.warn('No se pudo leer .env:', e.message); }

const str = (k, d) => (process.env[k] ?? '').trim() || d;
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && process.env[k] !== '' && process.env[k] != null ? n : d; };
const flag = (k, d) => { const v = (process.env[k] ?? '').trim(); return v === '' ? d : !/^(0|false|off|no)$/i.test(v); };
export const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export const config = {
  get appName() { return str('APP_NAME', 'Inventario'); },
  get appShortName() { return str('APP_SHORT_NAME', this.appName.slice(0, 12)); },
  get themeColor() { return /^#[0-9a-fA-F]{6}$/.test(str('THEME_COLOR', '')) ? str('THEME_COLOR', '') : '#14532d'; },
  get timezone() { return str('TIMEZONE', 'UTC'); },
  get locale() { return str('LOCALE', 'es'); },
  get currency() { return str('CURRENCY', 'USD'); },
  get orgName() { return str('ORG_NAME', 'Mi Negocio'); },
  get ownerUsername() { return str('OWNER_USERNAME', 'admin'); },
  get host() { return str('HOST', '127.0.0.1'); },
  get port() { return num('PORT', 8095); },
  get dbPath() { return resolve(ROOT, expandHome(str('DB_PATH', './data/app.db'))); },
  get trustProxy() { return flag('TRUST_PROXY', true); },
  get loginMax() { return num('LOGIN_MAX_ATTEMPTS', 10); },
  get geoLookup() { return flag('GEO_LOOKUP', true); },
  get domain() { return str('DOMAIN', 'inventario.example.com'); },
  get serviceName() { return str('SERVICE_NAME', 'manage-storage'); },
  get backupDir() { return resolve(ROOT, expandHome(str('BACKUP_DIR', '~/ManageStorage-backups'))); },
  get backupKeep() { return num('BACKUP_KEEP', 30); },
  get backupTime() { return /^\d{1,2}:\d{2}$/.test(str('BACKUP_TIME', '')) ? str('BACKUP_TIME', '') : '23:55'; },
  get backupTz() { return str('BACKUP_TZ', this.timezone); },
  /** Lo que ve el navegador (se inyecta en index.html). Nada secreto. */
  get publicConfig() { return { appName: this.appName, locale: this.locale, currency: this.currency, themeColor: this.themeColor }; },
};
