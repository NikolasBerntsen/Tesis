import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { traerEmergencia } from '../api';
import { ContextoDeRelevosYEmergencias, SIN_OPERACION } from '../relevosYEmergencias';
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import { makeEmergencia, makeEvent, makeRelevo } from '../test/fixtures';
import type { Relevo } from '../types';
import LogDetailModal from './LogDetailModal';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  traerEmergencia: vi.fn(),
}));
const traerMock = vi.mocked(traerEmergencia);

/** Los eventos que deja el hub con un relevo (§7 del contrato): `detalle` lleva todas las claves. */
function eventoDeRelevo(type: string, detalle: Record<string, unknown> = {}) {
  return makeEvent({
    id: 70,
    type,
    source: 'backend',
    message: `Evento ${type}`,
    drone_id: 'a1',
    meta: JSON.stringify({
      drone: { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' },
      detalle: {
        relevoId: 7,
        motivo: 'patrulla',
        estado: 'FALLIDO',
        motivoFin: 'sin_despegue',
        origen: 'Alfa',
        relevo: 'Bravo',
        relevoHash: 'b7e4209c3f1a4d6e8b2c5a7f9d1e3c40',
        rutaId: 1,
        desdeNodo: 3,
        motivoDeB: 'sin_respuesta',
        ...detalle,
      },
    }),
  });
}

function abrir(fila: ReturnType<typeof makeEvent>, relevos: Relevo[] = []) {
  const envolver = (hijo: ReactNode) => (
    <ContextoDeRelevosYEmergencias.Provider value={{ ...SIN_OPERACION, relevos }}>{hijo}</ContextoDeRelevosYEmergencias.Provider>
  );
  render(envolver(<LogDetailModal fila={fila} onCerrar={vi.fn()} />));
  return screen.getByRole('dialog');
}

/** El valor de una fila de datos, buscado por su rótulo. */
function dato(caja: HTMLElement, rotulo: string): HTMLElement {
  return within(caja).getAllByText(rotulo, { selector: 'dt' })[0].nextElementSibling as HTMLElement;
}

describe('el detalle de los eventos de relevos, desvíos y emergencias', () => {
  beforeEach(() => {
    traerMock.mockReset();
    limpiarEstadoMapa();
  });

  it('la cabecera lleva el rótulo delante del código', () => {
    const caja = abrir(eventoDeRelevo('RELAY_FAILED'));
    expect(caja).toHaveTextContent('Relevo fallido · RELAY_FAILED');
  });

  it('un tipo sin rótulo deja sólo el código, como siempre', () => {
    const caja = abrir(makeEvent({ type: 'PATROL_STARTED', message: 'Arrancó' }));
    expect(within(caja).getByText('PATROL_STARTED')).toBeInTheDocument();
    expect(caja).not.toHaveTextContent('· PATROL_STARTED');
  });

  it('el detalle de un relevo se lee en castellano y sin el hash del dron de relevo', () => {
    const caja = abrir(eventoDeRelevo('RELAY_FAILED'));
    expect(dato(caja, 'Relevo')).toHaveTextContent('7');
    expect(dato(caja, 'Motivo')).toHaveTextContent('Patrulla');
    expect(dato(caja, 'Estado')).toHaveTextContent('Fallido');
    expect(dato(caja, 'Cómo terminó')).toHaveTextContent('El dron de relevo no pudo despegar a tiempo');
    expect(dato(caja, 'Pidió el relevo')).toHaveTextContent('Alfa');
    expect(dato(caja, 'Dron de relevo')).toHaveTextContent('Bravo');
    expect(dato(caja, 'Motivo del dron de relevo')).toHaveTextContent('No contestó a tiempo');
    expect(dato(caja, 'Desde el nodo')).toHaveTextContent('3');
    expect(caja).not.toHaveTextContent('b7e4209c');
    expect(within(caja).queryByText('relevoHash')).not.toBeInTheDocument();
  });

  it('un motivo que no es de la lista (un hub más nuevo) pasa tal cual', () => {
    const caja = abrir(eventoDeRelevo('RELAY_REJECTED', { motivoDeB: 'algo_nuevo' }));
    expect(dato(caja, 'Motivo del dron de relevo')).toHaveTextContent('algo_nuevo');
  });

  it('si la consola sigue el relevo, dice cómo está ahora, con su motivo de fin', () => {
    const caja = abrir(eventoDeRelevo('RELAY_STARTED'), [
      makeRelevo({ estado: 'CANCELADO', motivoFin: 'alerta_descartada', relevo: null }),
    ]);
    const ahora = within(caja).getByTestId('relevo-ahora');
    expect(within(caja).getByRole('heading', { name: 'Relevo #7 ahora' })).toBeInTheDocument();
    expect(within(ahora).getByText('Cancelado')).toHaveClass('estado', 'muted');
    expect(ahora).toHaveTextContent('Cancelado · La alerta se descartó');
    expect(dato(ahora, 'Dron de relevo')).toHaveTextContent('Sin candidato');
    // Terminado, ya no llega a ningún lado.
    expect(within(ahora).queryByText('Llega en')).not.toBeInTheDocument();
  });

  it('en camino sin hora de llegada no inventa una', () => {
    const caja = abrir(eventoDeRelevo('RELAY_STARTED'), [makeRelevo({ etaS: null })]);
    expect(within(caja).getByTestId('relevo-ahora')).toHaveTextContent('En camino');
    expect(within(caja).queryByText('Llega en')).not.toBeInTheDocument();
  });

  it('un relevo que la consola no conoce no agrega nada a lo que guardó el evento', () => {
    const caja = abrir(eventoDeRelevo('RELAY_COMPLETED'), [makeRelevo({ id: 99 })]);
    expect(within(caja).queryByTestId('relevo-ahora')).not.toBeInTheDocument();
    expect(dato(caja, 'Estado')).toHaveTextContent('Fallido');
  });

  it('un desvío a otra base muestra adónde y el mapa de dónde estaba', () => {
    const caja = abrir(
      makeEvent({
        type: 'RTH_DIVERTED',
        message: 'Alfa se desvía a Base Sur',
        meta: JSON.stringify({
          drone: { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' },
          ubicacion: { lat: -34.879, lon: -56.185, accuracyM: null },
          detalle: { motivo: 'otra_base', baseId: 2, base: 'Base Sur', relevoId: 5 },
        }),
      }),
    );
    expect(caja).toHaveTextContent('Regreso desviado · RTH_DIVERTED');
    expect(dato(caja, 'Motivo')).toHaveTextContent('A otra base');
    expect(dato(caja, 'Base')).toHaveTextContent('Base Sur');
    expect(dato(caja, 'Base (id)')).toHaveTextContent('2');
    expect(within(caja).getByTestId('mapa-ubicacion')).toBeInTheDocument();
  });

  it('un EMERGENCY_RECOVERED trae la ficha de la emergencia y dice quién la marcó', async () => {
    traerMock.mockImplementation(async (id) => {
      const { fotos: _n, ...resto } = makeEmergencia({ id, recuperadaEn: '2026-10-23T15:40:00.000Z', recuperadaPor: 'campo1' });
      return { ...resto, fotos: [] };
    });
    const caja = abrir(
      makeEvent({
        type: 'EMERGENCY_RECOVERED',
        message: 'campo1 recuperó a Alfa',
        meta: JSON.stringify({
          drone: { hash: 'a1', displayName: 'Alfa', model: 'DJI Mini 4 Pro' },
          emergencia: { id: 3, motivo: 'autonomia', lat: -34.8702, lon: -56.1902, ts: '2026-10-23T15:04:05.300Z' },
          detalle: { por: 'campo1' },
        }),
      }),
    );
    expect(caja).toHaveTextContent('Dron recuperado · EMERGENCY_RECOVERED');
    expect(await within(caja).findByText('Recuperado', { selector: '.estado' })).toBeInTheDocument();
    expect(traerMock).toHaveBeenCalledWith(3);
    expect(dato(caja, 'Por')).toHaveTextContent('campo1');
    // La ficha del dron va adentro de la de la emergencia: no se repite.
    expect(within(caja).queryByText('Modelo', { selector: 'dt' })).not.toBeInTheDocument();
  });
});
