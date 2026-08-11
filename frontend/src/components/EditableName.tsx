import { useState } from 'react';

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
        <strong>{name}</strong>
        <button
          className="icon"
          title="Renombrar dron"
          onClick={(e) => {
            e.stopPropagation();
            setValue(name);
            setEditing(true);
          }}
        >
          ✎
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
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className="icon" title="Guardar" onClick={save}>
        ✓
      </button>
      <button className="icon" title="Cancelar" onClick={() => setEditing(false)}>
        ✕
      </button>
    </span>
  );
}
