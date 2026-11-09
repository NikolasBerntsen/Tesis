import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AJUSTES_DEL_DRON,
  CLAVES_DE_AJUSTE,
  REACCIONES_A_DETECCION,
  ROTULOS_DE_REACCION,
  esReaccionADeteccion,
  leerAjustes,
  textoDelAjuste,
} from '../../src/ajustes';
import { createDrone, getDrone, toDroneAssetView, updateDrone, type DroneAsset } from '../../src/store';
import { droneCard, mensajeDeAjustes } from '../../src/ws';
import { limpiarBase } from '../helpers';

// Los ajustes del dron (VUELO §10) contra el contrato que comparten el backend,
// la consola y la app: docs/contrato/ajustes.json. La prueba carga el archivo
// (fs, relativo a la raíz del repo) porque es lo que dice el contrato: si
// cambia un rango, tiene que romper acá hasta que las tres puntas lo sigan.

interface Ejemplo {
  caso: string;
  porque?: string;
  cuerpo: Record<string, unknown>;
}

interface AjusteDelContrato {
  tipo: string;
  minimo?: number;
  maximo?: number;
  paso?: number;
  decimales?: number;
  porDefecto: number | string;
  valores?: string[];
  rotulos?: Record<string, string>;
}

const CONTRATO = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/contrato/ajustes.json'), 'utf8'),
) as {
  ajustes: Record<string, AjusteDelContrato>;
  ejemplos: { validos: Ejemplo[]; invalidos: Ejemplo[] };
};

describe('ajustes — los números son los del contrato', () => {
  it('las mismas claves, con el mismo tipo, rango, paso y valor de fábrica', () => {
    expect([...CLAVES_DE_AJUSTE].sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(CONTRATO.ajustes).sort((a, b) => a.localeCompare(b)),
    );
    for (const clave of CLAVES_DE_AJUSTE) {
      const propio = AJUSTES_DEL_DRON[clave] as unknown as AjusteDelContrato;
      const delContrato = CONTRATO.ajustes[clave];
      expect(propio.tipo, clave).toBe(delContrato.tipo);
      expect(propio.porDefecto, clave).toBe(delContrato.porDefecto);
      if (delContrato.tipo === 'enum') {
        expect(propio.valores, clave).toEqual(delContrato.valores);
      } else {
        expect([propio.minimo, propio.maximo, propio.paso], clave).toEqual([delContrato.minimo, delContrato.maximo, delContrato.paso]);
        expect(propio.decimales, clave).toBe(delContrato.decimales);
      }
    }
  });

  it('la lista de reacciones y sus rótulos son los del contrato', () => {
    const reaccion = CONTRATO.ajustes.reaccionADeteccion;
    expect([...REACCIONES_A_DETECCION]).toEqual(reaccion.valores);
    expect(ROTULOS_DE_REACCION).toEqual(reaccion.rotulos);
    // el valor de fábrica tiene que ser una reacción que exista
    expect(esReaccionADeteccion(reaccion.porDefecto)).toBe(true);
  });

  it('los valores de fábrica entran en su propio rango: la app los tiene que poder recortar', () => {
    const silencio = AJUSTES_DEL_DRON.silencioAlRetomarS;
    expect(leerAjustes({ silencioAlRetomarS: silencio.porDefecto }).ok).toBe(true);
    expect(leerAjustes({ velocidadOrbitaMs: AJUSTES_DEL_DRON.velocidadOrbitaMs.porDefecto }).ok).toBe(true);
    expect(leerAjustes({ reaccionADeteccion: AJUSTES_DEL_DRON.reaccionADeteccion.porDefecto }).ok).toBe(true);
  });
});

