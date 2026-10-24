import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLES_POR_DEFECTO,
  RANGOS,
  claveDeCache,
  guardarCacheDeControles,
  leerCacheDeControles,
  normalizarControles,
  quedoSinGuardar,
  textoDeAjuste,
  velocidadesDeTeclado,
  type ClaveNumerica,
  type ControlesDeVuelo,
} from './preferenciasDeControl';
import { VELOCIDADES_POR_DEFECTO } from './components/useTecladoDeVuelo';

interface Contrato {
  controles: Record<string, { tipo: string; minimo?: number; maximo?: number; paso?: number; porDefecto: number | boolean }>;
  ejemplos: { validos: { caso: string; cuerpo: { controles: Partial<ControlesDeVuelo> } }[] };
}

// `dirname` y no `new URL('…', import.meta.url)`: Vite reescribe ese patrón como
// si fuera un asset y la ruta deja de ser un archivo (ver contraste.test.ts).
const contrato = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/contrato/preferencias.json'), 'utf8'),
) as Contrato;

describe('los ajustes son los del contrato que valida el backend', () => {
  it('las mismas claves, y cada deslizador con el rango, el paso y el valor por defecto de ahí', () => {
    expect(Object.keys(CONTROLES_POR_DEFECTO).sort()).toEqual(Object.keys(contrato.controles).sort());
    for (const [clave, rango] of Object.entries(RANGOS)) {
      const delContrato = contrato.controles[clave];
      expect(delContrato.tipo, clave).toBe('numero');
      expect(rango, clave).toEqual({
        minimo: delContrato.minimo,
        maximo: delContrato.maximo,
        paso: delContrato.paso,
        porDefecto: delContrato.porDefecto,
      });
      // El paso tiene que caer justo en los dos topes y en el valor por defecto:
      // si no, el deslizador no podría mostrar el valor de fábrica.
      for (const valor of [rango.maximo, rango.porDefecto]) {
        const pasos = (valor - rango.minimo) / rango.paso;
        expect(Math.abs(pasos - Math.round(pasos)), `${clave}: ${valor}`).toBeLessThan(1e-9);
      }
    }
    expect(contrato.controles.invertirVertical).toEqual({ tipo: 'booleano', porDefecto: CONTROLES_POR_DEFECTO.invertirVertical });
  });

  it('los de fábrica vuelan el teclado como antes de que se pudiera ajustar', () => {
    expect(velocidadesDeTeclado(CONTROLES_POR_DEFECTO)).toEqual(VELOCIDADES_POR_DEFECTO);
    expect(Object.isFrozen(CONTROLES_POR_DEFECTO)).toBe(true);
  });
});

describe('normalizarControles', () => {
  it.each(contrato.ejemplos.validos)('un cuerpo válido del contrato pasa entero: $caso', ({ cuerpo }) => {
    expect(normalizarControles(cuerpo.controles)).toEqual({ ...CONTROLES_POR_DEFECTO, ...cuerpo.controles });
  });

  it('lo que no sirve cae a su valor por defecto, clave por clave', () => {
    const crudo = {
      sensibilidadHorizontal: 1.5,
      sensibilidadVertical: 9,
      velocidadNormal: '0.4',
      velocidadGiro: Number.NaN,
      pasoDeRueda: null,
      invertirVertical: 'sí',
      volumen: 3,
    };
    expect(normalizarControles(crudo)).toEqual({ ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 1.5 });
  });

  it.each([null, undefined, 'texto', 3, [1, 2]])('algo que no es un objeto (%j) son los de fábrica', (crudo) => {
    expect(normalizarControles(crudo)).toEqual(CONTROLES_POR_DEFECTO);
  });

  it('devuelve un objeto nuevo, no los de fábrica congelados', () => {
    const controles = normalizarControles({});
    controles.pasoDeRueda = 3;
    expect(CONTROLES_POR_DEFECTO.pasoDeRueda).toBe(5);
  });
});

