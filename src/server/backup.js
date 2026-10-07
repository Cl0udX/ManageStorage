// Respaldo consistente en caliente: VACUUM INTO → verificación de integridad → compresión → comprobación de que lo
// comprimido es idéntico al original → rotación. Un respaldo que no se comprueba no sirve: si algo falla, no se guarda nada
// "a medias" y el proceso termina con error (el temporizador de systemd lo deja visible).
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const sha256 = async (stream) => { const h = createHash('sha256'); for await (const c of stream) h.update(c); return h.digest('hex'); };

/** Fecha/hora "de pared" en una zona horaria (p. ej. America/Bogota): 2026-10-07_2355 */
export function stamp(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
}

export async function createBackup({ dbPath, dir, prefix = 'app', tz = 'UTC', keep = 30, now = new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${prefix}-${stamp(now, tz)}`;
  const tmp = join(dir, `.tmp-${process.pid}-${base}.db`);
  const out = join(dir, `${base}.db.gz`);
  const src = new DatabaseSync(dbPath);
  try {
    src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  } finally { src.close(); }
  try {
    // 1) la copia debe ser una base sana
    const copy = new DatabaseSync(tmp, { readOnly: true });
    const verdict = copy.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join(',');
    const counts = Object.fromEntries(['operations', 'records', 'entities', 'users'].map((t) => [t, copy.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
    copy.close();
    if (verdict !== 'ok') throw new Error(`integrity_check falló: ${verdict}`);
    // 2) se comprime y se comprueba que al descomprimir sale EXACTAMENTE lo mismo
    await pipeline(createReadStream(tmp), createGzip({ level: 9 }), createWriteStream(`${out}.partial`, { mode: 0o600 }));
    const [a, b] = await Promise.all([sha256(createReadStream(tmp)), sha256(createReadStream(`${out}.partial`).pipe(createGunzip()))]);
    if (a !== b) throw new Error('la copia comprimida no coincide con el original');
    renameSync(`${out}.partial`, out);
    pruneBackups(dir, prefix, keep);
    return { file: out, bytes: statSync(out).size, counts };
  } finally {
    rmSync(tmp, { force: true }); rmSync(`${out}.partial`, { force: true });
  }
}

/** Conserva los `keep` más recientes de cada tipo (app-*, pre-reset-*). Acepta también los .db sin comprimir de antes. */
export function pruneBackups(dir, prefix, keep) {
  const re = new RegExp(`^${prefix}-.*\\.db(\\.gz)?$`);
  const files = readdirSync(dir).filter((f) => re.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
}
