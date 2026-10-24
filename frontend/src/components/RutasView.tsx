import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api, traerRutas } from '../api';
import { CENTRO_POR_DEFECTO, TRAZO, etiquetaDeNodo, useFondo, vestirAtribucion } from '../mapa';
import type { Me, PatrolRoute } from '../types';
import { BotonEditar, BotonEliminar, BotonRestaurar } from './AccionesDeGestion';
import { useAvisar } from './AvisosFlotantes';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import EditorDeRuta from './EditorDeRuta';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';
import { IconoMas, IconoRutas } from './Iconos';

/** El dato corto de la cabecera, como "3 rutas · 14 nodos" en el prototipo. */
function resumenDeRutas(rutas: PatrolRoute[]): string {
  const vivas = rutas.filter((r) => !r.deleted);
  const nodos = vivas.reduce((total, r) => total + r.waypoints.length, 0);
  return `${vivas.length} ${vivas.length === 1 ? 'ruta' : 'rutas'} · ${nodos} ${nodos === 1 ? 'nodo' : 'nodos'}`;
}

type PropsDeItem = Readonly<{
  ruta: PatrolRoute;
  elegida: boolean;
  esSupervisor: boolean;
  onElegir: () => void;
  onEditar: () => void;
  onEliminar: () => void;
  onRestaurar: () => void;
}>;

/**
 * Una ruta del catálogo: una placa con el nombre en Cinzel, cuántos nodos
 * tiene y su descripción. La elegida (la que se dibuja en el mapa) lleva el
 * filo de oro. Elegirla era un clic en la fila, y con el teclado no había
 * forma: el nombre es el botón que lo hace, y la placa entera sigue
 * respondiendo al mouse para no tener que apuntarle al texto.
 */
function ItemDeRuta({ ruta, elegida, esSupervisor, onElegir, onEditar, onEliminar, onRestaurar }: PropsDeItem) {
  const clases = ['ruta-item', elegida && 'seleccionada', ruta.deleted && 'eliminada'].filter(Boolean).join(' ');
  const nodos = ruta.waypoints.length;
  return (
    <li // NOSONAR(S6847, S1082): el clic en la placa es comodidad del mouse; con el teclado se elige desde el botón del nombre, ver arriba
      className={clases}
      onClick={onElegir}
    >
      <div className="ruta-item-cabecera">
        <button
          type="button"
          className="fila-elegir ruta-item-nombre"
          aria-current={elegida ? 'true' : undefined}
          title="Ver el recorrido en el mapa"
          onClick={onElegir}
        >
          {ruta.name}
        </button>
        {esSupervisor && (
          <div className="acciones-fila" role="group" aria-label={`Acciones de ${ruta.name}`}>
            {ruta.deleted ? (
              <BotonRestaurar chico onClick={onRestaurar} />
            ) : (
              <>
                <BotonEditar onClick={onEditar} />
                <BotonEliminar onClick={onEliminar} />
              </>
            )}
          </div>
        )}
      </div>
      <p className="ruta-item-detalle">
        <span className="ruta-item-nodos">
          {nodos} {nodos === 1 ? 'nodo' : 'nodos'}
        </span>
        {ruta.description && ` · ${ruta.description}`}
      </p>
    </li>
  );
}

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
        .bindTooltip(etiquetaDeNodo(i, w.label), { permanent: true, direction: 'top' })
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
export default function RutasView({ me }: Readonly<{ me: Me }>) {
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
        subtitulo={rutas.length > 0 ? resumenDeRutas(rutas) : undefined}
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
              <IconoMas tamano={18} />
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

      {/* El esqueleto sólo hasta que llega la primera lista: después, una
          recarga apaga la lista un momento en vez de empujarla con un cartel. */}
      {rutas.length === 0 && (cargando || !error) && (
        <section className="card">
          {cargando ? (
            <EsqueletoDeTabla texto="Trayendo las rutas…" />
          ) : (
            <EstadoVacio titulo="Todavía no hay rutas de patrullaje." icono={<IconoRutas tamano={46} />}>
              {puedeCrear
                ? 'Con «Nueva ruta» marcás los nodos en el mapa, en el orden en que el dron los tiene que recorrer.'
                : 'Las rutas las dibujan los operadores de campo y los supervisores; cuando haya alguna, va a aparecer acá.'}
            </EstadoVacio>
          )}
        </section>
      )}

      {/* Como en el prototipo: el catálogo a la izquierda, cada ruta en su
          placa, y a la derecha el recorrido de la elegida en su panel. */}
      {rutas.length > 0 && (
        <div className="rutas-cuerpo">
          <ul className="lista-rutas" aria-label="Rutas de patrullaje" aria-busy={cargando || undefined}>
            {rutas.map((r) => (
              <ItemDeRuta
                key={r.id}
                ruta={r}
                elegida={r.id === elegida?.id}
                esSupervisor={esSupervisor}
                onElegir={() => setElegida(r)}
                onEditar={() => setEditando(r)}
                onEliminar={() => pedirBaja(r)}
                onRestaurar={() =>
                  void accion(() => api(`/routes/${r.id}/restore`, { method: 'POST' }), `Ruta ${r.name} restaurada.`)
                }
              />
            ))}
          </ul>

          <section className="card">
            <div className="mapa-head">
              <h2>{elegida ? elegida.name : 'Recorrido'}</h2>
            </div>
            <MapaDeRuta ruta={elegida} />
            <div className="mapa-leyenda">
              <span className="estado warn">Primer nodo</span>
              <span className="estado bad">Nodo</span>
            </div>
          </section>
        </div>
      )}

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
