# Despliegue en la nube de Oracle

El Comando Central corre como **un solo contenedor Docker** (el backend sirve la
API, el WebSocket y el build del frontend) en la **misma VM de Oracle que el otro
proyecto**, detrás del **Caddy que ya está corriendo ahí**.

- URL del sistema: **https://tesis.144-22-138-149.sslip.io**
- URL del otro proyecto: https://panel.144-22-138-149.sslip.io *(no cambia)*

## Cómo funciona el despliegue continuo

Mismo mecanismo que el otro proyecto: **no hay registry de imágenes ni agente en
el servidor**. El runner de GitHub copia el código y la VM construye.

```
push / merge a main
      │
      ▼
 Workflow "CI"  (.github/workflows/ci.yml)      tests y cobertura
      │  conclusion == success
      ▼
 Workflow "Deploy a Oracle Cloud"  (.github/workflows/deploy.yml)
      │  rsync -az --delete   (excluye .git, .env, node_modules, dist, android-app)
      ▼
 VM Oracle 144.22.138.149 · /home/ubuntu/tesis
      │  bash deploy/deploy.sh update → docker compose up -d --build
      ▼
 Contenedor 'comando-central' en la red 'proxy'  ←— Caddy del otro proyecto
```

Si el CI falla, el despliegue no corre. Se puede disparar a mano desde
**Actions → Deploy a Oracle Cloud → Run workflow**.

## Convivencia con el otro proyecto

| Situación | Qué pasa |
|---|---|
| Se despliega la tesis | Sólo se recrea su contenedor: ~5 s sin responder en `tesis.…`. `panel.…` no se entera. |
| Se despliega el otro proyecto | Al recrear Caddy hay unos segundos en que **ambos** sitios no responden desde afuera. El contenedor de la tesis sigue vivo y no pierde nada. |
| El otro proyecto corre su `reset` | Borra **sus** volúmenes. La base de la tesis (volumen `cc-data`) no se toca: son proyectos distintos de Docker Compose. |
| Se borra o recrea la red `proxy` | Hay que volver a levantar ambos stacks. `deploy.sh` recrea la red si falta. |

Cuidados sobre recursos compartidos: la VM es una Ampere A1 del *free tier*.
Cada despliegue compila en la VM, así que durante esos minutos el otro proyecto
anda más lento. `deploy.sh update` hace `docker image prune -f` (borra sólo
imágenes huérfanas, nunca las que están en uso), lo que ayuda a que el disco no
se llene — que es la falla más común en esa máquina.

## Qué hay que preparar una sola vez

### 1. La clave SSH (ya está)

Es **la misma VM**, así que se reutiliza la misma clave privada que usa el otro
proyecto. El workflow acepta el secret con cualquiera de los dos nombres:
`ORACLE_SSH_KEY` o `VM_SSH_KEY` (Settings → Secrets and variables → Actions).
La IP y el usuario van fijos en el YAML, no como secrets.

Si alguna vez hay que rehacerla:

```bash
ssh-keygen -t ed25519 -f ci_key -C "github-deploy"      # en tu máquina
# el contenido de ci_key.pub va a ~/.ssh/authorized_keys de la VM
# el contenido completo de ci_key (privada) va al secret del repo
```

### 2. El bloque en el Caddyfile del otro proyecto

El Caddy que ya corre en la VM es el que da HTTPS y decide qué sitio va a qué
contenedor. Hay que agregarle este bloque **en el repo del otro proyecto**
(`deploy/Caddyfile`), no a mano en la VM: su propio `rsync --delete` lo pisaría.

```caddy
tesis.144-22-138-149.sslip.io {
	reverse_proxy comando-central:4000
}
```

`sslip.io` resuelve solo cualquier nombre que lleve la IP con guiones, así que no
hay que configurar DNS. Caddy pide y renueva el certificado por su cuenta, y
reenvía las conexiones WebSocket (`/ws`) sin configuración extra.

Y su servicio `caddy` en `docker-compose.prod.yml` tiene que estar también en la
red compartida:

```yaml
  caddy:
    networks:
      - default
      - proxy
# …al final del archivo
networks:
  proxy:
    external: true
```

La red se crea una sola vez en la VM (o la crea `deploy/deploy.sh`):

```bash
docker network create proxy
```

### 3. Puertos de Oracle

**No hay que abrir nada nuevo.** La tesis no publica puertos: entra por el 80/443
del Caddy, que ya están abiertos en la Security List para el otro proyecto.

## `DEV_WIPE_DB`: borrar la base en cada despliegue

Bandera pensada para la etapa de desarrollo, mientras el esquema todavía se
mueve y volver a sembrar de cero es más rápido que migrar a mano.

Con **`true`**, cada despliegue baja el stack con `down -v` —lo que elimina el
volumen `cc-data`— y lo vuelve a levantar; el contenedor siembra la base al
arrancar, así que el sistema queda con los usuarios y drones de demostración.
Con **`false`**, o sin definir, los datos quedan intactos. Se revisa en **cada**
despliegue, y el resultado se imprime en el registro de Actions.

Se puede fijar en dos lugares:

| Dónde | Cómo | Cuándo conviene |
|---|---|---|
| Variable del repositorio | Settings → Secrets and variables → Actions → **Variables** → `DEV_WIPE_DB` | Para prenderla y apagarla sin entrar a la VM |
| `.env` de la VM | `DEV_WIPE_DB=true` en `/home/ubuntu/tesis/.env` | Para que quede atada a esa máquina |

La variable del repositorio **le gana** al `.env`. Si no está definida, manda el
`.env`. Cualquier valor que no sea `true` (o `1`, `si`, `yes`) se toma como
`false`: ante la duda, no se borra.

> **Antes de que haya datos reales, ponerla en `false`.** Con `true` no hay
> confirmación ni vuelta atrás, y el borrado corre solo con cada merge a `main`.
> El borrado manual con confirmación escrita sigue siendo `deploy.sh reset`.

## Primer despliegue manual (opcional)

```bash
ssh ubuntu@144.22.138.149
cd ~/tesis            # el rsync del workflow crea esta carpeta
bash deploy/deploy.sh up
```

`up` crea el `.env` con un `JWT_SECRET` aleatorio si no existe, crea la red si
falta, construye la imagen y espera a que el contenedor esté sano.

## Diagnóstico

```bash
# En la VM
cd ~/tesis
docker compose -f docker-compose.prod.yml ps
bash deploy/deploy.sh logs

# Desde afuera
curl -s https://tesis.144-22-138-149.sslip.io/api/health
```

| Síntoma | Causa más probable |
|---|---|
| `502 Bad Gateway` en `tesis.…` | El contenedor está caído o fuera de la red `proxy` |
| El navegador no resuelve o da timeout | Falta el bloque en el Caddyfile del otro proyecto, o su Caddy no está en la red `proxy` |
| `Permission denied (publickey)` en Actions | El secret con la clave está vacío o mal pegado |
| `port is already allocated` | Alguien le agregó `ports:` al compose: la tesis no debe publicar puertos |
| `no space left on device` al construir | Imágenes acumuladas de los dos proyectos: `docker system prune -f` en la VM |
| Se cerraron todas las sesiones | Se regeneró el `.env` y cambió `JWT_SECRET` |

## Límites conocidos

- **Rollback**: no hay. Volver atrás es revertir el commit en `main` y esperar el
  siguiente despliegue.
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
