#!/usr/bin/env bash
#
# Levanta los servicios del MVP de patrullaje con drones:
#   - Comando Central (backend)      http://localhost:4000
#   - Consola del operador (web)     http://localhost:5173
#   - Software de detección (mock)   http://localhost:8765
#
# La app Android se corre aparte desde Android Studio.
#
# Uso:
#   ./start.sh              Levanta todo (Docker si el daemon corre; si no, npm local)
#   ./start.sh stop         Detiene y elimina los contenedores
#   ./start.sh stop reset   Además borra los volúmenes y la base de datos

set -euo pipefail
cd "$(dirname "$0")"

RESET_DB="no"

case "${*:-}" in
  "")           MODE="run" ;;
  "stop")       MODE="stop" ;;
  "stop reset") MODE="stop"; RESET_DB="yes" ;;
  *)
    echo "Uso: ./start.sh [stop [reset]]" >&2
    exit 1
    ;;
esac

# ---------- utilidades ----------

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi

info()  { echo "${DIM}·${RESET} $*"; }
ok()    { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}!${RESET} $*"; }
fail()  { echo "${RED}✗${RESET} $*" >&2; }

http_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "$1" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e "fetch('$1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
  else
    return 1
  fi
}

# Espera a que un servicio responda. Devuelve 1 si se agota el tiempo.
wait_for() {
  local url="$1" name="$2" tries="${3:-60}"
  while [ "$tries" -gt 0 ]; do
    if http_ok "$url"; then ok "$name listo"; return 0; fi
    sleep 1
    tries=$((tries - 1))
  done
  fail "$name no respondió a tiempo ($url)"
  return 1
}

lan_ip() {
  command -v node >/dev/null 2>&1 || return 0
  node -e "
    const os = require('os');
    const nic = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal);
    if (nic) console.log(nic.address);
  " 2>/dev/null || true
}

banner() {
  local ip; ip="$(lan_ip)"
  echo
  echo "${BOLD}────────────────────────────────────────────────────────────${RESET}"
  echo "${BOLD}  Servicios levantados${RESET}"
  echo "${BOLD}────────────────────────────────────────────────────────────${RESET}"
  echo "  Consola del operador   ${BOLD}http://localhost:5173${RESET}"
  echo "  Comando Central (API)  http://localhost:4000"
  echo "  Detección (visor)      ${BOLD}http://localhost:8765${RESET}"
  echo
  echo "  ${BOLD}Usuarios de demo${RESET}"
  echo "    operador / operador123   (consola web)"
  echo "    drone1   / drone123      (usado por la app Android)"
  echo
  echo "  ${BOLD}En la app Android${RESET} (Android Studio, variante mockDebug)"
  echo "    Emulador  → Comando Central: http://10.0.2.2:4000"
  echo "                Detección:       ws://10.0.2.2:8765"
  if [ -n "$ip" ]; then
    echo "    Teléfono  → Comando Central: http://$ip:4000"
    echo "                Detección:       ws://$ip:8765"
  fi
  echo
  echo "  ${DIM}Guion de demo paso a paso en el README.md${RESET}"
  echo "  ${DIM}Ctrl+C para detener todo${RESET}"
  echo "${BOLD}────────────────────────────────────────────────────────────${RESET}"
  echo
}

# down detiene Y elimina los contenedores y la red; --remove-orphans barre
# además los que hayan quedado de una configuración anterior.
docker_down() {
  docker compose down --remove-orphans
}

