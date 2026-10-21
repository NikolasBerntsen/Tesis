# Lanzador de un clic del software de detección (Windows).
#
# Se abre con iniciar.bat (doble clic). Deja todo listo y arranca el servidor:
#
#   1. Busca un entorno de Python que ya tenga todo (torch, ultralytics, aiohttp,
#      psutil) y lo reutiliza.
#   2. Si no hay, consigue "uv" (lo instala en el perfil del usuario con el
#      instalador oficial) y crea detection\.venv con Python 3.12.
#   3. Instala torch: con una NVIDIA, el de CUDA; sin NVIDIA, el de CPU. Después,
#      el resto de requirements.txt.
#   4. Verifica que todo importe y si torch ve la GPU.
#   5. Consigue el modelo entrenado (lo copia de las carpetas conocidas o lo baja
#      de una URL configurable, verificando el SHA-256). Sin modelo, se sigue con
#      el de respaldo de COCO.
#   6. Revisa el Firewall de Windows y, si faltan las reglas, pide permiso de
#      administrador (UAC) para crearlas.
#   7. Arranca el servidor y abre el visor en el navegador.
#
#   iniciar.bat                          # todo, y arranca
#   iniciar.bat -SoloVerificar           # todo menos arrancar (y sin pedir permisos de administrador)
#   iniciar.bat --modelo yolo11m-mix     # lo que no es de este script va tal cual a servidor.py
#
# Este archivo tiene que quedar en UTF-8 CON BOM: sin BOM, Windows PowerShell
# 5.1 lo lee como ANSI y cada acento de los mensajes sale roto.

param([switch]$SoloVerificar)

$ErrorActionPreference = 'Stop'
$AQUI = $PSScriptRoot
$REPO = Split-Path $AQUI -Parent
$VENV = Join-Path $AQUI '.venv'
$MODELOS = Join-Path $AQUI 'modelos'
# El modelo de campo y su huella: la copia o la descarga se aceptan solo si
# coinciden, así un .pt a medio bajar o el de otro entrenamiento no pasan.
$MODELO = 'yolo11m-2clases.pt'
$MODELO_BYTES = 40579500
$MODELO_SHA256 = 'd7d4599023e8e9be4ae5548261eb1df379a217ec9ebbfe82967fc282d386e881'
$PYTHON_VERSION = '3.12'
$INDICE_CUDA = 'https://download.pytorch.org/whl/cu128'
$INDICE_CPU = 'https://download.pytorch.org/whl/cpu'
$REGLA = 'DronePatrol deteccion'
$PUERTO_UDP = 8766
# Además de si torch ve la GPU, si el torch instalado TRAE CUDA (torch.version.cuda):
# no es lo mismo un torch de CPU (se arregla reinstalándolo) que uno de CUDA que
# no ve la placa porque el driver es viejo (reinstalarlo no cambia nada). La
# línea va marcada porque torch avisa por stderr justo en ese caso.
$PRUEBA = "import torch, ultralytics, aiohttp, psutil, cv2, numpy; " +
          "print('ENTORNO', torch.__version__, torch.cuda.is_available(), torch.version.cuda is not None)"

# Los argumentos que no son de este script van al servidor. --solo-verificar
# también se acepta así, para que valga lo mismo que en iniciar.sh.
$ArgsServidor = @()
foreach ($a in $args) {
    if ($a -eq '--solo-verificar') { $SoloVerificar = $true } else { $ArgsServidor += $a }
}
$PUERTO = 8765
for ($i = 0; $i -lt $ArgsServidor.Count - 1; $i++) {
    if ($ArgsServidor[$i] -eq '--puerto') { $PUERTO = [int]$ArgsServidor[$i + 1] }
}

# ---------------------------------------------------------------------------
# Mensajes
# ---------------------------------------------------------------------------

function Paso([int]$n, [string]$texto) { Write-Host ''; Write-Host "[$n/7] $texto" -ForegroundColor Cyan }
function Bien([string]$texto) { Write-Host "      OK  $texto" -ForegroundColor Green }
function Aviso([string]$texto) { Write-Host "      !!  $texto" -ForegroundColor Yellow }
function Info([string]$texto) { Write-Host "          $texto" }
function Fallar([string]$texto, [string[]]$queHacer) {
    Write-Host ''
    Write-Host "  ERROR: $texto" -ForegroundColor Red
    foreach ($l in $queHacer) { Write-Host "         $l" -ForegroundColor Red }
    exit 1
}

