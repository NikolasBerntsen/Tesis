# Despliegue en la nube de Oracle

El Comando Central corre como **un solo contenedor Docker** (el backend sirve la
API, el WebSocket y el build del frontend) en una **VM de Oracle compartida con
otros proyectos**, detrás del **Caddy general de la VM**: un Caddy que vive en
`~/caddy`, fuera de cualquier repo, es el único que publica 80/443 y saca los
certificados de todos los sitios.

- URL del sistema: **https://tesis.144-22-138-149.sslip.io**

## Cómo funciona el despliegue continuo

Mismo mecanismo que los otros proyectos de la VM: **no hay registry de imágenes ni agente en
el servidor**. El runner de GitHub copia el código y la VM construye.

```
push / merge a main
      │
      ▼
 CI (.github/workflows/ci.yml): backend · consola · app Android   ~45 s en paralelo
      │                                    │
      │ las tres en verde                  └──▶ SonarQube (calidad y cobertura)  ~6 min
      ▼                                             (publica el tablero; no frena nada)
 deploy.yml, llamado como workflow reutilizable
      │  rsync -az --delete   (excluye .git, .env, node_modules, dist, android-app)
      ▼
 VM de Oracle (variable VM_HOST) · /home/ubuntu/tesis
      │  bash deploy/deploy.sh update → build, up, escribe ~/caddy/conf/sites/tesis.caddy
      ▼
 Contenedor 'comando-central' en la red 'proxy'  ←— Caddy general de la VM
```

Si alguna de las tres suites falla, el despliegue no corre. Se puede disparar a
mano desde **Actions → Deploy a la VM → Run workflow**; con el campo `ref` (un
commit o tag) despliega una versión anterior: es el **rollback**.

**El análisis de SonarQube corre al costado, no adelante.** Antes el despliegue
colgaba del workflow entero (`workflow_run`), así que esperaba también a ese
análisis: seis minutos de medición de calidad entre el merge y la VM
actualizada. Y ni siquiera funcionaba como control de calidad — la acción del
scanner termina bien aunque el quality gate falle, así que lo único que aportaba
al despliegue era la espera. Los tests son de quienes de verdad depende que el
código ande, y son los que lo frenan.

Medido: del merge a la VM actualizada, ~1 minuto en vez de ~7.

## Las contraseñas de la demostración

El seed crea los cuatro usuarios con las contraseñas que están en el informe.
Son públicas a propósito: es lo que permite que cualquiera entre a probar el
sistema. Cada una se puede pisar con `SEED_PASSWORD_<USUARIO>` (o
`SEED_PASSWORD` para todas) en el `.env` de la VM.

Con `NODE_ENV=production` y alguna de fábrica puesta, el seed **avisa** en el
registro y sigue. Para que además **corte**, se define `SEED_STRICT=true`.

Que cortar sea opt-in viene de haberlo hecho mal primero. Cuando el chequeo
cortaba siempre, el despliegue del 21/9 dejó la VM sin backend: el contenedor
arranca con `node dist/seed.js && node dist/index.js`, así que el seed que
tiraba se llevaba puesta la aplicación y el contenedor quedó reiniciándose en
loop. Dos arreglos, no uno: el chequeo dejó de ser terminante por defecto, y el
`&&` pasó a `;` para que ningún error del seed pueda volver a tumbar al
servidor. Los datos de demostración son deseables, no imprescindibles; el
esquema de la base lo crea `db.ts` al importarse, no el seed.

## Convivencia con los otros proyectos

| Situación | Qué pasa |
|---|---|
| Se despliega la tesis | Sólo se recrea su contenedor: ~5 s sin responder en `tesis.…`. Los otros sitios no se enteran. |
| Se despliega otro proyecto | Escribe **su** archivo de sitio y recarga el Caddy general sin cortar: la tesis no se entera. |
| Otro proyecto corre su `reset` | Borra **sus** volúmenes. La base de la tesis (volumen `cc-data`) no se toca: son proyectos distintos de Docker Compose. Tampoco toca al Caddy. |
| Se borra o recrea la red `proxy` | Hay que volver a levantar los stacks. `deploy.sh` recrea la red si falta. |

