# Despliegue en la nube de Oracle

El sistema se despliega como **un solo contenedor Docker** que sirve la API, el
WebSocket y la web (el backend sirve el build del frontend desde `./public`).
Cada push a `main` reconstruye la imagen y actualiza la VM automáticamente.

## Cómo funciona el despliegue continuo

`.github/workflows/deploy.yml` hace, en cada push a `main`:

1. **Construye** la imagen con el `Dockerfile` de la raíz (frontend + backend).
2. La **publica** en GHCR (el registro de contenedores de GitHub), etiquetada
   con el SHA del commit y como `latest`.
3. **Entra por SSH** a tu VM de Oracle y corre `docker compose pull` +
   `up -d`, con lo que baja la imagen nueva y reinicia el contenedor.

## Qué tenés que preparar una sola vez

### 1. En la VM de Oracle

La VM (Linux con Docker) tiene que tener, en el home del usuario, una carpeta
`~/comando-central/` con dos archivos:

- `docker-compose.prod.yml` — copialo de la raíz del repo.
- `.env` — con el secreto del JWT:

  ```
  JWT_SECRET=<una cadena larga y aleatoria>
  ```

  Generá el valor con `openssl rand -hex 32`. **Este archivo no va al repo.**

Abrí el puerto 80 en la *security list* de la subred de Oracle y en el firewall
de la VM (`sudo firewall-cmd --add-service=http --permanent && sudo firewall-cmd --reload`).

### 2. La clave SSH — **acá va tu pregunta**

El workflow entra a la VM con una clave SSH que guardás como *secret* del repo.
Pasos:

1. **Generá un par de claves** solo para el despliegue (en tu máquina):

   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-deploy"
   ```

   Esto crea `deploy_key` (privada) y `deploy_key.pub` (pública).

2. **Autorizá la pública en la VM**: agregá el contenido de `deploy_key.pub` a
   `~/.ssh/authorized_keys` del usuario de la VM (por ejemplo `opc` o `ubuntu`).

3. **Cargá los secrets en GitHub**: en el repo, **Settings → Secrets and
   variables → Actions → New repository secret**, creá estos cuatro:

   | Secret | Valor |
   |---|---|
   | `ORACLE_HOST` | La IP pública de tu VM de Oracle |
   | `ORACLE_USER` | El usuario SSH de la VM (`opc`, `ubuntu`, …) |
   | `ORACLE_SSH_KEY` | El contenido **completo** del archivo `deploy_key` (la clave **privada**, incluidas las líneas `BEGIN`/`END`) |
   | `GITHUB_TOKEN` | *No hace falta crearlo*: GitHub lo provee solo |

   > **Es `ORACLE_SSH_KEY` la clave que preguntabas dónde poner.** Va como
   > secret del repositorio, nunca en el código ni en la VM. La pública va en la
   > VM; la privada, en este secret.

4. Guardá la privada `deploy_key` en un lugar seguro y borrala de tu carpeta de
   trabajo si no la necesitás más.

Con eso, el próximo push a `main` despliega solo. Podés dispararlo a mano desde
la pestaña **Actions → Deploy → Run workflow**.

## Probarlo localmente antes

```bash
docker build -t comando-central .
docker run -p 8080:4000 -e JWT_SECRET=dev-secreto -v cc-data:/data comando-central
# abrir http://localhost:8080  (usuarios de demo del README)
```
