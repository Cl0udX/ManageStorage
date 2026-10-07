// MemoryStore persistido a disco (escritura atómica tmp+rename). Solo Node: tests de reinicio.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { MemoryStore } from './memory-store.js';

export class FileStore extends MemoryStore {
  constructor(path) {
    super(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined);
    this.path = path;
  }

  async _persist() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ meta: this.meta, state: this.state, ops: [...this.ops.values()] }));
    renameSync(tmp, this.path);
  }
}