Cuidados sobre recursos compartidos: la VM es una Ampere A1 del *free tier*.
Cada despliegue compila en la VM, así que durante esos minutos los otros
proyectos andan más lentos. `deploy.sh update` hace `docker image prune -f` (borra sólo
imágenes huérfanas, nunca las que están en uso), lo que ayuda a que el disco no
se llene — que es la falla más común en esa máquina.

## Qué hay que preparar una sola vez

### 1. La clave SSH y las variables (ya están)

Es **la misma VM** que los otros proyectos, así que se reutiliza la misma clave
privada. El workflow acepta el secret con cualquiera de los dos nombres:
`VM_SSH_KEY` u `ORACLE_SSH_KEY` (Settings → Secrets and variables → Actions).

Lo demás son **variables del repo** (pestaña Variables), no secrets: el YAML no
tiene ningún dato de la VM escrito.

| Variable | Para qué |
|---|---|
| `VM_HOST` | IP pública de la VM |
| `VM_USER` | Usuario SSH (`ubuntu`) |
| `DEPLOY_PATH` | Carpeta del proyecto en la VM (`/home/ubuntu/tesis`) |
| `APP_DOMAIN` | Dominio público (`tesis.<ip-con-guiones>.sslip.io`) |
| `CADDY_CONTAINER` | Contenedor del Caddy general (`caddy`) |
| `CADDY_SITES_DIR` | Carpeta de sitios del Caddy general (`/home/ubuntu/caddy/conf/sites`) |
| `DEV_WIPE_DB` | Ver más abajo |

Si alguna vez hay que rehacer la clave:

```bash
ssh-keygen -t ed25519 -N "" -C "github-deploy" -f ci_key      # en tu máquina
# ci_key.pub va a ~/.ssh/authorized_keys de la VM; la privada se sube desde el archivo:
tr -d '\r' < ci_key | gh secret set VM_SSH_KEY --repo NikolasBerntsen/Tesis
```

### 2. El sitio en el Caddy general (lo hace el deploy)

No hay que tocar ningún otro repo. En cada despliegue, `deploy/deploy.sh` escribe
**su** archivo en la carpeta de sitios del Caddy general:

```caddy
# ~/caddy/conf/sites/tesis.caddy — lo escribe deploy/deploy.sh; no editar a mano.
tesis.<ip-con-guiones>.sslip.io {
	encode zstd gzip
	reverse_proxy comando-central:4000
}
```

Comprueba que el Caddy de verdad lo lee, **valida** la configuración y recién
entonces recarga; si algo falla, restaura el archivo anterior (un archivo roto
tiraría todos los sitios de la VM en el próximo reinicio de Caddy).

`sslip.io` resuelve solo cualquier nombre que lleve la IP con guiones, así que no
hay que configurar DNS. Caddy pide y renueva el certificado por su cuenta, y
reenvía las conexiones WebSocket (`/ws`) sin configuración extra.

La red compartida `proxy` ya existe en la VM (si faltara, la crea `deploy/deploy.sh`).

### 3. Puertos de Oracle

**No hay que abrir nada nuevo.** La tesis no publica puertos: entra por el 80/443
del Caddy general, que ya están abiertos en la Security List.

## `DEV_WIPE_DB`: borrar la base en cada despliegue

Bandera pensada para la etapa de desarrollo, mientras el esquema todavía se
mueve y volver a sembrar de cero es más rápido que migrar a mano.

