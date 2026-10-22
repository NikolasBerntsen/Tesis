import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api, traerRutas } from '../api';
import { CENTRO_POR_DEFECTO, TRAZO, useFondo, vestirAtribucion } from '../mapa';
import type { Me, PatrolRoute } from '../types';
import { useAvisar } from './AvisosFlotantes';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import EditorDeRuta from './EditorDeRuta';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';

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
    // Las clases dejan que el CSS aclare el recorrido y el filo de los nodos
    // en obsidiana, sobre el callejero oscurecido (ver TRAZO en mapa.ts).
    L.polyline(puntos, { color: '#8A6A1C', weight: 2, className: TRAZO.recorrido }).addTo(grupo);
    ruta.waypoints.forEach((w, i) => {
      L.circleMarker([w.lat, w.lon], {
        radius: i === 0 ? 10 : 7,
        color: '#14120F',
        className: TRAZO.nodo,
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
  // Eliminar una ruta era un solo clic sin pregunta, al lado de "Editar".
  const [pedido, setPedido] = useState<PedidoDeConfirmacion | null>(null);
  const avisar = useAvisar();

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

  async function accion(fn: () => Promise<unknown>, aviso: string) {
    setError('');
    try {
      await fn();
      avisar(aviso);
      await cargar();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  function pedirBaja(r: PatrolRoute) {
    setPedido({
      titulo: `Eliminar la ruta ${r.name}`,
      subtitulo: 'La baja se puede deshacer',
      consecuencia: 'La ruta sale del catálogo y deja de ofrecerse para empezar un patrullaje.',
      detalle: 'Un supervisor la puede restaurar desde «Ver eliminadas», con sus nodos tal como estaban.',
      confirmar: 'Eliminar',
      enCurso: 'Eliminando…',
      // El error sube al diálogo; la lista se recarga sin hacerlo esperar.
      accion: async () => {
        await api(`/routes/${r.id}`, { method: 'DELETE' });
        avisar(`Ruta ${r.name} eliminada.`);
        void cargar();
      },
    });
  }

  return (
    <main className="page-main">
      <EncabezadoDeVista
        titulo="Rutas de patrullaje"
        opciones={
          esSupervisor && (
            <button
              type="button"
              className={verEliminadas ? 'toggle-eliminados activo' : 'toggle-eliminados'}
              aria-pressed={verEliminadas}
              onClick={() => setVerEliminadas((v) => !v)}
            >
              Ver eliminadas
            </button>
          )
        }
        accion={
          puedeCrear && (
            <button type="button" className="primario" onClick={() => setEditando(null)}>
              Nueva ruta
            </button>
          )
        }
      />

      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        {/* El esqueleto sólo hasta que llega la primera lista: después, una
            recarga apaga la tabla un momento en vez de empujarla con un cartel. */}
        {cargando && rutas.length === 0 && <EsqueletoDeTabla texto="Trayendo las rutas…" />}
        {!cargando && !error && rutas.length === 0 && (
          <EstadoVacio titulo="Todavía no hay rutas de patrullaje.">
            {puedeCrear
              ? 'Con «Nueva ruta» marcás los nodos en el mapa, en el orden en que el dron los tiene que recorrer.'
              : 'Las rutas las dibujan los operadores de campo y los supervisores; cuando haya alguna, va a aparecer acá.'}
          </EstadoVacio>
        )}

        {rutas.length > 0 && (
          <div className="rutas-cuerpo">
            <div className="tabla-envoltorio" aria-busy={cargando || undefined}>
              <table className="tabla tabla-gestion">
                <thead>
                  <tr>
                    <th>Ruta</th>
                    <th>Nodos</th>
                    {esSupervisor && <th className="columna-acciones">Acciones</th>}
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
                        {/* Elegir la ruta que se dibuja era un clic en la fila,
                            y con el teclado no había forma: el nombre es el
                            botón que lo hace (la fila sigue respondiendo al
                            mouse, para no apuntarle al texto). */}
                        <button
                          type="button"
                          className="fila-elegir inscripcion"
                          aria-current={r.id === elegida?.id ? 'true' : undefined}
                          title="Ver el recorrido en el mapa"
                          onClick={() => setElegida(r)}
                        >
                          {r.name}
                        </button>
                        {r.description && <div className="muted">{r.description}</div>}
                      </td>
                      <td className="mono">{r.waypoints.length}</td>
                      {esSupervisor && (
                        <td className="barra-acciones">
                          <div className="acciones-fila" role="group" aria-label={`Acciones de ${r.name}`}>
                            {r.deleted ? (
                              <button
                                type="button"
                                className="chico"
                                onClick={() =>
                                  accion(() => api(`/routes/${r.id}/restore`, { method: 'POST' }), `Ruta ${r.name} restaurada.`)
                                }
                              >
                                Restaurar
                              </button>
                            ) : (
                              <>
                                <button type="button" className="chico" onClick={() => setEditando(r)}>
                                  Editar
                                </button>
                                <button type="button" className="chico dismiss" onClick={() => pedirBaja(r)}>
                                  Eliminar
                                </button>
                              </>
                            )}
                          </div>
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
            avisar(editando ? `Cambios de ${datos.name} guardados.` : `Ruta ${datos.name} creada.`);
            await cargar();
          }}
        />
      )}

      {pedido && <DialogoConfirmacion pedido={pedido} onCerrar={() => setPedido(null)} />}
    </main>
  );
}
