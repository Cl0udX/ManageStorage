// Crea una organización con su owner (y opcionalmente un staff) y datos base.
// Uso: ./ms seed [--org "Mi Negocio"] [--owner usuario] [--staff otro]   (por defecto ORG_NAME y OWNER_USERNAME del .env)
// Las contraseñas se generan al azar y se imprimen UNA vez.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../src/server/db/db.js';
import { createOrganization, createUser } from '../src/server/auth/auth.js';
import { serverApply } from '../src/server/sync/service.js';
import { config } from '../src/server/config.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const orgName = arg('org') ?? config.orgName; const owner = arg('owner') ?? config.ownerUsername; const staff = arg('staff');
if (!orgName || !owner) { console.error('uso: seed.js [--org <nombre>] [--owner <usuario>] [--staff <usuario>]'); process.exit(1); }

const DB_PATH = config.dbPath;
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const pw = () => randomBytes(12).toString('base64url');

const ownerPw = pw();
const { org_id, user_id } = createOrganization(db, { name: orgName, ownerUsername: owner, ownerPassword: ownerPw });
serverApply(db, org_id, user_id, 'ENTITY_CREATE', 'payment_method', 'pm-cash', { data: { name: 'Efectivo' } });
serverApply(db, org_id, user_id, 'ENTITY_CREATE', 'payment_method', 'pm-transfer', { data: { name: 'Transferencia' } });
console.log(`org: ${orgName} (${org_id})\nowner: ${owner} / ${ownerPw}`);
if (staff) {
  const staffPw = pw();
  createUser(db, { org_id, username: staff, password: staffPw, role: 'staff' });
  console.log(`staff: ${staff} / ${staffPw}`);
}
db.close();
