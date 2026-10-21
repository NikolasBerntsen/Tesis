"""Pruebas del servidor de detección: las piezas puras y el camino de un cuadro.

    cd detection
    ..\\ml\\.venv\\Scripts\\python.exe -m unittest -v      (o el Python de iniciar.bat)

No cargan ningún modelo ni tocan la GPU: el detector es uno de mentira, y las
placas de red y las reglas del firewall se arman a mano con la forma que
devuelven psutil y PowerShell. Lo único "real" es la red de loopback, que se
usa para probar de punta a punta el "hola" de la app y el WebSocket /phone.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from collections import namedtuple
from pathlib import Path
from unittest import mock

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import servidor  # noqa: E402

# La forma de psutil.net_if_addrs() / net_if_stats(), sin depender de las placas de esta máquina.
Dir = namedtuple("Dir", "family address netmask broadcast ptp")
Est = namedtuple("Est", "isup")


def ipv4(ip: str, mascara: str) -> Dir:
    return Dir(socket.AF_INET, ip, mascara, None, None)


def jpeg_b64(ancho: int = 64, alto: int = 36) -> str:
    ok, jpeg = cv2.imencode(".jpg", np.zeros((alto, ancho, 3), dtype=np.uint8))
    assert ok
    return base64.b64encode(jpeg.tobytes()).decode("ascii")


class DetectorDeMentira:
    """Lo mínimo que Servidor usa de un Detector, sin YOLO."""

    def __init__(self, resultado=None, error: Exception | None = None):
        self.nombre = "mentira"
        self.esquema = "PERSON/VEHICLE (entrenado en 2 clases)"
        self.respaldo = False
        self.imgsz = 1280
        self.ms = 12.0
        self.resultado = resultado or ({}, [])
        self.error = error

    def detectar(self, cuadro):
        if self.error is not None:
            raise self.error
        return self.resultado


# ---------------------------------------------------------------------------
# Red
# ---------------------------------------------------------------------------


class BroadcastDirigido(unittest.TestCase):
    def test_red_22_de_la_casa(self):
        # El caso de campo: con /24 supuesto salía a 192.168.68.255, que en
        # esta red es un host común y el anuncio no llegaba a nadie.
        self.assertEqual(servidor.broadcast_dirigido("192.168.68.50", "255.255.252.0"), "192.168.71.255")

    def test_red_24(self):
        self.assertEqual(servidor.broadcast_dirigido("192.168.1.34", "255.255.255.0"), "192.168.1.255")

    def test_red_16(self):
        self.assertEqual(servidor.broadcast_dirigido("10.20.30.40", "255.255.0.0"), "10.20.255.255")

    def test_hotspot_de_android_y_de_windows(self):
        self.assertEqual(servidor.broadcast_dirigido("192.168.43.10", "255.255.255.0"), "192.168.43.255")
        self.assertEqual(servidor.broadcast_dirigido("192.168.137.1", "255.255.255.0"), "192.168.137.255")

    def test_redes_sin_broadcast(self):
        self.assertIsNone(servidor.broadcast_dirigido("10.8.0.2", "255.255.255.255"))
        self.assertIsNone(servidor.broadcast_dirigido("10.8.0.2", "255.255.255.254"))


class FiltroDeInterfacesVirtuales(unittest.TestCase):
    def test_virtuales_por_nombre(self):
        for nombre in (
            "VMware Network Adapter VMnet1", "VMware Network Adapter VMnet8", "VirtualBox Host-Only Network",
            "vEthernet (WSL)", "vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter",
            "TAP-Windows Adapter V9", "ExpressVPN TUN Driver", "ExpressVPN", "NordVPN",
            "Loopback Pseudo-Interface 1", "Conexión de red Bluetooth 2", "Bluetooth Network Connection",
            "lo", "lo0", "tun0", "tap1", "utun3", "wg0", "docker0", "br-3f2a9c1d", "vethc0ffee",
            "virbr0", "vmnet8", "vboxnet0", "awdl0", "llw0", "ztmjfpigyc",
        ):
            with self.subTest(nombre=nombre):
                self.assertTrue(servidor.es_interfaz_virtual(nombre), nombre)

    def test_reales(self):
        for nombre in ("Wi-Fi", "Wi-Fi 3", "Ethernet", "Ethernet 3", "Conexión de área local* 2",
                       "Local Area Connection* 2", "en0", "en1", "eth0", "wlan0", "wlp2s0", "enp3s0", "local"):
            with self.subTest(nombre=nombre):
                self.assertFalse(servidor.es_interfaz_virtual(nombre), nombre)

    def test_la_descripcion_delata_a_la_vpn_con_nombre_inocente(self):
        # En Windows el TAP de ExpressVPN se llama "Ethernet 2": solo la
        # descripción del adaptador dice qué es.
        self.assertFalse(servidor.es_interfaz_virtual("Ethernet 2"))
        self.assertTrue(servidor.es_interfaz_virtual("Ethernet 2", "ExpressVPN TAP Adapter"))
        self.assertTrue(servidor.es_interfaz_virtual("Conexión de área local", "OpenVPN Data Channel Offload for ExpressVPN"))

    def test_la_zona_con_cobertura_de_windows_no_se_filtra(self):
        # El teléfono puede estar colgado de la notebook: es una interfaz que sirve.
        self.assertFalse(servidor.es_interfaz_virtual("Local Area Connection* 10", "Microsoft Wi-Fi Direct Virtual Adapter #2"))


class InterfacesParaAnunciar(unittest.TestCase):
    def setUp(self):
        self.direcciones = {
            "Wi-Fi 3": [ipv4("192.168.68.50", "255.255.252.0"),
                        Dir(socket.AF_INET6, "fe80::1", None, None, None)],
            "Ethernet 3": [ipv4("192.168.68.52", "255.255.252.0")],
            "Ethernet 2": [ipv4("169.254.48.7", "255.255.0.0")],
            "Ethernet 5": [ipv4("169.254.9.9", "255.255.0.0")],
            "VMware Network Adapter VMnet1": [ipv4("192.168.16.1", "255.255.255.0")],
            "Loopback Pseudo-Interface 1": [ipv4("127.0.0.1", "255.0.0.0")],
            "Local Area Connection* 10": [ipv4("192.168.137.1", "255.255.255.0")],
        }
        self.estados = {
            "Wi-Fi 3": Est(True), "Ethernet 3": Est(False), "Ethernet 2": Est(False), "Ethernet 5": Est(True),
            "VMware Network Adapter VMnet1": Est(True), "Loopback Pseudo-Interface 1": Est(True),
            "Local Area Connection* 10": Est(True),
        }
        self.descripciones = {"Ethernet 2": "ExpressVPN TAP Adapter"}

    def test_solo_quedan_las_reales_con_su_broadcast_verdadero(self):
        reales, _ = servidor.interfaces_para_anunciar(self.direcciones, self.estados, self.descripciones)
        self.assertEqual(reales, [
            servidor.Interfaz("Wi-Fi 3", "192.168.68.50", 22, "192.168.71.255"),
            servidor.Interfaz("Local Area Connection* 10", "192.168.137.1", 24, "192.168.137.255"),
        ])

    def test_cada_ignorada_dice_por_que(self):
        _, ignoradas = servidor.interfaces_para_anunciar(self.direcciones, self.estados, self.descripciones)
        motivos = {nombre: motivo for nombre, _, motivo in ignoradas}
        self.assertEqual(motivos, {
            "Ethernet 3": "desconectada",
            "Ethernet 2": "virtual",
            "Ethernet 5": "sin IP del DHCP (169.254)",
            "VMware Network Adapter VMnet1": "virtual",
            "Loopback Pseudo-Interface 1": "loopback",
        })

    def test_sin_estados_no_se_descarta_por_desconectada(self):
        reales, _ = servidor.interfaces_para_anunciar({"eth0": [ipv4("10.0.0.5", "255.255.255.0")]})
        self.assertEqual(reales, [servidor.Interfaz("eth0", "10.0.0.5", 24, "10.0.0.255")])

    def test_urls_para_el_modo_manual(self):
        reales, _ = servidor.interfaces_para_anunciar(self.direcciones, self.estados, self.descripciones)
        self.assertEqual(servidor.urls_para_la_app(reales, 8765),
                         ["ws://192.168.68.50:8765", "ws://192.168.137.1:8765"])


class AnuncioPorCadaInterfaz(unittest.TestCase):
    """El bucle de ida: un socket atado a la IP de cada placa, que manda a su broadcast y al limitado.

    Con sockets de mentira, para ver adónde sale cada datagrama sin depender
    de las placas de esta máquina (ni mandar broadcasts de verdad a la red).
    """

    WIFI = servidor.Interfaz("Wi-Fi 3", "192.168.68.50", 22, "192.168.71.255")
    HOTSPOT = servidor.Interfaz("Local Area Connection* 10", "192.168.137.1", 24, "192.168.137.255")

    def correr(self, vueltas):
        """Corre el bucle una vez por cada lista de interfaces de `vueltas` y devuelve lo que pasó."""
        registro = {"atados": [], "enviados": [], "cerrados": []}

        class SocketDeMentira:
            def __init__(self, *args, **kwargs):
                self.ip = None

            def setsockopt(self, *args):
                pass

            def bind(self, direccion):
                self.ip = direccion[0]
                registro["atados"].append(direccion)

            def sendto(self, datos, destino):
                registro["enviados"].append((self.ip, destino, json.loads(datos)))

            def close(self):
                registro["cerrados"].append(self.ip)

        d = servidor.Descubrimiento(8765, "notebook-campo")
        d.REVISION_S = 0  # que vuelva a mirar las placas en cada vuelta
        pendientes = list(vueltas)

        def revisar():
            d.interfaces = pendientes.pop(0)
            return d.interfaces

        def esperar(_segundos):
            registro.setdefault("por_vuelta", []).append(list(registro["enviados"]))
            registro["enviados"].clear()
            if not pendientes:
                d._parar.set()
            return d._parar.is_set()

        d.revisar_interfaces = revisar
        d._parar.wait = esperar
        with mock.patch.object(servidor.socket, "socket", SocketDeMentira):
            d._bucle_anuncio()
        return registro

    def test_cada_placa_por_su_socket_a_su_broadcast_y_al_limitado(self):
        r = self.correr([[self.WIFI, self.HOTSPOT]])
        self.assertEqual(sorted(r["atados"]), [("192.168.137.1", 0), ("192.168.68.50", 0)])
        self.assertEqual(sorted((ip, destino) for ip, destino, _ in r["por_vuelta"][0]), [
            ("192.168.137.1", ("192.168.137.255", 8766)), ("192.168.137.1", ("255.255.255.255", 8766)),
            ("192.168.68.50", ("192.168.71.255", 8766)), ("192.168.68.50", ("255.255.255.255", 8766)),
        ])
        for *_, anuncio in r["por_vuelta"][0]:
            self.assertEqual(anuncio, {"service": "dronepatrol-detection", "port": 8765, "name": "notebook-campo"})

    def test_una_placa_sin_broadcast_dirigido_va_solo_al_limitado(self):
        vpn_punto_a_punto = servidor.Interfaz("eth0", "10.8.0.2", 32, None)
        r = self.correr([[vpn_punto_a_punto]])
        self.assertEqual([(ip, d) for ip, d, _ in r["por_vuelta"][0]], [("10.8.0.2", ("255.255.255.255", 8766))])

    def test_la_placa_que_se_va_cierra_su_socket(self):
        # Ethernet -> Wi-Fi en el medio de la sesión (pasó durante el diagnóstico).
        r = self.correr([[self.WIFI, self.HOTSPOT], [self.WIFI]])
        self.assertIn("192.168.137.1", r["cerrados"][:1])  # se cerró al reconciliar, antes del final
        self.assertEqual({ip for ip, _, _ in r["por_vuelta"][1]}, {"192.168.68.50"})
        # Al terminar no queda ninguno abierto: los dos atados y el suelto.
        self.assertEqual(sorted(map(str, r["cerrados"])), ["192.168.137.1", "192.168.68.50", "None"])

    def test_sin_placas_reales_sale_igual_por_la_del_sistema(self):
        r = self.correr([[]])
        self.assertEqual([(ip, d) for ip, d, _ in r["por_vuelta"][0]], [(None, ("255.255.255.255", 8766))])


class HolaDeLaApp(unittest.TestCase):
    def test_hola_valido(self):
        datos = json.dumps({"service": "dronepatrol-app", "port": 8766, "name": "S23 Ultra"}).encode()
        self.assertEqual(servidor.interpretar_hola(datos), {"port": 8766, "name": "S23 Ultra"})

    def test_el_propio_anuncio_no_es_un_hola(self):
        # El broadcast del servidor vuelve a su propio puerto 8766.
        datos = json.dumps({"service": "dronepatrol-detection", "port": 8765, "name": "pc"}).encode()
        self.assertIsNone(servidor.interpretar_hola(datos))

    def test_basura(self):
        for datos in (b"", b"hola", b"\xff\xfe\x00", b"[1, 2]", b"null", b'"dronepatrol-app"',
                      json.dumps({"service": "otra-cosa"}).encode(), b"{" + b" " * 5000 + b"}"):
            with self.subTest(datos=datos[:20]):
                self.assertIsNone(servidor.interpretar_hola(datos))

    def test_puerto_que_no_sirve_cae_al_de_siempre(self):
        for puerto in (None, "8766", 0, 70000, True, 12.5):
            with self.subTest(puerto=puerto):
                datos = json.dumps({"service": "dronepatrol-app", "port": puerto}).encode()
                self.assertEqual(servidor.interpretar_hola(datos), {"port": 8766, "name": ""})

    def test_nombre_recortado(self):
        datos = json.dumps({"service": "dronepatrol-app", "port": 8766, "name": "  " + "x" * 100}).encode()
        self.assertEqual(servidor.interpretar_hola(datos)["name"], "x" * 64)


class RespuestaUnicastAlHola(unittest.TestCase):
    """De punta a punta por loopback: la app saluda y el servidor le contesta a ella sola."""

    def test_contesta_con_el_anuncio_a_la_ip_y_puerto_del_hola(self):
        descubrimiento = servidor.Descubrimiento(8765, "notebook-campo", puerto_udp=0)
        escucha = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        escucha.bind(("127.0.0.1", 0))
        telefono = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        telefono.bind(("127.0.0.1", 0))
        telefono.settimeout(2.0)
        try:
            puerto_telefono = telefono.getsockname()[1]
            hola = json.dumps({"service": "dronepatrol-app", "port": puerto_telefono, "name": "S23"}).encode()
            self.assertTrue(descubrimiento.atender(escucha, hola, "127.0.0.1"))
            datos, origen = telefono.recvfrom(2048)
            self.assertEqual(json.loads(datos), {"service": "dronepatrol-detection", "port": 8765,
                                                 "name": "notebook-campo"})
            self.assertEqual(origen[0], "127.0.0.1")
            vistos = descubrimiento.estado()["telefonosVistos"]
            self.assertEqual([(t["ip"], t["name"]) for t in vistos], [("127.0.0.1", "S23")])
        finally:
            escucha.close()
            telefono.close()

    def test_lo_que_no_es_hola_no_se_contesta(self):
        descubrimiento = servidor.Descubrimiento(8765, "pc", puerto_udp=0)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as escucha:
            escucha.bind(("127.0.0.1", 0))
            self.assertFalse(descubrimiento.atender(escucha, descubrimiento.anuncio, "127.0.0.1"))
        self.assertEqual(descubrimiento.estado()["telefonosVistos"], [])


# ---------------------------------------------------------------------------
# Clases del modelo
# ---------------------------------------------------------------------------


COCO_PARCIAL = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 4: "airplane", 5: "bus", 6: "train",
                7: "truck", 8: "boat", 9: "traffic light", 16: "dog", 79: "toothbrush"}
VISDRONE = {0: "pedestrian", 1: "people", 2: "bicycle", 3: "car", 4: "van", 5: "truck", 6: "tricycle",
            7: "awning-tricycle", 8: "bus", 9: "motor"}


class MapaDeClases(unittest.TestCase):
    def test_dos_clases_como_hoy(self):
        mapa, esquema = servidor.armar_mapa_de_clases({0: "PERSON", 1: "VEHICLE"})
        self.assertEqual(mapa, {0: "PERSON", 1: "VEHICLE"})
        self.assertIn("2 clases", esquema)

    def test_dos_clases_en_minuscula_y_en_otro_orden(self):
        mapa, _ = servidor.armar_mapa_de_clases({0: "vehicle", 1: "person"})
        self.assertEqual(mapa, {0: "VEHICLE", 1: "PERSON"})

    def test_coco_persona_y_cuatro_vehiculos_el_resto_afuera(self):
        mapa, esquema = servidor.armar_mapa_de_clases(COCO_PARCIAL)
        self.assertEqual(mapa, {0: "PERSON", 2: "VEHICLE", 3: "VEHICLE", 5: "VEHICLE", 7: "VEHICLE"})
        self.assertIn("COCO", esquema)

    def test_visdrone_agrupado_como_siempre(self):
        mapa, _ = servidor.armar_mapa_de_clases(VISDRONE)
        self.assertEqual(mapa, {0: "PERSON", 1: "PERSON", **{i: "VEHICLE" for i in range(2, 10)}})

    def test_un_modelo_sin_nada_util_queda_vacio(self):
        mapa, _ = servidor.armar_mapa_de_clases({0: "cat", 1: "dog"})
        self.assertEqual(mapa, {})


Caja = namedtuple("Caja", "cls conf xyxy")


class YoloDeMentira:
    """Lo que Detector usa de ultralytics.YOLO: los nombres y predict()."""

    pedidos: list = []

    def __init__(self, pesos):
        self.names = COCO_PARCIAL

    def predict(self, cuadro, imgsz, conf, device, classes, verbose):
        YoloDeMentira.pedidos.append(classes)
        cajas = [Caja(0, 0.9, [[10, 20, 30, 60]]), Caja(16, 0.95, [[0, 0, 5, 5]]), Caja(7, 0.6, [[40, 40, 80, 70]])]
        return [namedtuple("Resultado", "boxes")(cajas)]


class DetectorConElRespaldoDeCoco(unittest.TestCase):
    def setUp(self):
        YoloDeMentira.pedidos = []
        parche = mock.patch.object(servidor, "_importar_torch_y_yolo", return_value=(None, YoloDeMentira))
        parche.start()
        self.addCleanup(parche.stop)

    def test_le_pide_al_modelo_solo_las_clases_que_sirven_y_descarta_el_resto(self):
        d = servidor.Detector(Path("yolo11m.pt"), 640, 0.35, "cpu", respaldo=True)
        mejor, cajas = d.detectar(np.zeros((100, 100, 3), dtype=np.uint8))
        self.assertEqual(YoloDeMentira.pedidos, [[0, 2, 3, 5, 7]])
        self.assertEqual(mejor, {"PERSON": 0.9, "VEHICLE": 0.6})  # el perro (16) no aparece
        self.assertEqual([c[4] for c in cajas], ["PERSON", "VEHICLE"])
        self.assertTrue(d.respaldo)
        self.assertIn("COCO", d.esquema)


class EleccionDelModelo(unittest.TestCase):
    """Qué .pt arranca según lo que haya en modelos/ (en una carpeta temporal)."""

    def setUp(self):
        import tempfile

        carpeta = tempfile.TemporaryDirectory()
        self.addCleanup(carpeta.cleanup)
        self.tmp = Path(carpeta.name)
        (self.tmp / "detection" / "modelos").mkdir(parents=True)
        for nombre, valor in (("AQUI", self.tmp / "detection"),
                              ("CARPETA_RESPALDO", self.tmp / "detection" / "modelos" / "respaldo")):
            parche = mock.patch.object(servidor, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        self.args = argparse.Namespace(pesos=None, modelo=None)

    def poner(self, *rutas):
        for r in rutas:
            p = self.tmp / r
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"pesos")

    def test_sin_modelos_entrenados_va_el_respaldo_y_baja_a_su_carpeta(self):
        pesos, respaldo = servidor.elegir_modelo(self.args)
        self.assertTrue(respaldo)
        self.assertEqual(pesos, self.tmp / "detection" / "modelos" / "respaldo" / "yolo11m.pt")
        self.assertTrue(pesos.parent.is_dir())  # ultralytics lo baja ahí

    def test_el_respaldo_de_ml_se_usa_sin_bajar_nada(self):
        self.poner("ml/yolo11m.pt")
        self.assertEqual(servidor.elegir_modelo(self.args), (self.tmp / "ml" / "yolo11m.pt", True))

    def test_el_respaldo_no_entra_en_el_menu_ni_le_gana_al_entrenado(self):
        self.poner("detection/modelos/respaldo/yolo11m.pt", "detection/modelos/yolo11m-mix.pt",
                   "detection/modelos/yolo11m-2clases.pt")
        pesos, respaldo = servidor.elegir_modelo(self.args)
        self.assertEqual((pesos.name, respaldo), ("yolo11m-2clases.pt", False))

    def test_un_solo_entrenado_va_sin_preguntar(self):
        self.poner("detection/modelos/yolo11m-mix.pt")
        pesos, respaldo = servidor.elegir_modelo(self.args)
        self.assertEqual((pesos.name, respaldo), ("yolo11m-mix.pt", False))


class AbrirElVisor(unittest.TestCase):
    def test_abre_recien_cuando_el_servidor_contesta(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            s.listen()
            puerto = s.getsockname()[1]
            with mock.patch.object(servidor.webbrowser, "open", return_value=True) as abrir:
                servidor.abrir_visor_cuando_responda(puerto, espera_s=3)
        abrir.assert_called_once_with(f"http://localhost:{puerto}")

    def test_si_nunca_contesta_no_abre_nada(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            puerto = s.getsockname()[1]
        with mock.patch.object(servidor.webbrowser, "open") as abrir:
            servidor.abrir_visor_cuando_responda(puerto, espera_s=1)
        abrir.assert_not_called()


# ---------------------------------------------------------------------------
# Mensaje detection y frameTs
# ---------------------------------------------------------------------------


class MensajeDetection(unittest.TestCase):
    def test_devuelve_el_ts_del_cuadro_tal_cual(self):
        antes = int(time.time() * 1000)
        m = servidor.mensaje_detection({"PERSON": 0.8123, "VEHICLE": 0.5}, [{"cls": "PERSON"}], "abc",
                                       frame_ts=1700000000123)
        self.assertEqual(m["frameTs"], 1700000000123)
        # ts es la hora de ESTA PC, no la del cuadro
        self.assertGreaterEqual(m["ts"], antes)
        self.assertEqual(m["type"], "detection")
        self.assertTrue(m["detected"])
        self.assertEqual(m["classes"], ["PERSON", "VEHICLE"])
        self.assertEqual(m["confidence"], 0.812)
        self.assertEqual(m["snapshotBase64"], "abc")

    def test_sin_deteccion_no_lleva_captura_pero_si_frameTs(self):
        m = servidor.mensaje_detection({}, None, None, frame_ts=42)
        self.assertEqual((m["detected"], m["classes"], m["confidence"], m["boxes"]), (False, [], 0.0, []))
        self.assertNotIn("snapshotBase64", m)
        self.assertEqual(m["frameTs"], 42)

    def test_frameTs_va_aunque_sea_null(self):
        m = servidor.mensaje_detection({})
        self.assertIn("frameTs", m)
        self.assertIsNone(m["frameTs"])
        json.dumps(m)  # serializable: null y no NaN

    def test_ts_del_cuadro(self):
        self.assertEqual(servidor.ts_del_cuadro(1700000000123), 1700000000123)
        self.assertEqual(servidor.ts_del_cuadro(1700000000123.5), 1700000000123.5)
        for malo in (None, "1700000000123", True, float("nan"), float("inf"), [1]):
            with self.subTest(valor=malo):
                self.assertIsNone(servidor.ts_del_cuadro(malo))

    def test_cajas_normalizadas(self):
        cajas = servidor.cajas_normalizadas([(100, 50, 300, 250, "VEHICLE", 0.91234)], 1000, 500)
        self.assertEqual(cajas, [{"cls": "VEHICLE", "conf": 0.912, "x": 0.2, "y": 0.3, "w": 0.2, "h": 0.4}])

    def test_simulada_del_visor_se_ata_al_ultimo_cuadro(self):
        m = servidor.completar_simulada({"type": "detection", "detected": True, "classes": ["PERSON"],
                                         "confidence": 0.9, "ts": 5}, 1234)
        self.assertEqual((m["frameTs"], m["boxes"], m["ts"], m["classes"]), (1234, [], 5, ["PERSON"]))

    def test_simulada_respeta_un_frameTs_propio(self):
        m = servidor.completar_simulada({"type": "detection", "detected": True, "frameTs": 99}, 1234)
        self.assertEqual(m["frameTs"], 99)
        self.assertIn("ts", m)


# ---------------------------------------------------------------------------
# Dispositivo, puerto y firewall
# ---------------------------------------------------------------------------


class Dispositivo(unittest.TestCase):
    def test_automatico(self):
        self.assertEqual(servidor.elegir_dispositivo(None, True, False), (0, "cuda"))
        self.assertEqual(servidor.elegir_dispositivo(None, False, True), ("mps", "mps"))
        self.assertEqual(servidor.elegir_dispositivo("auto", False, False), ("cpu", "cpu"))

    def test_pedidos(self):
        self.assertEqual(servidor.elegir_dispositivo("cuda", True, False), (0, "cuda"))
        self.assertEqual(servidor.elegir_dispositivo("cuda:1", True, False), (1, "cuda"))
        self.assertEqual(servidor.elegir_dispositivo("0", True, False), (0, "cuda"))
        self.assertEqual(servidor.elegir_dispositivo("CPU", True, True), ("cpu", "cpu"))
        self.assertEqual(servidor.elegir_dispositivo("mps", False, True), ("mps", "mps"))

    def test_pedidos_imposibles_son_error_y_no_cpu_callada(self):
        for pedido, cuda, mps in (("cuda", False, True), ("0", False, False), ("mps", True, False), ("tpu", True, True)):
            with self.subTest(pedido=pedido):
                with self.assertRaises(ValueError):
                    servidor.elegir_dispositivo(pedido, cuda, mps)


class PuertoOcupado(unittest.TestCase):
    def test_con_alguien_escuchando(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("0.0.0.0", 0))
            s.listen()
            self.assertTrue(servidor.puerto_ocupado(s.getsockname()[1]))

    def test_libre(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            puerto = s.getsockname()[1]
        self.assertFalse(servidor.puerto_ocupado(puerto))

    def test_el_mensaje_dice_que_hacer(self):
        texto = servidor.mensaje_puerto_ocupado(8765)
        self.assertIn("8765", texto)
        self.assertIn("--puerto", texto)
        # Otro puerto sirve contra otro programa, no contra otro servidor de
        # detección: los dos se anunciarían y la app saltaría entre ellos.
        self.assertIn("dos servidores de detección", texto)


class Diagnostico(unittest.TestCase):
    """`--diagnostico`, el modo verificación de los lanzadores (sin placas ni firewall reales)."""

    def diagnosticar(self, puerto):
        with mock.patch.object(servidor.Descubrimiento, "revisar_interfaces", return_value=[]), \
                mock.patch.object(servidor, "revisar_firewall") as firewall:
            with self.assertLogs("deteccion", level="INFO") as registro:
                codigo = servidor.diagnosticar(puerto)
        firewall.assert_called_once_with(puerto)
        return codigo, "\n".join(registro.output)

    def test_puerto_ocupado_sale_con_2_y_dice_que_hacer(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("0.0.0.0", 0))
            s.listen()
            codigo, texto = self.diagnosticar(s.getsockname()[1])
        self.assertEqual(codigo, 2)
        self.assertIn("ya está en uso", texto)

    def test_puerto_libre_sale_con_0(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            puerto = s.getsockname()[1]
        codigo, texto = self.diagnosticar(puerto)
        self.assertEqual(codigo, 0)
        self.assertIn("está libre", texto)


PYTHON = os.path.normcase(r"C:\Program Files\Python313\python.exe")


def regla(nombre, perfil, protocolo="TCP", puertos=("8765",), programa="Any", accion="Allow", habilitada="True"):
    return {"nombre": nombre, "habilitada": habilitada, "direccion": "Inbound", "accion": accion,
            "perfil": perfil, "protocolo": protocolo, "puertos": list(puertos), "programa": programa}


def firewall(reglas, categoria="Private", perfiles=None):
    return {
        "reglas": reglas,
        "perfilesRed": [{"categoria": categoria, "nombre": "Pupis 6GHz", "interfaz": "Wi-Fi 3"}],
        "perfilesFirewall": perfiles or [{"nombre": p, "activo": True, "entrada": "NotConfigured"}
                                         for p in ("Domain", "Private", "Public")],
    }


class Firewall(unittest.TestCase):
    PROGRAMAS = {servidor.normalizar_ruta(PYTHON)}

    def evaluar(self, datos, protocolo="TCP", puerto=8765):
        return servidor.evaluar_firewall(datos, protocolo, puerto, self.PROGRAMAS)

    def test_el_caso_del_diagnostico_python_solo_en_publicas(self):
        # Wi-Fi de la casa = Privada, Python permitido solo en Públicas.
        datos = firewall([regla("Python", "Public", puertos=["Any"], programa=r"C:\program files\python313\python.exe")])
        self.assertEqual(self.evaluar(datos), {"Private": ("cerrado", "")})

    def test_regla_por_puerto_en_todos_los_perfiles(self):
        datos = firewall([regla("DronePatrol deteccion TCP 8765", "Any")])
        self.assertEqual(self.evaluar(datos), {"Private": ("abierto", "DronePatrol deteccion TCP 8765")})

    def test_regla_de_python_con_variables_de_entorno(self):
        os.environ.setdefault("ProgramFiles", r"C:\Program Files")
        datos = firewall([regla("Python", "Private, Public", puertos=["Any"],
                                programa=r"%ProgramFiles%\Python313\python.exe")])
        esperado = "abierto" if os.environ["ProgramFiles"].lower() == r"c:\program files" else "cerrado"
        self.assertEqual(self.evaluar(datos)["Private"][0], esperado)

    def test_regla_de_otro_python_no_cuenta(self):
        datos = firewall([regla("Python 3.9", "Any", puertos=["Any"], programa=r"C:\Python39\python.exe")])
        self.assertEqual(self.evaluar(datos)["Private"][0], "cerrado")

    def test_el_bloqueo_gana(self):
        datos = firewall([regla("DronePatrol deteccion TCP 8765", "Any"),
                          regla("python.exe", "Private", puertos=["Any"], programa=PYTHON, accion="Block")])
        self.assertEqual(self.evaluar(datos), {"Private": ("bloqueado", "python.exe")})

    def test_deshabilitada_protocolo_y_puerto(self):
        datos = firewall([regla("apagada", "Any", habilitada="False"), regla("udp", "Any", protocolo="UDP"),
                          regla("otro puerto", "Any", puertos=["8000"]), regla("rango", "Any", puertos=["8700-8799"])])
        self.assertEqual(self.evaluar(datos), {"Private": ("abierto", "rango")})
        self.assertEqual(self.evaluar(datos, "UDP", 8765), {"Private": ("abierto", "udp")})

    def test_firewall_apagado_en_ese_perfil(self):
        perfiles = [{"nombre": "Private", "activo": False, "entrada": "NotConfigured"}]
        self.assertEqual(self.evaluar(firewall([], perfiles=perfiles))["Private"][0], "abierto")

    def test_red_de_dominio(self):
        datos = firewall([regla("solo privada", "Private")], categoria="DomainAuthenticated")
        self.assertEqual(self.evaluar(datos), {"Domain": ("cerrado", "")})

    def test_avisos_con_el_comando_exacto(self):
        lineas = servidor.avisos_de_firewall({"Private": ("cerrado", "")}, {"Private": ("cerrado", "")}, 8765, 8766)
        texto = "\n".join(lineas)
        self.assertIn("perfil Privado", texto)
        self.assertIn("New-NetFirewallRule -DisplayName 'DronePatrol deteccion TCP 8765' -Direction Inbound "
                      "-Action Allow -Protocol TCP -LocalPort 8765 -Profile Any", texto)
        self.assertIn("-Protocol UDP -LocalPort 8766", texto)
        self.assertIn("iniciar.bat", texto)

    def test_sin_avisos_si_esta_abierto(self):
        self.assertEqual(servidor.avisos_de_firewall({"Private": ("abierto", "x")}, {"Private": ("abierto", "y")},
                                                     8765, 8766), [])

    def test_aviso_de_bloqueo_nombra_la_regla(self):
        lineas = servidor.avisos_de_firewall({"Private": ("bloqueado", "python.exe")}, {}, 8765, 8766)
        self.assertTrue(any("python.exe" in l and "BLOQUEA" in l for l in lineas))


# ---------------------------------------------------------------------------
# El camino de un cuadro
# ---------------------------------------------------------------------------


class ProcesarUnCuadro(unittest.TestCase):
    def cuadro(self):
        return np.zeros((720, 1280, 3), dtype=np.uint8)

    def test_deteccion_con_frameTs_y_captura(self):
        detector = DetectorDeMentira(({"PERSON": 0.8}, [(100, 100, 140, 180, "PERSON", 0.8)]))
        s = servidor.Servidor(detector)
        al_telefono, al_visor = s.procesar(self.cuadro(), 1700000000123)
        self.assertEqual(al_telefono["frameTs"], 1700000000123)
        self.assertTrue(al_telefono["detected"])
        self.assertTrue(al_telefono["snapshotBase64"])
        self.assertEqual(al_telefono["boxes"][0]["cls"], "PERSON")
        self.assertNotIn("snapshotBase64", al_visor["detection"])
        self.assertEqual(al_visor["ts"], 1700000000123)
        self.assertEqual((s.procesados, s.errores), (1, 0))

    def test_si_la_inferencia_falla_el_visor_ve_el_cuadro_crudo_con_el_error(self):
        s = servidor.Servidor(DetectorDeMentira(error=RuntimeError("CUDA out of memory")))
        with self.assertLogs("deteccion", level="ERROR"):
            al_telefono, al_visor = s.procesar(self.cuadro(), 7)
        self.assertIsNone(al_telefono)  # al teléfono no se le miente un "no detecté"
        self.assertEqual(al_visor["error"], "CUDA out of memory")
        self.assertTrue(al_visor["jpegBase64"])
        self.assertIsNone(al_visor["detection"])
        self.assertEqual((s.procesados, s.errores), (0, 1))
        self.assertIn("CUDA out of memory", s._estado()["ultimoError"])

    def test_un_cuadro_ilegible_cuenta_como_recibido_y_como_error(self):
        s = servidor.Servidor(DetectorDeMentira())
        with self.assertLogs("deteccion", level="WARNING"):
            s._encolar("esto no es base64 de un jpeg", 5)
        estado = s._estado()
        self.assertEqual((estado["recibidos"], estado["errores"]), (1, 1))
        self.assertIsNotNone(estado["ultimoCuadroHaceS"])

    def test_la_cola_de_un_cuadro_descarta_el_viejo(self):
        s = servidor.Servidor(DetectorDeMentira())
        s._encolar(jpeg_b64(), 1)
        s._encolar(jpeg_b64(), 2)
        self.assertEqual((s.recibidos, s.descartados, s._pendiente[1]), (2, 1, 2))

    def test_un_cuadro_muy_apaisado_con_deteccion_no_rompe_la_captura(self):
        # Un cliente roto puede mandar un JPEG de 1 px de alto: reducido a 640
        # px de ancho la captura daba 0 de alto y cv2.resize tiraba una excepción.
        detector = DetectorDeMentira(({"PERSON": 0.8}, [(0, 0, 10, 1, "PERSON", 0.8)]))
        al_telefono, _ = servidor.Servidor(detector).procesar(np.zeros((1, 2000, 3), dtype=np.uint8), 3)
        self.assertTrue(al_telefono["snapshotBase64"])
        self.assertEqual(al_telefono["frameTs"], 3)


class HiloDelModelo(unittest.TestCase):
    """El hilo que infiere tiene que sobrevivir a cualquier cuadro: si muere, la detección se para para siempre."""

    def esperar(self, condicion, segundos=5.0):
        hasta = time.monotonic() + segundos
        while not condicion():
            if time.monotonic() > hasta:
                self.fail("no pasó a tiempo")
            time.sleep(0.01)

    def test_un_fallo_fuera_del_modelo_no_mata_el_hilo(self):
        s = servidor.Servidor(DetectorDeMentira())
        vistos = []
        procesar = s.procesar

        def procesar_o_romper(cuadro, ts):
            vistos.append(ts)
            if ts == 1:
                raise ValueError("se rompió la captura")
            return procesar(cuadro, ts)

        s.procesar = procesar_o_romper
        hilo = threading.Thread(target=s._inferir, daemon=True)
        hilo.start()

        def parar():
            s._parar.set()
            with s._hay:
                s._hay.notify_all()
            hilo.join(2)

        self.addCleanup(parar)
        with self.assertLogs("deteccion", level="ERROR"):
            s._encolar(jpeg_b64(), 1)
            self.esperar(lambda: vistos == [1] and s.errores == 1)
            s._encolar(jpeg_b64(), 2)
            self.esperar(lambda: s.procesados == 1)
        self.assertEqual(vistos, [1, 2])
        self.assertTrue(hilo.is_alive())
        self.assertIn("se rompió la captura", s.ultimo_error)


class ImportarSinModelo(unittest.TestCase):
    def test_importar_no_carga_torch_ni_ultralytics(self):
        codigo = "import sys, servidor; print('torch' in sys.modules, 'ultralytics' in sys.modules)"
        r = subprocess.run([sys.executable, "-c", codigo], cwd=AQUI, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), ["False", "False"])


class EnlaceConElTelefono(unittest.IsolatedAsyncioTestCase):
    """El WebSocket /phone de verdad (aiohttp en loopback) con el detector de mentira."""

    async def asyncSetUp(self):
        from aiohttp.test_utils import TestClient, TestServer

        detector = DetectorDeMentira(({"VEHICLE": 0.7}, [(10, 10, 30, 20, "VEHICLE", 0.7)]))
        self.servidor = servidor.Servidor(detector)
        self.cliente = TestClient(TestServer(self.servidor.app()))
        await self.cliente.start_server()

    async def asyncTearDown(self):
        await self.cliente.close()

    async def test_video_frame_vuelve_como_detection_con_su_frameTs(self):
        telefono = await self.cliente.ws_connect("/phone")
        await telefono.send_json({"type": "video_frame", "jpegBase64": jpeg_b64(), "ts": 1700000000555})
        msg = await asyncio.wait_for(telefono.receive_json(), timeout=10)
        self.assertEqual(msg["type"], "detection")
        self.assertEqual(msg["frameTs"], 1700000000555)
        self.assertEqual(msg["classes"], ["VEHICLE"])
        await telefono.close()

    async def test_el_visor_ve_la_ip_del_telefono_y_las_stats_sin_inferencias(self):
        visor = await self.cliente.ws_connect("/viewer")
        self.assertEqual((await visor.receive_json())["type"], "phone_status")
        self.assertEqual((await visor.receive_json())["type"], "stats")
        telefono = await self.cliente.ws_connect("/phone")
        estado = await asyncio.wait_for(visor.receive_json(), timeout=5)
        self.assertEqual(estado, {"type": "phone_status", "connected": True, "ip": "127.0.0.1"})
        # Sin ningún cuadro procesado, las estadísticas igual llegan solas cada segundo.
        while True:
            msg = await asyncio.wait_for(visor.receive_json(), timeout=3)
            if msg["type"] == "stats":
                break
        self.assertEqual((msg["telefono"], msg["telefonoIp"], msg["recibidos"]), (True, "127.0.0.1", 0))
        await telefono.close()
        await visor.close()

    async def test_la_simulada_del_visor_llega_al_telefono_atada_al_ultimo_cuadro(self):
        telefono = await self.cliente.ws_connect("/phone")
        await telefono.send_json({"type": "video_frame", "jpegBase64": jpeg_b64(), "ts": 321})
        await asyncio.wait_for(telefono.receive_json(), timeout=10)  # la del modelo
        visor = await self.cliente.ws_connect("/viewer")
        await visor.send_json({"type": "detection", "detected": True, "classes": ["PERSON"], "confidence": 0.9})
        msg = await asyncio.wait_for(telefono.receive_json(), timeout=5)
        self.assertEqual((msg["classes"], msg["frameTs"], msg["boxes"]), (["PERSON"], 321, []))
        await telefono.close()
        await visor.close()


if __name__ == "__main__":
    unittest.main()
