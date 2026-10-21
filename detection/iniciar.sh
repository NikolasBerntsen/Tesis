#!/usr/bin/env bash
# Lanzador de un clic del software de detección (Linux y macOS).
#
# El equivalente de iniciar.bat: deja todo listo y arranca el servidor.
#
#   1. Busca un entorno de Python que ya tenga todo (torch, ultralytics, aiohttp,
#      psutil) y lo reutiliza.
#   2. Si no hay, consigue "uv" (lo instala en el perfil del usuario con el
#      instalador oficial) y crea detection/.venv con Python 3.12.
#   3. Instala torch: en Linux con NVIDIA el de CUDA, sin NVIDIA el de CPU; en
#      macOS el de PyPI (trae la GPU de Apple, mps). Después, requirements.txt.
#   4. Verifica que todo importe y qué GPU ve torch.
#   5. Consigue el modelo entrenado (lo copia de las carpetas conocidas o lo baja
#      de una URL configurable, verificando el SHA-256). Sin modelo, se sigue con
#      el de respaldo de COCO.
#   6. Revisa el firewall (ufw / firewalld en Linux, el de la aplicación en macOS)
#      y, si hace falta, ofrece abrir los puertos con sudo.
#   7. Arranca el servidor y abre el visor en el navegador.
#
#   ./iniciar.sh                         # todo, y arranca
#   ./iniciar.sh --solo-verificar        # todo menos arrancar (y sin sudo)
#   ./iniciar.sh --modelo yolo11m-mix    # lo que no es de este script va tal cual a servidor.py
#
# Si no se abre con doble clic o con ./iniciar.sh, falta el permiso de
# ejecución:  chmod +x iniciar.sh   (o correrlo con: bash iniciar.sh).
# En Windows también corre desde Git Bash, pero solo reutilizando un entorno
# que ya exista: para instalar y para el firewall, iniciar.bat.

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$AQUI")"
VENV="$AQUI/.venv"
MODELOS="$AQUI/modelos"
# El modelo de campo y su huella: la copia o la descarga se aceptan solo si
# coinciden, así un .pt a medio bajar o el de otro entrenamiento no pasan.
MODELO="yolo11m-2clases.pt"
MODELO_BYTES=40579500
MODELO_SHA256="d7d4599023e8e9be4ae5548261eb1df379a217ec9ebbfe82967fc282d386e881"
PYTHON_VERSION="3.12"
INDICE_CUDA="https://download.pytorch.org/whl/cu128"
INDICE_CPU="https://download.pytorch.org/whl/cpu"
PUERTO=8765
PUERTO_UDP=8766
# Además de si torch ve la GPU, si el torch instalado TRAE CUDA (torch.version.cuda):
# no es lo mismo un torch de CPU (se arregla reinstalándolo) que uno de CUDA que
# no ve la placa porque el driver es viejo (reinstalarlo no cambia nada). La
# línea va marcada porque torch avisa por stderr justo en ese caso.
PRUEBA="import torch, ultralytics, aiohttp, psutil, cv2, numpy; print('ENTORNO', torch.__version__, torch.cuda.is_available(), torch.version.cuda is not None)"

SOLO_VERIFICAR=0
ARGS_SERVIDOR=()
ANTERIOR=""
for a in "$@"; do
    case "$a" in
        --solo-verificar|-SoloVerificar) SOLO_VERIFICAR=1 ;;
        *) ARGS_SERVIDOR+=("$a") ;;
    esac
    if [ "$ANTERIOR" = "--puerto" ]; then PUERTO="$a"; fi
    ANTERIOR="$a"
done

case "$(uname -s)" in
    Darwin) SO=mac ;;
    Linux) SO=linux ;;
    MINGW*|MSYS*|CYGWIN*) SO=windows ;;
    *) SO=otro ;;
esac
# En Git Bash la terminal es UTF-8 pero Python escribe en la página de códigos
# de Windows cuando no habla con una consola de verdad: los acentos del log
# saldrían rotos.
[ "$SO" = windows ] && export PYTHONIOENCODING=utf-8

