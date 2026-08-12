import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import { LEJOS_M, api, distanciaM, rutasDeBase, traerBases, traerRutas } from '../api';
import { CENTRO_POR_DEFECTO, iconoBase, useFondo, vestirAtribucion } from '../mapa';
import type { BaseAsset, Me, PatrolRoute } from '../types';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import EditorDeRuta from './EditorDeRuta';
import Modal from './Modal';

type Formulario = { name: string; lat: string; lon: string };
const VACIO: Formulario = { name: '', lat: '', lon: '' };

function coordValida(v: string, tope: number): boolean {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && Math.abs(n) <= tope;
}

/**
 * Mapa para elegir el punto de una base. Clickear pone el marcador y completa
 * las coordenadas del formulario: en el terreno nadie tipea una latitud.
 */
function MapaElector({ lat, lon, onElegir }: { lat: number | null; lon: number | null; onElegir: (lat: number, lon: number) => void }) {
  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const marca = useRef<L.Marker | null>(null);
  const elegir = useRef(onElegir);
  elegir.current = onElegir;

  useEffect(() => {
    if (!caja.current || mapa.current) return;
    const m = L.map(caja.current, { attributionControl: true, zoomControl: true }).setView(CENTRO_POR_DEFECTO, 14);
    vestirAtribucion(m);
    m.on('click', (e: L.LeafletMouseEvent) => elegir.current(e.latlng.lat, e.latlng.lng));
    mapa.current = m;
    // Leaflet mide mal el contenedor si nace dentro de algo que recién se abre.
    setTimeout(() => m.invalidateSize(), 60);
    return () => {
      m.remove();
      mapa.current = null;
      marca.current = null;
    };
  }, []);

  const [fondo, setFondo] = useFondo(mapa);

  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (lat == null || lon == null) {
      marca.current?.remove();
      marca.current = null;
      return;
    }
    if (marca.current) marca.current.setLatLng([lat, lon]);
    else marca.current = L.marker([lat, lon], { icon: iconoBase() }).addTo(m);
    m.panTo([lat, lon]);
  }, [lat, lon]);

  return (
    <div className="mapa-caja">
      <ConmutadorDeFondo fondo={fondo} onCambiar={setFondo} />
      <div className="mapa-elector" ref={caja} />
    </div>
  );
}

/**
 * Bases de retorno de los drones. El operador de campo las da de alta parado en
 * el lugar; el supervisor las edita y las da de baja.
 */
