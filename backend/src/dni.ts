/**
 * El DNI argentino y su ÚNICA forma guardada. Vive aparte de store.ts porque lo
 * usan dos lados que no pueden importarse entre sí: la API, al validar lo que
 * tipea el admin, y la migración de db.ts, que lleva a esta misma forma los
 * DNI que ya estaban guardados (store.ts importa db.ts, no al revés).
 *
 * La consola repite la regla en frontend/src/dni.ts: si cambia acá, cambia allá.
 */

/**
 * Lleva un DNI a su forma canónica —solo dígitos y sin ceros a la izquierda—,
 * o devuelve null si no es uno válido.
 *
 * - Se aceptan los puntos y los espacios con que la gente lo escribe
 *   ("30.123.456") porque así figura en el documento; cualquier otro carácter
 *   lo invalida en vez de descartarse, para no convertir un error de tipeo en
 *   el DNI de otra persona.
 * - Los ceros a la izquierda se sacan porque no cambian el número: "05123456"
 *   es el 5.123.456 escrito como aparece adentro del CUIL. Guardar las dos
 *   formas por separado dejaba a una misma persona con dos cuentas vivas —el
 *   índice único y el chequeo de la API comparan texto, y "5123456" no es
 *   "05123456"— y el buscador no la encontraba por la otra forma.
 * - Válido es de 7 u 8 dígitos YA SIN los ceros: los de 7 son los de las
 *   personas mayores, y un "00000000" no es el DNI de nadie.
 *
 * Solo se acepta texto: un número de JSON como 3012345.6 pasaría a "30123456"
 * al sacarle el punto, y ese no es el DNI que nadie escribió.
 */
export function normalizarDni(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const digitos = valor.replace(/[.\s]/g, '');
  if (!/^\d+$/.test(digitos)) return null;
  const canonico = digitos.replace(/^0+/, '');
  return /^\d{7,8}$/.test(canonico) ? canonico : null;
}

/**
 * Lo que se tipeó en el buscador, llevado a la forma en que se guardan los
 * DNI, para compararlo como substring: sin puntos ni espacios y sin ceros a la
 * izquierda, así "05.123" encuentra al 5.123.456. Sacarle los ceros a una
 * búsqueda parcial sólo puede ampliarla —"0456" pasa a "456", que está adentro
 * de todo lo que contenía "0456"—, nunca dejar afuera a quien se buscaba.
 *
 * Una búsqueda hecha SOLO de ceros ("0", "00", "0.0") se deja como está: sin
 * ceros quedaba vacía, y una búsqueda vacía no encuentra ningún DNI, cuando
 * "0" tiene que encontrar a todos los que tienen un cero adentro (un DNI
 * canónico nunca empieza con cero, pero los tiene en el medio).
 */
export function dniParaBuscar(q: string): string {
  const digitos = q.replace(/[.\s]/g, '');
  const sinCeros = digitos.replace(/^0+/, '');
  return sinCeros === '' ? digitos : sinCeros;
}
