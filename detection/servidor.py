"""Software de detección: el proceso que corre en la notebook de campo.

    correr.bat                          # modelo por menú (o el único que haya)
    correr.bat --modelo yolo11m-mix     # directo
    correr.bat --imgsz 1280 --conf 0.3

Implementa el contrato de docs/PROTOCOLS.md §4 con la app de control:

  - La app se conecta por WebSocket a ws://<esta-pc>:8765/phone y manda
    `video_frame` (JPEG en base64, 1280 px de ancho, hasta 2 por segundo).
  - Por cada cuadro procesado se le contesta un `detection`:
        {"type": "detection", "detected": true, "classes": ["PERSON"],
         "confidence": 0.81, "ts": 1700000000000}
  - Y para que la app encuentre esta notebook sin tipear IPs, cada segundo se
    anuncia por UDP a toda la red (puerto 8766):
        {"service": "dronepatrol-detection", "port": 8765, "name": "<hostname>"}

Además sirve un visor en http://localhost:8765 con el video anotado, el estado
del enlace y los tiempos del modelo, y botones para simular una detección (lo
que hacía detection-mock), así la demo completa se puede correr sin dron.

El modelo corre en un hilo propio con una cola de UN cuadro: si la GPU va más
lenta que el enlace, se tira el cuadro viejo y nunca se acumula retraso. Los
modelos son los entrenados en `ml/` (YOLO11 sobre VisDrone); las 10 clases se
agrupan en PERSON / VEHICLE acá si el modelo no viene ya agrupado.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import socket
import sys
import threading
import time
from collections import deque
from pathlib import Path

try:
    import cv2
    import numpy as np
    import torch
    from aiohttp import WSMsgType, web
    from ultralytics import YOLO
except ModuleNotFoundError as falta:  # pragma: no cover - mensaje para el operador
    raise SystemExit(
        f"\nFalta el módulo '{falta.name}'.\n\n"
        f"Estás usando este Python:\n  {sys.executable}\n\n"
        "Usá correr.bat, que elige el entorno correcto solo, o instalá las\n"
        "dependencias en el tuyo:\n\n"
        "    pip install -r requirements.txt\n"
    )

AQUI = Path(__file__).parent
PUERTO = 8765
PUERTO_ANUNCIO = 8766
SERVICIO = "dronepatrol-detection"
COLORES = {"PERSON": (80, 200, 80), "VEHICLE": (60, 150, 255)}  # BGR
log = logging.getLogger("deteccion")


# ---------------------------------------------------------------------------
# Modelo
# ---------------------------------------------------------------------------


class Detector:
    """El modelo cargado y la agrupación de sus clases al contrato."""

    def __init__(self, pesos: Path, imgsz: int, conf: float, device):
        self.nombre = pesos.stem
        self.imgsz = imgsz
        self.conf = conf
        self.device = device
        log.info("Cargando %s …", pesos)
        self.yolo = YOLO(str(pesos))
        nombres = {str(v).upper() for v in self.yolo.names.values()}
        # Los modelos conviven con esquemas de clases distintos: el de 10 clases
        # de VisDrone hay que agruparlo acá, el de 2 ya viene agrupado desde el
        # entrenamiento. Se decide por los nombres, no por la cantidad.
        self.ya_agrupado = nombres == {"PERSON", "VEHICLE"}
        self.tiempos: deque[float] = deque(maxlen=30)

    def grupo(self, indice: int) -> str:
        if self.ya_agrupado:
            return str(self.yolo.names[indice]).upper()
        return "PERSON" if indice in (0, 1) else "VEHICLE"

    def calentar(self) -> None:
        """La primera inferencia paga la inicialización de CUDA (más de un segundo)."""
        vacio = np.zeros((360, 640, 3), dtype=np.uint8)
        for _ in range(2):
            self.yolo.predict(vacio, imgsz=self.imgsz, conf=self.conf, device=self.device, verbose=False)

    def detectar(self, cuadro: np.ndarray) -> tuple[dict[str, float], list[tuple[int, int, int, int, str, float]]]:
        """(mejor confianza por clase, cajas) de un cuadro BGR."""
        inicio = time.perf_counter()
        resultado = self.yolo.predict(cuadro, imgsz=self.imgsz, conf=self.conf, device=self.device, verbose=False)[0]
        self.tiempos.append(time.perf_counter() - inicio)
        mejor: dict[str, float] = {}
        cajas = []
        for caja in resultado.boxes:
            grupo = self.grupo(int(caja.cls))
            confianza = float(caja.conf)
            mejor[grupo] = max(mejor.get(grupo, 0.0), confianza)
            x1, y1, x2, y2 = (int(v) for v in caja.xyxy[0])
            cajas.append((x1, y1, x2, y2, grupo, confianza))
        return mejor, cajas

    @property
    def ms(self) -> float:
        return sum(self.tiempos) / len(self.tiempos) * 1000 if self.tiempos else 0.0


def mensaje_detection(mejor: dict[str, float]) -> dict:
    """La forma exacta del mensaje `detection` del contrato."""
    return {
        "type": "detection",
        "detected": bool(mejor),
        "classes": sorted(mejor),
        "confidence": round(max(mejor.values()), 3) if mejor else 0.0,
        "ts": int(time.time() * 1000),
    }


def dibujar(cuadro: np.ndarray, cajas, etiqueta: str) -> np.ndarray:
    for x1, y1, x2, y2, grupo, confianza in cajas:
        color = COLORES.get(grupo, (200, 200, 200))
        cv2.rectangle(cuadro, (x1, y1), (x2, y2), color, 2)
        cv2.putText(cuadro, f"{grupo} {confianza:.2f}", (x1, max(y1 - 6, 14)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)
    cv2.rectangle(cuadro, (0, 0), (cuadro.shape[1], 26), (20, 20, 20), -1)
    cv2.putText(cuadro, etiqueta, (10, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (230, 230, 230), 1, cv2.LINE_AA)
    return cuadro


# ---------------------------------------------------------------------------
# Descubrimiento: el anuncio UDP
# ---------------------------------------------------------------------------


def direcciones_de_broadcast() -> list[str]:
    """255.255.255.255 más el broadcast dirigido de cada IP local (/24).

    Windows no siempre manda el broadcast limitado por todas las interfaces;
    con el dirigido de cada red llega aunque la notebook tenga Wi-Fi y
    Ethernet a la vez.
    """
    destinos = {"255.255.255.255"}
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            partes = ip.split(".")
            if len(partes) == 4 and not ip.startswith("127."):
                destinos.add(".".join(partes[:3] + ["255"]))
    except OSError:
        pass
    return sorted(destinos)


def anunciar(puerto: int, nombre: str, parar: threading.Event) -> None:
    """Hilo que anuncia el servicio cada segundo mientras el servidor viva."""
    anuncio = json.dumps({"service": SERVICIO, "port": puerto, "name": nombre}).encode("utf-8")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while not parar.is_set():
            for destino in direcciones_de_broadcast():
                try:
                    s.sendto(anuncio, (destino, PUERTO_ANUNCIO))
                except OSError:
                    pass
            parar.wait(1.0)


# ---------------------------------------------------------------------------
# Servidor
# ---------------------------------------------------------------------------


class Servidor:
    def __init__(self, detector: Detector | None):
        self.detector = detector
        self.telefono: web.WebSocketResponse | None = None
        self.visores: set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        # Cola de un solo lugar entre el socket y el hilo del modelo
        self._pendiente: tuple[np.ndarray, int] | None = None
        self._hay = threading.Condition()
        self.recibidos = 0
        self.procesados = 0
        self.descartados = 0
        self.ultima_deteccion: dict | None = None

    # ---- HTTP / WS ----

    def app(self) -> web.Application:
        app = web.Application(client_max_size=4 * 1024 * 1024)
        app.router.add_get("/", self.pagina)
        app.router.add_get("/phone", self.ws_telefono)
        app.router.add_get("/viewer", self.ws_visor)
        app.router.add_get("/api/estado", self.estado)
        app.on_startup.append(self._al_arrancar)
        return app

    async def _al_arrancar(self, app: web.Application) -> None:
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self._inferir, name="modelo", daemon=True).start()

    async def pagina(self, request: web.Request) -> web.Response:
        return web.Response(text=(AQUI / "visor.html").read_text(encoding="utf-8"), content_type="text/html")

    async def estado(self, request: web.Request) -> web.Response:
        return web.json_response(self._estado())

    def _estado(self) -> dict:
        return {
            "telefono": self.telefono is not None and not self.telefono.closed,
            "modelo": self.detector.nombre if self.detector else None,
            "imgsz": self.detector.imgsz if self.detector else None,
            "ms": round(self.detector.ms, 1) if self.detector else None,
            "recibidos": self.recibidos,
            "procesados": self.procesados,
            "descartados": self.descartados,
            "ultima": self.ultima_deteccion,
        }

    async def ws_telefono(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=4 * 1024 * 1024, heartbeat=20)
        await ws.prepare(request)
        if self.telefono is not None and not self.telefono.closed:
            # Un dron por notebook: el nuevo reemplaza al viejo (reconexión)
            await self.telefono.close()
        self.telefono = ws
        log.info("Celular conectado desde %s", request.remote)
        await self._a_visores({"type": "phone_status", "connected": True})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    datos = json.loads(msg.data)
                except ValueError:
                    continue
                if datos.get("type") == "video_frame":
                    self._encolar(datos.get("jpegBase64", ""), int(datos.get("ts") or 0))
        finally:
            if self.telefono is ws:
                self.telefono = None
            log.info("Celular desconectado")
            await self._a_visores({"type": "phone_status", "connected": False})
        return ws

    async def ws_visor(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.visores.add(ws)
        await ws.send_json({"type": "phone_status", "connected": self.telefono is not None and not self.telefono.closed})
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
                if datos.get("type") == "detection":
                    await self._al_telefono(datos)
        finally:
            self.visores.discard(ws)
        return ws

    async def _al_telefono(self, mensaje: dict) -> None:
        ws = self.telefono
        if ws is not None and not ws.closed:
            try:
                await ws.send_json(mensaje)
            except ConnectionResetError:
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

    def _encolar(self, jpeg_b64: str, ts: int) -> None:
        self.recibidos += 1
        try:
            bytes_ = base64.b64decode(jpeg_b64)
            cuadro = cv2.imdecode(np.frombuffer(bytes_, dtype=np.uint8), cv2.IMREAD_COLOR)
        except Exception:
            return
        if cuadro is None:
            return
        with self._hay:
            if self._pendiente is not None:
                self.descartados += 1
            self._pendiente = (cuadro, ts)
            self._hay.notify()

    def _inferir(self) -> None:
        """Hilo del modelo: toma el último cuadro, infiere, publica."""
        while True:
            with self._hay:
                while self._pendiente is None:
                    self._hay.wait()
                cuadro, ts = self._pendiente
                self._pendiente = None
            if self.detector is None:
                mejor, cajas = {}, []
            else:
                try:
                    mejor, cajas = self.detector.detectar(cuadro)
                except Exception:
                    log.exception("Falló la inferencia de un cuadro")
                    continue
            self.procesados += 1
            mensaje = mensaje_detection(mejor)
            self.ultima_deteccion = mensaje if mensaje["detected"] else self.ultima_deteccion
            etiqueta = (
                f"{self.detector.nombre}  {self.detector.ms:.0f} ms  imgsz {self.detector.imgsz}"
                if self.detector else "sin modelo"
            )
            anotado = dibujar(cuadro, cajas, etiqueta)
            ok, jpeg = cv2.imencode(".jpg", anotado, [cv2.IMWRITE_JPEG_QUALITY, 70])
            visor = {
                "type": "video_frame",
                "jpegBase64": base64.b64encode(jpeg.tobytes()).decode("ascii") if ok else "",
                "ts": ts,
                "detection": mensaje,
            }
            if self.loop is not None:
                asyncio.run_coroutine_threadsafe(self._publicar(mensaje, visor), self.loop)

    async def _publicar(self, al_telefono: dict, al_visor: dict) -> None:
        await self._al_telefono(al_telefono)
        await self._a_visores(al_visor)
        await self._a_visores({"type": "stats", **self._estado()})


# ---------------------------------------------------------------------------
# Arranque
# ---------------------------------------------------------------------------


def modelos_disponibles(carpeta: Path) -> list[Path]:
    return sorted(carpeta.glob("*.pt"))


def elegir_modelo(args: argparse.Namespace) -> Path | None:
    if args.pesos:
        return Path(args.pesos)
    candidatos = modelos_disponibles(AQUI / "modelos")
    if args.modelo:
        for p in candidatos:
            if p.stem == args.modelo:
                return p
        raise SystemExit(f"No existe modelos/{args.modelo}.pt. Hay: {[p.stem for p in candidatos]}")
    if not candidatos:
        return None
    if len(candidatos) == 1:
        return candidatos[0]
    print("\nModelos disponibles:")
    for i, p in enumerate(candidatos, start=1):
        print(f"  {i}) {p.stem}")
    try:
        elegido = input(f"\n¿Cuál corro? [1-{len(candidatos)}, Enter = 1]: ").strip()
    except EOFError:
        elegido = ""
    if elegido.isdigit() and 1 <= int(elegido) <= len(candidatos):
        return candidatos[int(elegido) - 1]
    return candidatos[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--modelo", help="Nombre del .pt en modelos/ (sin extensión)")
    parser.add_argument("--pesos", help="Ruta a un .pt cualquiera")
    parser.add_argument("--imgsz", type=int, default=1280,
                        help="Resolución de inferencia. Los cuadros llegan a 1280 px; 1536 detecta un poco más y cuesta más")
    parser.add_argument("--conf", type=float, default=0.35)
    parser.add_argument("--device", default=None, help="0 para GPU, cpu para CPU")
    parser.add_argument("--puerto", type=int, default=PUERTO)
    parser.add_argument("--sin-anuncio", action="store_true", help="No anunciar el servicio por UDP")
    parser.add_argument("--sin-modelo", action="store_true", help="Solo visor y botones (como el mock), sin inferencia")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    detector = None
    if not args.sin_modelo:
        pesos = elegir_modelo(args)
        if pesos is None:
            raise SystemExit(
                f"No hay ningún .pt en {AQUI / 'modelos'}. Copiá ahí los pesos entrenados "
                "(por ejemplo yolo11m-mix.pt) o pasá --pesos. Con --sin-modelo arranca solo el visor."
            )
        if args.device is None:
            args.device = 0 if torch.cuda.is_available() else "cpu"
        if args.device != "cpu" and not torch.cuda.is_available():
            raise SystemExit("Pediste GPU pero torch no ve ninguna. Revisá que el entorno tenga la versión de torch con CUDA.")
        detector = Detector(pesos, args.imgsz, args.conf, args.device)
        detector.calentar()
        equipo = torch.cuda.get_device_name(0) if args.device != "cpu" else "CPU"
        log.info("Modelo %s listo en %s (imgsz %d, conf %.2f)", detector.nombre, equipo, args.imgsz, args.conf)

    parar = threading.Event()
    if not args.sin_anuncio:
        threading.Thread(target=anunciar, args=(args.puerto, socket.gethostname(), parar), name="anuncio", daemon=True).start()
        log.info("Anunciando el servicio por UDP en el puerto %d a %s", PUERTO_ANUNCIO, ", ".join(direcciones_de_broadcast()))

    servidor = Servidor(detector)
    log.info("Visor en http://localhost:%d  ·  la app se conecta a ws://<esta-pc>:%d/phone", args.puerto, args.puerto)
    try:
        web.run_app(servidor.app(), host="0.0.0.0", port=args.puerto, print=None)
    finally:
        parar.set()


if __name__ == "__main__":
    main()
