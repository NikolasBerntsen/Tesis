import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AJUSTES_DE_FABRICA,
  AYUDA_DE_REACCION,
  RANGO_DE_ORBITA,
  RANGO_DE_SILENCIO,
  REACCIONES,
  REACCIONES_QUE_SIGUEN,
  ROTULO_DE_REACCION,
  ajusteDelDron,
  consecuenciasDeDecidir,
  esReaccion,
  fichaConAjuste,
  textoDeSilencio,
  textoDeVelocidad,
  type CambioDeAjustes,
  type ReaccionADeteccion,
} from './ajustesDelDron';
import { makeDrone } from './test/fixtures';

interface Rango {
  tipo: string;
  minimo: number;
  maximo: number;
  paso: number;
  porDefecto: number;
}

interface Contrato {
  ajustes: {
    velocidadOrbitaMs: Rango;
    reaccionADeteccion: { tipo: string; valores: string[]; porDefecto: string; rotulos: Record<string, string> };
    silencioAlRetomarS: Rango;
  };
  ejemplos: {
    validos: { caso: string; cuerpo: CambioDeAjustes }[];
    invalidos: { caso: string; porque: string; cuerpo: Record<string, unknown> }[];
  };
}

// `dirname` y no `new URL('…', import.meta.url)`: Vite reescribe ese patrón como
// si fuera un asset y la ruta deja de ser un archivo (ver contraste.test.ts).
const contrato = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/contrato/ajustes.json'), 'utf8'),
) as Contrato;

const rango = ({ minimo, maximo, paso, porDefecto }: Rango) => ({ minimo, maximo, paso, porDefecto });

/**
 * La consola arma sus controles con estos números y el backend valida con los
 * mismos (docs/contrato/ajustes.json): si uno cambia sin el otro, el deslizador
 * ofrece valores que el hub rechaza, o deja de ofrecer los que acepta.
 */
describe('los ajustes del dron son los del contrato', () => {
  it('la órbita: rango, paso y valor de fábrica', () => {
    expect(contrato.ajustes.velocidadOrbitaMs.tipo).toBe('numero');
    expect(RANGO_DE_ORBITA).toEqual(rango(contrato.ajustes.velocidadOrbitaMs));
  });

  it('el silencio: rango, paso y valor de fábrica, en segundos enteros', () => {
    expect(contrato.ajustes.silencioAlRetomarS.tipo).toBe('entero');
    expect(RANGO_DE_SILENCIO).toEqual(rango(contrato.ajustes.silencioAlRetomarS));
  });

  it('la reacción: los valores, el de fábrica y los rótulos, tal cual', () => {
    const { reaccionADeteccion } = contrato.ajustes;
    expect(reaccionADeteccion.tipo).toBe('enum');
    expect([...REACCIONES]).toEqual(reaccionADeteccion.valores);
    expect(AJUSTES_DE_FABRICA.reaccionADeteccion).toBe(reaccionADeteccion.porDefecto);
    expect(ROTULO_DE_REACCION).toEqual(reaccionADeteccion.rotulos);
    // Las que siguen al objetivo son todas menos detenerse, en el orden del contrato.
    expect([...REACCIONES_QUE_SIGUEN]).toEqual(reaccionADeteccion.valores.filter((v) => v !== 'detenerse'));
    // Y cada una tiene su línea de ayuda (VUELO §5).
    for (const r of REACCIONES) expect(AYUDA_DE_REACCION[r], r).toBeTruthy();
  });

  it('el paso cae justo en los topes y en lo de fábrica: el deslizador tiene que poder mostrarlos', () => {
    for (const r of [RANGO_DE_ORBITA, RANGO_DE_SILENCIO]) {
      for (const valor of [r.maximo, r.porDefecto]) {
        const pasos = (valor - r.minimo) / r.paso;
        expect(Math.abs(pasos - Math.round(pasos)), String(valor)).toBeLessThan(1e-9);
      }
    }
  });

  it('lo de fábrica es lo del contrato, y está congelado', () => {
    expect(AJUSTES_DE_FABRICA).toEqual({
      velocidadOrbitaMs: contrato.ajustes.velocidadOrbitaMs.porDefecto,
      reaccionADeteccion: contrato.ajustes.reaccionADeteccion.porDefecto,
      silencioAlRetomarS: contrato.ajustes.silencioAlRetomarS.porDefecto,
    });
    expect(Object.isFrozen(AJUSTES_DE_FABRICA)).toBe(true);
  });

  it.each(contrato.ejemplos.validos)('un cuerpo válido del contrato sólo nombra ajustes que la consola conoce: $caso', ({ cuerpo }) => {
    for (const [clave, valor] of Object.entries(cuerpo)) {
      expect(Object.keys(AJUSTES_DE_FABRICA)).toContain(clave);
      if (clave === 'reaccionADeteccion') expect(valor === null || esReaccion(valor)).toBe(true);
    }
  });

  it('las reacciones inválidas de los ejemplos no pasan por esReaccion', () => {
    const malas = contrato.ejemplos.invalidos
      .map((e) => e.cuerpo.reaccionADeteccion)
      .filter((v) => v !== undefined);
    expect(malas.length).toBeGreaterThan(0);
    for (const v of malas) expect(esReaccion(v), String(v)).toBe(false);
  });
});

