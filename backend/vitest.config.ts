import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // better-sqlite3 es un módulo nativo: el pool de procesos (forks) lo carga
    // sin los problemas que a veces da worker_threads.
    pool: 'forks',
    // Cada archivo de test corre aislado (registro de módulos fresco), así el
    // singleton de db.ts y el estado del hub de ws.ts arrancan limpios por archivo.
    isolate: true,
    // Base de datos efímera en memoria y secreto de JWT fijo para los tests.
    // Se fija ANTES de importar cualquier módulo del backend (config.ts lee
    // DB_FILE del entorno al importarse). dotenv no pisa lo ya definido.
    env: {
      DB_FILE: ':memory:',
      JWT_SECRET: 'test-secret-vitest',
      NODE_ENV: 'test',
    },
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // El segundo reporte es para SonarQube: el formato genérico de ejecución de
    // tests, que es lo que lee `sonar.testExecutionReportPaths`. Sin esto Sonar
    // muestra la cobertura pero no cuántos tests corrieron ni cuánto tardaron.
    // `onWritePath` prefija con el módulo por el mismo motivo que el
    // `projectRoot` de la cobertura: el análisis corre desde la raíz y sin el
    // prefijo Sonar busca `tests/...` ahí y no encuentra nada.
    reporters: [
      'default',
      [
        'vitest-sonar-reporter',
        {
          outputFile: 'coverage/tests-sonar.xml',
          onWritePath: (ruta: string) => `backend/${ruta}`,
        },
      ],
    ],
    // Los tests de WebSocket y control abren sockets y esperan mensajes.
    testTimeout: 15000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      // `projectRoot: '..'` NO es cosmético: sin él el lcov sale con rutas
      // relativas a backend/ (`SF:src/app.ts`) y el análisis de Sonar, que corre
      // desde la raíz del repo, no puede resolver ni un archivo — la cobertura
      // aparece en cero sin ningún error. Con esto sale `SF:backend/src/app.ts`.
      reporter: ['text', ['lcov', { projectRoot: '..' }], 'json-summary'],
      all: true,
      include: ['src/**/*.ts'],
      // index.ts es el único entrypoint de verdad: tres líneas que llaman a
      // listen(). seed.ts SALIÓ de esta lista: decide con qué usuarios y con
      // qué contraseñas arranca una instalación, así que sí es lógica a probar
      // (tests/unit/seed.test.ts). Lo que se excluya acá hay que excluirlo
      // también en sonar-project.properties, o Sonar lo cuenta como 0 %.
      exclude: ['src/index.ts'],
      // Pegados a la cobertura real (99,1 líneas / 95,1 ramas) con un margen
      // chico: la idea es que una funcionalidad sin tests rompa el CI, no que
      // quede pasando. El piso del PROYECTO entero, que es el que se prometió
      // sostener en 90 %, lo verifica scripts/cobertura.mjs desde la raíz.
      thresholds: {
        lines: 98,
        functions: 97,
        statements: 98,
        branches: 94,
      },
    },
  },
});
