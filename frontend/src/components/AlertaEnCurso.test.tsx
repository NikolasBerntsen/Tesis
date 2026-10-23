import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import AlertaEnCurso from './AlertaEnCurso';
import ProveedorDeAlertas from './ProveedorDeAlertas';
import { time } from '../format';
import { makeAlert, makeDrone } from '../test/fixtures';
import type { Alert } from '../types';
import { ESPERA_DEL_RELEVO_MS } from '../useCarruselDeAlertas';
import type { Decision } from '../useDecisionDeAlerta';

// El pop-up de la alerta lleva un mapa: Leaflet no corre en jsdom.
vi.mock('leaflet', async () => (await import('../test/dobleLeaflet')).dobleLeaflet());

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
/** La región viva de la cuenta: lo que oye quien usa lector de pantalla. */
const anuncio = () => within(tarjeta()).getByRole('status');

describe('AlertaEnCurso', () => {
  it('muestra la captura, el tipo y la hora de la alerta', () => {
    montar();
    expect(screen.getByRole('heading', { name: 'Alerta en curso' })).toBeInTheDocument();
    // El tipo va en la placa óxido de la alerta, con su dibujo (oculto al lector).
    const tipo = screen.getByText('VEHÍCULO');
    expect(tipo).toHaveClass('chip', 'rojo');
    expect(tipo.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,QUFB',
    );
    const hora = makeAlert().created_at;
    expect(within(tarjeta()).getByText(time(hora))).toHaveAttribute('datetime', hora);
  });

  it('el pie del visor dice que es una captura: lo que está en vivo es el video del dron', () => {
    montar();
    const pie = document.querySelector('.visor-pie') as HTMLElement;
    expect(pie).toHaveTextContent('Captura');
    expect(pie).not.toHaveTextContent(/en vivo/i);
  });

  it('un tipo que la consola no conoce se muestra tal cual, y no en blanco', () => {
    montar({ alertas: [makeAlert({ type: 'ANIMAL' as never })] });
    const tipo = screen.getByText('ANIMAL');
    expect(tipo).toHaveClass('chip', 'rojo');
    // Sin dibujo: no hay uno que le corresponda.
    expect(tipo.querySelector('svg')).toBeNull();
  });

  it('sin captura lo dice en lugar de dejar un hueco', () => {
    montar({ alertas: [makeAlert({ snapshot: null })] });
    expect(screen.getByText('La detección no dejó captura.')).toBeInTheDocument();
    expect(document.querySelector('.visor-pie')).toHaveTextContent('Detección');
  });

  it('cuenta cuánto hace que la alerta espera, al segundo', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2024-01-01T12:08:17.000Z'));
      montar({ alertas: [makeAlert({ created_at: '2024-01-01T12:00:00.000Z' })] });
      const espera = () => document.querySelector('.alerta-espera time') as HTMLElement;
      expect(espera()).toHaveTextContent('00:08:17');
      expect(espera()).toHaveAttribute('datetime', 'PT497S');
      act(() => vi.advanceTimersByTime(1000));
      expect(espera()).toHaveTextContent('00:08:18');
    } finally {
      vi.useRealTimers();
    }
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
    expect(anuncio()).toHaveTextContent('Alerta 3 de 5, 2 alertas nuevas sin ver');
    await userEvent.click(screen.getByRole('button', { name: 'Ver las 2 alertas nuevas' }));
    expect(cuenta()).toHaveTextContent('1 de 5');
    expect(screen.getByRole('button', { name: 'Ver la alerta nueva' })).toBeInTheDocument();
    expect(anuncio()).toHaveTextContent('Alerta 1 de 5, una alerta nueva sin ver');
  });

  it('la región que anuncia la cuenta ya está con una sola alerta, y la segunda se anuncia al llegar', async () => {
    // La vista del dron no le pasa título: el encabezado no cambia y no avisa.
    const { conAlertas } = montar();
    const region = anuncio();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();

    conAlertas([makeAlert({ id: 7, type: 'VEHICLE', snapshot: 'QUFB' }), makeAlert({ id: 12 })]);
    // Es la misma región, ahora con texto: un cambio, que es lo que se anuncia.
    // Una región que naciera con la segunda alerta ya traería el texto puesto.
    expect(anuncio()).toBe(region);
    expect(region).toHaveTextContent('Alerta 2 de 2, una alerta nueva sin ver');

    await userEvent.click(screen.getByRole('button', { name: 'Ver la alerta nueva' }));
    expect(region).toHaveTextContent(/^Alerta 1 de 2$/);
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
    expect(bravo).toHaveClass('chip', 'oro');
    await userEvent.click(bravo);
    expect(onVerDron).toHaveBeenCalledWith('d2');

    await userEvent.click(siguiente());
    await userEvent.click(screen.getByRole('button', { name: 'Alfa' }));
    expect(onVerDron).toHaveBeenLastCalledWith('d1');
  });

  it('el segundo click de un doble click en Validar no decide la alerta de otro dron que entra en su lugar', () => {
    vi.useFakeTimers();
    try {
      // El pedido queda en viaje: el backend avisa por el WebSocket antes de contestarlo.
      const onDecidir = vi.fn(() => new Promise<void>(() => {}));
      const { conAlertas } = montar({
        alertas: [makeAlert({ id: 9, drone_id: 'd1' }), makeAlert({ id: 5, drone_id: 'd2' })],
        drones,
        onVerDron: vi.fn(),
        onDecidir,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Validar' }));
      expect(onDecidir).toHaveBeenCalledWith(9, 'VALIDATED');

      // La 9 (de Alfa) se va y en su lugar queda la 5, de Bravo, que nadie miró.
      conAlertas([makeAlert({ id: 5, drone_id: 'd2' })]);
      expect(screen.getByRole('button', { name: 'Bravo' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Descartar' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Validar' }));
      fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
      expect(onDecidir).toHaveBeenCalledTimes(1);

      // Pasada la espera ya es una decisión sobre algo que el operador tuvo a la vista.
      act(() => vi.advanceTimersByTime(ESPERA_DEL_RELEVO_MS));
      expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Validar' }));
      expect(onDecidir).toHaveBeenLastCalledWith(5, 'VALIDATED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('si el operador elige la vecina con las flechas, la puede decidir enseguida', async () => {
    const onDecidir = vi.fn();
    const { conAlertas } = montar({ alertas: TRES, onDecidir });
    conAlertas([TRES[0], TRES[2]]);
    expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();

    await userEvent.click(siguiente());
    await userEvent.click(anterior());
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(5, 'VALIDATED');
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

  it('suelta, sin la consola alrededor, no ofrece abrir la alerta: no habría quién la muestre', () => {
    montar();
    expect(screen.queryByRole('button', { name: 'Ver detalle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ampliar la captura/ })).not.toBeInTheDocument();
  });
});

describe('AlertaEnCurso — abrir la alerta en su pop-up', () => {
  const alfa = makeDrone({ droneId: 'd1', displayName: 'Alfa' });

  function enLaConsola(alertas = [makeAlert({ id: 7, type: 'VEHICLE', drone_id: 'd1', snapshot: 'QUFB' })]) {
    const verDron = vi.fn();
    render(
      <ProveedorDeAlertas alertas={alertas} drones={[alfa]} statuses={{}} decidir={vi.fn()} verDron={verDron}>
        <AlertaEnCurso alertas={alertas} onDecidir={vi.fn()} />
      </ProveedorDeAlertas>,
    );
    return { verDron };
  }

  it('tocar la captura abre el pop-up con la alerta, y al cerrarlo el foco vuelve a la captura', async () => {
    enLaConsola();
    const captura = screen.getByRole('button', { name: 'Ampliar la captura de la alerta #7' });
    expect(within(captura).getByAltText('Captura que disparó la detección')).toBeInTheDocument();

    await userEvent.click(captura);
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de vehículo #7' });
    expect(within(dialogo).getByAltText('Captura de la detección')).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Ver feed en vivo' })).toBeEnabled();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(captura).toHaveFocus();
  });

  it('"Ver detalle" abre la misma alerta, también la que llegó sin captura', async () => {
    enLaConsola([makeAlert({ id: 9, drone_id: 'd1', snapshot: null })]);
    expect(screen.queryByRole('button', { name: /Ampliar la captura/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #9' });
    // El pop-up lo dice con el mismo visor que la tarjeta de atrás.
    expect(within(dialogo).getByText('La detección no dejó captura.')).toBeInTheDocument();
  });

  it('desde el pop-up se va al video del dron', async () => {
    const { verDron } = enLaConsola();
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ver feed en vivo' }));
    expect(verDron).toHaveBeenCalledWith('d1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * La consola reducida a lo que importa acá: decidir cambia el estado de la
   * alerta y el carrusel recibe sólo las pendientes, como en el tablero. La
   * decidida se va del carrusel —con el botón que abrió el pop-up— mientras el
   * pop-up sigue abierto.
   */
  function TableroConCarrusel({ iniciales }: { iniciales: Alert[] }) {
    const [alertas, setAlertas] = useState(iniciales);
    const decidir = (id: number, decision: Decision) =>
      setAlertas((antes) => antes.map((a) => (a.id === id ? { ...a, status: decision } : a)));
    const pendientes = alertas.filter((a) => a.status === 'PENDING');
    return (
      <ProveedorDeAlertas alertas={alertas} drones={[alfa]} statuses={{}} decidir={decidir} verDron={vi.fn()}>
        <main>
          <h2 tabIndex={-1}>Operación</h2>
          {pendientes.length > 0 && <AlertaEnCurso alertas={pendientes} onDecidir={decidir} />}
        </main>
      </ProveedorDeAlertas>
    );
  }

  it('decidida desde el pop-up, al cerrarlo el foco vuelve al carrusel, que ya muestra la siguiente', async () => {
    render(<TableroConCarrusel iniciales={[makeAlert({ id: 9 }), makeAlert({ id: 7, type: 'VEHICLE' })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #9' });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Validar' }));
    expect(within(tarjeta()).getByText('VEHÍCULO')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tarjeta()).toHaveFocus();
  });

  it('si era la última y el carrusel se fue, al cerrar el pop-up el foco va al título de la vista', async () => {
    render(<TableroConCarrusel iniciales={[makeAlert({ id: 7, snapshot: 'QUFB' })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ampliar la captura de la alerta #7' }));
    const dialogo = screen.getByRole('dialog', { name: 'Alerta de persona #7' });
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Descartar' }));
    expect(screen.queryByRole('region', { name: 'Alerta en curso' })).not.toBeInTheDocument();

    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Operación' })).toHaveFocus();
  });

  it('cerrado sin decidir, el foco vuelve a lo que lo abrió y no al carrusel', async () => {
    render(<TableroConCarrusel iniciales={[makeAlert({ id: 9 }), makeAlert({ id: 7 })]} />);
    const verDetalle = screen.getByRole('button', { name: 'Ver detalle' });
    await userEvent.click(verDetalle);
    await userEvent.keyboard('{Escape}');
    expect(verDetalle).toHaveFocus();
  });
});
