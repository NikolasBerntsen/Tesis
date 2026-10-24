import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import { LEJOS_M, api, distanciaM, rutasDeBase, traerBases, traerRutas } from '../api';
import { CENTRO_POR_DEFECTO, PALETA, iconoBase, useFondo, vestirAtribucion } from '../mapa';
import type { BaseAsset, Me, PatrolRoute } from '../types';
import { BotonEditar, BotonEliminar, BotonRestaurar } from './AccionesDeGestion';
import { useAvisar } from './AvisosFlotantes';
import ConmutadorDeFondo from './ConmutadorDeFondo';
import DialogoConfirmacion, { type PedidoDeConfirmacion } from './DialogoConfirmacion';
import EditorDeRuta from './EditorDeRuta';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EsqueletoDeTabla, EstadoVacio } from './EstadosDeVista';
import { IconoBase, IconoCerrar, IconoMas, IconoRutas, IconoUbicacion } from './Iconos';
import Modal from './Modal';

type Formulario = { name: string; lat: string; lon: string; aterrizajeLat: string; aterrizajeLon: string };
const VACIO: Formulario = { name: '', lat: '', lon: '', aterrizajeLat: '', aterrizajeLon: '' };

/**
 * Entre cuánto y cuánto de la base va el punto de aterrizaje para visitantes
 * (§5 del contrato, RELEVOS §0): más cerca bajaría sobre la plataforma; más
 * lejos ya no está "en la base" para el hub. El backend lo vuelve a controlar.
 */
const VISITANTES_MINIMO_M = 10;
const VISITANTES_MAXIMO_M = 50;

/** El punto para visitantes en el mapa: un aro azul, que no se confunde con el rombo de la base. */
const ARO_VISITANTES: L.CircleMarkerOptions = {
  radius: 7,
  color: PALETA.info,
  weight: 2.5,
  fillColor: PALETA.marfil,
  fillOpacity: 0.95,
};

/** Lo bastante cerca para distinguir 10 m de 50 alrededor de la base. */
const ZOOM_DEL_PUNTO_PARA_VISITANTES = 19;

/** "23,4 m": con un decimal, porque 50,4 redondeado a 50 parecería estar en rango. */
function metros(m: number): string {
  return `${(Math.round(m * 10) / 10).toLocaleString('es-AR')} m`;
}

/**
 * Qué le pasa al punto para visitantes, o '' si está bien (o si no se cargó:
 * es opcional). Se mide contra el punto de la base que está en el formulario,
 * no contra el guardado: mover la base sin mover el punto lo puede dejar
 * fuera de rango, y el backend lo rechazaría.
 */
function problemaDelPuntoDeVisitantes(
  cargado: boolean,
  punto: { lat: number; lon: number } | null,
  distancia: number | null,
): string {
  if (!cargado) return '';
  if (!punto) return 'Completá la latitud y la longitud del punto para visitantes, o dejá las dos vacías.';
  if (distancia === null) return '';
  if (distancia < VISITANTES_MINIMO_M || distancia > VISITANTES_MAXIMO_M) {
    return `El punto para visitantes tiene que estar entre ${VISITANTES_MINIMO_M} y ${VISITANTES_MAXIMO_M} m de la base: ahora está a ${metros(distancia)}.`;
  }
  return '';
}

function coordValida(v: string, tope: number): boolean {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && Math.abs(n) <= tope;
}

function textoError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * El botón que guarda la asignación dice cuántas rutas quedan. Antes era
 * "Asignar 2 ruta(s)" y "Asignar sin rutas": el paréntesis no es castellano y
 * lo segundo no se entiende sin pensarlo.
 */
function rotuloDeAsignacion(cantidad: number): string {
  if (cantidad === 0) return 'Guardar sin rutas';
  return cantidad === 1 ? 'Asignar 1 ruta' : `Asignar ${cantidad} rutas`;
}

/**
 * Por qué el botón de guardar sigue apagado. Sin esto el diálogo sólo mostraba
 * un botón gris, y quien no veía el marcador en el mapa no sabía qué le faltaba.
 */
function queFalta(hayNombre: boolean, hayPunto: boolean): string {
  if (hayNombre && hayPunto) return '';
  if (hayNombre) return 'Falta el punto: marcalo en el mapa o escribí las coordenadas.';
  return hayPunto ? 'Falta el nombre de la base.' : 'Faltan el nombre y el punto de la base.';
}

