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
    // Los tests de WebSocket y control abren sockets y esperan mensajes.
    testTimeout: 15000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      all: true,
      include: ['src/**/*.ts'],
      // index.ts y seed.ts son entrypoints/datos, no lógica a testear.
      exclude: ['src/index.ts', 'src/seed.ts'],
      // Pegados a la cobertura real (99.8 / 97.2) con un margen chico: la idea
      // es que una funcionalidad sin tests rompa el CI, no que quede pasando.
      thresholds: {
        lines: 97,
        functions: 97,
        statements: 97,
        branches: 94,
      },
    },
  },
});
