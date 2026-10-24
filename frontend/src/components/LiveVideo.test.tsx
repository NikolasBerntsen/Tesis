import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LiveVideo from './LiveVideo';

describe('LiveVideo', () => {
  it('muestra el frame como imagen cuando hay señal', () => {
    render(<LiveVideo frame="ZZZ" />);
    const img = screen.getByAltText('Transmisión del dron') as HTMLImageElement;
    expect(img.src).toContain('data:image/jpeg;base64,ZZZ');
  });

  it('muestra el placeholder cuando no hay frame', () => {
    render(<LiveVideo frame={null} />);
    expect(screen.getByText('Sin señal de video')).toBeInTheDocument();
  });

  it('encuadra el video en el visor negro, con las escuadras de una cámara', () => {
    const { container } = render(<LiveVideo frame="ZZZ" />);
    expect(container.querySelector('.visor > .visor-cuadro > img.video')).toBeInTheDocument();
  });

  it('dice "En vivo" sólo con imagen y con el enlace arriba: el último cuadro de un enlace caído es viejo', () => {
    const { rerender } = render(<LiveVideo frame="ZZZ" />);
    expect(screen.getByText('En vivo')).toHaveClass('visor-vivo');

    rerender(<LiveVideo frame="ZZZ" senalPerdida />);
    expect(screen.queryByText('En vivo')).not.toBeInTheDocument();

    rerender(<LiveVideo frame={null} />);
    expect(screen.queryByText('En vivo')).not.toBeInTheDocument();
  });

  it('el título lleva el ícono de la cámara, oculto al lector', () => {
    render(<LiveVideo frame={null} />);
    const titulo = screen.getByRole('heading', { name: 'Video en vivo' });
    expect(titulo.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
