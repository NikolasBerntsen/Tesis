/**
 * El DNI argentino, del lado de la consola. La regla es la misma que aplica el
 * backend (store.ts, normalizarDni) y está repetida a propósito: validar acá
 * le ahorra al admin un viaje al servidor para enterarse de un error de
 * tipeo, pero el que decide sigue siendo el backend.
 */

/**
 * Lleva lo que se tipeó a solo dígitos, o devuelve null si no es un DNI. Se
 * aceptan los puntos y los espacios con que figura en el documento; cualquier
 * otro carácter lo invalida, para no convertir un error de tipeo en el DNI de
 * otra persona. Válido es de 7 u 8 dígitos.
 */
export function normalizarDni(texto: string): string | null {
  const digitos = texto.replace(/[.\s]/g, '');
  return /^\d{7,8}$/.test(digitos) ? digitos : null;
}

/** Lo que se le dice a quien lo tipeó mal. */
export const AYUDA_DNI = 'El DNI tiene que tener 7 u 8 dígitos (con o sin puntos).';

/**
 * El DNI como se lee en el documento: 30.123.456. Vacío si la cuenta no lo
 * tiene, que quien muestra decide cómo pintar. Se arma por grupos de tres desde
 * la derecha en vez de con toLocaleString, que depende del idioma del
 * navegador y en uno en inglés pondría comas.
 */
export function formatearDni(dni: string | undefined): string {
  if (!dni) return '';
  const grupos: string[] = [];
  for (let fin = dni.length; fin > 0; fin -= 3) grupos.unshift(dni.slice(Math.max(0, fin - 3), fin));
  return grupos.join('.');
}