Con **`true`**, cada despliegue baja el stack con `down -v` —lo que elimina el
volumen `cc-data`— y lo vuelve a levantar; el contenedor siembra la base al
arrancar, así que el sistema queda con los usuarios y drones de demostración.
Con **`false`**, o sin definir, los datos quedan intactos. Se revisa en **cada**
despliegue, y el resultado se imprime en el registro de Actions.

Se fija en un solo lugar: la **variable del repositorio** (Settings → Secrets and
variables → Actions → **Variables** → `DEV_WIPE_DB`). Cualquier valor que no sea
`true` —o no tenerla— se toma como `false`: ante la duda, no se borra. (Un
`DEV_WIPE_DB` en el `.env` de la VM ya no se tiene en cuenta.)

> **Antes de que haya datos reales, ponerla en `false`.** Con `true` no hay
> confirmación ni vuelta atrás, y el borrado corre solo con cada merge a `main`.
> El borrado manual con confirmación escrita sigue siendo `deploy.sh reset`.

## Despliegue a mano en la VM (opcional)

```bash
ssh -i /ruta/a/la-clave.key ubuntu@<VM_HOST>
cd ~/tesis            # el rsync del workflow crea esta carpeta
bash deploy/deploy.sh update            # build + up conservando los datos ('up' es lo mismo)
bash deploy/deploy.sh status            # salud, último despliegue y URL
bash deploy/deploy.sh set-env NOMBRE    # guarda un valor en el .env sin mostrarlo
```

`update` crea el `.env` con un `JWT_SECRET` aleatorio si no existe, crea la red si
falta, construye la imagen, deja el sitio en el Caddy general y espera a que el
contenedor esté sano. El dominio lo toma de la última corrida del workflow
(guardado en el `.env` como `DEPLOY_APP_DOMAIN`).

## Diagnóstico

```bash
# En la VM
cd ~/tesis
docker compose -f docker-compose.prod.yml ps
bash deploy/deploy.sh logs

# Desde afuera
curl -s https://<APP_DOMAIN>/api/health
```

| Síntoma | Causa más probable |
|---|---|
| `502 Bad Gateway` en `tesis.…` | El contenedor está caído o fuera de la red `proxy` |
| El navegador no resuelve o da timeout | Falta `tesis.caddy` en `~/caddy/conf/sites`, o el Caddy general está caído: `docker ps`, `docker logs caddy` |
| "Caddy no la publica" en el deploy | `CADDY_CONTAINER`/`CADDY_SITES_DIR` no coinciden con la VM, o el Caddy general no importa `sites/*.caddy` |
| `Permission denied (publickey)` en Actions | El secret con la clave está vacío o mal pegado |
| `port is already allocated` | Alguien le agregó `ports:` al compose: la tesis no debe publicar puertos |
| `no space left on device` al construir | Imágenes acumuladas de los proyectos: `docker builder prune -f` y `docker image prune -f` en la VM (nunca `--volumes`) |
| Se cerraron todas las sesiones | Se regeneró el `.env` y cambió `JWT_SECRET` |

## Límites conocidos

- **Rollback**: Run workflow con `ref` (un commit o tag). Vuelve el código, no la
  base, y el próximo merge a `main` despliega lo último otra vez; para quedarse
  en una versión vieja, revertir el commit en `main`.
- **Ventana de caída**: `up -d --build` recrea el contenedor; hay unos segundos
  sin servicio. No hay despliegue azul/verde.
- **Backups**: manuales. La base es un archivo SQLite dentro del volumen
  `cc-data` (`docker cp comando-central:/data/comando-central.db .`).
- **`reset` es sólo manual** y pide confirmación escrita. El borrado automático
  en cada despliegue existe aparte, con `DEV_WIPE_DB`, y está apagado por
  defecto.

## Probarlo localmente

```bash
docker network create proxy 2>/dev/null || true
JWT_SECRET=dev-secreto docker compose -f docker-compose.prod.yml up --build -d
docker run --rm --network proxy curlimages/curl -s http://comando-central:4000/api/health
```
