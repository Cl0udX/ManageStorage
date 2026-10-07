// Deja la base "nueva" para entregarla: borra los datos de una organización (ventas, productos, dispositivos…)
// y conserva la organización y sus usuarios. Hace un respaldo ANTES. Irreversible salvo restaurando ese respaldo.
//   ./ms node scripts/reset-data.js --yes                 (organización = ORG_NAME del .env; o --org "Nombre")  (conserva sesiones y equipos)
//   ./ms node scripts/reset-data.js --yes --drop-sessions  (también cierra sesiones y borra equipos)
import { openDb } from '../src/server/db/db.js';
import { resetOrgData } from '../src/server/sync/reset.js';
import { createBackup } from '../src/server/backup.js';
import { config } from '../src/server/config.js';

const a = process.argv.slice(2);
const orgName = a.includes('--org') ? a[a.indexOf('--org') + 1] : config.orgName;
const DB_PATH = config.dbPath;
if (!orgName) { console.error('uso: reset-data.js [--org "<nombre exacto>"] --yes'); process.exit(1); }

const db = openDb(DB_PATH);
const org = db.prepare('SELECT id,name FROM organizations WHERE name=?').get(orgName);
if (!org) { console.error(`no existe la organización "${orgName}"`); process.exit(1); }
const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE org_id=?`).get(org.id).c;
const drop = a.includes('--drop-sessions');
console.log(`Se borrarán de "${org.name}": ${n('operations')} operaciones, ${n('records')} ventas/compras/gastos, ${n('entities')} productos/config${drop ? `, ${n('devices')} dispositivos, ${n('sessions')} sesiones` : ''}.`);
console.log(`Se conservan: la organización, sus usuarios${drop ? '' : `, ${n('devices')} dispositivo(s) y ${n('sessions')} sesión(es) (nadie tiene que volver a entrar)`}.`);
if (!a.includes('--yes')) { console.log('\nNo se hizo nada. Agrega --yes para ejecutar.'); process.exit(0); }

// Respaldo verificado ANTES de borrar (si falla, no se borra nada).
const backup = await createBackup({ dbPath: DB_PATH, dir: config.backupDir, prefix: 'pre-reset', keep: 10 });
console.log(`Respaldo previo verificado: ${backup.file}`);
console.log('Resultado:', resetOrgData(db, org.id, { dropSessions: drop }));
db.close();