export default function BasesView({ me }: { me: Me }) {
  const [bases, setBases] = useState<BaseAsset[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [verEliminadas, setVerEliminadas] = useState(false);
  const [form, setForm] = useState<Formulario>(VACIO);
  const [editando, setEditando] = useState<BaseAsset | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [ubicando, setUbicando] = useState(false);
  // Qué rutas puede patrullar un dron que sale de esta base. Se abre solo
  // después de dar de alta una base y a pedido desde la fila de cualquier otra:
  // las rutas de una base cambian mucho después del alta.
  const [asignando, setAsignando] = useState<BaseAsset | null>(null);
  const [reciencreada, setReciencreada] = useState(false);
  const [rutas, setRutas] = useState<PatrolRoute[]>([]);
  const [elegidas, setElegidas] = useState<number[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [editorAbierto, setEditorAbierto] = useState(false);
  const [aConfirmar, setAConfirmar] = useState<{ ruta: PatrolRoute; metros: number } | null>(null);

  const esSupervisor = me.role === 'supervisor' || me.role === 'admin';
  const puedeCrear = esSupervisor || me.role === 'field_operator';

  async function cargar() {
    setCargando(true);
    try {
      setBases(await traerBases({ incluirEliminadas: verEliminadas && esSupervisor }));
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

  const lat = coordValida(form.lat, 90) ? Number(form.lat) : null;
  const lon = coordValida(form.lon, 180) ? Number(form.lon) : null;
  const completo = form.name.trim().length > 0 && lat != null && lon != null;

  function abrirAlta() {
    setEditando(null);
    setForm(VACIO);
    setElegidas([]);
    setBusqueda('');
    setAsignando(null);
    setAbierto(true);
  }

  /**
   * Abre la asignación de rutas de una base que ya existe, con las que hoy
   * tiene ya marcadas: acá se agrega y se saca, no se empieza de cero.
   */
  async function abrirRutas(b: BaseAsset) {
    setError('');
    setBusqueda('');
    setReciencreada(false);
    setElegidas([]);
    setAsignando(b);
    try {
      const [todas, asignadas] = await Promise.all([traerRutas(), rutasDeBase(b.id)]);
      setRutas(todas);
      setElegidas(asignadas.map((r) => r.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Las rutas se ordenan por la distancia entre la base y su PRIMER nodo: es
   * desde ahí que el dron arranca el recorrido, así que es la distancia que
   * decide si la ruta tiene sentido para esta base.
   */
  const rutasOrdenadas = useMemo(() => {
    const origen = asignando ?? (lat != null && lon != null ? { lat, lon } : null);
    const q = busqueda.trim().toLowerCase();
    return rutas
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .map((r) => {
        const primero = r.waypoints[0];
        const metros = origen && primero ? distanciaM(origen, primero) : null;
        return { ruta: r, metros };
      })
      .sort((a, b) => (a.metros ?? Infinity) - (b.metros ?? Infinity));
  }, [rutas, busqueda, asignando, lat, lon]);

  function alternarRuta(ruta: PatrolRoute, metros: number | null) {
    if (elegidas.includes(ruta.id)) {
      setElegidas((ids) => ids.filter((id) => id !== ruta.id));
      return;
    }
    // Lejos de la base, el vuelo hasta el primer nodo se come la autonomía:
    // se pregunta antes de asignarla, con la distancia a la vista.
    if (metros != null && metros > LEJOS_M) {
      setAConfirmar({ ruta, metros });
      return;
    }
    setElegidas((ids) => [...ids, ruta.id]);
  }

  function abrirEdicion(b: BaseAsset) {
    setEditando(b);
    setForm({ name: b.name, lat: String(b.lat), lon: String(b.lon) });
    setAbierto(true);
  }

  /**
   * El operador de campo está parado en la base cuando la da de alta: pedirle
   * las coordenadas al GPS es más rápido y más exacto que buscarla en el mapa.
   */
  function usarMiUbicacion() {
    if (!navigator.geolocation) {
      setError('Este dispositivo no informa su ubicación: marcá el punto en el mapa.');
      return;
    }
    setUbicando(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(6), lon: pos.coords.longitude.toFixed(6) }));
        setUbicando(false);
      },
      () => {
        setError('No se pudo leer la ubicación. Revisá el permiso del navegador o marcá el punto en el mapa.');
        setUbicando(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!completo) return;
    const cuerpo = JSON.stringify({ name: form.name.trim(), lat, lon });
    if (editando) {
      const ok = await accion(() => api(`/bases/${editando.id}`, { method: 'PATCH', body: cuerpo }));
      if (ok) setAbierto(false);
      return;
    }
    // Alta: se guarda la base y recién ahí se eligen sus rutas, que es el orden
    // en que se piensa el problema (primero dónde está, después qué patrulla).
    setError('');
    try {
      const creada = await api<BaseAsset>('/bases', { method: 'POST', body: cuerpo });
      setAbierto(false);
      setElegidas([]);
      setReciencreada(true);
      setAsignando(creada);
      setRutas(await traerRutas().catch(() => []));
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const visibles = useMemo(() => bases, [bases]);

  return (
    <main className="page-main">
      <section className="card">
        <div className="log-head">
          <h2>Bases</h2>
          <div className="barra-acciones">
            {esSupervisor && (
              <button
                type="button"
                className={verEliminadas ? 'toggle-eliminados activo' : 'toggle-eliminados'}
                onClick={() => setVerEliminadas((v) => !v)}
              >
                {verEliminadas ? 'Ocultar eliminadas' : 'Ver eliminadas'}
              </button>
            )}
            {puedeCrear && (
              <button type="button" className="primario chico" onClick={abrirAlta}>
                Nueva base
              </button>
            )}
          </div>
        </div>

        {error && <p className="aviso malo">{error}</p>}
        {cargando && <p className="vacio">Trayendo las bases…</p>}
        {!cargando && !error && visibles.length === 0 && (
          <p className="vacio">Todavía no hay bases dadas de alta.</p>
        )}

        {visibles.length > 0 && (
          <div className="tabla-envoltorio">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Coordenadas</th>
                  <th>Estado</th>
                  {puedeCrear && <th />}
                </tr>
              </thead>
              <tbody>
                {visibles.map((b) => (
                  <tr key={b.id} className={b.deletedAt ? 'fila-eliminada' : undefined}>
                    <td className="inscripcion">{b.name}</td>
                    <td className="mono">
                      {b.lat.toFixed(5)}, {b.lon.toFixed(5)}
                    </td>
                    <td>
                      {b.deletedAt ? (
                        <span className="estado muted">Eliminada</span>
                      ) : (
                        <span className={b.active ? 'estado ok' : 'estado muted'}>{b.active ? 'Activa' : 'Inactiva'}</span>
                      )}
                    </td>
                    {puedeCrear && (
                      <td className="barra-acciones">
                        {b.deletedAt ? (
                          esSupervisor && (
                            <button className="chico" onClick={() => accion(() => api(`/bases/${b.id}/restore`, { method: 'POST' }))}>
                              Restaurar
                            </button>
                          )
                        ) : (
                          <>
                            <button className="chico" onClick={() => void abrirRutas(b)}>
                              Rutas
                            </button>
                            {esSupervisor && (
                              <>
                                <button className="chico" onClick={() => abrirEdicion(b)}>
                                  Editar
                                </button>
                                <button
                                  className="chico"
                                  onClick={() =>
                                    accion(() => api(`/bases/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active: !b.active }) }))
                                  }
                                >
                                  {b.active ? 'Desactivar' : 'Activar'}
                                </button>
                                <button className="chico dismiss" onClick={() => accion(() => api(`/bases/${b.id}`, { method: 'DELETE' }))}>
                                  Eliminar
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {abierto && (
        <Modal etiquetadoPor="titulo-base" onCerrar={() => setAbierto(false)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id="titulo-base">
              {editando ? `Editar ${editando.name}` : 'Nueva base'}
            </h2>
            <button type="button" className="modal-cerrar" aria-label="Cerrar" onClick={() => setAbierto(false)}>
              ×
            </button>
          </header>
          <form className="form-base modal-cuerpo" onSubmit={guardar}>
            <label>
              Nombre
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required />
            </label>

            <p className="muted">Marcá el punto en el mapa o escribí las coordenadas.</p>
            <MapaElector
              lat={lat}
              lon={lon}
              onElegir={(la, lo) => setForm((f) => ({ ...f, lat: la.toFixed(6), lon: lo.toFixed(6) }))}
            />

            <div className="fila-coords">
              <label>
                Latitud
                <input value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} inputMode="decimal" required />
              </label>
              <label>
                Longitud
                <input value={form.lon} onChange={(e) => setForm({ ...form, lon: e.target.value })} inputMode="decimal" required />
              </label>
              <button type="button" onClick={usarMiUbicacion} disabled={ubicando}>
                {ubicando ? 'Ubicando…' : 'Usar mi ubicación'}
              </button>
            </div>

            <div className="modal-pie">
              <button type="button" className="ghost" onClick={() => setAbierto(false)}>
                Cancelar
              </button>
              <button type="submit" className="primario" disabled={!completo}>
                {editando ? 'Guardar' : 'Dar de alta'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {asignando && (
        <Modal etiquetadoPor="titulo-rutas-base" onCerrar={() => setAsignando(null)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id="titulo-rutas-base">
              Rutas de {asignando.name}
            </h2>
            <button type="button" className="modal-cerrar" aria-label="Cerrar" onClick={() => setAsignando(null)}>
              ×
            </button>
          </header>
          <div className="modal-cuerpo form-base">
            {error && <p className="aviso malo">{error}</p>}
            <p className="muted">
              {reciencreada ? (
                <>
                  <strong>{asignando.name}</strong> quedó dada de alta. Elegí qué rutas puede patrullar un dron
                  que sale de esta base; las más cercanas aparecen primero.
                </>
              ) : (
                <>
                  Elegí qué rutas puede patrullar un dron que sale de <strong>{asignando.name}</strong>; las más
                  cercanas aparecen primero. Lo que quede sin marcar se le saca a la base.
                </>
              )}
            </p>
            <div className="barra-acciones">
              <input
                className="buscador"
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar una ruta…"
                aria-label="Buscar rutas"
              />
              {puedeCrear && (
                <button type="button" className="chico" onClick={() => setEditorAbierto(true)}>
                  Nueva ruta
                </button>
              )}
            </div>
            {rutasOrdenadas.length === 0 && <p className="vacio">No hay rutas para asignar.</p>}
            <ul className="lista-bases" role="listbox" aria-label="Rutas disponibles">
              {rutasOrdenadas.map(({ ruta, metros }) => (
                <li key={ruta.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={elegidas.includes(ruta.id)}
                    className={elegidas.includes(ruta.id) ? 'active' : ''}
                    onClick={() => alternarRuta(ruta, metros)}
                  >
                    <span className="inscripcion">{ruta.name}</span>
                    <span className="muted mono">
                      {ruta.waypoints.length} nodos
                      {metros != null && ` · ${metros < 1000 ? `${Math.round(metros)} m` : `${(metros / 1000).toFixed(1)} km`}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="modal-pie">
            <button type="button" className="ghost" onClick={() => setAsignando(null)}>
              {reciencreada ? 'Después' : 'Cancelar'}
            </button>
            <button
              type="button"
              className="primario"
              onClick={() =>
                accion(async () => {
                  await api(`/bases/${asignando.id}/routes`, {
                    method: 'PUT',
                    body: JSON.stringify({ routeIds: elegidas }),
                  });
                  setAsignando(null);
                })
              }
            >
              Asignar {elegidas.length > 0 ? `${elegidas.length} ruta(s)` : 'sin rutas'}
            </button>
          </div>
        </Modal>
      )}

      {editorAbierto && (
        <EditorDeRuta
          ruta={null}
          base={asignando}
          onCerrar={() => setEditorAbierto(false)}
          onGuardar={async (datos) => {
            // Una ruta dibujada desde la base se asigna sola: es para esta base
            // que se la está haciendo.
            const creada = await api<PatrolRoute>('/routes', { method: 'POST', body: JSON.stringify(datos) });
            setRutas((rs) => [...rs, creada]);
            setElegidas((ids) => [...ids, creada.id]);
            setEditorAbierto(false);
          }}
        />
      )}

      {aConfirmar && (
        <Modal etiquetadoPor="titulo-lejos" onCerrar={() => setAConfirmar(null)}>
          <header className="modal-cabecera">
            <h2 className="modal-titulo" id="titulo-lejos">
              La ruta queda lejos de la base
            </h2>
          </header>
          <div className="modal-cuerpo">
            <p>
              El primer nodo de <strong>{aConfirmar.ruta.name}</strong> está a{' '}
              <strong>{(aConfirmar.metros / 1000).toFixed(1)} km</strong> de la base. El dron va a gastar
              esa ida y esa vuelta de su autonomía antes de empezar a patrullar.
            </p>
            <p className="muted">¿Querés asignarla igual?</p>
          </div>
          <footer className="modal-pie">
            <button type="button" className="ghost" onClick={() => setAConfirmar(null)}>
              No asignarla
            </button>
            <button
              type="button"
              className="primario"
              onClick={() => {
                setElegidas((ids) => [...ids, aConfirmar.ruta.id]);
                setAConfirmar(null);
              }}
            >
              Asignarla igual
            </button>
          </footer>
        </Modal>
      )}
    </main>
  );
}
