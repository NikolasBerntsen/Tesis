import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProveedorDeAlertas from './ProveedorDeAlertas';
import { useAlertasEnVivo } from '../alertasEnVivo';
import { api } from '../api';
import { makeAlert, makeDrone, makeStatus } from '../test/fixtures';
import { limpiarEstadoMapa } from '../test/dobleLeaflet';
import type { Alert } from '../types';

vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));

/** Lo que abre la alerta: el carrusel o la campana, reducidos a un botón. */
function Abridor({ alerta }: { alerta: Alert }) {
  const { abrirAlerta } = useAlertasEnVivo();
  return (
    <button type="button" onClick={() => abrirAlerta?.(alerta)}>
      Abrir la alerta
    </button>
  );
}

const ALFA = makeDrone({ droneId: 'd1', displayName: 'Alfa' });

function montar({ alertas = [makeAlert({ id: 7, drone_id: 'd1' })], conAbridor = true } = {}) {
  const props = {
    alertas,
    drones: [ALFA],
    statuses: { d1: makeStatus({ droneId: 'd1' }) },
    decidir: vi.fn(),
    verDron: vi.fn(),
  };
  const arbol = (lista: Alert[], abridor: boolean) => (
    <ProveedorDeAlertas {...props} alertas={lista}>
      {abridor && <Abridor alerta={alertas[0]} />}
    </ProveedorDeAlertas>
  );
  const { rerender } = render(arbol(alertas, conAbridor));
  return { ...props, cambiar: (lista: Alert[], abridor = true) => rerender(arbol(lista, abridor)) };
}

const popUp = () => screen.getByRole('dialog', { name: /Alerta de persona #7/ });

describe('ProveedorDeAlertas y el pop-up de una alerta', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    limpiarEstadoMapa();
  });

  it('abre el pop-up con el tipo, el dron y la hora en la cabecera', async () => {
    montar();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    const dialogo = popUp();
    expect(within(dialogo).getByText(/^Alfa · \d{1,2}:\d{2}:\d{2}$/)).toBeInTheDocument();
    // El título ya está en la cabecera: el cuerpo no lo repite.
    expect(within(dialogo).queryByRole('heading', { name: /^Alerta #7/ })).not.toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Ver feed en vivo' })).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Validar' })).toBeInTheDocument();
    // La alerta ya estaba en la consola: no se la pide al backend.
    expect(api).not.toHaveBeenCalled();
  });

  it('se cierra con la cruz, con el pie y con Escape', async () => {
    montar();
    const abrir = () => userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));

    await abrir();
    await userEvent.click(within(popUp()).getByRole('button', { name: 'Cerrar la alerta' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await abrir();
    await userEvent.click(within(popUp()).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await abrir();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"Ver feed en vivo" lleva al dron y cierra el pop-up', async () => {
    const { verDron } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    await userEvent.click(within(popUp()).getByRole('button', { name: 'Ver feed en vivo' }));
    expect(verDron).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('decidir desde el pop-up no lo cierra aunque se vaya lo que lo abrió', async () => {
    const { decidir, cambiar } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    await userEvent.click(within(popUp()).getByRole('button', { name: 'Validar' }));
    expect(decidir).toHaveBeenCalledWith(7, 'VALIDATED');

    // Era la última pendiente: el carrusel que la abrió se va de la vista.
    // El pop-up sigue, y muestra que la decisión quedó registrada.
    cambiar([makeAlert({ id: 7, drone_id: 'd1', status: 'VALIDATED', decided_by: 'oper1' })], false);
    expect(within(popUp()).getByText(/^Validada por oper1/)).toBeInTheDocument();
    expect(within(popUp()).queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('de un dron que ya no está en la flota, la cabecera lo dice', async () => {
    montar({ alertas: [makeAlert({ id: 7, drone_id: 'borrado' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    expect(within(popUp()).getByText(/^Dron desconocido · /)).toBeInTheDocument();
  });

  it('una alerta que la consola ya no tiene en su lista se muestra como la trajo quien la abrió', async () => {
    const vieja = makeAlert({ id: 7, drone_id: 'd1', snapshot: 'QUFB' });
    render(
      <ProveedorDeAlertas alertas={[]} drones={[ALFA]} statuses={{}} decidir={vi.fn()} verDron={vi.fn()}>
        <Abridor alerta={vieja} />
      </ProveedorDeAlertas>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    expect(within(popUp()).getByAltText('Captura de la detección')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('un tipo que la consola no conoce se nombra tal cual', async () => {
    montar({ alertas: [makeAlert({ id: 8, type: 'ANIMAL' as never, drone_id: 'd1' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Abrir la alerta' }));
    expect(screen.getByRole('dialog', { name: 'Alerta de animal #8' })).toBeInTheDocument();
  });
});