docker_available() {
  command -v docker >/dev/null 2>&1 || return 1
  docker compose version >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

# ---------- modo stop ----------

if [ "$MODE" = "stop" ]; then
  if docker_available; then
    info "Deteniendo y eliminando contenedores…"
    if [ "$RESET_DB" = "yes" ]; then
      docker compose down --remove-orphans --volumes
      ok "Contenedores y volúmenes eliminados"
    else
      docker_down
      ok "Contenedores eliminados (los datos se conservan)"
    fi
  else
    warn "Docker no está disponible; en modo nativo alcanza con Ctrl+C"
  fi
  # En modo nativo la base no vive en un volumen sino en disco
  if [ "$RESET_DB" = "yes" ] && [ -d backend/data ]; then
    rm -rf backend/data
    info "Base de datos local borrada"
  fi
  exit 0
fi

# ---------- elección de modo ----------

if docker_available; then
  MODE="docker"
else
  MODE="native"
  info "Docker no disponible: se usa modo nativo"
fi

# ---------- Docker ----------

run_docker() {
  info "Construyendo e iniciando contenedores (la primera vez tarda unos minutos)…"
  docker compose up -d --build

  # Al salir, bajar los contenedores para no dejar nada corriendo
  trap 'echo; info "Deteniendo contenedores…"; docker_down; exit 0' INT TERM

  wait_for "http://localhost:4000/api/health" "Comando Central" 90 || { docker compose logs backend; exit 1; }
  wait_for "http://localhost:8765/"           "Detección"       60 || { docker compose logs detection; exit 1; }
  wait_for "http://localhost:5173/"           "Consola web"     90 || { docker compose logs frontend; exit 1; }

  banner
  info "Mostrando logs (Ctrl+C para detener todo)"
  docker compose logs -f
}

# ---------- Nativo ----------

PIDS=()

cleanup_native() {
  trap - INT TERM EXIT
  echo
  info "Deteniendo servicios…"
  # Con Ctrl+C la terminal ya señalizó a todo el grupo; esto cubre el caso de
  # un SIGTERM dirigido solo al script, y remata a los que no hayan salido.
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
  done
  ok "Listo"
  exit 0
}

# Instala dependencias solo si faltan (borrar node_modules fuerza reinstalación)
ensure_deps() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ]; then
    info "Instalando dependencias de $dir…"
    (cd "$dir" && npm install --no-audit --no-fund >/dev/null)
  fi
}

start_service() {
  local name="$1" dir="$2" logfile="$3"; shift 3
  # exec reemplaza la subshell por el proceso real, así $! es el PID que hay
  # que matar y no el de un shell intermedio que dejaría al servicio huérfano.
  (cd "$dir" && exec "$@" </dev/null >"../$logfile" 2>&1) &
  PIDS+=("$!")
  info "$name iniciado (log: $logfile)"
}

run_native() {
  command -v node >/dev/null 2>&1 || { fail "Node.js no está instalado (se necesita 20+)"; exit 1; }

  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    fail "Node $major detectado; se necesita Node 20 o superior"
    exit 1
  fi

  mkdir -p logs
  [ -f backend/.env ] || cp backend/.env.example backend/.env

  ensure_deps backend
  ensure_deps frontend
  ensure_deps detection-mock

  info "Sembrando usuarios y rutas de demo…"
  (cd backend && npm run seed >../logs/seed.log 2>&1) || { fail "Falló el seed (ver logs/seed.log)"; exit 1; }

  trap cleanup_native INT TERM EXIT

  # Se invocan los binarios directamente (no vía npm) para que Ctrl+C no deje
  # procesos hijos huérfanos.
  start_service "Comando Central" backend      logs/backend.log   ./node_modules/.bin/tsx watch src/index.ts
  start_service "Detección"       detection-mock logs/detection.log node server.js
  start_service "Consola web"     frontend     logs/frontend.log  ./node_modules/.bin/vite

  wait_for "http://localhost:4000/api/health" "Comando Central" 60 || { tail -20 logs/backend.log; exit 1; }
  wait_for "http://localhost:8765/"           "Detección"       30 || { tail -20 logs/detection.log; exit 1; }
  wait_for "http://localhost:5173/"           "Consola web"     60 || { tail -20 logs/frontend.log; exit 1; }

  banner
  wait
}

case "$MODE" in
  docker) run_docker ;;
  native) run_native ;;
esac
