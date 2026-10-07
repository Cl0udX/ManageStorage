// Instala (o actualiza) los servicios de systemd DE USUARIO a partir de .env: la app y el respaldo diario.
// No necesita root. Uso:  ./ms install            instala y arranca
//                         ./ms install --print    solo muestra lo que escribiría
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config, ROOT } from '../src/server/config.js';

const print = process.argv.includes('--print');
const [hh, mm] = config.backupTime.split(':');
const vars = { '@APP_NAME@': config.appName, '@DIR@': ROOT, '@BACKUP_TIME@': `${hh.padStart(2, '0')}:${mm}`, '@TIMEZONE@': config.backupTz };
const render = (file) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(k, v), readFileSync(join(ROOT, 'deploy', file), 'utf8'));
const name = config.serviceName;
const files = { [`${name}.service`]: render('service.template'), [`${name}-backup.service`]: render('backup.service.template'), [`${name}-backup.timer`]: render('backup.timer.template') };

if (print) { for (const [f, t] of Object.entries(files)) console.log(`# ===== ${f} =====\n${t}`); process.exit(0); }

const dir = join(homedir(), '.config', 'systemd', 'user');
mkdirSync(dir, { recursive: true });
for (const [f, t] of Object.entries(files)) { writeFileSync(join(dir, f), t); console.log(`escrito ${join(dir, f)}`); }
const ctl = (...a) => execFileSync('systemctl', ['--user', ...a], { stdio: 'inherit' });
ctl('daemon-reload');
ctl('enable', `${name}.service`);
ctl('restart', `${name}.service`);
ctl('enable', '--now', `${name}-backup.timer`);
try {
  const linger = execFileSync('loginctl', ['show-user', process.env.USER ?? '', '-p', 'Linger'], { encoding: 'utf8' }).trim();
  if (linger !== 'Linger=yes') console.log('\nAVISO: para que el servicio siga corriendo al cerrar tu sesión SSH y arranque con el servidor, ejecuta una vez:  loginctl enable-linger $USER');
} catch { /* sin loginctl */ }
console.log(`\nListo. Estado:  systemctl --user status ${name}    ·    próximo respaldo:  systemctl --user list-timers ${name}-backup.timer`);
