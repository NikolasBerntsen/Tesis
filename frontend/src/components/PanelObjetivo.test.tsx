import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PanelObjetivo from './PanelObjetivo';
import type { ObjetivoEnSeguimiento } from '../types';

function objetivo(over: Partial<ObjetivoEnSeguimiento> = {}): ObjetivoEnSeguimiento {
  return {
    alertId: 12,
    type: 'VEHICLE',
    lat: -34.60412,
    lon: -58.3817,
    speedMs: 4.2,
    courseDeg: 118,
    moving: true,
    lost: false,
    lastSeenMs: 600,
    decision: 'PENDING',
    ...over,
  };
}

const escribirEnPortapapeles = vi.fn();

beforeEach(() => {
  escribirEnPortapapeles.mockReset();
  escribirEnPortapapeles.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: escribirEnPortapapeles },
    configurable: true,
  });
});

/** El valor de un renglón del panel, buscado por su rótulo. */
function valor(rotulo: string): HTMLElement {
  return screen.getByText(rotulo, { selector: 'dt' }).nextElementSibling as HTMLElement;
}

describe('PanelObjetivo', () => {
  it('muestra tipo, situación, velocidad, rumbo, cuándo se lo vio y la decisión', () => {
    render(<PanelObjetivo objetivo={objetivo()} />);
    expect(screen.getByRole('heading', { name: 'Objetivo' })).toBeInTheDocument();
    expect(valor('Tipo')).toHaveTextContent('Vehículo · alerta #12');
    expect(screen.getByTestId('situacion-objetivo')).toHaveTextContent('En movimiento');
    expect(valor('Velocidad')).toHaveTextContent('4.2 m/s (15 km/h)');
    expect(valor('Rumbo')).toHaveTextContent('118° SE');
    expect(valor('Visto')).toHaveTextContent('hace menos de 1 s');
    expect(valor('Decisión')).toHaveTextContent('Sin decidir');
    expect(screen.getByTestId('coordenadas-objetivo')).toHaveTextContent('-34.604120, -58.381700');
  });

  it('quieto no muestra rumbo: el número sería ruido del filtro', () => {
    render(<PanelObjetivo objetivo={objetivo({ moving: false, speedMs: 0.2 })} />);
    expect(screen.getByTestId('situacion-objetivo')).toHaveTextContent('Quieto');
    expect(valor('Rumbo')).toHaveTextContent('—');
  });

  it('perdido: avisa que la posición es la última conocida', () => {
    render(<PanelObjetivo objetivo={objetivo({ lost: true, lastSeenMs: 12_400 })} />);
    expect(screen.getByTestId('situacion-objetivo')).toHaveTextContent('Perdido');
    expect(screen.getByTestId('situacion-objetivo')).toHaveClass('warn');
    expect(screen.getByText('Última posición', { selector: 'dt' })).toBeInTheDocument();
    expect(valor('Visto')).toHaveTextContent('hace 12 s');
    expect(screen.getByRole('status')).toHaveTextContent(/orbita la última posición conocida/);
  });

  it('validada lo dice en verde', () => {
    render(<PanelObjetivo objetivo={objetivo({ decision: 'VALIDATED' })} />);
    expect(within(valor('Decisión')).getByText('Validada por un operador')).toHaveClass('estado', 'ok');
  });

  it('sin el alert_ack todavía no hay número de alerta', () => {
    render(<PanelObjetivo objetivo={objetivo({ alertId: null, type: 'PERSON' })} />);
    expect(valor('Tipo')).toHaveTextContent(/^Persona$/);
  });

  it('copia las coordenadas para el equipo de tierra', async () => {
    render(<PanelObjetivo objetivo={objetivo()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copiar las coordenadas del objetivo' }));
    expect(escribirEnPortapapeles).toHaveBeenCalledWith('-34.604120, -58.381700');
    expect(await screen.findByText('Copiado')).toBeInTheDocument();
  });

  it('si el navegador no deja copiar, lo dice en vez de fingir', async () => {
    escribirEnPortapapeles.mockRejectedValue(new Error('sin permiso'));
    render(<PanelObjetivo objetivo={objetivo()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copiar las coordenadas del objetivo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No se pudieron copiar/);
    expect(screen.queryByText('Copiado')).not.toBeInTheDocument();
  });

  // La app manda null en vez de NaN cuando no pudo estimar la velocidad o el
  // rumbo: antes el panel tiraba un TypeError y la consola quedaba en blanco.
  it('sin velocidad ni rumbo estimados (null de la app) muestra la raya y no se rompe', () => {
    render(<PanelObjetivo objetivo={objetivo({ speedMs: null, courseDeg: null })} />);
    expect(valor('Velocidad')).toHaveTextContent('—');
    expect(valor('Rumbo')).toHaveTextContent('—');
    expect(screen.getByTestId('coordenadas-objetivo')).toHaveTextContent('-34.604120, -58.381700');
  });

  it('una posición rota no se ofrece para copiar', () => {
    render(<PanelObjetivo objetivo={objetivo({ lat: 0, lon: 0 })} />);
    expect(screen.getByText('Sin posición estimada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copiar/ })).not.toBeInTheDocument();
  });
});