# ---------------------------------------------------------------------------
# Mensajes
# ---------------------------------------------------------------------------

if [ -t 1 ]; then C_PASO=$'\033[36m'; C_OK=$'\033[32m'; C_AVISO=$'\033[33m'; C_ERROR=$'\033[31m'; C_FIN=$'\033[0m'
else C_PASO=""; C_OK=""; C_AVISO=""; C_ERROR=""; C_FIN=""; fi

paso() { printf '\n%s[%s/7] %s%s\n' "$C_PASO" "$1" "$2" "$C_FIN"; }
bien() { printf '      %sOK  %s%s\n' "$C_OK" "$1" "$C_FIN"; }
aviso() { printf '      %s!!  %s%s\n' "$C_AVISO" "$1" "$C_FIN"; }
info() { printf '          %s\n' "$1"; }
fallar() {
    printf '\n  %sERROR: %s%s\n' "$C_ERROR" "$1" "$C_FIN"
    shift
    for l in "$@"; do printf '         %s%s%s\n' "$C_ERROR" "$l" "$C_FIN"; done
    exit 1
}

python_de() {  # el intérprete de un entorno virtual, según el sistema
    if [ "$SO" = windows ]; then echo "$1/Scripts/python.exe"; else echo "$1/bin/python"; fi
}

escritorios() {
    # El Escritorio cambia de nombre con el idioma; xdg-user-dir sabe cuál es.
    local d
    if command -v xdg-user-dir >/dev/null 2>&1; then d="$(xdg-user-dir DESKTOP 2>/dev/null)"; [ -n "$d" ] && echo "$d"; fi
    echo "$HOME/Desktop"
    echo "$HOME/Escritorio"
}

huella() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tamano() { wc -c < "$1" | tr -d ' '; }

# ---------------------------------------------------------------------------
# 1. Entorno de Python
# ---------------------------------------------------------------------------

hay_nvidia() {
    command -v nvidia-smi >/dev/null 2>&1 || return 1
    nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null | head -n 1
}

# Deja en PRUEBA_SIRVE (1/0), PRUEBA_CUDA (torch ve la GPU: True/False),
# PRUEBA_TORCH_CUDA (el torch instalado trae CUDA), PRUEBA_SIN_MODULO y
# PRUEBA_DETALLE lo que imprimió $PRUEBA ($1 = código de salida, $2 = salida).
leer_prueba() {
    local linea
    PRUEBA_SIRVE=0; PRUEBA_CUDA=False; PRUEBA_TORCH_CUDA=False; PRUEBA_DETALLE=""; PRUEBA_SIN_MODULO=0
    linea="$(printf '%s\n' "$2" | tr -d '\r' | grep -E '^ENTORNO [^ ]+ (True|False) (True|False)$' | tail -n 1)"
    if [ "$1" = 0 ] && [ -n "$linea" ]; then
        PRUEBA_SIRVE=1
        PRUEBA_CUDA="$(printf '%s' "$linea" | cut -d' ' -f3)"
        PRUEBA_TORCH_CUDA="$(printf '%s' "$linea" | cut -d' ' -f4)"
        PRUEBA_DETALLE="torch $(printf '%s' "$linea" | cut -d' ' -f2)"
    elif printf '%s' "$2" | grep -q "No module named"; then
        PRUEBA_SIN_MODULO=1
        PRUEBA_DETALLE="le falta $(printf '%s' "$2" | grep -o "No module named '[^']*'" | head -n 1 | cut -d"'" -f2)"
    else
        PRUEBA_DETALLE="$(printf '%s\n' "$2" | tail -n 1)"
    fi
}

probar_entorno() {  # $1 = el intérprete; deja PRUEBA_* (ver leer_prueba). 1 si no existe.
    local salida codigo
    [ -x "$1" ] || return 1
    salida="$("$1" -c "$PRUEBA" 2>&1)"; codigo=$?
    leer_prueba "$codigo" "$salida"
    return 0
}

