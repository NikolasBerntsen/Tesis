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

    // Antes un dron encima de un objetivo decía PATRULLANDO, igual que uno
    // haciendo la ronda: en una grilla de cámaras no se distinguía cuál mirar.
    it('ORBITANDO en oro con el dron sobre el objetivo', () => {
      renderTile({ status: makeStatus({ state: 'ORBITING' }) });
      expect(screen.getByText('ORBITANDO')).toHaveClass('esquina-oro');
    });

    it('SIGUIENDO en oro, con su propio rótulo, cuando el objetivo se mueve', () => {
      renderTile({ status: makeStatus({ state: 'FOLLOWING' }) });
      expect(screen.getByText('SIGUIENDO')).toHaveClass('esquina-oro');
      expect(screen.queryByText('PATRULLANDO')).not.toBeInTheDocument();
    });

    it('EN TIERRA si el dron informa que está en el suelo, aunque el estado sea de vuelo', () => {
      renderTile({ status: makeStatus({ state: 'PAUSED', flying: false }) });
      expect(screen.getByText('EN TIERRA')).toBeInTheDocument();
    });

    it('el control manual se lee aunque el dron esté apoyado', () => {
      renderTile({ status: makeStatus({ state: 'MANUAL', flying: false }) });
      expect(screen.getByText('CONTROL MANUAL')).toBeInTheDocument();
    });
  });

  describe('estado del mosaico', () => {
    it.each([
      ['ORBITING', 'Orbitando objetivo'],
      ['FOLLOWING', 'Siguiendo objetivo'],
    ])('%s va resaltado en oro', (state, etiqueta) => {
      renderTile({ status: makeStatus({ state }) });
      expect(screen.getByText(etiqueta)).toHaveClass('accent');
    });

    it('patrullando no se resalta', () => {
      renderTile({ status: makeStatus({ state: 'PATROLLING' }) });
      expect(screen.getByText('Patrullando')).toHaveClass('muted');
    });
  });

  describe('video y datos', () => {
    it('muestra el frame como imagen base64 cuando hay señal', () => {
      renderTile({ frame: 'AAAA', drone: makeDrone({ displayName: 'Bravo' }) });
      const img = screen.getByAltText('Video de Bravo') as HTMLImageElement;
      expect(img.src).toContain('data:image/jpeg;base64,AAAA');
    });

    it('encuadra la cámara en el visor negro, el mismo de la captura de una alerta', () => {
      renderTile({ frame: 'AAAA' });
      expect(document.querySelector('.visor.tile-video .visor-cuadro img.video')).toBeInTheDocument();
    });

    it('dice "En vivo" sólo con imagen y con señal: sin ellas no hay nada en vivo', () => {
      renderTile({ frame: 'AAAA' });
      expect(screen.getByText('En vivo')).toHaveClass('visor-vivo');
    });

    it('sin imagen no dice "En vivo"', () => {
      renderTile({ frame: null });
      expect(screen.queryByText('En vivo')).not.toBeInTheDocument();
    });

    it('con la señal perdida no dice "En vivo": el cuadro que queda es viejo', () => {
      renderTile({ frame: 'AAAA', status: makeStatus({ signal: 'LOST' }) });
      expect(screen.queryByText('En vivo')).not.toBeInTheDocument();
    });

    it('la batería también va en una barra, del ancho del nivel y teñida como la cifra', () => {
      const { container } = render(
        <CameraTile
          drone={makeDrone()}
          status={makeStatus({ battery: 32.4 })}
          frame={null}
          pendingAlerts={0}
          onOpen={vi.fn()}
          onRename={vi.fn()}
        />,
      );
      const barra = container.querySelector('.medidor.barra') as HTMLElement;
      // Es dibujo: la cifra de al lado ya lo dice.
      expect(barra).toHaveAttribute('aria-hidden', 'true');
      const relleno = barra.querySelector('.medidor-relleno') as HTMLElement;
      expect(relleno).toHaveClass('warn');
      expect(relleno.style.width).toBe('32.4%');
      expect(screen.getByText('32%')).toHaveClass('warn');
    });

    it('sin estado no dibuja la barra de batería', () => {
      renderTile({ status: null });
      expect(document.querySelector('.medidor.barra')).toBeNull();
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
      expect(screen.getByText('Alertas')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('no muestra contador de alertas cuando es 0', () => {
      renderTile({ pendingAlerts: 0 });
      expect(screen.queryByText(/^alertas$/i)).not.toBeInTheDocument();
    });
  });

  it('abrir el detalle es un botón de verdad, con nombre accesible', async () => {
    const props = renderTile({ frame: null });

    // Antes era un onClick colgado del div del mosaico: con teclado no había
    // forma de abrirlo. Ahora es un <button> estirado por CSS sobre el mosaico.
    const abrir = screen.getByRole('button', { name: `Ver detalle de ${props.drone.displayName}` });
    expect(abrir.tagName).toBe('BUTTON');

    await userEvent.click(abrir);
    expect(props.onOpen).toHaveBeenCalled();
  });

  it('se abre con el teclado, sin manejadores propios', async () => {
    const props = renderTile({ frame: null });
    const abrir = screen.getByRole('button', { name: `Ver detalle de ${props.drone.displayName}` });

    abrir.focus();
    expect(abrir).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenCalledTimes(1);

    await userEvent.keyboard(' ');
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it('renombrar no abre el detalle: el control de nombre no está dentro del botón', async () => {
    const props = renderTile({ frame: null });
    const abrir = screen.getByRole('button', { name: `Ver detalle de ${props.drone.displayName}` });
    const renombrar = screen.getByRole('button', { name: 'Renombrar dron' });

    // Un <button> no puede contener controles: si el de renombrar quedara
    // adentro del de abrir, el marcado sería inválido y el teclado se rompería.
    expect(abrir.contains(renombrar)).toBe(false);

    await userEvent.click(renombrar);
    expect(props.onOpen).not.toHaveBeenCalled();
  });
});
