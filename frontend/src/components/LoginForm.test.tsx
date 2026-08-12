import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginForm from './LoginForm';
import { login } from '../api';

vi.mock('../api', () => ({
  login: vi.fn(),
}));

const loginMock = vi.mocked(login);

describe('LoginForm', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it('deja el botón deshabilitado hasta que hay usuario y contraseña', async () => {
    render(<LoginForm onLogin={() => {}} />);
    const boton = screen.getByRole('button', { name: 'Ingresar' });
    expect(boton).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Usuario'), 'oper');
    expect(boton).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Contraseña'), 'secreta');
    expect(boton).toBeEnabled();
  });

  it('llama a login y avisa onLogin cuando las credenciales son válidas', async () => {
    loginMock.mockResolvedValue(undefined);
    const onLogin = vi.fn();
    render(<LoginForm onLogin={onLogin} />);

    await userEvent.type(screen.getByLabelText('Usuario'), 'oper');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'secreta');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(loginMock).toHaveBeenCalledWith('oper', 'secreta');
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
  });

  it('muestra el mensaje de error y no llama onLogin si login falla', async () => {
    loginMock.mockRejectedValue(new Error('Credenciales inválidas'));
    const onLogin = vi.fn();
    render(<LoginForm onLogin={onLogin} />);

    await userEvent.type(screen.getByLabelText('Usuario'), 'oper');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'mala');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));

    // El error se anuncia solo (role=alert): el foco se queda en el campo.
    expect(await screen.findByRole('alert')).toHaveTextContent('Credenciales inválidas');
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('arma la placa de ingreso: título, subtítulo y filigrana separadora', () => {
    const { container } = render(<LoginForm onLogin={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Comando Central' })).toBeInTheDocument();
    expect(screen.getByText('Sistema de patrullaje con drones')).toBeInTheDocument();
    expect(container.querySelector('.login-card .regla-ornamental')).not.toBeNull();
  });

  it('muestra un error genérico si lo lanzado no es un Error', async () => {
    loginMock.mockRejectedValue('boom');
    render(<LoginForm onLogin={() => {}} />);
    await userEvent.type(screen.getByLabelText('Usuario'), 'oper');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByText('Error de autenticación')).toBeInTheDocument();
  });
});
