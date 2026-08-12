import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CameraTile from './CameraTile';
import { makeDrone, makeStatus } from '../test/fixtures';

function renderTile(props: Partial<Parameters<typeof CameraTile>[0]> = {}) {
  const base = {
    drone: makeDrone(),
    status: makeStatus(),
    frame: null as string | null,
    pendingAlerts: 0,
    onOpen: vi.fn(),
    onRename: vi.fn(),
  };
  const merged = { ...base, ...props };
  render(<CameraTile {...merged} />);
  return merged;
}

describe('CameraTile', () => {
  describe('overlay de estado alterado', () => {
    it('muestra "SEÑAL PERDIDA" cuando se perdió la señal', () => {
      renderTile({ status: makeStatus({ signal: 'LOST' }) });
      expect(screen.getByText('SEÑAL PERDIDA')).toBeInTheDocument();
    });

    it('la señal perdida tiene prioridad sobre la batería baja', () => {
      renderTile({ status: makeStatus({ signal: 'LOST', battery: 5 }) });
      expect(screen.getByText('SEÑAL PERDIDA')).toBeInTheDocument();
      expect(screen.queryByText('BATERÍA BAJA')).not.toBeInTheDocument();
    });

    it('muestra "BATERÍA BAJA" con batería <= 25%', () => {
      renderTile({ status: makeStatus({ battery: 20 }) });
      expect(screen.getByText('BATERÍA BAJA')).toBeInTheDocument();
    });

    it('muestra "BATERÍA BAJA" en estado RETURNING_HOME_BATTERY aunque la batería sea alta', () => {
      renderTile({ status: makeStatus({ battery: 90, state: 'RETURNING_HOME_BATTERY' }) });
      expect(screen.getByText('BATERÍA BAJA')).toBeInTheDocument();
    });

    it('el aviso de falla va engrosado para que no se lea tenue sobre la imagen', () => {
      renderTile({ status: makeStatus({ signal: 'LOST' }) });
      expect(screen.getByText('SEÑAL PERDIDA').tagName).toBe('STRONG');
    });

    it('no muestra overlay en estado normal', () => {
      renderTile({ status: makeStatus() });
      expect(screen.queryByText('SEÑAL PERDIDA')).not.toBeInTheDocument();
      expect(screen.queryByText('BATERÍA BAJA')).not.toBeInTheDocument();
    });
  });

  describe('texto de la esquina', () => {
    it('CONTROL MANUAL en verde cuando el dron está en manual', () => {
      renderTile({ status: makeStatus({ state: 'MANUAL' }) });
      const esquina = screen.getByText('CONTROL MANUAL');
      expect(esquina).toHaveClass('esquina-verde');
    });

    it('EN TIERRA (gris) cuando está IDLE', () => {
      renderTile({ status: makeStatus({ state: 'IDLE' }) });
      expect(screen.getByText('EN TIERRA')).toHaveClass('esquina-gris');
    });

    it('EN TIERRA cuando está LANDED', () => {
      renderTile({ status: makeStatus({ state: 'LANDED' }) });
      expect(screen.getByText('EN TIERRA')).toBeInTheDocument();
    });

    it('EN TIERRA cuando no hay estado', () => {
      renderTile({ status: null });
      expect(screen.getByText('EN TIERRA')).toBeInTheDocument();
    });

    it('PATRULLANDO (gris) en cualquier otro estado en vuelo', () => {
      renderTile({ status: makeStatus({ state: 'PATROLLING' }) });
      expect(screen.getByText('PATRULLANDO')).toHaveClass('esquina-gris');
    });
  });

  describe('video y datos', () => {
    it('muestra el frame como imagen base64 cuando hay señal', () => {
      renderTile({ frame: 'AAAA', drone: makeDrone({ displayName: 'Bravo' }) });
      const img = screen.getByAltText('Video de Bravo') as HTMLImageElement;
      expect(img.src).toContain('data:image/jpeg;base64,AAAA');
    });

    it('encuadra la cámara en un marco de mármol con filo dorado', () => {
      renderTile({ frame: 'AAAA' });
      expect(document.querySelector('.hueco.filo-oro .tile-video img.video')).toBeInTheDocument();
    });

    it('muestra el placeholder sin señal de video', () => {
      renderTile({ frame: null });
      expect(screen.getByText('Sin señal de video')).toBeInTheDocument();
    });

    it('muestra batería y señal con su porcentaje', () => {
      renderTile({ status: makeStatus({ battery: 77.6, signalPct: 88 }) });
      expect(screen.getByText('78%')).toBeInTheDocument();
      expect(screen.getByText('88%')).toBeInTheDocument();
    });

    it('muestra guiones cuando no hay estado', () => {
      renderTile({ status: null });
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('Sin estado')).toBeInTheDocument();
    });

    it('muestra el contador de alertas pendientes cuando hay', () => {
      renderTile({ pendingAlerts: 3 });
      expect(screen.getByText('Alertas pendientes')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('no muestra contador de alertas cuando es 0', () => {
      renderTile({ pendingAlerts: 0 });
      expect(screen.queryByText(/alertas pendientes/i)).not.toBeInTheDocument();
    });
  });

  it('llama onOpen al clickear el tile', async () => {
    const props = renderTile({ frame: null });
    await userEvent.click(screen.getByText('Sin señal de video'));
    expect(props.onOpen).toHaveBeenCalled();
  });
});
