# ManageStorage — contexto completo para cualquier IA / desarrollador

> Léelo entero antes de tocar código. La UI y la documentación están en español sencillo (la interfaz aún no tiene i18n; moneda, fechas y zona horaria sí son configurables).
> Este archivo es la fuente única de contexto: lo leen opencode, Claude Code, Codex, Cursor, etc. (`.opencode/` solo añade agentes y comandos).

## 1. Qué es y para quién

PWA **offline-first** y genérica para pequeños negocios que manejan inventario, ventas, compras y gastos. Pensada para personas
que **no saben de informática** y que **a veces no tienen internet**: cada producto tiene costo, precio y cantidad, todo funciona
sin conexión y se sincroniza solo cuando vuelve internet; el reporte principal es la **ganancia semanal**.
El sistema es genérico a propósito: **no hay lógica específica de ningún tipo de negocio** y no se debe agregar sin que el dueño de la instalación lo pida.
Todo lo propio de cada instalación (nombre, moneda, zona horaria, dominio, organización) vive en **`.env`** (plantilla: `.env.example`), nunca en el código.

Prioridad absoluta, en este orden: **CORRECTNESS > NO PERDER DATOS > OFFLINE > SINCRONIZACIÓN > SIMPLICIDAD > FEATURES.**

> Si existe `AGENTS.local.md` (archivo privado, fuera del repositorio), léelo también: tiene los datos reales de esa instalación.

## 2. Configuración y despliegue

Toda la configuración está en `.env` (cópialo de `.env.example`): identidad (`APP_NAME`, `APP_SHORT_NAME`, `THEME_COLOR`), región (`TIMEZONE`, `LOCALE`, `CURRENCY`),
datos iniciales (`ORG_NAME`, `OWNER_USERNAME`), servidor (`HOST`, `PORT`, `DB_PATH`, `TRUST_PROXY`, `LOGIN_MAX_ATTEMPTS`, `GEO_LOOKUP`), publicación (`DOMAIN`, `SERVICE_NAME`) y respaldos (`BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_TIME`).
Se lee en `src/server/config.js` (valores por defecto neutros: UTC / `es` / USD). Las variables ya definidas en el entorno tienen prioridad sobre `.env`. Cambiar la identidad cambia el *build* de la app y los equipos instalados se actualizan solos.

Despliegue típico (Linux con systemd, Node ≥ 22.5; recomendado 24):
1. `cp .env.example .env` y editarlo. 2. `./ms seed` (crea la organización y el dueño; imprime la contraseña UNA vez). 3. `./ms install` (servicio de usuario + respaldo diario programado, sin root).
4. `./ms caddy` imprime el bloque para tu Caddyfile (HTTPS obligatorio: sin él no funcionan Service Worker ni la app instalada).

**Reglas de operación (aprendidas por las malas):**
1. Si el Caddyfile tiene `admin off`, `systemctl reload caddy` NO funciona y hay que `restart`, lo que corta unos segundos a *todos* los sitios que sirva ese Caddy. Pide confirmación al dueño antes.
2. **No ejecutes `caddy validate` como root** sin después devolver el dueño (`chown caddy:caddy`) de los logs que cree: un log propiedad de root hace fallar el siguiente `restart` y tumba todos los sitios.
3. No instales paquetes del sistema sin permiso del dueño.
4. Antes de cambiar datos de producción, haz `./ms backup`.
5. **Jamás escribas contraseñas, tokens ni claves en archivos del repo, memoria o logs.** Úsalas solo en el comando y no las persistas. `.env`, `data/` y los respaldos están en `.gitignore`.

## 3. Comandos

