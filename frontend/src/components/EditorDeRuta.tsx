import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { CENTRO_POR_DEFECTO, iconoBase, useFondo, vestirAtribucion } from '../mapa';
import type { PatrolRoute, Waypoint } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import Modal from './Modal';

/** Un nodo con identidad estable, para poder arrastrarlo sin que se confunda. */
interface Nodo extends Waypoint {
  clave: number;
}

let contador = 0;
const nuevoNodo = (lat: number, lon: number): Nodo => ({ lat, lon, alt: 40, clave: ++contador });

const NODO_NORMAL = '#9C3B30';
const NODO_ILUMINADO = '#F2C230';
const NODO_HECHO = '#4F7A46';

/**
 * Editor de rutas: se hacen clic los nodos sobre el mapa, se los edita y se los
 * reordena arrastrando. Antes de guardar hay un repaso que enciende los nodos
 * uno por uno en orden, que es la única forma de ver de verdad si el recorrido
 * quedó como uno lo pensó.
 */
export default function EditorDeRuta({
  ruta,
  base,
  onGuardar,
  onCerrar,
}: {
  ruta?: PatrolRoute | null;
  /** Si el editor se abrió desde una base, se la dibuja para tenerla de referencia. */
  base?: { name: string; lat: number; lon: number } | null;
  onGuardar: (datos: { name: string; description: string; waypoints: Waypoint[] }) => Promise<void>;
  onCerrar: () => void;
}) {
  const [nombre, setNombre] = useState(ruta?.name ?? '');
  const [descripcion, setDescripcion] = useState(ruta?.description ?? '');
  const [nodos, setNodos] = useState<Nodo[]>(
    () => (ruta?.waypoints ?? []).map((w) => ({ ...w, clave: ++contador })),
  );
  const [arrastrado, setArrastrado] = useState<number | null>(null);
  const [repasando, setRepasando] = useState(false);
  const [encendido, setEncendido] = useState(-1);
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);
  const alClic = useRef<(lat: number, lon: number) => void>(() => {});
  alClic.current = (lat, lon) => setNodos((ns) => [...ns, nuevoNodo(lat, lon)]);

  useEffect(() => {
    if (!caja.current || mapa.current) return;
    // Arranca donde el trabajo va a estar: el primer nodo si la ruta ya existe,
    // la base si el editor se abrió desde una, y si no el centro de la ciudad.
    const centro: L.LatLngTuple = nodos.length
      ? [nodos[0].lat, nodos[0].lon]
      : base
        ? [base.lat, base.lon]
        : CENTRO_POR_DEFECTO;
    const m = L.map(caja.current).setView(centro, 15);
    vestirAtribucion(m);
    m.on('click', (e: L.LeafletMouseEvent) => alClic.current(e.latlng.lat, e.latlng.lng));
    // La base va en su propia capa: no se borra con cada redibujo de los nodos.
    if (base) {
      L.marker([base.lat, base.lon], { icon: iconoBase() })
        .bindTooltip(base.name, { direction: 'top' })
        .addTo(m);
    }
    capa.current = L.layerGroup().addTo(m);
    mapa.current = m;
    setTimeout(() => m.invalidateSize(), 60);
    return () => {
      m.remove();
      mapa.current = null;
      capa.current = null;
    };
  }, []);

  const [fondo, setFondo] = useFondo(mapa);

  // Redibuja nodos y tramos. Durante el repaso, el color dice hasta dónde llegó.
  useEffect(() => {
    const grupo = capa.current;
    if (!grupo) return;
    grupo.clearLayers();
    if (nodos.length > 1) {
      L.polyline(nodos.map((n) => [n.lat, n.lon] as [number, number]), {
        color: '#8A6A1C',
        weight: 2,
        dashArray: '5 6',
      }).addTo(grupo);
    }
    nodos.forEach((n, i) => {
      const color = !repasando ? NODO_NORMAL : i < encendido ? NODO_HECHO : i === encendido ? NODO_ILUMINADO : NODO_NORMAL;
      L.circleMarker([n.lat, n.lon], {
        radius: i === encendido ? 12 : 8,
        color: '#14120F',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(`${i + 1}${n.label ? ` · ${n.label}` : ''}`, { permanent: true, direction: 'top' })
        .addTo(grupo);
    });
  }, [nodos, repasando, encendido]);

  // El repaso: un nodo por segundo, en orden.
  useEffect(() => {
    if (!repasando) return;
    if (encendido >= nodos.length) {
      setRepasando(false);
      return;
    }
    const id = setTimeout(() => setEncendido((n) => n + 1), 900);
    return () => clearTimeout(id);
  }, [repasando, encendido, nodos.length]);

  function mover(desde: number, hasta: number) {
    if (desde === hasta) return;
    setNodos((ns) => {
      const copia = [...ns];
      const [sacado] = copia.splice(desde, 1);
      copia.splice(hasta, 0, sacado);
      return copia;
    });
  }

  function editarNodo(i: number, campo: 'label' | 'alt', valor: string) {
    setNodos((ns) =>
      ns.map((n, j) => {
        if (j !== i) return n;
        if (campo === 'label') return { ...n, label: valor };
        const alt = Number(valor);
        return { ...n, alt: Number.isFinite(alt) ? alt : n.alt };
      }),
    );
  }

  async function guardar() {
    setError('');
    setGuardando(true);
    try {
      await onGuardar({
        name: nombre.trim(),
        description: descripcion.trim(),
        waypoints: nodos.map(({ clave, label, ...resto }) => (label?.trim() ? { ...resto, label: label.trim() } : resto)),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuardando(false);
    }
  }

  const completa = nombre.trim().length > 0 && nodos.length >= 2;

  return (
    <Modal etiquetadoPor="titulo-editor-ruta" ancho onCerrar={onCerrar}>
      <header className="modal-cabecera">
        <h2 className="modal-titulo" id="titulo-editor-ruta">
          {ruta ? `Editar ${ruta.name}` : 'Nueva ruta de patrullaje'}
        </h2>
        <button type="button" className="modal-cerrar" aria-label="Cerrar" onClick={onCerrar}>
          ×
        </button>
      </header>

      <div className="modal-cuerpo editor-ruta">
        {error && <p className="aviso malo">{error}</p>}

        <div className="fila-coords">
          <label>
            Nombre
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={60} />
          </label>
          <label>
            Descripción
            <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} maxLength={200} />
          </label>
        </div>

        <p className="muted">
          {repasando
            ? `Repasando el recorrido: nodo ${Math.min(encendido + 1, nodos.length)} de ${nodos.length}.`
            : 'Hacé clic en el mapa para agregar nodos. Arrastrá las filas para cambiar el orden.'}
        </p>

        <div className="editor-ruta-cuerpo">
          <div className="mapa-caja">
            <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
            <div className="mapa-elector" ref={caja} />
          </div>

          <div className="nodos-columna">
            {/* Encabezados: sin esto la altura era un 40 suelto que nadie tiene
                por qué saber qué significa. */}
            <div className="nodos-encabezado" aria-hidden="true">
              <span className="nodo-orden">#</span>
              <span>Apodo</span>
              <span>Altura (m)</span>
              <span className="nodo-coord">Coordenadas</span>
              <span className="nodos-encabezado-acciones">Orden</span>
            </div>
            <ol className="lista-nodos">
            {nodos.length === 0 && <li className="muted">Todavía no hay nodos.</li>}
            {nodos.map((n, i) => (
              <li
                key={n.clave}
                className={repasando && i === encendido ? 'nodo-encendido' : undefined}
                draggable
                onDragStart={() => setArrastrado(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (arrastrado !== null) mover(arrastrado, i);
                  setArrastrado(null);
                }}
              >
                <span className="nodo-orden mono">{i + 1}</span>
                <input
                  className="nodo-apodo"
                  value={n.label ?? ''}
                  onChange={(e) => editarNodo(i, 'label', e.target.value)}
                  placeholder="Sin apodo"
                  aria-label={`Apodo del nodo ${i + 1}`}
                  maxLength={40}
                />
                <input
                  className="nodo-alt"
                  value={String(n.alt)}
                  onChange={(e) => editarNodo(i, 'alt', e.target.value)}
                  aria-label={`Altura del nodo ${i + 1}`}
                  inputMode="numeric"
                />
                <span className="muted mono nodo-coord">
                  {n.lat.toFixed(4)}, {n.lon.toFixed(4)}
                </span>
                <button type="button" className="chico" disabled={i === 0} onClick={() => mover(i, i - 1)} aria-label={`Subir el nodo ${i + 1}`}>
                  ↑
                </button>
                <button
                  type="button"
                  className="chico"
                  disabled={i === nodos.length - 1}
                  onClick={() => mover(i, i + 1)}
                  aria-label={`Bajar el nodo ${i + 1}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="chico dismiss"
                  onClick={() => setNodos((ns) => ns.filter((_, j) => j !== i))}
                  aria-label={`Quitar el nodo ${i + 1}`}
                >
                  Quitar
                </button>
              </li>
            ))}
            </ol>
          </div>
        </div>
      </div>

      <footer className="modal-pie">
        <button type="button" className="ghost" onClick={onCerrar}>
          Cancelar
        </button>
        <button
          type="button"
          disabled={nodos.length < 2 || repasando}
          onClick={() => {
            setEncendido(0);
            setRepasando(true);
          }}
        >
          Repasar el recorrido
        </button>
        <button type="button" className="primario" disabled={!completa || guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar ruta'}
        </button>
      </footer>
    </Modal>
  );
}