describe('velocidadesDeTeclado', () => {
  it('cada grupo de teclas lleva su velocidad, y Shift su multiplicador', () => {
    const controles = { ...CONTROLES_POR_DEFECTO, velocidadNormal: 0.3, velocidadSubida: 0.4, velocidadGiro: 0.7, multiplicadorShift: 3 };
    expect(velocidadesDeTeclado(controles)).toEqual({ avance: 0.3, subida: 0.4, giro: 0.7, rapido: 3 });
  });
});

describe('la copia local, por usuario', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('cada usuario tiene la suya', () => {
    guardarCacheDeControles('ana', { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 0.4 });
    guardarCacheDeControles('beto', { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 2 });
    expect(leerCacheDeControles('ana')?.sensibilidadVertical).toBe(0.4);
    expect(leerCacheDeControles('beto')?.sensibilidadVertical).toBe(2);
    expect(localStorage.getItem(claveDeCache('ana'))).toContain('"sensibilidadVertical":0.4');
  });

  it('sin copia, o sin usuario, no hay nada que leer ni que guardar', () => {
    expect(leerCacheDeControles('ana')).toBeNull();
    guardarCacheDeControles('', { ...CONTROLES_POR_DEFECTO });
    expect(localStorage.length).toBe(0);
    expect(leerCacheDeControles('')).toBeNull();
  });

  it('una copia rota no se lee; una vieja o tocada a mano se normaliza', () => {
    localStorage.setItem(claveDeCache('ana'), '{roto');
    expect(leerCacheDeControles('ana')).toBeNull();
    localStorage.setItem(claveDeCache('ana'), JSON.stringify({ velocidadNormal: 0.8, viejo: true, pasoDeRueda: 99 }));
    expect(leerCacheDeControles('ana')).toEqual({ ...CONTROLES_POR_DEFECTO, velocidadNormal: 0.8 });
  });

  it('la marca de "sin guardar" va en la misma copia, y leerla no cambia los ajustes', () => {
    const propios = { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 3 };
    guardarCacheDeControles('ana', propios, true);
    expect(quedoSinGuardar('ana')).toBe(true);
    expect(leerCacheDeControles('ana')).toEqual(propios);
    // Guardada en el Comando Central, la copia vuelve a estar al día.
    guardarCacheDeControles('ana', propios);
    expect(quedoSinGuardar('ana')).toBe(false);
    expect(leerCacheDeControles('ana')).toEqual(propios);
  });

  it('sin copia, sin usuario, con una copia rota o con una de antes de la marca, nada quedó sin guardar', () => {
    expect(quedoSinGuardar('ana')).toBe(false);
    expect(quedoSinGuardar('')).toBe(false);
    localStorage.setItem(claveDeCache('ana'), '{roto');
    expect(quedoSinGuardar('ana')).toBe(false);
    localStorage.setItem(claveDeCache('ana'), 'null');
    expect(quedoSinGuardar('ana')).toBe(false);
    localStorage.setItem(claveDeCache('ana'), JSON.stringify({ ...CONTROLES_POR_DEFECTO, sinGuardar: 'sí' }));
    expect(quedoSinGuardar('ana')).toBe(false);
  });

  it('un navegador que niega el almacenamiento no impide volar', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('lleno', 'QuotaExceededError');
    });
    expect(leerCacheDeControles('ana')).toBeNull();
    expect(quedoSinGuardar('ana')).toBe(false);
    expect(() => guardarCacheDeControles('ana', { ...CONTROLES_POR_DEFECTO }, true)).not.toThrow();
  });
});

describe('textoDeAjuste', () => {
  it.each<[ClaveNumerica, number, string, string]>([
    ['sensibilidadHorizontal', 1, '1×', '1 vez'],
    ['sensibilidadVertical', 0.6, '0,6×', '0,6 veces'],
    ['multiplicadorShift', 2.25, '2,25×', '2,25 veces'],
    ['velocidadNormal', 0.35, '35 %', '35 por ciento de la palanca'],
    ['velocidadSubida', 1, '100 %', '100 por ciento de la palanca'],
    ['velocidadGiro', 0.5, '50 %', '50 por ciento de la palanca'],
    ['pasoDeRueda', 5, '5°', '5 grados por muesca'],
  ])('%s en %s se lee "%s"', (clave, valor, visible, leido) => {
    expect(textoDeAjuste(clave, valor)).toEqual({ visible, leido });
  });
});
