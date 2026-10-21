import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DialogoDron from './DialogoDron';
import { makeDrone } from '../test/fixtures';
import type { BaseAsset, Drone } from '../types';

function base(id: number, name: string, lat: number, lon: number): BaseAsset {
  return { id, name, lat, lon, active: true, createdAt: '', createdBy: null, deleted: false, deletedAt: null };
}

const NORTE = base(7, 'Base Norte', -34.85, -56.2);
const SUR = base(8, 'Base Sur', -34.9, -56.1);

function montar({
  dron = null,
  bases = [NORTE, SUR],
  onGuardar = vi.fn(async () => {}),
}: { dron?: Drone | null; bases?: BaseAsset[]; onGuardar?: ReturnType<typeof vi.fn> } = {}) {
  const onCerrar = vi.fn();
  render(<DialogoDron dron={dron} bases={bases} onGuardar={onGuardar} onCerrar={onCerrar} />);
  const dialogo = screen.getByRole('dialog', { name: dron ? 'Editar dron' : 'Nuevo dron' });
  return { dialogo, onGuardar, onCerrar };
}

const alfa = () => makeDrone({ hash: 'h-alfa', displayName: 'Alfa', model: 'DJI Mini 3', inventoryCode: 'INV-1', baseId: 7 });

describe('DialogoDron — alta', () => {
  it('abre con el título del alta, los campos vacíos y el foco en el nombre', () => {
    const { dialogo } = montar();

    expect(within(dialogo).getByLabelText('Nombre')).toHaveFocus();
    expect(within(dialogo).getByLabelText('Nombre')).toHaveValue('');
    expect(within(dialogo).getByLabelText('Modelo')).toHaveValue('');
    expect(within(dialogo).getByLabelText('Número de inventario')).toHaveValue('');
    expect(within(dialogo).getByText(/se abre su sticker/i)).toBeInTheDocument();
  });

  it('no deja dar de alta sin nombre, y dice por qué', async () => {
    const { dialogo } = montar();
    const alta = within(dialogo).getByRole('button', { name: 'Dar de alta' });

    expect(alta).toBeDisabled();
    expect(within(dialogo).getByText('Falta el nombre del dron.')).toBeInTheDocument();

    // un nombre de puros espacios tampoco es un nombre
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), '   ');
    expect(alta).toBeDisabled();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');
    expect(alta).toBeEnabled();
    expect(within(dialogo).queryByText('Falta el nombre del dron.')).not.toBeInTheDocument();
  });

  it('marca el nombre en el campo recién cuando se lo dejó vacío', async () => {
    const { dialogo } = montar();
    const nombre = within(dialogo).getByLabelText('Nombre');

    // recién abierto no se reta a nadie
    expect(nombre).toHaveAttribute('aria-invalid', 'false');
    expect(within(dialogo).queryByText(/Poné un nombre/)).not.toBeInTheDocument();

    await userEvent.tab();
    expect(nombre).toHaveAttribute('aria-invalid', 'true');
    expect(nombre).toHaveAccessibleDescription(/Poné un nombre/);

    await userEvent.type(nombre, 'Delta');
    expect(nombre).toHaveAttribute('aria-invalid', 'false');
    expect(nombre).not.toHaveAccessibleDescription();
  });

  it('un envío forzado sin nombre no llama al backend y marca el campo', () => {
    const { dialogo, onGuardar } = montar();

    fireEvent.submit(within(dialogo).getByLabelText('Nombre').closest('form')!);

    expect(onGuardar).not.toHaveBeenCalled();
    expect(within(dialogo).getByText(/Poné un nombre/)).toBeInTheDocument();
  });

  it('manda el alta con los campos limpios, y sin base si no se eligió', async () => {
    const { dialogo, onGuardar } = montar();

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), '  Delta ');
    await userEvent.type(within(dialogo).getByLabelText('Modelo'), 'DJI Air 3 ');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    expect(onGuardar).toHaveBeenCalledWith({ displayName: 'Delta', model: 'DJI Air 3', inventoryCode: '' });
  });

  it('mientras guarda, el botón avisa y no deja mandar dos veces', async () => {
    const { dialogo } = montar({ onGuardar: vi.fn(() => new Promise<void>(() => {})) });

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    expect(within(dialogo).getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  });

  it('el error del backend se lee adentro, y se puede corregir y reintentar', async () => {
    const onGuardar = vi.fn().mockRejectedValueOnce(new Error('El número de inventario ya está en uso'));
    onGuardar.mockResolvedValueOnce(undefined);
    const { dialogo, onCerrar } = montar({ onGuardar });

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');
    await userEvent.type(within(dialogo).getByLabelText('Número de inventario'), 'INV-1');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('El número de inventario ya está en uso');
    expect(onCerrar).not.toHaveBeenCalled();

    await userEvent.type(within(dialogo).getByLabelText('Número de inventario'), '2');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));

    expect(onGuardar).toHaveBeenLastCalledWith({ displayName: 'Delta', model: '', inventoryCode: 'INV-12' });
    // el aviso viejo se borra al reintentar
    await waitFor(() => expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument());
  });

  it('un rechazo que no es un Error igual se muestra', async () => {
    const { dialogo } = montar({ onGuardar: vi.fn().mockRejectedValue('sin conexión') });

    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta{Enter}');

    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('sin conexión');
  });

  it('se cierra sin guardar con Cancelar, con la cruz y con Escape', async () => {
    const { dialogo, onGuardar, onCerrar } = montar();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cerrar' }));
    await userEvent.keyboard('{Escape}');

    expect(onCerrar).toHaveBeenCalledTimes(3);
    expect(onGuardar).not.toHaveBeenCalled();
  });
});

