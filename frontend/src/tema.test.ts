import { describe, it, expect, beforeEach, vi } from 'vitest';
import { alternarTema, aplicarTema, temaGuardado } from './tema';

/** Simula lo que responde el sistema operativo. */
function conPreferencia(oscuro: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: oscuro && q.includes('dark') }));
}

describe('tema', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.tema;
    vi.unstubAllGlobals();
  });

  it('sin elección guardada sigue la preferencia del sistema', () => {
    conPreferencia(true);
    expect(temaGuardado()).toBe('oscuro');
    conPreferencia(false);
    expect(temaGuardado()).toBe('claro');
  });

  it('la elección guardada le gana a la preferencia del sistema', () => {
    conPreferencia(true);
    aplicarTema('claro');
    expect(temaGuardado()).toBe('claro');
  });

  it('un valor basura en el almacenamiento no rompe: cae a la preferencia', () => {
    conPreferencia(true);
    localStorage.setItem('cc_tema', 'turquesa');
    expect(temaGuardado()).toBe('oscuro');
  });

  it('sin matchMedia (navegador viejo o jsdom pelado) asume claro', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(temaGuardado()).toBe('claro');
  });

  it('aplicar escribe el atributo que leen los tokens del CSS', () => {
    aplicarTema('oscuro');
    expect(document.documentElement.dataset.tema).toBe('oscuro');
    aplicarTema('claro');
    expect(document.documentElement.dataset.tema).toBe('claro');
  });

  it('alternar va y vuelve', () => {
    expect(alternarTema('claro')).toBe('oscuro');
    expect(alternarTema('oscuro')).toBe('claro');
  });
});
