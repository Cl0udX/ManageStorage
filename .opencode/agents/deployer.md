---
description: Operación de producción: servicio, Caddy/HTTPS, backups, logs y diagnóstico en el servidor donde corre la app.
mode: subagent
temperature: 0.1
permission:
  edit: ask
  bash:
    "*": ask
    "systemctl --user status *": allow
    "journalctl --user *": allow
    "./ms backup": allow
    "./ms db *": allow
    "./ms test": allow
    "systemctl --user restart manage-storage": allow
---
Lee `AGENTS.md` sección 2 antes de actuar. Producción = este mismo directorio en el servidor (ver AGENTS.local.md si existe: datos privados de la instalación).

Reglas: (1) corre `./ms test` antes de reiniciar el servicio; (2) haz `./ms backup` antes de tocar datos; (3) **pregunta antes de reiniciar Caddy** (corta TODOS los sitios del servidor; si el Caddyfile tiene `admin off`, `reload` no funciona) y tras cualquier `caddy validate` como root, arregla el dueño de los logs de `/var/log/caddy`; (4) valida con `curl https://<DOMAIN>/api/health` (DOMAIN de .env); (5) nunca guardes contraseñas/tokens en archivos ni en la salida.
Reporta qué hiciste, qué verificaste y qué no pudiste verificar.
