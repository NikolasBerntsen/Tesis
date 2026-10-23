import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EventLog from './EventLog';
import { makeEvent } from '../test/fixtures';

const abrirNada = () => {};

describe('EventLog', () => {
  it('muestra el mensaje de vacío cuando no hay eventos', () => {
    render(<EventLog events={[]} onAbrir={abrirNada} />);
    expect(screen.getByText('Sin eventos registrados.')).toBeInTheDocument();
  });

  it('lista los eventos con su tipo y mensaje', () => {
    render(
      <EventLog
        events={[
          makeEvent({ id: 1, type: 'STATUS', message: 'todo ok' }),
          makeEvent({ id: 2, type: 'ALERT_CREATED', message: 'persona detectada' }),
        ]}
        onAbrir={abrirNada}
      />,
    );
    expect(screen.getByText('todo ok')).toBeInTheDocument();
    expect(screen.getByText('persona detectada')).toBeInTheDocument();
  });

  it('resalta los tipos de evento importantes', () => {
    render(
      <EventLog
        events={[
          makeEvent({ id: 1, type: 'ALERT_CREATED' }),
          makeEvent({ id: 2, type: 'RTH_LOW_BATTERY' }),
          makeEvent({ id: 3, type: 'STATUS' }),
        ]}
        onAbrir={abrirNada}
      />,
    );
    expect(screen.getByText('ALERT_CREATED')).toHaveClass('bad');
    expect(screen.getByText('RTH_LOW_BATTERY')).toHaveClass('warn');
    // Un tipo sin resaltar no lleva ni bad ni warn
    const normal = screen.getByText('STATUS');
    expect(normal).not.toHaveClass('bad');
    expect(normal).not.toHaveClass('warn');
  });

  it('rotula las columnas sólo cuando hay eventos', () => {
    const { rerender } = render(<EventLog events={[]} onAbrir={abrirNada} />);
    expect(screen.queryByText('Detalle')).not.toBeInTheDocument();

    rerender(<EventLog events={[makeEvent()]} onAbrir={abrirNada} />);
    expect(screen.getByText('Hora')).toBeInTheDocument();
    expect(screen.getByText('Evento')).toBeInTheDocument();
    expect(screen.getByText('Detalle')).toBeInTheDocument();
  });

  it('mientras llega el historial no dice "sin eventos": muestra el esqueleto', () => {
    const { rerender } = render(<EventLog events={[]} cargando onAbrir={abrirNada} />);
    expect(screen.getByRole('status')).toHaveTextContent('Trayendo los eventos del dron…');
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();

    rerender(<EventLog events={[]} cargando={false} onAbrir={abrirNada} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Sin eventos registrados.')).toBeInTheDocument();
  });

  it('lo que llega en vivo se ve aunque el historial todavía viaje', () => {
    render(<EventLog events={[makeEvent({ id: 9, message: 'llegó en vivo' })]} cargando onAbrir={abrirNada} />);
    expect(screen.getByText('llegó en vivo')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Sin eventos registrados.')).not.toBeInTheDocument();
  });

  it('cada fila es un botón que abre su detalle, con el mouse y con el teclado', async () => {
    const onAbrir = vi.fn();
    const alerta = makeEvent({ id: 4, type: 'ALERT_CREATED', message: 'Alerta de PERSONA generada por Alfa' });
    render(<EventLog events={[makeEvent({ id: 3, message: 'otro' }), alerta]} onAbrir={onAbrir} />);

    const fila = screen.getByRole('button', { name: 'Ver el detalle de ALERT_CREATED: Alerta de PERSONA generada por Alfa' });
    await userEvent.click(fila);
    expect(onAbrir).toHaveBeenCalledWith(alerta);

    // Es un botón de verdad: se llega con el tabulador y se abre con Enter.
    onAbrir.mockClear();
    fila.focus();
    await userEvent.keyboard('{Enter}');
    expect(onAbrir).toHaveBeenCalledWith(alerta);
  });

  it('marca la fila abierta, y sólo esa', () => {
    render(
      <EventLog
        events={[makeEvent({ id: 1, message: 'primero' }), makeEvent({ id: 2, message: 'segundo' })]}
        seleccionado={2}
        onAbrir={abrirNada}
      />,
    );
    expect(screen.getByRole('button', { name: /segundo/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /primero/ })).not.toHaveAttribute('aria-current');
  });
});
