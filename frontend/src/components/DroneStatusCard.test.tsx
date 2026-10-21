import { render, screen, within } from '@testing-library/react';
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
    // La cifra y su unidad son dos nodos: el valor manda y el '%' va chico.
    expect(screen.getByText('63')).toHaveTextContent('63%');
    expect(screen.getByText('72')).toHaveTextContent('72%');
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

  it('sin ruta cargada no muestra nodo ni su medidor', () => {
    const { container } = render(
      <DroneStatusCard status={makeStatus({ waypointTotal: 0 })} onResumePatrol={() => {}} />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    // Quedan los medidores de batería y señal; el del recorrido no se dibuja.
    expect(container.querySelectorAll('.medidor')).toHaveLength(2);
  });

  it('aplica la clase de batería según el nivel', () => {
    render(<DroneStatusCard status={makeStatus({ battery: 15 })} onResumePatrol={() => {}} />);
    expect(screen.getByText('15')).toHaveClass('bad');
  });
});

describe('DroneStatusCard — siguiendo al objetivo', () => {
  const OBJETIVO = {
    alertId: 12,
    type: 'VEHICLE' as const,
    lat: -34.6041,
    lon: -58.3817,
    speedMs: 4.2,
    courseDeg: 118,
    moving: true,
    lost: false,
    lastSeenMs: 600,
    decision: 'PENDING' as const,
  };

  it('FOLLOWING se resalta igual que la órbita, con su propia etiqueta', () => {
    render(<DroneStatusCard status={makeStatus({ state: 'FOLLOWING' })} onResumePatrol={() => {}} />);
    expect(screen.getByText('Siguiendo objetivo')).toHaveClass('accent');
    expect(screen.getByRole('button', { name: 'Reanudar patrullaje' })).toBeInTheDocument();
  });

  it.each(['ORBITING', 'FOLLOWING'])(
    'con un objetivo cargado (%s), el botón dice que se deja el objetivo',
    async (state) => {
      const onResume = vi.fn();
      render(<DroneStatusCard status={makeStatus({ state, target: OBJETIVO })} onResumePatrol={onResume} />);
      expect(screen.queryByRole('button', { name: 'Reanudar patrullaje' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Dejar el objetivo y reanudar patrullaje' }));
      expect(onResume).toHaveBeenCalled();
    },
  );

  it('con el control tomado no ofrece reanudar: eso pasa por soltar el control', () => {
    render(
      <DroneStatusCard status={makeStatus({ state: 'ORBITING', target: OBJETIVO })} controlTomado onResumePatrol={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: /reanudar patrullaje/i })).not.toBeInTheDocument();
  });
});

describe('DroneStatusCard — vuelo y GPS', () => {
  const segundoNivel = () => document.body.querySelector('.status-segundo-nivel') as HTMLElement;

  it('sin GPS muestra "Sin GPS (N satélites)" en vez de coordenadas', () => {
    render(
      <DroneStatusCard
        status={makeStatus({ lat: null, lon: null, gpsFix: false, satellites: 3 })}
        onResumePatrol={() => {}}
      />,
    );
    expect(within(segundoNivel()).getByText('Sin GPS (3 satélites)')).toBeInTheDocument();
    expect(screen.queryByText(/-34\.6/)).not.toBeInTheDocument();
    // Y se dice también en la línea que se mira, no sólo en lo plegado.
    expect(screen.getByTestId('detalle-de-vuelo')).toHaveTextContent('sin GPS');
  });

  it('el 0,0 del SDK sin fix tampoco se muestra como posición', () => {
    render(<DroneStatusCard status={makeStatus({ lat: 0, lon: 0, satellites: 0 })} onResumePatrol={() => {}} />);
    expect(within(segundoNivel()).getByText('Sin GPS (0 satélites)')).toBeInTheDocument();
    expect(screen.queryByText('0.00000, 0.00000')).not.toBeInTheDocument();
  });

  it('gpsFix false manda aunque lleguen coordenadas', () => {
    render(<DroneStatusCard status={makeStatus({ gpsFix: false, satellites: 5 })} onResumePatrol={() => {}} />);
    expect(within(segundoNivel()).getByText('Sin GPS (5 satélites)')).toBeInTheDocument();
    expect(screen.queryByText('-34.60123, -58.40456')).not.toBeInTheDocument();
  });

  it('en el suelo lo dice al lado del estado', () => {
    render(<DroneStatusCard status={makeStatus({ state: 'MANUAL', flying: false, alt: 0 })} onResumePatrol={() => {}} />);
    expect(screen.getByTestId('detalle-de-vuelo')).toHaveTextContent('En el suelo');
  });

  it('en el aire dice a qué altura', () => {
    render(<DroneStatusCard status={makeStatus({ flying: true, alt: 31.6 })} onResumePatrol={() => {}} />);
    expect(screen.getByTestId('detalle-de-vuelo')).toHaveTextContent('En el aire, a 32 m');
  });

  it('muestra altura, satélites y modo de vuelo en el segundo nivel cuando vienen', () => {
    render(
      <DroneStatusCard
        status={makeStatus({ flying: true, alt: 31.6, satellites: 14, gpsFix: true, flightMode: 'ATTI' })}
        onResumePatrol={() => {}}
      />,
    );
    const plegado = segundoNivel();
    expect(within(plegado).getByText('31.6 m')).toBeInTheDocument();
    expect(within(plegado).getByText('14')).toBeInTheDocument();
    expect(within(plegado).getByText('ATTI')).toBeInTheDocument();
    expect(within(plegado).getByText('-34.60123, -58.40456')).toBeInTheDocument();
  });

  it('una app vieja que no manda esos datos no inventa ninguno', () => {
    render(<DroneStatusCard status={makeStatus()} onResumePatrol={() => {}} />);
    expect(screen.queryByTestId('detalle-de-vuelo')).not.toBeInTheDocument();
    expect(screen.queryByText('Altura')).not.toBeInTheDocument();
    expect(screen.queryByText('Satélites')).not.toBeInTheDocument();
    expect(screen.queryByText('Modo de vuelo')).not.toBeInTheDocument();
  });

  it('un modo de vuelo vacío (el simulador) no se muestra', () => {
    render(<DroneStatusCard status={makeStatus({ flightMode: '' })} onResumePatrol={() => {}} />);
    expect(screen.queryByText('Modo de vuelo')).not.toBeInTheDocument();
  });
});
