# SonarQube: calidad, cobertura y tests

SonarQube analiza el código de los tres componentes (backend, consola web y app
Android) y muestra, además de bugs y code smells, **la cobertura y la ejecución
de los tests** que ya corren en CI. Este documento explica qué quedó configurado
y qué hay que hacer una sola vez para prenderlo.

## Qué mira, y de dónde saca los datos

Todo el mapa está en [`sonar-project.properties`](../sonar-project.properties),
en la raíz. El repositorio se analiza como **un solo proyecto de Sonar**: es un
monorepo, pero los tres componentes forman un sistema y conviene verlos juntos.

| Qué | De qué archivo sale | Quién lo genera |
|---|---|---|
| Cobertura del backend | `backend/coverage/lcov.info` | `npm run test:cov` (vitest + v8) |
| Cobertura de la consola | `frontend/coverage/lcov.info` | `npm run test:cov` |
| Cobertura de la app | `android-app/app/build/reports/coverage/test/mock/debug/report.xml` | `./gradlew createMockDebugUnitTestCoverageReport` (JaCoCo) |
| Tests de backend y consola | `*/coverage/tests-sonar.xml` | `vitest-sonar-reporter` |
| Tests de la app | `android-app/app/build/test-results/testMockDebugUnitTest/` | Gradle (XML de JUnit) |

En CI cada componente sube su informe como artefacto y un cuarto job
(`SonarQube (calidad y cobertura)`) los baja a todos y corre el análisis. Espera
a que los tres estén en verde: si una suite falló, su cobertura quedó incompleta
y analizarla diría cualquier cosa.

## Prenderlo: SonarQube Cloud

Es el camino más corto para un repositorio de GitHub y es gratis para proyectos
públicos.

1. Entrá a <https://sonarcloud.io> con la cuenta de GitHub.
2. **+ › Analyze new project**, elegí `NikolasBerntsen/Tesis` y creá el proyecto.
   Sonar te muestra la **organization key** y el **project key**.
3. Abrí `sonar-project.properties` y verificá que `sonar.projectKey` y
   `sonar.organization` sean exactamente esos dos valores. Para este repositorio
   ya son los que están escritos: `NikolasBerntsen_Tesis` y `nikolasberntsen`.
4. En el paso de configuración elegí **GitHub Actions** (no el análisis
   automático: nosotros ya tenemos el workflow y queremos que suba la cobertura).
   Si quedó prendido *Automatic Analysis*, apagalo en
   **Administration › Analysis Method**, porque compite con el del CI.
5. Copiá el token que te da y guardalo en GitHub:
   **Settings › Secrets and variables › Actions › New repository secret**, con
   nombre `SONAR_TOKEN`. Que sea un **secret**, no una *variable*: en esa misma
   pantalla hay dos pestañas y el job lee `secrets.SONAR_TOKEN`, así que un
   token guardado como variable llega vacío y el análisis se saltea.
6. Listo. El próximo push corre el análisis y publica en SonarCloud.

No hace falta definir `SONAR_HOST_URL`: si la variable no existe, el job apunta
a `https://sonarcloud.io`.

Lo que no funciona —y cuesta un rato darse cuenta— es pasarle la variable vacía
esperando que el scanner caiga en ese default: no existe tal default. Con
`SONAR_HOST_URL` vacía, el scanner igual la usa, arma una URL sin esquema y el
análisis muere en un segundo con *Expected URL scheme 'http' or 'https' but no
scheme was found for /api/v...*. Por eso el paso del workflow escribe el valor
por defecto a mano: `${{ vars.SONAR_HOST_URL || 'https://sonarcloud.io' }}`.

## Prenderlo: instancia propia (SonarQube Server)

Si la cátedra pide un servidor propio o preferís tenerlo local:

```bash
docker run -d --name sonarqube -p 9000:9000 sonarqube:community
```

Tarda unos minutos en levantar la primera vez. Después:

1. Entrá a <http://localhost:9000> (usuario y contraseña `admin`; te pide
   cambiarla).
