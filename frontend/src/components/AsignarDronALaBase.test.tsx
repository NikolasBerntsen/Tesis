import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, traerDrones } from '../api';
import { makeDrone, makeStatus } from '../test/fixtures';
import type { BaseAsset, Drone } from '../types';
import AsignarDronALaBase, { estaEnVuelo, ordenarParaAsignar } from './AsignarDronALaBase';
import { ProveedorDeAvisos } from './AvisosFlotantes';

vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn(),
  traerDrones: vi.fn(),
}));
const apiMock = vi.mocked(api);
const dronesMock = vi.mocked(traerDrones);

const RIO: BaseAsset = { id: 5, name: 'Base Río', lat: -34.9, lon: -56.15, active: true, createdAt: '', createdBy: 'campo1', deleted: false, deletedAt: null };

const SIN_BASE = makeDrone({ hash: 'z9', droneId: 'z9', displayName: 'Zulu', baseId: null, base: null, online: false });
const DE_OTRA = makeDrone({ hash: 'a1', droneId: 'a1', displayName: 'Alfa', baseId: 1, base: { name: 'Base Norte', lat: -34.6, lon: -58.4 } });
const DE_ESTA = makeDrone({ hash: 'b2', droneId: 'b2', displayName: 'Bravo', baseId: 5, base: { name: 'Base Río', lat: -34.9, lon: -56.15 } });
const VOLANDO = makeDrone({
  hash: 'c3', droneId: 'c3', displayName: 'Charlie', baseId: 1, base: { name: 'Base Norte', lat: -34.6, lon: -58.4 },
  online: true, lastStatus: makeStatus({ droneId: 'c3', flying: true }),
});

function montar(props: Partial<Parameters<typeof AsignarDronALaBase>[0]> = {}) {
  const todas = { base: RIO, onCerrar: vi.fn(), onAsignado: vi.fn(), ...props };
  render(
    <ProveedorDeAvisos>
      <AsignarDronALaBase {...todas} />
    </ProveedorDeAvisos>,
  );
  return todas;
}

const opciones = () => screen.getAllByRole('option');

