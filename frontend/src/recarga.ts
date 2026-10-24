/**
 * Una lista que se trae por REST al montar y en cada reconexión, y que de ahí
 * en más mantiene el WebSocket (los relevos y las emergencias, RELEVOS §6).
 *
 * Los dos caminos no llegan en orden: el hub puede armar la respuesta, mandar
 * después un `relay_updated` de un relevo nuevo, y que el WebSocket le gane a
 * la respuesta. Esa lista no nombra al relevo nuevo, y no porque haya
 * terminado. Y como el pedido sale en cada cambio de `conectado` (al caerse y
 * al volver), dos pueden cruzarse y el viejo llegar último. La recarga se
 * acuerda de las dos cosas:
 *
 * - Sólo se aplica la respuesta del último pedido: la de uno anterior se tira.
 * - Mientras el pedido va y vuelve, anota los ids que trajo el WebSocket, y
 *   eso es lo que recibe `aplicar`: la lista no puede dar por terminado a
 *   ninguno de ellos. Si de verdad terminaron, su propio mensaje lo dirá.
 */
export interface Recarga {
  /** Un id que llegó por el WebSocket: si hay un pedido en vuelo, la respuesta no lo puede borrar. */
  anotar(id: number): void;
  /**
   * Pide la lista y, si cuando vuelve no salió otro pedido después, la aplica
   * junto con los ids que llegaron en vivo mientras tanto. El rechazo del
   * pedido sube: lo atiende quien llama.
   */
  recargar<T>(pedir: () => Promise<T>, aplicar: (lista: T, vistosEnVivo: ReadonlySet<number>) => void): Promise<void>;
}

export function crearRecarga(): Recarga {
  /** El número del último pedido que salió. */
  let ultimo = 0;
  /** Lo que llegó en vivo desde que salió el último pedido; `null` si no hay ninguno en vuelo. */
  let vistos: Set<number> | null = null;
  return {
    anotar(id) {
      vistos?.add(id);
    },
    async recargar(pedir, aplicar) {
      ultimo += 1;
      const numero = ultimo;
      // Uno nuevo por pedido: lo anotado para uno anterior no sirve para este,
      // que el hub arma DESPUÉS de esos mensajes y ya los tiene en cuenta.
      const anotados = new Set<number>();
      vistos = anotados;
      try {
        const lista = await pedir();
        if (numero === ultimo) aplicar(lista, anotados);
      } finally {
        if (numero === ultimo) vistos = null;
      }
    },
  };
}
