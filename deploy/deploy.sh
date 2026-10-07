#!/usr/bin/env bash
# =============================================================================
# Comando Central (tesis) · despliegue en la VM
#
#   bash deploy/deploy.sh update            → build + up conservando los datos (lo normal; 'up' es lo mismo)
#   bash deploy/deploy.sh reset             → ⚠ BORRA los volúmenes de ESTE proyecto (base incluida) y arranca de cero (a mano pide escribir 'borrar')
#   bash deploy/deploy.sh status            → contenedores, salud, último despliegue y URL
#   bash deploy/deploy.sh logs [servicio]   → logs en vivo
#   bash deploy/deploy.sh down              → baja el stack sin borrar datos
#   bash deploy/deploy.sh set-env NOMBRE    → guarda un valor en el .env de la VM sin mostrarlo (API keys, etc.)
#   bash deploy/deploy.sh help
#
# Lo ejecuta GitHub Actions (.github/workflows/deploy.yml, que llama el CI de main cuando las
# suites pasan), y también se puede correr a mano dentro de la VM. El stack NO publica puertos: la única entrada es el Caddy
# compartido de la VM, que llega a comando-central por la red compartida. Este script deja
# el sitio del proyecto en la carpeta de sitios de Caddy (un archivo propio) y lo recarga.
# =============================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_SLUG="tesis"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
WEB_CONTAINER="comando-central"   # container_name del servicio de entrada (único en la VM)
WEB_PORT="4000"                   # puerto interno: API, WebSocket (/ws) y la consola web
PROXY_NETWORK="${PROXY_NETWORK:-proxy}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-900}"

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker no está instalado en la VM."
docker compose version >/dev/null 2>&1 || die "Falta el plugin 'docker compose' (v2)."

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
rand()    { local s; s="$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"; printf '%s' "${s:0:${1:-48}}"; }