2. **Create Project › Manually**, poné la clave que quieras y anotala.
3. Generá un token en **My Account › Security**.
4. En `sonar-project.properties`: poné esa clave en `sonar.projectKey` y
   **comentá la línea `sonar.organization`**, que solo existe en la nube.
5. En GitHub, además del secreto `SONAR_TOKEN`, creá la variable
   `SONAR_HOST_URL` (**Settings › Secrets and variables › Actions › Variables**)
   con la URL del servidor. Ojo: si corre en tu máquina, el runner de GitHub no
   la alcanza — para eso hay que correr el análisis a mano (abajo) o exponer el
   servidor.

## Correrlo a mano

Sirve para probar la configuración sin esperar al CI. Primero generá los
informes; después, el análisis:

```bash
# 1) Los informes de los tres componentes
(cd backend  && npm ci && npm run test:cov)
(cd frontend && npm ci && npm run test:cov)
(cd android-app && ./gradlew testMockDebugUnitTest createMockDebugUnitTestCoverageReport)

# 2) El análisis, desde la raíz del repositorio
docker run --rm --network=host \
  -v "$PWD:/usr/src" \
  -e SONAR_HOST_URL="http://localhost:9000" \
  -e SONAR_TOKEN="<tu-token>" \
  sonarsource/sonar-scanner-cli
```

El scanner lee `sonar-project.properties` solo; no hay que pasarle nada más.

## Tres detalles que hacen que esto funcione (y por qué)

**Las rutas de los informes.** El análisis corre desde la raíz del repositorio,
así que los informes tienen que nombrar los archivos desde acá
(`backend/src/ws.ts`), no desde su módulo (`src/ws.ts`). Vitest, por defecto,
los escribe relativos al módulo. Por eso:

- en la cobertura, el reporter lleva `projectRoot: '..'`;
- en los tests, `vitest-sonar-reporter` lleva `onWritePath`, que prefija el
  nombre del módulo.

Sin esas dos líneas Sonar **no falla**: publica cobertura cero y el tablero
miente. Es la razón por la que el job de CI verifica que los cinco informes
existan antes de analizar, y rompe con el nombre del que falta.

**JaCoCo y Robolectric.** Robolectric carga las clases con su propio
classloader y las deja sin "location"; JaCoCo, por defecto, esas las ignora. Sin
`includeNoLocationClasses` (está en `app/build.gradle.kts`), todo lo que solo se
prueba con Robolectric se informa como **cero por ciento** sin un solo error que
lo delate. En la corrida de verificación, ese detalle era la diferencia entre
esto y lo otro:

| Paquete | Sin la línea | Con la línea |
|---|---|---|
| `patrol` (PatrolManager) | 0,0 % | 78,4 % |
| `drone` | 34,2 % | 82,6 % |
| `comms` | 16,9 % | 42,5 % |
| Proyecto entero (líneas) | 78,2 % | 88,1 % |

**El flavor `dji`.** No se compila en CI (necesita `-PenableDji`, la API key del
MSDK y el hardware), así que ningún test puede cubrirlo. Está en
`sonar.coverage.exclusions`: se lo excluye de la **cuenta** de cobertura, no del
análisis — sus bugs y code smells se siguen reportando. Si algún día esa parte
se puede testear, sacá esa línea.

## Lo que dio la verificación

Antes de subir nada, la configuración se probó de punta a punta contra un
SonarQube 26.9 local; después publicó en SonarQube Cloud desde el CI. Los dos
caminos dan lo mismo.

Lo que el primer análisis publicado dejó a la vista fue más interesante que la
cobertura: **vitest informaba 99 % y Sonar 88,2 %** sobre el mismo código. La
diferencia no era un error de Sonar. Eran cuatro archivos que la configuración
de vitest tenía **excluidos de la cobertura** —`DronesMap.tsx`, el seed del
backend y los dos entrypoints—, así que vitest ni los mencionaba; Sonar, que no
conoce esa lista, los indexaba igual y los contaba como 0 %. Entre los cuatro,
287 líneas sin cubrir que el número lindo escondía.