function Correr([string]$exe, [string[]]$argumentos) {
    # Corre un programa y devuelve su código y su salida (stdout y stderr juntos).
    # Con 2>&1, PowerShell 5.1 convierte cada línea de stderr en un error, y con
    # 'Stop' en una excepción, aunque el programa termine bien: por eso acá
    # adentro la preferencia se baja a 'Continue'.
    $antes = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $salida = & $exe @argumentos 2>&1 | ForEach-Object { "$_" }
        $codigo = $LASTEXITCODE
    } catch {
        $salida = "$_"
        $codigo = -1
    } finally {
        $ErrorActionPreference = $antes
    }
    return [pscustomobject]@{ Codigo = $codigo; Salida = (@($salida) -join "`n").Trim() }
}

function Nativo([string]$exe, [string[]]$argumentos) {
    # Corre un programa mostrando su salida en vivo (las descargas largas tienen
    # que verse avanzar) y devuelve su código. 'Continue' por lo mismo que en
    # Correr: uv y pip escriben el progreso por stderr, y si la salida de este
    # script se redirige, PowerShell 5.1 lo tomaría como un error y cortaría.
    $ErrorActionPreference = 'Continue'
    & $exe @argumentos | Out-Host
    return $LASTEXITCODE
}

function Escritorios {
    # El Escritorio puede estar redirigido a OneDrive: se prueban los dos.
    return @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop')) |
        Where-Object { $_ } | Select-Object -Unique
}

# ---------------------------------------------------------------------------
# 1. Entorno de Python
# ---------------------------------------------------------------------------

function Hay-Nvidia {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) { return $null }
    $r = Correr $smi.Source @('--query-gpu=name,driver_version,memory.total', '--format=csv,noheader')
    if ($r.Codigo -ne 0 -or -not $r.Salida) { return $null }
    return ($r.Salida -split "`n")[0].Trim()
}

function Leer-Prueba([int]$codigo, [string]$salida) {
    # @{ Sirve; Cuda; TorchConCuda; Detalle; SinModulo } a partir de lo que imprimió $PRUEBA.
    $linea = [regex]::Match($salida, '(?m)^ENTORNO (\S+) (True|False) (True|False)\s*$')
    if ($codigo -eq 0 -and $linea.Success) {
        return [pscustomobject]@{ Sirve = $true; Cuda = ($linea.Groups[2].Value -eq 'True')
            TorchConCuda = ($linea.Groups[3].Value -eq 'True'); Detalle = "torch $($linea.Groups[1].Value)"; SinModulo = $false }
    }
    $falta = [regex]::Match($salida, "No module named '([^']+)'")
    $detalle = if ($falta.Success) { "le falta $($falta.Groups[1].Value)" } else { ($salida -split "`n")[-1] }
    return [pscustomobject]@{ Sirve = $false; Cuda = $false; TorchConCuda = $false; Detalle = $detalle; SinModulo = $falta.Success }
}

function Probar-Entorno([string]$py) {
    # Si importa todo lo del servidor y si torch ve la GPU (ver Leer-Prueba); $null si no existe.
    if (-not (Test-Path -LiteralPath $py)) { return $null }
    $r = Correr $py @('-c', $PRUEBA)
    return Leer-Prueba $r.Codigo $r.Salida
}

function Que-Hacer-Con($prueba, [bool]$esPropio, [bool]$hayNvidia) {
    # usar / usar-sin-gpu / reinstalar-torch / saltear / completar / no-sirve.
    if ($prueba.Sirve -and $hayNvidia -and -not $prueba.Cuda) {
        # torch de CUDA que igual no ve la placa: es el driver (o la placa), no
        # el entorno. Reinstalarlo o armar otro entorno bajaría 3 GB en CADA
        # arranque para terminar igual: se usa y el paso 4 dice qué actualizar.
        if ($prueba.TorchConCuda) { return 'usar-sin-gpu' }
        # El propio sí se toca: se le cambia torch por el de CUDA (paso 3). Uno
        # ajeno no: andaría, pero en CPU, y eso no llega a tiempo real.
        if ($esPropio) { return 'reinstalar-torch' }
        return 'saltear'
    }
    if ($prueba.Sirve) { return 'usar' }
    if ($esPropio -and $prueba.SinModulo) { return 'completar' }
    return 'no-sirve'
}