```bash
# Dentro de la carpeta del proyecto. USA SIEMPRE el lanzador ./ms: elige un Node que traiga node:sqlite
# (el `node` de tu shell puede ser más viejo, y por SSH no interactivo puede no haber node en el PATH).
./ms test                                 # 51 tests (node --test test/*.test.js). Deben pasar SIEMPRE antes de desplegar
systemctl --user restart <SERVICE_NAME>   # aplicar cambios de servidor (el frontend se sirve desde disco: basta recargar)
./ms backup                               # backup en caliente (VACUUM INTO)
# Ver datos (SOLO LECTURA):
./ms db tables | schema [tabla] | stock | ops [N] | "SELECT ..."
./ms db-web                               # visor web de solo lectura (túnel SSH con -t, ver README). Si el puerto lo ocupa un visor anterior, lo cierra y abre uno nuevo (nunca toca otro programa); se cierra solo tras 30 min sin uso
# Usuarios (la clave entra por stdin, no por argumento):
printf '%s' 'clave' | ./ms user <usuario> [--rename nuevo] [--role owner|staff]
printf '%s' 'clave' | ./ms user --create <usuario> [--org "Nombre"] --role owner
./ms user <usuario> --disable
./ms seed [--org "Nombre"] [--owner usuario] [--staff otro]   # nueva organización (por defecto ORG_NAME / OWNER_USERNAME de .env)
```
**Actualizaciones de la app (automáticas):** el servidor calcula `build` = hash del contenido de `public/` + `src/{client,domain,shared}` y lo inyecta, junto con la lista completa de archivos, en `/sw.js`. No hay que subir ninguna versión ni mantener listas: basta desplegar los archivos. Los equipos con internet detectan el cambio (al abrir, cada 15 min, al volver a la app o recuperar conexión), descargan el paquete nuevo completo en segundo plano y lo activan cuando no hay venta ni diálogo abierto (si no, muestran "Actualizar ahora"). Sin internet siguen con la versión instalada, sin mezclar versiones. Un test verifica que todo archivo servible esté en el precache.

## 4. Arquitectura en 1 minuto (detalle: `docs/ARCHITECTURE.md`)

- **Servidor** (`src/server`): Node `node:http` + `node:sqlite`, **cero dependencias npm**. SQLite en vez de PostgreSQL porque el servidor no tiene Postgres/Docker/root; acceso a datos aislado → migrable.
- **Cliente** (`src/client`): JS ES modules sin build. IndexedDB (nunca localStorage) + Service Worker. El mismo `src/domain` y `src/shared` corren en servidor y navegador.
- **Modelo = log de operaciones + estado derivado.** El cliente nunca envía "estado final"; envía **operaciones** (hechos) con `op_id` único, `device_id`, `device_seq`, `base_version`, `created_at`. El servidor las aplica, las guarda en `operations` (orden = `seq`) y publica `effects` normalizados que todos los dispositivos aplican igual.
- **Sync**: push (ordenado por `device_seq`, idempotente por `op_id`, hueco ⇒ se detiene) → pull desde cursor. Vista local = estado del servidor + ops locales aún no cubiertas por el cursor.
- **Dos tipos de dato, dos estrategias (NO mezclar):**
  - *Acumulativos* (venta, compra, ajuste de stock, gasto): hechos conmutativos que **se apilan**. Stock = `SUM(inventory_movements.delta)`. Anular = movimientos compensatorios, jamás borrar.
  - *Estado/config* (nombre, precio, costo…): **merge por campo** con `version`/`field_meta`; si dos dispositivos cambian el MISMO campo concurrentemente ⇒ **conflicto explícito** (se guardan ambos valores) que el `owner` resuelve. **Nunca last-write-wins.**
- **Login offline** (`src/client/auth/session.js`): verificador PBKDF2 local; el primer login en cada dispositivo exige internet.
- **Formas de pago**: `PAYMENT_METHODS` en `src/shared/constants.js` (`pm-cash` Efectivo, `pm-transfer` Transferencia; ids estables). Cada venta, gasto y "llegó mercancía" guarda `payment_method_id` (opcional en el servidor por compatibilidad; la UI lo exige). "Plata de la semana" por forma de pago = ventas (entra) − gastos − compras de mercancía (salen) → `weeklyReport().byMethod`. No hay saldo inicial ni retiros: solo cuenta lo anotado.
- **UI**: 4 pestañas — Vender (buscador sin tildes + carrito + confirmación con Efectivo/Transferencia), Historial (ventas por día, `salesByDay`), Productos, Ganancias.
- **Ganancia semanal** (`src/domain/report.js`): `ventas − costo de lo vendido − gastos` (semana lunes–domingo, hora local). Cada línea de venta guarda `unit_cost` del momento. Las compras de mercancía no restan (son inventario). Las anuladas no cuentan.