# Qué hacer con un entorno ya probado (usa PRUEBA_* y GPU; $1 = 1 si es el
# propio): usar / usar-sin-gpu / reinstalar-torch / saltear / completar / no-sirve.
que_hacer_con() {
    if [ "$PRUEBA_SIRVE" = 1 ] && [ -n "$GPU" ] && [ "$PRUEBA_CUDA" != True ]; then
        # torch de CUDA que igual no ve la placa: es el driver (o la placa), no
        # el entorno. Reinstalarlo o armar otro entorno bajaría 3 GB en CADA
        # arranque para terminar igual: se usa y el paso 4 dice qué actualizar.
        if [ "$PRUEBA_TORCH_CUDA" = True ]; then echo usar-sin-gpu
        # El propio sí se toca: se le cambia torch por el de CUDA (paso 3). Uno
        # ajeno no: andaría, pero en CPU, y eso no llega a tiempo real.
        elif [ "$1" = 1 ]; then echo reinstalar-torch
        else echo saltear; fi
    elif [ "$PRUEBA_SIRVE" = 1 ]; then echo usar
    elif [ "$1" = 1 ] && [ "$PRUEBA_SIN_MODULO" = 1 ]; then echo completar
    else echo no-sirve; fi
}

main() {
    printf '\n  Software de detección - preparación y arranque\n'
    [ "$SOLO_VERIFICAR" = 1 ] && printf '  (modo verificación: no arranca el servidor ni pide sudo)\n'

    paso 1 "Entorno de Python"
    GPU="$(hay_nvidia)"
    if [ -n "$GPU" ]; then info "GPU NVIDIA: $GPU"
    elif [ "$SO" = mac ]; then info "Mac: torch usa la GPU de Apple (mps) si es Apple Silicon."
    else info "Sin GPU NVIDIA (nvidia-smi no responde): la detección va a ir en CPU."; fi

    PROPIO="$(python_de "$VENV")"
    local candidatos=("$PROPIO" "$(python_de "$REPO/ml/.venv")") e c
    while IFS= read -r e; do candidatos+=("$(python_de "$e/tests ia tesis/.venv")"); done < <(escritorios)

    PY=""; REINSTALAR_TORCH=0; COMPLETAR_PROPIO=0; CREADO=0
    for c in "${candidatos[@]}"; do
        probar_entorno "$c" || continue
        local es_propio=0 accion; [ "$c" = "$PROPIO" ] && es_propio=1
        accion="$(que_hacer_con "$es_propio")"
        case "$accion" in
            reinstalar-torch)
                aviso "$c tiene torch sin CUDA y esta PC tiene una NVIDIA: se le reinstala torch."
                PY="$c"; REINSTALAR_TORCH=1; break ;;
            saltear) aviso "$c tiene torch sin CUDA (iría en CPU, lento): no se usa." ;;
            usar-sin-gpu)
                aviso "$c tiene torch con CUDA pero no ve la NVIDIA: es el driver, no el entorno (ver el paso 4). Se usa igual."
                PY="$c"; break ;;
            usar)
                local extra=""; [ "$PRUEBA_CUDA" = True ] && extra=", con CUDA"
                PY="$c"; bien "$c ($PRUEBA_DETALLE$extra)"; break ;;
            completar)
                aviso "$c está incompleto ($PRUEBA_DETALLE): se completa."
                PY="$c"; COMPLETAR_PROPIO=1; break ;;
            *) info "$c no sirve: $PRUEBA_DETALLE" ;;
        esac
    done

    preparar_entorno
    instalar_dependencias
    verificar
    asegurar_modelo
    revisar_firewall
    arrancar
}

# ---------------------------------------------------------------------------
# 2. uv y el entorno nuevo
# ---------------------------------------------------------------------------

buscar_uv() {
    local l
    for l in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "$HOME/.local/bin/uv.exe"; do
        if [ -n "$l" ] && [ -x "$l" ]; then echo "$l"; return 0; fi
    done
    return 1
}

instalar_uv() {
    # El instalador oficial de Astral, en el perfil del usuario (sin sudo).
    # UV_NO_MODIFY_PATH: que no toque el .bashrc / .zshrc; este script lo llama
    # por su ruta completa y no le hace falta.
    info "Instalando uv (el instalador oficial de astral.sh, en tu perfil de usuario)..."
    if command -v curl >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null
    fi
}

