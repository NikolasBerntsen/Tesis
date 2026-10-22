import { describe, expect, it } from 'vitest';
import { esc } from './html';

describe('esc', () => {
  it('escapa lo que el HTML interpretaría, con entidades numéricas', () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe('&#60;img src=x onerror=&#34;alert(1)&#34;&#62;');
    expect(esc('Tom & Jerry')).toBe('Tom &#38; Jerry');
    expect(esc("d'Artagnan")).toBe('d&#39;Artagnan');
  });

  it('el resultado, puesto con innerHTML, es texto y no crea elementos', () => {
    const malicioso = '<img src=x onerror=alert(1)><b>negrita</b>';
    const caja = document.createElement('div');
    caja.innerHTML = esc(malicioso);
    expect(caja.children).toHaveLength(0);
    expect(caja.textContent).toBe(malicioso);
  });

  it('sirve dentro de un atributo entre comillas, simples o dobles', () => {
    const caja = document.createElement('div');
    caja.innerHTML = `<input value="${esc('" onfocus="robar()')}"><input value='${esc("' onfocus='robar()")}'>`;
    const [doble, simple] = Array.from(caja.querySelectorAll('input'));
    expect(doble.getAttribute('onfocus')).toBeNull();
    expect(doble.value).toBe('" onfocus="robar()');
    expect(simple.getAttribute('onfocus')).toBeNull();
    expect(simple.value).toBe("' onfocus='robar()");
  });

  it('un dato que llegó sin tipo se escapa en vez de romper', () => {
    expect(esc(42 as unknown as string)).toBe('42');
  });

  it('un texto sin nada que escapar queda igual', () => {
    expect(esc('Nodo 3 · Portón')).toBe('Nodo 3 · Portón');
  });
});