describe('DialogoDron — edición', () => {
  it('arranca con los datos del dron y dice cuál es', () => {
    const { dialogo } = montar({ dron: alfa() });

    expect(within(dialogo).getByLabelText('Nombre')).toHaveValue('Alfa');
    expect(within(dialogo).getByLabelText('Modelo')).toHaveValue('DJI Mini 3');
    expect(within(dialogo).getByLabelText('Número de inventario')).toHaveValue('INV-1');
    expect(within(dialogo).getByText('Base Norte')).toBeInTheDocument();
    expect(dialogo.querySelector('.modal-subtitulo')).toHaveTextContent('Alfa');
  });

  it('manda sólo lo que cambió', async () => {
    const { dialogo, onGuardar } = montar({ dron: alfa() });

    await userEvent.clear(within(dialogo).getByLabelText('Nombre'));
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Alfa II');
    await userEvent.clear(within(dialogo).getByLabelText('Número de inventario'));
    await userEvent.type(within(dialogo).getByLabelText('Número de inventario'), 'INV-2');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(onGuardar).toHaveBeenCalledWith({ displayName: 'Alfa II', inventoryCode: 'INV-2' });
  });

  it('cambiar el modelo y la base manda esos dos campos', async () => {
    const { dialogo, onGuardar } = montar({ dron: alfa() });

    await userEvent.type(within(dialogo).getByLabelText('Modelo'), ' Pro');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cambiar' }));
    await userEvent.click(within(dialogo).getByRole('option', { name: /Base Sur/ }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(onGuardar).toHaveBeenCalledWith({ model: 'DJI Mini 3 Pro', baseId: 8 });
  });

  it('quitar la base manda baseId null', async () => {
    const { dialogo, onGuardar } = montar({ dron: alfa() });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Quitar' }));
    expect(within(dialogo).getByLabelText('Buscar base')).toBeInTheDocument();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(onGuardar).toHaveBeenCalledWith({ baseId: null });
  });

  it('sin cambios, guardar cierra sin pegarle al backend', async () => {
    const { dialogo, onGuardar, onCerrar } = montar({ dron: alfa() });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Guardar cambios' }));

    expect(onGuardar).not.toHaveBeenCalled();
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });
});

describe('DialogoDron — selector de base', () => {
  it('"Cambiar" lleva el foco al buscador, que filtra a medida que se escribe', async () => {
    const { dialogo } = montar({ dron: alfa() });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cambiar' }));
    const buscador = within(dialogo).getByLabelText('Buscar base');
    expect(buscador).toHaveFocus();

    await userEvent.type(buscador, 'sur');
    expect(within(dialogo).getAllByRole('option')).toHaveLength(1);
    await userEvent.clear(buscador);
    await userEvent.type(buscador, 'oeste');
    expect(within(dialogo).getByText('Ninguna base coincide.')).toBeInTheDocument();
  });

  it('Enter en el buscador elige la primera que coincide en vez de mandar el formulario', async () => {
    const { dialogo, onGuardar } = montar();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');

    await userEvent.type(within(dialogo).getByLabelText('Buscar base'), 'sur{Enter}');

    expect(onGuardar).not.toHaveBeenCalled();
    expect(within(dialogo).getByText('Base Sur')).toBeInTheDocument();
    expect(within(dialogo).queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Dar de alta' }));
    expect(onGuardar).toHaveBeenCalledWith(expect.objectContaining({ baseId: 8 }));
  });

  it('Enter sin coincidencias no elige nada ni manda el formulario', async () => {
    const { dialogo, onGuardar } = montar();
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');

    await userEvent.type(within(dialogo).getByLabelText('Buscar base'), 'oeste{Enter}');

    expect(onGuardar).not.toHaveBeenCalled();
    expect(within(dialogo).getByText('Ninguna base coincide.')).toBeInTheDocument();
  });

  it('Escape con la lista abierta cierra la lista, no el diálogo', async () => {
    const { dialogo, onCerrar } = montar({ dron: alfa() });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cambiar' }));
    expect(within(dialogo).getByRole('listbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onCerrar).not.toHaveBeenCalled();
    expect(within(dialogo).queryByRole('listbox')).not.toBeInTheDocument();
    // vuelve a mostrar la base que ya tenía
    expect(within(dialogo).getByText('Base Norte')).toBeInTheDocument();

    // con la lista cerrada, Escape vuelve a ser el del diálogo
    within(dialogo).getByRole('button', { name: 'Cambiar' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('las teclas con la lista cerrada no hacen nada raro en el buscador', async () => {
    const { dialogo, onGuardar } = montar();
    const buscador = within(dialogo).getByLabelText('Buscar base');
    await userEvent.type(within(dialogo).getByLabelText('Nombre'), 'Delta');

    // se abre al enfocarlo, se cierra con Escape y un Enter ahí ya manda el
    // formulario, como en cualquier otro campo
    await userEvent.click(buscador);
    await userEvent.keyboard('{Escape}');
    expect(within(dialogo).queryByRole('listbox')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}');

    expect(onGuardar).toHaveBeenCalledWith({ displayName: 'Delta', model: '', inventoryCode: '' });
  });

  it('sin bases dadas de alta el buscador queda apagado y lo explica', () => {
    const { dialogo } = montar({ bases: [] });

    const buscador = within(dialogo).getByLabelText('Buscar base');
    expect(buscador).toBeDisabled();
    expect(buscador).toHaveAttribute('placeholder', 'No hay bases dadas de alta');
  });
});
