"""Software de detección: el proceso que corre en la notebook de campo.

    iniciar.bat                         # doble clic: prepara todo y arranca (Windows)
    ./iniciar.sh                        # lo mismo en Linux / macOS
    iniciar.bat --modelo yolo11m-mix    # los argumentos llegan tal cual a este archivo
    python servidor.py --imgsz 1280 --conf 0.3   # a mano, con un entorno que ya tenga todo

Implementa el contrato de docs/PROTOCOLS.md §4 con la app de control:

  - La app se conecta por WebSocket a ws://<esta-pc>:8765/phone y manda
    `video_frame` (JPEG en base64, 1280 px de ancho, hasta 2 por segundo, con el
    `ts` de captura medido con el reloj del teléfono).
  - Por cada cuadro procesado se le contesta un `detection`, con las cajas en
    coordenadas normalizadas (centro y tamaño, 0..1), el `frameTs` (el `ts` del
    cuadro analizado, devuelto tal cual) y, si detectó algo, la captura anotada
    del cuadro (640 px, JPEG base64) para la alerta:
        {"type": "detection", "detected": true, "classes": ["PERSON"],
         "confidence": 0.81, "boxes": [{"cls": "PERSON", "conf": 0.81,
         "x": 0.52, "y": 0.41, "w": 0.02, "h": 0.05}],
         "snapshotBase64": "...", "ts": 1700000000900, "frameTs": 1700000000000}
  - Para que la app encuentre esta notebook sin tipear IPs, el descubrimiento es
    de ida y vuelta (UDP 8766): cada segundo se anuncia por broadcast en cada
    interfaz de red real, y a cada "hola" que manda la app se le contesta por
    unicast con el mismo anuncio:
        {"service": "dronepatrol-detection", "port": 8765, "name": "<hostname>"}

Además sirve un visor en http://localhost:8765 con el video anotado, el estado
del enlace (IP del teléfono, contadores, errores) y botones para simular una
detección (lo que hacía detection-mock), así la demo completa se corre sin dron.

El modelo corre en un hilo propio con una cola de UN cuadro: si la GPU va más
lenta que el enlace, se tira el cuadro viejo y nunca se acumula retraso. El de
campo es el entrenado en `ml/` (YOLO11m en PERSON / VEHICLE); si no está, se
arranca con el YOLO11m genérico de COCO como respaldo, para que la detección
ande igual (peor) en una máquina recién preparada.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ipaddress
import json
import logging
import math
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from dataclasses import dataclass
from pathlib import Path


def _falta_modulo(nombre: str | None) -> str:
    return (
        f"\nFalta el módulo '{nombre}'.\n\n"
        f"Estás usando este Python:\n  {sys.executable}\n\n"
        "Usá iniciar.bat (o iniciar.sh en Linux/macOS): busca un entorno que\n"
        "tenga todo y, si no hay, lo crea e instala lo que falte.\n"
    )


# Lo liviano se importa acá; torch y ultralytics recién al cargar el modelo
# (`_importar_torch_y_yolo`). Así el módulo se puede importar sin pagar los
# segundos de torch ni tocar la GPU: lo usan las pruebas y el lanzador.
try:
    import cv2
    import numpy as np
    from aiohttp import WSMsgType, web
except ModuleNotFoundError as falta:  # pragma: no cover - mensaje para el operador
    raise SystemExit(_falta_modulo(falta.name))

try:
    import psutil
except ModuleNotFoundError:  # pragma: no cover - entornos viejos, ver listar_interfaces()
    psutil = None


def _importar_torch_y_yolo():
    try:
        import torch
        from ultralytics import YOLO
    except ModuleNotFoundError as falta:  # pragma: no cover - mensaje para el operador
        raise SystemExit(_falta_modulo(falta.name))
    return torch, YOLO


AQUI = Path(__file__).resolve().parent
# El modelo de campo: YOLO11m entrenado directamente en PERSON / VEHICLE (ver
# ml/ y detection/README.md). Si está en modelos/, arranca con él sin preguntar.
MODELO_POR_DEFECTO = "yolo11m-2clases"
# El respaldo: el YOLO11m de COCO que publica Ultralytics. Va en una subcarpeta
# para que no entre en el menú de modelos/ (que lista solo los *.pt de arriba)
# ni le gane al entrenado cuando este aparezca.
MODELO_RESPALDO = "yolo11m.pt"
CARPETA_RESPALDO = AQUI / "modelos" / "respaldo"
PUERTO = 8765
PUERTO_ANUNCIO = 8766
SERVICIO = "dronepatrol-detection"
SERVICIO_APP = "dronepatrol-app"
BROADCAST_LIMITADO = "255.255.255.255"
# El nombre de las reglas que crea iniciar.ps1: el servidor las nombra en sus
# avisos para que el comando que imprime y el del lanzador sean el mismo.
REGLA_FIREWALL = "DronePatrol deteccion"
COLORES = {"PERSON": (80, 200, 80), "VEHICLE": (60, 150, 255)}  # BGR
log = logging.getLogger("deteccion")


class _ConTecho:
    """Deja pasar un aviso cada `cada_s` segundos: un error que se repite en
    cada cuadro (2 por segundo) taparía la consola y no diría nada nuevo."""

    def __init__(self, cada_s: float):
        self.cada_s = cada_s
        self._ultimo = -math.inf

    def puede(self) -> bool:
        ahora = time.monotonic()
        if ahora - self._ultimo < self.cada_s:
            return False
        self._ultimo = ahora
        return True


# ---------------------------------------------------------------------------
# Modelo
# ---------------------------------------------------------------------------

# VisDrone (10 clases): personas a pie y "people" (sentadas, en moto), el resto
# son vehículos, bicicletas incluidas, como agrupó siempre este servidor.
VISDRONE_PERSONAS = {"pedestrian", "people"}
# COCO (80 clases): solo lo que el contrato llama vehículo. Bicicletas, trenes,
# aviones y barcos no son lo que se patrulla, y alertar por ellos sería ruido.
COCO_VEHICULOS = {"car", "truck", "bus", "motorcycle"}


def armar_mapa_de_clases(nombres: dict) -> tuple[dict[int, str], str]:
    """(índice del modelo -> PERSON/VEHICLE, descripción del esquema para el log).

    Los modelos conviven con esquemas de clases distintos y se reconocen por los
    NOMBRES, no por la cantidad: el de 2 clases ya viene agrupado desde el
    entrenamiento, el de VisDrone se agrupa acá, y uno genérico (el de COCO del
    respaldo) se mapea por nombre. Una clase que no queda en el mapa se descarta:
    un perro o un semáforo no son ni persona ni vehículo.
    """
    normalizados = {int(i): str(n).strip().lower() for i, n in nombres.items()}
    valores = set(normalizados.values())
    if valores == {"person", "vehicle"}:
        return {i: n.upper() for i, n in normalizados.items()}, "PERSON/VEHICLE (entrenado en 2 clases)"
    if "pedestrian" in valores:
        mapa = {i: ("PERSON" if n in VISDRONE_PERSONAS else "VEHICLE") for i, n in normalizados.items()}
        return mapa, "VisDrone (10 clases agrupadas en PERSON/VEHICLE)"
    mapa = {}
    for i, n in normalizados.items():
        if n == "person":
            mapa[i] = "PERSON"
        elif n in COCO_VEHICULOS:
            mapa[i] = "VEHICLE"
    descartadas = len(normalizados) - len(mapa)
    return mapa, (
        "COCO (person -> PERSON; car/truck/bus/motorcycle -> VEHICLE; "
        f"se descartan las otras {descartadas} clases)"
    )


class Detector:
    """El modelo cargado y la agrupación de sus clases al contrato."""

    def __init__(self, pesos: Path, imgsz: int, conf: float, device, respaldo: bool = False):
        _, YOLO = _importar_torch_y_yolo()
        self.nombre = Path(pesos).stem
        self.imgsz = imgsz
        self.conf = conf
        self.device = device
        self.respaldo = respaldo
        log.info("Cargando %s …", pesos)
        self.yolo = YOLO(str(pesos))
        self.mapa, self.esquema = armar_mapa_de_clases(self.yolo.names)
        if not self.mapa:
            raise SystemExit(
                f"El modelo {pesos} no tiene ninguna clase que se pueda llevar a PERSON/VEHICLE "
                f"(sus clases: {sorted(set(self.yolo.names.values()))[:12]} …)."
            )
        # Si el mapa deja clases afuera (COCO), se le piden al modelo solo las
        # que sirven: el filtrado ocurre antes de la supresión de no máximos y
        # nadie paga por cajas de perros que después se tirarían.
        self.clases = sorted(self.mapa) if len(self.mapa) < len(self.yolo.names) else None
        self.tiempos: deque[float] = deque(maxlen=30)

    def grupo(self, indice: int) -> str | None:
        return self.mapa.get(indice)

    def _predecir(self, cuadro: np.ndarray):
        return self.yolo.predict(cuadro, imgsz=self.imgsz, conf=self.conf, device=self.device,
                                 classes=self.clases, verbose=False)

    def calentar(self) -> None:
        """La primera inferencia paga la inicialización de CUDA (más de un segundo)."""
        vacio = np.zeros((360, 640, 3), dtype=np.uint8)
        for _ in range(2):
            self._predecir(vacio)

    def detectar(self, cuadro: np.ndarray) -> tuple[dict[str, float], list[tuple[int, int, int, int, str, float]]]:
        """(mejor confianza por clase, cajas en pixeles) de un cuadro BGR."""
        inicio = time.perf_counter()
        resultado = self._predecir(cuadro)[0]
        self.tiempos.append(time.perf_counter() - inicio)
        mejor: dict[str, float] = {}
        cajas = []
        for caja in resultado.boxes:
            grupo = self.grupo(int(caja.cls))
            if grupo is None:
                continue
            confianza = float(caja.conf)
            mejor[grupo] = max(mejor.get(grupo, 0.0), confianza)
            x1, y1, x2, y2 = (int(v) for v in caja.xyxy[0])
            cajas.append((x1, y1, x2, y2, grupo, confianza))
        return mejor, cajas

    @property
    def ms(self) -> float:
        return sum(self.tiempos) / len(self.tiempos) * 1000 if self.tiempos else 0.0


def cajas_normalizadas(cajas, ancho: int, alto: int) -> list[dict]:
    """Las cajas en coordenadas 0..1 (centro y tamaño): valen sobre cualquier
    tamaño del mismo cuadro, que es lo que la app necesita para dibujarlas
    sobre el video de 640 px de la consola y para ubicar el objetivo."""
    return [
        {
            "cls": grupo,
            "conf": round(confianza, 3),
            "x": round((x1 + x2) / 2 / ancho, 4),
            "y": round((y1 + y2) / 2 / alto, 4),
            "w": round((x2 - x1) / ancho, 4),
            "h": round((y2 - y1) / alto, 4),
        }
        for x1, y1, x2, y2, grupo, confianza in cajas
    ]


def ts_del_cuadro(valor) -> int | float | None:
    """El `ts` de un `video_frame` tal como vino, o None si no es un número.

    Se devuelve sin tocar (el contrato dice "tal cual"): es la hora de captura
    con el reloj del TELÉFONO, y la app la usa para buscar en su historial de
    telemetría la pose del dron en ese instante. Cualquier corrección acá (a
    la hora de esta PC, a cero) le haría elegir otra pose sin enterarse. Lo que
    no es un número (falta, texto, booleano, NaN) no se inventa: va como null.
    """
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None
    if isinstance(valor, float) and not math.isfinite(valor):
        return None
    return valor


def mensaje_detection(mejor: dict[str, float], cajas: list[dict] | None = None,
                      snapshot_b64: str | None = None, frame_ts: int | float | None = None) -> dict:
    """La forma exacta del mensaje `detection` del contrato (PROTOCOLS §4)."""
    mensaje = {
        "type": "detection",
        "detected": bool(mejor),
        "classes": sorted(mejor),
        "confidence": round(max(mejor.values()), 3) if mejor else 0.0,
        "boxes": cajas or [],
        # `ts` es la hora de ESTA PC al contestar; `frameTs`, la del teléfono al
        # capturar el cuadro analizado. Entre las dos pasan de 0,3 a 1 s (cola,
        # Wi-Fi, inferencia) en los que el dron se movió: con frameTs la app
        # georreferencia la caja con la pose de cuando se vio, no la de ahora.
        "ts": int(time.time() * 1000),
        "frameTs": frame_ts,
    }
    if snapshot_b64:
        # La captura anotada del cuadro que disparó la detección: es la que la
        # app adjunta a la alerta. Solo cuando hay algo que mostrar.
        mensaje["snapshotBase64"] = snapshot_b64
    return mensaje


def completar_simulada(mensaje: dict, ultimo_frame_ts) -> dict:
    """Una detección de los botones del visor, con lo que trae una de verdad.

    El botón no sabe qué cuadro está mirando la app; el servidor sí: el último
    que llegó. Se la ata a ese `frameTs` para que la app la procese igual que
    una del modelo (misma pose, mismo camino), que es lo que la demo muestra.
    """
    completo = {"boxes": [], **mensaje, "type": "detection"}
    completo.setdefault("ts", int(time.time() * 1000))
    if completo.get("frameTs") is None:
        completo["frameTs"] = ultimo_frame_ts
    return completo


ANCHO_SNAPSHOT = 640


def snapshot_base64(anotado: np.ndarray) -> str:
    """El cuadro anotado reducido al tamaño de la consola, en JPEG base64."""
    # Al menos un pixel de alto: un cuadro muy apaisado (lo que mande un
    # cliente roto) daría 0, y cv2.resize con alto 0 tira una excepción.
    alto = max(1, int(anotado.shape[0] * ANCHO_SNAPSHOT / anotado.shape[1]))
    chico = cv2.resize(anotado, (ANCHO_SNAPSHOT, alto), interpolation=cv2.INTER_AREA)
    ok, jpeg = cv2.imencode(".jpg", chico, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return base64.b64encode(jpeg.tobytes()).decode("ascii") if ok else ""


def dibujar(cuadro: np.ndarray, cajas, etiqueta: str, color_etiqueta=(230, 230, 230)) -> np.ndarray:
    for x1, y1, x2, y2, grupo, confianza in cajas:
        color = COLORES.get(grupo, (200, 200, 200))
        cv2.rectangle(cuadro, (x1, y1), (x2, y2), color, 2)
        cv2.putText(cuadro, f"{grupo} {confianza:.2f}", (x1, max(y1 - 6, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)
    # OpenCV dibuja solo ASCII: un acento en un mensaje de error saldría como
    # "??" en el medio del texto, así que se lo baja a ASCII antes.
    texto = etiqueta.encode("ascii", "replace").decode("ascii")
    cv2.rectangle(cuadro, (0, 0), (cuadro.shape[1], 26), (20, 20, 20), -1)
    cv2.putText(cuadro, texto, (10, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color_etiqueta, 1, cv2.LINE_AA)
    return cuadro


def _sin_captura(mensaje: dict | None) -> dict | None:
    """El `detection` sin la captura: al visor y al estado no les hace falta, y pesa."""
    if mensaje is None:
        return None
    return {k: v for k, v in mensaje.items() if k != "snapshotBase64"}


# ---------------------------------------------------------------------------
# Dispositivo
# ---------------------------------------------------------------------------


def elegir_dispositivo(pedido: str | None, hay_cuda: bool, hay_mps: bool) -> tuple[object, str]:
    """(lo que se le pasa a ultralytics, tipo: "cuda" / "mps" / "cpu").

    Sin pedido se usa lo mejor que haya: la GPU de NVIDIA, la de una Mac con
    Apple Silicon (mps) o la CPU. Un pedido que la máquina no puede cumplir es
    un error y no una caída silenciosa a CPU: el operador cree que va en GPU y
    en realidad cada cuadro tarda segundos.
    """
    p = "" if pedido is None else str(pedido).strip().lower()
    if p in ("", "auto"):
        if hay_cuda:
            return 0, "cuda"
        if hay_mps:
            return "mps", "mps"
        return "cpu", "cpu"
    if p == "cpu":
        return "cpu", "cpu"
    if p == "mps":
        if not hay_mps:
            raise ValueError("Pediste --device mps (GPU de Apple) pero torch no la ve: hace falta una Mac "
                             "con Apple Silicon y torch 2.x.")
        return "mps", "mps"
    if p in ("cuda", "gpu"):
        p = "0"
    if p.startswith("cuda:"):
        p = p[len("cuda:"):]
    if p.isdigit():
        if not hay_cuda:
            raise ValueError("Pediste GPU pero torch no ve ninguna. Revisá que el entorno tenga la versión de "
                             "torch con CUDA (iniciar.bat la instala si hay una NVIDIA) o usá --device cpu.")
        return int(p), "cuda"
    raise ValueError(f"--device {pedido!r} no se entiende: usá cuda, 0, mps o cpu.")


# ---------------------------------------------------------------------------
# Descubrimiento: el anuncio UDP de ida y la respuesta al "hola" de la app
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Interfaz:
    """Una interfaz de red por la que vale la pena anunciarse."""

    nombre: str
    ip: str
    prefijo: int
    broadcast: str | None  # el dirigido de su red; None en /31 y /32, que no tienen


# Adaptadores que no llevan a ningún teléfono: máquinas virtuales, WSL, VPN,
# Bluetooth. En Windows el nombre a veces no lo dice ("Ethernet 2" es el TAP de
# ExpressVPN), por eso se mira también la descripción del adaptador cuando la
# hay. El Wi-Fi Direct ("Local Area Connection* N") NO está: es la interfaz de la
# zona con cobertura móvil de Windows, y el teléfono puede estar colgado de ahí.
_VIRTUAL_EN_EL_TEXTO = (
    "vmware", "virtualbox", "vbox", "vethernet", "hyper-v", "wsl", "vpn", "wintun",
    "wireguard", "tailscale", "zerotier", "hamachi", "docker", "virbr", "loopback",
    "bluetooth", "pseudo-interface", "teredo", "isatap", "miniport", "kernel debug",
)
# TAP y TUN como palabra ("TAP-Windows Adapter", "ExpressVPN TUN Driver"): como
# subcadena se comerían nombres inocentes.
_VIRTUAL_PALABRA = re.compile(r"\b(?:tap|tun)\b", re.IGNORECASE)
# Los nombres cortos de Linux y macOS: lo, tun0, tap0, utun3, wg0, veth…, br-…
# (docker), vmnet8, vboxnet0, awdl0/llw0 (AirDrop), zt… (ZeroTier).
_VIRTUAL_PREFIJO = re.compile(
    r"^(?:lo\d*$|tun\d|tap\d|utun\d|wg\d|veth|br-|vmnet\d|vboxnet\d|awdl\d|llw\d|zt[0-9a-z]{6,}$)",
    re.IGNORECASE,
)


def es_interfaz_virtual(nombre: str, descripcion: str = "") -> bool:
    texto = f"{nombre} {descripcion}".lower()
    if any(clave in texto for clave in _VIRTUAL_EN_EL_TEXTO):
        return True
    if _VIRTUAL_PALABRA.search(texto):
        return True
    return bool(_VIRTUAL_PREFIJO.match(nombre.strip()))


def broadcast_dirigido(ip: str, mascara: str) -> str | None:
    """El broadcast de la red de esa IP con su máscara VERDADERA.

    Suponer /24 fue el error de antes: en una red /22 (192.168.68.0/22, la del
    router de la casa) el broadcast es 192.168.71.255, y 192.168.68.255 es un
    host común que Windows busca por ARP, no encuentra, y el anuncio no sale.
    """
    red = ipaddress.IPv4Interface(f"{ip}/{mascara}").network
    if red.prefixlen >= 31:
        return None
    return str(red.broadcast_address)


def interfaces_para_anunciar(direcciones: dict, estados: dict | None = None,
                             descripciones: dict | None = None) -> tuple[list[Interfaz], list[tuple[str, str, str]]]:
    """(interfaces reales, ignoradas como (nombre, ip, motivo)).

    Recibe lo mismo que devuelven psutil.net_if_addrs() y net_if_stats(), así se
    prueba sin depender de las placas de la máquina que corre las pruebas.
    """
    estados = estados or {}
    descripciones = descripciones or {}
    reales: list[Interfaz] = []
    ignoradas: list[tuple[str, str, str]] = []
    for nombre, lista in direcciones.items():
        estado = estados.get(nombre)
        for d in lista:
            if d.family != socket.AF_INET:
                continue
            try:
                interfaz = ipaddress.IPv4Interface(f"{d.address}/{d.netmask or '32'}")
            except ValueError:
                continue
            ip = interfaz.ip
            # El orden de las preguntas es el del motivo más útil para el log:
            # "virtual" explica más que "sin IP" en un adaptador de VPN apagado.
            if ip.is_loopback:
                motivo = "loopback"
            elif es_interfaz_virtual(nombre, descripciones.get(nombre, "")):
                motivo = "virtual"
            elif estado is not None and not estado.isup:
                # Windows deja la última IP puesta en una placa desenchufada.
                motivo = "desconectada"
            elif ip.is_link_local:
                # 169.254/16: la placa está prendida pero no consiguió IP del
                # DHCP; no hay red ahí (es la Wi-Fi que "conecta" y no anda).
                motivo = "sin IP del DHCP (169.254)"
            else:
                motivo = None
            if motivo:
                ignoradas.append((nombre, str(ip), motivo))
                continue
            reales.append(Interfaz(nombre, str(ip), interfaz.network.prefixlen,
                                   broadcast_dirigido(str(ip), str(interfaz.netmask))))
    return reales, ignoradas


def urls_para_la_app(interfaces: list[Interfaz], puerto: int) -> list[str]:
    """Lo que se escribe en el modo "Dirección manual" de la app (le agrega /phone sola)."""
    return [f"ws://{i.ip}:{puerto}" for i in interfaces]


_PS_ADAPTADORES = (
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
    "Get-NetAdapter -IncludeHidden | Select-Object Name, InterfaceDescription | ConvertTo-Json -Compress"
)


def correr_powershell(script: str, timeout: float) -> str | None:
    """La salida de un comando de PowerShell, o None si no se pudo (no Windows, demora, error)."""
    if sys.platform != "win32":
        return None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    salida = r.stdout.decode("utf-8", errors="replace").lstrip("﻿").strip()
    return salida or None


def _lista_json(salida: str | None) -> list:
    """ConvertTo-Json devuelve un objeto suelto cuando hay uno solo: siempre lista."""
    if not salida:
        return []
    try:
        datos = json.loads(salida)
    except ValueError:
        return []
    if isinstance(datos, dict):
        return [datos]
    return datos if isinstance(datos, list) else []


def descripciones_de_adaptadores() -> dict[str, str]:
    """En Windows, nombre de la conexión -> descripción del adaptador ("Ethernet 2" -> "ExpressVPN TAP Adapter")."""
    filas = _lista_json(correr_powershell(_PS_ADAPTADORES, timeout=15))
    return {str(f["Name"]): str(f.get("InterfaceDescription") or "")
            for f in filas if isinstance(f, dict) and f.get("Name")}


def listar_interfaces(descripciones: dict | None = None) -> tuple[list[Interfaz], list[tuple[str, str, str]]]:
    if psutil is not None:
        return interfaces_para_anunciar(psutil.net_if_addrs(), psutil.net_if_stats(), descripciones)
    # Sin psutil no hay máscaras: en vez de suponer /24 (el error de antes) se
    # anuncia solo al broadcast limitado, pero igual desde cada IP local, que es
    # lo que hace que Windows lo mande por todas las placas.
    try:
        ips = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        ips = []
    return [Interfaz("(sin psutil)", ip, 32, None) for ip in ips if not ip.startswith(("127.", "169.254."))], []


def interpretar_hola(datos: bytes) -> dict | None:
    """El "hola" de la app (`{"service": "dronepatrol-app", "port": 8766, "name": …}`) o None.

    Por ese puerto llega de todo, empezando por los anuncios de este mismo
    servidor (el broadcast vuelve): solo cuenta un objeto JSON con ese service.
    Un puerto que no sirve no descarta el hola: se le contesta al de siempre.
    """
    if len(datos) > 2048:
        return None
    try:
        msg = json.loads(datos.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(msg, dict) or msg.get("service") != SERVICIO_APP:
        return None
    puerto = msg.get("port")
    if isinstance(puerto, bool) or not isinstance(puerto, int) or not 1 <= puerto <= 65535:
        puerto = PUERTO_ANUNCIO
    nombre = msg.get("name")
    nombre = nombre.strip()[:64] if isinstance(nombre, str) else ""
    return {"port": puerto, "name": nombre}


class Descubrimiento:
    """Las dos mitades del descubrimiento de PROTOCOLS §4.

    De ida, cada segundo, un anuncio por CADA interfaz real con un socket atado
    a su IP: así Windows lo saca por esa placa y no solo por la de mejor métrica
    (que con una VPN conectada es la de la VPN). De vuelta, se escucha el "hola"
    que la app manda mientras busca y se le contesta por unicast: el del
    teléfono casi siempre llega aunque el broadcast de la PC se pierda.
    """

    REVISION_S = 5.0  # cada cuánto se vuelven a mirar las placas (Ethernet -> Wi-Fi en el medio)

    def __init__(self, puerto_servicio: int, nombre: str, puerto_udp: int = PUERTO_ANUNCIO):
        self.puerto_servicio = puerto_servicio
        self.puerto_udp = puerto_udp
        self.anuncio = json.dumps({"service": SERVICIO, "port": puerto_servicio, "name": nombre}).encode("utf-8")
        self.interfaces: list[Interfaz] = []
        self.telefonos: dict[str, dict] = {}  # ip -> {"name", "visto" (monotonic)}
        self.escuchando = False
        self._parar = threading.Event()
        self._lock = threading.Lock()
        self._descripciones: dict[str, str] = {}
        self._nombres_consultados: set[str] = set()
        self._descripciones_en = -math.inf
        self._firma: tuple | None = None
        self._errores_avisados: set[tuple[str, str]] = set()

    # ---- interfaces ----

    def revisar_interfaces(self) -> list[Interfaz]:
        """Vuelve a listar las placas y, si cambiaron, lo deja en el log."""
        if sys.platform == "win32" and psutil is not None:
            nombres = set(psutil.net_if_addrs())
            # La descripción sale de PowerShell (un segundo): se pide al arrancar
            # y cuando aparece una placa por la que no se preguntó, no en cada
            # revisión (y como mucho una vez por minuto).
            if nombres - self._nombres_consultados and time.monotonic() - self._descripciones_en > 60:
                self._descripciones = descripciones_de_adaptadores() or self._descripciones
                self._descripciones_en = time.monotonic()
                self._nombres_consultados |= nombres
        interfaces, ignoradas = listar_interfaces(self._descripciones)
        firma = (tuple(interfaces), tuple(ignoradas))
        if firma != self._firma:
            self._firma = firma
            self._loguear(interfaces, ignoradas)
        with self._lock:
            self.interfaces = interfaces
        return interfaces

    def _loguear(self, interfaces: list[Interfaz], ignoradas) -> None:
        if psutil is None:
            log.warning("Sin el módulo psutil no conozco las máscaras de red: el anuncio va solo a %s. "
                        "Instalalo (iniciar.bat lo hace) para que salga también por el broadcast de cada red.",
                        BROADCAST_LIMITADO)
        if not interfaces:
            log.warning("No encontré ninguna interfaz de red real (¿Wi-Fi apagado?): el anuncio va a %s "
                        "por la placa que elija el sistema.", BROADCAST_LIMITADO)
        for i in interfaces:
            destinos = " + ".join(d for d in (i.broadcast, BROADCAST_LIMITADO) if d)
            log.info("Anuncio UDP %d: %s (%s/%d) -> %s", self.puerto_udp, i.nombre, i.ip, i.prefijo, destinos)
        visibles = [(n, ip, m) for n, ip, m in ignoradas if m != "loopback"]
        if visibles:
            log.info("Interfaces ignoradas: %s", ", ".join(f"{n} ({ip}, {m})" for n, ip, m in visibles))

    # ---- hilos ----

    def arrancar(self) -> None:
        threading.Thread(target=self._bucle_anuncio, name="anuncio", daemon=True).start()
        sock = self.abrir_escucha()
        if sock is not None:
            threading.Thread(target=self._bucle_escucha, args=(sock,), name="hola", daemon=True).start()

    def parar(self) -> None:
        self._parar.set()

    def _bucle_anuncio(self) -> None:
        sockets: dict[str, socket.socket] = {}
        suelto = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        suelto.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        revisado = -math.inf
        try:
            while not self._parar.is_set():
                if time.monotonic() - revisado >= self.REVISION_S:
                    revisado = time.monotonic()
                    interfaces = self.revisar_interfaces()
                    self._reconciliar(sockets, interfaces)
                with self._lock:
                    interfaces = list(self.interfaces)
                for i in interfaces:
                    s = sockets.get(i.ip)
                    if s is None:
                        continue
                    for destino in (i.broadcast, BROADCAST_LIMITADO):
                        if destino:
                            self._mandar(s, destino, i)
                if not interfaces:
                    self._mandar(suelto, BROADCAST_LIMITADO, None)
                self._parar.wait(1.0)
        finally:
            suelto.close()
            for s in sockets.values():
                s.close()

    def _reconciliar(self, sockets: dict[str, socket.socket], interfaces: list[Interfaz]) -> None:
        """Un socket atado por IP local: se cierran los de placas que se fueron y se abren los nuevos."""
        vigentes = {i.ip for i in interfaces}
        for ip in list(sockets):
            if ip not in vigentes:
                sockets.pop(ip).close()
        for i in interfaces:
            if i.ip in sockets:
                continue
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            try:
                s.bind((i.ip, 0))
            except OSError as error:
                s.close()
                log.warning("No pude atar el anuncio a %s (%s): %s", i.nombre, i.ip, error)
                continue
            sockets[i.ip] = s

    def _mandar(self, s: socket.socket, destino: str, interfaz: Interfaz | None) -> None:
        try:
            s.sendto(self.anuncio, (destino, self.puerto_udp))
        except OSError as error:
            clave = (interfaz.ip if interfaz else "", destino)
            if clave not in self._errores_avisados:
                self._errores_avisados.add(clave)
                donde = f"{interfaz.nombre} ({interfaz.ip})" if interfaz else "la placa por defecto"
                log.warning("El anuncio por %s a %s falló: %s", donde, destino, error)

    def abrir_escucha(self) -> socket.socket | None:
        """El socket que recibe los "hola" de la app, o None si el puerto no está libre."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        if sys.platform != "win32":
            # En Windows SO_REUSEADDR deja que OTRO proceso se robe el puerto, así
            # que ahí no se pone; en Linux/macOS solo evita el "ocupado" al reiniciar.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", self.puerto_udp))
        except OSError as error:
            sock.close()
            log.warning("No pude escuchar el 'hola' de la app en UDP %d (%s): el descubrimiento queda solo "
                        "de ida (el anuncio por broadcast sigue saliendo).", self.puerto_udp, error)
            return None
        sock.settimeout(1.0)
        self.escuchando = True
        log.info("Escuchando el 'hola' de la app en UDP %d (se le contesta por unicast)", self.puerto_udp)
        return sock

    def _bucle_escucha(self, sock: socket.socket) -> None:
        try:
            while not self._parar.is_set():
                try:
                    datos, (ip, _) = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                except ConnectionResetError:
                    # Windows: si una respuesta unicast encontró el puerto del
                    # teléfono cerrado (cerró la app), el ICMP que vuelve hace
                    # fallar el PRÓXIMO recvfrom. No es un error de esta escucha.
                    continue
                except OSError as error:
                    if self._parar.is_set():
                        break
                    log.warning("Falló la escucha del 'hola': %s", error)
                    self._parar.wait(1.0)
                    continue
                self.atender(sock, datos, ip)
        finally:
            self.escuchando = False
            sock.close()

    def atender(self, sock: socket.socket, datos: bytes, ip: str) -> bool:
        """Contesta un datagrama si es un "hola" de la app. True si contestó."""
        hola = interpretar_hola(datos)
        if hola is None:
            return False
        try:
            sock.sendto(self.anuncio, (ip, hola["port"]))
        except OSError as error:
            log.warning("No pude contestarle a %s:%d: %s", ip, hola["port"], error)
            return False
        self._registrar_telefono(ip, hola)
        return True

    def _registrar_telefono(self, ip: str, hola: dict) -> None:
        ahora = time.monotonic()
        with self._lock:
            anterior = self.telefonos.get(ip)
            self.telefonos[ip] = {"name": hola["name"], "visto": ahora}
        # El hola llega cada 2 s mientras la app busca: se loguea el primero (y
        # el de un teléfono que volvió después de un rato), no cada uno.
        if anterior is None or ahora - anterior["visto"] > 60:
            log.info("Teléfono encontrado: %s (%s) busca la detección; se le contestó por unicast a %s:%d",
                     hola["name"] or "sin nombre", ip, ip, hola["port"])

    def estado(self) -> dict:
        ahora = time.monotonic()
        with self._lock:
            interfaces = list(self.interfaces)
            telefonos = sorted(self.telefonos.items(), key=lambda kv: kv[1]["visto"], reverse=True)
        return {
            "interfaces": [{"nombre": i.nombre, "ip": i.ip, "prefijo": i.prefijo, "broadcast": i.broadcast}
                           for i in interfaces],
            "urls": urls_para_la_app(interfaces, self.puerto_servicio),
            "escuchaHola": self.escuchando,
            "telefonosVistos": [{"ip": ip, "name": t["name"], "haceS": round(ahora - t["visto"])}
                                for ip, t in telefonos[:5]],
        }


