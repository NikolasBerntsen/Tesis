import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorDeApi, ordenarAterrizaje, ordenarVolverABase } from '../api';
import { makeDrone, makeEvent, makeMe, makeStatus } from '../test/fixtures';
import type { Drone, DroneStatus, EventRow, Me } from '../types';
import TarjetaDeVuelo from './TarjetaDeVuelo';

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  ordenarVolverABase: vi.fn(),
  ordenarAterrizaje: vi.fn(),
}));
const volverMock = vi.mocked(ordenarVolverABase);
const aterrizarMock = vi.mocked(ordenarAterrizaje);

type Props = { me?: Me; drone?: Drone; status?: DroneStatus | null; controlador?: string | null; eventos?: EventRow[] };

function montar(props: Props = {}) {
  const todas = {
    me: makeMe({ username: 'oper1', role: 'operator', canControl: true }),
    drone: makeDrone({ droneId: 'd1', displayName: 'Alfa', online: true }),
    status: makeStatus({ droneId: 'd1', state: 'PATROLLING', flying: true }),
    controlador: null,
    eventos: [] as EventRow[],
    ...props,
  };
  const { rerender } = render(<TarjetaDeVuelo {...todas} />);
  // Lo que cambia se acumula: un evento que llega no le devuelve el control a nadie.
  const volverARenderizar = (cambios: Props) => {
    Object.assign(todas, cambios);
    rerender(<TarjetaDeVuelo {...todas} />);
  };
  return { ...todas, volverARenderizar };
}

const SUPERVISOR = makeMe({ username: 'super1', role: 'supervisor', canControl: true });
/** Un evento de la app sobre el aterrizaje, como llega por el canal en vivo. */
const deLaApp = (id: number, type: string, message: string, drone_id = 'd1') => makeEvent({ id, type, message, drone_id });

const volver = () => screen.getByRole('button', { name: 'Volver a la base' });
const aterrizar = () => screen.getByRole('button', { name: 'Aterrizar acá' });
const motivo = () => screen.getByTestId('vuelo-motivo');

