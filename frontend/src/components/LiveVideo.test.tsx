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

  it('encuadra el video en un marco de mármol con filo dorado', () => {
    const { container } = render(<LiveVideo frame="ZZZ" />);
    expect(container.querySelector('.hueco.filo-oro img.video')).toBeInTheDocument();
  });
});
