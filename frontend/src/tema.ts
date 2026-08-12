/**
 * Modo claro / oscuro. El tema se guarda por navegador y arranca siguiendo la
 * preferencia del sistema: quien ya eligió oscuro en su máquina no tiene por
 * qué volver a elegirlo acá.
 */
export type Tema = 'claro' | 'oscuro';

const CLAVE = 'cc_tema';

function preferenciaDelSistema(): Tema {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro';
}

export function temaGuardado(): Tema {
  const v = localStorage.getItem(CLAVE);
  return v === 'claro' || v === 'oscuro' ? v : preferenciaDelSistema();
}

/** Escribe el atributo que leen los tokens del CSS y recuerda la elección. */
export function aplicarTema(tema: Tema): void {
  document.documentElement.dataset.tema = tema;
  localStorage.setItem(CLAVE, tema);
}

export function alternarTema(actual: Tema): Tema {
  return actual === 'oscuro' ? 'claro' : 'oscuro';
}
