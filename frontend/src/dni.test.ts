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
});
