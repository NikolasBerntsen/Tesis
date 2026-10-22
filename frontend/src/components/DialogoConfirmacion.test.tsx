import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';

/** Una promesa que el test resuelve o rechaza cuando quiere, para ver el estado intermedio. */
function pendiente() {
  let resolver!: () => void;
  let rechazar!: (motivo: unknown) => void;
  const promesa = new Promise<void>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

function montar(cambios: Partial<PedidoDeConfirmacion> = {}) {
  const onCerrar = vi.fn();
  const accion = cambios.accion ?? vi.fn();
  const pedido: PedidoDeConfirmacion = {
    titulo: 'Eliminar el dron Alfa',
    subtitulo: 'La baja se puede deshacer',
    consecuencia: 'El dron se desconecta en el acto.',
    detalle: 'Se puede restaurar desde «Ver eliminados».',
    confirmar: 'Eliminar',
    enCurso: 'Eliminando…',
    ...cambios,
    accion,
  };
  render(<DialogoConfirmacion pedido={pedido} onCerrar={onCerrar} />);
  return { onCerrar, accion, dialogo: screen.getByRole('dialog', { name: pedido.titulo }) };
}

describe('DialogoConfirmacion', () => {
  it('dice qué, la consecuencia y cómo deshacerlo, con la consecuencia como descripción', () => {
    const { dialogo } = montar();
    expect(within(dialogo).getByRole('heading', { name: 'Eliminar el dron Alfa' })).toBeInTheDocument();
    expect(dialogo).toHaveTextContent('La baja se puede deshacer');
    expect(dialogo).toHaveAccessibleDescription('El dron se desconecta en el acto.');
    expect(dialogo).toHaveTextContent('Se puede restaurar desde «Ver eliminados».');
  });

  it('sin subtítulo ni detalle no deja huecos vacíos', () => {
    const { dialogo } = montar({ subtitulo: undefined, detalle: undefined });
    expect(dialogo.querySelector('.modal-subtitulo')).toBeNull();
    expect(dialogo.querySelectorAll('.modal-cuerpo p')).toHaveLength(1);
  });

  it('el foco arranca en Cancelar: un Enter apurado no confirma nada', async () => {
    const { dialogo, accion, onCerrar } = montar();
    const cancelar = within(dialogo).getByRole('button', { name: 'Cancelar' });
    expect(cancelar).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(accion).not.toHaveBeenCalled();
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('se cierra sin hacer nada con Cancelar, la cruz y Escape', async () => {
    const { dialogo, accion, onCerrar } = montar();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cerrar la confirmación' }));
    await userEvent.keyboard('{Escape}');
    expect(onCerrar).toHaveBeenCalledTimes(3);
    expect(accion).not.toHaveBeenCalled();
  });

  it('lo destructivo va con el filo óxido de Eliminar; lo que no, con el oro', () => {
    const { dialogo } = montar();
    expect(within(dialogo).getByRole('button', { name: 'Eliminar' })).toHaveClass('dismiss');
  });

  it('el tono primario y una salida con su propio verbo', () => {
    const { dialogo } = montar({ tono: 'primario', confirmar: 'Asignarla igual', cancelar: 'No asignarla' });
    expect(within(dialogo).getByRole('button', { name: 'Asignarla igual' })).toHaveClass('primario');
    expect(within(dialogo).getByRole('button', { name: 'No asignarla' })).toHaveFocus();
    expect(within(dialogo).queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });

  it('una acción que no espera nada se hace y cierra en el acto', async () => {
    const { dialogo, accion, onCerrar } = montar();
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(accion).toHaveBeenCalledTimes(1);
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('con el pedido en viaje, todo se apaga y nada cierra el diálogo', async () => {
    const viaje = pendiente();
    const { dialogo, onCerrar } = montar({ accion: () => viaje.promesa });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    const enCurso = within(dialogo).getByRole('button', { name: 'Eliminando…' });
    expect(enCurso).toBeDisabled();
    expect(enCurso).toHaveAttribute('aria-busy', 'true');
    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(within(dialogo).getByRole('button', { name: 'Cerrar la confirmación' })).toBeDisabled();

    // Ni Escape ni el velo: el backend lo va a procesar igual.
    fireEvent.keyDown(document, { key: 'Escape' });
    const velo = dialogo.parentElement as HTMLElement;
    fireEvent.mouseDown(velo);
    fireEvent.click(velo);
    expect(onCerrar).not.toHaveBeenCalled();

    // Con los tres botones apagados, el tabulador no escapa del diálogo.
    await userEvent.tab();
    expect(dialogo).toHaveFocus();

    await act(async () => viaje.resolver());
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('sin rótulo de "en curso", el botón conserva el verbo mientras espera', async () => {
    const viaje = pendiente();
    const { dialogo } = montar({ enCurso: undefined, accion: () => viaje.promesa });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(within(dialogo).getByRole('button', { name: 'Eliminar' })).toBeDisabled();
    await act(async () => viaje.resolver());
  });

  it('si el backend rechaza, el motivo se lee adentro y se puede reintentar o cancelar', async () => {
    const viaje = pendiente();
    const accion = vi.fn().mockReturnValueOnce(viaje.promesa).mockResolvedValueOnce(undefined);
    const { dialogo, onCerrar } = montar({ accion });

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    await act(async () => viaje.rechazar(new Error('La base tiene 2 drones asignados')));

    expect(within(dialogo).getByRole('alert')).toHaveTextContent('La base tiene 2 drones asignados');
    expect(onCerrar).not.toHaveBeenCalled();
    expect(within(dialogo).getByRole('button', { name: 'Cancelar' })).toBeEnabled();

    // Reintentar borra el error viejo y, si sale bien, cierra.
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument();
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it('un rechazo que no es un Error igual se lee', async () => {
    const { dialogo } = montar({ accion: () => Promise.reject('sin conexión') });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Eliminar' }));
    expect(await within(dialogo).findByRole('alert')).toHaveTextContent('sin conexión');
  });

  it('la cruz es el ícono de trazo del sistema, no un glifo de texto', () => {
    const { dialogo } = montar();
    const cruz = within(dialogo).getByRole('button', { name: 'Cerrar la confirmación' });
    expect(cruz.textContent).toBe('');
    expect(cruz.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
