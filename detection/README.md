# Software de detección (notebook de campo)

El proceso que corre en la notebook al lado del control: recibe el video que
le manda la app del celular, corre el modelo YOLO11 entrenado sobre VisDrone
(`ml/`) y le contesta a la app qué vio. Reemplaza a `detection-mock/`, que
queda como demo sin GPU; el contrato de mensajes es el mismo
([docs/PROTOCOLS.md](../docs/PROTOCOLS.md) §4).

```
Celular (app, 1280 px, ≤2 cuadros/s) ──Wi-Fi/WebSocket──▶ servidor.py ──YOLO11m──▶ detection ──▶ celular
                                                              │
                      UDP 8766 ◀── "estoy acá" cada 1 s ──────┘   (la app encuentra la notebook sola)
```

## Cómo se enlaza con el celular

**Por Wi-Fi, obligatoriamente.** El puerto USB del teléfono lo ocupa el cable
del control RC-N2/RC-N3, así que no hay cable posible hacia la notebook (el
USB-C de abajo del control es solo carga y DJI Assistant). Celular y notebook
tienen que estar en la misma red: el hotspot del celular o la Wi-Fi del lugar.

No hay que tipear IPs: el servidor **anuncia** su presencia por UDP a toda la
red cada segundo y la app, en modo de enlace *Automático* (el de fábrica), lo
escucha y se conecta. Si los anuncios no llegan (alguna red filtra los
broadcast), en la app se puede elegir *Dirección manual* y escribir
`ws://<ip-de-la-notebook>:8765`.

> **Firewall de Windows.** La primera vez que se corre, Windows pregunta si
> dejar que Python acepte conexiones: hay que permitirlo en redes **privadas y
> públicas** (el hotspot de un celular suele clasificarse como pública).

## Correr

```bash
correr.bat                        # elige el modelo por menú (o el único que haya)
correr.bat --modelo yolo11m-mix   # directo
correr.bat --imgsz 1536 --conf 0.30
correr.bat --sin-modelo           # solo el visor con botones, como el mock
```

`correr.bat` busca un entorno de Python con las dependencias: `.venv` en esta
carpeta, el de `tests ia tesis` del Escritorio o el de `../ml`. En una máquina
nueva (una GPU NVIDIA hace falta para que sea en tiempo real):

```bash
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
```

Los pesos van en `modelos/*.pt` (git los ignora: pesan 40 MB). Los entrenados
en la tesis son `yolo11m-mix.pt` (mejor sobre video continuo, el escenario
real) y `yolo11m-2clases.pt` (mejor sobre fotos sueltas); se copian desde
`ml/results` o desde el proyecto de entrenamiento.

El visor queda en **http://localhost:8765**: el video anotado, el estado del
enlace con el celular, los tiempos del modelo y dos botones para **simular una
detección** (para la demo sin dron, igual que hacía el mock).

| Flag | Default | Para qué |
|---|---|---|
| `--modelo` | menú | Nombre del `.pt` en `modelos/` |
| `--pesos` | — | Ruta a un `.pt` cualquiera |
| `--imgsz` | `1280` | Resolución de inferencia. Los cuadros llegan a 1280 px; `1536` detecta algo más y cuesta más |
| `--conf` | `0.35` | Umbral de confianza |
| `--device` | GPU si hay | `cpu` para forzar CPU (lento, solo para probar) |
| `--puerto` | `8765` | Puerto del WebSocket y del visor |
| `--sin-anuncio` | — | No anunciar por UDP |
| `--sin-modelo` | — | Sin inferencia: solo visor y botones |

## Cómo funciona por dentro

- **Una cola de un solo cuadro** entre el socket y el hilo del modelo. Si la
  GPU va más lenta que el enlace se descarta el cuadro viejo: la latencia no
  crece nunca, y en video en vivo lo viejo no sirve.
- Por cada cuadro procesado sale **un `detection`** (detectado o no): es la
  app la que decide qué hacer con él (solo reacciona patrullando, ver
  `PatrolManager`).
- Las 10 clases de VisDrone se agrupan en `PERSON` / `VEHICLE` acá si el modelo
  no viene ya agrupado; se decide por los nombres de las clases.
- El cuadro anotado va a los visores con calidad 70; al celular solo va el
  JSON.

## Probar sin dron ni celular

Con el servidor corriendo, la app en el **emulador** llega a esta PC por
`ws://10.0.2.2:8765` (modo *Dirección manual*), y el dron simulado le manda su
video sintético. Con el dron real, el flavor `dji` de la app manda el video de
la cámara.
