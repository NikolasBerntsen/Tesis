# Tests y cobertura

El sistema es de seguridad, así que la corrección importa. Cada componente
tiene su propia suite y todas corren en CI (`.github/workflows/ci.yml`) en cada
push y pull request. El objetivo de cobertura es **90% de líneas**.

## Backend (`backend/`)

Node + Express + WebSocket + SQLite, con **Vitest** y cobertura `v8`.

```bash
cd backend
npm test          # corre toda la suite
npm run test:cov  # con reporte de cobertura
```

- **Tests unitarios**: funciones puras del store (usuarios, rutas, apodos de
  nodos, filtrado de logs por categoría) y de auth (jerarquía de roles,
  construcción del token).
- **Tests de integración**: levantan el servidor real (`createServer()` de
  `src/app.ts`) en un puerto efímero y ejercen la API por HTTP y el hub por
  WebSocket, cada uno contra una base de datos descartable:
  - autenticación (login correcto, fallido y con cuenta desactivada, con su
    registro en el log de sistema);
  - jerarquía de permisos (un operador no llega a `/users`, un supervisor no
    llega a `/logs`, etc.) y flags evaluados en vivo (suspender o desactivar
    surte efecto sobre tokens ya emitidos);
  - control manual exclusivo (un solo titular, 409 para el resto, liberación
    forzada por un supervisor, movimiento solo del titular);
  - comandos de patrullaje (comenzar/interrumpir ruta, reanudar desde un nodo
    elegido, vuelo forzado a un nodo);
  - ABM de usuarios y su registro con antes/después.

## Frontend (`frontend/`)

React + Vite, con **Vitest** + **Testing Library** sobre jsdom.

```bash
cd frontend
npm test
npm run test:cov
```

- **Unitarios** de los helpers de formato (`format.ts`) y del cliente de API
  (manejo de 401, sesión en `localStorage`).
- **De componentes**: login, tarjeta de cámara (overlays de señal perdida y
  batería baja, etiqueta de modo), gestión de usuarios (acciones según rol),
  registro del sistema, panel de alertas y estado del dron.

El mapa (`DronesMap.tsx`, Leaflet) se ejercita aparte con pruebas de navegador
(ver abajo) porque depende de APIs de mapas que jsdom no provee.

## App Android (`android-app/`)

Kotlin, con **JUnit** + **Robolectric**.

```bash
cd android-app
./gradlew testMockDebugUnitTest
```

- Smoke test de arranque de la pantalla de login en las APIs 26/30/34
  (Robolectric), que cubre el inflado de layout y la resolución de tema.
- Tests del dron simulado: navegación a un punto (llega y queda estacionario),
  vuelo estacionario, cálculo del rumbo de la cámara y drenaje de batería.

## Pruebas de navegador (extremo a extremo)

Además de la cobertura por unidad, el flujo completo del Comando Central se
verifica en un navegador real (Chromium vía Playwright) contra el backend y una
flota de drones simulados: dashboard de cámaras y mapa, control manual, cono de
la cámara, forzado y reanudación desde un nodo, gestión de usuarios por rol y el
registro del sistema. Estas pruebas viven fuera del árbol del repo (son de
verificación manual, no parte de `npm test`).

## Tipos de test, en resumen

| Tipo | Qué valida | Dónde |
|---|---|---|
| Unitario | Funciones puras y de dominio, aisladas | backend, frontend, android |
| Integración | Varios módulos juntos: API + base + WebSocket | backend |
| Componente | Render y comportamiento de la UI | frontend |
| Extremo a extremo | El circuito completo en un navegador real | Playwright (manual) |
