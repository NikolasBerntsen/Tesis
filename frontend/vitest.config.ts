import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Config de tests separada del build de producción: reutiliza el vite.config.ts
// existente (plugin de React, alias, etc.) vía mergeConfig y sólo le agrega la
// clave `test`. Así `npm run build` sigue usando su config intacta.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      css: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov', 'json-summary'],
        all: true,
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          // Bootstrap de la app: sólo monta React en el DOM, sin lógica propia.
          'src/main.tsx',
          // DronesMap manipula Leaflet de forma imperativa contra el DOM; en
          // jsdom no hay canvas/tiles reales, así que se mockea el módulo en los
          // tests de sus consumidores (Dashboard/DroneDetail) y se lo excluye de
          // la cobertura en vez de forzar aserciones frágiles sobre Leaflet.
          'src/components/DronesMap.tsx',
          // Sólo declaraciones de tipos/interfaces: no genera código ejecutable.
          'src/types.ts',
          // Infra de testing y los propios tests.
          'src/test/**',
          'src/**/*.test.{ts,tsx}',
        ],
        thresholds: {
          lines: 80,
          functions: 80,
          statements: 80,
        },
      },
    },
  }),
);
