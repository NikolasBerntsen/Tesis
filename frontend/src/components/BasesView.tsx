import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import { api, traerBases } from '../api';
import type { BaseAsset, Me } from '../types';
import Modal from './Modal';

type Formulario = { name: string; lat: string; lon: string };
const VACIO: Formulario = { name: '', lat: '', lon: '' };

const CRUZ = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v18M3 12h18" />
  </svg>
);

/** Marcador de la base: el mismo lenguaje que usa el mapa de la flota. */
const iconoBase = L.divIcon({
  className: 'base-icon',
  html: '<span class="base-marca"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

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
    const m = L.map(caja.current, { attributionControl: true, zoomControl: true }).setView([-34.8565, -56.2075], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
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

  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (lat == null || lon == null) {
      marca.current?.remove();
      marca.current = null;
      return;
    }
    if (marca.current) marca.current.setLatLng([lat, lon]);
    else marca.current = L.marker([lat, lon], { icon: iconoBase }).addTo(m);
    m.panTo([lat, lon]);
  }, [lat, lon]);

  return <div className="mapa-elector" ref={caja} />;
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
    setAbierto(true);
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
    const ok = await accion(() =>
      editando
        ? api(`/bases/${editando.id}`, { method: 'PATCH', body: cuerpo })
        : api('/bases', { method: 'POST', body: cuerpo }),
    );
    if (ok) setAbierto(false);
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
              <button type="button" className="primario" onClick={abrirAlta}>
                {CRUZ} Nueva base
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
                  {esSupervisor && <th />}
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
                    {esSupervisor && (
                      <td className="barra-acciones">
                        {b.deletedAt ? (
                          <button className="chico" onClick={() => accion(() => api(`/bases/${b.id}/restore`, { method: 'POST' }))}>
                            Restaurar
                          </button>
                        ) : (
                          <>
                            <button className="chico" onClick={() => abrirEdicion(b)}>
                              Editar
                            </button>
                            <button
                              className="chico"
                              onClick={() => accion(() => api(`/bases/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active: !b.active }) }))}
                            >
                              {b.active ? 'Desactivar' : 'Activar'}
                            </button>
                            <button className="chico dismiss" onClick={() => accion(() => api(`/bases/${b.id}`, { method: 'DELETE' }))}>
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
    </main>
  );
}
