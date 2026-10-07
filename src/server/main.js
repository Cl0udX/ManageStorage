import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { openDb } from './db/db.js';
import { createApp } from './http/server.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDb(config.dbPath);
const server = createApp(db);
server.listen(config.port, config.host, () => console.log(`${config.appName} escuchando en http://${config.host}:${config.port} (db: ${config.dbPath})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
