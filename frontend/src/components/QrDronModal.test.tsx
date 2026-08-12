import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QrDronModal from './QrDronModal';
import { makeDrone } from '../test/fixtures';

// El QR se dibuja en el navegador; acá alcanza con saber qué se le pidió dibujar.
const { generarQr } = vi.hoisted(() => ({ generarQr: vi.fn() }));
vi.mock('qrcode', () => ({ toDataURL: generarQr }));

const HASH = 'c54ae4a0aad98bdc6ae5ab810751335c';

function montar(over = {}) {
  const onCerrar = vi.fn();
  const dron = makeDrone({ hash: HASH, droneId: HASH, displayName: 'Alfa', model: 'DJI Mini 3', ...over });
  render(<QrDronModal dron={dron} onCerrar={onCerrar} />);
  return onCerrar;
}

beforeEach(() => {
  generarQr.mockReset();
  generarQr.mockResolvedValue('data:image/png;base64,QR');
});

describe('QrDronModal', () => {
  it('codifica únicamente el hash y deja el nombre y el modelo fuera del QR', async () => {
    montar();

    await waitFor(() => expect(generarQr).toHaveBeenCalled());
    // Ni JSON ni URL: el hash pelado es lo único que la app manda a /drones/pair.
    expect(generarQr.mock.calls[0][0]).toBe(HASH);

    const qr = await screen.findByAltText('Código QR de Alfa');
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(screen.getByText('Alfa', { selector: '.qr-sticker-nombre' })).toBeInTheDocument();
    expect(screen.getByText('DJI Mini 3')).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
  });

  it('no muestra la línea del modelo si el dron no tiene', async () => {
    montar({ model: '' });

    await screen.findByAltText('Código QR de Alfa');
    expect(document.querySelector('.qr-sticker-modelo')).toBeNull();
  });

  it('imprime el sticker con la hoja de impresión del navegador', async () => {
    const imprimir = vi.spyOn(window, 'print').mockImplementation(() => {});
    montar();

    const boton = await screen.findByRole('button', { name: 'Imprimir sticker' });
    await waitFor(() => expect(boton).toBeEnabled());
    await userEvent.click(boton);
    expect(imprimir).toHaveBeenCalledTimes(1);
    // Sin esta regla el sticker saldría en el papel detrás de la consola entera.
    expect(document.querySelector('style[media="print"]')?.textContent).toContain('.dashboard');
    imprimir.mockRestore();
  });

  it('no deja imprimir mientras el QR no está listo', () => {
    generarQr.mockReturnValue(new Promise(() => {}));
    montar();

    expect(screen.getByRole('button', { name: 'Imprimir sticker' })).toBeDisabled();
    expect(screen.getByText('Generando el código…')).toBeInTheDocument();
  });

  it('se cierra con el botón, con Escape y clickeando afuera', async () => {
    const onCerrar = montar();
    await screen.findByAltText('Código QR de Alfa');

    await userEvent.click(screen.getByRole('button', { name: 'Cerrar el sticker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onCerrar).toHaveBeenCalledTimes(4);
  });

  it('avisa si no se pudo generar el código', async () => {
    generarQr.mockRejectedValue(new Error('sin canvas'));
    montar();

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo generar el código QR');
    expect(screen.queryByAltText('Código QR de Alfa')).not.toBeInTheDocument();
  });
});