### Mapa de carpetas
```
src/shared/       constants.js (OP, ENTITY_FIELDS…), validate.js (validadores cliente+servidor)
src/domain/       state.js (registros, efectos, proyección optimista), report.js (ganancias)
src/client/persistence/  memory-store.js, file-store.js (tests), idb-store.js (navegador)
src/client/sync/  engine.js (cola, push/pull, reintentos, estados)
src/client/api/   api-client.js (ApiError vs NetworkError)
src/client/auth/  session.js (login online/offline)
src/client/ui/    app.js, app.css  (frontend)
src/server/       db/db.js (esquema), auth/auth.js, sync/{apply,service}.js, http/server.js, main.js
public/           index.html, sw.js, manifest.webmanifest, icons/
scripts/          seed, set-user, backup, db (consola RO), db-web (visor RO)
test/             helpers.js (mundo de pruebas con red controlable), sync.test.js, business.test.js
deploy/           manage-storage.service, Caddyfile.snippet
```

### Tipos de operación (`src/shared/constants.js`)
`ENTITY_CREATE`, `ENTITY_UPDATE` (requiere `base_version`), `SALE_CREATE`, `PURCHASE_CREATE`, `STOCK_ADJUST`, `EXPENSE_CREATE`, `OP_VOID`. Entidades de estado: `product {name, sku, price, cost, category_id, archived}`, `category`, `payment_method`. Dinero y cantidades = **enteros** (unidad principal de la moneda configurada, sin centavos; unidades).

### Tablas (SQLite)
`organizations, users, devices, sessions, entities, operations, records, inventory_movements, conflicts, audit_log, meta`. **Toda tabla de negocio lleva `org_id` y este sale SIEMPRE de la sesión autenticada, nunca del payload.**

### API (`src/server/http/server.js`)
`POST /api/login` · `POST /api/logout` · `GET /api/me` · `GET /api/sync/snapshot` · `GET /api/sync/pull?since=` (410 = cursor muy viejo → re-snapshot conservando cola) · `POST /api/sync/push` · `GET /api/conflicts` · `POST /api/conflicts/:id/resolve {choice: server|client|value}` · `GET /api/devices` · `POST /api/devices/:id/revoke` · `GET /api/export/movements.csv` · `GET /api/health`. **No existe registro público de usuarios, y no debe existir** (usuarios solo por `scripts/`).

## 5. Invariantes — romperlos es un bug grave

1. **Una operación aceptada jamás se pierde ni se aplica dos veces.** Idempotencia por `op_id` (UNIQUE global). Un fallo interno revierte *esa* op y se reintenta; no se marca como rechazada.
2. Las ops de un dispositivo se aplican **en orden de `device_seq`, sin huecos**.
3. **Prohibido last-write-wins** sobre datos que se puedan fusionar o apilar. Lo no fusionable genera `conflicts` con ambos valores.
4. El stock **no es una columna**: se reconstruye de `inventory_movements`. Correcciones = nuevos movimientos.
5. Lo anulado/rechazado **se conserva** en el log (auditable). Las ops inválidas se guardan como `rejected`.
6. El cliente purga una op local **solo** cuando el cursor ya la cubre (evita parpadeos/dobles conteos); estado + cursor + purga = una sola transacción de IndexedDB.
7. Aislamiento por `org_id` en **todas** las consultas. Una org no puede ver ni afectar otra (hay test).
8. `created_at` viene del reloj del dispositivo (no confiable): **no se usa para ordenar**, solo como hora de negocio. El orden es `seq` del servidor.
9. La API nunca se cachea en el Service Worker; los datos viven en IndexedDB.
10. Sin `innerHTML` con datos de usuario (XSS). Todo con `textContent`.

### Respaldos
Cada día a la hora `BACKUP_TIME` (por defecto 23:55) **de la zona `TIMEZONE`** del negocio (temporizador de systemd `<SERVICE_NAME>-backup.timer`, zona explícita: no depende de la hora del servidor; `Persistent=true`) se crea un `.db.gz` en **`BACKUP_DIR`** (por defecto `~/ManageStorage-backups/`, FUERA del proyecto, permisos 700), conservando los `BACKUP_KEEP` más recientes (30; `pre-reset-*`: 10). `src/server/backup.js`: VACUUM INTO → `PRAGMA integrity_check` de la copia → comprime → comprueba por hash que lo comprimido es idéntico → renombra (si algo falla no se guarda nada a medias y el servicio queda en `failed`). Manual: `./ms backup` · listar: `./ms backup list` · estado: `systemctl --user list-timers manage-storage-backup.timer` y `journalctl --user -u manage-storage-backup`. **Limitación honesta**: es otra carpeta del MISMO servidor; protege de errores y borrados, NO de perder el servidor. **Restaurar** (emergencia): parar el servicio, `gunzip -c respaldo.db.gz > data/app.db` (borrar `app.db-wal`/`-shm`), arrancar. OJO: los equipos ya habrán avanzado más que el respaldo (cursores, `device_seq`, ventas posteriores): restaurar a mano deja los equipos desfasados. No hay procedimiento automático todavía (idea: que los equipos conserven unos días sus operaciones ya enviadas para reenviarlas tras una restauración). Pídelo antes de restaurar en producción.

