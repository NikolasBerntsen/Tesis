import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AlertasDelDron from './AlertasDelDron';
import { makeAlert } from '../test/fixtures';
import type { Alert } from '../types';

// El carrusel de adentro puede abrir el pop-up de la alerta, que lleva un mapa:
// Leaflet no corre en jsdom.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

type Props = Parameters<typeof AlertasDelDron>[0];

const TRES: Alert[] = [
  makeAlert({ id: 3, type: 'PERSON', snapshot: 'QUFB' }),
  makeAlert({ id: 9, type: 'VEHICLE', snapshot: 'QkJC' }),
  makeAlert({ id: 5, type: 'PERSON', snapshot: null }),
];

function montar(props: Partial<Props> = {}) {
  const todas: Props = { nombre: 'Alfa', alertas: TRES, onDecidir: vi.fn(), onCerrar: vi.fn(), ...props };
  const { rerender } = render(<AlertasDelDron {...todas} />);
  const conAlertas = (alertas: readonly Alert[]) => rerender(<AlertasDelDron {...todas} alertas={alertas} />);
  return { ...todas, conAlertas };
}

const dialogo = () => screen.getByRole('dialog', { name: 'Alertas de Alfa' });
const aTodas = () => userEvent.click(screen.getByRole('button', { name: 'Todas' }));
const casilla = (id: number) => screen.getByRole('checkbox', { name: `Seleccionar la alerta #${id}` });