Write-Host ''
Write-Host '  Software de detección - preparación y arranque' -ForegroundColor White
if ($SoloVerificar) { Write-Host '  (modo verificación: no arranca el servidor ni pide permisos de administrador)' }

Paso 1 'Entorno de Python'
$GPU = Hay-Nvidia
if ($GPU) { Info "GPU NVIDIA: $GPU" } else { Info 'Sin GPU NVIDIA (nvidia-smi no responde): la detección va a ir en CPU.' }

$propio = Join-Path $VENV 'Scripts\python.exe'
$candidatos = @($propio, (Join-Path $REPO 'ml\.venv\Scripts\python.exe'))
foreach ($e in (Escritorios)) { $candidatos += (Join-Path $e 'tests ia tesis\.venv\Scripts\python.exe') }
$candidatos = $candidatos | Select-Object -Unique

$PY = $null
$reinstalarTorch = $false
$completarPropio = $false
foreach ($c in $candidatos) {
    $p = Probar-Entorno $c
    if ($null -eq $p) { continue }
    $accion = Que-Hacer-Con $p ($c -eq $propio) ([bool]$GPU)
    if ($accion -eq 'reinstalar-torch') {
        Aviso "$c tiene torch sin CUDA y esta PC tiene una NVIDIA: se le reinstala torch."
        $PY = $c; $reinstalarTorch = $true; break
    }
    if ($accion -eq 'saltear') { Aviso "$c tiene torch sin CUDA (iría en CPU, lento): no se usa."; continue }
    if ($accion -eq 'usar-sin-gpu') {
        Aviso "$c tiene torch con CUDA pero no ve la NVIDIA: es el driver, no el entorno (ver el paso 4). Se usa igual."
        $PY = $c; break
    }
    if ($accion -eq 'usar') { $PY = $c; Bien "$c ($($p.Detalle)$(if ($p.Cuda) { ', con CUDA' }))"; break }
    if ($accion -eq 'completar') {
        Aviso "$c está incompleto ($($p.Detalle)): se completa."
        $PY = $c; $completarPropio = $true; break
    }
    Info "$c no sirve: $($p.Detalle)"
}

# ---------------------------------------------------------------------------
# 2. uv y el entorno nuevo
# ---------------------------------------------------------------------------

function Buscar-Uv {
    $enPath = Get-Command uv -ErrorAction SilentlyContinue
    $lugares = @()
    if ($enPath) { $lugares += $enPath.Source }
    $lugares += @((Join-Path $env:USERPROFILE '.local\bin\uv.exe'), (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe'),
                  (Join-Path $env:LOCALAPPDATA 'Programs\uv\uv.exe'))
    foreach ($l in $lugares) { if ($l -and (Test-Path -LiteralPath $l)) { return $l } }
    return $null
}

function Instalar-Uv {
    # El instalador oficial de Astral, en el perfil del usuario (no pide
    # administrador). UV_NO_MODIFY_PATH: que no toque el PATH del usuario; este
    # script lo llama por su ruta completa y no le hace falta.
    Info 'Instalando uv (el instalador oficial de astral.sh, en tu perfil de usuario)...'
    $env:UV_NO_MODIFY_PATH = '1'
    $comando = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor ' +
               '[Net.SecurityProtocolType]::Tls12; irm https://astral.sh/uv/install.ps1 | iex'
    $r = Correr 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $comando)
    if ($r.Codigo -ne 0) { Info ($r.Salida -split "`n" | Select-Object -Last 3) }
    return Buscar-Uv
}

function Python-DelSistema {
    # El respaldo si uv no se pudo instalar: un Python 3.10..3.13 ya instalado.
    foreach ($v in @('3.12', '3.11', '3.13', '3.10')) {
        $r = Correr 'py' @("-$v", '-c', 'import sys; print(sys.executable)')
        if ($r.Codigo -eq 0 -and $r.Salida) { return ($r.Salida -split "`n")[-1].Trim() }
    }
    $r = Correr 'python' @('-c', 'import sys; print(sys.version_info >= (3, 10) and sys.version_info < (3, 14), sys.executable)')
    if ($r.Codigo -eq 0 -and $r.Salida -like 'True *') { return $r.Salida.Substring(5).Trim() }
    return $null
}

