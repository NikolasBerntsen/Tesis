import { useState } from 'react';
import { alternarTema, aplicarTema, temaGuardado, type Tema } from '../tema';
import { IconoLuna, IconoSol } from './Iconos';

/**
 * Alterna entre el mármol de día y la piedra negra de noche. El ícono muestra
 * a dónde se va al tocarlo, no dónde se está: es lo que la gente espera de
 * este control.
 */
export default function BotonTema() {
  const [tema, setTema] = useState<Tema>(() => temaGuardado());

  function cambiar() {
    const nuevo = alternarTema(tema);
    aplicarTema(nuevo);
    setTema(nuevo);
  }

  const vaAOscuro = tema === 'claro';
  return (
    <button
      type="button"
      className="icono-boton"
      onClick={cambiar}
      aria-label={vaAOscuro ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
      title={vaAOscuro ? 'Modo oscuro' : 'Modo claro'}
    >
      {vaAOscuro ? <IconoLuna /> : <IconoSol />}
    </button>
  );
}
