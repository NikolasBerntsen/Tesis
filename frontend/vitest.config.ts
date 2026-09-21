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
      // El segundo reporte es para SonarQube: el formato genérico de ejecución
      // de tests que lee `sonar.testExecutionReportPaths`. Sin esto Sonar muestra
      // la cobertura pero no cuántos tests corrieron ni cuánto tardaron.
      // `onWritePath` prefija con el módulo porque el análisis corre desde la
      // raíz del repo: sin el prefijo Sonar busca `src/...` ahí y no encuentra nada.
      reporters: [
        'default',
        [
          'vitest-sonar-reporter',
          {
            outputFile: 'coverage/tests-sonar.xml',
            onWritePath: (ruta: string) => `frontend/${ruta}`,
          },
        ],
      ],
      coverage: {
        provider: 'v8',
        // `projectRoot: '..'` NO es cosmético: sin él el lcov sale con rutas
        // relativas a frontend/ (`SF:src/App.tsx`) y el análisis de Sonar, que
        // corre desde la raíz, no resuelve ni un archivo — la cobertura aparece
        // en cero sin ningún error. Con esto sale `SF:frontend/src/App.tsx`.
        reporter: ['text', ['lcov', { projectRoot: '..' }], 'json-summary'],
        all: true,
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          // Bootstrap de la app: sólo monta React en el DOM, sin lógica propia.
          'src/main.tsx',
          // DronesMap SALIÓ de esta lista. Estaba excluido por manipular Leaflet
          // de forma imperativa, pero ya tenía tests propios con un doble del
          // módulo: la exclusión solo servía para que sus 248 líneas no se
          // contaran, y Sonar —que no conoce esta lista— las contaba igual como
          // 0 %. Era el agujero de cobertura más grande del proyecto.
          // Sólo declaraciones de tipos/interfaces: no genera código ejecutable.
          'src/types.ts',
          // Infra de testing y los propios tests.
          'src/test/**',
          'src/**/*.test.{ts,tsx}',
        ],
        // Pegados a la cobertura real (97,6 líneas / 94,2 ramas / 90,4
        // funciones) con un margen chico: la idea es que una funcionalidad sin
        // tests rompa el CI, no que pase. El piso del PROYECTO entero, que es
        // el que se prometió sostener en 90 %, lo verifica
        // scripts/cobertura.mjs desde la raíz.
        //
        // El umbral de funciones había bajado dos veces (94 → 92 → 89) y eso
        // era la señal de que faltaban manejadores sin ejercitar. Vuelve a
        // subir a 90 ahora que DronesMap entró a la cuenta con sus tests; el
        // camino sigue siendo 92 y después 94, cubriendo manejadores, nunca
        // bajando el número.
        thresholds: {
          lines: 97,
          functions: 90,
          statements: 97,
          branches: 93,
        },
      },
    },
  }),
);
