import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeAlert, makeDrone } from '../test/fixtures';
import CampanaDeAlertas from './CampanaDeAlertas';

const DRONES = [makeDrone({ droneId: 'd1', displayName: 'Alfa' }), makeDrone({ droneId: 'd2', displayName: 'Bravo' })];

function montar(alerts = [makeAlert()], extra: Partial<Parameters<typeof CampanaDeAlertas>[0]> = {}) {
  const props = { alerts, drones: DRONES, onDecidir: vi.fn(), onVerDron: vi.fn(), ...extra };
  render(<CampanaDeAlertas {...props} />);
  return props;
}

describe('CampanaDeAlertas', () => {
  it('cuenta las pendientes y lo dice en el nombre accesible', () => {
    montar([makeAlert({ id: 1 }), makeAlert({ id: 2 }), makeAlert({ id: 3, status: 'VALIDATED' })]);

    const boton = screen.getByRole('button', { name: /2 pendientes/ });
    expect(within(boton).getByText('2')).toBeInTheDocument();
    // cerrada por defecto: la barra no puede tapar la vista sin que se lo pidan
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();
  });

  it('sin pendientes no cuenta nada y lo dice al abrirla', async () => {
    montar([]);
    expect(screen.getByRole('button', { name: /ninguna pendiente/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/sin alertas pendientes/i)).toBeInTheDocument();
  });

  it('lista la pendiente con su tipo y el nombre del dron, no el hash', async () => {
    montar([makeAlert({ id: 9, type: 'VEHICLE', drone_id: 'd2' })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));

    const panel = screen.getByRole('region', { name: /alertas de detección/i });
    expect(within(panel).getByText('VEHÍCULO')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Bravo' })).toBeInTheDocument();
  });

  it('valida y descarta desde el desplegable', async () => {
    const { onDecidir } = montar([makeAlert({ id: 42 })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(42, 'VALIDATED');

    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onDecidir).toHaveBeenCalledWith(42, 'DISMISSED');
  });

  // Antes el rechazo iba a console.error: el operador apretaba "Validar", no
  // pasaba nada, y creía que había decidido.
  it('si el backend rechaza la decisión, el motivo aparece junto a esa alerta', async () => {
    const onDecidir = vi.fn().mockRejectedValue(new Error('Esta alerta ya la decidió otro operador.'));
    montar([makeAlert({ id: 1, drone_id: 'd1' }), makeAlert({ id: 2, drone_id: 'd2' })], { onDecidir });
    await userEvent.click(screen.getByRole('button', { name: /2 pendientes/ }));

    const alertas = screen.getAllByRole('button', { name: 'Validar' });
    await userEvent.click(alertas[1]);

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent('Esta alerta ya la decidió otro operador.');
    // Pegado a la alerta que falló, no a la otra.
    expect(aviso.closest('.campana-alerta')).toHaveTextContent('Bravo');
    expect(aviso.closest('.campana-alerta')).not.toHaveTextContent('Alfa');
  });

  it('mientras la decisión viaja, esa alerta no acepta otro click', async () => {
    let terminar: () => void = () => {};
    const onDecidir = vi.fn(() => new Promise<void>((r) => (terminar = r)));
    montar([makeAlert({ id: 5 })], { onDecidir });
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeDisabled();

    terminar();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled());
  });

  // Con un único "en curso", decidir la segunda rehabilitaba los botones de la
  // primera con su pedido todavía en viaje: el segundo click volvía como 409.
  it('decidir otra alerta no rehabilita los botones de la que todavía viaja', async () => {
    const terminar: Record<number, () => void> = {};
    const onDecidir = vi.fn((id: number) => new Promise<void>((r) => (terminar[id] = r)));
    montar([makeAlert({ id: 1, drone_id: 'd1' }), makeAlert({ id: 2, drone_id: 'd2' })], { onDecidir });
    await userEvent.click(screen.getByRole('button', { name: /2 pendientes/ }));

    await userEvent.click(screen.getAllByRole('button', { name: 'Validar' })[0]);
    await userEvent.click(screen.getAllByRole('button', { name: 'Descartar' })[1]);
    for (const nombre of ['Validar', 'Descartar']) {
      for (const boton of screen.getAllByRole('button', { name: nombre })) expect(boton).toBeDisabled();
    }

    // Termina la segunda: la primera sigue en viaje y sigue bloqueada.
    terminar[2]();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Validar' })[1]).toBeEnabled());
    expect(screen.getAllByRole('button', { name: 'Validar' })[0]).toBeDisabled();

    terminar[1]();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Validar' })[0]).toBeEnabled());
  });

  it('el nombre del dron lleva a su vista y cierra el desplegable', async () => {
    const { onVerDron } = montar([makeAlert({ id: 1, drone_id: 'd1' })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Alfa' }));

    expect(onVerDron).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();
  });

  it('una alerta sin dron no ofrece ir a ninguna vista', async () => {
    montar([makeAlert({ id: 1, drone_id: null })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));

    expect(screen.getByRole('button', { name: 'Dron desconocido' })).toBeDisabled();
  });

  it('muestra la instantánea cuando la alerta la trae', async () => {
    montar([makeAlert({ id: 1, snapshot: 'QUFB' })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));

    expect(screen.getByAltText('Detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QUFB');
  });

  it('lista las últimas decididas debajo de las pendientes', async () => {
    montar([
      makeAlert({ id: 1, status: 'VALIDATED', drone_id: 'd1' }),
      makeAlert({ id: 2, status: 'DISMISSED', drone_id: 'd2' }),
    ]);
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Validada')).toBeInTheDocument();
    expect(screen.getByText('Descartada')).toBeInTheDocument();
  });

  it('se cierra con Escape y clickeando afuera', async () => {
    montar();
    const boton = screen.getByRole('button', { name: /1 pendiente/ });

    await userEvent.click(boton);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();

    await userEvent.click(boton);
    await userEvent.click(document.body);
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();
  });

  it('Escape con el foco adentro del panel lo devuelve a la campana, no a la página', async () => {
    montar([makeAlert({ id: 1 })]);
    const campana = screen.getByRole('button', { name: /1 pendiente/ });
    await userEvent.click(campana);
    expect(campana).toHaveAttribute('aria-controls', screen.getByRole('region', { name: /alertas de detección/i }).id);

    screen.getByRole('button', { name: 'Validar' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();
    expect(campana).toHaveFocus();
    expect(campana).not.toHaveAttribute('aria-controls');
  });

  it('Escape con el foco en otro lado cierra el panel sin robarle el foco a nadie', async () => {
    render(
      <>
        <input aria-label="Otra cosa" />
        <CampanaDeAlertas alerts={[makeAlert()]} drones={DRONES} onDecidir={vi.fn()} onVerDron={vi.fn()} />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    const otra = screen.getByRole('textbox', { name: 'Otra cosa' });
    otra.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();
    expect(otra).toHaveFocus();
  });
});

