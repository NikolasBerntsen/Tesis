"""Pruebas de las decisiones de los lanzadores (iniciar.ps1 e iniciar.sh).

    cd detection
    ..\\ml\\.venv\\Scripts\\python.exe -m unittest -v      (corre estas y las del servidor)

Los lanzadores instalan, bajan gigas y piden permisos de administrador: eso no
se prueba acá. Lo que sí se prueba son sus funciones puras, cargadas sueltas
(en PowerShell, desde el árbol del script; en bash, con `source`, que no corre
`main`): qué hacer con cada entorno de Python encontrado, cómo se lee la prueba
de un entorno, cuándo ufw está prendido y de dónde se baja el modelo. Las de
PowerShell corren solo en Windows y las de bash donde haya un bash (en Windows,
el de Git for Windows: el "bash" de System32 es el de WSL, que es otro sistema).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent

# (sirve, ve la GPU, el torch trae CUDA, le falta un módulo, es el propio, hay NVIDIA) -> qué hacer
CASOS = [
    ((True, True, True, False, False, True), "usar"),
    # El caso del arreglo: torch de CUDA con un driver viejo. Antes, el propio se
    # reinstalaba (3 GB) y uno ajeno se salteaba para armar otro igual, en cada arranque.
    ((True, False, True, False, False, True), "usar-sin-gpu"),
    ((True, False, True, False, True, True), "usar-sin-gpu"),
    # torch de CPU en una PC con NVIDIA: al propio se le cambia; uno ajeno no se toca.
    ((True, False, False, False, True, True), "reinstalar-torch"),
    ((True, False, False, False, False, True), "saltear"),
    # Sin NVIDIA, el de CPU es justo lo que corresponde.
    ((True, False, False, False, False, False), "usar"),
    ((False, False, False, True, True, True), "completar"),
    ((False, False, False, True, False, True), "no-sirve"),
    ((False, False, False, False, True, False), "no-sirve"),
]

# Lo que imprime la prueba de un entorno, con lo que torch y ultralytics le
# agregan alrededor: la línea que interesa no es necesariamente la última.
SALIDA_DRIVER_VIEJO = (
    "Creating new Ultralytics Settings v0.0.6 file\n"
    "ENTORNO 2.11.0+cu128 False True\n"
    "C:\\venv\\torch\\cuda\\__init__.py:182: UserWarning: CUDA initialization: The NVIDIA driver on your system is too old"
)
SALIDA_SIN_PSUTIL = (
    "Traceback (most recent call last):\n"
    '  File "<string>", line 1, in <module>\n'
    "ModuleNotFoundError: No module named 'psutil'"
)
LECTURAS = [
    # (código, salida) -> (sirve, ve la GPU, trae CUDA, le falta un módulo, detalle)
    ((0, SALIDA_DRIVER_VIEJO), (True, False, True, False, "torch 2.11.0+cu128")),
    ((0, "ENTORNO 2.11.0+cpu False False\r"), (True, False, False, False, "torch 2.11.0+cpu")),
    ((1, SALIDA_SIN_PSUTIL), (False, False, False, True, "le falta psutil")),
    # Terminó bien pero sin la línea marcada (otro Python, otra cosa): no sirve.
    ((0, "hola"), (False, False, False, False, "hola")),
]

# Cuando el entorno no importa (paso 4 de iniciar.ps1): qué se le aconseja hacer.
ERRORES_DE_IMPORTACION = [
    # El típico de una Windows recién instalada: rehacer el entorno no lo arregla.
    ('OSError: [WinError 126] No se puede encontrar el módulo especificado. Error loading '
     '"C:\\det\\.venv\\Lib\\site-packages\\torch\\lib\\fbgemm.dll" or one of its dependencies.', "vc_redist"),
    ("ImportError: DLL load failed while importing cv2: No se puede encontrar el módulo especificado.", "vc_redist"),
    ("ModuleNotFoundError: No module named 'ultralytics'", "Borrá"),
]


def _bash() -> str | None:
    if sys.platform != "win32":
        return shutil.which("bash")
    candidatos = []
    git = shutil.which("git")
    if git:
        raiz = Path(git).resolve().parent.parent  # ...\Git\cmd\git.exe o ...\Git\mingw64\bin\git.exe
        candidatos += [raiz / "bin" / "bash.exe", raiz.parent / "bin" / "bash.exe"]
    for variable in ("ProgramFiles", "ProgramW6432"):
        if os.environ.get(variable):
            candidatos.append(Path(os.environ[variable]) / "Git" / "bin" / "bash.exe")
    return next((str(c) for c in candidatos if c.is_file()), None)


@unittest.skipUnless(sys.platform == "win32" and shutil.which("powershell"), "PowerShell de Windows")
class LanzadorDeWindows(unittest.TestCase):
    """Las funciones de iniciar.ps1, sacadas del árbol del script (sin correrlo)."""

    @classmethod
    def setUpClass(cls):
        entrada = {
            "casos": [dict(zip(("sirve", "cuda", "torch_cuda", "sin_modulo", "es_propio", "hay_nvidia"), c))
                      for c, _ in CASOS],
            "lecturas": [{"codigo": codigo, "salida": salida} for (codigo, salida), _ in LECTURAS],
            "errores": [salida for salida, _ in ERRORES_DE_IMPORTACION],
        }
        script = (
            "$ErrorActionPreference = 'Stop'\n"
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n"  # los consejos llevan acentos
            f"$ast =[System.Management.Automation.Language.Parser]::ParseFile("
            f"'{str(AQUI / 'iniciar.ps1').replace(chr(39), chr(39) * 2)}', [ref]$null, [ref]$null)\n"
            "foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {\n"
            "    . ([scriptblock]::Create($f.Extent.Text))\n"
            "}\n"
            f"$entrada = ConvertFrom-Json '{json.dumps(entrada).replace(chr(39), chr(39) * 2)}'\n"
            "$decisiones = @(foreach ($c in $entrada.casos) {\n"
            "    $p = [pscustomobject]@{ Sirve = $c.sirve; Cuda = $c.cuda; TorchConCuda = $c.torch_cuda;"
            " SinModulo = $c.sin_modulo; Detalle = '' }\n"
            "    Que-Hacer-Con $p $c.es_propio $c.hay_nvidia\n"
            "})\n"
            "$lecturas = @(foreach ($l in $entrada.lecturas) { Leer-Prueba $l.codigo $l.salida })\n"
            "$consejos = @(foreach ($s in $entrada.errores) { ,@(Que-Hacer-Si-No-Importa $s) })\n"
            "ConvertTo-Json -Compress -Depth 4 -InputObject @{ decisiones = $decisiones; lecturas = $lecturas;"
            " consejos = $consejos }\n"
        )
        with tempfile.TemporaryDirectory() as carpeta:
            archivo = Path(carpeta) / "prueba.ps1"
            archivo.write_text(script, encoding="utf-8-sig")
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                "-File", str(archivo)], capture_output=True, timeout=120)
        salida = r.stdout.decode("utf-8", errors="replace")
        if r.returncode != 0:
            raise AssertionError(f"PowerShell falló:\n{salida}\n{r.stderr.decode('utf-8', errors='replace')}")
        cls.resultado = json.loads(salida)

    def test_que_hacer_con_cada_entorno(self):
        for (caso, esperado), obtenido in zip(CASOS, self.resultado["decisiones"]):
            with self.subTest(caso=caso):
                self.assertEqual(obtenido, esperado)

    def test_leer_la_prueba_de_un_entorno(self):
        for (entrada, esperado), p in zip(LECTURAS, self.resultado["lecturas"]):
            with self.subTest(salida=entrada[1][:40]):
                self.assertEqual((p["Sirve"], p["Cuda"], p["TorchConCuda"], p["SinModulo"], p["Detalle"]), esperado)

    def test_el_consejo_cuando_el_entorno_no_importa(self):
        for (salida, esperado), consejo in zip(ERRORES_DE_IMPORTACION, self.resultado["consejos"]):
            with self.subTest(salida=salida[:40]):
                self.assertIn(esperado, " ".join(consejo))
        self.assertEqual(len(self.resultado["consejos"]), len(ERRORES_DE_IMPORTACION))


BASH = _bash()


@unittest.skipUnless(BASH, "hace falta bash (en Windows, el de Git for Windows)")
class LanzadorDeLinuxYMac(unittest.TestCase):
    """Las funciones de iniciar.sh, cargadas con `source` (sin correr main)."""

    def correr(self, codigo: str, **entorno) -> list[str]:
        script = f'source "{(AQUI / "iniciar.sh").as_posix()}"\n{codigo}\n'
        env = {k: v for k, v in os.environ.items() if k != "DRONEPATROL_MODELO_URL"}
        env.update(entorno)
        r = subprocess.run([BASH, "-c", script], capture_output=True, timeout=60, env=env)
        salida = r.stdout.decode("utf-8", errors="replace")
        self.assertEqual(r.returncode, 0, f"{salida}\n{r.stderr.decode('utf-8', errors='replace')}")
        return salida.replace("\r", "").splitlines()

    def test_que_hacer_con_cada_entorno(self):
        lineas = []
        for (sirve, cuda, torch_cuda, sin_modulo, es_propio, hay_nvidia), _ in CASOS:
            lineas.append(
                f"PRUEBA_SIRVE={int(sirve)}; PRUEBA_CUDA={cuda}; PRUEBA_TORCH_CUDA={torch_cuda}; "
                f"PRUEBA_SIN_MODULO={int(sin_modulo)}; GPU={'NVIDIA' if hay_nvidia else ''}; "
                f"que_hacer_con {int(es_propio)}"
            )
        obtenidos = self.correr("\n".join(lineas))
        for (caso, esperado), obtenido in zip(CASOS, obtenidos):
            with self.subTest(caso=caso):
                self.assertEqual(obtenido, esperado)
        self.assertEqual(len(obtenidos), len(CASOS))

    def test_leer_la_prueba_de_un_entorno(self):
        entorno = {f"SALIDA_{i}": salida for i, ((_, salida), _) in enumerate(LECTURAS)}
        codigo = "\n".join(
            f'leer_prueba {codigo} "$SALIDA_{i}"; '
            'echo "$PRUEBA_SIRVE|$PRUEBA_CUDA|$PRUEBA_TORCH_CUDA|$PRUEBA_SIN_MODULO|$PRUEBA_DETALLE"'
            for i, ((codigo, _), _) in enumerate(LECTURAS)
        )
        obtenidos = self.correr(codigo, **entorno)
        for ((_, salida), esperado), obtenido in zip(LECTURAS, obtenidos):
            sirve, cuda, torch_cuda, sin_modulo, detalle = esperado
            with self.subTest(salida=salida[:40]):
                self.assertEqual(obtenido, f"{int(sirve)}|{cuda}|{torch_cuda}|{int(sin_modulo)}|{detalle}")

    def test_ufw_prendido_se_mira_en_su_configuracion(self):
        # `systemctl is-active ufw` da "active" aunque ufw esté apagado: lo que vale es ENABLED.
        with tempfile.TemporaryDirectory() as carpeta:
            apagado, prendido = Path(carpeta) / "apagado.conf", Path(carpeta) / "prendido.conf"
            apagado.write_text("# /etc/ufw/ufw.conf\nENABLED=no\nLOGLEVEL=low\n", encoding="utf-8")
            prendido.write_text("# /etc/ufw/ufw.conf\nENABLED=yes\nLOGLEVEL=low\n", encoding="utf-8")
            codigo = (
                "ufw() { :; }\n"  # que `command -v ufw` lo encuentre, esté instalado o no
                f'UFW_CONF="{apagado.as_posix()}" ufw_activo && echo si || echo no\n'
                f'UFW_CONF="{prendido.as_posix()}" ufw_activo && echo si || echo no\n'
                f'UFW_CONF="{(Path(carpeta) / "no-existe.conf").as_posix()}" ufw_activo && echo si || echo no\n'
            )
            self.assertEqual(self.correr(codigo), ["no", "si", "no"])

    def test_la_fuente_del_modelo_sale_limpia_de_fuente_txt(self):
        with tempfile.TemporaryDirectory() as carpeta:
            (Path(carpeta) / "fuente.txt").write_bytes(
                "\ufeff# de dónde bajar el modelo\r\n\r\n   \r\n  /media/usb/Niko's/yolo11m-2clases.pt  \r\notra\r\n"
                .encode("utf-8"))
            obtenido = self.correr(f'MODELOS="{Path(carpeta).as_posix()}"; fuente_del_modelo')
        self.assertEqual(obtenido, ["/media/usb/Niko's/yolo11m-2clases.pt"])

    def test_la_variable_de_entorno_le_gana_a_fuente_txt(self):
        with tempfile.TemporaryDirectory() as carpeta:
            (Path(carpeta) / "fuente.txt").write_text("https://ejemplo.invalid/viejo.pt\n", encoding="utf-8")
            obtenido = self.correr(f'MODELOS="{Path(carpeta).as_posix()}"; fuente_del_modelo',
                                   DRONEPATROL_MODELO_URL="https://ejemplo.invalid/m.pt")
        self.assertEqual(obtenido, ["https://ejemplo.invalid/m.pt"])


if __name__ == "__main__":
    unittest.main()
