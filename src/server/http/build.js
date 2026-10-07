// Identificador de versión de la app (hash del contenido de TODO lo que el navegador descarga) y lista de
// archivos a precachear. Se inyectan en /sw.js al servirlo → cualquier cambio de código cambia los bytes de
// sw.js y los equipos instalados se actualizan solos. Nada que subir/mantener a mano.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, extname } from 'node:path';

const EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.png', '.svg']);

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (EXT.has(extname(e.name))) out.push(p);
  }
}

export function makeBuildInfo(root, extra = () => '') {
  const roots = [join(root, 'public'), join(root, 'src', 'shared'), join(root, 'src', 'domain'), join(root, 'src', 'client')];
  let memo = null;
  return function buildInfo() {
    const files = [];
    for (const r of roots) walk(r, files);
    files.sort();
    const cfg = extra();
    const sig = files.map((f) => { const s = statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; }).join('|') + cfg;
    if (memo?.sig === sig) return memo.value;
    const h = createHash('sha256').update(cfg);
    for (const f of files) h.update(f).update(readFileSync(f));
    const urls = files
      .map((f) => { const rel = `/${relative(root, f).split(sep).join('/')}`; return rel.startsWith('/public/') ? rel.slice(7) : rel; })
      .filter((u) => u !== '/sw.js');
    urls.unshift('/');
    memo = { sig, value: { build: h.digest('hex').slice(0, 12), files: urls } };
    return memo.value;
  };
}
