# Software de detección (notebook de campo)

El proceso que corre en la notebook al lado del control: recibe el video que
le manda la app del celular, corre el modelo YOLO11 entrenado sobre VisDrone
(`ml/`) y le contesta a la app qué vio. Reemplaza a `detection-mock/`, que
queda como demo sin GPU; el contrato de mensajes es el mismo
([docs/PROTOCOLS.md](../docs/PROTOCOLS.md) §4).

```
Celular (app, 1280 px, ≤2 cuadros/s) ──Wi-Fi/WebSocket──▶ servidor.py ──YOLO11m──▶ detection (+frameTs) ──▶ celular
        │   ▲                                                  │
        │   └──── UDP 8766: "acá estoy" cada 1 s, por cada placa de red ─┘
        └──────── UDP 8766: "hola" de la app cada 2 s ──▶ respuesta unicast
```

## Arrancar: un clic

| Sistema | Qué se corre |
|---|---|
| Windows | **doble clic en `iniciar.bat`** (o `correr.bat`, que es el mismo atajo de siempre) |
| Linux / macOS | `./iniciar.sh` en una terminal (o `bash iniciar.sh`) |

No hace falta tener nada instalado de antemano más que el sistema: el lanzador
chequea, instala lo que falte y deja el apartado de detección listo. La primera
vez en una máquina nueva baja unos **3 GB** (torch con CUDA) y el entorno ocupa
unos 5 GB; las siguientes arranca en segundos. Los argumentos que no son del
lanzador pasan tal cual al servidor:

```bash
iniciar.bat                          # prepara lo que falte y arranca
iniciar.bat -SoloVerificar           # todo menos arrancar, y sin pedir permisos de administrador
iniciar.bat --modelo yolo11m-mix     # elegir otro modelo de modelos/
iniciar.bat --imgsz 1536 --conf 0.30
./iniciar.sh --solo-verificar        # lo mismo en Linux / macOS
```

> **`iniciar.sh` necesita permiso de ejecución.** Git solo lo conserva si el
> archivo está marcado en el repo; quien lo mantiene lo marca una vez con
> `git update-index --chmod=+x detection/iniciar.sh` y lo commitea. Mientras
> tanto, `bash iniciar.sh` funciona igual, o `chmod +x iniciar.sh` en la
> máquina.

### Qué hace cada paso