### Datos en cada equipo: ventana de 180 días (no es un límite de SQLite)
Cada equipo guarda los últimos `RECORD_RETENTION_DAYS` (180) días de ventas/compras/gastos (`pruneRecords` al sincronizar; el stock es un acumulado aparte y no se poda). El snapshot trae todo lo de esa ventana, **sin tope de cantidad** (antes había un `LIMIT 2000` que dejaba semanas incompletas). `state.coverage.records_since` indica desde cuándo hay datos completos. Las semanas anteriores se calculan **en el servidor** (`GET /api/reports/week?start&end`, mismo código `reportBetween`) y la app las pide sola con internet (sin internet avisa). La huella solo compara registros de los últimos `DIGEST_DAYS` (150) días (el servidor manda `digest_from`), así no hay falsos "autocorrige" por el borde de la ventana. Cambiar la forma del estado ⇒ subir `STATE_SCHEMA` (hoy 2).

### Validación de hora (con internet)
`GET /api/time` (sin sesión) da la hora del servidor y la **zona horaria del negocio** (`meta.timezone` o, si no hay, `TIMEZONE` de `.env`; `./ms node scripts/admin.js set-timezone <IANA>`; sirve para cualquier país). Con internet la app (al abrir, al iniciar sesión, cada 5 min, al volver a la app o recuperar conexión) comprueba (`src/client/clock.js`, `src/shared/time.js`): reloj dentro de ±5 min del servidor (corrigiendo el tiempo de ida y vuelta) **y** que el desfase de zona horaria sea el del negocio. Si no, pantalla de bloqueo con instrucciones: no se entra ni se envían credenciales ni se sincroniza hasta corregirlo. Sin internet no se puede comprobar (se comprueba al volver); si el servidor no responde bien o la red es muy lenta, **no se bloquea a nadie**. El desfase medido se informa en `dispositivos.desfase_reloj_s`. Las operaciones creadas offline con el reloj mal conservan su hora (limitación conocida).

### Protección de datos del navegador (Safari)
`navigator.storage.persist()` al arrancar (`src/client/storage-guard.js`). Safari borra los datos de **sitios** sin uso en 7 días, pero **no** los de una app instalada en la pantalla de inicio: en iPhone/iPad sin instalar se muestra un aviso (máx. 1 vez al día) para instalarla. `dispositivos.modo` y `almacenamiento_protegido` dicen qué equipos están en riesgo. Las operaciones sin enviar viven solo en el equipo hasta sincronizar: por eso se sincroniza apenas hay internet.

### Sesión vencida o rechazada (decisión de diseño)
Si hay internet y el servidor responde 401 a un equipo (sesión borrada, vencida, reinicio con `--drop-sessions`), la app **va al login** y no deja trabajar con datos locales viejos (`requireLogin` en `app.js`). Lo pendiente queda guardado en el equipo y se envía al entrar. Sin internet se sigue trabajando normal con la copia local (el login offline usa el verificador PBKDF2). Al abrir la app con internet se espera hasta 2,5 s la confirmación del servidor antes de enseñar datos locales. Equipos con una versión muy vieja del JS (página que nunca se recargó) se actualizan al cerrar y reabrir la app. **Cuidado**: `reset-data.js --drop-sessions` saca a todos al login.