# ---------------------------------------------------------------------------
# Arranque: puerto, firewall
# ---------------------------------------------------------------------------


def puerto_ocupado(puerto: int) -> bool:
    """True si ya hay alguien escuchando ese puerto TCP (otra ventana del servidor, el mock)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if sys.platform == "win32":
            # Sin esto Windows deja atar el mismo puerto dos veces y la prueba no prueba nada.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            # En Linux/macOS, para que un servidor recién cerrado (TIME_WAIT) no cuente como ocupado.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", puerto))
        except OSError:
            return True
    # Alguien atado solo a 127.0.0.1 (un `adb forward`, otro servidor local)
    # puede convivir con el bind de arriba y quedarse igual con las conexiones.
    try:
        with socket.create_connection(("127.0.0.1", puerto), timeout=0.3):
            return True
    except OSError:
        return False


def mensaje_puerto_ocupado(puerto: int) -> str:
    quien = (f"netstat -ano | findstr :{puerto}      (el último número es el PID)"
             if sys.platform == "win32" else f"lsof -i :{puerto}")
    return (
        f"\nEl puerto {puerto} ya está en uso: casi seguro hay otro servidor de detección abierto\n"
        "(otra ventana de iniciar.bat / correr.bat, o detection-mock).\n\n"
        "  - Cerrá esa ventana (Ctrl+C) y volvé a arrancar.\n"
        f"  - Para ver qué programa lo tiene:  {quien}\n"
        "  - Si es OTRO programa (no un servidor de detección), arrancá en otro puerto con\n"
        "    --puerto 8770: la app en modo Automático lo encuentra igual, porque el anuncio\n"
        "    lleva el puerto. Con dos servidores de detección abiertos no: los dos se anuncian\n"
        "    y la app saltaría de uno a otro.\n"
    )


PERFILES_ES = {"Domain": "Dominio", "Private": "Privado", "Public": "Público"}
_PERFIL_DE_CATEGORIA = {"private": "Private", "public": "Public", "domainauthenticated": "Domain", "domain": "Domain"}


def _perfiles_de_regla(texto) -> set[str]:
    t = str(texto or "").lower()
    if not t or "any" in t:
        return set(PERFILES_ES)
    return {p for p in PERFILES_ES if p.lower() in t}


def _puerto_en(puertos, puerto: int) -> bool:
    if isinstance(puertos, (str, int)):
        puertos = [puertos]
    for p in puertos or []:
        s = str(p).strip().lower()
        if s == "any":
            return True
        if "-" in s:
            desde, _, hasta = s.partition("-")
            if desde.strip().isdigit() and hasta.strip().isdigit() and int(desde) <= puerto <= int(hasta):
                return True
        elif s.isdigit() and int(s) == puerto:
            return True
    return False


def _protocolo_coincide(texto, protocolo: str) -> bool:
    t = str(texto or "any").strip().lower()
    numeros = {"tcp": "6", "udp": "17"}
    return t in ("any", protocolo.lower(), numeros.get(protocolo.lower(), ""))


def normalizar_ruta(ruta: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.expandvars(str(ruta))))


def rutas_de_programa(*ejecutables: str | None) -> set[str]:
    """Cómo puede nombrar el firewall a este Python: cada ejecutable tal cual y resuelto.

    El Python que baja uv vive detrás de un junction (cpython-3.12-...) y la
    regla que crea el aviso de Windows guarda la ruta real del proceso
    (cpython-3.12.15-...): sin resolverla, ese permiso no contaba.
    """
    return {normalizar_ruta(r) for e in ejecutables if e for r in (e, os.path.realpath(e))}


def _programa_coincide(programa, programas: set[str]) -> bool:
    if not programa or str(programa).strip().lower() == "any":
        return True
    return normalizar_ruta(programa) in programas


def evaluar_firewall(datos: dict, protocolo: str, puerto: int, programas: set[str]) -> dict[str, tuple[str, str]]:
    """Por cada perfil de red ACTIVO: (estado, regla), estado = abierto / bloqueado / cerrado.

    Una regla de entrada cuenta si está habilitada, cubre el perfil, el
    protocolo y el puerto (o es "Any") y el programa es este Python (o "Any").
    Las de BLOQUEO ganan siempre en el Firewall de Windows: un "Cancelar" en el
    aviso de la primera vez deja una que anula cualquier permiso por puerto.
    """
    reglas = datos.get("reglas") or []
    perfiles_fw = datos.get("perfilesFirewall") or []
    apagados = {str(p.get("nombre")) for p in perfiles_fw if not p.get("activo", True)}
    abiertos_por_defecto = {str(p.get("nombre")) for p in perfiles_fw if str(p.get("entrada", "")).lower() == "allow"}
    activos = []
    for red in datos.get("perfilesRed") or []:
        categoria = red.get("categoria") if isinstance(red, dict) else red
        perfil = _PERFIL_DE_CATEGORIA.get(str(categoria).lower())
        if perfil and perfil not in activos:
            activos.append(perfil)
    resultado: dict[str, tuple[str, str]] = {}
    for perfil in activos:
        if perfil in apagados:
            resultado[perfil] = ("abierto", "firewall apagado en este perfil")
            continue
        if perfil in abiertos_por_defecto:
            resultado[perfil] = ("abierto", "el perfil acepta todo lo entrante")
            continue
        aplican = [
            r for r in reglas
            if str(r.get("habilitada")).lower() == "true"
            and str(r.get("direccion", "")).lower() == "inbound"
            and perfil in _perfiles_de_regla(r.get("perfil"))
            and _protocolo_coincide(r.get("protocolo"), protocolo)
            and _puerto_en(r.get("puertos"), puerto)
            and _programa_coincide(r.get("programa"), programas)
        ]
        bloqueo = next((r for r in aplican if str(r.get("accion", "")).lower() == "block"), None)
        permiso = next((r for r in aplican if str(r.get("accion", "")).lower() == "allow"), None)
        if bloqueo:
            resultado[perfil] = ("bloqueado", str(bloqueo.get("nombre", "")))
        elif permiso:
            resultado[perfil] = ("abierto", str(permiso.get("nombre", "")))
        else:
            resultado[perfil] = ("cerrado", "")
    return resultado


def comandos_firewall(puerto_tcp: int, puerto_udp: int) -> list[str]:
    """Los comandos exactos que crean las reglas (los mismos que corre iniciar.ps1)."""
    return [
        f"New-NetFirewallRule -DisplayName '{REGLA_FIREWALL} TCP {puerto_tcp}' -Direction Inbound "
        f"-Action Allow -Protocol TCP -LocalPort {puerto_tcp} -Profile Any",
        f"New-NetFirewallRule -DisplayName '{REGLA_FIREWALL} UDP {puerto_udp}' -Direction Inbound "
        f"-Action Allow -Protocol UDP -LocalPort {puerto_udp} -Profile Any",
    ]


def avisos_de_firewall(tcp: dict[str, tuple[str, str]], udp: dict[str, tuple[str, str]],
                       puerto_tcp: int, puerto_udp: int) -> list[str]:
    """Las líneas que se le muestran al operador; vacía si está todo abierto."""
    lineas: list[str] = []
    bloqueos = {regla for estado, regla in list(tcp.values()) + list(udp.values()) if estado == "bloqueado"}
    for regla in sorted(bloqueos):
        lineas += [
            f"Hay una regla del Firewall de Windows que BLOQUEA a este Python ('{regla}'), y las de bloqueo",
            "ganan a cualquier permiso. Se crea sola al tocar 'Cancelar' en el aviso de la primera vez.",
            "Borrala en 'Firewall de Windows con seguridad avanzada' > Reglas de entrada, o en PowerShell",
            f"como administrador:  Get-NetFirewallRule -DisplayName '{regla}' | "
            "Where-Object Action -eq Block | Remove-NetFirewallRule",
        ]
    cerrados_tcp = [PERFILES_ES.get(p, p) for p, (estado, _) in tcp.items() if estado == "cerrado"]
    cerrados_udp = [PERFILES_ES.get(p, p) for p, (estado, _) in udp.items() if estado == "cerrado"]
    if cerrados_tcp:
        lineas.append(
            f"El Firewall de Windows no deja entrar conexiones al puerto TCP {puerto_tcp} en la red activa "
            f"(perfil {', '.join(cerrados_tcp)}): el teléfono va a encontrar esta PC pero no va a poder conectarse."
        )
    if cerrados_udp:
        lineas.append(
            f"Tampoco entra el 'hola' de la app por UDP {puerto_udp} (perfil {', '.join(cerrados_udp)}): "
            "el descubrimiento queda solo de ida."
        )
    if cerrados_tcp or cerrados_udp:
        lineas.append("Arreglo, en PowerShell como administrador:")
        lineas += [f"    {c}" for c in comandos_firewall(puerto_tcp, puerto_udp)]
        lineas.append("o cerrá esto y corré iniciar.bat, que crea las reglas (pide permiso de administrador).")
    return lineas


def _script_firewall(puertos: list[int]) -> str:
    # Las reglas salen de la API COM del firewall (HNetCfg.FwPolicy2), que las
    # da todas sin ser administrador. Get-NetFirewallPortFilter sin filtro se
    # corta en el primer "Acceso denegado" y pierde las que vienen después, que
    # son las más nuevas: en una notebook leyó 612 de 859 reglas, no vio las de
    # iniciar.bat y avisaba que el 8765 estaba cerrado con las reglas puestas.
    # Solo se traen las candidatas: de entrada, que nombran estos puertos (o un
    # rango) o son de un Python. Las de un servicio o un paquete de la Tienda no
    # tocan a este Python; muchas de la Tienda no nombran programa ni puerto.
    lista = ",".join(f"'{p}'" for p in puertos)
    return (
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n"
        "$ErrorActionPreference = 'SilentlyContinue'\n"
        f"$puertos = @({lista})\n"
        "$reglas = @(foreach ($r in (New-Object -ComObject HNetCfg.FwPolicy2).Rules) {\n"
        "  if ($r.Direction -ne 1 -or $r.ServiceName -or $r.LocalAppPackageId) { continue }\n"
        "  $programa = [string]$r.ApplicationName; $lp = [string]$r.LocalPorts\n"
        "  $lp = @(if (-not $lp -or $lp -eq '*') { 'Any' } else { $lp -split ',' | ForEach-Object { $_.Trim() } })\n"
        "  $nombraPuerto = @($lp | Where-Object { $puertos -contains $_ -or $_ -like '*-*' }).Count -gt 0\n"
        "  if ($programa -notlike '*python*' -and -not ($nombraPuerto -and -not $programa)) { continue }\n"
        "  $bits = [int]$r.Profiles; $enPerfiles = @()\n"
        "  if ($bits -band 1) { $enPerfiles += 'Domain' }; if ($bits -band 2) { $enPerfiles += 'Private' }\n"
        "  if ($bits -band 4) { $enPerfiles += 'Public' }\n"
        "  @{ nombre = [string]$r.Name; habilitada = [string]$r.Enabled; direccion = 'Inbound';"
        " accion = $(if ($r.Action -eq 1) { 'Allow' } else { 'Block' });"
        " perfil = $(if ($enPerfiles.Count -eq 3) { 'Any' } else { $enPerfiles -join ', ' });"
        " protocolo = $(switch ([int]$r.Protocol) { 6 { 'TCP' } 17 { 'UDP' } 256 { 'Any' } default { [string]$r.Protocol } });"
        " puertos = $lp; programa = $(if ($programa) { $programa } else { 'Any' }) }\n"
        "})\n"
        "$redes = @(Get-NetConnectionProfile | ForEach-Object { @{ categoria = [string]$_.NetworkCategory;"
        " nombre = [string]$_.Name; interfaz = [string]$_.InterfaceAlias } })\n"
        "$perfiles = @(Get-NetFirewallProfile | ForEach-Object { @{ nombre = [string]$_.Name;"
        " activo = ([string]$_.Enabled -eq 'True'); entrada = [string]$_.DefaultInboundAction } })\n"
        "ConvertTo-Json -Compress -Depth 4 -InputObject @{ reglas = $reglas; perfilesRed = $redes;"
        " perfilesFirewall = $perfiles }\n"
    )


def _describir_red(red: dict) -> str:
    """'Pupis 6GHz (Privado)': la red como la muestra Windows y su perfil en castellano."""
    perfil = _PERFIL_DE_CATEGORIA.get(str(red.get("categoria")).lower())
    return f"{red.get('nombre') or red.get('interfaz')} ({PERFILES_ES.get(perfil, red.get('categoria'))})"


def _como_lista(valor) -> list:
    if valor is None:
        return []
    return valor if isinstance(valor, list) else [valor]


def revisar_firewall(puerto_tcp: int, puerto_udp: int = PUERTO_ANUNCIO) -> None:
    """En Windows, avisa si el firewall no deja entrar al teléfono en la red activa.

    Es la falla que más tiempo hizo perder en el campo: en la PC todo anda (el
    tráfico local no se filtra), el teléfono encuentra la notebook por el
    anuncio, y la conexión muere en silencio porque Python solo tenía permiso
    en redes Públicas y la Wi-Fi de la casa es Privada.
    """
    if sys.platform != "win32":
        return
    salida = correr_powershell(_script_firewall([puerto_tcp, puerto_udp]), timeout=40)
    try:
        datos = json.loads(salida) if salida else None
    except ValueError:
        datos = None
    if not isinstance(datos, dict):
        log.info("No pude revisar el Firewall de Windows (se sigue igual). Si el teléfono no conecta, mirá el README.")
        return
    datos = {k: _como_lista(datos.get(k)) for k in ("reglas", "perfilesRed", "perfilesFirewall")}
    programas = rutas_de_programa(sys.executable, getattr(sys, "_base_executable", None))
    tcp = evaluar_firewall(datos, "TCP", puerto_tcp, programas)
    udp = evaluar_firewall(datos, "UDP", puerto_udp, programas)
    redes = ", ".join(_describir_red(r) for r in datos["perfilesRed"] if isinstance(r, dict))
    lineas = avisos_de_firewall(tcp, udp, puerto_tcp, puerto_udp)
    if not tcp:
        log.info("Firewall: no hay ninguna red conectada para revisar.")
    elif not lineas:
        reglas = sorted({regla for _, regla in tcp.values() if regla})
        log.info("Firewall: la red activa (%s) deja entrar al teléfono (%s).", redes, "; ".join(reglas))
    else:
        log.warning("Firewall, red activa: %s\n    %s", redes, "\n    ".join(lineas))


def abrir_visor_cuando_responda(puerto: int, espera_s: float = 60.0) -> None:
    """Abre el visor en el navegador recién cuando el servidor contesta (abrirlo antes da una página de error)."""
    hasta = time.monotonic() + espera_s
    while time.monotonic() < hasta:
        try:
            with socket.create_connection(("127.0.0.1", puerto), timeout=0.5):
                break
        except OSError:
            time.sleep(0.5)
    else:
        return
    url = f"http://localhost:{puerto}"
    if not webbrowser.open(url):
        log.info("Abrí %s en el navegador para ver el visor.", url)


# ---------------------------------------------------------------------------
# Servidor
# ---------------------------------------------------------------------------


class Servidor:
    def __init__(self, detector: Detector | None, descubrimiento: Descubrimiento | None = None,
                 dispositivo: str | None = None):
        self.detector = detector
        self.descubrimiento = descubrimiento
        self.dispositivo = dispositivo
        self.telefono: web.WebSocketResponse | None = None
        self.telefono_ip: str | None = None
        self.visores: set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        # Cola de un solo lugar entre el socket y el hilo del modelo
        self._pendiente: tuple[np.ndarray, int | float | None] | None = None
        self._hay = threading.Condition()
        self._parar = threading.Event()
        self._tarea_stats: asyncio.Task | None = None
        self.recibidos = 0
        self.procesados = 0
        self.descartados = 0
        self.errores = 0
        self.ultimo_error: str | None = None
        self.ultimo_frame_ts: int | float | None = None
        self._ultimo_cuadro_en: float | None = None
        self.ultima_deteccion: dict | None = None
        self._techo_error = _ConTecho(10.0)

    # ---- HTTP / WS ----

    def app(self) -> web.Application:
        app = web.Application(client_max_size=4 * 1024 * 1024)
        app.router.add_get("/", self.pagina)
        app.router.add_get("/phone", self.ws_telefono)
        app.router.add_get("/viewer", self.ws_visor)
        app.router.add_get("/api/estado", self.estado)
        app.on_startup.append(self._al_arrancar)
        app.on_cleanup.append(self._al_cerrar)
        return app

    async def _al_arrancar(self, app: web.Application) -> None:
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self._inferir, name="modelo", daemon=True).start()
        self._tarea_stats = asyncio.create_task(self._stats_periodicas())

    async def _al_cerrar(self, app: web.Application) -> None:
        self._parar.set()
        with self._hay:
            self._hay.notify_all()
        if self._tarea_stats is not None:
            self._tarea_stats.cancel()

    async def _stats_periodicas(self) -> None:
        """Las estadísticas al visor una vez por segundo, pase lo que pase con el modelo.

        Antes salían solo detrás de una inferencia exitosa: si los cuadros
        llegaban pero el decodificado o el modelo fallaban, el visor quedaba en
        cero y negro, igual que si no llegara nada. Ahora "llega y falla" y "no
        llega" se ven distintos.
        """
        while True:
            await asyncio.sleep(1.0)
            if self.visores:
                await self._a_visores({"type": "stats", **self._estado()})

    async def pagina(self, request: web.Request) -> web.Response:
        return web.Response(text=(AQUI / "visor.html").read_text(encoding="utf-8"), content_type="text/html")

    async def estado(self, request: web.Request) -> web.Response:
        return web.json_response(self._estado())

    def telefono_conectado(self) -> bool:
        return self.telefono is not None and not self.telefono.closed

    def _estado(self) -> dict:
        d = self.detector
        estado = {
            "telefono": self.telefono_conectado(),
            "telefonoIp": self.telefono_ip if self.telefono_conectado() else None,
            "modelo": d.nombre if d else None,
            "esquema": d.esquema if d else None,
            "respaldo": d.respaldo if d else False,
            "dispositivo": self.dispositivo,
            "imgsz": d.imgsz if d else None,
            "ms": round(d.ms, 1) if d else None,
            "recibidos": self.recibidos,
            "procesados": self.procesados,
            "descartados": self.descartados,
            "errores": self.errores,
            "ultimoError": self.ultimo_error,
            "ultimoCuadroHaceS": (round(time.monotonic() - self._ultimo_cuadro_en, 1)
                                  if self._ultimo_cuadro_en is not None else None),
            "ultima": self.ultima_deteccion,
        }
        if self.descubrimiento is not None:
            estado.update(self.descubrimiento.estado())
        return estado

    async def ws_telefono(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=4 * 1024 * 1024, heartbeat=20)
        await ws.prepare(request)
        if self.telefono_conectado():
            # Un dron por notebook: el nuevo reemplaza al viejo (reconexión)
            await self.telefono.close()
        self.telefono = ws
        self.telefono_ip = request.remote
        log.info("Celular conectado desde %s", request.remote)
        await self._a_visores({"type": "phone_status", "connected": True, "ip": request.remote})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    datos = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(datos, dict) and datos.get("type") == "video_frame":
                    self._encolar(datos.get("jpegBase64") or "", ts_del_cuadro(datos.get("ts")))
        finally:
            if self.telefono is ws:
                self.telefono = None
            log.info("Celular desconectado (%s)", request.remote)
            await self._a_visores({"type": "phone_status", "connected": self.telefono_conectado(),
                                   "ip": self.telefono_ip if self.telefono_conectado() else None})
        return ws

    async def ws_visor(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.visores.add(ws)
        await ws.send_json({"type": "phone_status", "connected": self.telefono_conectado(),
                            "ip": self.telefono_ip if self.telefono_conectado() else None})
        await ws.send_json({"type": "stats", **self._estado()})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    datos = json.loads(msg.data)
                except ValueError:
                    continue
                # Los botones del visor simulan una detección, como el mock
                if isinstance(datos, dict) and datos.get("type") == "detection":
                    await self._al_telefono(completar_simulada(datos, self.ultimo_frame_ts))
        finally:
            self.visores.discard(ws)
        return ws

    async def _al_telefono(self, mensaje: dict) -> None:
        ws = self.telefono
        if ws is not None and not ws.closed:
            try:
                await ws.send_json(mensaje)
            except (ConnectionResetError, RuntimeError):
                pass

    async def _a_visores(self, mensaje: dict) -> None:
        muertos = []
        for ws in list(self.visores):
            try:
                await ws.send_json(mensaje)
            except (ConnectionResetError, RuntimeError):
                muertos.append(ws)
        for ws in muertos:
            self.visores.discard(ws)

    # ---- Modelo ----

    def _anotar_error(self, texto: str) -> None:
        self.errores += 1
        self.ultimo_error = texto

    def _encolar(self, jpeg_b64: str, ts: int | float | None) -> None:
        self.recibidos += 1
        self._ultimo_cuadro_en = time.monotonic()
        self.ultimo_frame_ts = ts
        try:
            bytes_ = base64.b64decode(jpeg_b64)
            cuadro = cv2.imdecode(np.frombuffer(bytes_, dtype=np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            cuadro = None
        if cuadro is None:
            self._anotar_error("cuadro ilegible: el video_frame no trae un JPEG válido")
            if self._techo_error.puede():
                log.warning("Llegó un cuadro que no es un JPEG válido (van %d errores)", self.errores)
            return
        with self._hay:
            if self._pendiente is not None:
                self.descartados += 1
            self._pendiente = (cuadro, ts)
            self._hay.notify()

    def _inferir(self) -> None:
        """Hilo del modelo: toma el último cuadro, infiere, publica."""
        while not self._parar.is_set():
            with self._hay:
                while self._pendiente is None and not self._parar.is_set():
                    self._hay.wait(1.0)
                if self._pendiente is None:
                    break
                cuadro, ts = self._pendiente
                self._pendiente = None
            try:
                al_telefono, al_visor = self.procesar(cuadro, ts)
            except Exception as error:
                # `procesar` ya atrapa lo que falle en el modelo; esto es para lo
                # de alrededor (dibujar, comprimir la captura). Si una excepción
                # se escapara de acá, este hilo moriría callado y la detección
                # quedaría parada para siempre: los cuadros seguirían llegando
                # (Recibidos sube) y ninguno se procesaría.
                self._anotar_error(f"procesando el cuadro: {error}")
                if self._techo_error.puede():
                    log.exception("Falló el procesamiento de un cuadro (van %d errores)", self.errores)
                continue
            if self.loop is not None:
                asyncio.run_coroutine_threadsafe(self._publicar(al_telefono, al_visor), self.loop)

    def procesar(self, cuadro: np.ndarray, ts: int | float | None) -> tuple[dict | None, dict]:
        """(el `detection` para el teléfono o None, el cuadro para los visores).

        Si la inferencia falla, al teléfono no va nada (un "no detecté" sería
        mentira) y al visor va el cuadro CRUDO con el error escrito encima: así
        se ve que el video llega y que lo que falla es el modelo.
        """
        alto, ancho = cuadro.shape[:2]
        if self.detector is None:
            mejor, cajas = {}, []
            etiqueta = "sin modelo"
        else:
            try:
                mejor, cajas = self.detector.detectar(cuadro)
            except Exception as error:
                self._anotar_error(f"inferencia: {error}")
                if self._techo_error.puede():
                    log.exception("Falló la inferencia de un cuadro (van %d errores)", self.errores)
                crudo = dibujar(cuadro, [], f"ERROR DE INFERENCIA: {error}"[:110], (90, 90, 255))
                return None, self._cuadro_al_visor(crudo, ts, None, error=str(error))
            etiqueta = f"{self.detector.nombre}  {self.detector.ms:.0f} ms  imgsz {self.detector.imgsz}"
        self.procesados += 1
        anotado = dibujar(cuadro, cajas, etiqueta)
        mensaje = mensaje_detection(
            mejor,
            cajas_normalizadas(cajas, ancho, alto),
            snapshot_base64(anotado) if mejor else None,
            frame_ts=ts,
        )
        if mejor:
            self.ultima_deteccion = _sin_captura(mensaje)
        return mensaje, self._cuadro_al_visor(anotado, ts, _sin_captura(mensaje))

    @staticmethod
    def _cuadro_al_visor(imagen: np.ndarray, ts, deteccion: dict | None, error: str | None = None) -> dict:
        ok, jpeg = cv2.imencode(".jpg", imagen, [cv2.IMWRITE_JPEG_QUALITY, 70])
        visor = {
            "type": "video_frame",
            "jpegBase64": base64.b64encode(jpeg.tobytes()).decode("ascii") if ok else "",
            "ts": ts,
            "detection": deteccion,
        }
        if error is not None:
            visor["error"] = error
        return visor

    async def _publicar(self, al_telefono: dict | None, al_visor: dict) -> None:
        if al_telefono is not None:
            await self._al_telefono(al_telefono)
        await self._a_visores(al_visor)


# ---------------------------------------------------------------------------
# Arranque
# ---------------------------------------------------------------------------


def modelos_disponibles(carpeta: Path) -> list[Path]:
    return sorted(carpeta.glob("*.pt"))


def ruta_del_respaldo() -> Path:
    """Dónde está (o adónde va a bajar) el YOLO11m de COCO.

    Si el repo tiene el de ml/ (el que se usó de base para entrenar), se usa
    ese y no se baja nada; si no, ultralytics lo baja a modelos/respaldo/.
    """
    propio = CARPETA_RESPALDO / MODELO_RESPALDO
    if propio.exists():
        return propio
    del_repo = AQUI.parent / "ml" / MODELO_RESPALDO
    if del_repo.exists():
        return del_repo
    CARPETA_RESPALDO.mkdir(parents=True, exist_ok=True)
    return propio


def elegir_modelo(args: argparse.Namespace) -> tuple[Path, bool]:
    """(pesos, es el respaldo de COCO)."""
    if args.pesos:
        return Path(args.pesos), False
    candidatos = modelos_disponibles(AQUI / "modelos")
    if args.modelo:
        for p in candidatos:
            if p.stem == args.modelo:
                return p, False
        raise SystemExit(f"No existe modelos/{args.modelo}.pt. Hay: {[p.stem for p in candidatos]}")
    if not candidatos:
        return ruta_del_respaldo(), True
    if len(candidatos) == 1:
        return candidatos[0], False
    # El de campo es el de dos clases: si está, va sin preguntar.
    for p in candidatos:
        if p.stem == MODELO_POR_DEFECTO:
            return p, False
    print("\nModelos disponibles:")
    for i, p in enumerate(candidatos, start=1):
        print(f"  {i}) {p.stem}")
    try:
        elegido = input(f"\n¿Cuál corro? [1-{len(candidatos)}, Enter = 1]: ").strip()
    except EOFError:
        elegido = ""
    if elegido.isdigit() and 1 <= int(elegido) <= len(candidatos):
        return candidatos[int(elegido) - 1], False
    return candidatos[0], False


def _nombre_del_equipo(torch, device, tipo: str) -> str:
    if tipo == "cuda":
        return torch.cuda.get_device_name(device)
    if tipo == "mps":
        return "GPU de Apple (mps)"
    return "CPU"


def _consola_tolerante() -> None:
    """Que un carácter que la consola no sabe escribir no tumbe un log (consolas viejas de Windows)."""
    for flujo in (sys.stdout, sys.stderr):
        try:
            flujo.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def cargar_detector(args: argparse.Namespace) -> tuple[Detector, str]:
    torch, _ = _importar_torch_y_yolo()
    pesos, respaldo = elegir_modelo(args)
    hay_mps = bool(getattr(torch.backends, "mps", None)) and torch.backends.mps.is_available()
    try:
        device, tipo = elegir_dispositivo(args.device, torch.cuda.is_available(), hay_mps)
    except ValueError as error:
        raise SystemExit(str(error))
    if respaldo:
        log.warning(
            "No hay ningún modelo entrenado en %s: se usa el de RESPALDO %s (YOLO11m genérico de COCO%s). "
            "Detecta bastante peor desde el aire que el entrenado. Copiá yolo11m-2clases.pt a esa carpeta "
            "(iniciar.bat lo busca y lo copia solo).",
            AQUI / "modelos", pesos, "" if pesos.exists() else "; ultralytics lo baja la primera vez, ~40 MB",
        )
    try:
        detector = Detector(pesos, args.imgsz, args.conf, device, respaldo=respaldo)
    except SystemExit:
        raise
    except Exception as error:
        if respaldo:
            raise SystemExit(
                f"No hay modelo entrenado y no pude cargar (ni bajar) el de respaldo: {error}\n"
                f"Copiá yolo11m-2clases.pt a {AQUI / 'modelos'}, o arrancá con --sin-modelo para usar solo el visor."
            )
        raise
    detector.calentar()
    equipo = _nombre_del_equipo(torch, device, tipo)
    log.info("Modelo %s listo en %s (imgsz %d, conf %.2f)", detector.nombre, equipo, args.imgsz, args.conf)
    log.info("Clases: %s%s", detector.esquema, "  [RESPALDO]" if respaldo else "  [entrenado]")
    if tipo == "cpu" and args.imgsz > 640:
        log.warning("En CPU, YOLO11m a imgsz %d tarda segundos por cuadro: probá --imgsz 640 (ve menos de "
                    "lejos, pero contesta a tiempo).", args.imgsz)
    return detector, equipo


def diagnosticar(puerto: int) -> int:
    """Red, puerto y firewall, sin cargar el modelo ni arrancar nada (`--diagnostico`).

    Es lo que muestran los lanzadores en modo verificación: así la lógica que
    decide por dónde se anuncia y si el firewall deja entrar vive en un solo
    lugar (este, el que tiene pruebas) y no repetida en PowerShell y en bash.
    Devuelve el código de salida: 2 si el puerto está ocupado, 0 si no.
    """
    interfaces = Descubrimiento(puerto, socket.gethostname()).revisar_interfaces()
    urls = urls_para_la_app(interfaces, puerto)
    if urls:
        log.info("Para el modo 'Dirección manual' de la app: %s", "  o  ".join(urls))
    revisar_firewall(puerto)
    if puerto_ocupado(puerto):
        log.error(mensaje_puerto_ocupado(puerto))
        return 2
    log.info("El puerto %d está libre: el servidor puede arrancar.", puerto)
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--modelo", help="Nombre del .pt en modelos/ (sin extensión)")
    parser.add_argument("--pesos", help="Ruta a un .pt cualquiera")
    parser.add_argument("--imgsz", type=int, default=1280,
                        help="Resolución de inferencia. Los cuadros llegan a 1280 px; 1536 detecta un poco más y cuesta más")
    parser.add_argument("--conf", type=float, default=0.35)
    parser.add_argument("--device", default=None, help="cuda (o 0), mps (Mac) o cpu. Por defecto, el mejor que haya")
    parser.add_argument("--puerto", type=int, default=PUERTO)
    parser.add_argument("--sin-anuncio", action="store_true",
                        help="Sin descubrimiento UDP (ni anuncio ni respuesta al 'hola'): solo modo manual")
    parser.add_argument("--sin-modelo", action="store_true", help="Solo visor y botones (como el mock), sin inferencia")
    parser.add_argument("--sin-revisar-firewall", action="store_true", help="No revisar el Firewall de Windows al arrancar")
    parser.add_argument("--abrir-visor", action="store_true", help="Abrir el visor en el navegador cuando el servidor esté listo")
    parser.add_argument("--diagnostico", action="store_true",
                        help="Solo revisar red, puerto y firewall, y salir (sin cargar el modelo)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    _consola_tolerante()
    if args.diagnostico:
        raise SystemExit(diagnosticar(args.puerto))

    # Primero lo que falla rápido: no tiene sentido cargar el modelo diez
    # segundos para enterarse al final de que el puerto lo tiene otra ventana.
    if puerto_ocupado(args.puerto):
        log.error(mensaje_puerto_ocupado(args.puerto))
        raise SystemExit(2)
    if not args.sin_revisar_firewall:
        # En paralelo con la carga del modelo: PowerShell tarda unos segundos.
        threading.Thread(target=revisar_firewall, args=(args.puerto,), name="firewall", daemon=True).start()

    descubrimiento = None if args.sin_anuncio else Descubrimiento(args.puerto, socket.gethostname())
    if descubrimiento is not None:
        descubrimiento.revisar_interfaces()

    detector, equipo = (None, None) if args.sin_modelo else cargar_detector(args)

    if descubrimiento is not None:
        # Recién ahora: anunciarse antes de poder atender haría que la app
        # pruebe, falle y le diga al operador que revise el firewall.
        descubrimiento.arrancar()
        urls = urls_para_la_app(descubrimiento.interfaces, args.puerto)
    else:
        urls = urls_para_la_app(listar_interfaces()[0], args.puerto)
    servidor = Servidor(detector, descubrimiento, equipo)
    log.info("Visor en http://localhost:%d  ·  la app se conecta a ws://<esta-pc>:%d/phone", args.puerto, args.puerto)
    if urls:
        log.info("Para el modo 'Dirección manual' de la app: %s", "  o  ".join(urls))
    if args.abrir_visor:
        threading.Thread(target=abrir_visor_cuando_responda, args=(args.puerto,), name="navegador", daemon=True).start()
    try:
        web.run_app(servidor.app(), host="0.0.0.0", port=args.puerto, print=None)
    finally:
        if descubrimiento is not None:
            descubrimiento.parar()


if __name__ == "__main__":
    main()