python_del_sistema() {
    # El respaldo si uv no se pudo instalar: un Python 3.10..3.13 ya instalado.
    local p
    for p in python3.12 python3.11 python3.13 python3.10 python3; do
        if command -v "$p" >/dev/null 2>&1 &&
           "$p" -c 'import sys, venv; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
            command -v "$p"; return 0
        fi
    done
    return 1
}

preparar_entorno() {
    UV=""
    paso 2 "Herramienta de instalación (uv)"
    if [ -n "$PY" ] && [ "$REINSTALAR_TORCH" = 0 ] && [ "$COMPLETAR_PROPIO" = 0 ]; then
        bien "No hace falta: el entorno ya tiene todo."
        return
    fi
    if [ "$SO" = windows ]; then
        fallar "Desde Git Bash este script solo reutiliza un entorno que ya exista." \
               "Para instalar en Windows, usá iniciar.bat (doble clic)."
    fi
    UV="$(buscar_uv)"
    if [ -z "$UV" ]; then instalar_uv; UV="$(buscar_uv)"; fi
    if [ -n "$UV" ]; then bien "uv: $UV"
    else aviso "No se pudo instalar uv (¿sin internet, o sin curl/wget?): pruebo con el Python del sistema."; fi
    [ -n "$PY" ] && return

    local libre_kb
    libre_kb="$(df -Pk "$AQUI" 2>/dev/null | awk 'NR==2 {print $4}')"
    if [ -n "$libre_kb" ] && [ "$libre_kb" -lt $((8 * 1024 * 1024)) ]; then
        aviso "Quedan $((libre_kb / 1024 / 1024)) GB libres en el disco y el entorno ocupa unos 5 GB: puede no alcanzar."
    fi
    if [ -n "$UV" ]; then
        info "Creando detection/.venv con Python $PYTHON_VERSION (uv lo baja si no está)..."
        "$UV" venv --python "$PYTHON_VERSION" "$VENV" ||
            fallar "uv no pudo crear el entorno." "Revisá la conexión a internet y volvé a correr ./iniciar.sh." \
                   "Si quedó a medias, borrá $VENV antes."
    else
        local base
        base="$(python_del_sistema)" ||
            fallar "No hay uv ni un Python 3.10 a 3.13 instalado." \
                   "Instalá Python 3.12 (apt install python3.12-venv, brew install python@3.12) o conectate a" \
                   "internet para que se instale uv, y volvé a correr ./iniciar.sh."
        info "Creando detection/.venv con $base ..."
        "$base" -m venv "$VENV" || fallar "No se pudo crear el entorno con $base." \
            "En Debian/Ubuntu suele faltar el paquete python3-venv:  sudo apt install python3-venv"
    fi
    PY="$PROPIO"; CREADO=1
}

# ---------------------------------------------------------------------------
# 3. torch y el resto
# ---------------------------------------------------------------------------

instalar() {  # con uv si está (mucho más rápido); si no, con el pip del entorno
    if [ -n "$UV" ]; then "$UV" pip install --python "$PY" "$@"; else "$PY" -m pip install "$@"; fi
}

desinstalar() {
    if [ -n "$UV" ]; then "$UV" pip uninstall --python "$PY" "$@"; else "$PY" -m pip uninstall -y "$@"; fi
}

dejar_solo_opencv_headless() {
    # ultralytics pide opencv-python y requirements.txt la versión sin ventanas:
    # las dos escriben la misma carpeta cv2 y la que se instaló última pisa a la
    # otra. Se deja solo la headless, reinstalada, para que cv2 sea uno solo (y
    # no pida libGL en un Linux sin escritorio).
    local ambas
    ambas="$("$PY" -c "import importlib.metadata as m; n = {(d.metadata['Name'] or '').lower() for d in m.distributions()}; print('opencv-python' in n and 'opencv-python-headless' in n)")"
    [ "$ambas" = True ] || return 0
    info "Quedaron opencv-python y opencv-python-headless juntos: se deja solo la headless."
    desinstalar opencv-python
    if [ -n "$UV" ]; then "$UV" pip install --python "$PY" --reinstall-package opencv-python-headless opencv-python-headless
    else "$PY" -m pip install --force-reinstall --no-deps opencv-python-headless; fi
}

