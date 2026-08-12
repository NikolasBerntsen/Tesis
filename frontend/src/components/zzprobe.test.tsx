import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LogDetailModal from './LogDetailModal';
import QrDronModal from './QrDronModal';
import { makeDrone, makeEvent } from '../test/fixtures';

vi.mock('leaflet', () => ({
  default: { divIcon: vi.fn(() => ({})), map: vi.fn(), tileLayer: vi.fn(), marker: vi.fn(), circle: vi.fn() },
}));
vi.mock('qrcode', () => ({ toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') }));
vi.mock('../api', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('../api')>()),
  api: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => vi.clearAllMocks());

describe('PROBE arrastrar desde adentro y soltar sobre el velo', () => {
  it('M: seleccionar texto del pop-up y soltar afuera lo cierra', async () => {
    const cerrar = vi.fn();
    render(<LogDetailModal fila={makeEvent({ message: 'un mensaje largo para seleccionar' })} onCerrar={cerrar} />);

    const caja = screen.getByRole('dialog');
    const velo = caja.parentElement!;
    const titulo = screen.getByRole('heading', { name: 'un mensaje largo para seleccionar' });

    // Arrastre: apretar sobre el título (adentro) y soltar sobre el velo (afuera)
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: titulo },
      { target: velo },
      { keys: '[/MouseLeft]', target: velo },
    ]);
    // eslint-disable-next-line no-console
    console.warn('M · pidió cerrar tras arrastrar hacia afuera:', cerrar.mock.calls.length);
  });

  it('N: lo mismo en el sticker del QR', async () => {
    const cerrar = vi.fn();
    render(<QrDronModal dron={makeDrone()} onCerrar={cerrar} />);
    const caja = screen.getByRole('dialog');
    const velo = caja.parentElement!;
    const titulo = screen.getByRole('heading');

    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: titulo },
      { target: velo },
      { keys: '[/MouseLeft]', target: velo },
    ]);
    // eslint-disable-next-line no-console
    console.warn('N · pidió cerrar tras arrastrar hacia afuera:', cerrar.mock.calls.length);
  });
});
