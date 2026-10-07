# ManageStorage

**Inventario, ventas y ganancias para pequeños negocios, que funciona aunque no haya internet.**

Una aplicación web instalable (PWA) para llevar productos, ventas, compras y gastos desde el celular. Todo se guarda en el
equipo y se **sincroniza solo** cuando vuelve la conexión, sin perder ni duplicar operaciones. Pensada para personas que no
saben de informática: pocas pantallas, textos simples y botones grandes.

> Sin dependencias de npm · Node.js + SQLite · JavaScript sin paso de compilación · interfaz en español

---

## Contenido

- [Características](#características)
- [Cómo funciona](#cómo-funciona)
- [Inicio rápido](#inicio-rápido)
- [Poner la app en producción](#poner-la-app-en-producción)
- [Instalarla en el celular](#instalarla-en-el-celular)
- [Configuración (`.env`)](#configuración-env)
- [Comandos](#comandos)
- [Uso diario](#uso-diario)
- [Seguridad y privacidad](#seguridad-y-privacidad)
- [Respaldos](#respaldos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Pruebas](#pruebas)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

## Características

- 📴 **Funciona sin conexión**: abre, vende y registra aunque no haya internet; al volver la señal se envía todo automáticamente.
- 🔁 **No pierde operaciones**: cada venta, compra o gasto es un hecho con identificador único. Si se reenvía, se aplica una sola vez; si se corta la conexión a mitad, se reintenta sin duplicar.
- 📦 **Inventario confiable**: el stock siempre se calcula a partir de los movimientos (nunca es un número que se sobrescribe). Dos celulares vendiendo a la vez sin internet dan el resultado correcto.
- 💰 **Costo, precio y ganancia semanal**: cada producto guarda cuánto cuesta y a cuánto se vende; el reporte semanal separa ventas, costo de lo vendido, gastos y ganancia.
- 💵 **Efectivo vs. transferencia**: cada venta, gasto y compra indica cómo se pagó; la app muestra cuánto entró y salió por cada forma de pago.
- 🧾 **Historial y anulaciones**: las ventas se pueden anular (con movimientos compensatorios; nada se borra).
- 🤝 **Varios dispositivos y usuarios**: las ediciones se fusionan campo por campo; si dos equipos cambian lo mismo sin conexión, se guarda un conflicto con ambos valores para decidir.
- 🔐 **Seguridad básica seria**: contraseñas con scrypt, sesiones revocables, aislamiento entre organizaciones, límite de intentos de acceso, HTTPS obligatorio.
- 🔄 **Se actualiza sola**: cada versión se descarga completa en segundo plano y se activa cuando no hay una venta en curso.
- 🕒 **Valida la hora** del equipo cuando hay internet (para que cada venta caiga en el día correcto).
- 🛟 **Respaldos diarios verificados** y herramientas de solo lectura para consultar los datos.
- 🧩 **Genérica**: nombre, moneda, idioma/región y zona horaria se configuran en un archivo `.env`.

## Cómo funciona

```
 ┌────────────── Celular / computador ───────────────┐          ┌────────────── Servidor ──────────────┐
 │  PWA (instalable)                                  │          │  Node.js  +  SQLite (WAL)             │
 │  ├─ Service Worker  → abre sin conexión            │          │  ├─ API: login · sync · reportes      │
 │  ├─ IndexedDB       → copia local de los datos     │  HTTPS   │  ├─ Registro de operaciones (log)     │
 │  └─ Cola de operaciones pendientes  ──────────────────────────▶ │  ├─ Estado derivado (stock, etc.)    │
 │        ▲  push (idempotente, en orden)             │          │  └─ Conflictos, auditoría, respaldos   │
 │        └─ pull (cambios de los demás)  ◀─────────────────────── │                                       │
 └────────────────────────────────────────────────────┘          └───────────────────────────────────────┘
```

- El cliente **nunca envía "el estado final"**: envía operaciones. El servidor las aplica, las guarda en un registro ordenado y
  publica los efectos, que todos los equipos aplican igual.
- **Datos acumulativos** (ventas, compras, ajustes, gastos): se suman, no se sobrescriben. **Datos de configuración** (nombre, precio, costo):
  fusión por campo con versiones y conflictos explícitos. Nunca "gana el último" sobre algo que pueda perderse.
- Detalle del modelo, el protocolo y los riesgos: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Inicio rápido

**Requisitos:** Linux o macOS con **Node.js ≥ 22.5** (recomendado 24: trae `node:sqlite`, no hay que instalar nada más).

```bash
git clone <URL-de-este-repositorio> manage-storage
cd manage-storage

cp .env.example .env     # edítalo: nombre de la app, zona horaria, moneda, nombre del negocio…
./ms seed                # crea la organización y el usuario dueño. La contraseña se muestra UNA sola vez: guárdala.
./ms start               # abre http://127.0.0.1:8095
```

`./ms` es un lanzador que elige un Node con `node:sqlite` (busca en `~/.local/node` y en el `PATH`) y carga tu `.env`.
Si tu Node es más viejo, instala uno nuevo o define `MS_NODE=/ruta/a/node`.

> Para probar en el celular necesitas HTTPS (ver abajo): el modo sin conexión y la instalación como app no funcionan en `http://` salvo en `localhost`.

## Poner la app en producción

1. **Servidor**: cualquier Linux con systemd y un dominio apuntando a él.
2. **Configura** `.env` (en especial `DOMAIN`, `TIMEZONE`, `APP_NAME`, `ORG_NAME`) y crea el dueño con `./ms seed`.
3. **Servicio y respaldo diario** (sin root, como servicios de usuario):
   ```bash
   ./ms install
   loginctl enable-linger $USER     # una vez: para que siga corriendo al cerrar la sesión SSH
   ```
4. **HTTPS con Caddy** (obtiene y renueva el certificado solo):
   ```bash
   ./ms caddy      # imprime el bloque; pégalo en tu Caddyfile y recarga Caddy
   ```
   La app solo escucha en `127.0.0.1`; Caddy es quien la publica.
5. Comprueba: `curl https://TU-DOMINIO/api/health` → `{"ok":true,…}`.

Para **actualizar**: copia los archivos nuevos y reinicia el servicio (`systemctl --user restart manage-storage`). Los equipos con internet se
actualizan solos; los que estén sin conexión lo hacen al conectarse. Antes de cambiar nada importante: `./ms backup`.

## Instalarla en el celular

Abre la dirección de la app y, desde el navegador:

- **iPhone / iPad (Safari)**: botón *Compartir* → **Agregar a pantalla de inicio**.
- **Android (Chrome)**: menú ⋮ → **Instalar aplicación** (o *Añadir a la pantalla de inicio*).

Se abre como una app, sin barra del navegador. **En iPhone es importante instalarla**: Safari borra los datos de los sitios que no se
usan en 7 días, pero no los de las apps instaladas. La primera vez en cada equipo hace falta internet; después funciona sin conexión.

## Configuración (`.env`)

Copia [`.env.example`](.env.example) a `.env`. Todo es opcional (hay valores por defecto neutros). **`.env` nunca se sube al repositorio.**

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `APP_NAME`, `APP_SHORT_NAME` | Nombre en el login, el título y al instalarla / bajo el ícono | `Inventario` |
| `THEME_COLOR` | Color principal (`#rrggbb`) | `#14532d` |
| `TIMEZONE` | Zona horaria del negocio (IANA). La usan la validación de hora y los respaldos | `UTC` |
| `LOCALE`, `CURRENCY` | Formato de fechas/números y moneda (código ISO) | `es`, `USD` |
| `ORG_NAME`, `OWNER_USERNAME` | Datos con que `./ms seed` crea el negocio y el dueño | `Mi Negocio`, `admin` |
| `HOST`, `PORT` | Dirección y puerto del servidor | `127.0.0.1`, `8095` |
| `DB_PATH` | Archivo SQLite | `./data/app.db` |
| `TRUST_PROXY` | `1` si hay un proxy (Caddy) delante que pone la IP real | `1` |
| `LOGIN_MAX_ATTEMPTS` | Intentos de acceso por IP cada 5 minutos | `10` |
| `GEO_LOOKUP` | `on`/`off`: ubicación aproximada de cada equipo por su IP (consulta un servicio externo enviando **solo la IP**) | `on` |
| `DOMAIN` | Dominio público (para `./ms caddy`) | `inventario.example.com` |
| `SERVICE_NAME` | Nombre del servicio de systemd | `manage-storage` |
| `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_TIME` | Carpeta, cuántos respaldos conservar y hora diaria (hora del negocio) | `~/ManageStorage-backups`, `30`, `23:55` |

Los importes son **enteros** en la unidad principal de la moneda (no se manejan centavos).

## Comandos

Todos con el lanzador `./ms`:

| Comando | Qué hace |
|---|---|
| `./ms start` | Arranca el servidor |
| `./ms seed [--org X] [--owner Y] [--staff Z]` | Crea una organización con su dueño |
| `./ms user …` | Crear, renombrar o deshabilitar usuarios (la clave entra por stdin, no queda en el historial) |
| `./ms install` | Instala el servicio y el respaldo diario programado |
| `./ms caddy` | Imprime la configuración de Caddy para tu dominio |
| `./ms backup` · `./ms backup list` | Respaldo verificado y comprimido · listarlos |
| `./ms db tables \| stock \| devices \| device <id> \| accesos \| ops N \| "SELECT …"` | Consultas de **solo lectura** (con vistas legibles en español) |
| `./ms db-web` | Visor web de solo lectura (por túnel SSH, con token, se cierra solo) |
| `./ms node scripts/admin.js …` | Anular ventas, archivar productos, nombrar equipos, zona horaria |
| `./ms node scripts/reset-data.js --yes` | Borra los datos del negocio (con respaldo previo) |
| `./ms test` | Ejecuta las pruebas |

## Uso diario

La app tiene cuatro pestañas:

- **Vender**: buscador, productos con `+` / `−`, y *Cobrar*, que pide confirmar y elegir **Efectivo** o **Transferencia**.
- **Historial**: ventas por día, con el total por forma de pago; se pueden anular.
- **Productos**: agregar (nombre, costo, precio, cantidad), cambiar, *Llegó mercancía*, *Corregir cantidad*, quitar.
- **Ganancias**: por semana (lunes–domingo): ganancia, ventas, costo de lo vendido, gastos, plata en efectivo y en transferencias, y ganancia por producto.

Roles: **dueño** (todo, incluido resolver conflictos y desactivar equipos) y **empleado** (vender y registrar).

## Seguridad y privacidad

- Contraseñas con **scrypt**; sesiones con token aleatorio (en la base solo se guarda su hash) que se pueden revocar; límite de intentos por IP.
- Cada organización está aislada: toda consulta lleva el identificador de la organización de la **sesión**, nunca del contenido de la petición.
- Cabeceras de seguridad y CSP estricta; sin `innerHTML` con datos de usuarios.
- Con internet, la app comprueba que la hora del equipo sea correcta antes de dejar entrar.
- Se registran IP, tipo de equipo y ubicación aproximada de cada equipo (para saber de dónde se conecta cada uno). Puedes apagar la consulta de ubicación con `GEO_LOOKUP=off`.
- **Los datos locales del navegador no están cifrados**: quien tenga el celular desbloqueado puede verlos.
- **Nunca subas `.env`, `data/` ni los respaldos** (ya están en `.gitignore`). Cambia cualquier contraseña que hayas compartido por chat o correo.

## Respaldos

`./ms install` programa un respaldo **diario** a la hora del negocio (`BACKUP_TIME`, en tu `TIMEZONE`). Cada respaldo se verifica (integridad de la base y
comparación del archivo comprimido) y se guarda en `BACKUP_DIR`, fuera del proyecto.

- Es otra carpeta del **mismo servidor**: protege de errores y borrados, **no** de perder el servidor. Copia los respaldos a otro lugar (`scp`, rsync…).
- Restaurar a mano deja a los celulares desfasados respecto al servidor; hazlo con cuidado (ver `AGENTS.md`).

## Estructura del proyecto

```
src/shared/    constantes y validadores (los usan servidor y navegador)
src/domain/    reglas puras: registros, efectos, reportes, huella de datos
src/client/    motor de sincronización, almacenamiento local (IndexedDB), cliente de API, inicio de sesión sin conexión, interfaz
src/server/    HTTP, autenticación, reglas de sincronización, base de datos, respaldos, configuración
public/        index.html, Service Worker, manifest, íconos
scripts/       administración (seed, usuarios, respaldos, reinicio de datos, visor, instalación…)
deploy/        plantillas de systemd y de Caddy
test/          pruebas (servidor real en proceso, red con fallas simuladas)
docs/          arquitectura
.opencode/     agentes y comandos para opencode (opcional)
```

## Pruebas

```bash
./ms test
```

Cubren, entre otras cosas: dos equipos vendiendo sin conexión (stock correcto), envíos duplicados, conexión perdida a mitad de la sincronización,
reinicio del equipo antes de sincronizar, conflictos de edición, días sin conexión, reinicio de datos, respaldos y restauración, validación de hora.
**Importante**: las pruebas ejercitan la lógica en Node; la interfaz, el Service Worker e IndexedDB en un navegador real aún no tienen pruebas automáticas.

## Limitaciones conocidas

- Los datos del navegador no están cifrados y el navegador no sincroniza con la app cerrada (se envía al abrirla con internet).
- Un solo servidor con SQLite (suficiente para un negocio pequeño; para crecer habría que migrar a PostgreSQL).
- Cada equipo guarda los últimos 180 días de ventas; las semanas anteriores se consultan al servidor.
- Interfaz solo en español; importes sin centavos; cantidades enteras.
- Restaurar un respaldo antiguo no tiene aún un procedimiento automático para los equipos.

## Contribuir

Las reglas que no se deben romper (no perder operaciones, idempotencia, orden por equipo, sin "gana el último", stock derivado de movimientos,
aislamiento por organización) están en [`AGENTS.md`](AGENTS.md). Cualquier cambio en sincronización o dominio debe llevar su prueba primero, y `./ms test` debe pasar.
Los issues y pull requests son bienvenidos.

## Licencia

Pendiente de definir por quien publique el repositorio (agrega un archivo `LICENSE`).