### Identificar de dónde viene cada equipo (todo pasivo: la app NO pide ni muestra nada)
Decisión de diseño: **no agregar campos/botones a la app para esto**; se obtiene lo que ya se sabe solo.
- **Servidor** (en cada petición autenticada, `touchDevice`): IP real (Caddy pone `X-Forwarded-For`; solo se confía porque el servicio escucha en 127.0.0.1 — Caddy la sobrescribe, verificado que una IP falsificada no pasa), tipo legible del user-agent (`src/server/http/ua.js`: "iPhone · iOS 18.7 · Safari"), idioma y client hints de las cabeceras.
- **Cliente** (`src/client/ui/client-info.js`, cabecera `X-Client-Info`): zona horaria, idioma, pantalla, si es **app instalada o pestaña del navegador**, núcleos/memoria, tipo de conexión, modelo (Chrome/Android), versión de la app. Lista blanca y valores cortos en `sanitizeInfo` (`auth.js`).
- **Ubicación por IP** (`src/server/http/geo.js`): ciudad/departamento/país/proveedor/ASN/lat-lon aproximados + host por DNS inverso; consulta a ipwho.is **enviando solo la IP**, en segundo plano, cacheada en `ip_geo` (30 días; 6 h si falló). Desactivar: `GEO_LOOKUP=off`. Es aproximada (en celulares suele ser la ciudad del proveedor).
- **Historial**: `device_ips` (cada IP que ha usado un equipo) y `audit_log` con IP+navegador en inicios de sesión buenos y fallidos.
- **Ver**: `./ms db devices` (resumen) · `./ms db device <inicio_id>` (todo + historial de IPs) · `./ms db accesos [N]` · vistas SQL `dispositivos`, `historial_ips`, `accesos` (también en el visor web y en DB Browser). Poner nombre a un equipo, solo desde el servidor: `./ms node scripts/admin.js name-device <id> "Celular de la caja"`.
- Nota: el `device_id` vive en el almacenamiento del navegador: **abrir en Safari y abrir la app instalada (icono en pantalla) son equipos distintos**, igual que borrar los datos del sitio.

### Cambios directos en la base de datos
**Lo correcto**: cambios administrativos por el registro, que llegan a todos los equipos y quedan auditados:
`./ms node scripts/admin.js void <id_registro>` (anula venta/compra/gasto y corrige el stock), `archive-product <id>` / `restore-product <id>`. Los ids: `./ms db "select id, kind, amount from records"`.
**Red de seguridad** (si alguien igual edita/borra filas a mano): `/api/sync/pull` devuelve `digest` (huella SHA-256 de catálogo + stock + últimos 500 registros, `src/domain/digest.js`); cuando el cliente está al día compara con la suya y, si difiere, baja un snapshot nuevo (máx. 1 vez por minuto, la cola pendiente no se toca; `engine.healCount`/`lastHeal`). Limitaciones: borrar un registro a mano sin sus `inventory_movements` deja datos incoherentes (la huella detecta ambos cambios por separado, pero no los reconcilia); no se vigila la tabla `operations` ni `audit_log`; registros más antiguos que los 500 últimos solo se detectan vía stock. Para borrar TODO usa el reinicio de datos (abajo).

### Reiniciar los datos de una organización (p. ej. borrar pruebas antes de entregar)
`./ms node scripts/reset-data.js [--org "Nombre"]` (en seco: solo muestra cuánto borraría) y con `--yes` ejecuta. Hace un respaldo verificado `pre-reset-*` en `BACKUP_DIR` ANTES, conserva la organización, sus usuarios **y por defecto las sesiones y dispositivos** (nadie vuelve a iniciar sesión), borra operaciones/ventas/productos y re-crea las formas de pago. Con `--drop-sessions` además cierra sesiones y borra los equipos (todos deben volver a entrar). El contador `operations.seq` no se reinicia al conservar sesiones (los cursores de los equipos siguen siendo válidos) y `devices.last_device_seq` vuelve a 0. **No borres filas a mano para esto**: el reinicio cambia la *época de datos* (`meta.epoch:<org>`). **Regla de integridad (decisión de diseño)**: cuando un equipo detecta una época distinta (409 `epoch_changed`) —o es una copia vieja sin época y el servidor, tras un reinicio, la rechaza— (1) **descarta lo que ya había sincronizado** (el reinicio lo borró a propósito; queda archivado en `meta.discarded_after_reset`), (2) **CONSERVA lo que nunca se subió** (operaciones `pending`), las **renumera desde 1** (el servidor nuevo no conoce su numeración anterior; si no, el servidor esperaría la secuencia 1 y el equipo quedaría atascado) y las envía a la base nueva, y (3) baja el snapshot nuevo. Si una operación pendiente depende de algo que el reinicio borró (p. ej. vender un producto que ya no existe), el servidor la guarda como `rejected` y la persona la ve en "No se pudieron guardar" con todos sus datos: nunca se pierde en silencio. Consecuencia a tener en cuenta: si un celular de pruebas tiene ventas de prueba sin enviar, **reaparecerán** en la base limpia. Los equipos viejos sin época hacen primero una consulta (`_probeEpoch`) para saber si el mundo cambió antes de bajar o enviar nada. Los cambios hechos en la base por otras vías (anular, archivar, ediciones) se propagan por el registro o por la huella (ver arriba); un equipo sin internet los recibe al conectarse.