# --------------------------------------------------------------------------- .env de la VM
# Vive SOLO en la VM: tiene los secretos, el rsync del workflow no lo toca y nunca va al repo.
get_kv() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
set_kv() {  # set_kv CLAVE VALOR → reemplaza la línea CLAVE=… o la agrega (el valor se escribe tal cual)
  local tmp; tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; listo = 0 }
    index($0, k "=") == 1 { if (!listo) print k "=" v; listo = 1; next }
    { print }
    END { if (!listo) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
ensure_key() {  # ensure_key CLAVE VALOR → la agrega solo si falta (los secretos se generan una sola vez)
  grep -qE "^$1=" "$ENV_FILE" || { printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; log "$1 agregado al .env"; }
}
ensure_env_file() {
  [ -f "$ENV_FILE" ] && return 0
  # Sin .env pero con volúmenes de este proyecto = casi seguro cambió la carpeta (DEPLOY_PATH).
  # Un .env nuevo traería otra contraseña de base y la app no podría conectarse a sus datos.
  if [ "${MODO:-}" != reset ] && [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$APP_SLUG")" ]; then
    die "Hay volúmenes de '$APP_SLUG' pero no hay $ENV_FILE en $(pwd): ¿cambió DEPLOY_PATH? Recuperá el .env de la carpeta anterior (o usá reset, que borra los datos)."
  fi
  log "Creando $ENV_FILE (primer despliegue)"
  ( umask 077; printf '# Comando Central (tesis) · configuración de la VM (la mantiene deploy/deploy.sh). No se sube al repo.\n' > "$ENV_FILE" )
}

hosts_caddy()     { printf '%s' "$APP_DOMAIN" | tr ',;' '  ' | xargs | sed 's/ /, /g'; }          # "a.com, b.com"
primer_host()     { printf '%s' "$APP_DOMAIN" | tr ',;' '  ' | awk '{print $1}'; }

ensure_env() {
  ensure_env_file

  # Una línea por cada variable que lea docker-compose.prod.yml. Si más adelante la app necesita
  # una variable nueva, se agrega acá y el próximo deploy la suma al .env existente.
  # El JWT_SECRET se genera una sola vez: cambiarlo cerraría todas las sesiones abiertas.
  # Opcionales a mano (set-env): SEED_PASSWORD_<USUARIO>, SEED_STRICT (ver docs/DEPLOY.md).
  ensure_key JWT_SECRET "$(rand 72)"

  # Configuración del despliegue que manda el workflow (variables del repo). Se guarda en el .env
  # para que una corrida a mano dentro de la VM use los mismos valores.
  local k
  for k in APP_DOMAIN CADDY_CONTAINER CADDY_SITES_DIR; do
    if [ -n "${!k:-}" ]; then set_kv "DEPLOY_$k" "${!k}"; else printf -v "$k" '%s' "$(get_kv "DEPLOY_$k")"; fi
  done
  CADDY_CONTAINER="${CADDY_CONTAINER:-caddy}"
  CADDY_SITES_DIR="${CADDY_SITES_DIR:-$HOME/caddy/conf/sites}"
  [ -n "${APP_DOMAIN:-}" ] || die "Falta APP_DOMAIN (variable del repo en GitHub, o DEPLOY_APP_DOMAIN en $ENV_FILE)."
}

ensure_proxy_network() {
  docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1 && return 0
  log "Creando la red compartida '$PROXY_NETWORK'"
  docker network create "$PROXY_NETWORK" >/dev/null
}

check_disk() {
  local libre; libre="$(df -Pk . | awk 'NR == 2 {print int($4 / 1048576)}')"
  [ "${libre:-99}" -ge 3 ] || warn "Quedan ${libre} GB libres: el build puede fallar (docker system df; docker builder prune)."
}

# --------------------------------------------------------------------------- Caddy (entrada)
# Cada proyecto escribe SOLO su archivo <slug>.caddy en la carpeta de sitios que importa el Caddy
# compartido (en el contenedor: /etc/caddy/sites). En cada deploy se comprueba que Caddy de verdad
# lee ese archivo, y antes de recargar se valida: si la configuración nueva no es válida se restaura
# la anterior, porque un archivo roto tiraría TODOS los sitios de la VM en el próximo reinicio.
# (Sin 'grep -q' en tuberías: con pipefail, su salida anticipada puede dar falsos negativos.)
caddy_lee_el_sitio() {  # el contenedor ve este archivo tal cual, y su Caddyfile importa la carpeta
  local archivo="$1" caddyfile
  docker exec "$CADDY_CONTAINER" cat "/etc/caddy/sites/$APP_SLUG.caddy" 2>/dev/null | cmp -s - "$archivo" || return 1
  caddyfile="$(docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile 2>/dev/null || true)"
  printf '%s\n' "$caddyfile" | grep -E '^[[:space:]]*import[[:space:]]+[^[:space:]]*sites/\*\.caddy' >/dev/null
}

ensure_caddy_site() {
  local cfg=(--config /etc/caddy/Caddyfile --adapter caddyfile) redes
  if [[ " $(docker ps --format '{{.Names}}' | tr '\n' ' ') " != *" $CADDY_CONTAINER "* ]]; then
    warn "No encontré corriendo el contenedor de Caddy '$CADDY_CONTAINER' (variable CADDY_CONTAINER)."
    return 1
  fi
  redes=" $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER") "
  if [[ "$redes" != *" $PROXY_NETWORK "* ]]; then
    log "Conectando $CADDY_CONTAINER a la red '$PROXY_NETWORK'"
    docker network connect "$PROXY_NETWORK" "$CADDY_CONTAINER" || { warn "No pude conectar $CADDY_CONTAINER a '$PROXY_NETWORK'."; return 1; }
  fi
  if [ ! -d "$CADDY_SITES_DIR" ]; then
    warn "No existe la carpeta de sitios $CADDY_SITES_DIR (variable CADDY_SITES_DIR)."
    return 1
  fi

  local archivo="$CADDY_SITES_DIR/$APP_SLUG.caddy" nuevo previo="" habia=0 cambio=1
  nuevo="$(cat <<EOF
# $APP_SLUG — lo escribe deploy/deploy.sh del repo en cada despliegue; no editar a mano.
$(hosts_caddy) {
	encode zstd gzip
	reverse_proxy $WEB_CONTAINER:$WEB_PORT
}
EOF
)"
  if [ -f "$archivo" ]; then
    habia=1; previo="$(cat "$archivo")"
    [ "$previo" = "$nuevo" ] && cambio=0
  fi
  if [ "$cambio" = 1 ]; then
    printf '%s\n' "$nuevo" > "$archivo" || { warn "No puedo escribir $archivo (¿la carpeta es de root? sudo chown $(id -un): $CADDY_SITES_DIR)."; return 1; }
  fi
  restaurar() { if [ "$habia" = 1 ]; then printf '%s\n' "$previo" > "$archivo"; else rm -f "$archivo"; fi; }

  if ! caddy_lee_el_sitio "$archivo"; then
    [ "$cambio" = 1 ] && restaurar
    warn "El Caddy '$CADDY_CONTAINER' no lee $archivo: su Caddyfile no importa '…/sites/*.caddy' o no monta $CADDY_SITES_DIR en /etc/caddy/sites."
    return 1
  fi
  if [ "$cambio" = 0 ]; then log "Caddy ya publica $(hosts_caddy)"; return 0; fi

  if docker exec "$CADDY_CONTAINER" caddy validate "${cfg[@]}" >/dev/null 2>&1 \
     && docker exec "$CADDY_CONTAINER" caddy reload "${cfg[@]}" >/dev/null 2>&1; then
    log "Caddy publica $(hosts_caddy) (el certificado HTTPS lo saca solo)"
  else
    warn "Caddy rechazó la configuración nueva; dejo la anterior. Detalle:"
    docker exec "$CADDY_CONTAINER" caddy validate "${cfg[@]}" 2>&1 | grep -iE 'error|ambiguous' | tail -n 5 >&2 || true
    restaurar
    return 1
  fi
}

