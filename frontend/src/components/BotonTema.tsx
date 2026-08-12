import { useState } from 'react';
import { alternarTema, aplicarTema, temaGuardado, type Tema } from '../tema';

const SOL = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
  </svg>
);

const LUNA = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z" />
  </svg>
);

/**
 * Alterna entre la piedra clara y la obsidiana. El ícono muestra a dónde se va
 * al tocarlo, no dónde se está: es lo que la gente espera de este control.
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
      {vaAOscuro ? LUNA : SOL}
    </button>
  );
}
