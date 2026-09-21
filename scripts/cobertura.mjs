/**
 * Piso de cobertura del PROYECTO ENTERO.
 *
 * Cada componente ya tiene su propio umbral (vitest en backend y consola,
 * JaCoCo en la app), pero ninguna de esas herramientas ve a las otras dos: la
 * cobertura del sistema completo —la que se publica en Sonar y la que se cita
 * en la tesis— no la vigila nadie. Este script la calcula sumando los mismos
 * informes que lee Sonar y falla si baja del piso.
 *
 * Uso:
 *   node scripts/cobertura.mjs            # piso por defecto: 90 %
 *   node scripts/cobertura.mjs --piso 92
 *
 * Cuenta LÍNEAS, no la métrica `Coverage` del tablero de Sonar (que mezcla
 * líneas y condiciones y siempre da más bajo). Es la misma unidad en la que
 * está escrito el objetivo en docs/TESTS.md.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Lo que se descuenta de la cuenta, igual que `sonar.coverage.exclusions`. */
export const EXCLUIDOS = ['backend/src/index.ts', 'frontend/src/main.tsx'];

/**
 * Suma LF/LH de un lcov. Se queda con la ÚLTIMA aparición de cada archivo:
 * lcov admite repetidos y quedarse con todos contaría dos veces el mismo.
 */
export function leerLcov(texto) {
  const porArchivo = new Map();
  let archivo = null;
  let lf = 0;
  let lh = 0;
  for (const linea of texto.split('\n')) {
    const l = linea.trim();
    if (l.startsWith('SF:')) {
      archivo = l.slice(3);
      lf = 0;
      lh = 0;
    } else if (l.startsWith('LF:')) lf = Number(l.slice(3));
    else if (l.startsWith('LH:')) lh = Number(l.slice(3));
    else if (l === 'end_of_record' && archivo) {
      porArchivo.set(archivo, { total: lf, cubiertas: lh });
      archivo = null;
    }
  }
  return porArchivo;
}

/**
 * Cobertura de líneas por archivo del informe XML de JaCoCo.
 *
 * Se suma archivo por archivo y no el contador del report entero, porque hay
 * que descontar el código GENERADO: las clases de *view binding* que escribe el
 * build (`com/tesis/dronepatrol/databinding/*.java`) están en el bytecode, así
 * que JaCoCo las mide, pero no las escribió nadie y no están en
 * `sonar.sources`. Contarlas hundía la cifra de la app varios puntos por
 * archivos que ningún test podría cubrir aunque quisiera.
 */
export function leerJacoco(texto) {
  const porArchivo = new Map();
  // <package name="..."> ... <sourcefile name="X.kt"> <counter .../> </sourcefile>
  for (const paquete of texto.matchAll(/<package\s+name="([^"]+)"([\s\S]*?)<\/package>/g)) {
    const nombrePaquete = paquete[1];
    for (const archivo of paquete[2].matchAll(/<sourcefile\s+name="([^"]+)"([\s\S]*?)<\/sourcefile>/g)) {
      const ruta = `${nombrePaquete}/${archivo[1]}`;
      const contador = /<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/.exec(archivo[2]);
      if (!contador) continue;
      porArchivo.set(ruta, { total: Number(contador[1]) + Number(contador[2]), cubiertas: Number(contador[2]) });
    }
  }
  return porArchivo;
}

/** Código que escribe el build, no una persona. */
export const GENERADO = [/\/databinding\//];

/** Descarta los archivos excluidos y el código generado, y suma el resto. */
export function sumar(porArchivo, excluidos = EXCLUIDOS) {
  let total = 0;
  let cubiertas = 0;
  for (const [archivo, n] of porArchivo) {
    const normalizado = archivo.replaceAll('\\', '/');
    if (excluidos.some((e) => normalizado.endsWith(e))) continue;
    if (GENERADO.some((re) => re.test(`/${normalizado}`))) continue;
    total += n.total;
    cubiertas += n.cubiertas;
  }
  return { total, cubiertas };
}

export const porcentaje = ({ total, cubiertas }) => (total === 0 ? 0 : (100 * cubiertas) / total);

const INFORMES = [
  { nombre: 'Backend', ruta: 'backend/coverage/lcov.info', tipo: 'lcov' },
  { nombre: 'Consola', ruta: 'frontend/coverage/lcov.info', tipo: 'lcov' },
  { nombre: 'App Android', ruta: 'android-app/app/build/reports/coverage/test/mock/debug/report.xml', tipo: 'jacoco' },
];

/** Lee los tres informes desde `raiz` y devuelve el detalle y el total. */
export function medir(raiz, leer = (p) => fs.readFileSync(p, 'utf8')) {
  const partes = [];
  for (const informe of INFORMES) {
    const texto = leer(path.join(raiz, informe.ruta));
    const n = sumar(informe.tipo === 'lcov' ? leerLcov(texto) : leerJacoco(texto));
    partes.push({ nombre: informe.nombre, ...n });
  }
  const total = partes.reduce(
    (acc, p) => ({ total: acc.total + p.total, cubiertas: acc.cubiertas + p.cubiertas }),
    { total: 0, cubiertas: 0 },
  );
  return { partes, total };
}

/* --- Ejecución ------------------------------------------------------------ */

function main(argv) {
  const i = argv.indexOf('--piso');
  const piso = i === -1 ? 90 : Number(argv[i + 1]);
  if (!Number.isFinite(piso) || piso < 0 || piso > 100) {
    console.error(`Piso inválido: ${argv[i + 1]}`);
    return 2;
  }

  const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  let medicion;
  try {
    medicion = medir(raiz);
  } catch (err) {
    console.error(`No se pudo leer un informe de cobertura: ${err.message}`);
    console.error('Generalos con: npm run test:cov (backend y frontend) y ./gradlew createMockDebugUnitTestCoverageReport');
    return 2;
  }

  for (const p of medicion.partes) {
    console.log(`  ${p.nombre.padEnd(14)} ${porcentaje(p).toFixed(1).padStart(5)} %  (${p.cubiertas}/${p.total} líneas)`);
  }
  const pct = porcentaje(medicion.total);
  console.log(`  ${'PROYECTO'.padEnd(14)} ${pct.toFixed(1).padStart(5)} %  (${medicion.total.cubiertas}/${medicion.total.total} líneas)`);

  if (pct + 1e-9 < piso) {
    console.error(
      `::error::La cobertura de líneas del proyecto bajó a ${pct.toFixed(1)} %, por debajo del piso de ${piso} %. ` +
        'Lo que se agrega va con sus tests: ver docs/TESTS.md.',
    );
    return 1;
  }
  console.log(`\nOK: ${pct.toFixed(1)} % ≥ ${piso} %`);
  return 0;
}

// Solo al ejecutarlo; importado desde el test, no hace nada.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exit(main(process.argv.slice(2)));
}