instalar_dependencias() {
    paso 3 "torch y dependencias"
    if [ "$CREADO" = 0 ] && [ "$REINSTALAR_TORCH" = 0 ] && [ "$COMPLETAR_PROPIO" = 0 ]; then
        bien "Nada que instalar."
        return
    fi
    local indice=() cual
    if [ "$SO" = mac ]; then cual="de PyPI (con la GPU de Apple)"
    elif [ -n "$GPU" ]; then indice=(--index-url "$INDICE_CUDA"); cual="con CUDA 12.8 (para la NVIDIA)"
    else indice=(--index-url "$INDICE_CPU"); cual="para CPU"; fi
    if [ "$REINSTALAR_TORCH" = 1 ] || ! "$PY" -c 'import torch' >/dev/null 2>&1; then
        aviso "Se instala torch $cual. La descarga ronda 3 GB y puede tardar varios minutos: no cierres la terminal."
        [ "$REINSTALAR_TORCH" = 1 ] && desinstalar torch torchvision
        instalar torch torchvision ${indice[@]+"${indice[@]}"} ||
            fallar "No se pudo instalar torch." "Revisá la conexión a internet y volvé a correr ./iniciar.sh (retoma donde quedó)."
    fi
    info "Instalando el resto (requirements.txt)..."
    instalar -r "$AQUI/requirements.txt" ||
        fallar "No se pudieron instalar las dependencias de requirements.txt." "Revisá la conexión y volvé a correr ./iniciar.sh."
    dejar_solo_opencv_headless
    bien "Dependencias instaladas."
}

# ---------------------------------------------------------------------------
# 4. Verificación
# ---------------------------------------------------------------------------

verificar() {
    paso 4 "Verificación"
    local salida
    salida="$("$PY" -c "import torch, ultralytics, aiohttp, psutil, cv2
c = torch.cuda.is_available()
m = bool(getattr(torch.backends, 'mps', None)) and torch.backends.mps.is_available()
print('torch', torch.__version__, '| ultralytics', ultralytics.__version__, '| GPU:', torch.cuda.get_device_name(0) if c else ('Apple (mps)' if m else 'no'))
print(c)" 2>&1)" ||
        fallar "El entorno no importa lo que necesita el servidor." "$(printf '%s\n' "$salida" | tail -n 1)" \
               "Borrá $VENV y volvé a correr ./iniciar.sh para rehacerlo."
    bien "Python: $PY"
    bien "$(printf '%s\n' "$salida" | tail -n 2 | head -n 1)"
    if [ -n "$GPU" ] && [ "$(printf '%s\n' "$salida" | tail -n 1)" != True ]; then
        aviso "La PC tiene una NVIDIA pero torch no la ve: la detección va a ir en CPU (segundos por cuadro)."
        info "Actualizá el driver de NVIDIA (CUDA 12.8 pide la rama 570 o más nueva) y volvé a correr ./iniciar.sh."
    fi
}

# ---------------------------------------------------------------------------
# 5. Modelo
# ---------------------------------------------------------------------------

buscar_modelo_local() {
    # En el proyecto de entrenamiento (con sus subcarpetas: runs/*/weights,
    # entrenamiento/*/weights, modelos/v2-*) y en ml/ del repo. Se reconoce por
    # la huella y no por el nombre: ahí todos se llaman best.pt.
    local carpetas=() e c f por_nombre=""
    while IFS= read -r e; do carpetas+=("$e/tests ia tesis"); done < <(escritorios)
    carpetas+=("$REPO/ml/results" "$REPO/ml/runs")
    for c in "${carpetas[@]}"; do
        [ -d "$c" ] || continue
        while IFS= read -r f; do
            if [ "$(tamano "$f")" = "$MODELO_BYTES" ] && [ "$(huella "$f")" = "$MODELO_SHA256" ]; then echo "$f"; return 0; fi
            if [ -z "$por_nombre" ] && [ "$(basename "$f")" = "$MODELO" ]; then por_nombre="$f"; fi
        done < <(find "$c" -maxdepth 6 -type f -name '*.pt' -not -path '*/.venv/*' -not -path '*/site-packages/*' \
                      -not -path '*/datasets/*' 2>/dev/null)
    done
    [ -n "$por_nombre" ] && { echo "$por_nombre"; return 0; }
    return 1
}

