import { useState } from 'react';

// Los íconos son SVG de trazo que heredan el color del botón: el tema no
// admite glifos sueltos (✎ ✓ ✕) porque no siguen el peso del resto del dibujo.
const ICONO = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Nombre visible del dron con edición en línea (PATCH /api/drones/:droneId). */
export default function EditableName({
  name,
  onRename,
}: {
  name: string;
  onRename: (displayName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  if (!editing) {
    return (
      <span className="editable-name">
        <strong className="inscripcion">{name}</strong>
        <button
          className="icon"
          title="Renombrar dron"
          aria-label="Renombrar dron"
          onClick={(e) => {
            e.stopPropagation();
            setValue(name);
            setEditing(true);
          }}
        >
          <svg {...ICONO}>
            <path d="M11.9 2.6 13.4 4.1 5 12.5 2.9 13.1 3.5 11z" />
            <path d="M10.4 4.1 11.9 5.6" />
          </svg>
        </button>
      </span>
    );
  }

  const save = () => {
    const clean = value.trim();
    if (clean && clean !== name) onRename(clean);
    setEditing(false);
  };

  return (
    <span className="editable-name" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        maxLength={40}
        aria-label="Nombre del dron"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className="icon" title="Guardar" aria-label="Guardar" onClick={save}>
        <svg {...ICONO}>
          <path d="M3.2 8.4 6.3 11.5 12.8 5" />
        </svg>
      </button>
      <button className="icon" title="Cancelar" aria-label="Cancelar" onClick={() => setEditing(false)}>
        <svg {...ICONO}>
          <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
        </svg>
      </button>
    </span>
  );
}