describe('TarjetaDeVuelo', () => {
  beforeEach(() => {
    volverMock.mockReset();
    volverMock.mockResolvedValue({ ok: true, delivered: true });
    aterrizarMock.mockReset();
    aterrizarMock.mockResolvedValue({ ok: true, delivered: true });
  });

  it('conectado y en el aire, las dos órdenes están a mano, sin motivos que leer', () => {
    montar();
    expect(screen.getByRole('heading', { name: 'Vuelo' })).toBeInTheDocument();
    expect(volver()).toBeEnabled();
    expect(aterrizar()).toBeEnabled();
    expect(screen.queryByTestId('vuelo-motivo')).not.toBeInTheDocument();
    // Los íconos son dibujo: el nombre de cada botón sigue siendo su texto.
    expect(volver().querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['en el suelo', { status: makeStatus({ flying: false }) }, 'El dron está en el suelo.'],
    ['desconectado', { drone: makeDrone({ online: false }) }, 'El dron está desconectado.'],
    ['sin saber si vuela (una app vieja)', { status: makeStatus({}) }, 'El dron no informa si está en el aire.'],
    ['sin status', { status: null }, 'El dron no informa si está en el aire.'],
  ] as [string, Props, string][])('%s: las dos se apagan y se dice por qué', (_caso, props, texto) => {
    montar(props);
    expect(volver()).toBeDisabled();
    expect(aterrizar()).toBeDisabled();
    expect(motivo()).toHaveTextContent(texto);
  });

  it.each(['RETURNING_HOME', 'RETURNING_HOME_BATTERY'])(
    'ya volviendo (%s), «Volver a la base» no agrega nada; «Aterrizar acá» le corta el regreso',
    (state) => {
      montar({ status: makeStatus({ state, flying: true }) });
      expect(volver()).toBeDisabled();
      expect(aterrizar()).toBeEnabled();
      expect(motivo()).toHaveTextContent('Ya está volviendo a la base: «Aterrizar acá» le corta el regreso y lo baja donde está');
      // Un regreso del propio DJI no se discute: no se promete lo que la app va a rechazar.
      expect(motivo()).toHaveTextContent('salvo un regreso del propio DJI que la app no discute');
    },
  );

  it('sin señal con la aeronave las dos se apagan: el DJI vuelve solo y la app no aterriza', () => {
    montar({ status: makeStatus({ state: 'RETURNING_HOME_SIGNAL', flying: true }) });
    expect(volver()).toBeDisabled();
    expect(aterrizar()).toBeDisabled();
    expect(motivo()).toHaveTextContent('Sin enlace con la aeronave: el DJI vuelve solo.');
  });

  it('aterrizando de emergencia no alcanza ninguna base, y no se promete nada de «Aterrizar acá»: ya está bajando', () => {
    montar({ status: makeStatus({ state: 'ATERRIZAJE_EMERGENCIA', flying: true }) });
    expect(volver()).toBeDisabled();
    expect(aterrizar()).toBeEnabled();
    expect(motivo()).toHaveTextContent('Está aterrizando de emergencia en su última ubicación: no alcanza ninguna base.');
    expect(motivo()).not.toHaveTextContent('Aterrizar acá');
  });

  it('«Volver a la base» pide confirmación con lo que pasa, y recién ahí manda la orden; el aviso dura hasta que el dron vuelve', async () => {
    const { volverARenderizar } = montar();
    fireEvent.click(volver());
    const dialogo = screen.getByRole('dialog', { name: 'Volver a la base: Alfa' });
    expect(dialogo).toHaveTextContent(
      'El dron deja lo que esté haciendo (la ruta o el objetivo) y vuelve solo a su base; las detecciones no lo frenan.',
    );
    // Sin el control, nada que soltar: la frase no está.
    expect(dialogo).not.toHaveTextContent('lo soltás');
    expect(volverMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Volver a la base' }));
    await waitFor(() => expect(volverMock).toHaveBeenCalledWith('d1', { forzar: false }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('vuelo-en-curso')).toHaveTextContent(/Regreso ordenado/);

    volverARenderizar({ status: makeStatus({ state: 'RETURNING_HOME', flying: true }) });
    expect(screen.queryByTestId('vuelo-en-curso')).not.toBeInTheDocument();
  });

  it('si tengo el control manual, la pregunta avisa que lo suelto', () => {
    montar({ controlador: 'oper1' });
    expect(volver()).toBeEnabled();
    fireEvent.click(volver());
    expect(screen.getByRole('dialog')).toHaveTextContent('Si tenés el control manual, lo soltás.');
  });

  it('«Aterrizar acá» pide confirmación y manda la orden; el aviso se va cuando el dron toca el suelo', async () => {
    const { volverARenderizar } = montar();
    fireEvent.click(aterrizar());
    const dialogo = screen.getByRole('dialog', { name: 'Aterrizar acá: Alfa' });
    expect(dialogo).toHaveTextContent(
      'El dron desciende y aterriza donde está ahora. Confirmá que abajo hay suelo firme y despejado.',
    );
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aterrizar acá' }));
    await waitFor(() => expect(aterrizarMock).toHaveBeenCalledWith('d1', { forzar: false }));
    expect(await screen.findByTestId('vuelo-en-curso')).toHaveTextContent(/Aterrizaje ordenado/);

    volverARenderizar({ status: makeStatus({ state: 'PAUSED', flying: false }) });
    expect(screen.queryByTestId('vuelo-en-curso')).not.toBeInTheDocument();
  });

  it('cancelar la pregunta no manda nada', () => {
    montar();
    fireEvent.click(volver());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(volverMock).not.toHaveBeenCalled();
  });

  it('con otro al mando, un operador ve quién lo tiene y no puede dar la orden', () => {
    montar({ controlador: 'oper9' });
    expect(volver()).toBeDisabled();
    expect(aterrizar()).toBeDisabled();
    expect(motivo()).toHaveTextContent('Controlado por oper9. Sólo un supervisor puede darle estas órdenes igual.');
  });

  it('un supervisor se lo quita antes: lo lee en la tarjeta, la pregunta lo dice y la orden va con forzar', async () => {
    montar({ me: makeMe({ username: 'super1', role: 'supervisor', canControl: true }), controlador: 'oper9' });
    expect(volver()).toBeEnabled();
    expect(motivo()).toHaveTextContent('Controlado por oper9: cualquiera de las dos órdenes le quita el control antes.');

    fireEvent.click(volver());
    let dialogo = screen.getByRole('dialog', { name: 'Volver a la base: Alfa' });
    expect(dialogo).toHaveTextContent('oper9 tiene el control manual: se le quita en el acto.');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Quitarle el control y volver a la base' }));
    await waitFor(() => expect(volverMock).toHaveBeenCalledWith('d1', { forzar: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(aterrizar());
    dialogo = screen.getByRole('dialog', { name: 'Aterrizar acá: Alfa' });
    expect(dialogo).toHaveTextContent('oper9 tiene el control manual: se le quita en el acto.');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Quitarle el control y aterrizar acá' }));
    await waitFor(() => expect(aterrizarMock).toHaveBeenCalledWith('d1', { forzar: true }));
  });

  it('si el hub rechaza la orden (el control lo tiene otro), el motivo se lee en la pregunta, que sigue abierta', async () => {
    volverMock.mockRejectedValue(new ErrorDeApi('El control lo tiene oper9', 409));
    montar();
    fireEvent.click(volver());
    const dialogo = screen.getByRole('dialog', { name: 'Volver a la base: Alfa' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Volver a la base' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('El control lo tiene oper9');
    expect(screen.getByRole('dialog', { name: 'Volver a la base: Alfa' })).toBeInTheDocument();
    expect(screen.queryByTestId('vuelo-en-curso')).not.toBeInTheDocument();
  });

  it('mientras la orden viaja, el botón de la pregunta lo dice', async () => {
    let resolver: (r: { ok: boolean; delivered: boolean }) => void = () => {};
    volverMock.mockImplementation(() => new Promise((r) => (resolver = r)));
    montar();
    fireEvent.click(volver());
    const dialogo = screen.getByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Volver a la base' }));
    expect(await within(dialogo).findByRole('button', { name: 'Ordenando…' })).toBeDisabled();
    await act(async () => resolver({ ok: true, delivered: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('la pregunta abierta no se vuelve forzada: si en el medio otro toma el control, sale como se leyó y el 409 se lee adentro', async () => {
    volverMock.mockRejectedValue(new ErrorDeApi('El control lo tiene oper9', 409));
    const { volverARenderizar } = montar({ me: SUPERVISOR });
    fireEvent.click(volver());
    const dialogo = screen.getByRole('dialog', { name: 'Volver a la base: Alfa' });
    // oper9 toma el control con la pregunta abierta: el supervisor no leyó que se lo quitaba.
    volverARenderizar({ controlador: 'oper9' });
    expect(dialogo).not.toHaveTextContent('se le quita en el acto');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Volver a la base' }));
    await waitFor(() => expect(volverMock).toHaveBeenCalledWith('d1', { forzar: false }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('El control lo tiene oper9');
  });

  it('la pregunta que le quitaba el control a alguien se descarta si el control cambia de manos', () => {
    const { volverARenderizar } = montar({ me: SUPERVISOR, controlador: 'oper9' });
    fireEvent.click(aterrizar());
    expect(screen.getByRole('dialog', { name: 'Aterrizar acá: Alfa' })).toHaveTextContent('oper9 tiene el control manual');
    volverARenderizar({ controlador: 'oper7' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(aterrizarMock).not.toHaveBeenCalled();
  });

  it('el lock que suelta la propia orden forzada no cierra la pregunta mientras viaja', async () => {
    let resolver: (r: { ok: boolean; delivered: boolean }) => void = () => {};
    volverMock.mockImplementation(() => new Promise((r) => (resolver = r)));
    const { volverARenderizar } = montar({ me: SUPERVISOR, controlador: 'oper9' });
    fireEvent.click(volver());
    const dialogo = screen.getByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Quitarle el control y volver a la base' }));
    expect(volverMock).toHaveBeenCalledWith('d1', { forzar: true });
    // El control_changed del hub llega antes que la respuesta del POST.
    volverARenderizar({ controlador: null });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => resolver({ ok: true, delivered: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('vuelo-en-curso')).toHaveTextContent(/Regreso ordenado/);
  });

  it.each([
    ['una palanca lo cortó', 'LANDING_CANCELLED', 'oper2 movió las palancas: el aterrizaje se corta y el dron queda a su mando'],
    ['no se pudo', 'DRONE_PROBLEM', 'No se pudo aterrizar: el dron no aceptó la orden'],
    ['no se da en ese estado', 'DRONE_PROBLEM', 'No se aterriza (oper1 ordenó aterrizar desde la consola): sin señal con el dron'],
  ])('el aviso del aterrizaje se va cuando la app dice que no sigue: %s', async (_caso, type, message) => {
    const { volverARenderizar } = montar({ eventos: [makeEvent({ id: 40 })] });
    fireEvent.click(aterrizar());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Aterrizar acá' }));
    expect(await screen.findByTestId('vuelo-en-curso')).toHaveTextContent(/Aterrizaje ordenado/);
    // Lo de otro dron, o lo que ya estaba antes de la orden, no cuenta.
    volverARenderizar({ eventos: [deLaApp(41, type, message, 'd2'), deLaApp(39, type, message), makeEvent({ id: 40 })] });
    expect(screen.getByTestId('vuelo-en-curso')).toBeInTheDocument();
    volverARenderizar({ eventos: [deLaApp(42, type, message), makeEvent({ id: 40 })] });
    expect(screen.queryByTestId('vuelo-en-curso')).not.toBeInTheDocument();
  });

  it('el aviso del regreso también se va con el dron en el suelo: ahí no hay regreso que esperar', async () => {
    const { volverARenderizar } = montar();
    fireEvent.click(volver());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Volver a la base' }));
    expect(await screen.findByTestId('vuelo-en-curso')).toHaveTextContent(/Regreso ordenado/);
    volverARenderizar({ status: makeStatus({ state: 'PAUSED', flying: false }) });
    expect(screen.queryByTestId('vuelo-en-curso')).not.toBeInTheDocument();
  });
});
