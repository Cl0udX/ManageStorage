# ManageStorage — Arquitectura (offline-first, genérico)

Prioridad: CORRECTNESS > NO PERDER DATOS > OFFLINE > SYNC > SIMPLICIDAD > FEATURES.

## 1. Decisiones de tecnología

| Tema | Decisión | Por qué / qué cambió vs. la hipótesis |
|---|---|---|
| Fuente de verdad | **Log de operaciones append-only + estado derivado**, en SQL relacional | Confirmado: SQL relacional + event log. NoSQL no aporta nada (necesitamos transacciones, SUM, joins). CSV solo como *export*. |
| Motor SQL | **SQLite (WAL, `synchronous=FULL`) vía `node:sqlite`** | Cambio forzado: el servidor no tiene PostgreSQL ni acceso root/Docker. Para un negocio pequeño, un único proceso + SQLite es correcto y más simple. El acceso a datos está aislado en `src/server/db` y `src/server/sync`; el esquema es relacional estándar (migrable a PostgreSQL cambiando el adaptador y `INTEGER PK AUTOINCREMENT` → `BIGSERIAL`). Backups diarios con `VACUUM INTO`. |
| Backend | Node 24, `node:http`, **cero dependencias** | Menos superficie, nada que compilar. Router mínimo; fácil de reemplazar por Fastify/Hono. |
| Cliente | PWA en JS ES modules sin build, **IndexedDB** + Service Worker | Confirmado. `localStorage` no se usa para datos. |
| Tipos | JSDoc + validadores en `src/shared` (mismo código en cliente y servidor) | Sin paso de compilación; el código compartido se sirve tal cual al navegador. |
| Dinero / cantidades | **Enteros** (centavos / unidades) | Evita errores de punto flotante. Cantidades fraccionarias (kg, litros) = limitación v1 (usar la unidad menor, p. ej. gramos). |

## 2. Modelo de datos

Simplificaciones respecto a la lista pedida:

- `Category`, `Product`, `PaymentMethod` son **entidades de estado/configuración** → una sola tabla genérica `entities(type, id, data, version, field_meta)`. Añadir `supplier` o `customer` mañana = agregar un tipo, no una tabla.
- `Sale`, `Purchase`, `Expense`, ajustes → **`records`** (cabecera + `lines` JSON) — son *hechos* inmutables, solo se anulan.
- `Inventory` **no existe como tabla**: el stock es `SUM(delta)` sobre `inventory_movements` (se reconstruye siempre; un cache/snapshot es una optimización futura).
- `SyncCursor` vive en el **cliente** (meta `cursor`); en el servidor el cursor es `operations.seq`. `devices.last_device_seq` es el "acuse" por dispositivo.

Tablas servidor: `organizations`, `users`, `devices`, `sessions`, `entities`, `operations` (el log), `records`, `inventory_movements`, `conflicts`, `audit_log`, `meta`.
Todas las tablas de negocio llevan `org_id`; **el `org_id` sale siempre de la sesión, jamás del payload**.

### Operación (`operations`)
`op_id` (único global, UUID generado en el cliente) · `device_id` · `user_id` · `device_seq` (contador por dispositivo, contiguo) · `entity_type` · `entity_id` · `op_type` · `payload` · `base_version` · `created_at` (reloj del dispositivo, informativo) · `received_at` · `seq` (orden **del servidor**, AUTOINCREMENT) · `status` (`applied|partial|conflict|rejected`) · `reason` · `effects` (resultado normalizado que ven todos los dispositivos).
Estado de sync local del cliente: `pending → acked` (con `server_seq`) o `rejected`.

## 3. Protocolo de sincronización

```
login ──► snapshot (estado completo + cursor=seq) ──► [offline OK]
 enqueue(op) = una transacción IDB: op + device_seq++            (sobrevive a cierres)
 sync():  PUSH pendientes en orden de device_seq (lotes)  ──►  PULL desde cursor
```

