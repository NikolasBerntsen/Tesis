import { describe, expect, it } from 'vitest';
import {
  GRADOS_POR_MUESCA,
  INCLINACION_MAXIMA,
  INCLINACION_MINIMA,
  ZOOM_MAXIMO,
  acotarEje,
  acotarInclinacion,
  acotarZoom,
  giroDelMouse,
  muescasDeRueda,
  pasosDeRueda,
  recortarInclinacion,
  textoDeAltura,
  textoDeInclinacion,
  textoDeZoom,
} from './pilotaje';

describe('acotarEje', () => {
  it('recorta a [-1, 1], redondea a dos decimales y aplica la zona muerta del mando', () => {
    expect(acotarEje(3)).toBe(1);
    expect(acotarEje(-7)).toBe(-1);
    expect(acotarEje(0.333)).toBe(0.33);
    // La zona muerta es la de la app: por debajo de 0,05 el dron no lo ejecuta.
    expect(acotarEje(0.04)).toBe(0);
    expect(acotarEje(-0.044)).toBe(0);
    // El borde exacto NO es zona muerta, como en MandoVirtual y en el Android.
    expect(acotarEje(0.05)).toBe(0.05);
  });
});

describe('acotarInclinacion', () => {
  it('se queda en el rango del contrato, de -90 a 30', () => {
    expect(acotarInclinacion(-120)).toBe(INCLINACION_MINIMA);
    expect(acotarInclinacion(45)).toBe(INCLINACION_MAXIMA);
    expect(acotarInclinacion(-30)).toBe(-30);
  });

  it('deja un decimal: el modo mouse suma fracciones de grado', () => {
    expect(acotarInclinacion(-30.149)).toBe(-30.1);
  });
});

describe('recortarInclinacion', () => {
  it('se queda en el rango del contrato sin tocar los decimales', () => {
    expect(recortarInclinacion(-120)).toBe(INCLINACION_MINIMA);
    expect(recortarInclinacion(45)).toBe(INCLINACION_MAXIMA);
    // Es la cuenta exacta del modo mouse: redondearla acá es lo que la torcía.
    expect(recortarInclinacion(-29.85)).toBe(-29.85);
  });
});

describe('acotarZoom', () => {
  it('va de 1× a 8×', () => {
    expect(acotarZoom(0.5)).toBe(1);
    expect(acotarZoom(9)).toBe(ZOOM_MAXIMO);
    expect(acotarZoom(2.5)).toBe(2.5);
  });
});

describe('muescasDeRueda', () => {
  it('lleva cada deltaMode a muescas, con el signo de deltaY', () => {
    expect(muescasDeRueda({ deltaY: 100, deltaMode: 0 })).toBe(1);
    expect(muescasDeRueda({ deltaY: -100, deltaMode: 0 })).toBe(-1);
    // Firefox con mouse cuenta en líneas: 3 por muesca.
    expect(muescasDeRueda({ deltaY: -3, deltaMode: 1 })).toBe(-1);
    expect(muescasDeRueda({ deltaY: 1, deltaMode: 2 })).toBe(1);
  });

  it('un deltaMode desconocido se toma como píxeles', () => {
    expect(muescasDeRueda({ deltaY: 200, deltaMode: 7 })).toBe(2);
  });
});

describe('pasosDeRueda', () => {
  it('una muesca de mouse es un paso, mida 100 px o 125 px, y no deja resto', () => {
    // Con la pantalla escalada al 125 % Chromium manda 125 px por muesca:
    // arrastrar el 0,25 haría que cuatro muescas den cinco pasos.
    expect(pasosDeRueda(0, 1.25)).toEqual({ pasos: 1, resto: 0 });
    expect(pasosDeRueda(0.4, -1)).toEqual({ pasos: -1, resto: 0 });
    expect(pasosDeRueda(0, 2.2)).toEqual({ pasos: 2, resto: 0 });
  });

  it('el touchpad manda pedacitos: se acumulan hasta completar una muesca', () => {
    let resto = 0;
    let pasos = 0;
    for (let i = 0; i < 4; i += 1) {
      const r = pasosDeRueda(resto, 0.3);
      resto = r.resto;
      pasos += r.pasos;
    }
    // 4 × 0,3 = 1,2: un paso, y queda 0,2 para el que siga.
    expect(pasos).toBe(1);
    expect(resto).toBeCloseTo(0.2);
  });
});

describe('giroDelMouse', () => {
  it('es proporcional al movimiento y satura a fondo', () => {
    expect(giroDelMouse(12.5)).toBe(0.5);
    expect(giroDelMouse(-25)).toBe(-1);
    expect(giroDelMouse(300)).toBe(1);
    // Un temblor de un píxel no gira el dron: cae en la zona muerta.
    expect(giroDelMouse(1)).toBe(0);
  });
});

describe('textos del HUD', () => {
  it('la inclinación va en grados enteros', () => {
    expect(textoDeInclinacion(-30)).toBe('-30°');
    expect(textoDeInclinacion(-29.6)).toBe('-30°');
    expect(textoDeInclinacion(GRADOS_POR_MUESCA)).toBe('5°');
  });

  it('el zoom va con coma decimal', () => {
    expect(textoDeZoom(1)).toBe('1×');
    expect(textoDeZoom(2.5)).toBe('2,5×');
  });

  it('la altura con un decimal, o una raya si la app no la manda', () => {
    expect(textoDeAltura(12.34)).toBe('12.3 m');
    expect(textoDeAltura(undefined)).toBe('—');
    expect(textoDeAltura(Number.NaN)).toBe('—');
  });
});
