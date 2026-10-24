import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import {
  AJUSTES_DE_CONTROL,
  CONTROLES_POR_DEFECTO,
  CUERPO_MAXIMO_BYTES,
  excedeElTamanio,
  guardarPreferencias,
  leerPreferencias,
  normalizarGuardadas,
  preferenciasDe,
  type PreferenciasDeControl,
} from '../../src/preferencias';
import { limpiarBase } from '../helpers';

interface Ejemplo {
  caso: string;
  porque?: string;
  cuerpo: Record<string, unknown>;
}

/** El contrato que comparten el backend y la consola (docs/contrato/preferencias.json). */
const CONTRATO = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/contrato/preferencias.json'), 'utf8'),
) as {
  limites: { cuerpoMaxBytes: number };
  controles: Record<string, { tipo: string; minimo?: number; maximo?: number; porDefecto: number | boolean }>;
  ejemplos: { validos: Ejemplo[]; invalidos: Ejemplo[] };
};

describe('preferencias — los números son los del contrato', () => {
  it('las mismas claves, con el mismo tipo, rango y valor por defecto', () => {
    expect(Object.keys(AJUSTES_DE_CONTROL).sort()).toEqual(Object.keys(CONTRATO.controles).sort());
    for (const [clave, ajuste] of Object.entries(AJUSTES_DE_CONTROL)) {
      const delContrato = CONTRATO.controles[clave];
      expect(ajuste.tipo, clave).toBe(delContrato.tipo);
      expect(ajuste.porDefecto, clave).toBe(delContrato.porDefecto);
      if (ajuste.tipo === 'numero') {
        expect([ajuste.minimo, ajuste.maximo], clave).toEqual([delContrato.minimo, delContrato.maximo]);
        // El valor por defecto tiene que poder guardarse.
        expect(ajuste.porDefecto).toBeGreaterThanOrEqual(ajuste.minimo);
        expect(ajuste.porDefecto).toBeLessThanOrEqual(ajuste.maximo);
      }
    }
    expect(CUERPO_MAXIMO_BYTES).toBe(CONTRATO.limites.cuerpoMaxBytes);
  });

  it('los valores por defecto son los de antes de que se pudieran ajustar las velocidades', () => {
    // La mitad del recorrido sin Shift y a fondo con Shift, 5° por muesca: el
    // que nunca abrió los ajustes vuela el teclado y la rueda como siempre.
    expect(CONTROLES_POR_DEFECTO).toMatchObject({
      velocidadNormal: 0.5,
      velocidadSubida: 0.5,
      velocidadGiro: 0.5,
      multiplicadorShift: 2,
      pasoDeRueda: 5,
      invertirVertical: false,
    });
    expect(Object.isFrozen(CONTROLES_POR_DEFECTO)).toBe(true);
  });
});