- **Push** `POST /api/sync/push {ops}`: el servidor procesa **en orden de `device_seq`**, cada op en su propia transacción:
  - `op_id` ya existe → devuelve el resultado original con `duplicate:true` (idempotencia; cubre reintentos, respuesta perdida, cierre a mitad de sync).
  - `device_seq` ≤ último → rechazo `device_seq_stale` (no persistido, bug de cliente).
  - `device_seq` ≠ último+1 → **se detiene** (`halted`): nunca se aplica fuera de orden; el cliente reintenta.
  - payload inválido → se **guarda como `rejected`** (no se pierde, queda auditable) y avanza la secuencia.
  - error interno → rollback de esa op y `halted`; se reintenta luego (no se marca como rechazada).
- **Pull** `GET /api/sync/pull?since=N`: devuelve el log ordenado por `seq` con los `effects`. El cliente aplica efectos + avanza el cursor **en una sola transacción**; ignora `seq ≤ cursor` (idempotente).
- **Vista local** = estado del servidor + proyección optimista de las ops locales aún no reflejadas (`pending`, o `acked` con `server_seq > cursor`). Nunca hay doble conteo ni parpadeo.
- Una op se purga localmente solo cuando el cursor ya la cubre.
- **Offline varios días**: el log no depende del tiempo. Las ops viejas se aplican igual (`created_at` se conserva como hora de negocio; el orden es `seq`). Si la sesión expiró → `401`, el cliente conserva su cola, pide re-login (mismo `device_id`) y continúa. Si el cursor quedó más viejo que el horizonte de compactación (`meta.min_seq`) → `410`, el cliente toma un snapshot nuevo **conservando las ops pendientes**.
- **Dispositivo revocado** → `403 device_revoked`: se detiene la sync, la cola local se conserva (recuperable por un admin).

## 4. Estrategia por tipo de dato

### a) Operaciones acumulativas (venta, compra, ajuste de stock, gasto)
Son hechos conmutativos: **se apilan, nunca se sobrescriben**. Stock = Σ movimientos → 100 − 10 − 5 = **85** sin importar el orden. El stock puede quedar negativo (la venta ya ocurrió físicamente); se muestra, no se rechaza.
**Anular**: `OP_VOID` crea movimientos *compensatorios* y marca el registro `voided`; nada se borra. Anular dos veces es no-op.

### b) Estado/configuración (nombre, precio, categoría…)
**Merge por campo** con versiones:
- Cada entidad tiene `version` (entero, +1 por cambio aplicado) y `field_meta[campo] = {v, d}` (versión y dispositivo de la última escritura de ese campo).
- La op trae `base_version` (la versión que el dispositivo veía).
- Por cada campo cambiado: mismo valor que el actual → fusión silenciosa; `field_meta.v ≤ base_version` **o** lo escribió el mismo dispositivo (causalmente anterior) → se aplica; si no → **conflicto**.
- Campos distintos de la misma entidad siempre se fusionan (A cambia nombre, B cambia precio → ambos).

### Conflictos
Se guarda una fila `conflicts` con **ambos valores** (`server_value`, `client_value`), versiones y la op de origen (que permanece intacta en el log). El valor del servidor sigue vigente hasta resolver. Resolución (solo `owner`): `server` | `client` | `value` (personalizado) → nueva versión + op de resolución en el log que llega a todos los dispositivos. Nada original se borra. El `conflict.id` es determinista (`op_id:campo`) → idempotente.

No hay *last-write-wins* en ningún camino; el único "gana el último" es entre ediciones del **mismo dispositivo**, que están totalmente ordenadas.

## 5. Estructura del proyecto

```
src/shared/       constantes, validadores (cliente+servidor)
src/domain/       reglas puras: construir registros, efectos, proyección optimista
src/client/persistence/  MemoryStore, FileStore (tests), IdbStore (navegador)
src/client/sync/  SyncEngine (cola, push/pull, reintentos, estados)
src/client/api/   ApiClient (fetch, errores de red vs. HTTP)
src/client/ui/    frontend PWA
src/server/db/    esquema + apertura SQLite
src/server/auth/  scrypt, sesiones, revocación de dispositivos
src/server/sync/  apply (reglas), service (push/pull/snapshot/conflictos)
src/server/http/  servidor HTTP + estáticos + cabeceras de seguridad
public/           index.html, sw.js, manifest, iconos
test/             escenarios críticos (node --test)
```

