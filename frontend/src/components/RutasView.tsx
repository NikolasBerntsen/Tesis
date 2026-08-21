import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api, traerRutas } from '../api';
import { CENTRO_POR_DEFECTO, useFondo, vestirAtribucion } from '../mapa';
import type { Me, PatrolRoute } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import EditorDeRuta from './EditorDeRuta';

/** Mapa de sólo lectura con el recorrido de la ruta elegida. */
function MapaDeRuta({ ruta }: { ruta: PatrolRoute | null }) {
  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!caja.current || mapa.current) return;
    const m = L.map(caja.current).setView(CENTRO_POR_DEFECTO, 14);
    vestirAtribucion(m);
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

  useEffect(() => {
    const grupo = capa.current;
    const m = mapa.current;
    if (!grupo || !m) return;
    grupo.clearLayers();
    if (!ruta || ruta.waypoints.length === 0) return;

    const puntos = ruta.waypoints.map((w) => [w.lat, w.lon] as [number, number]);
    L.polyline(puntos, { color: '#8A6A1C', weight: 2 }).addTo(grupo);
    ruta.waypoints.forEach((w, i) => {
      L.circleMarker([w.lat, w.lon], {
        radius: i === 0 ? 10 : 7,
        color: '#14120F',
        weight: 1.5,
        // El primero se destaca: es el que decide si la ruta le queda cerca a una base
        fillColor: i === 0 ? '#F2C230' : '#9C3B30',
        fillOpacity: 1,
      })
        .bindTooltip(`${i + 1}${w.label ? ` · ${w.label}` : ''}`, { permanent: true, direction: 'top' })
        .addTo(grupo);
    });
    m.fitBounds(L.latLngBounds(puntos).pad(0.25));
  }, [ruta]);

  return (
    <div className="mapa-caja">
      <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
      <div className="map" ref={caja} />
    </div>
  );
}

/** Catálogo de rutas de patrullaje, con su recorrido dibujado en el mapa. */
export default function RutasView({ me }: { me: Me }) {
  const [rutas, setRutas] = useState<PatrolRoute[]>([]);
  const [elegida, setElegida] = useState<PatrolRoute | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [verEliminadas, setVerEliminadas] = useState(false);
  const [editando, setEditando] = useState<PatrolRoute | null | undefined>(undefined);

  const esSupervisor = me.role === 'supervisor' || me.role === 'admin';
  const puedeCrear = esSupervisor || me.role === 'field_operator';

  async function cargar() {
    setCargando(true);
    try {
      const lista = await traerRutas({ incluirEliminadas: verEliminadas && esSupervisor });
      setRutas(lista);
      setElegida((actual) => lista.find((r) => r.id === actual?.id) ?? lista[0] ?? null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  }
  useEffect(() => {
    void cargar();
  }, [verEliminadas]);

  async function accion(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await cargar();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  return (
    <main className="page-main">
      <section className="card">
        <div className="log-head">
          <h2>Rutas de patrullaje</h2>
          <div className="barra-acciones">
            {esSupervisor && (
              <button
                type="button"
                className={verEliminadas ? 'toggle-eliminados activo' : 'toggle-eliminados'}
                aria-pressed={verEliminadas}
                onClick={() => setVerEliminadas((v) => !v)}
              >
                {verEliminadas ? 'Ocultar eliminadas' : 'Ver eliminadas'}
              </button>
            )}
            {puedeCrear && (
              <button type="button" className="primario chico" onClick={() => setEditando(null)}>
                Nueva ruta
              </button>
            )}
          </div>
        </div>

        {error && <p className="aviso malo">{error}</p>}
        {cargando && <p className="vacio">Trayendo las rutas…</p>}
        {!cargando && !error && rutas.length === 0 && <p className="vacio">Todavía no hay rutas de patrullaje.</p>}

        {rutas.length > 0 && (
          <div className="rutas-cuerpo">
            <div className="tabla-envoltorio">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Ruta</th>
                    <th>Nodos</th>
                    {esSupervisor && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rutas.map((r) => (
                    <tr
                      key={r.id}
                      className={`${r.id === elegida?.id ? 'seleccionada ' : ''}${r.deleted ? 'fila-eliminada' : ''}`.trim() || undefined}
                      onClick={() => setElegida(r)}
                    >
                      <td>
                        <span className="inscripcion">{r.name}</span>
                        {r.description && <div className="muted">{r.description}</div>}
                      </td>
                      <td className="mono">{r.waypoints.length}</td>
                      {esSupervisor && (
                        <td className="barra-acciones">
                          {r.deleted ? (
                            <button className="chico" onClick={() => accion(() => api(`/routes/${r.id}/restore`, { method: 'POST' }))}>
                              Restaurar
                            </button>
                          ) : (
                            <>
                              <button className="chico" onClick={() => setEditando(r)}>
                                Editar
                              </button>
                              <button className="chico dismiss" onClick={() => accion(() => api(`/routes/${r.id}`, { method: 'DELETE' }))}>
                                Eliminar
                              </button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <div className="mapa-head">
                <h2>{elegida ? elegida.name : 'Recorrido'}</h2>
              </div>
              <MapaDeRuta ruta={elegida} />
              <div className="mapa-leyenda">
                <span className="estado warn">Primer nodo</span>
                <span className="estado bad">Nodo</span>
              </div>
            </div>
          </div>
        )}
      </section>

      {editando !== undefined && (
        <EditorDeRuta
          ruta={editando}
          onCerrar={() => setEditando(undefined)}
          onGuardar={async (datos) => {
            await (editando
              ? api(`/routes/${editando.id}`, { method: 'PATCH', body: JSON.stringify(datos) })
              : api('/routes', { method: 'POST', body: JSON.stringify(datos) }));
            setEditando(undefined);
            await cargar();
          }}
        />
      )}
    </main>
  );
}
