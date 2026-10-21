import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AlertaEnCurso from './AlertaEnCurso';
import { makeAlert } from '../test/fixtures';

function montar(props: Partial<Parameters<typeof AlertaEnCurso>[0]> = {}) {
  const todas = {
    alerta: makeAlert({ id: 7, type: 'VEHICLE', snapshot: 'QUFB' }),
    otrasPendientes: 0,
    siguiendo: false,
    onDecidir: vi.fn(),
    ...props,
  };
  render(<AlertaEnCurso {...todas} />);
  return todas;
}

describe('AlertaEnCurso', () => {
  it('muestra la captura, el tipo y la hora de la alerta', () => {
    montar();
    expect(screen.getByRole('heading', { name: 'Alerta en curso' })).toBeInTheDocument();
    expect(screen.getByText('VEHÍCULO')).toHaveClass('badge', 'vehicle');
    expect(screen.getByAltText('Captura que disparó la detección')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,QUFB',
    );
    expect(screen.getByRole('region', { name: 'Alerta en curso' })).toBeInTheDocument();
  });

  it('sin captura lo dice en lugar de dejar un hueco', () => {
    montar({ alerta: makeAlert({ snapshot: null }) });
    expect(screen.getByText('La alerta llegó sin captura')).toBeInTheDocument();
  });

  it('valida y descarta con el id de la alerta', async () => {
    const { onDecidir } = montar();
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(onDecidir).toHaveBeenCalledWith(7, 'VALIDATED');
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onDecidir).toHaveBeenCalledWith(7, 'DISMISSED');
  });

  it('dice qué le hace cada botón al dron antes de apretarlo', () => {
    montar();
    expect(screen.getByText(/Descartar: retoma la ruta hacia el próximo nodo/)).toBeInTheDocument();
  });

  it('si el backend rechaza la decisión, el motivo queda a la vista', async () => {
    const onDecidir = vi.fn().mockRejectedValue(new Error('Esta alerta ya la decidió otro operador.'));
    montar({ onDecidir });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Esta alerta ya la decidió otro operador.');
  });

  it('un rechazo que no es un Error también se muestra', async () => {
    montar({ onDecidir: vi.fn().mockRejectedValue('el backend no contestó') });
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('el backend no contestó');
  });

  it('el motivo se limpia al volver a intentar', async () => {
    const onDecidir = vi.fn().mockRejectedValueOnce(new Error('falló')).mockResolvedValueOnce(undefined);
    montar({ onDecidir });
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('falló');
    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('mientras la decisión viaja los botones no aceptan un segundo click', async () => {
    let terminar: () => void = () => {};
    const onDecidir = vi.fn(() => new Promise<void>((r) => (terminar = r)));
    montar({ onDecidir });

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    expect(screen.getByRole('button', { name: 'Validar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeDisabled();

    terminar();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Validar' })).toBeEnabled());
    expect(onDecidir).toHaveBeenCalledTimes(1);
  });

  it('con el dron sobre este objetivo, lo dice', () => {
    montar({ siguiendo: true });
    expect(screen.getByText(/El dron está sobre este objetivo/)).toBeInTheDocument();
  });

  it('avisa si el dron tiene más alertas sin decidir, en singular y en plural', () => {
    const { rerender } = render(
      <AlertaEnCurso alerta={makeAlert({ id: 1 })} otrasPendientes={1} siguiendo={false} onDecidir={vi.fn()} />,
    );
    expect(screen.getByText('Este dron tiene otra alerta sin decidir: está en la campana.')).toBeInTheDocument();

    rerender(<AlertaEnCurso alerta={makeAlert({ id: 1 })} otrasPendientes={3} siguiendo={false} onDecidir={vi.fn()} />);
    expect(screen.getByText('Este dron tiene otras 3 alertas sin decidir: están en la campana.')).toBeInTheDocument();
  });
});
