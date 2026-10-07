#!/bin/sh
# Lanzador del proyecto: usa un Node que traiga node:sqlite (>= 22.5; recomendado 24). Busca en ~/.local/node y, si no, en el PATH.
# Funciona igual por SSH no interactivo. Uso: ./ms db [...] | db-web | backup | user | seed | install | caddy | test | start | node ...
DIR="$(cd "$(dirname "$0")" && pwd)"
has_sqlite() { "$1" -e 'require("node:sqlite")' >/dev/null 2>&1; }
NODE="${MS_NODE:-}"
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.local/node/node-v*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$NODE" ] && has_sqlite "$NODE" || NODE="$(command -v node 2>/dev/null)"
fi
if [ -z "$NODE" ] || ! has_sqlite "$NODE"; then
  echo "Necesitas Node.js 22.5 o superior (recomendado 24), que incluye node:sqlite. Instálalo (https://nodejs.org) o define MS_NODE=/ruta/a/node" >&2
  exit 1
fi
cd "$DIR" || exit 1
PATH="$(dirname "$NODE"):$PATH"; export PATH
cmd="$1"; [ $# -gt 0 ] && shift
case "$cmd" in
  db)      exec "$NODE" scripts/db.js "$@" ;;
  db-web)  exec "$NODE" scripts/db-web.js "$@" ;;
  backup)  exec "$NODE" scripts/backup.js "$@" ;;
  user)    exec "$NODE" scripts/set-user.js "$@" ;;
  seed)    exec "$NODE" scripts/seed.js "$@" ;;
  install) exec "$NODE" scripts/install-service.js "$@" ;;
  caddy)   exec "$NODE" scripts/print-caddy.js "$@" ;;
  test)    exec "$NODE" --test test/*.test.js ;;
  start)   exec "$NODE" src/server/main.js ;;
  node)    exec "$NODE" "$@" ;;
  *) echo "uso: ./ms db [tables|stock|devices|ops N|\"SELECT ...\"] | db-web | backup | user | seed | install | caddy | test | start | node ..." >&2; exit 1 ;;
esac
