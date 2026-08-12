import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AlertsPanel from './AlertsPanel';
import { makeAlert } from '../test/fixtures';

describe('AlertsPanel', () => {
  it('muestra el mensaje de vacío cuando no hay pendientes', () => {
    render(<AlertsPanel alerts={[]} onDecide={() => {}} />);
    expect(screen.getByText('Sin alertas pendientes.')).toBeInTheDocument();
  });

  it('lista las alertas pendientes con su tipo y contador', () => {
    render(
      <AlertsPanel
        alerts={[
          makeAlert({ id: 1, type: 'PERSON' }),
          makeAlert({ id: 2, type: 'VEHICLE' }),
        ]}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText('PERSONA')).toBeInTheDocument();
    expect(screen.getByText('VEHÍCULO')).toBeInTheDocument();
    // Badge con la cantidad de pendientes
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('muestra la snapshot cuando la alerta la trae', () => {
    render(<AlertsPanel alerts={[makeAlert({ snapshot: 'IMG' })]} onDecide={() => {}} />);
    const img = screen.getByAltText('Detección') as HTMLImageElement;
    expect(img.src).toContain('data:image/jpeg;base64,IMG');
  });

  it('dispara onDecide al validar y al descartar', async () => {
    const onDecide = vi.fn();
    render(<AlertsPanel alerts={[makeAlert({ id: 7 })]} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: 'Validar alerta' }));
    expect(onDecide).toHaveBeenCalledWith(7, 'VALIDATED');

    await userEvent.click(screen.getByRole('button', { name: 'Falso positivo' }));
    expect(onDecide).toHaveBeenCalledWith(7, 'DISMISSED');
  });

  it('muestra el historial reciente de alertas ya decididas', () => {
    render(
      <AlertsPanel
        alerts={[
          makeAlert({ id: 10, status: 'VALIDATED', decided_by: 'oper', decided_at: '2024-01-01T10:00:00.000Z' }),
          makeAlert({ id: 11, status: 'DISMISSED', decided_by: 'super', decided_at: '2024-01-01T11:00:00.000Z' }),
        ]}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText('Historial reciente')).toBeInTheDocument();
    expect(screen.getByText('VALIDADA')).toBeInTheDocument();
    expect(screen.getByText('DESCARTADA')).toBeInTheDocument();
    expect(screen.getByText(/por oper/)).toBeInTheDocument();
  });

  it('no muestra historial si sólo hay pendientes', () => {
    render(<AlertsPanel alerts={[makeAlert()]} onDecide={() => {}} />);
    expect(screen.queryByText('Historial reciente')).not.toBeInTheDocument();
  });

  it('abrevia el hash del dron y tolera que la alerta no lo traiga', () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    render(
      <AlertsPanel
        alerts={[makeAlert({ id: 3, drone_id: hash }), makeAlert({ id: 4, drone_id: null })]}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/#3 · a1b2c3…8f90/)).toBeInTheDocument();
    expect(screen.queryByText(hash)).not.toBeInTheDocument();
    expect(screen.getByText(/#4 · —/)).toBeInTheDocument();
  });
});
