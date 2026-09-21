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
   `sonar.organization` sean exactamente esos dos valores. Si el proyecto lo
   creaste importando el repo, ya coinciden con lo que está escrito.
4. En el paso de configuración elegí **GitHub Actions** (no el análisis
   automático: nosotros ya tenemos el workflow y queremos que suba la cobertura).
   Si quedó prendido *Automatic Analysis*, apagalo en
   **Administration › Analysis Method**, porque compite con el del CI.
5. Copiá el token que te da y guardalo en GitHub:
   **Settings › Secrets and variables › Actions › New repository secret**, con
   nombre `SONAR_TOKEN`.
6. Listo. El próximo push corre el análisis y publica en SonarCloud.

No hace falta definir `SONAR_HOST_URL`: sin esa variable, el paso apunta a
SonarQube Cloud.

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

Esta configuración se probó de punta a punta contra un SonarQube 26.9 local
antes de subirla: los tres componentes generaron sus informes, el scanner los
importó y el tablero quedó con **803 tests** (287 del backend, 381 de la consola
y 135 de la app, que es la suma exacta), **0 fallas** y **88,1 % de cobertura de
líneas** — 96,4 % el backend, 93,2 % la consola y 53,6 % la app.

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
