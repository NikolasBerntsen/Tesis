"""
Genera las dos texturas del fondo de la consola: la piedra negra con vetas de
oro (noche, data-tema="oscuro") y el mármol blanco con vetas grises y algunas
doradas (día, data-tema="claro").

Uso (desde la raíz del repo, con cualquier Python que tenga numpy y Pillow):

    python frontend/scripts/generar-vetas.py

Escribe frontend/src/assets/vetas-noche.webp y vetas-dia.webp, y anota en
frontend/src/test/vetas.json el píxel más claro y el más oscuro de cada una:
contraste.test.ts mide los paneles translúcidos contra esos dos extremos, así
que si se regeneran las texturas el test se entera solo.

Por qué así y no con ruido a secas: las vetas como curvas de nivel de un ruido
(la versión del prototipo) dibujan anillos cerrados alrededor de cada máximo
del ruido, y esos "ojitos" se leen como manchas, no como piedra. Acá cada veta
es una grieta: un camino que avanza con una dirección general, se tuerce de a
poco y se ramifica. Así no se cierra sobre sí misma, que es como se ve una veta
de verdad (y una grieta reparada con oro, el kintsugi del que sale la idea).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ANCHO, ALTO = 2560, 1600
SUPER = 2  # las líneas se dibujan al doble y se reducen: bordes suaves sin escalones
RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "src" / "assets"
EXTREMOS = RAIZ / "src" / "test" / "vetas.json"


def ruido_suave(rng: np.random.Generator, escala: int) -> np.ndarray:
    """Ruido de valor: una grilla aleatoria agrandada con bicúbica (0..1)."""
    grilla = rng.random((max(2, ALTO // escala + 2), max(2, ANCHO // escala + 2)))
    img = Image.fromarray((grilla * 255).astype(np.uint8)).resize((ANCHO, ALTO), Image.BICUBIC)
    # La bicúbica sola deja ver la grilla (manchas cuadradas en la piedra
    # oscura); un desenfoque de media celda la borra.
    img = img.filter(ImageFilter.GaussianBlur(escala / 2))
    return np.asarray(img, np.float32) / 255


def nubes(semilla: int, escalas=(640, 320, 160, 80)) -> np.ndarray:
    """Turbulencia de pocas octavas: la mancha blanda de la piedra."""
    rng = np.random.default_rng(semilla)
    capas = [ruido_suave(rng, e) / (i + 1) for i, e in enumerate(escalas)]
    total = sum(capas) / sum(1 / (i + 1) for i in range(len(escalas)))
    return (total - total.min()) / (total.max() - total.min())


def perfil(rng: np.random.Generator, n: int, suavidad: float) -> np.ndarray:
    """Una curva 0..1 que varía despacio a lo largo de n pasos (ancho, brillo)."""
    v = np.cumsum(rng.normal(0, 1, n))
    v = np.convolve(v, np.ones(int(suavidad)) / int(suavidad), mode="same")
    v -= v.min()
    return v / (v.max() or 1)


class Lienzo:
    """Una máscara 0..1 donde se dibujan las grietas, al doble de resolución."""

    def __init__(self) -> None:
        self.img = Image.new("L", (ANCHO * SUPER, ALTO * SUPER), 0)
        self.trazo = ImageDraw.Draw(self.img)

    def segmento(self, a, b, ancho: float, brillo: float) -> None:
        w = max(1, round(ancho * SUPER))
        valor = int(255 * min(1.0, brillo))
        pa = (a[0] * SUPER, a[1] * SUPER)
        pb = (b[0] * SUPER, b[1] * SUPER)
        self.trazo.line([pa, pb], fill=valor, width=w)
        r = w / 2
        # Juntas redondas: sin ellas, en cada quiebre aparece una muesca.
        self.trazo.ellipse([pb[0] - r, pb[1] - r, pb[0] + r, pb[1] + r], fill=valor)

    def mascara(self) -> np.ndarray:
        chica = self.img.resize((ANCHO, ALTO), Image.LANCZOS)
        return np.asarray(chica, np.float32) / 255


def grieta(
    lienzo: Lienzo,
    rng: np.random.Generator,
    origen,
    rumbo: float,
    largo: float,
    ancho: float,
    brillo: float,
    ramas: float,
    nivel: int = 0,
) -> None:
    """Un camino que sigue su rumbo general, se tuerce y a veces se abre en ramas."""
    paso = 4.0
    n = max(8, int(largo / paso))
    anchos = 0.45 + 0.55 * perfil(rng, n, 60)
    brillos = 0.35 + 0.65 * perfil(rng, n, 90)
    # Las ramas se afinan hasta desaparecer; la veta madre sólo en las puntas.
    afinado = np.ones(n)
    if nivel > 0:
        afinado = np.linspace(1, 0.05, n) ** 0.8
    else:
        borde = min(n // 6, 60)
        afinado[:borde] = np.linspace(0.2, 1, borde)
        afinado[-borde:] = np.linspace(1, 0.2, borde)

    x, y = origen
    # El desvío respecto del rumbo cambia con inercia (giro) y vuelve despacio
    # a cero; acotado a ±1 rad, la grieta nunca da la vuelta sobre sí misma.
    desvio, giro = 0.0, 0.0
    for i in range(n):
        giro = giro * 0.96 + rng.normal(0, 0.0035)
        # De vez en cuando, un quiebre seco: la grieta cambia de idea de golpe.
        golpe = rng.normal(0, 0.3) if rng.random() < 0.008 else 0.0
        desvio = float(np.clip(desvio * 0.997 + giro + golpe, -1.0, 1.0))
        angulo = rumbo + desvio
        quiebre = rng.normal(0, 0.12)  # el temblor de la grieta, sin acumular
        nx = x + math.cos(angulo + quiebre) * paso
        ny = y + math.sin(angulo + quiebre) * paso
        if not (-80 < nx < ANCHO + 80 and -80 < ny < ALTO + 80):
            break
        lienzo.segmento((x, y), (nx, ny), ancho * anchos[i] * afinado[i], brillo * brillos[i])
        x, y = nx, ny
        if nivel < 2 and rng.random() < ramas:
            lado = rng.choice((-1, 1))
            grieta(
                lienzo,
                rng,
                (x, y),
                angulo + lado * rng.uniform(0.35, 0.95),
                largo=rng.uniform(90, 420) / (nivel + 1),
                ancho=ancho * rng.uniform(0.45, 0.7),
                brillo=brillo * rng.uniform(0.6, 0.95),
                ramas=ramas * 0.5,
                nivel=nivel + 1,
            )


def red_de_grietas(semilla: int, cantidad: int, ancho, brillo, ramas, rumbo_medio: float) -> np.ndarray:
    """Varias grietas con un rumbo parecido, repartidas por toda la imagen.

    Cada una nace en un punto cualquiera y se traza hacia los dos lados hasta
    salir del cuadro: así las vetas cubren parejo y no se amontonan contra el
    borde donde arrancan.
    """
    rng = np.random.default_rng(semilla)
    lienzo = Lienzo()
    for _ in range(cantidad):
        origen = (rng.uniform(0, ANCHO), rng.uniform(0, ALTO))
        rumbo = rumbo_medio + rng.normal(0, 0.3)
        comun = dict(ancho=rng.uniform(*ancho), brillo=rng.uniform(*brillo), ramas=ramas)
        grieta(lienzo, rng, origen, rumbo, largo=rng.uniform(900, 2400), **comun)
        grieta(lienzo, rng, origen, rumbo + math.pi, largo=rng.uniform(900, 2400), **comun)
    return lienzo.mascara()


def desenfoque(m: np.ndarray, radio: float) -> np.ndarray:
    img = Image.fromarray(np.clip(m * 255, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radio)), np.float32) / 255


def tramado(rng: np.random.Generator, img: np.ndarray) -> np.ndarray:
    """Medio escalón de ruido antes de cuantizar: sin esto, la piedra oscura se
    ve en bandas en un monitor bueno."""
    return np.clip(img + rng.uniform(-0.5, 0.5, img.shape), 0, 255).astype(np.uint8)


def noche() -> np.ndarray:
    piedra = nubes(1)
    fondo = np.stack([9 + 11 * piedra, 8 + 9 * piedra, 7 + 6 * piedra], -1)
    # Las vetas madre: pocas, finas y brillantes, con su resplandor.
    oro = red_de_grietas(11, 8, ancho=(1.2, 2.2), brillo=(0.7, 1.0), ramas=0.009, rumbo_medio=0.62)
    # Un tejido de vetas finísimas y apagadas: la profundidad de la piedra.
    pelo = red_de_grietas(23, 14, ancho=(0.6, 1.0), brillo=(0.15, 0.35), ramas=0.006, rumbo_medio=0.55)
    halo = np.clip(desenfoque(oro, 3) * 1.0 + desenfoque(oro, 16) * 0.7, 0, 1)
    # El oro no llega al blanco: con el núcleo más claro, el panel que pasa por
    # encima de una grieta se aclaraba tanto que el texto de color bajaba de AA.
    nucleo = np.array([226, 182, 98], np.float32)
    resplandor = np.array([196, 138, 48], np.float32)
    bronce = np.array([120, 86, 36], np.float32)
    img = fondo * (1 - pelo[..., None]) + bronce * pelo[..., None]
    img = img + resplandor * 0.42 * halo[..., None]
    img = img * (1 - oro[..., None]) + nucleo * oro[..., None]
    return tramado(np.random.default_rng(5), img)


def dia() -> np.ndarray:
    marmol = nubes(2)
    fondo = np.stack([240 + 8 * marmol, 236 + 8 * marmol, 227 + 7 * marmol], -1)
    # Vetas grises blandas: dos redes desenfocadas, una ancha y una fina.
    gris_ancha = desenfoque(red_de_grietas(41, 8, ancho=(3.0, 6.0), brillo=(0.6, 1.0), ramas=0.01, rumbo_medio=0.7), 7)
    gris_fina = desenfoque(red_de_grietas(43, 12, ancho=(0.9, 1.6), brillo=(0.5, 0.9), ramas=0.008, rumbo_medio=0.62), 1.1)
    gris = np.clip(gris_ancha * 0.34 + gris_fina * 0.42, 0, 1)
    # Unas pocas vetas de oro, finas y nítidas.
    oro = red_de_grietas(51, 4, ancho=(1.2, 2.0), brillo=(0.75, 1.0), ramas=0.007, rumbo_medio=0.58)
    tono_gris = np.array([150, 144, 134], np.float32)
    # Un oro claro: de día la veta más oscura es la que apaga la tinta de los
    # paneles que pasan por encima.
    tono_oro = np.array([214, 174, 90], np.float32)
    img = fondo * (1 - gris[..., None]) + tono_gris * gris[..., None]
    img = img * (1 - oro[..., None]) + tono_oro * oro[..., None]
    return tramado(np.random.default_rng(6), img)


def luminancia(rgb: np.ndarray) -> np.ndarray:
    """Luminancia relativa de WCAG, la misma fórmula que src/test/wcag.ts."""
    s = rgb.astype(np.float64) / 255
    lineal = np.where(s <= 0.03928, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)
    return lineal @ np.array([0.2126, 0.7152, 0.0722])


def hexa(px) -> str:
    return "#{:02X}{:02X}{:02X}".format(*(int(c) for c in px))


def guardar(nombre: str, pixeles: np.ndarray, calidad: int) -> dict:
    ruta = SALIDA / nombre
    Image.fromarray(pixeles).save(ruta, quality=calidad, method=6)
    # Los extremos se leen del archivo ya comprimido: es lo que se pinta.
    leido = np.asarray(Image.open(ruta).convert("RGB"))
    lum = luminancia(leido.reshape(-1, 3))
    plano = leido.reshape(-1, 3)
    clara, oscura = plano[lum.argmax()], plano[lum.argmin()]
    print(f"{nombre}: {ruta.stat().st_size / 1024:.0f} KB, más clara {hexa(clara)}, más oscura {hexa(oscura)}")
    return {"clara": hexa(clara), "oscura": hexa(oscura)}


def main() -> None:
    SALIDA.mkdir(parents=True, exist_ok=True)
    extremos = {
        "oscuro": guardar("vetas-noche.webp", noche(), 82),
        "claro": guardar("vetas-dia.webp", dia(), 80),
    }
    EXTREMOS.write_text(json.dumps(extremos, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