describe('lo que guarda la ficha', () => {
  it('ajusteDelDron: el valor guardado, o lo de fábrica con null y sin el campo (un hub viejo)', () => {
    expect(ajusteDelDron(makeDrone({ velocidadOrbitaMs: 2.5 }), 'velocidadOrbitaMs')).toBe(2.5);
    expect(ajusteDelDron(makeDrone({ velocidadOrbitaMs: null }), 'velocidadOrbitaMs')).toBe(4);
    expect(ajusteDelDron(makeDrone(), 'silencioAlRetomarS')).toBe(15);
    expect(ajusteDelDron(makeDrone({ silencioAlRetomarS: 0 }), 'silencioAlRetomarS')).toBe(0);
    expect(ajusteDelDron(makeDrone({ reaccionADeteccion: 'seguir' }), 'reaccionADeteccion')).toBe('seguir');
    expect(ajusteDelDron(makeDrone({ reaccionADeteccion: null }), 'reaccionADeteccion')).toBe('seguir_y_orbitar');
    expect(ajusteDelDron(null, 'reaccionADeteccion')).toBe('seguir_y_orbitar');
  });

  it('un valor que no es del contrato se trata como de fábrica: la app no sabría aplicarlo', () => {
    expect(ajusteDelDron(makeDrone({ reaccionADeteccion: 'perseguir' as ReaccionADeteccion }), 'reaccionADeteccion')).toBe(
      'seguir_y_orbitar',
    );
    expect(ajusteDelDron(makeDrone({ silencioAlRetomarS: Number.NaN }), 'silencioAlRetomarS')).toBe(15);
  });

  it('fichaConAjuste distingue null (de fábrica) de ausente (un hub viejo)', () => {
    expect(fichaConAjuste(makeDrone({ silencioAlRetomarS: null }), 'silencioAlRetomarS')).toBe(true);
    expect(fichaConAjuste(makeDrone({ silencioAlRetomarS: 5 }), 'silencioAlRetomarS')).toBe(true);
    expect(fichaConAjuste(makeDrone(), 'silencioAlRetomarS')).toBe(false);
    expect(fichaConAjuste(null, 'reaccionADeteccion')).toBe(false);
  });

  it('esReaccion: los cuatro valores exactos y nada más', () => {
    for (const r of REACCIONES) expect(esReaccion(r)).toBe(true);
    expect(esReaccion('SEGUIR')).toBe(false);
    expect(esReaccion(3)).toBe(false);
    expect(esReaccion(null)).toBe(false);
  });
});

describe('cómo se escriben', () => {
  it('la velocidad con coma y un decimal; el silencio en segundos, o «Sin silencio» con cero', () => {
    expect(textoDeVelocidad(4)).toBe('4,0 m/s');
    expect(textoDeVelocidad(2.5)).toBe('2,5 m/s');
    expect(textoDeSilencio(15)).toBe('15 s');
    expect(textoDeSilencio(0)).toBe('Sin silencio');
  });
});

describe('consecuenciasDeDecidir', () => {
  const DE_SIEMPRE = {
    validar: 'Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar.',
    descartar: 'Descartar: retoma la ruta hacia el próximo nodo.',
  };

  it('sin la ficha, o con la de un hub viejo que no trae los ajustes, lo de siempre', () => {
    expect(consecuenciasDeDecidir(null)).toEqual(DE_SIEMPRE);
    expect(consecuenciasDeDecidir(undefined)).toEqual(DE_SIEMPRE);
    expect(consecuenciasDeDecidir(makeDrone())).toEqual(DE_SIEMPRE);
  });

  it.each([
    ['seguir_y_orbitar', 'lo orbita y, si se mueve, lo sigue'],
    ['orbitar', 'sigue orbitando el lugar'],
    ['seguir', 'sigue a 25 m del objetivo'],
    ['detenerse', 'lo sigue vigilando desde donde está'],
  ] as [ReaccionADeteccion, string][])('validar dice cómo sigue el dron con la reacción %s', (reaccion, final) => {
    expect(consecuenciasDeDecidir(makeDrone({ reaccionADeteccion: reaccion })).validar).toBe(
      `Validar: el dron se queda sobre el objetivo hasta que lo mandes a patrullar: ${final}.`,
    );
  });

  it('con la reacción en null vale la de fábrica', () => {
    expect(consecuenciasDeDecidir(makeDrone({ reaccionADeteccion: null })).validar).toContain('lo orbita y, si se mueve, lo sigue');
  });

  it('descartar dice el silencio: el guardado, el de fábrica con null, y «sin silencio» con cero', () => {
    expect(consecuenciasDeDecidir(makeDrone({ silencioAlRetomarS: 30 })).descartar).toBe(
      'Descartar: retoma la ruta hacia el próximo nodo y no se detiene por otra detección durante 30 s.',
    );
    expect(consecuenciasDeDecidir(makeDrone({ silencioAlRetomarS: null })).descartar).toBe(
      'Descartar: retoma la ruta hacia el próximo nodo y no se detiene por otra detección durante 15 s.',
    );
    expect(consecuenciasDeDecidir(makeDrone({ silencioAlRetomarS: 0 })).descartar).toBe(
      'Descartar: retoma la ruta hacia el próximo nodo, sin silencio: otra detección lo puede frenar enseguida.',
    );
  });
});