describe('leerAjustes — el cuerpo del PATCH', () => {
  it.each(CONTRATO.ejemplos.validos)('acepta: $caso', ({ cuerpo }) => {
    const lectura = leerAjustes(cuerpo);
    expect(lectura.ok).toBe(true);
    // Lo que vino se devuelve tal cual (la velocidad ya redondeada a un decimal) y nada más.
    const esperado = Object.fromEntries(
      Object.entries(cuerpo).map(([k, v]) => [k, k === 'velocidadOrbitaMs' && typeof v === 'number' ? Math.round(v * 10) / 10 : v]),
    );
    expect(lectura.ok && lectura.ajustes).toEqual(esperado);
  });

  it.each(CONTRATO.ejemplos.invalidos)('rechaza: $caso ($porque)', ({ cuerpo }) => {
    const lectura = leerAjustes(cuerpo);
    expect(lectura.ok).toBe(false);
    expect(!lectura.ok && lectura.error).toBeTruthy();
  });

  it('devuelve solo las claves que vinieron: lo que no se nombra no se toca', () => {
    expect(leerAjustes({ silencioAlRetomarS: 5 })).toEqual({ ok: true, ajustes: { silencioAlRetomarS: 5 } });
    const lectura = leerAjustes({ reaccionADeteccion: null });
    expect(lectura.ok && Object.keys(lectura.ajustes)).toEqual(['reaccionADeteccion']);
  });

  it('una clave que no es un ajuste se ignora si viene con una conocida; sola, no hay nada para ajustar', () => {
    expect(leerAjustes({ velocidadOrbitaMs: 3, velocidad: 9 })).toEqual({ ok: true, ajustes: { velocidadOrbitaMs: 3 } });
    expect(leerAjustes({ velocidad: 9 })).toEqual({
      ok: false,
      error: 'Nada para ajustar: mandá velocidadOrbitaMs, reaccionADeteccion o silencioAlRetomarS',
    });
  });

  it('dice qué está mal, con el rango', () => {
    expect(leerAjustes({ velocidadOrbitaMs: 0.5 })).toEqual({ ok: false, error: 'velocidadOrbitaMs tiene que estar entre 1 y 8 m/s' });
    expect(leerAjustes({ velocidadOrbitaMs: '3' })).toEqual({ ok: false, error: 'velocidadOrbitaMs tiene que ser un número o null' });
    expect(leerAjustes({ reaccionADeteccion: 'SEGUIR' })).toEqual({
      ok: false,
      error: 'reaccionADeteccion tiene que ser seguir_y_orbitar, orbitar, seguir o detenerse, o null',
    });
    expect(leerAjustes({ silencioAlRetomarS: 12 })).toEqual({
      ok: false,
      error: 'silencioAlRetomarS tiene que ser un entero entre 0 y 30, de a 5, o null',
    });
  });

  it('redondea la velocidad a un decimal y acepta los dos extremos de cada rango', () => {
    expect(leerAjustes({ velocidadOrbitaMs: 3.456 })).toEqual({ ok: true, ajustes: { velocidadOrbitaMs: 3.5 } });
    for (const v of [1, 8]) expect(leerAjustes({ velocidadOrbitaMs: v }).ok, `velocidad ${v}`).toBe(true);
    for (const s of [0, 5, 25, 30]) expect(leerAjustes({ silencioAlRetomarS: s }).ok, `silencio ${s}`).toBe(true);
    for (const r of REACCIONES_A_DETECCION) expect(leerAjustes({ reaccionADeteccion: r }).ok, r).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, true, {}, [], 'cuatro'])('una velocidad que no es del rango (%s) no pasa', (valor) => {
    expect(leerAjustes({ velocidadOrbitaMs: valor }).ok).toBe(false);
  });

  it.each([-5, 35, 7, 10.5, true, '10', Number.NaN, 1e300, {}])('un silencio que no es un entero de a 5 entre 0 y 30 (%s) no pasa', (valor) => {
    expect(leerAjustes({ silencioAlRetomarS: valor }).ok).toBe(false);
  });

  it.each(['perseguir', 'SEGUIR', 'Orbitar', '', 0, true, ['seguir'], {}])('una reacción que no está en la lista (%j) no pasa', (valor) => {
    expect(leerAjustes({ reaccionADeteccion: valor }).ok).toBe(false);
  });

  it('un valor malo rechaza el cuerpo entero aunque los otros estén bien', () => {
    expect(leerAjustes({ velocidadOrbitaMs: 3, reaccionADeteccion: 'seguir', silencioAlRetomarS: 7 }).ok).toBe(false);
    expect(leerAjustes({ velocidadOrbitaMs: 9, reaccionADeteccion: 'seguir' }).ok).toBe(false);
    expect(leerAjustes({ velocidadOrbitaMs: 3, reaccionADeteccion: 'volar' }).ok).toBe(false);
  });

  it.each([null, 'ajustes', 42, [], [{ velocidadOrbitaMs: 3 }]])('un cuerpo que no es un objeto (%j) no pasa', (cuerpo) => {
    expect(leerAjustes(cuerpo)).toEqual({ ok: false, error: 'El cuerpo tiene que ser un objeto con los ajustes' });
  });

  it('no se confunde con lo que hereda cualquier objeto', () => {
    expect(leerAjustes({ toString: 1 }).ok).toBe(false);
    expect(leerAjustes(JSON.parse('{"__proto__": {"velocidadOrbitaMs": 3}}')).ok).toBe(false);
    expect(leerAjustes(JSON.parse('{"__proto__": {}, "silencioAlRetomarS": 10}')).ok).toBe(true);
  });
});

