import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DroneStatusCard from './DroneStatusCard';
import { makeStatus } from '../test/fixtures';

describe('DroneStatusCard', () => {
  it('muestra el vacío cuando el dron no reportó estado', () => {
    render(<DroneStatusCard status={null} onResumePatrol={() => {}} />);
    expect(screen.getByText(/todavía no reportó estado/)).toBeInTheDocument();
  });

  it('muestra todos los datos del estado', () => {
    render(
      <DroneStatusCard
        status={makeStatus({ battery: 63.4, signalPct: 72, waypointIndex: 2, waypointTotal: 5, mode: 'DEPLOY' })}
        onResumePatrol={() => {}}
      />,
    );
    expect(screen.getByText('Patrullando')).toBeInTheDocument();
    expect(screen.getByText('63%')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('3 de 5')).toBeInTheDocument();
    expect(screen.getByText('DEPLOY')).toBeInTheDocument();
    expect(screen.getByText('-34.60123, -58.40456')).toBeInTheDocument();
  });

  it('muestra "PERDIDA" en la señal cuando el enlace se cayó', () => {
    render(<DroneStatusCard status={makeStatus({ signal: 'LOST', signalPct: 0 })} onResumePatrol={() => {}} />);
    const perdida = screen.getByText('PERDIDA');
    expect(perdida).toHaveClass('bad');
  });

  it('resalta el estado y ofrece reanudar cuando está orbitando', async () => {
    const onResume = vi.fn();
    render(<DroneStatusCard status={makeStatus({ state: 'ORBITING' })} onResumePatrol={onResume} />);
    expect(screen.getByText('Orbitando objetivo')).toHaveClass('accent');
    await userEvent.click(screen.getByRole('button', { name: 'Reanudar patrullaje' }));
    expect(onResume).toHaveBeenCalled();
  });

  it('no muestra el botón de reanudar fuera de la órbita', () => {
    render(<DroneStatusCard status={makeStatus({ state: 'PATROLLING' })} onResumePatrol={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Reanudar patrullaje' })).not.toBeInTheDocument();
  });

  it('aplica la clase de batería según el nivel', () => {
    render(<DroneStatusCard status={makeStatus({ battery: 15 })} onResumePatrol={() => {}} />);
    expect(screen.getByText('15%')).toHaveClass('bad');
  });
});