$UV = $null
$creado = $false
if (-not $PY -or $reinstalarTorch -or $completarPropio) {
    Paso 2 'Herramienta de instalación (uv)'
    $UV = Buscar-Uv
    if (-not $UV) { $UV = Instalar-Uv }
    if ($UV) {
        Bien "uv: $UV"
    } else {
        Aviso 'No se pudo instalar uv (¿sin internet, o un proxy que bloquea astral.sh?): pruebo con el Python del sistema.'
    }
    if (-not $PY) {
        try { $libre = (Get-PSDrive -Name (Split-Path $AQUI -Qualifier).TrimEnd(':')).Free } catch { $libre = 100GB }
        if ($libre -lt 8GB) {
            Aviso ("Quedan {0:N1} GB libres en el disco y el entorno ocupa unos 5 GB: puede no alcanzar." -f ($libre / 1GB))
        }
        if ($UV) {
            Info "Creando detection\.venv con Python $PYTHON_VERSION (uv lo baja si no está)..."
            if ((Nativo $UV @('venv', '--python', $PYTHON_VERSION, $VENV)) -ne 0) {
                Fallar 'uv no pudo crear el entorno.' @('Revisá la conexión a internet y volvé a correr iniciar.bat.',
                    "Si quedó a medias, borrá la carpeta $VENV antes.")
            }
        } else {
            $base = Python-DelSistema
            if (-not $base) {
                Fallar 'No hay uv ni un Python 3.10 a 3.13 instalado.' @(
                    'Instalá Python 3.12 desde https://www.python.org/downloads/ (tildá "Add python.exe to PATH")',
                    'o conectate a internet para que se instale uv, y volvé a correr iniciar.bat.')
            }
            Info "Creando detection\.venv con $base ..."
            if ((Nativo $base @('-m', 'venv', $VENV)) -ne 0) { Fallar "No se pudo crear el entorno con $base." @("Borrá $VENV y volvé a probar.") }
        }
        $PY = $propio
        $creado = $true
    }
} else {
    Paso 2 'Herramienta de instalación (uv)'
    Bien 'No hace falta: el entorno ya tiene todo.'
}

# ---------------------------------------------------------------------------
# 3. torch y el resto
# ---------------------------------------------------------------------------

function Instalar([string[]]$paquetes) {
    # Con uv si está (mucho más rápido); si no, con el pip del entorno.
    if ($UV) { $codigo = Nativo $UV (@('pip', 'install', '--python', $PY) + $paquetes) }
    else { $codigo = Nativo $PY (@('-m', 'pip', 'install') + $paquetes) }
    return ($codigo -eq 0)
}

function Desinstalar([string[]]$paquetes) {
    if ($UV) { Nativo $UV (@('pip', 'uninstall', '--python', $PY) + $paquetes) | Out-Null }
    else { Nativo $PY (@('-m', 'pip', 'uninstall', '-y') + $paquetes) | Out-Null }
}

function Dejar-SoloOpencvHeadless {
    # ultralytics pide opencv-python y requirements.txt la versión sin ventanas:
    # las dos escriben la misma carpeta cv2 y la que se instaló última pisa a la
    # otra. Se deja solo la headless, reinstalada, para que cv2 sea uno solo.
    $codigo = "import importlib.metadata as m; n = {(d.metadata['Name'] or '').lower() for d in m.distributions()}; " +
              "print('opencv-python' in n and 'opencv-python-headless' in n)"
    $r = Correr $PY @('-c', $codigo)
    if ($r.Salida -ne 'True') { return }
    Info 'Quedaron opencv-python y opencv-python-headless juntos: se deja solo la headless.'
    Desinstalar @('opencv-python')
    if ($UV) { Instalar @('--reinstall-package', 'opencv-python-headless', 'opencv-python-headless') | Out-Null }
    else { Instalar @('--force-reinstall', '--no-deps', 'opencv-python-headless') | Out-Null }
}