describe('textoDelAjuste — cómo se lee en el registro', () => {
  it('nombra el valor con su unidad o su rótulo, y «de fábrica» con el género del ajuste', () => {
    expect(textoDelAjuste('velocidadOrbitaMs', 2.5)).toBe('2.5 m/s');
    expect(textoDelAjuste('velocidadOrbitaMs', null)).toBe('la de fábrica');
    expect(textoDelAjuste('reaccionADeteccion', 'orbitar')).toBe('«Órbita en el lugar»');
    expect(textoDelAjuste('reaccionADeteccion', null)).toBe('la de fábrica');
    expect(textoDelAjuste('silencioAlRetomarS', 30)).toBe('30 s');
    expect(textoDelAjuste('silencioAlRetomarS', null)).toBe('el de fábrica');
  });
});

describe('ajustes — guardados con el dron y en la ficha', () => {
  beforeEach(limpiarBase);

  it('el dron nace con los tres de fábrica y cada uno se cambia y se vuelve a fábrica por separado', () => {
    const d = createDrone({ displayName: 'Alfa' }, 'campo');
    expect(d).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null });

    const r1 = updateDrone(d.hash, { reaccionADeteccion: 'detenerse', silencioAlRetomarS: 0 })!;
    expect(r1.before).toMatchObject({ reaccionADeteccion: null, silencioAlRetomarS: null });
    expect(r1.after).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: 'detenerse', silencioAlRetomarS: 0 });

    // lo que no se nombra no se toca
    const r2 = updateDrone(d.hash, { velocidadOrbitaMs: 2.5 })!;
    expect(r2.after).toMatchObject({ velocidadOrbitaMs: 2.5, reaccionADeteccion: 'detenerse', silencioAlRetomarS: 0 });

    // null es "el de fábrica", no "dejalo como está"
    const r3 = updateDrone(d.hash, { reaccionADeteccion: null, silencioAlRetomarS: null, velocidadOrbitaMs: null })!;
    expect(r3.after).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null });
    expect(getDrone(d.hash)).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null });
  });

  it('la ficha y el mensaje `ajustes` llevan los tres, con null en los de fábrica', () => {
    const d = createDrone({ displayName: 'Alfa' }, 'campo');
    updateDrone(d.hash, { silencioAlRetomarS: 20 });
    expect(droneCard(d.hash)).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: 20 });
    expect(mensajeDeAjustes(d.hash)).toEqual({
      type: 'ajustes', velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: 20, by: 'Comando Central',
    });
    expect(mensajeDeAjustes(d.hash, 'operador').by).toBe('operador');
    // de un dron que no existe salen los de fábrica: no hay nada guardado
    expect(mensajeDeAjustes('inexistente')).toMatchObject({ velocidadOrbitaMs: null, reaccionADeteccion: null, silencioAlRetomarS: null });
  });

  it('una reacción guardada que no está en la lista se lee como la de fábrica', () => {
    const fila: DroneAsset = {
      id: 1, hash: 'abc', display_name: 'X', model: '', inventory_code: '', active: 1, base_id: null,
      created_at: '2020-01-01T00:00:00.000Z', created_by: null, deleted: 0, deleted_at: null, deleted_by: null,
    };
    // una fila tocada a mano, o una reacción que dejó de existir: la app descartaría el mensaje entero
    expect(toDroneAssetView({ ...fila, reaccion_deteccion: 'perseguir' }).reaccionADeteccion).toBeNull();
    expect(toDroneAssetView({ ...fila, reaccion_deteccion: 'seguir' }).reaccionADeteccion).toBe('seguir');
    expect(toDroneAssetView({ ...fila, silencio_al_retomar_s: 10 }).silencioAlRetomarS).toBe(10);
    expect(toDroneAssetView({ ...fila, silencio_al_retomar_s: null }).silencioAlRetomarS).toBeNull();
  });
});