fuente_del_modelo() {
    # Una URL (o una ruta: pendrive, carpeta compartida) de donde bajarlo, si se configuró.
    if [ -n "${DRONEPATROL_MODELO_URL:-}" ]; then echo "$DRONEPATROL_MODELO_URL"; return 0; fi
    [ -f "$MODELOS/fuente.txt" ] || return 1
    local linea
    # Sin el BOM que deja el Bloc de notas de Windows: si no, queda pegado a la URL.
    # Los espacios de los bordes se sacan con sed y no con xargs, que se traba
    # con una comilla (una ruta como /media/usb/Niko's/...) y la devuelve vacía.
    linea="$(LC_ALL=C sed $'1s/^\xef\xbb\xbf//' "$MODELOS/fuente.txt" | tr -d '\r' | grep -v '^[[:space:]]*#' |
             grep -v '^[[:space:]]*$' | head -n 1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$linea" ] && { echo "$linea"; return 0; }
    return 1
}

bajar_modelo() {
    local fuente="$1" destino="$2" temporal="$2.descarga"
    if [ -f "$fuente" ]; then cp "$fuente" "$temporal"
    elif command -v curl >/dev/null 2>&1; then curl -fL --retry 2 -o "$temporal" "$fuente"
    else wget -O "$temporal" "$fuente"; fi || { aviso "No se pudo bajar el modelo de $fuente."; rm -f "$temporal"; return 1; }
    if [ "$(tamano "$temporal")" != "$MODELO_BYTES" ] || [ "$(huella "$temporal")" != "$MODELO_SHA256" ]; then
        aviso "Lo que se bajó no es el modelo esperado ($(tamano "$temporal") bytes): se descarta."
        rm -f "$temporal"; return 1
    fi
    mv -f "$temporal" "$destino"
}

asegurar_modelo() {
    paso 5 "Modelo"
    local destino="$MODELOS/$MODELO" origen fuente
    if [ -f "$destino" ]; then
        if [ "$(huella "$destino")" = "$MODELO_SHA256" ]; then bien "modelos/$MODELO (SHA-256 verificado)"
        else aviso "modelos/$MODELO no coincide con el SHA-256 conocido (¿otro entrenamiento?): se usa igual."; fi
        return
    fi
    mkdir -p "$MODELOS"
    if origen="$(buscar_modelo_local)"; then
        cp "$origen" "$destino" && bien "Copiado desde $origen"
        [ "$(huella "$destino")" = "$MODELO_SHA256" ] || aviso "Se llama igual pero no coincide con el SHA-256 conocido: se usa igual."
    elif fuente="$(fuente_del_modelo)"; then
        info "Bajando el modelo de $fuente ..."
        bajar_modelo "$fuente" "$destino" && bien "Bajado y verificado: modelos/$MODELO"
    fi
    if [ ! -f "$destino" ]; then
        aviso "No está $MODELO ni lo encontré en las carpetas conocidas."
        info "Se arranca con el modelo de RESPALDO (YOLO11m de COCO, ~40 MB que baja ultralytics la primera vez):"
        info "anda, pero ve bastante peor desde el aire. Para el entrenado: copialo a detection/modelos/, o poné una"
        info "URL (o ruta) en la variable DRONEPATROL_MODELO_URL o en detection/modelos/fuente.txt."
    fi
}

# ---------------------------------------------------------------------------
# 6. Firewall
# ---------------------------------------------------------------------------