$hayQueInstalar = $creado -or $reinstalarTorch -or $completarPropio
Paso 3 'torch y dependencias'
if ($hayQueInstalar) {
    if ($GPU) { $indice = $INDICE_CUDA; $cual = 'con CUDA 12.8 (para la NVIDIA)' } else { $indice = $INDICE_CPU; $cual = 'para CPU' }
    $tieneTorch = (Correr $PY @('-c', 'import torch')).Codigo -eq 0
    if ($reinstalarTorch -or -not $tieneTorch) {
        Aviso "Se instala torch $cual. La descarga ronda 3 GB y puede tardar varios minutos: no cierres la ventana."
        if ($reinstalarTorch) { Desinstalar @('torch', 'torchvision') }
        if (-not (Instalar @('torch', 'torchvision', '--index-url', $indice))) {
            Fallar 'No se pudo instalar torch.' @('Revisá la conexión a internet y volvé a correr iniciar.bat (retoma donde quedó).',
                "Índice usado: $indice")
        }
    }
    Info 'Instalando el resto (requirements.txt)...'
    if (-not (Instalar @('-r', (Join-Path $AQUI 'requirements.txt')))) {
        Fallar 'No se pudieron instalar las dependencias de requirements.txt.' @('Revisá la conexión y volvé a correr iniciar.bat.')
    }
    Dejar-SoloOpencvHeadless
    Bien 'Dependencias instaladas.'
} else {
    Bien 'Nada que instalar.'
}

# ---------------------------------------------------------------------------
# 4. Verificación
# ---------------------------------------------------------------------------

function Que-Hacer-Si-No-Importa([string]$salida) {
    # El consejo según el error. En una Windows recién instalada, lo típico es
    # que a torch (o a OpenCV) le falte el runtime de Visual C++: "WinError 126
    # ... fbgemm.dll" o "DLL load failed". Rehacer el entorno no lo arregla, y
    # bajaría otros 3 GB para terminar en el mismo error.
    if ($salida -match 'WinError 126|DLL load failed|\.dll\b') {
        return @('A torch le falta una biblioteca de Windows: el "Microsoft Visual C++ Redistributable" (x64).',
                 'Instalalo desde https://aka.ms/vs/17/release/vc_redist.x64.exe y volvé a correr iniciar.bat.')
    }
    return @("Borrá $VENV y volvé a correr iniciar.bat para rehacerlo.")
}

Paso 4 'Verificación'
$verificar = "import torch, ultralytics, aiohttp, psutil, cv2; c = torch.cuda.is_available(); " +
             "print('torch', torch.__version__, '| ultralytics', ultralytics.__version__, '| CUDA:', " +
             "torch.cuda.get_device_name(0) if c else 'no'); print(c)"
$r = Correr $PY @('-c', $verificar)
if ($r.Codigo -ne 0) {
    Fallar 'El entorno no importa lo que necesita el servidor.' (@($r.Salida -split "`n" | Select-Object -Last 2) +
        @(Que-Hacer-Si-No-Importa $r.Salida))
}
$lineas = $r.Salida -split "`n"
Bien "Python: $PY"
Bien $lineas[-2]
if ($GPU -and $lineas[-1].Trim() -ne 'True') {
    Aviso 'La PC tiene una NVIDIA pero torch no la ve: la detección va a ir en CPU (segundos por cuadro).'
    Info 'Actualizá el driver de NVIDIA (CUDA 12.8 pide la rama 570 o más nueva) y volvé a correr iniciar.bat.'
}

# ---------------------------------------------------------------------------
# 5. Modelo
# ---------------------------------------------------------------------------

function Huella([string]$ruta) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $ruta).Hash.ToLower() }

function Buscar-ModeloLocal {
    # En el proyecto de entrenamiento (con sus subcarpetas: runs/*/weights,
    # entrenamiento/*/weights, modelos/v2-*) y en ml/ del repo. Se reconoce por
    # la huella y no por el nombre: ahí todos se llaman best.pt.
    $carpetas = @()
    foreach ($e in (Escritorios)) { $carpetas += (Join-Path $e 'tests ia tesis') }
    $carpetas += @((Join-Path $REPO 'ml\results'), (Join-Path $REPO 'ml\runs'))
    $porNombre = $null
    foreach ($c in ($carpetas | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $c)) { continue }
        $pts = Get-ChildItem -LiteralPath $c -Recurse -Depth 5 -File -Filter '*.pt' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(\.venv|site-packages|datasets)\\' }
        foreach ($f in $pts) {
            if ($f.Length -eq $MODELO_BYTES -and (Huella $f.FullName) -eq $MODELO_SHA256) { return $f.FullName }
            if (-not $porNombre -and $f.Name -eq $MODELO) { $porNombre = $f.FullName }
        }
    }
    return $porNombre
}

