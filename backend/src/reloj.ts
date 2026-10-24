/**
 * El reloj del hub: milisegundos desde el epoch. Todo lo que vence en los
 * relevos (los 10 s de respuesta de B, los 120 s del despegue, los 30 s del
 * traspaso, los 20 s de un B desconectado) y la vigencia de un status se miden
 * con esto, nunca con el `ts` de un teléfono, que no está sincronizado.
 *
 * Es un objeto con una función y no una función suelta para que las pruebas lo
 * puedan reemplazar por uno que avanza a mano: así un plazo de 120 s se prueba
 * en un instante y sin esperar nada.
 */
export const relojDelHub = {
  ahora: (): number => Date.now(),
};
