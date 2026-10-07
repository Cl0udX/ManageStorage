// Crea/actualiza un usuario existente. La contraseña se lee de stdin (no queda en el historial de la shell).
// Uso: echo "clave" | node scripts/set-user.js <usuario-actual> [--rename nuevo] [--role owner|staff] [--disable]
//      echo "clave" | node scripts/set-user.js --create <usuario> [--org "<nombre exacto>"]  (por defecto ORG_NAME del .env) [--role owner|staff]
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, nowIso, audit } from '../src/server/db/db.js';
import { hashPassword } from '../src/server/auth/auth.js';
import { config } from '../src/server/config.js';

const a = process.argv.slice(2);
const flag = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
const db = openDb(config.dbPath);
const readPw = () => readFileSync(0, 'utf8').trim();

if (a.includes('--create')) {
  const username = flag('create'); const org = db.prepare('SELECT id FROM organizations WHERE name=?').get((flag('org') ?? config.orgName));
  if (!username || !org) { console.error('falta --create <usuario> o --org válido'); process.exit(1); }
  const role = flag('role') ?? 'owner';
  db.prepare('INSERT INTO users (id,org_id,username,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), org.id, username, hashPassword(readPw()), role, nowIso());
  audit(db, { org_id: org.id, action: 'user.created', detail: { username, role } });
  console.log(`creado ${username} (${role})`);
} else {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(a[0]);
  if (!user) { console.error('usuario no existe'); process.exit(1); }
  if (a.includes('--disable')) {
    db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(nowIso(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    console.log(`deshabilitado ${user.username}`);
  } else {
    const pw = readPw();
    db.prepare('UPDATE users SET password_hash=?, username=?, role=? WHERE id=?')
      .run(hashPassword(pw), flag('rename') ?? user.username, flag('role') ?? user.role, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    audit(db, { org_id: user.org_id, actor_user_id: user.id, action: 'user.updated', detail: { rename: flag('rename') ?? null, role: flag('role') ?? null } });
    console.log(`actualizado ${flag('rename') ?? user.username}`);
  }
}
db.close();
