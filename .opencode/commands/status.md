---
description: Estado del servicio en producción
agent: deployer
---
Revisa: `systemctl --user status manage-storage`, las últimas 20 líneas de `journalctl --user -u manage-storage`, `curl -s <PUBLIC_URL>/api/health` (la URL pública = https://DOMAIN, con DOMAIN de .env), y el último backup en `data/backups/`. Resume en 5 líneas.
