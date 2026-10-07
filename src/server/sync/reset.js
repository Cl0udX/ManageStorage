// Reinicio de datos de UNA organización (p. ej. borrar las pruebas mientras el cliente ya usa la app).
// Conserva la organización, sus usuarios y —por defecto— sus SESIONES y DISPOSITIVOS (nadie tiene que volver a entrar);
// borra operaciones, ventas, productos y demás datos. Con { dropSessions: true } también cierra sesiones y borra equipos.
// Cambia la "época" de datos: los equipos que la tengan distinta descartan su copia local y bajan la nueva
// (sin esto, el equipo seguiría con su copia vieja y numeración que el servidor ya no conoce). Regla en el cliente
// (`SyncEngine._resetLocal`): se descarta lo ya sincronizado y se CONSERVA y reenvía lo que nunca se subió.
import { randomUUID } from 'node:crypto';
import { tx, audit } from '../db/db.js';
import { serverApply } from './service.js';
import { PAYMENT_METHODS } from '../../shared/constants.js';

const epochKey = (org_id) => `epoch:${org_id}`;
const strictKey = (org_id) => `strict_epoch:${org_id}`;

export function getEpoch(db, org_id) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(epochKey(org_id));
  if (row) return row.value;
  const v = randomUUID();
  db.prepare('INSERT OR IGNORE INTO meta (key,value) VALUES (?,?)').run(epochKey(org_id), v);
  return db.prepare('SELECT value FROM meta WHERE key=?').get(epochKey(org_id)).value;
}

/** Tras un reinicio se exige que los clientes manden su época (los viejos, que no la envían, se rechazan). */
export const isStrictEpoch = (db, org_id) => !!db.prepare('SELECT 1 FROM meta WHERE key=?').get(strictKey(org_id));

export function resetOrgData(db, org_id, { dropSessions = false } = {}) {
  const counts = {};
  const owner = db.prepare("SELECT id FROM users WHERE org_id=? AND role='owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1").get(org_id);
  if (!owner) throw new Error('la organización no tiene un owner activo');
  tx(db, () => {
    // Orden por claves foráneas: sesiones antes que dispositivos.
    const tables = ['operations', 'records', 'inventory_movements', 'conflicts', 'entities', 'audit_log'];
    for (const t of dropSessions ? ['sessions', 'devices', ...tables] : tables) {
      counts[t] = db.prepare(`DELETE FROM ${t} WHERE org_id=?`).run(org_id).changes;
    }
    if (dropSessions) {
      // Base de una sola organización y ya vacía: la numeración vuelve a empezar en 1 (los equipos se re-registran).
      for (const t of ['operations', 'inventory_movements', 'audit_log']) {
        if (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c === 0) db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(t);
      }
    } else {
      // Se conservan sesiones y equipos. La numeración de `operations` NO se reinicia (los cursores de los equipos
      // seguirían siendo válidos) y cada equipo vuelve a contar sus operaciones desde 1 (lo hace solo al detectar
      // la época nueva), así que su contador en el servidor también vuelve a 0.
      counts.devices_kept = db.prepare('UPDATE devices SET last_device_seq=0 WHERE org_id=?').run(org_id).changes;
      counts.sessions_kept = db.prepare('SELECT COUNT(*) c FROM sessions WHERE org_id=?').get(org_id).c;
    }
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(epochKey(org_id), randomUUID());
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(strictKey(org_id), '1');
    audit(db, { org_id, actor_user_id: owner.id, action: 'db.reset', detail: counts });
  });
  // Formas de pago base (entran al log, así todos los equipos las reciben).
  for (const pm of PAYMENT_METHODS) serverApply(db, org_id, owner.id, 'ENTITY_CREATE', 'payment_method', pm.id, { data: { name: pm.name } });
  return counts;
}