| Paso | Qué hace | Si falla |
|---|---|---|
| 1. Entorno | Busca un Python que ya importe torch, ultralytics, aiohttp y psutil, en este orden: `detection/.venv`, `../ml/.venv` y `tests ia tesis/.venv` del Escritorio. Con una NVIDIA, un entorno ajeno con torch **sin CUDA** se saltea (andaría, pero en CPU); al propio se le cambia torch. Un torch **de CUDA** que no ve la placa se usa igual: es el driver, reinstalar torch no lo arregla (y bajaría 3 GB en cada arranque) | — |
| 2. uv | Si no hay entorno que sirva, consigue [uv](https://docs.astral.sh/uv/) (lo instala en el perfil del usuario con el instalador oficial de astral.sh, **sin tocar el PATH**) y crea `detection/.venv` con **Python 3.12** (uv lo baja si no está) | Sin uv, usa un Python 3.10–3.13 del sistema. Sin ninguno, dice qué instalar |
| 3. torch | Con NVIDIA (`nvidia-smi` responde), torch del índice **cu128** de PyTorch; sin NVIDIA, el de **CPU**; en macOS, el de PyPI (trae la GPU de Apple). Después `requirements.txt`, que a propósito no fija torch | Volver a correr: retoma donde quedó |
| 4. Verificación | Importa todo y muestra si torch ve la GPU | Si la NVIDIA está pero torch no la ve: actualizar el driver (CUDA 12.8 pide la rama 570 o más nueva) |
| 5. Modelo | Asegura `modelos/yolo11m-2clases.pt` y verifica su SHA-256 (ver abajo) | Sin modelo, arranca con el **respaldo de COCO** |
| 6. Firewall | Windows: si no están las reglas `DronePatrol deteccion`, pide permiso de administrador (UAC) y las crea. Avisa si hay una VPN conectada. Linux: con ufw o firewalld activos, ofrece abrir los puertos con sudo. macOS: avisa del aviso de "Permitir" | El servidor arranca igual e imprime el comando exacto |
| 7. Arranque | Arranca `servidor.py` y abre **http://localhost:8765** en el navegador cuando el servidor contesta | — |

Con **`-SoloVerificar`** (o `--solo-verificar`) hace todo eso salvo pedir
permisos de administrador y arrancar: en su lugar corre `servidor.py
--diagnostico`, que muestra por qué placas se anunciaría, las URL para el modo
manual, si el firewall deja entrar al teléfono en la red activa y si el puerto
está libre. Es lo primero que conviene mirar cuando "no conecta".

## El modelo

Los pesos van en `modelos/*.pt` (git los ignora: pesan 40 MB). **El de campo es
`yolo11m-2clases.pt`** (YOLO11m entrenado directamente en PERSON / VEHICLE): si
está, el servidor arranca con él sin preguntar. `yolo11m-mix.pt` queda como
alternativa (`--modelo yolo11m-mix`).

Si no está, el lanzador lo consigue solo, y lo acepta **solo si coincide la
huella** (40 579 500 bytes, SHA-256 `d7d4599023e8e9be4ae5548261eb1df379a217ec9ebbfe82967fc282d386e881`):

1. Lo busca en el proyecto de entrenamiento (`tests ia tesis` del Escritorio,
   con sus subcarpetas `entrenamiento/*/weights`, `runs/*/weights`,
   `modelos/v2-*`) y en `ml/results` y `ml/runs` del repo. Ahí todos se llaman
   `best.pt`: por eso se lo reconoce por la huella y no por el nombre.
2. Si no, lo **baja del release del repo**
   ([`modelo-yolo11m-2clases-v2`](https://github.com/NikolasBerntsen/Tesis/releases/tag/modelo-yolo11m-2clases-v2),
   público, sin token) y lo verifica con su SHA-256. Otra fuente se configura
   con la variable de entorno `DRONEPATROL_MODELO_URL` o la primera línea de
   `modelos/fuente.txt` (las que empiezan con `#` se ignoran); también vale una
   ruta: un pendrive, una carpeta compartida.
3. Si nada de eso anda, avisa y sigue con el **modelo de respaldo**: el YOLO11m
   genérico de COCO (`yolo11m.pt`, ~40 MB que ultralytics baja la primera vez a
   `modelos/respaldo/`, o el de `ml/` si está). Se mapea **person → PERSON** y
   **car / truck / bus / motorcycle → VEHICLE**; las otras 75 clases se
   descartan. Anda, pero desde 50 m ve bastante peor que el entrenado. El log y
   el visor dicen claramente cuál se está usando.

Las clases se reconocen por los **nombres** del modelo, no por la cantidad: el
de 2 clases ya viene agrupado, el de 10 clases de VisDrone se agrupa acá
(personas a pie y "people" → PERSON, el resto → VEHICLE) y uno genérico se
mapea por nombre.

## Cómo se enlaza con el celular

**Por Wi-Fi, obligatoriamente.** El puerto USB del teléfono lo ocupa el cable
del control RC-N2/RC-N3, así que no hay cable posible hacia la notebook (el
USB-C de abajo del control es solo carga y DJI Assistant). Celular y notebook
tienen que estar en la misma red: el hotspot del celular, la zona con cobertura
de la notebook o la Wi-Fi del lugar.

No hay que tipear IPs. El descubrimiento es **de ida y vuelta** (UDP 8766):

- **De ida**, cada segundo el servidor se anuncia **por cada interfaz de red
  real**, con un socket atado a la IP de esa placa: al broadcast dirigido
  calculado con la **máscara verdadera** (en una red /22 como
  `192.168.68.0/22` es `192.168.71.255`, no `.255` del tercer octeto) y a
  `255.255.255.255`. Se saltean loopback, APIPA (`169.254.x.x`, una placa sin
  IP del DHCP), las desconectadas y las virtuales (VMware, VirtualBox,
  Hyper-V/WSL, VPN TAP/TUN, Bluetooth). En Windows también se mira la
  descripción del adaptador, porque el TAP de una VPN puede llamarse
  "Ethernet 2". Al arrancar, el log dice `placa (ip/prefijo) -> broadcast` y
  cuáles ignoró y por qué.
- **De vuelta**, mientras busca, la app manda un "hola" por broadcast cada 2 s
  y el servidor **le contesta por unicast** a su IP. Así el enlace se arma
  aunque el broadcast de la PC se pierda (una VPN con mejor métrica, un router
  que no lo reenvía): el del teléfono casi siempre llega. El log dice
  `Teléfono encontrado: <nombre> (<ip>)`.

Si nada de eso alcanza, en la app se elige **Dirección manual** y se escribe una
de las URL que el servidor lista al arrancar (`ws://<ip-de-la-notebook>:8765`).

### Firewall

En Windows el lanzador crea dos reglas de entrada, en **todos los perfiles**:

```powershell
New-NetFirewallRule -DisplayName 'DronePatrol deteccion TCP 8765' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Profile Any
New-NetFirewallRule -DisplayName 'DronePatrol deteccion UDP 8766' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8766 -Profile Any
```

TCP 8765 es el video y las detecciones; UDP 8766, el "hola" de la app. Son por
**puerto** y no por programa a propósito: no dependen de qué Python se use, y
el permiso que pregunta Windows la primera vez suele quedar solo para redes
**públicas** mientras la Wi-Fi de la casa es **privada** (fue la falla de
campo: en la PC todo andaba, el teléfono encontraba la notebook y la conexión
moría en silencio). Al arrancar, el servidor revisa además si alguna regla
**bloquea** a Python (se crea sola al tocar "Cancelar" en ese aviso, y gana a
cualquier permiso) y lo dice con el comando para sacarla.

En Linux, con ufw: `sudo ufw allow 8765/tcp && sudo ufw allow 8766/udp`; con
firewalld: `sudo firewall-cmd --permanent --add-port=8765/tcp --add-port=8766/udp && sudo firewall-cmd --reload`.
En macOS, aceptar el "Permitir conexiones entrantes" la primera vez.

## Problemas típicos

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| La app dice "Buscando el software de detección…" para siempre | Teléfono en **otra red**: la de invitados, otra banda con aislamiento de clientes, datos móviles | Misma Wi-Fi y no la de invitados. Probar con el hotspot del teléfono |
| Ídem, con una VPN en la PC | La VPN (ExpressVPN y similares) se lleva el broadcast o bloquea la red local ("Network Lock") | Desconectarla. El lanzador avisa si hay una conectada |
| "La laptop se anunció en … pero no contesta: revisá el firewall" | El firewall no deja entrar al 8765 en el perfil de la red activa | `iniciar.bat` (crea las reglas) o el comando de arriba. `iniciar.bat -SoloVerificar` dice qué perfil falta |
| La app menciona "cable USB", `adb reverse`, `127.0.0.1` o una IP vieja | El **modo de enlace** quedó en **CABLE** o **RED** guardado de una prueba de banco | En la app: menú de campo → Enlace → **Automático** |
| El visor dice "celular conectado" pero `Errores` sube | Llegan cuadros pero el modelo falla (o el JPEG viene roto) | El visor muestra el cuadro crudo con el error escrito arriba y el último error abajo de los contadores |
| `Recibidos` queda en 0 con el celular conectado | La app no está mandando video (pantalla de operación cerrada, sin video del dron) | Abrir la pantalla de operación; el video sale aunque el dron esté en tierra |
| "El puerto 8765 ya está en uso" | Otra ventana del servidor (o `detection-mock`) abierta | Cerrarla. Si lo tiene otro programa, `--puerto 8770` (el anuncio lleva el puerto); con dos servidores de detección abiertos, no: los dos se anuncian y la app salta de uno a otro |
| Cada cuadro tarda segundos | No hay GPU (o torch no la ve) | `--imgsz 640`, o revisar el driver de NVIDIA. El log avisa en CPU |

## Correr a mano

Con un entorno que ya tenga todo:

```bash
python servidor.py                        # elige el modelo (o el único que haya)
python servidor.py --sin-modelo           # solo el visor con botones, como el mock
python servidor.py --diagnostico          # red, firewall y puerto; no carga nada
```

| Flag | Default | Para qué |
|---|---|---|
| `--modelo` | menú | Nombre del `.pt` en `modelos/` |
| `--pesos` | — | Ruta a un `.pt` cualquiera |
| `--imgsz` | `1280` | Resolución de inferencia. Los cuadros llegan a 1280 px; `1536` detecta algo más y cuesta más; en CPU, `640` |
| `--conf` | `0.35` | Umbral de confianza |
| `--device` | el mejor | `cuda` (o `0`), `mps` (Mac con Apple Silicon) o `cpu`. Pedir uno que no hay es un error, no una caída callada a CPU |
| `--puerto` | `8765` | Puerto del WebSocket y del visor |
| `--sin-anuncio` | — | Sin descubrimiento UDP (ni anuncio ni respuesta al "hola"): solo modo manual |
| `--sin-modelo` | — | Sin inferencia: solo visor y botones |
| `--abrir-visor` | — | Abrir el visor en el navegador cuando el servidor contesta (lo usa el lanzador) |
| `--sin-revisar-firewall` | — | No revisar el Firewall de Windows al arrancar |
| `--diagnostico` | — | Revisar red, firewall y puerto, y salir |

## El visor

**http://localhost:8765**: el video anotado, el estado del enlace con la **IP
del teléfono**, el último "hola" recibido, por qué placas se anuncia y las URL
para el modo manual, y los contadores **recibidos / procesados / errores /
descartados** con el tiempo del modelo. Las estadísticas llegan **una vez por
segundo pase lo que pase con el modelo**: así "no llega nada" (Recibidos
quieto) se distingue de "llega y falla" (Errores subiendo, cuadro crudo con el
error). Dos botones **simulan una detección** para la demo sin dron, atada al
último cuadro recibido.

## Cómo funciona por dentro

- **Una cola de un solo cuadro** entre el socket y el hilo del modelo. Si la
  GPU va más lenta que el enlace se descarta el cuadro viejo: la latencia no
  crece nunca, y en video en vivo lo viejo no sirve.
- Por cada cuadro procesado sale **un `detection`** (detectado o no) con las
  **cajas normalizadas** (centro y tamaño 0..1), el **`frameTs`** (el `ts` del
  cuadro, la hora de captura con el reloj del teléfono, devuelto tal cual) y,
  si detectó algo, la **captura anotada** (640 px) que la app adjunta a la
  alerta. Con `frameTs` la app georreferencia la caja con la pose del dron en
  el instante del cuadro y no con la de cuando llegó la respuesta (entre una y
  otra pasan de 0,3 a 1 s). Es la app la que decide qué hacer con cada
  detección (ver `PatrolManager`).
- Si la inferencia falla, al teléfono no va nada (un "no detecté" sería
  mentira) y al visor va el cuadro crudo con el error.
- `servidor.py` se puede importar sin cargar torch ni el modelo: lo usan las
  pruebas y el modo `--diagnostico`.

## Pruebas

```bash
cd detection
..\ml\.venv\Scripts\python.exe -m unittest -v     # o el Python que eligió el lanzador
```

`test_servidor.py` cubre las piezas puras (broadcast con la máscara verdadera,
filtro de placas virtuales, adónde sale el anuncio de cada placa, mapeo de
clases de 2 clases / VisDrone / COCO, el `detection` con `frameTs`, el "hola" de
la app, la elección del dispositivo, la evaluación de las reglas del firewall),
que el hilo del modelo sobreviva a un cuadro que rompe, y el camino de un
cuadro por el WebSocket real en loopback, con un detector de mentira: no cargan
ningún modelo ni tocan la GPU. `test_lanzadores.py` prueba las decisiones de
`iniciar.ps1` (en Windows) e `iniciar.sh` (donde haya bash; en Windows, el de
Git for Windows) cargando sus funciones sueltas: qué hacer con cada entorno de
Python encontrado, cuándo ufw está prendido y de dónde se baja el modelo. No
instalan ni bajan nada.

## Probar sin dron ni celular

Con el servidor corriendo, la app en el **emulador** llega a esta PC por
`ws://10.0.2.2:8765` (modo *Dirección manual*), y el dron simulado le manda su
video sintético. Con el dron real, el flavor `dji` de la app manda el video de
la cámara.