function Fuente-DelModelo {
    # Una URL (o una ruta: pendrive, carpeta compartida) de donde bajarlo, si se configuró.
    if ($env:DRONEPATROL_MODELO_URL) { return $env:DRONEPATROL_MODELO_URL.Trim() }
    $archivo = Join-Path $MODELOS 'fuente.txt'
    if (Test-Path -LiteralPath $archivo) {
        $linea = Get-Content -LiteralPath $archivo | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } |
            Select-Object -First 1
        if ($linea) { return $linea.Trim() }
    }
    return $null
}

function Bajar-Modelo([string]$fuente, [string]$destino) {
    $temporal = "$destino.descarga"
    try {
        if (Test-Path -LiteralPath $fuente) {
            Copy-Item -LiteralPath $fuente -Destination $temporal -Force
        } else {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            # La barra de progreso de PowerShell 5.1 hace la descarga diez veces más lenta.
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $fuente -OutFile $temporal -UseBasicParsing
        }
    } catch {
        Aviso "No se pudo bajar el modelo de $fuente : $($_.Exception.Message)"
        Remove-Item -LiteralPath $temporal -ErrorAction SilentlyContinue
        return $false
    }
    $tam = (Get-Item -LiteralPath $temporal).Length
    $huella = Huella $temporal
    if ($tam -ne $MODELO_BYTES -or $huella -ne $MODELO_SHA256) {
        Aviso "Lo que se bajó no es el modelo esperado ($tam bytes, SHA-256 $huella): se descarta."
        Remove-Item -LiteralPath $temporal -ErrorAction SilentlyContinue
        return $false
    }
    Move-Item -LiteralPath $temporal -Destination $destino -Force
    return $true
}

Paso 5 'Modelo'
$destino = Join-Path $MODELOS $MODELO
if (Test-Path -LiteralPath $destino) {
    if ((Huella $destino) -eq $MODELO_SHA256) {
        Bien "modelos\$MODELO (SHA-256 verificado)"
    } else {
        Aviso "modelos\$MODELO no coincide con el SHA-256 conocido (¿otro entrenamiento?): se usa igual."
    }
} else {
    New-Item -ItemType Directory -Force -Path $MODELOS | Out-Null
    $origen = Buscar-ModeloLocal
    $fuente = Fuente-DelModelo
    if ($origen) {
        Copy-Item -LiteralPath $origen -Destination $destino
        Bien "Copiado desde $origen"
        if ((Huella $destino) -ne $MODELO_SHA256) { Aviso 'Se llama igual pero no coincide con el SHA-256 conocido: se usa igual.' }
    } elseif ($fuente) {
        Info "Bajando el modelo de $fuente ..."
        if (Bajar-Modelo $fuente $destino) { Bien "Bajado y verificado: modelos\$MODELO" }
    }
    if (-not (Test-Path -LiteralPath $destino)) {
        Aviso "No está $MODELO ni lo encontré en las carpetas conocidas."
        Info 'Se arranca con el modelo de RESPALDO (YOLO11m de COCO, ~40 MB que baja ultralytics la primera vez):'
        Info 'anda, pero ve bastante peor desde el aire. Para el entrenado: copialo a detection\modelos\, o poné una'
        Info 'URL (o ruta) en la variable DRONEPATROL_MODELO_URL o en detection\modelos\fuente.txt.'
    }
}

# ---------------------------------------------------------------------------
# 6. Firewall y red
# ---------------------------------------------------------------------------

