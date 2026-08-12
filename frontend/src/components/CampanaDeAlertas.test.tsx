import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
});
