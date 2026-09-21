/**
 * Tests del piso de cobertura. Corren con el runner que ya trae Node:
 *
 *   node --test scripts/
 *
 * Sin dependencias a propósito: este script vive en la raíz del repositorio,
 * fuera de los dos workspaces de npm, y agregarle un package.json propio con
 * vitest para cuatro funciones puras sería más armazón que código.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { leerLcov, leerJacoco, sumar, porcentaje, medir, EXCLUIDOS } from './cobertura.mjs';

const LCOV = `TN:
SF:backend/src/app.ts
LF:10
LH:9
end_of_record
SF:backend/src/index.ts
LF:2
LH:0
end_of_record
`;

const JACOCO = `<?xml version="1.0" encoding="UTF-8"?>
<report name="app">
  <package name="com/tesis/dronepatrol">
    <sourcefile name="MainActivity.kt">
      <counter type="BRANCH" missed="3" covered="7"/>
      <counter type="LINE" missed="40" covered="60"/>
    </sourcefile>
    <sourcefile name="Config.kt">
      <counter type="LINE" missed="0" covered="40"/>
    </sourcefile>
  </package>
  <package name="com/tesis/dronepatrol/databinding">
    <sourcefile name="ActivityMainBinding.java">
      <counter type="LINE" missed="26" covered="103"/>
    </sourcefile>
  </package>
  <counter type="LINE" missed="66" covered="203"/>
</report>`;

test('leerLcov junta LF y LH por archivo', () => {
  const porArchivo = leerLcov(LCOV);
  assert.equal(porArchivo.size, 2);
  assert.deepEqual(porArchivo.get('backend/src/app.ts'), { total: 10, cubiertas: 9 });
  assert.deepEqual(porArchivo.get('backend/src/index.ts'), { total: 2, cubiertas: 0 });
});

test('un archivo repetido en el lcov no se cuenta dos veces', () => {
  const porArchivo = leerLcov(LCOV + 'SF:backend/src/app.ts\nLF:10\nLH:10\nend_of_record\n');
  assert.equal(porArchivo.size, 2);
  // Gana la última aparición.
  assert.deepEqual(porArchivo.get('backend/src/app.ts'), { total: 10, cubiertas: 10 });
});

test('un registro sin end_of_record se descarta en vez de ensuciar la cuenta', () => {
  const porArchivo = leerLcov('SF:a.ts\nLF:5\nLH:5\n');
  assert.equal(porArchivo.size, 0);
});

test('leerJacoco desglosa por archivo y toma el contador de LÍNEAS', () => {
  const porArchivo = leerJacoco(JACOCO);
  assert.equal(porArchivo.size, 3);
  // Del archivo con dos contadores tiene que tomar LINE, no BRANCH.
  assert.deepEqual(porArchivo.get('com/tesis/dronepatrol/MainActivity.kt'), { total: 100, cubiertas: 60 });
  assert.deepEqual(porArchivo.get('com/tesis/dronepatrol/Config.kt'), { total: 40, cubiertas: 40 });
});

test('el view binding generado por el build no entra en la cuenta', () => {
  // Es lo que separa este número del del tablero de Sonar, que tampoco lo mira:
  // contando esas 129 líneas generadas la app medía 60,9 %; sin ellas, 62,3 %,
  // que es lo que publica Sonar.
  const total = sumar(leerJacoco(JACOCO));
  assert.deepEqual(total, { total: 140, cubiertas: 100 });
});

test('un informe de JaCoCo sin contadores de línea no revienta', () => {
  assert.deepEqual(sumar(leerJacoco('<report name="app"></report>')), { total: 0, cubiertas: 0 });
});

test('sumar descuenta los archivos excluidos', () => {
  const todo = sumar(leerLcov(LCOV), []);
  assert.deepEqual(todo, { total: 12, cubiertas: 9 });

  // index.ts es un entrypoint: sale de la cuenta, igual que en Sonar.
  const sinEntrypoint = sumar(leerLcov(LCOV));
  assert.deepEqual(sinEntrypoint, { total: 10, cubiertas: 9 });
  assert.ok(EXCLUIDOS.includes('backend/src/index.ts'));
});

test('la exclusión compara el final de la ruta, venga como venga', () => {
  const abs = new Map([['/home/quien-sea/Tesis/backend/src/index.ts', { total: 2, cubiertas: 0 }]]);
  assert.deepEqual(sumar(abs), { total: 0, cubiertas: 0 });
});

test('porcentaje no divide por cero', () => {
  assert.equal(porcentaje({ total: 0, cubiertas: 0 }), 0);
  assert.equal(porcentaje({ total: 200, cubiertas: 180 }), 90);
});

test('medir suma los tres informes en un solo número', () => {
  const falsos = {
    'backend/coverage/lcov.info': LCOV,
    'frontend/coverage/lcov.info': 'SF:frontend/src/App.tsx\nLF:100\nLH:95\nend_of_record\n',
    'android-app/app/build/reports/coverage/test/mock/debug/report.xml': JACOCO,
  };
  const leer = (ruta) => {
    const clave = Object.keys(falsos).find((k) => ruta.endsWith(k));
    if (!clave) throw new Error(`sin doble para ${ruta}`);
    return falsos[clave];
  };

  const { partes, total } = medir('/raiz', leer);
  assert.deepEqual(
    partes.map((p) => [p.nombre, p.cubiertas, p.total]),
    [
      ['Backend', 9, 10],
      ['Consola', 95, 100],
      ['App Android', 100, 140],
    ],
  );
  // 204 de 250: el total es de LÍNEAS, no el promedio de los tres porcentajes
  // (que daría 87,3 % y taparía lo que arrastra la app).
  assert.deepEqual(total, { total: 250, cubiertas: 204 });
  assert.equal(porcentaje(total).toFixed(1), '81.6');
});

test('un informe que falta se nota, no pasa por cobertura cero', () => {
  assert.throws(() => medir('/raiz', () => {
    throw new Error('ENOENT');
  }));
});