describe('leerPreferencias — el cuerpo del PUT', () => {
  it.each(CONTRATO.ejemplos.validos)('acepta: $caso', ({ cuerpo }) => {
    const lectura = leerPreferencias(cuerpo);
    expect(lectura.ok).toBe(true);
    // Lo que vino se guarda tal cual, y lo que no vino vuelve al valor por defecto.
    const esperado = { ...CONTROLES_POR_DEFECTO, ...(cuerpo.controles as Partial<PreferenciasDeControl>) };
    expect(lectura.ok && lectura.controles).toEqual(esperado);
  });

  it.each(CONTRATO.ejemplos.invalidos)('rechaza: $caso ($porque)', ({ cuerpo }) => {
    const lectura = leerPreferencias(cuerpo);
    expect(lectura.ok).toBe(false);
    expect(!lectura.ok && lectura.error).toBeTruthy();
  });

  it('dice qué está mal, con el rango escrito como se escribe acá', () => {
    expect(leerPreferencias({ controles: { velocidadNormal: 0.05 } })).toEqual({
      ok: false,
      error: 'controles.velocidadNormal tiene que ser un número entre 0,1 y 1',
    });
    expect(leerPreferencias({ controles: { invertirVertical: 'sí' } })).toEqual({
      ok: false,
      error: 'controles.invertirVertical tiene que ser true o false',
    });
    expect(leerPreferencias({ controles: {}, username: 'admin' })).toEqual({ ok: false, error: 'Campo desconocido: username' });
    expect(leerPreferencias({ controles: { volumen: 1 } })).toEqual({ ok: false, error: 'Ajuste desconocido: controles.volumen' });
  });

  it('no se confunde con lo que hereda cualquier objeto', () => {
    // `in` diría que "toString" es un ajuste: es de Object.prototype.
    expect(leerPreferencias({ controles: { toString: 1 } }).ok).toBe(false);
    expect(leerPreferencias(JSON.parse('{"controles": {"__proto__": {"pasoDeRueda": 9}}}')).ok).toBe(false);
    expect(leerPreferencias(JSON.parse('{"__proto__": {}, "controles": {}}')).ok).toBe(false);
  });

  it.each([null, 'controles', 42, [], [{ controles: {} }]])('un cuerpo que no es un objeto (%j) no pasa', (cuerpo) => {
    expect(leerPreferencias(cuerpo)).toEqual({ ok: false, error: 'El cuerpo tiene que ser un objeto con controles' });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('un número que no es del rango (%s) no pasa', (valor) => {
    expect(leerPreferencias({ controles: { sensibilidadHorizontal: valor } }).ok).toBe(false);
  });
});

describe('excedeElTamanio — el techo del cuerpo', () => {
  it('el juego completo entra holgado; lo que pasa de 2 KB, no', () => {
    expect(excedeElTamanio({ controles: CONTROLES_POR_DEFECTO })).toBe(false);
    expect(excedeElTamanio({ controles: {}, relleno: 'x'.repeat(CUERPO_MAXIMO_BYTES) })).toBe(true);
  });

  it('se mide en bytes y no en letras: una eñe ocupa dos', () => {
    // `{"a":"…"}` son 8 bytes de armazón: con 1020 eñes son 2048, justo el techo.
    expect(excedeElTamanio({ a: 'ñ'.repeat(1020) })).toBe(false);
    expect(excedeElTamanio({ a: 'ñ'.repeat(1021) })).toBe(true);
  });

  it('sin cuerpo no hay nada que medir', () => {
    expect(excedeElTamanio(undefined)).toBe(false);
  });
});

describe('normalizarGuardadas — lo que hay en la fila', () => {
  it('un juego válido vuelve igual', () => {
    const guardado = { ...CONTROLES_POR_DEFECTO, sensibilidadVertical: 0.4, invertirVertical: true };
    expect(normalizarGuardadas(JSON.stringify(guardado))).toEqual(guardado);
  });

  it('lo que ya no sirve cae a su valor por defecto, clave por clave, y lo desconocido se va', () => {
    const fila = JSON.stringify({ sensibilidadHorizontal: 9, velocidadGiro: 0.7, invertirVertical: 'no', viejo: 1 });
    expect(normalizarGuardadas(fila)).toEqual({ ...CONTROLES_POR_DEFECTO, velocidadGiro: 0.7 });
  });

  it.each(['{roto', 'null', '[1,2]', '"texto"'])('un JSON roto o que no es un objeto (%s) son los de fábrica', (texto) => {
    expect(normalizarGuardadas(texto)).toEqual(CONTROLES_POR_DEFECTO);
  });
});

describe('preferenciasDe y guardarPreferencias — en la base', () => {
  beforeEach(() => {
    limpiarBase();
    for (const username of ['ana', 'beto']) {
      db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'h', 'operator')").run(username);
    }
  });

  it('sin nada guardado devuelve los de fábrica, sin fecha', () => {
    expect(preferenciasDe('ana')).toEqual({ controles: CONTROLES_POR_DEFECTO, actualizadoEn: null });
  });

  it('guarda, devuelve lo guardado con la fecha y lo reemplaza entero la vez siguiente', () => {
    const primero = { ...CONTROLES_POR_DEFECTO, sensibilidadHorizontal: 2.2 };
    const guardadas = guardarPreferencias('ana', primero);
    expect(guardadas.controles).toEqual(primero);
    expect(Date.parse(guardadas.actualizadoEn!)).not.toBeNaN();
    expect(preferenciasDe('ana')).toEqual(guardadas);

    const segundo = { ...CONTROLES_POR_DEFECTO, pasoDeRueda: 2 };
    guardarPreferencias('ana', segundo);
    expect(preferenciasDe('ana').controles).toEqual(segundo);
    expect(db.prepare('SELECT COUNT(*) AS n FROM preferencias_de_usuario').get()).toEqual({ n: 1 });
  });

  it('las de una persona no tocan las de otra', () => {
    guardarPreferencias('ana', { ...CONTROLES_POR_DEFECTO, velocidadNormal: 0.9 });
    expect(preferenciasDe('beto').controles).toEqual(CONTROLES_POR_DEFECTO);
  });

  it('lo que se devuelve no es el mismo objeto que se guardó', () => {
    const controles = { ...CONTROLES_POR_DEFECTO };
    const guardadas = guardarPreferencias('ana', controles);
    guardadas.controles.pasoDeRueda = 12;
    expect(preferenciasDe('ana').controles.pasoDeRueda).toBe(CONTROLES_POR_DEFECTO.pasoDeRueda);
  });

  it('una fila que se echó a perder se lee con los valores por defecto', () => {
    db.prepare("INSERT INTO preferencias_de_usuario (username, controles, actualizado_en) VALUES ('beto', '{roto', 'ayer')").run();
    expect(preferenciasDe('beto')).toEqual({ controles: CONTROLES_POR_DEFECTO, actualizadoEn: 'ayer' });
  });

  it('sólo se guardan preferencias de una cuenta que existe', () => {
    expect(() => guardarPreferencias('nadie', { ...CONTROLES_POR_DEFECTO })).toThrow(/FOREIGN KEY/);
  });
});
