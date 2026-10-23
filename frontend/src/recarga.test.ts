import { describe, expect, it, vi } from 'vitest';
import { crearRecarga } from './recarga';

/** Un pedido que el test contesta cuando quiere: así se cruza con lo que llega en vivo. */
function pedidoDemorado<T>() {
  let contestar: (valor: T) => void = () => {};
  let fallar: (motivo: unknown) => void = () => {};
  const promesa = new Promise<T>((ok, mal) => {
    contestar = ok;
    fallar = mal;
  });
  return { pedir: () => promesa, contestar, fallar };
}

describe('crearRecarga', () => {
  it('aplica la respuesta con los ids que llegaron en vivo mientras el pedido iba y volvía', async () => {
    const recarga = crearRecarga();
    const pedido = pedidoDemorado<string[]>();
    const aplicar = vi.fn();
    recarga.anotar(1); // Antes del pedido: la lista ya lo tiene en cuenta.
    const enCurso = recarga.recargar(pedido.pedir, aplicar);
    recarga.anotar(5);
    recarga.anotar(6);
    pedido.contestar(['lista']);
    await enCurso;
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(aplicar).toHaveBeenCalledWith(['lista'], new Set([5, 6]));

    // Después de la respuesta ya no anota nada: el próximo pedido arranca de cero.
    recarga.anotar(7);
    const otro = pedidoDemorado<string[]>();
    const siguiente = recarga.recargar(otro.pedir, aplicar);
    otro.contestar([]);
    await siguiente;
    expect(aplicar).toHaveBeenLastCalledWith([], new Set());
  });

  it('tira la respuesta de un pedido si salió otro después, aunque llegue última', async () => {
    const recarga = crearRecarga();
    const viejo = pedidoDemorado<string>();
    const nuevo = pedidoDemorado<string>();
    const aplicar = vi.fn();
    const primero = recarga.recargar(viejo.pedir, aplicar);
    recarga.anotar(3);
    const segundo = recarga.recargar(nuevo.pedir, aplicar);
    recarga.anotar(4);

    nuevo.contestar('nueva');
    await segundo;
    // Lo anotado para el viejo no viaja con el nuevo: el hub lo armó después.
    expect(aplicar).toHaveBeenCalledWith('nueva', new Set([4]));

    viejo.contestar('vieja');
    await primero;
    expect(aplicar).toHaveBeenCalledTimes(1);
  });

  it('un pedido viejo que vuelve antes que el nuevo tampoco se aplica, ni corta lo que anota el nuevo', async () => {
    const recarga = crearRecarga();
    const viejo = pedidoDemorado<string>();
    const nuevo = pedidoDemorado<string>();
    const aplicar = vi.fn();
    const primero = recarga.recargar(viejo.pedir, aplicar);
    const segundo = recarga.recargar(nuevo.pedir, aplicar);
    viejo.contestar('vieja');
    await primero;
    recarga.anotar(8);
    nuevo.contestar('nueva');
    await segundo;
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(aplicar).toHaveBeenCalledWith('nueva', new Set([8]));
  });

  it('si el pedido falla, el rechazo sube, no se aplica nada y deja de anotar', async () => {
    const recarga = crearRecarga();
    const pedido = pedidoDemorado<string>();
    const aplicar = vi.fn();
    const enCurso = recarga.recargar(pedido.pedir, aplicar);
    pedido.fallar(new Error('sin red'));
    await expect(enCurso).rejects.toThrow('sin red');
    expect(aplicar).not.toHaveBeenCalled();

    recarga.anotar(9);
    const otro = pedidoDemorado<string>();
    const siguiente = recarga.recargar(otro.pedir, aplicar);
    otro.contestar('ok');
    await siguiente;
    expect(aplicar).toHaveBeenCalledWith('ok', new Set());
  });
});