preguntar_y_correr() {  # $1 = descripción; el resto, el comando (con sudo)
    local que="$1"; shift
    info "Comando: $*"
    if [ "$SOLO_VERIFICAR" = 1 ] || [ ! -t 0 ]; then
        info "Corré ./iniciar.sh sin --solo-verificar (en una terminal) para que lo haga, o correlo vos."
        return
    fi
    local r
    read -r -p "          ¿$que ahora? (pide tu contraseña de sudo) [s/N] " r
    case "$r" in s|S|si|sí|Si|Sí) "$@" && bien "Hecho." || aviso "No se pudo: correlo vos." ;; *) info "No se tocó nada." ;; esac
}

ufw_activo() {
    # Por su configuración, que se lee sin sudo. `systemctl is-active ufw` no
    # sirve: en Ubuntu la unidad queda "active (exited)" aunque ufw esté apagado,
    # y se le pediría la contraseña a alguien que no tiene nada que abrir.
    command -v ufw >/dev/null 2>&1 && grep -qs '^ENABLED=yes' "${UFW_CONF:-/etc/ufw/ufw.conf}"
}

revisar_firewall() {
    paso 6 "Firewall"
    case "$SO" in
        windows)
            info "En Windows el firewall lo prepara iniciar.bat (el diagnóstico del paso 7 dice si deja entrar)."
            ;;
        mac)
            local estado
            estado="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null)"
            if printf '%s' "$estado" | grep -qi "enabled"; then
                aviso "El firewall de macOS está prendido: la primera vez va a preguntar si Python acepta conexiones"
                info "entrantes. Tocá «Permitir», si no el teléfono no se puede conectar."
            else
                bien "El firewall de macOS está apagado: no hay nada que abrir."
            fi
            ;;
        linux)
            if ufw_activo; then
                aviso "ufw está activo: hay que dejar entrar TCP $PUERTO (video) y UDP $PUERTO_UDP (descubrimiento)."
                preguntar_y_correr "Abro los puertos en ufw" sudo sh -c "ufw allow $PUERTO/tcp && ufw allow $PUERTO_UDP/udp"
            elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
                aviso "firewalld está activo: hay que dejar entrar TCP $PUERTO (video) y UDP $PUERTO_UDP (descubrimiento)."
                preguntar_y_correr "Abro los puertos en firewalld" sudo sh -c \
                    "firewall-cmd --permanent --add-port=$PUERTO/tcp --add-port=$PUERTO_UDP/udp && firewall-cmd --reload"
            else
                bien "No hay ufw ni firewalld activos: no hay nada que abrir."
            fi
            ;;
        *) info "Sistema desconocido: si el teléfono no conecta, abrí TCP $PUERTO y UDP $PUERTO_UDP en el firewall." ;;
    esac
}

# ---------------------------------------------------------------------------
# 7. Arranque
# ---------------------------------------------------------------------------

arrancar() {
    local servidor="$AQUI/servidor.py"
    if [ "$SOLO_VERIFICAR" = 1 ]; then
        paso 7 "Diagnóstico del servidor (sin arrancarlo)"
        "$PY" "$servidor" --diagnostico ${ARGS_SERVIDOR[@]+"${ARGS_SERVIDOR[@]}"}
        local codigo=$?
        echo
        if [ "$codigo" = 0 ]; then printf '  %sListo. Para arrancar la detección: ./iniciar.sh%s\n' "$C_OK" "$C_FIN"
        else printf '  %sHay que resolver lo de arriba antes de arrancar.%s\n' "$C_AVISO" "$C_FIN"; fi
        exit "$codigo"
    fi
    paso 7 "Arranque"
    info "Cargando el modelo (unos segundos); el visor se abre solo en el navegador: http://localhost:$PUERTO"
    info "Para cortar: Ctrl+C en esta terminal."
    echo
    exec "$PY" "$servidor" --abrir-visor ${ARGS_SERVIDOR[@]+"${ARGS_SERVIDOR[@]}"}
}

# Así se puede cargar con "source" para probar una función suelta sin correr todo.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main
fi
