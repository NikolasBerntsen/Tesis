#!/usr/bin/env bash
# Script de despliegue que corre EN LA VM de Oracle. El workflow de GitHub lo
# invoca por SSH después de copiar el código con rsync.
#
#   bash deploy/deploy.sh up      # primera vez: prepara .env, red y levanta
#   bash deploy/deploy.sh update  # despliegue incremental (lo usa el CI)
#   bash deploy/deploy.sh logs    # logs en vivo
#   bash deploy/deploy.sh down    # baja el contenedor (conserva la base)
#   bash deploy/deploy.sh reset   # BORRA la base y levanta de cero (manual)
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
PLANTILLA=".env.example"
# Red compartida con el Caddy del otro proyecto: es la que permite que el
# proxy llegue a este contenedor sin publicar ningún puerto al exterior.
RED="proxy"
CONTENEDOR="comando-central"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

verificar_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker no está instalado en esta VM." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: falta el plugin 'docker compose'." >&2
    exit 1
  fi
}

# El .env vive sólo en la VM (rsync lo excluye), así que los secretos
# sobreviven a todos los despliegues. Si no existe se crea con un JWT_SECRET
# aleatorio; si ya existe no se toca, para no invalidar las sesiones abiertas.
preparar_env() {
  if [ -f .env ]; then return; fi
  echo "→ No hay .env: creando uno con un JWT_SECRET nuevo."
  if [ -f "$PLANTILLA" ]; then cp "$PLANTILLA" .env; else : > .env; fi
  local secreto
  if command -v openssl >/dev/null 2>&1; then
    secreto="$(openssl rand -hex 32)"
  else
    secreto="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")"
  fi
  if grep -q '^JWT_SECRET=' .env; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$secreto|" .env
  else
    echo "JWT_SECRET=$secreto" >> .env
  fi
  chmod 600 .env
}

preparar_red() {
  if ! docker network inspect "$RED" >/dev/null 2>&1; then
    echo "→ Creando la red compartida '$RED'."
    docker network create "$RED"
  fi
}

# A diferencia del script del otro proyecto, esta espera SÍ devuelve error si
# el contenedor no llega a estar sano: un deploy roto tiene que verse rojo en
# Actions, no en verde.
esperar_salud() {
  local intentos=40 estado
  echo "→ Esperando a que el contenedor esté sano…"
  for _ in $(seq "$intentos"); do
    estado="$(docker inspect -f '{{.State.Health.Status}}' "$CONTENEDOR" 2>/dev/null || echo desconocido)"
    case "$estado" in
      healthy) echo "✓ Contenedor sano."; return 0 ;;
      unhealthy|desconocido) ;;
    esac
    sleep 3
  done
  echo "ERROR: el contenedor no quedó sano (último estado: $estado)." >&2
  compose logs --tail 50 || true
  return 1
}

# Comprobación de punta a punta a través del Caddy del otro proyecto. Es
# informativa: en el primer despliegue el certificado puede tardar un minuto.
verificar_por_el_proxy() {
  local url="https://tesis.144-22-138-149.sslip.io/api/health"
  if curl -fsS --max-time 10 "$url" >/dev/null 2>&1; then
    echo "✓ Responde por el proxy: $url"
  else
    echo "· Todavía no responde por $url (¿falta el bloque en el Caddyfile del otro proyecto o el certificado está emitiéndose?)."
  fi
}

case "${1:-up}" in
  up)
    verificar_docker; preparar_env; preparar_red
    compose up -d --build
    esperar_salud
    verificar_por_el_proxy
    ;;
  update)
    verificar_docker; preparar_env; preparar_red
    compose up -d --build
    esperar_salud
    # Las imágenes huérfanas se acumulan con cada build y llenan el disco de la
    # VM, que además comparte con el otro proyecto. Sólo borra las que nadie usa.
    docker image prune -f >/dev/null || true
    verificar_por_el_proxy
    ;;
  logs)  compose logs -f --tail 100 ;;
  down)  compose down ;;
  reset)
    echo "⚠  Esto BORRA la base de datos del Comando Central."
    read -r -p "Escribí 'borrar' para confirmar: " respuesta
    [ "$respuesta" = "borrar" ] || { echo "Cancelado."; exit 1; }
    compose down -v --remove-orphans
    verificar_docker; preparar_env; preparar_red
    compose up -d --build
    esperar_salud
    ;;
  *) echo "Uso: $0 {up|update|logs|down|reset}" >&2; exit 1 ;;
esac