describe('AsignarDronALaBase', () => {
  beforeEach(() => {
    apiMock.mockReset();
    dronesMock.mockReset();
    dronesMock.mockResolvedValue([DE_ESTA, VOLANDO, DE_OTRA, SIN_BASE]);
  });

  it('lista los drones con los que no tienen base primero, y dice dónde está cada uno', async () => {
    montar();
    expect(await screen.findByRole('dialog', { name: '¿Asignar un dron a Base Río?' })).toBeInTheDocument();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    expect(opciones()[0]).toHaveTextContent('Zulu');
    expect(opciones()[0]).toHaveTextContent('Sin base');
    expect(opciones()[1]).toHaveTextContent('Alfa');
    expect(opciones()[1]).toHaveTextContent('Hoy vuelve a Base Norte');
    expect(opciones()[2]).toHaveTextContent('Charlie');
    expect(opciones()[2]).toHaveTextContent('En vuelo: se le cambia la base cuando aterrice');
    expect(opciones()[2]).toBeDisabled();
    expect(opciones()[3]).toHaveTextContent('Bravo');
    expect(opciones()[3]).toHaveTextContent('Ya está en esta base');
    expect(opciones()[3]).toBeDisabled();
  });

  it('el buscador filtra por nombre, modelo, inventario o base', async () => {
    montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    await userEvent.type(screen.getByLabelText('Buscar drones'), 'norte');
    expect(opciones().map((o) => o.textContent)).toEqual([expect.stringContaining('Alfa'), expect.stringContaining('Charlie')]);
    await userEvent.clear(screen.getByLabelText('Buscar drones'));
    await userEvent.type(screen.getByLabelText('Buscar drones'), 'zul');
    expect(opciones()).toHaveLength(1);
  });

  it('un dron sin base se asigna en el acto, avisa y cierra', async () => {
    const ficha = { ...SIN_BASE, baseId: 5, base: { name: 'Base Río', lat: -34.9, lon: -56.15 } };
    apiMock.mockResolvedValue(ficha);
    const { onCerrar, onAsignado } = montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));

    await userEvent.click(screen.getByRole('option', { name: /Zulu/ }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/z9', { method: 'PATCH', body: JSON.stringify({ baseId: 5 }) }),
    );
    await waitFor(() => expect(onCerrar).toHaveBeenCalled());
    expect(onAsignado).toHaveBeenCalledWith(ficha);
    expect(screen.getByText('Zulu asignado a Base Río.')).toBeInTheDocument();
  });

  it('un dron de otra base pide confirmación antes de sacárselo; cancelar no cambia nada', async () => {
    montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    await userEvent.click(screen.getByRole('option', { name: /Alfa/ }));

    const confirmacion = screen.getByRole('dialog', { name: 'Reasignar Alfa a Base Río' });
    expect(confirmacion).toHaveTextContent('Alfa hoy es de la base Base Norte');
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Cancelar' }));
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Reasignar Alfa a Base Río' })).not.toBeInTheDocument();
  });

  it('confirmada, la reasignación manda la base nueva', async () => {
    apiMock.mockResolvedValue({ ...DE_OTRA, baseId: 5 });
    const { onCerrar } = montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    await userEvent.click(screen.getByRole('option', { name: /Alfa/ }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Reasignar Alfa a Base Río' })).getByRole('button', { name: 'Reasignar' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/drones/a1', { method: 'PATCH', body: JSON.stringify({ baseId: 5 }) }),
    );
    await waitFor(() => expect(onCerrar).toHaveBeenCalled());
  });

  it('si el Comando Central rechaza la reasignación, el motivo se lee en la confirmación, que sigue abierta', async () => {
    apiMock.mockRejectedValue(new Error('El dron está en vuelo: la base se le cambia cuando aterrice'));
    const { onCerrar } = montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    await userEvent.click(screen.getByRole('option', { name: /Alfa/ }));
    const confirmacion = screen.getByRole('dialog', { name: 'Reasignar Alfa a Base Río' });
    await userEvent.click(within(confirmacion).getByRole('button', { name: 'Reasignar' }));
    expect(await within(confirmacion).findByRole('alert')).toHaveTextContent('El dron está en vuelo');
    expect(onCerrar).not.toHaveBeenCalled();
  });

  it('un rechazo al asignar uno sin base se lee en la lista', async () => {
    apiMock.mockRejectedValue(new Error('Dron inexistente'));
    montar();
    await waitFor(() => expect(opciones()).toHaveLength(4));
    await userEvent.click(screen.getByRole('option', { name: /Zulu/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dron inexistente');
  });

  it('"Ahora no" cierra sin tocar nada; si no se pueden traer los drones, lo dice', async () => {
    dronesMock.mockRejectedValue(new Error('sin red'));
    const { onCerrar } = montar();
    expect(await screen.findByRole('alert')).toHaveTextContent('sin red');
    await userEvent.click(screen.getByRole('button', { name: 'Ahora no' }));
    expect(onCerrar).toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('estaEnVuelo: lo dice `flying`, y sin `flying` el estado; desconectado nunca vuela', () => {
    expect(estaEnVuelo(makeDrone({ online: true, lastStatus: makeStatus({ flying: true }) }))).toBe(true);
    expect(estaEnVuelo(makeDrone({ online: true, lastStatus: makeStatus({ flying: false, state: 'PATROLLING' }) }))).toBe(false);
    expect(estaEnVuelo(makeDrone({ online: true, lastStatus: makeStatus({ state: 'PATROLLING' }) }))).toBe(true);
    expect(estaEnVuelo(makeDrone({ online: true, lastStatus: makeStatus({ state: 'IDLE' }) }))).toBe(false);
    expect(estaEnVuelo(makeDrone({ online: false, lastStatus: makeStatus({ flying: true }) }))).toBe(false);
    expect(estaEnVuelo(makeDrone({ online: true, lastStatus: null }))).toBe(false);
  });

  it('ordenarParaAsignar: sin base, de otra base, de esta; por nombre adentro de cada grupo, sin las bajas', () => {
    const eliminado: Drone = makeDrone({ hash: 'x', displayName: 'Xray', baseId: null, deleted: true });
    const orden = ordenarParaAsignar([DE_ESTA, DE_OTRA, eliminado, SIN_BASE, VOLANDO], 5).map((d) => d.displayName);
    expect(orden).toEqual(['Zulu', 'Alfa', 'Charlie', 'Bravo']);
  });
});
