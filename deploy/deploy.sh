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
  # La bandera se deja explícita y apagada: que exista en el archivo hace que
  # se vea, y que se vea es lo que evita que alguien la active sin querer.
  grep -q '^DEV_WIPE_DB=' .env || echo 'DEV_WIPE_DB=false' >> .env
  if grep -q '^JWT_SECRET=' .env; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$secreto|" .env
  else
    echo "JWT_SECRET=$secreto" >> .env
  fi
  chmod 600 .env
}

# ---- DEV_WIPE_DB ----
#
# Bandera de desarrollo: con `true`, CADA despliegue borra la base antes de
# levantar. Se lee del entorno (lo puede mandar el workflow) y, si no viene, del
# .env de la VM. Cualquier otro valor —incluido no estar definida— deja los
# datos intactos, que es el comportamiento por defecto.
#
# Está pensada para la etapa de desarrollo, mientras el esquema todavía se
# mueve. Antes de que haya datos reales hay que ponerla en false: acá no hay
# confirmación ni vuelta atrás, y el borrado corre solo con cada merge.
valor_wipe() {
  if [ -n "${DEV_WIPE_DB:-}" ]; then
    echo "$DEV_WIPE_DB"
  elif [ -f .env ]; then
    grep -E '^DEV_WIPE_DB=' .env | tail -n1 | cut -d= -f2- | tr -d '"'"'"' '
  fi
}

origen_wipe() {
  if [ -n "${DEV_WIPE_DB:-}" ]; then echo "variable de entorno del despliegue"; else echo "archivo .env de la VM"; fi
}

wipe_pedido() {
  case "$(valor_wipe | tr '[:upper:]' '[:lower:]')" in
    true|1|si|sí|yes) return 0 ;;
    *) return 1 ;;
  esac
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
    if wipe_pedido; then
      echo "⚠  DEV_WIPE_DB está en true: se BORRA la base antes de levantar."
      echo "   Origen del valor: $(origen_wipe)"
      compose down -v --remove-orphans
      echo "   Volúmenes eliminados. El contenedor va a sembrar la base de cero al arrancar."
    fi
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