## 6. Seguridad

- Passwords: scrypt con sal. Tokens de sesión: 32 bytes aleatorios, en BD solo su SHA-256; expiran a 30 días (deslizante).
- Aislamiento: `org_id` de la sesión en **todas** las consultas; `op_id` de otra organización se rechaza.
- Dispositivos: se registran en el login, se pueden revocar (bloquea login y sync con 403 device_revoked).
- HTTPS por Caddy (Let's Encrypt), HSTS, CSP estricta (`default-src 'self'`), rate-limit de login, el servidor escucha solo en `127.0.0.1`.
- UI sin `innerHTML` con datos de usuario (XSS).
- **Limitación**: IndexedDB no está cifrado; quien tenga el dispositivo desbloqueado accede a la copia local. Mitigación futura: cifrado WebCrypto con clave derivada del PIN/password. Los tokens también viven en IndexedDB.

## 7. Riesgos y limitaciones

1. Relojes de dispositivos: `created_at` no se usa para ordenar (solo informativo); el orden es el `seq` del servidor.
2. SQLite = un solo nodo; escalar requiere PostgreSQL (camino de migración descrito arriba).
3. Un hueco en `device_seq` (p. ej. restauración de backup del servidor) detiene la sync de ese dispositivo hasta intervenir: es deliberado (fail-safe antes que aplicar desordenado).
4. Snapshot completo (sin paginación): válido para catálogos pequeños; paginar si crece.
5. Compactación del log no implementada (existe el mecanismo `410`/`min_seq`).
6. Cantidades enteras; sin multi-moneda ni impuestos.
7. Conflictos de estado solo resolvibles online por un `owner`.
8. Service Worker/IndexedDB verificados con tests de lógica en Node; la prueba en navegador real es manual (ver README).

## 9. Actualización de la app y compatibilidad
`build` = hash del contenido servido, inyectado con la lista de archivos en `/sw.js` ⇒ cada despliegue cambia los bytes del Service Worker y los equipos instalados se actualizan solos: instalan el paquete **completo** (`shell-<build>`, descargado con `cache: reload`) en segundo plano; si falla a medias se conserva la versión anterior intacta (nunca versiones mezcladas). La página activa la nueva solo cuando no hay carrito ni diálogos abiertos. Compatibilidad de datos: `STATE_SCHEMA` (estado local), versión de IndexedDB (migraciones), `PROTO`/`minProto` (426 ⇒ "Actualizar", la cola se conserva) y la regla de que el servidor siempre acepte operaciones viejas.

## 8. Añadidos (v0.2): login offline, costo/ganancia, roles

- **Login sin conexión** (`src/client/auth/session.js`): tras un login online se guarda en IndexedDB un verificador PBKDF2-SHA256 (210k iteraciones, sal aleatoria) — nunca la contraseña. Sin internet se valida contra ese verificador y se conserva el token del servidor; al volver internet se renueva solo (la contraseña escrita se guarda únicamente en memoria durante la sesión). Si el servidor está alcanzable, su respuesta manda (contraseña cambiada ⇒ 401 aunque el verificador local la acepte). **El primer login en cada dispositivo exige internet** (el servidor registra el dispositivo). Riesgo: quien extraiga IndexedDB puede intentar fuerza bruta sobre el verificador (mitigado por el costo de PBKDF2, no eliminado).
- **Costo y ganancia**: `product.cost` (a cómo nos sale) y `price` (a cómo vendemos). Cada línea de venta guarda `unit_cost` *del momento* → subir el costo después no reescribe la ganancia pasada. Ganancia semanal (lunes–domingo, hora local del dispositivo, `src/domain/report.js`) = ventas − costo de lo vendido − gastos; las compras de mercancía son inventario (no restan), las anuladas no cuentan. El reporte se calcula en el dispositivo, por eso funciona offline.
- **Roles**: `owner` (todo: resolver conflictos, revocar dispositivos, exportar CSV) y `staff` (vender, productos, gastos; no administra). Hoy hay un solo usuario `owner`. `scripts/set-user.js` crea/renombra/cambia clave/deshabilita (la clave entra por stdin).
