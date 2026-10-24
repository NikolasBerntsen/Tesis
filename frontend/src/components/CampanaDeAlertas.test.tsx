import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeAlert, makeDrone } from '../test/fixtures';
import CampanaDeAlertas from './CampanaDeAlertas';
import ProveedorDeAlertas from './ProveedorDeAlertas';

// El pop-up de la alerta lleva un mapa: Leaflet no corre en jsdom.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

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

  // RELEVOS §3.6: después de un traspaso, la alerta es del que la sigue.
  it('una alerta relevada lleva al dron que la sigue, pendiente o ya decidida', async () => {
    const props = montar([
      makeAlert({ id: 9, drone_id: 'd1', seguidaPor: 'd2' }),
      makeAlert({ id: 8, drone_id: 'd1', seguidaPor: 'd2', status: 'VALIDATED' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    const panel = screen.getByRole('region', { name: /alertas de detección/i });
    await userEvent.click(within(panel).getByRole('button', { name: 'Bravo' }));
    expect(props.onVerDron).toHaveBeenCalledWith('d2');

    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    expect(within(screen.getByRole('region', { name: /alertas de detección/i })).getByText(/· Bravo/)).toBeInTheDocument();
  });

  it('un tipo que la consola no conoce se lee tal cual, pendiente o decidido', async () => {
    montar([
      makeAlert({ id: 1, type: 'ANIMAL' as 'PERSON' }),
      makeAlert({ id: 2, type: 'ANIMAL' as 'PERSON', status: 'DISMISSED' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    const panel = screen.getByRole('region', { name: /alertas de detección/i });
    // En la placa óxido de cualquier alerta, pero sin dibujo: no hay ícono que adivinar.
    const chip = within(panel).getByText('ANIMAL');
    expect(chip).toHaveClass('chip', 'rojo');
    expect(chip.querySelector('svg')).toBeNull();
    expect(within(panel).getByText(/ANIMAL · Alfa/)).toBeInTheDocument();
  });

  it('una alerta sin dron no ofrece ir a ninguna vista', async () => {
    montar([makeAlert({ id: 3, drone_id: null })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    const panel = screen.getByRole('region', { name: /alertas de detección/i });
    expect(within(panel).getByRole('button', { name: 'Dron desconocido' })).toBeDisabled();
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

  it('suelta, sin la consola alrededor, no ofrece abrir las alertas', async () => {
    montar([makeAlert({ id: 1, snapshot: 'QUFB' }), makeAlert({ id: 2, status: 'VALIDATED' })]);
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    expect(screen.queryByRole('button', { name: 'Ver detalle' })).not.toBeInTheDocument();
    expect(screen.getByAltText('Detección')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Validada/ })).not.toBeInTheDocument();
  });
});

describe('CampanaDeAlertas — abrir una alerta en su pop-up', () => {
  function enLaConsola(alerts = [makeAlert({ id: 4, drone_id: 'd2', snapshot: 'QUFB' })]) {
    const verDron = vi.fn();
    render(
      <ProveedorDeAlertas alertas={alerts} drones={DRONES} statuses={{}} decidir={vi.fn()} verDron={verDron}>
        <CampanaDeAlertas alerts={alerts} drones={DRONES} onDecidir={vi.fn()} onVerDron={verDron} />
      </ProveedorDeAlertas>,
    );
    return { verDron };
  }

  it('una pendiente se abre desde su captura o desde "Ver detalle", y el desplegable se pliega', async () => {
    enLaConsola();
    const campana = screen.getByRole('button', { name: /1 pendiente/ });
    await userEvent.click(campana);
    await userEvent.click(screen.getByRole('button', { name: 'Ampliar la captura de la alerta #4' }));

    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #4' });
    expect(within(dialogo).getByText(/^Bravo · /)).toBeInTheDocument();
    // El desplegable no queda abierto atrás, a medio camino.
    expect(screen.queryByRole('region', { name: /alertas de detección/i })).not.toBeInTheDocument();

    // Al cerrar, el foco vuelve a la campana: el botón que se tocó ya no está.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(campana).toHaveFocus();

    await userEvent.click(campana);
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    expect(screen.getByRole('dialog', { name: 'Alerta de persona #4' })).toBeInTheDocument();
  });

  it('una decidida también se abre, para ver quién la decidió y dónde fue', async () => {
    enLaConsola([makeAlert({ id: 5, drone_id: 'd1', status: 'DISMISSED', decided_by: 'oper2' })]);
    await userEvent.click(screen.getByRole('button', { name: /ninguna pendiente/ }));
    await userEvent.click(screen.getByRole('button', { name: /Descartada/ }));

    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #5' });
    expect(within(dialogo).getByText(/^Descartada por oper2/)).toBeInTheDocument();
    expect(within(dialogo).queryByRole('button', { name: 'Validar' })).not.toBeInTheDocument();
  });

  it('desde el pop-up se va al video del dron', async () => {
    const { verDron } = enLaConsola();
    await userEvent.click(screen.getByRole('button', { name: /1 pendiente/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver feed en vivo' }));
    expect(verDron).toHaveBeenCalledWith('d2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

