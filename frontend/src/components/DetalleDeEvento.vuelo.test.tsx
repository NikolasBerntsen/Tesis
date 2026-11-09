import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContextoDeRelevosYEmergencias, SIN_OPERACION } from '../relevosYEmergencias';
import { makeEvent } from '../test/fixtures';
import LogDetailModal from './LogDetailModal';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

const ALFA = { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' };

/**
 * Un evento de ajuste del dron (PROTOCOLS §7, VUELO §11): antes, después y
 * quién. Como los deja el hub: `source` es el usuario que lo fijó.
 */
function eventoDeAjuste(type: string, antes: Record<string, unknown>, despues: Record<string, unknown>, detalle: Record<string, unknown>) {
  return makeEvent({
    id: 80,
    type,
    source: 'oper1',
    message: `Evento ${type}`,
    drone_id: 'a1',
    meta: JSON.stringify({ drone: ALFA, antes, despues, detalle }),
  });
}

/** Un `RTH_ORDERED` como lo deja el hub: `teniaElControl` es un usuario, o `null` si el dron volaba solo. */
function regresoOrdenado(teniaElControl: string | null) {
  return makeEvent({
    id: 81,
    type: 'RTH_ORDERED',
    source: 'oper1',
    message: 'oper1 ordenó el regreso a la base del dron "Alfa"',
    drone_id: 'a1',
    meta: JSON.stringify({ drone: ALFA, detalle: { por: 'oper1', teniaElControl } }),
  });
}

function abrir(fila: ReturnType<typeof makeEvent>) {
  const envolver = (hijo: ReactNode) => (
    <ContextoDeRelevosYEmergencias.Provider value={SIN_OPERACION}>{hijo}</ContextoDeRelevosYEmergencias.Provider>
  );
  render(envolver(<LogDetailModal fila={fila} onCerrar={vi.fn()} />));
  return screen.getByRole('dialog');
}

/** El valor de un campo en una columna de la comparación, buscado por su rótulo. */
function valorEn(columna: HTMLElement, rotulo: string): HTMLElement {
  return within(columna).getByText(rotulo, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

describe('el detalle de los eventos de los ajustes del dron', () => {
  it('el silencio al retomar: el rótulo en castellano, los segundos con su unidad y «De fábrica» en lugar de null', () => {
    const dialogo = abrir(
      eventoDeAjuste('RESUME_SILENCE_SET', { silencioAlRetomarS: null }, { silencioAlRetomarS: 30 }, { por: 'oper1', silencioAlRetomarS: 30 }),
    );
    const antes = dialogo.querySelector('.comparacion-col:not(.comparacion-despues)') as HTMLElement;
    const despues = dialogo.querySelector('.comparacion-despues') as HTMLElement;
    expect(valorEn(antes, 'Silencio al retomar')).toHaveTextContent('De fábrica');
    expect(valorEn(despues, 'Silencio al retomar')).toHaveTextContent('30 s');
    expect(valorEn(despues, 'Silencio al retomar')).toHaveClass('cambiado');
    // El rótulo del tipo, para el que no sabe qué es un RESUME_SILENCE_SET.
    expect(dialogo).toHaveTextContent('Silencio al retomar fijado');
  });

  it('la reacción ante una detección se lee con los rótulos del contrato', () => {
    const dialogo = abrir(
      eventoDeAjuste(
        'DETECTION_REACTION_SET',
        { reaccionADeteccion: 'seguir_y_orbitar' },
        { reaccionADeteccion: 'detenerse' },
        { por: 'oper1', reaccionADeteccion: 'detenerse' },
      ),
    );
    const antes = dialogo.querySelector('.comparacion-col:not(.comparacion-despues)') as HTMLElement;
    const despues = dialogo.querySelector('.comparacion-despues') as HTMLElement;
    expect(valorEn(antes, 'Ante una detección')).toHaveTextContent('Seguimiento y órbita');
    expect(valorEn(despues, 'Ante una detección')).toHaveTextContent('Detenerse y vigilar');
    // Y en el detalle, quién y qué.
    const detalle = within(dialogo).getAllByText('Ante una detección', { selector: 'dt' }).at(-1)!.nextElementSibling;
    expect(detalle).toHaveTextContent('Detenerse y vigilar');
    expect(dialogo).toHaveTextContent('Reacción ante una detección fijada');
  });

  it('la velocidad de órbita lleva su unidad, y volver a base por orden se rotula', () => {
    const dialogo = abrir(
      eventoDeAjuste('ORBIT_SPEED_SET', { velocidadOrbitaMs: 4 }, { velocidadOrbitaMs: 2.5 }, { por: 'oper1', velocidadOrbitaMs: 2.5 }),
    );
    const despues = dialogo.querySelector('.comparacion-despues') as HTMLElement;
    expect(valorEn(despues, 'Velocidad de órbita')).toHaveTextContent('2.5 m/s');
    expect(dialogo).toHaveTextContent('Velocidad de órbita fijada');
  });

  it('volver a la base ordenado desde la consola: quién, y a quién se le soltó el control', () => {
    const dialogo = abrir(regresoOrdenado('oper9'));
    expect(dialogo).toHaveTextContent('Volver a la base ordenado');
    const detalle = within(dialogo).getByText('Tenía el control', { selector: 'dt' }).nextElementSibling;
    expect(detalle).toHaveTextContent('oper9');
  });

  it('con el dron volando solo, `teniaElControl: null` se lee «Nadie (volaba solo)» y no la raya', () => {
    const dialogo = abrir(regresoOrdenado(null));
    const detalle = within(dialogo).getByText('Tenía el control', { selector: 'dt' }).nextElementSibling;
    expect(detalle).toHaveTextContent('Nadie (volaba solo)');
    expect(within(dialogo).getByText('Por', { selector: 'dt' }).nextElementSibling).toHaveTextContent('oper1');
  });
});
