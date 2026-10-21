import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AlertaEnCurso from './AlertaEnCurso';
import { makeAlert, makeDrone } from '../test/fixtures';

type Props = Parameters<typeof AlertaEnCurso>[0];

function montar(props: Partial<Props> = {}) {
  const todas: Props = {
    alertas: [makeAlert({ id: 7, type: 'VEHICLE', snapshot: 'QUFB' })],
    onDecidir: vi.fn(),
    ...props,
  };
  const { rerender } = render(<AlertaEnCurso {...todas} />);
  // La lista de pendientes cambia sola (llegan, se deciden en otra consola):
  // se la cambia sobre el mismo componente, que es donde vive la selección.
  const conAlertas = (alertas: Props['alertas']) => rerender(<AlertaEnCurso {...todas} alertas={alertas} />);
  return { ...todas, conAlertas };
}

/** Tres pendientes que llegan desordenadas: la 9 es la más nueva. */
const TRES = [
  makeAlert({ id: 3, type: 'PERSON' }),
  makeAlert({ id: 9, type: 'VEHICLE' }),
  makeAlert({ id: 5, type: 'PERSON', snapshot: 'QkJC' }),
];

const tarjeta = () => screen.getByRole('region', { name: 'Alerta en curso' });
const cuenta = () => screen.getByTestId('carrusel-cuenta');
const anterior = () => screen.getByRole('button', { name: 'Alerta anterior, más nueva' });
const siguiente = () => screen.getByRole('button', { name: 'Alerta siguiente, más vieja' });

