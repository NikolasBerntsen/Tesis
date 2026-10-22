/**
 * El DNI argentino, del lado de la consola. La regla es la misma que aplica el
 * backend (backend/src/dni.ts, normalizarDni) y está repetida a propósito:
 * validar acá le ahorra al admin un viaje al servidor para enterarse de un
 * error de tipeo, pero el que decide sigue siendo el backend.
 */

/**
 * Lleva lo que se tipeó a su forma canónica —solo dígitos y sin ceros a la
 * izquierda—, o devuelve null si no es un DNI. Se aceptan los puntos y los
 * espacios con que figura en el documento; cualquier otro carácter lo
 * invalida, para no convertir un error de tipeo en el DNI de otra persona.
 *
 * Los ceros se sacan porque no cambian el número: "05.123.456" es el
 * 5.123.456 escrito como aparece adentro del CUIL, y es el mismo que el
 * backend ya tiene guardado sin el cero. Válido es de 7 u 8 dígitos YA SIN
 * esos ceros, así que un "00000000" no pasa.
 */
export function normalizarDni(texto: string): string | null {
  const digitos = texto.replace(/[.\s]/g, '');
  if (!/^\d+$/.test(digitos)) return null;
  const canonico = digitos.replace(/^0+/, '');
  return /^\d{7,8}$/.test(canonico) ? canonico : null;
}

/** Lo que se le dice a quien lo tipeó mal. */
export const AYUDA_DNI = 'El DNI tiene que tener 7 u 8 dígitos (con o sin puntos).';

/**
 * El DNI como se lee en el documento: 30.123.456. Vacío si la cuenta no lo
 * tiene, que quien muestra decide cómo pintar. Se arma por grupos de tres desde
 * la derecha en vez de con toLocaleString, que depende del idioma del
 * navegador y en uno en inglés pondría comas.
 *
 * Los ceros a la izquierda se sacan antes de agrupar, igual que al guardar: un
 * backend que todavía no migró sus datos podría mandar "05123456", y mostrarlo
 * como "05.123.456" haría creer que es otro DNI que el 5.123.456 de al lado.
 */
export function formatearDni(dni: string | undefined): string {
  const canonico = (dni ?? '').replace(/^0+/, '');
  const grupos: string[] = [];
  for (let fin = canonico.length; fin > 0; fin -= 3) grupos.unshift(canonico.slice(Math.max(0, fin - 3), fin));
  return grupos.join('.');
}