### Compatibilidad entre versiones (obligatoria al desplegar)
Hay equipos con versiones viejas de la app y **operaciones pendientes guardadas con el formato viejo** (días sin conexión). Por eso:
- El servidor **debe seguir aceptando y aplicando las operaciones de versiones anteriores**. Campos nuevos = opcionales con valor por defecto (como `unit_cost`, `cost`); nunca vuelvas obligatorio algo que clientes viejos no envían.
- Cambio de **forma del estado local** (lo que guarda IndexedDB) incompatible ⇒ sube `STATE_SCHEMA` (`src/shared/constants.js`): cada equipo baja un snapshot nuevo conservando su cola. Cambio de esquema de IndexedDB (stores/índices) ⇒ sube la versión en `idb-store.js` y escribe la migración en `onupgradeneeded`.
- Cambio **realmente rompedor** del protocolo ⇒ sube `PROTO` y fija `minProto` en `createApp`: los clientes viejos reciben 426, muestran "Actualizar" y **conservan su cola**. Antes de subir `minProto`, asegúrate de que el servidor aún sepa leer sus operaciones pendientes o migra el formato.
- Nunca borres ni renombres campos de `payload` ya existentes sin una ruta de lectura para el formato antiguo.

## 6. Convenciones de código

- JS moderno, ES modules, **sin dependencias npm** (decisión deliberada: nada que compilar/actualizar). Si propones una, justifícala.
- Comentarios en español, breves, explican el *por qué*.
- Cambios de reglas de sync/dominio ⇒ **test primero** (`test/*.test.js`; usa `world()` y `device()` de `test/helpers.js`, que simulan offline, respuesta perdida y reinicios).
- UI: español **sencillo y cálido** ("Llegó mercancía", "A cómo nos sale"), botones grandes (≥44px), sin jerga (nada de "sincronizar operaciones", "conflicto de merge"). Estados visibles: "✓ Todo guardado", "⏳ N cambios esperan internet", "📴 Sin internet · todo guardado aquí".
- Validación en un solo lugar (`src/shared/validate.js`), usada por cliente y servidor.

## 7. Limitaciones y riesgos conocidos

- IndexedDB no está cifrado (cualquiera con el equipo desbloqueado ve la copia local). Mejora futura: cifrado WebCrypto.
- El navegador no sincroniza con la app cerrada: se envía al abrirla con internet (Safari/iOS no tiene Background Sync fiable).
- SQLite = un solo nodo/proceso. Escalar ⇒ PostgreSQL.
- Snapshot sin paginar (catálogos pequeños); no hay compactación del log (existe el mecanismo `410`/`meta.min_seq`).
- Cantidades solo enteras; sin multi-moneda ni impuestos.
- Las contraseñas las elige cada instalación: aconsejar claves largas y cambiar cualquier clave que haya pasado por un chat o correo.
- **Verificación pendiente:** el frontend (UI, Service Worker, IndexedDB) está comprobado por tests de lógica en Node y por `curl`, **no** por pruebas automatizadas en un navegador real.

## 8. Agentes y comandos (`.opencode/`)

| Agente | Úsalo para |
|---|---|
| `sync-guardian` | Revisar cualquier cambio que toque sync/dominio/auth contra los invariantes (solo lectura) |
| `tester` | Escribir/ejecutar tests de escenarios (offline, duplicados, conflictos…) |
| `ui-friendly` | Cambios de interfaz para usuarios no técnicos |
| `deployer` | Reiniciar servicio, Caddy, backups, diagnóstico de producción |
| `db-inspector` | Consultar datos en solo lectura y explicarlos |

Comandos: `/test`, `/status`, `/db <consulta o atajo>`, `/backup`.
