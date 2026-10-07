// Imprime el bloque de Caddy (proxy + HTTPS automático) con DOMAIN y PORT del .env:  ./ms caddy
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../src/server/config.js';

const t = readFileSync(join(ROOT, 'deploy', 'Caddyfile.template'), 'utf8');
console.log(t.replaceAll('@APP_NAME@', config.appName).replaceAll('@DOMAIN@', config.domain).replaceAll('@PORT@', String(config.port)));
if (config.domain.endsWith('example.com')) console.error('AVISO: DOMAIN en .env sigue siendo el de ejemplo. Cámbialo por tu dominio real antes de usar este bloque.');
