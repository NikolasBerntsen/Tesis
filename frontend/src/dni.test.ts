import { describe, expect, it } from 'vitest';
import { formatearDni, normalizarDni } from './dni';

describe('normalizarDni', () => {
  it('acepta el DNI con o sin puntos y espacios y lo deja en dígitos', () => {
    expect(normalizarDni('30.123.456')).toBe('30123456');
    expect(normalizarDni(' 30 123 456 ')).toBe('30123456');
    expect(normalizarDni('30123456')).toBe('30123456');
    expect(normalizarDni('1.234.567')).toBe('1234567');
  });

  it('rechaza lo que no tiene 7 u 8 dígitos o trae otros caracteres', () => {
    for (const malo of ['', '...', '123456', '123456789', '30-123-456', '30123a56']) {
      expect(normalizarDni(malo), malo).toBeNull();
    }
  });

  // Mismo criterio que el backend: "05.123.456" es el 5.123.456 como figura en
  // el CUIL. Si la consola lo dejaba pasar con el cero, el admin creía que
  // cargaba otro DNI y el backend lo guardaba como uno distinto.
  it('saca los ceros a la izquierda: no cambian el número', () => {
    expect(normalizarDni('05.123.456')).toBe('5123456');
    expect(normalizarDni('05123456')).toBe('5123456');
    expect(normalizarDni('0001234567')).toBe('1234567');
  });

  it('los 7 u 8 dígitos se cuentan ya sin los ceros', () => {
    for (const malo of ['00000000', '00.000.000', '0', '0612345']) {
      expect(normalizarDni(malo), malo).toBeNull();
    }
  });
});

describe('formatearDni', () => {
  it('agrupa de a tres desde la derecha, como en el documento', () => {
    expect(formatearDni('30123456')).toBe('30.123.456');
    expect(formatearDni('1234567')).toBe('1.234.567');
    expect(formatearDni('123')).toBe('123');
  });

  it('una cuenta sin DNI no se formatea', () => {
    expect(formatearDni('')).toBe('');
    expect(formatearDni(undefined)).toBe('');
  });

  it('muestra la forma canónica aunque llegue con el cero del CUIL', () => {
    expect(formatearDni('05123456')).toBe('5.123.456');
    expect(formatearDni('00000000')).toBe('');
  });
});