# --------------------------------------------------------------------------- salud
wait_healthy() {
  log "Esperando a que los servicios queden sanos (hasta $((HEALTH_TIMEOUT / 60)) min)"
  local limite=$((SECONDS + HEALTH_TIMEOUT)) pendientes ultimo="" svc cid estado reinicios servicios
  servicios="$(compose config --services)"
  while [ $SECONDS -lt $limite ]; do
    pendientes=""
    for svc in $servicios; do
      cid="$(compose ps -a -q "$svc" 2>/dev/null | awk 'NR == 1')"
      if [ -z "$cid" ]; then pendientes="$pendientes $svc(sin-contenedor)"; continue; fi
      estado="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}/{{.State.ExitCode}}' "$cid" 2>/dev/null || echo desconocido/1)"
      reinicios="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
      if [ "${reinicios:-0}" -ge 5 ]; then
        warn "$svc ya se reinició $reinicios veces. Últimos registros:"
        compose logs --tail 60 "$svc" >&2 || true
        return 1
      fi
      case "$estado" in
        healthy/*|running/*|exited/0) ;;   # exited/0: servicios de una sola corrida (migraciones)
        *) pendientes="$pendientes $svc(${estado%/*})" ;;
      esac
    done
    if [ -z "$pendientes" ]; then log "Servicios listos ✓"; return 0; fi
    # Una línea solo cuando algo cambia: el log de GitHub Actions queda legible.
    [ "$pendientes" != "$ultimo" ] && { echo "  esperando:$pendientes"; ultimo="$pendientes"; }
    sleep 5
  done
  warn "Se agotó la espera. Estado y últimos registros:"
  compose ps -a >&2 || true
  compose logs --tail 40 >&2 || true
  return 1
}

guardar_info() {  # deja constancia del último despliegue que salió bien (lo lee 'status' y el skill)
  {
    echo "repo=${DEPLOY_REPO:-?}"
    echo "commit=${DEPLOY_COMMIT:-manual}"
    echo "ref=${DEPLOY_REF:-}"
    echo "modo=$1"
    echo "fecha=$(date -Iseconds)"
    echo "run=${DEPLOY_RUN_URL:-}"
  } > .deploy-info
}

desplegar() {  # desplegar update|reset
  MODO="$1"
  local caddy_ok=1
  ensure_env
  ensure_proxy_network
  check_disk
  # Primero se construye (lo que más tarda, sobre todo en ARM) y recién después se baja lo que
  # corre: así el sitio queda caído segundos y no durante todo el build.
  log "Construyendo imágenes (la primera vez tarda varios minutos, más en ARM)"
  compose build
  if [ "$MODO" = reset ]; then
    warn "RESET: se borran los contenedores y VOLÚMENES de '$APP_SLUG' (base de datos incluida). Los otros proyectos no se tocan."
    compose down -v --remove-orphans || true
  fi
  log "Levantando el stack"
  compose up -d --remove-orphans
  # El sitio se registra antes de esperar la salud: así Caddy va sacando el certificado en paralelo.
  ensure_caddy_site || caddy_ok=0
  wait_healthy
  [ "$caddy_ok" = 1 ] || die "La app quedó levantada pero Caddy no la publica en $(hosts_caddy) (ver el aviso de arriba)."
  docker image prune -f >/dev/null 2>&1 || true
  guardar_info "$MODO"
  log "Listo: https://$(primer_host)"
}

cmd_status() {
  compose ps -a
  echo
  local svc cid
  for svc in $(compose config --services 2>/dev/null); do
    cid="$(compose ps -a -q "$svc" 2>/dev/null | awk 'NR == 1')"
    if [ -z "$cid" ]; then echo "$svc: sin contenedor"; continue; fi
    echo "$svc: $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} (reinicios: {{.RestartCount}})' "$cid")"
  done
  if [ -f .deploy-info ]; then echo; echo "Último despliegue correcto:"; sed 's/^/  /' .deploy-info; fi
  APP_DOMAIN="$(get_kv DEPLOY_APP_DOMAIN)"
  [ -n "$APP_DOMAIN" ] && { echo; echo "URL: https://$(primer_host)"; }
  return 0
}

cmd_set_env() {
  local k="${1:-}" v
  [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Uso: bash deploy/deploy.sh set-env NOMBRE"
  [ -t 0 ] || die "Necesita una terminal interactiva. Desde tu PC: ssh -t usuario@host 'cd $(pwd) && bash deploy/deploy.sh set-env $k'"
  ensure_env_file
  read -rsp "Valor para $k (no se muestra): " v; echo
  [ -n "$v" ] || die "Valor vacío: no cambié nada."
  case "$v" in *"'"*) die "El valor no puede tener comillas simples (') por cómo docker compose lee el .env." ;; esac
  set_kv "$k" "'$v'"   # entre comillas simples: docker compose no interpreta $, # ni espacios
  log "$k guardado en $ENV_FILE. Se aplica en el próximo deploy (o ahora: bash deploy/deploy.sh update)."
}

case "${1:-update}" in
  update|up) desplegar update ;;
  reset)
    if [ -t 0 ]; then
      read -r -p "⚠ Esto BORRA la base de datos del Comando Central. Escribí 'borrar' para confirmar: " r
      [ "$r" = "borrar" ] || die "Cancelado."
    fi
    desplegar reset ;;
  status)  cmd_status ;;
  logs)    shift; compose logs -f --tail 100 "$@" ;;
  down)    compose down --remove-orphans ;;
  set-env) shift; cmd_set_env "${1:-}" ;;
  help|-h|--help)
    awk 'NR > 2 && /^# =====/ {exit} NR > 2 {sub(/^# ?/, ""); print}' "${BASH_SOURCE[0]}" ;;
  *) die "Comando desconocido: $1 (probá: update, reset, status, logs, down, set-env, help)" ;;
esac
