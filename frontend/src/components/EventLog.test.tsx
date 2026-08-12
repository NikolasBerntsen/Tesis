import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EventLog from './EventLog';
import { makeEvent } from '../test/fixtures';

describe('EventLog', () => {
  it('muestra el mensaje de vacío cuando no hay eventos', () => {
    render(<EventLog events={[]} />);
    expect(screen.getByText('Sin eventos registrados.')).toBeInTheDocument();
  });

  it('lista los eventos con su tipo y mensaje', () => {
    render(
      <EventLog
        events={[
          makeEvent({ id: 1, type: 'STATUS', message: 'todo ok' }),
          makeEvent({ id: 2, type: 'ALERT_CREATED', message: 'persona detectada' }),
        ]}
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
    const { rerender } = render(<EventLog events={[]} />);
    expect(screen.queryByText('Detalle')).not.toBeInTheDocument();

    rerender(<EventLog events={[makeEvent()]} />);
    expect(screen.getByText('Hora')).toBeInTheDocument();
    expect(screen.getByText('Evento')).toBeInTheDocument();
    expect(screen.getByText('Detalle')).toBeInTheDocument();
  });
});
