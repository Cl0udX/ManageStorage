// Cambios administrativos que SÍ se reflejan en todos los equipos (pasan por el registro de operaciones y quedan
// auditados). Úsalos en vez de borrar filas a mano.
//   ./ms node scripts/admin.js void <id_de_venta_compra_o_gasto>   anula (corrige el stock con movimientos compensatorios)
//   ./ms node scripts/admin.js archive-product <id_producto>       quita el producto de las listas (conserva su historial)
//   ./ms node scripts/admin.js restore-product <id_producto>       lo vuelve a mostrar
//   ./ms node scripts/admin.js set-timezone <zona IANA>            zona horaria del negocio (p. ej. America/Mexico_City, Europe/Madrid, UTC)
//   ./ms node scripts/admin.js name-device <id_o_inicio_del_id> "Celular de la caja"   le pone nombre a un equipo (ver ./ms db devices)
// Opcional: --org "Nombre" (si hay varias organizaciones). Los ids se ven con: ./ms db "select id, kind, amount from records"
import { openDb } from '../src/server/db/db.js';
import { serverApply } from '../src/server/sync/service.js';
import { config } from '../src/server/config.js';

const a = process.argv.slice(2);
const [cmd, id] = a;
const orgName = a.includes('--org') ? a[a.indexOf('--org') + 1] : null;
const db = openDb(config.dbPath);
const orgs = db.prepare('SELECT id,name FROM organizations WHERE (? IS NULL OR name=?)').all(orgName, orgName);
if (orgs.length !== 1) { console.error(orgs.length ? 'hay varias organizaciones: usa --org "Nombre"' : 'organización no encontrada'); process.exit(1); }
const org = orgs[0].id;
const owner = db.prepare("SELECT id FROM users WHERE org_id=? AND role='owner' ORDER BY created_at LIMIT 1").get(org).id;

try {
  if (cmd === 'void' && id) {
    const rec = db.prepare('SELECT op_id, kind, voided FROM records WHERE org_id=? AND id=?').get(org, id);
    if (!rec) throw new Error('no existe ese id en records');
    if (rec.voided) { console.log('ya estaba anulado'); process.exit(0); }
    const seq = serverApply(db, org, owner, 'OP_VOID', 'void', `admin-${rec.op_id}`, { target_op_id: rec.op_id, reason: 'anulado por el administrador' });
    console.log(`anulado (${rec.kind}), op seq ${seq}`);
  } else if ((cmd === 'archive-product' || cmd === 'restore-product') && id) {
    const e = db.prepare("SELECT version FROM entities WHERE org_id=? AND type='product' AND id=?").get(org, id);
    if (!e) throw new Error('no existe ese producto');
    const seq = serverApply(db, org, owner, 'ENTITY_UPDATE', 'product', id, { changes: { archived: cmd === 'archive-product' } }, e.version);
    console.log(`${cmd === 'archive-product' ? 'archivado' : 'restaurado'}, op seq ${seq}`);
  } else if (cmd === 'set-timezone' && id) {
    const { isValidTimeZone } = await import('../src/shared/time.js');
    if (!isValidTimeZone(id)) throw new Error('zona horaria inválida (usa nombres IANA, p. ej. America/Mexico_City)');
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('timezone',?)").run(id);
    console.log(`zona horaria del negocio: ${id}`);
  } else if (cmd === 'name-device' && id && a[2]) {
    const rows = db.prepare("SELECT id FROM devices WHERE org_id=? AND id LIKE ? || '%'").all(org, id);
    if (rows.length !== 1) throw new Error(rows.length ? 'ese inicio de id coincide con varios equipos' : 'no existe ese equipo (usa ./ms db devices)');
    db.prepare('UPDATE devices SET label=?, name=? WHERE id=?').run(a[2].slice(0, 60), a[2].slice(0, 60), rows[0].id);
    console.log('equipo renombrado');
  } else {
    console.error('uso: admin.js void <id> | archive-product <id> | restore-product <id> | name-device <id> "nombre"  [--org "Nombre"]');
    process.exit(1);
  }
} catch (e) { console.error('error:', e.message); process.exit(1); }
db.close();