/** El dato corto de la cabecera: cuántas bases hay y cuántas se pueden asignar. */
function resumenDeBases(bases: BaseAsset[]): string {
  const vivas = bases.filter((b) => !b.deleted);
  const activas = vivas.filter((b) => b.active).length;
  return `${vivas.length} ${vivas.length === 1 ? 'base' : 'bases'} · ${activas} ${activas === 1 ? 'activa' : 'activas'}`;
}

/** La pastilla de la ficha: si se le puede asignar a un dron, o si es una baja. */
function pastillaDeBase(b: BaseAsset): { clase: string; texto: string } {
  if (b.deleted) return { clase: 'muted', texto: 'Eliminada' };
  return b.active ? { clase: 'ok', texto: 'Activa' } : { clase: 'muted', texto: 'Inactiva' };
}

type PropsDeFichaDeBase = Readonly<{
  base: BaseAsset;
  esSupervisor: boolean;
  /** El operador de campo y el supervisor: los que ven las acciones. */
  puedeCrear: boolean;
  onEditar: () => void;
  onRutas: () => void;
  onAlternarActiva: () => void;
  onEliminar: () => void;
  onRestaurar: () => void;
}>;

/**
 * Las acciones de una base, en el orden de todas las vistas de gestión:
 * Editar primero, Eliminar al final. Las eliminadas sólo llegan cuando el
 * supervisor las pide con el interruptor: restaurar no necesita preguntar el
 * rol otra vez.
 */