describe('AlertasDelDron', () => {
  it('abre en "una por vez" con el carrusel, y la cabecera cuenta las pendientes', () => {
    montar();
    expect(dialogo()).toHaveTextContent('3 pendientes');
    expect(screen.getByRole('button', { name: 'Una por vez' })).toHaveAttribute('aria-pressed', 'true');
    // El carrusel de siempre: la más nueva (9) primero, con sus flechas.
    expect(screen.getByTestId('carrusel-cuenta')).toHaveTextContent('1 de 3');
    expect(screen.getByText('VEHÍCULO')).toBeInTheDocument();
  });

  it('"Todas" muestra la grilla con una ficha por alerta, la más nueva primero, cada una con su casilla', async () => {
    montar();
    await aTodas();
    const grilla = screen.getByRole('list', { name: 'Alertas pendientes de Alfa' });
    const fichas = within(grilla).getAllByRole('listitem');
    expect(fichas).toHaveLength(3);
    expect(fichas[0]).toHaveTextContent('#9');
    expect(fichas[1]).toHaveTextContent('#5');
    expect(fichas[2]).toHaveTextContent('#3');
    expect(within(fichas[1]).getByText('La detección no dejó captura.')).toBeInTheDocument();
    expect(screen.getByTestId('cuenta-seleccion')).toHaveTextContent('Ninguna seleccionada');
    expect(screen.getByRole('button', { name: 'Descartar las seleccionadas' })).toBeDisabled();
  });

  it('en la grilla cada alerta se decide sola, con su id', async () => {
    const { onDecidir } = montar();
    await aTodas();
    const ficha = screen.getAllByRole('listitem')[0];
    await userEvent.click(within(ficha).getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(9, 'VALIDATED');
  });

  it('seleccionar varias y descartarlas pide confirmación y decide cada una', async () => {
    const onDecidir = vi.fn().mockResolvedValue(undefined);
    montar({ onDecidir });
    await aTodas();
    await userEvent.click(casilla(9));
    await userEvent.click(casilla(3));
    expect(screen.getByTestId('cuenta-seleccion')).toHaveTextContent('2 seleccionadas');

    await userEvent.click(screen.getByRole('button', { name: 'Descartar las seleccionadas' }));
    const confirmacion = screen.getByRole('dialog', { name: 'Descartar 2 alertas' });
    expect(confirmacion).toHaveTextContent('quedan descartadas como falsos positivos');
    expect(onDecidir).not.toHaveBeenCalled();

    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Descartar todas' }));
    await waitFor(() => expect(onDecidir).toHaveBeenCalledTimes(2));
    expect(onDecidir).toHaveBeenCalledWith(9, 'DISMISSED');
    expect(onDecidir).toHaveBeenCalledWith(3, 'DISMISSED');
    expect(onDecidir).not.toHaveBeenCalledWith(5, expect.anything());
    await waitFor(() => expect(screen.getByTestId('cuenta-seleccion')).toHaveTextContent('Ninguna seleccionada'));
  });

  it('"Seleccionar todas" las marca y validar las decide todas; la confirmación lo dice en positivo', async () => {
    const onDecidir = vi.fn().mockResolvedValue(undefined);
    montar({ onDecidir });
    await aTodas();
    await userEvent.click(screen.getByRole('button', { name: 'Seleccionar todas' }));
    expect(screen.getByTestId('cuenta-seleccion')).toHaveTextContent('3 seleccionadas');
    expect(screen.getByRole('button', { name: 'Ninguna' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Validar las seleccionadas' }));
    const confirmacion = screen.getByRole('dialog', { name: 'Validar 3 alertas' });
    expect(confirmacion).toHaveTextContent('quedan validadas como reales');
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Validar todas' }));
    await waitFor(() => expect(onDecidir).toHaveBeenCalledTimes(3));
  });

  it('cancelar la confirmación no decide nada y deja la selección', async () => {
    const { onDecidir } = montar();
    await aTodas();
    await userEvent.click(casilla(9));
    await userEvent.click(screen.getByRole('button', { name: 'Descartar las seleccionadas' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Descartar 1 alertas' })).getByRole('button', { name: 'Cancelar' }));
    expect(onDecidir).not.toHaveBeenCalled();
    expect(casilla(9)).toBeChecked();
  });

  it('un rechazo del backend queda al lado de la alerta que falló, y las otras se deciden igual', async () => {
    const onDecidir = vi.fn((id: number) =>
      id === 9 ? Promise.reject(new Error('Esta alerta ya la decidió otro operador.')) : Promise.resolve(),
    );
    montar({ onDecidir });
    await aTodas();
    await userEvent.click(screen.getByRole('button', { name: 'Seleccionar todas' }));
    await userEvent.click(screen.getByRole('button', { name: 'Descartar las seleccionadas' }));
    await userEvent.click(screen.getByRole('button', { name: 'Descartar todas' }));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Esta alerta ya la decidió otro operador.');
    expect(screen.getAllByRole('listitem')[0]).toContainElement(alerta);
    expect(onDecidir).toHaveBeenCalledTimes(3);
  });

  it('una alerta que se fue sale de la selección sola', async () => {
    const { conAlertas } = montar();
    await aTodas();
    await userEvent.click(casilla(9));
    await userEvent.click(casilla(5));
    conAlertas(TRES.filter((a) => a.id !== 9));
    await waitFor(() => expect(screen.getByTestId('cuenta-seleccion')).toHaveTextContent('1 seleccionada'));
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar la alerta #9' })).not.toBeInTheDocument();
  });

  it('la captura de la grilla se amplía al tocarla', async () => {
    montar();
    await aTodas();
    await userEvent.click(screen.getByRole('button', { name: 'Ampliar la captura de la alerta #9' }));
    const ampliada = screen.getByRole('dialog', { name: 'Captura de la alerta #9' });
    expect(within(ampliada).getByAltText('Captura de la alerta #9')).toHaveAttribute('src', 'data:image/jpeg;base64,QkJC');
    await userEvent.click(within(ampliada).getByRole('button', { name: 'Cerrar la imagen ampliada' }));
    expect(screen.queryByRole('dialog', { name: 'Captura de la alerta #9' })).not.toBeInTheDocument();
  });

  it('sin pendientes lo dice, en las dos vistas', async () => {
    montar({ alertas: [] });
    expect(dialogo()).toHaveTextContent('Sin alertas pendientes');
    expect(screen.getByText('No quedan alertas pendientes de Alfa.')).toBeInTheDocument();
    await aTodas();
    expect(screen.getByText('No quedan alertas pendientes de Alfa.')).toBeInTheDocument();
  });

  it('Cerrar y la cruz cierran el pop-up', async () => {
    const { onCerrar } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar las alertas' }));
    expect(onCerrar).toHaveBeenCalledTimes(2);
  });
});