describe('AlertaEnCurso', () => {
  it('muestra la captura, el tipo y la hora de la alerta', () => {
    montar();
    expect(screen.getByRole('heading', { name: 'Alerta en curso' })).toBeInTheDocument();
    expect(screen.getByText('VEHÍCULO')).toHaveClass('badge', 'vehicle');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,QUFB',
    );
    expect(tarjeta()).toBeInTheDocument();
  });

  it('un tipo que la consola no conoce se muestra tal cual, y no en blanco', () => {
    montar({ alertas: [makeAlert({ type: 'ANIMAL' as never })] });
    expect(screen.getByText('ANIMAL')).toHaveClass('badge', 'animal');
  });

  it('sin captura lo dice en lugar de dejar un hueco', () => {
    montar({ alertas: [makeAlert({ snapshot: null })] });
    expect(screen.getByText('La alerta llegó sin captura')).toBeInTheDocument();
  });

  it('sin alertas no dibuja nada', () => {
    const { container } = render(<AlertaEnCurso alertas={[]} onDecidir={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('valida y descarta con el id de la alerta', async () => {
    const { onDecidir } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(7, 'VALIDATED');
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onDecidir).toHaveBeenCalledWith(7, 'DISMISSED');
  });

  it('dice qué le hace cada botón al dron antes de apretarlo', () => {
    montar();
    expect(screen.getByText(/Descartar: retoma la ruta hacia el próximo nodo/)).toBeInTheDocument();
  });

  it('si el backend rechaza la decisión, el motivo queda a la vista', async () => {
    const onDecidir = vi.fn().mockRejectedValue(new Error('Esta alerta ya la decidió otro operador.'));
    montar({ onDecidir });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Esta alerta ya la decidió otro operador.');
  });

  it('un rechazo que no es un Error también se muestra', async () => {
    montar({ onDecidir: vi.fn().mockRejectedValue('el backend no contestó') });
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('el backend no contestó');
  });

  it('el motivo se limpia al volver a intentar', async () => {
    const onDecidir = vi.fn().mockRejectedValueOnce(new Error('falló')).mockResolvedValueOnce(undefined);
    montar({ onDecidir });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('falló');
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('mientras la decisión viaja los botones no aceptan un segundo click', async () => {
    let terminar: () => void = () => {};
    const onDecidir = vi.fn(() => new Promise<void>((r) => (terminar = r)));
    montar({ onDecidir });

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeDisabled();

    terminar();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled());
    expect(onDecidir).toHaveBeenCalledTimes(1);
  });

  it('con un dron sobre el objetivo de esta alerta, lo dice', () => {
    montar({ seguidas: [null, 7] });
    expect(screen.getByText(/El dron está sobre este objetivo/)).toBeInTheDocument();
  });

  it('con una sola alerta no hay nada que recorrer: ni flechas ni cuenta', () => {
    montar();
    expect(screen.queryByRole('button', { name: /Alerta anterior/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('carrusel-cuenta')).not.toBeInTheDocument();
    // Sigue siendo enfocable por código: es adonde vuelve el foco al decidir.
    expect(tarjeta()).toHaveAttribute('tabindex', '-1');
  });

  it('acepta otro título y la variante apaisada del tablero', () => {
    montar({ titulo: '2 alertas sin atender', apaisada: true });
    expect(screen.getByRole('region', { name: '2 alertas sin atender' })).toHaveClass('alerta-en-curso', 'apaisada');
  });
});

describe('AlertaEnCurso — carrusel', () => {
  it('arranca en la más nueva y dice cuál es de cuántas', () => {
    montar({ alertas: TRES });
    expect(cuenta()).toHaveTextContent('1 de 3');
    expect(within(tarjeta()).getByText('VEHÍCULO')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '1 de 3' })).toBeInTheDocument();
    expect(tarjeta()).toHaveAttribute('aria-roledescription', 'carrusel');
  });

  it('las flechas recorren de la más nueva a la más vieja', async () => {
    const { onDecidir } = montar({ alertas: TRES });
    await userEvent.click(siguiente());
    expect(cuenta()).toHaveTextContent('2 de 3');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QkJC');

    await userEvent.click(siguiente());
    expect(cuenta()).toHaveTextContent('3 de 3');
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(3, 'VALIDATED');

    await userEvent.click(anterior());
    expect(cuenta()).toHaveTextContent('2 de 3');
  });

  it('en las puntas la flecha se apaga y no da la vuelta', async () => {
    montar({ alertas: TRES });
    expect(anterior()).toHaveAttribute('aria-disabled', 'true');
    expect(siguiente()).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(anterior());
    expect(cuenta()).toHaveTextContent('1 de 3');

    await userEvent.click(siguiente());
    await userEvent.click(siguiente());
    expect(siguiente()).toHaveAttribute('aria-disabled', 'true');
    expect(anterior()).toHaveAttribute('aria-disabled', 'false');
    await userEvent.click(siguiente());
    expect(cuenta()).toHaveTextContent('3 de 3');
  });

  it('con el foco en el carrusel, las flechas del teclado lo recorren', async () => {
    montar({ alertas: TRES });
    expect(tarjeta()).toHaveAttribute('tabindex', '0');
    tarjeta().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(cuenta()).toHaveTextContent('2 de 3');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(cuenta()).toHaveTextContent('3 de 3');
    await userEvent.keyboard('{ArrowLeft}');
    expect(cuenta()).toHaveTextContent('2 de 3');
  });

  it('desde un botón de adentro las flechas también andan', async () => {
    montar({ alertas: TRES });
    siguiente().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(cuenta()).toHaveTextContent('2 de 3');
    // El paso sigue enfocado aunque llegue a la punta: está con aria-disabled.
    await userEvent.keyboard('{Enter}');
    expect(cuenta()).toHaveTextContent('3 de 3');
    expect(siguiente()).toHaveFocus();
  });

  it('no se mete con los atajos del navegador ni con otras teclas', () => {
    montar({ alertas: TRES });
    fireEvent.keyDown(tarjeta(), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(tarjeta(), { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(tarjeta(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(tarjeta(), { key: 'ArrowRight', metaKey: true });
    expect(cuenta()).toHaveTextContent('1 de 3');

    const tecla = fireEvent.keyDown(tarjeta(), { key: 'Enter' });
    // `fireEvent` devuelve false sólo si alguien llamó a preventDefault.
    expect(tecla).toBe(true);
    expect(fireEvent.keyDown(tarjeta(), { key: 'ArrowRight' })).toBe(false);
  });

  it('al decidirse la que se mira, queda la vecina que le seguía y no la primera', async () => {
    const { conAlertas } = montar({ alertas: TRES });
    await userEvent.click(siguiente());
    expect(cuenta()).toHaveTextContent('2 de 3');

    // La 5 se decidió: el backend la saca de las pendientes.
    conAlertas([TRES[0], TRES[1]]);
    expect(cuenta()).toHaveTextContent('2 de 2');
    expect(screen.queryByAltText('Captura que disparó la detección')).not.toBeInTheDocument();
    expect(within(tarjeta()).getByText('PERSONA')).toBeInTheDocument();
  });

  it('si la decidida era la última, queda la anterior', async () => {
    const { conAlertas } = montar({ alertas: TRES });
    await userEvent.click(siguiente());
    await userEvent.click(siguiente());
    conAlertas([TRES[1], TRES[2]]);
    expect(cuenta()).toHaveTextContent('2 de 2');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QkJC');
  });

  it('el foco que estaba en Validar vuelve al carrusel y no pasa a la vecina', async () => {
    const { conAlertas } = montar({ alertas: TRES });
    const validar = screen.getByRole('button', { name: 'Validar' });
    validar.focus();
    conAlertas([TRES[0], TRES[2]]);
    // Un segundo Enter no puede validar una alerta que el operador no miró.
    expect(screen.getByRole('button', { name: 'Validar' })).not.toHaveFocus();
    expect(tarjeta()).toHaveFocus();
  });

  it('al quedar una sola, el foco igual vuelve a la tarjeta', () => {
    const { conAlertas } = montar({ alertas: [TRES[0], TRES[1]] });
    screen.getByRole('button', { name: 'Descartar' }).focus();
    conAlertas([TRES[0]]);
    expect(tarjeta()).toHaveFocus();
    expect(screen.queryByTestId('carrusel-cuenta')).not.toBeInTheDocument();
  });

  it('si el navegador suelta el foco del botón deshabilitado mientras se decide, vuelve al carrusel', async () => {
    let terminar: () => void = () => {};
    const onDecidir = vi.fn(() => new Promise<void>((r) => (terminar = r)));
    montar({ alertas: TRES, onDecidir });
    const validar = screen.getByRole('button', { name: 'Validar' });
    await userEvent.click(validar);
    expect(validar).toBeDisabled();
    // Así lo hace Chrome con un botón enfocado que se deshabilita: avisa con un
    // focusout sin destino y deja el foco en ningún lado. jsdom no lo hace solo.
    fireEvent.focusOut(validar, { relatedTarget: null });
    const enNingunLado = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);

    // Si el backend la rechaza, la alerta sigue ahí: el foco vuelve igual.
    await act(async () => terminar());
    enNingunLado.mockRestore();
    expect(tarjeta()).toHaveFocus();
  });

  it('si el operador sacó el foco del carrusel, irse una alerta no lo trae de vuelta', () => {
    const { conAlertas } = montar({ alertas: TRES });
    const validar = screen.getByRole('button', { name: 'Validar' });
    validar.focus();
    // Un click en una parte de la página que no se enfoca: el foco va a ningún lado.
    act(() => validar.blur());
    conAlertas([TRES[0], TRES[2]]);
    expect(tarjeta()).not.toHaveFocus();
  });

  it('si el foco estaba en otra parte, irse una alerta no se lo roba', async () => {
    render(<button type="button">Afuera</button>);
    const { conAlertas } = montar({ alertas: TRES });
    // Pasa por el carrusel y sale: el carrusel tiene que enterarse de que el foco se fue.
    await userEvent.click(siguiente());
    await userEvent.click(screen.getByRole('button', { name: 'Afuera' }));
    conAlertas([TRES[1], TRES[0]]);
    expect(screen.getByRole('button', { name: 'Afuera' })).toHaveFocus();
  });

  it('una alerta nueva no saca al operador de la que mira: cambia la cuenta y la cuenta late', async () => {
    const { conAlertas } = montar({ alertas: TRES });
    await userEvent.click(siguiente());
    expect(cuenta()).not.toHaveClass('llego');

    conAlertas([...TRES, makeAlert({ id: 12, type: 'VEHICLE', snapshot: 'Q0ND' })]);
    // Sigue en la 5 (la de la captura QkJC), que ahora es la tercera de cuatro.
    expect(cuenta()).toHaveTextContent('3 de 4');
    expect(cuenta()).toHaveClass('llego');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,QkJC');

    // Y queda un aviso quieto para quien no ve el latido.
    await userEvent.click(screen.getByRole('button', { name: 'Ver la alerta nueva' }));
    expect(cuenta()).toHaveTextContent('1 de 4');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute('src', 'data:image/jpeg;base64,Q0ND');
    expect(screen.queryByRole('button', { name: /alerta nueva/ })).not.toBeInTheDocument();
  });

  it('con varias nuevas sin ver, el aviso las cuenta', async () => {
    const { conAlertas } = montar({ alertas: TRES });
    conAlertas([...TRES, makeAlert({ id: 12 }), makeAlert({ id: 14 })]);
    expect(cuenta()).toHaveTextContent('3 de 5');
    await userEvent.click(screen.getByRole('button', { name: 'Ver las 2 alertas nuevas' }));
    expect(cuenta()).toHaveTextContent('1 de 5');
    expect(screen.getByRole('button', { name: 'Ver la alerta nueva' })).toBeInTheDocument();
  });

  it('el error de una alerta queda con esa alerta al recorrer', async () => {
    const onDecidir = vi.fn().mockRejectedValue(new Error('falló la 9'));
    montar({ alertas: TRES, onDecidir });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('falló la 9');

    await userEvent.click(siguiente());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(anterior());
    expect(screen.getByRole('alert')).toHaveTextContent('falló la 9');
  });
});

describe('AlertaEnCurso — en el tablero', () => {
  const drones = [makeDrone({ droneId: 'd1', displayName: 'Alfa' }), makeDrone({ droneId: 'd2', displayName: 'Bravo' })];

  it('dice de qué dron es cada alerta y lleva a su vista', async () => {
    const onVerDron = vi.fn();
    montar({
      alertas: [makeAlert({ id: 1, drone_id: 'd1' }), makeAlert({ id: 2, drone_id: 'd2' })],
      drones,
      onVerDron,
    });
    const bravo = screen.getByRole('button', { name: 'Bravo' });
    expect(bravo).toHaveAttribute('title', 'Abrir la vista de Bravo');
    await userEvent.click(bravo);
    expect(onVerDron).toHaveBeenCalledWith('d2');

    await userEvent.click(siguiente());
    await userEvent.click(screen.getByRole('button', { name: 'Alfa' }));
    expect(onVerDron).toHaveBeenLastCalledWith('d1');
  });

  it('una alerta de un dron que ya no está no lleva a ningún lado', () => {
    montar({ alertas: [makeAlert({ id: 1, drone_id: 'd9' })], drones, onVerDron: vi.fn() });
    const desconocido = screen.getByRole('button', { name: 'Dron desconocido' });
    expect(desconocido).toBeDisabled();
    expect(desconocido).not.toHaveAttribute('title');
  });

  it('sin `onVerDron` (vista del dron) no repite el nombre del dron', () => {
    montar({ alertas: [makeAlert({ id: 1, drone_id: 'd1' })], drones });
    expect(screen.queryByRole('button', { name: 'Alfa' })).not.toBeInTheDocument();
  });
});