function AccionesDeBase({ base, esSupervisor, onEditar, onRutas, onAlternarActiva, onEliminar, onRestaurar }: PropsDeFichaDeBase) {
  return (
    <div className="ficha-acciones" role="group" aria-label={`Acciones de ${base.name}`}>
      {base.deleted ? (
        <BotonRestaurar onClick={onRestaurar} />
      ) : (
        <>
          {esSupervisor && <BotonEditar onClick={onEditar} />}
          <button type="button" onClick={onRutas}>
            <IconoRutas tamano={18} />
            Rutas
          </button>
          {esSupervisor && (
            <>
              <button type="button" onClick={onAlternarActiva}>
                {base.active ? 'Desactivar' : 'Activar'}
              </button>
              <BotonEliminar onClick={onEliminar} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * La ficha de una base, como en el prototipo: el nombre en Cinzel, el alfiler
 * con sus coordenadas debajo y la pastilla de si está activa; si tiene punto
 * para visitantes, a cuánto queda. Lo que el prototipo dibuja además (los
 * drones de la base, el relevo en espera) no lo trae la lista de bases, así
 * que no se inventa acá: quién espera para relevos lo dice cada dron, en su
 * cámara del tablero y en su vista.
 */
function FichaDeBase(props: PropsDeFichaDeBase) {
  const { base, puedeCrear } = props;
  const idNombre = useId();
  const pastilla = pastillaDeBase(base);
  const visitantes =
    base.aterrizajeLat != null && base.aterrizajeLon != null
      ? distanciaM(base, { lat: base.aterrizajeLat, lon: base.aterrizajeLon })
      : null;
  return (
    <li>
      <article className={base.deleted ? 'ficha eliminada' : 'ficha'} aria-labelledby={idNombre}>
        <header className="ficha-cabecera">
          <div className="ficha-titulos">
            <h3 className="ficha-nombre" id={idNombre}>
              {base.name}
            </h3>
            <p className="ficha-sub">
              <IconoUbicacion tamano={16} />
              {base.lat.toFixed(5)}, {base.lon.toFixed(5)}
            </p>
          </div>
          <span className={`estado pastilla ${pastilla.clase}`}>{pastilla.texto}</span>
        </header>
        {/* El punto donde aterriza un dron de otra base que viene a relevar
            (RELEVOS §6): un dato de la base, a cuánto queda de ella. */}
        {visitantes !== null && (
          <dl className="ficha-datos">
            <div className="ficha-dato-ancho">
              <dt className="rotulo">Punto para visitantes</dt>
              <dd>{`A ${metros(visitantes)} de la base`}</dd>
            </div>
          </dl>
        )}
        {puedeCrear && <AccionesDeBase {...props} />}
      </article>
    </li>
  );
}

/**
 * Mapa para elegir el punto de una base. Clickear pone el marcador y completa
 * las coordenadas del formulario: en el terreno nadie tipea una latitud.
 */
function MapaElector({
  lat,
  lon,
  visitante = null,
  acercar = false,
  onElegir,
}: {
  lat: number | null;
  lon: number | null;
  /** El punto de aterrizaje para visitantes, si hay uno cargado. */
  visitante?: { lat: number; lon: number } | null;
  /** Acercarse a la base: se está eligiendo algo a pocos metros de ella. */
  acercar?: boolean;
  onElegir: (lat: number, lon: number) => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const marca = useRef<L.Marker | null>(null);
  const marcaVisitante = useRef<L.CircleMarker | null>(null);
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
      marcaVisitante.current = null;
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

  // El punto para visitantes va a entre 10 y 50 m de la base: con el zoom de
  // la ciudad no se distingue de ella. Al pasar a elegirlo, el mapa se acerca
  // a la base; al volver a la base, se queda donde el operador lo dejó.
  useEffect(() => {
    const m = mapa.current;
    if (!m || !acercar || lat == null || lon == null) return;
    m.setView([lat, lon], ZOOM_DEL_PUNTO_PARA_VISITANTES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acercar]);

  const latVisitante = visitante?.lat;
  const lonVisitante = visitante?.lon;
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (latVisitante === undefined || lonVisitante === undefined) {
      marcaVisitante.current?.remove();
      marcaVisitante.current = null;
      return;
    }
    if (marcaVisitante.current) marcaVisitante.current.setLatLng([latVisitante, lonVisitante]);
    else {
      marcaVisitante.current = L.circleMarker([latVisitante, lonVisitante], ARO_VISITANTES)
        .bindTooltip('Punto para visitantes')
        .addTo(m);
    }
  }, [latVisitante, lonVisitante]);

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
export default function BasesView({ me }: Readonly<{ me: Me }>) {
  const [bases, setBases] = useState<BaseAsset[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [verEliminadas, setVerEliminadas] = useState(false);
  const [form, setForm] = useState<Formulario>(VACIO);
  const [editando, setEditando] = useState<BaseAsset | null>(null);
  const [abierto, setAbierto] = useState(false);
  // El error del alta o de la edición va adentro del diálogo: el de la página
  // queda tapado por el velo y parecía que guardar no hacía nada.
  const [errorForm, setErrorForm] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [ubicando, setUbicando] = useState(false);
  // Qué pone el clic en el mapa del formulario: el punto de la base o el de
  // aterrizaje para visitantes. Arranca en la base, que es lo que se carga primero.
  const [marcando, setMarcando] = useState<'base' | 'visitantes'>('base');
  // Qué rutas puede patrullar un dron que sale de esta base. Se abre solo
  // después de dar de alta una base y a pedido desde la fila de cualquier otra:
  // las rutas de una base cambian mucho después del alta.
  const [asignando, setAsignando] = useState<BaseAsset | null>(null);
  // El error de la asignación es del diálogo, como el del formulario. Leía el
  // de la página, que tiene su propio aviso: un PUT rechazado se anunciaba dos
  // veces, y la copia de la página quedaba repetida detrás del velo.
  const [errorRutas, setErrorRutas] = useState('');
  const [reciencreada, setReciencreada] = useState(false);
  const [rutas, setRutas] = useState<PatrolRoute[]>([]);
  const [elegidas, setElegidas] = useState<number[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [editorAbierto, setEditorAbierto] = useState(false);
  const [lejana, setLejana] = useState<{ ruta: PatrolRoute; metros: number } | null>(null);
  // Lo que borra o apaga una base pregunta antes: eliminar se hacía con un
  // solo clic y sin vuelta atrás a la vista.
  const [pedido, setPedido] = useState<PedidoDeConfirmacion | null>(null);
  const avisar = useAvisar();

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

  /**
   * Para lo que pasa por la confirmación: el error sube al diálogo, que lo
   * muestra adentro y no se cierra. La lista se recarga sin esperarla: el
   * diálogo se cierra apenas el backend dice que sí.
   */
  function confirmada(fn: () => Promise<unknown>, aviso: string) {
    return async () => {
      await fn();
      avisar(aviso);
      void cargar();
    };
  }

  function pedirBaja(b: BaseAsset) {
    setPedido({
      titulo: `Eliminar la base ${b.name}`,
      subtitulo: 'La baja se puede deshacer',
      consecuencia: 'La base sale del catálogo y ya no se le puede asignar a ningún dron.',
      detalle:
        'Si todavía es la base de algún dron, el Comando Central no la deja eliminar: primero hay que reasignarlos. Un supervisor la puede restaurar desde «Ver eliminadas».',
      confirmar: 'Eliminar',
      enCurso: 'Eliminando…',
      accion: confirmada(() => api(`/bases/${b.id}`, { method: 'DELETE' }), `Base ${b.name} eliminada.`),
    });
  }

  /** Desactivar pregunta (deja de poder asignarse); activar no rompe nada. */
  function alternarActiva(b: BaseAsset) {
    const cambiar = () => api(`/bases/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active: !b.active }) });
    if (!b.active) {
      void accion(cambiar, `Base ${b.name} activada.`);
      return;
    }
    setPedido({
      titulo: `Desactivar la base ${b.name}`,
      consecuencia: 'Mientras esté inactiva no se le puede asignar a ningún dron. Los drones que ya la tienen la conservan.',
      detalle: 'Se vuelve a activar desde esta misma fila.',
      confirmar: 'Desactivar',
      enCurso: 'Desactivando…',
      accion: confirmada(cambiar, `Base ${b.name} desactivada.`),
    });
  }

  const lat = coordValida(form.lat, 90) ? Number(form.lat) : null;
  const lon = coordValida(form.lon, 180) ? Number(form.lon) : null;
  const hayNombre = form.name.trim().length > 0;
  // Una coordenada a medio escribir no es un error; una escrita y fuera de
  // rango, sí, y se marca en el campo para no tener que adivinar cuál es.
  const latMal = form.lat.trim() !== '' && lat == null;
  const lonMal = form.lon.trim() !== '' && lon == null;
  // El punto para visitantes es opcional, pero si se empezó a cargar tiene que
  // quedar entero y a la distancia que pide el contrato.
  const latVisitante = coordValida(form.aterrizajeLat, 90) ? Number(form.aterrizajeLat) : null;
  const lonVisitante = coordValida(form.aterrizajeLon, 180) ? Number(form.aterrizajeLon) : null;
  const visitante = latVisitante != null && lonVisitante != null ? { lat: latVisitante, lon: lonVisitante } : null;
  const visitanteCargado = form.aterrizajeLat.trim() !== '' || form.aterrizajeLon.trim() !== '';
  const distanciaVisitante = visitante && lat != null && lon != null ? distanciaM({ lat, lon }, visitante) : null;
  const errorVisitante = problemaDelPuntoDeVisitantes(visitanteCargado, visitante, distanciaVisitante);
  const completo = hayNombre && lat != null && lon != null && errorVisitante === '';
  const faltante =
    queFalta(hayNombre, lat != null && lon != null) || (errorVisitante ? 'Revisá el punto para visitantes.' : '');

  function abrirAlta() {
    setEditando(null);
    setForm(VACIO);
    setMarcando('base');
    setErrorForm('');
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
    setErrorRutas('');
    setBusqueda('');
    setReciencreada(false);
    setElegidas([]);
    setAsignando(b);
    try {
      const [todas, asignadas] = await Promise.all([traerRutas(), rutasDeBase(b.id)]);
      setRutas(todas);
      setElegidas(asignadas.map((r) => r.id));
    } catch (e) {
      setErrorRutas(textoError(e));
    }
  }

  /** Guarda la asignación. Si el backend la rechaza, el diálogo queda abierto con el error adentro. */
  async function guardarRutas(b: BaseAsset) {
    setErrorRutas('');
    try {
      await api(`/bases/${b.id}/routes`, { method: 'PUT', body: JSON.stringify({ routeIds: elegidas }) });
    } catch (e) {
      setErrorRutas(textoError(e));
      return;
    }
    setAsignando(null);
    avisar(`Rutas de ${b.name} guardadas.`);
    await cargar();
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
      setLejana({ ruta, metros });
      return;
    }
    setElegidas((ids) => [...ids, ruta.id]);
  }

  function abrirEdicion(b: BaseAsset) {
    setEditando(b);
    setForm({
      name: b.name,
      lat: String(b.lat),
      lon: String(b.lon),
      // Un backend viejo no manda el punto: es lo mismo que no tenerlo.
      aterrizajeLat: b.aterrizajeLat == null ? '' : String(b.aterrizajeLat),
      aterrizajeLon: b.aterrizajeLon == null ? '' : String(b.aterrizajeLon),
    });
    setMarcando('base');
    setErrorForm('');
    setAbierto(true);
  }

  /**
   * El operador de campo está parado en la base cuando la da de alta: pedirle
   * las coordenadas al GPS es más rápido y más exacto que buscarla en el mapa.
   */
  function usarMiUbicacion() {
    if (!navigator.geolocation) {
      setErrorForm('Este dispositivo no informa su ubicación: marcá el punto en el mapa.');
      return;
    }
    setErrorForm('');
    setUbicando(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(6), lon: pos.coords.longitude.toFixed(6) }));
        setUbicando(false);
      },
      () => {
        setErrorForm('No se pudo leer la ubicación. Revisá el permiso del navegador o marcá el punto en el mapa.');
        setUbicando(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  /**
   * Con el pedido en viaje, cerrar ya no es "salir sin guardar": la base se
   * guarda igual, y al volver esto cerraría el diálogo que esté abierto en ese
   * momento —otro alta a medio escribir— y abriría las rutas de la primera.
   * Por eso Cancelar y la cruz se apagan, y Escape y el velo no cierran, hasta
   * que el backend conteste.
   */
  function cerrarFormulario() {
    if (!guardando) setAbierto(false);
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    // Con el botón apagado esto no debería pasar; cubre el Enter de un
    // navegador que igual intente mandar el formulario a medio completar.
    if (!completo) return;
    // En la edición el punto viaja siempre, nuevo o en null: el backend lo
    // controla contra la posición final de la base, y "sin cambios" con la
    // base movida podía dejarlo fuera de rango. En el alta, sin punto no va.
    const datos = { name: form.name.trim(), lat, lon };
    const punto = { aterrizajeLat: visitante?.lat ?? null, aterrizajeLon: visitante?.lon ?? null };
    const cuerpo = JSON.stringify(editando !== null || visitante !== null ? { ...datos, ...punto } : datos);
    setErrorForm('');
    setGuardando(true);
    let creada: BaseAsset | null = null;
    try {
      if (editando) await api(`/bases/${editando.id}`, { method: 'PATCH', body: cuerpo });
      else creada = await api<BaseAsset>('/bases', { method: 'POST', body: cuerpo });
    } catch (err) {
      setErrorForm(textoError(err));
      setGuardando(false);
      return;
    }
    // "Guardando" termina con el pedido, no con la recarga de la lista que
    // viene después: si no, un diálogo que se abra mientras la lista viaja
    // nacería con el botón apagado diciendo "Guardando…".
    setGuardando(false);
    setAbierto(false);
    avisar(creada ? `Base ${creada.name} dada de alta.` : `Cambios de ${form.name.trim()} guardados.`);
    if (creada) {
      // Alta: se guarda la base y recién ahí se eligen sus rutas, que es el
      // orden en que se piensa el problema (primero dónde está, después qué
      // patrulla).
      setElegidas([]);
      setErrorRutas('');
      setReciencreada(true);
      setAsignando(creada);
      setRutas(await traerRutas().catch(() => []));
    }
    await cargar();
  }

  const visibles = useMemo(() => bases, [bases]);

  return (
    <main className="page-main">
      <EncabezadoDeVista
        titulo="Bases"
        subtitulo={visibles.length > 0 ? resumenDeBases(visibles) : undefined}
        opciones={
          esSupervisor && (
            // Rótulo fijo y aria-pressed, como en Drones y Usuarios: antes este
            // era el único interruptor que no decía si estaba apretado.
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
            <button type="button" className="primario" onClick={abrirAlta}>
              <IconoMas tamano={18} />
              Nueva base
            </button>
          )
        }
      />

      {error && (
        <p className="aviso malo" role="alert">
          {error}
        </p>
      )}

      {/* El esqueleto sólo la primera vez: después de cada acción la lista se
          recarga, y el cartel de "Trayendo…" aparecía arriba de las bases y
          las empujaba para abajo y para arriba en cada clic. */}
      {visibles.length === 0 && (cargando || !error) && (
        <section className="card">
          {cargando ? (
            <EsqueletoDeTabla texto="Trayendo las bases…" />
          ) : (
            <EstadoVacio titulo="Todavía no hay bases dadas de alta." icono={<IconoBase tamano={46} />}>
              {puedeCrear
                ? 'Con «Nueva base» la das de alta: parado en el lugar, usá tu ubicación; si no, marcá el punto en el mapa.'
                : 'Las bases las dan de alta los operadores de campo y los supervisores; cuando haya alguna, va a aparecer acá.'}
            </EstadoVacio>
          )}
        </section>
      )}

      {visibles.length > 0 && (
        <ul className="fichas" aria-label="Bases dadas de alta" aria-busy={cargando || undefined}>
          {visibles.map((b) => (
            <FichaDeBase
              key={b.id}
              base={b}
              esSupervisor={esSupervisor}
              puedeCrear={puedeCrear}
              onEditar={() => abrirEdicion(b)}
              onRutas={() => void abrirRutas(b)}
              onAlternarActiva={() => alternarActiva(b)}
              onEliminar={() => pedirBaja(b)}
              onRestaurar={() =>
                void accion(() => api(`/bases/${b.id}/restore`, { method: 'POST' }), `Base ${b.name} restaurada.`)
              }
            />
          ))}
        </ul>
      )}

      {abierto && (
        <Modal etiquetadoPor="titulo-base" enfocarPrimerCampo onCerrar={cerrarFormulario}>
          <header className="modal-cabecera">
            <div>
              <h2 className="modal-titulo" id="titulo-base">
                {editando ? 'Editar base' : 'Nueva base'}
              </h2>
              <p className="modal-subtitulo">
                {editando ? editando.name : 'Después del alta elegís qué rutas patrulla'}
              </p>
            </div>
            <button
              type="button"
              className="modal-cerrar"
              aria-label="Cerrar"
              onClick={cerrarFormulario}
              disabled={guardando}
            >
              <IconoCerrar tamano={18} />
            </button>
          </header>
          <form className="modal-formulario" onSubmit={guardar} noValidate>
            <div className="modal-cuerpo form-base">
              {errorForm && (
                <p className="aviso malo" role="alert">
                  {errorForm}
                </p>
              )}
              <label className="campo">
                <span className="campo-rotulo">Nombre</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  maxLength={60}
                  aria-required="true"
                  autoComplete="off"
                />
              </label>

              <p className="muted">Marcá el punto en el mapa o escribí las coordenadas.</p>
              <div className="view-switch elector-de-punto" role="group" aria-label="Qué marca el clic en el mapa">
                <button
                  type="button"
                  className={marcando === 'base' ? 'active' : ''}
                  aria-pressed={marcando === 'base'}
                  onClick={() => setMarcando('base')}
                >
                  La base
                </button>
                <button
                  type="button"
                  className={marcando === 'visitantes' ? 'active' : ''}
                  aria-pressed={marcando === 'visitantes'}
                  onClick={() => setMarcando('visitantes')}
                >
                  El punto para visitantes
                </button>
              </div>
              <MapaElector
                lat={lat}
                lon={lon}
                visitante={visitante}
                acercar={marcando === 'visitantes'}
                onElegir={(la, lo) =>
                  setForm((f) =>
                    marcando === 'visitantes'
                      ? { ...f, aterrizajeLat: la.toFixed(6), aterrizajeLon: lo.toFixed(6) }
                      : { ...f, lat: la.toFixed(6), lon: lo.toFixed(6) },
                  )
                }
              />

              <div className="fila-coords">
                <label className="campo">
                  <span className="campo-rotulo">Latitud</span>
                  <input
                    value={form.lat}
                    onChange={(e) => setForm({ ...form, lat: e.target.value })}
                    inputMode="decimal"
                    aria-required="true"
                    aria-invalid={latMal}
                    aria-describedby={latMal ? 'error-coords-base' : undefined}
                  />
                </label>
                <label className="campo">
                  <span className="campo-rotulo">Longitud</span>
                  <input
                    value={form.lon}
                    onChange={(e) => setForm({ ...form, lon: e.target.value })}
                    inputMode="decimal"
                    aria-required="true"
                    aria-invalid={lonMal}
                    aria-describedby={lonMal ? 'error-coords-base' : undefined}
                  />
                </label>
                <button type="button" onClick={usarMiUbicacion} disabled={ubicando}>
                  {ubicando ? 'Ubicando…' : 'Usar mi ubicación'}
                </button>
              </div>
              {(latMal || lonMal) && (
                <p className="campo-error" id="error-coords-base">
                  La latitud va de -90 a 90 y la longitud de -180 a 180, en grados con punto decimal.
                </p>
              )}

              {/* Opcional: sin él, un dron que se desvía hasta esta base baja
                  15 m al norte del punto de la base (RELEVOS §0). */}
              <fieldset className="campo-grupo">
                <legend>Punto de aterrizaje para visitantes (opcional)</legend>
                <p className="muted">
                  Dónde baja un dron que se desvía desde otra base: un lugar libre, a 10 m o más de toda plataforma, y a
                  entre {VISITANTES_MINIMO_M} y {VISITANTES_MAXIMO_M} m de la base. Sin este punto, baja 15 m al norte
                  de la base.
                </p>
                <div className="fila-coords">
                  <label className="campo">
                    <span className="campo-rotulo">Latitud para visitantes</span>
                    <input
                      value={form.aterrizajeLat}
                      onChange={(e) => setForm({ ...form, aterrizajeLat: e.target.value })}
                      inputMode="decimal"
                      aria-invalid={errorVisitante !== ''}
                      aria-describedby={errorVisitante ? 'error-visitantes-base' : undefined}
                    />
                  </label>
                  <label className="campo">
                    <span className="campo-rotulo">Longitud para visitantes</span>
                    <input
                      value={form.aterrizajeLon}
                      onChange={(e) => setForm({ ...form, aterrizajeLon: e.target.value })}
                      inputMode="decimal"
                      aria-invalid={errorVisitante !== ''}
                      aria-describedby={errorVisitante ? 'error-visitantes-base' : undefined}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, aterrizajeLat: '', aterrizajeLon: '' }))}
                    disabled={!visitanteCargado}
                  >
                    Quitar el punto
                  </button>
                </div>
                {errorVisitante ? (
                  <p className="campo-error" id="error-visitantes-base">
                    {errorVisitante}
                  </p>
                ) : (
                  distanciaVisitante !== null && (
                    <p className="muted" data-testid="distancia-visitantes">{`A ${metros(distanciaVisitante)} de la base.`}</p>
                  )
                )}
              </fieldset>
            </div>

            <footer className="modal-pie">
              {faltante && <p className="pie-nota">{faltante}</p>}
              <button type="button" onClick={cerrarFormulario} disabled={guardando}>
                Cancelar
              </button>
              <button type="submit" className="primario" disabled={!completo || guardando}>
                {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Dar de alta'}
              </button>
            </footer>
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
              <IconoCerrar tamano={18} />
            </button>
          </header>
          <div className="modal-cuerpo form-base">
            {errorRutas && (
              <p className="aviso malo" role="alert">
                {errorRutas}
              </p>
            )}
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
            <button type="button" onClick={() => setAsignando(null)}>
              {reciencreada ? 'Después' : 'Cancelar'}
            </button>
            <button type="button" className="primario" onClick={() => guardarRutas(asignando)}>
              {rotuloDeAsignacion(elegidas.length)}
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

      {/* No borra nada, pero es la misma pregunta con la misma forma: qué
          pasa si sí, y las dos salidas dichas con su verbo. */}
      {lejana && (
        <DialogoConfirmacion
          pedido={{
            titulo: 'La ruta queda lejos de la base',
            consecuencia: (
              <>
                El primer nodo de <strong>{lejana.ruta.name}</strong> está a{' '}
                <strong>{(lejana.metros / 1000).toFixed(1)} km</strong> de la base. El dron va a gastar esa
                ida y esa vuelta de su autonomía antes de empezar a patrullar.
              </>
            ),
            detalle: '¿Querés asignarla igual?',
            confirmar: 'Asignarla igual',
            cancelar: 'No asignarla',
            tono: 'primario',
            accion: () => setElegidas((ids) => [...ids, lejana.ruta.id]),
          }}
          onCerrar={() => setLejana(null)}
        />
      )}

      {pedido && <DialogoConfirmacion pedido={pedido} onCerrar={() => setPedido(null)} />}
    </main>
  );
}
