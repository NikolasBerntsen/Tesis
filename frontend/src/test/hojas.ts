import { partirArriba } from './wcag';

/**
 * Lectura mínima de las hojas de estilo para los tests. jsdom no aplica el
 * CSS, así que lo que se puede fijar es el contrato: que la regla que pinta un
 * estado exista y use el token que el test de contraste mide. Sin esto, un par
 * medido puede pasar mientras la hoja pinta otra cosa.
 */

export interface Regla {
  /** Cada selector de la lista, con los espacios normalizados. */
  selectores: string[];
  cuerpo: string;
}

/**
 * Las reglas de una hoja, sin comentarios. Las de adentro de un `@media` se
 * leen igual que las de afuera: el bloque de la consulta no se distingue.
 */
export function reglas(css: string): Regla[] {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...limpio.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, lista, cuerpo]) => ({
    selectores: partirArriba(lista.trim(), ',').map((s) => s.replace(/\s+/g, ' ')),
    cuerpo,
  }));
}

/**
 * El valor de `propiedad` en la última regla que nombra `selector` tal cual
 * (la que gana en la cascada a igual especificidad), o null si ninguna lo
 * declara.
 */
export function valorDe(css: string, selector: string, propiedad: string): string | null {
  let valor: string | null = null;
  for (const regla of reglas(css)) {
    if (!regla.selectores.includes(selector)) continue;
    for (const declaracion of partirArriba(regla.cuerpo, ';')) {
      const i = declaracion.indexOf(':');
      if (declaracion.slice(0, i).trim() === propiedad) valor = declaracion.slice(i + 1).trim();
    }
  }
  return valor;
}
