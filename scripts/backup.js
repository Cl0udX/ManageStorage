// Respaldo diario (lo ejecuta el temporizador de systemd a la hora BACKUP_TIME de tu zona horaria) o manual: ./ms backup
// Guarda en BACKUP_DIR (BACKUP_DIR en .env; por defecto ~/ManageStorage-backups, FUERA de la carpeta del proyecto) un .db.gz verificado.
// IMPORTANTE: es otra carpeta del MISMO servidor: protege de borrados/errores, NO de que se pierda el servidor entero.
//   ./ms backup                 crear un respaldo ahora
//   ./ms backup list            listar los respaldos
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { createBackup } from '../src/server/backup.js';
import { config } from '../src/server/config.js';

const dir = config.backupDir;
if (process.argv[2] === 'list') {
  const rows = readdirSync(dir).filter((f) => /\.db(\.gz)?$/.test(f)).sort().map((f) => ({ archivo: f, kb: Math.round(statSync(join(dir, f)).size / 1024) }));
  console.table(rows);
} else {
  try {
    const r = await createBackup({ dbPath: config.dbPath, dir, tz: config.backupTz, keep: config.backupKeep });
    console.log(`respaldo verificado: ${r.file} (${Math.round(r.bytes / 1024)} KB)`, r.counts);
  } catch (e) { console.error('RESPALDO FALLÓ:', e.message); process.exit(1); }
}