De esos cuatro, dos no tenían por qué estar excluidos y hoy tienen tests
propios; los otros dos son entrypoints de tres líneas y ahora están declarados
en `sonar.coverage.exclusions`, así que **las dos listas coinciden** y los dos
números miden lo mismo.

| | Antes | Ahora |
|---|---|---|
| `DronesMap.tsx` | excluido, 0 % en Sonar | 86 %, con 35 tests propios |
| `seed.ts` | excluido, 0 % en Sonar | 100 %, con 10 tests propios |
| Cobertura de líneas del proyecto | 88,2 % | **91,7 %** |
| Tests | 803 | **852** |

## El piso de cobertura

El objetivo de 90 % de líneas de [TESTS.md](TESTS.md) no lo vigilaba nadie: cada
componente tenía su umbral, pero la cifra del sistema completo —la que se
publica y la que se cita— no era de nadie. La verifica
[`scripts/cobertura.mjs`](../scripts/cobertura.mjs), que suma los mismos
informes que lee Sonar y rompe el CI por debajo del piso:

```bash
node scripts/cobertura.mjs              # piso por defecto: 90 %
node --test scripts/cobertura.test.mjs  # sus propios tests
```

Cuenta **líneas**, no la métrica *Coverage* del tablero, que mezcla líneas y
condiciones y siempre da más bajo — sobre el análisis anterior eran 85,5 %
contra 88,2 % del mismo código. El objetivo de TESTS.md está escrito en líneas,
así que el piso se mide en líneas.
Y descuenta dos cosas, para medir el mismo conjunto de archivos que Sonar: los
dos entrypoints y el *view binding* que genera el build de Android. Esas 129
líneas generadas son la diferencia entre leer la app al 60,9 % o al 62,3 %, que
es lo que publica el tablero.

No coincide al decimal con Sonar —Sonar decide por su cuenta qué línea es
ejecutable— pero queda dentro de unas décimas, que es lo que hace falta para
que sirva de alarma.

## Lo que conviene saber del tablero

- El **quality gate** por defecto (*Sonar way*) mide sobre el **código nuevo**,
  no sobre todo el proyecto: pide 80 % de cobertura en lo que agregás, 3 % o
  menos de duplicación y ningún issue de seguridad. Es el criterio que más
  sentido tiene acá, donde el objetivo declarado en [TESTS.md](TESTS.md) es 90 %
  de líneas y las suites ya lo superan.
- El análisis necesita el historial completo de git para fechar el código nuevo:
  por eso el job hace `fetch-depth: 0`.
- Mientras no exista el secreto `SONAR_TOKEN`, el job se saltea con un aviso en
  vez de dejar el CI en rojo.

## Un detalle que hay que mirar de vuelta si se cambia de versión

La ejecución de los tests de Kotlin entra por `sonar.junit.reportPaths`, que es
un importador de la familia Java. En la verificación **sí se importó** —los 803
tests del tablero son 287 + 381 + 135, y esos 135 son los de la app—, pero es la
parte menos garantizada del armado: si algún día el total no cierra con la suma
de las tres suites, el sospechoso es ese. La cobertura de Kotlin va por otro
camino (JaCoCo) y no depende de esto.

En el log del análisis se ve cuál de los tres importadores hizo qué, y conviene
mirarlo si el número no cierra:

- `Generic Test Executions Report` → `Imported test execution data for 18 files`
  (backend) y `28 files` (consola);
- `KotlinSurefireSensor` → una línea `Searching for ...` por cada clase de test
  de la app;
- `JaCoCo XML Report Importer` → la cobertura de Kotlin.

Ese último avisa `6 of 23 files were not found in the analysed sources`. Los seis
son las clases de *view binding* que genera el build
(`com.tesis.dronepatrol.databinding.*`): JaCoCo las mide porque están en el
bytecode, pero no son código escrito por nadie y no están en `sonar.sources`, así
que no tienen dónde mostrarse. Es informativo, no un problema: los 17 archivos
restantes, que son todo el código de la app, sí se importan.