function Reglas-Que-Faltan {
    $faltan = @()
    foreach ($r in @(@{ Nombre = "$REGLA TCP $PUERTO"; Protocolo = 'TCP'; Puerto = $PUERTO },
                     @{ Nombre = "$REGLA UDP $PUERTO_UDP"; Protocolo = 'UDP'; Puerto = $PUERTO_UDP })) {
        $existe = Get-NetFirewallRule -DisplayName $r.Nombre -ErrorAction SilentlyContinue |
            Where-Object { "$($_.Enabled)" -eq 'True' }
        if (-not $existe) { $faltan += $r }
    }
    return $faltan
}

function Comando-Regla($r) {
    return "New-NetFirewallRule -DisplayName '$($r.Nombre)' -Direction Inbound -Action Allow " +
           "-Protocol $($r.Protocolo) -LocalPort $($r.Puerto) -Profile Any"
}

Paso 6 'Firewall de Windows y red'
foreach ($red in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
    Info "Red activa: $($red.Name) en $($red.InterfaceAlias) (perfil $($red.NetworkCategory))"
}
$vpn = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
    $_.Status -eq 'Up' -and "$($_.InterfaceDescription) $($_.Name)" -match 'VPN|TAP|TUN|WireGuard|Wintun|Tailscale|ZeroTier' })
foreach ($v in $vpn) {
    Aviso "Hay una VPN conectada ($($v.Name): $($v.InterfaceDescription)). Puede llevarse el tráfico de la red local:"
    Info 'si el teléfono no encuentra la PC, desconectala (y apagá su "bloqueo de red").'
}
$faltan = @(Reglas-Que-Faltan)
if ($faltan.Count -eq 0) {
    Bien "Reglas de entrada '$REGLA' (TCP $PUERTO y UDP $PUERTO_UDP) presentes."
} else {
    $comandos = @($faltan | ForEach-Object { Comando-Regla $_ })
    $esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($SoloVerificar) {
        Aviso "Faltan reglas de entrada: $(($faltan | ForEach-Object { $_.Nombre }) -join ', ')."
        Info 'Otra regla (la de Python, por ejemplo) puede estar dejando entrar igual: el diagnóstico del paso 7 lo dice.'
        Info 'Las propias son por puerto y no dependen de qué Python se use. Se crean así (PowerShell como administrador):'
        foreach ($c in $comandos) { Info "  $c" }
        Info 'o corriendo iniciar.bat sin -SoloVerificar, que pide el permiso y las crea.'
    } else {
        Info 'Para que el teléfono pueda conectarse hacen falta dos reglas de entrada en el Firewall'
        Info "(TCP $PUERTO para el video, UDP $PUERTO_UDP para que la app encuentre la PC)."
        try {
            if ($esAdmin) {
                foreach ($c in $comandos) { Invoke-Expression $c | Out-Null }
            } else {
                Info 'Windows va a pedir permiso de administrador: aceptá en la ventana que aparece.'
                Start-Process -FilePath 'powershell' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ($comandos -join '; '))
            }
        } catch {
            Aviso "No se crearon las reglas: $($_.Exception.Message)"
        }
        $faltan = @(Reglas-Que-Faltan)
        if ($faltan.Count -eq 0) {
            Bien 'Reglas creadas.'
        } else {
            Aviso 'Siguen faltando reglas (¿se rechazó el permiso?). El servidor arranca igual; si el teléfono no conecta,'
            Info 'creálas en PowerShell como administrador:'
            foreach ($c in $comandos) { Info "  $c" }
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Arranque
# ---------------------------------------------------------------------------

$servidor = Join-Path $AQUI 'servidor.py'
if ($SoloVerificar) {
    Paso 7 'Diagnóstico del servidor (sin arrancarlo)'
    & $PY $servidor --diagnostico @ArgsServidor
    $codigo = $LASTEXITCODE
    Write-Host ''
    if ($codigo -eq 0) {
        Write-Host '  Listo. Para arrancar la detección: iniciar.bat (doble clic).' -ForegroundColor Green
    } else {
        Write-Host '  Hay que resolver lo de arriba antes de arrancar.' -ForegroundColor Yellow
    }
    exit $codigo
}
Paso 7 'Arranque'
Info "Cargando el modelo (unos segundos); el visor se abre solo en el navegador: http://localhost:$PUERTO"
Info 'Para cortar: Ctrl+C en esta ventana.'
Write-Host ''
& $PY $servidor --abrir-visor @ArgsServidor
exit $LASTEXITCODE
