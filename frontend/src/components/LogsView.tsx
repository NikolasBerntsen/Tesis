import { useEffect, useState, type KeyboardEvent } from 'react';
import { TAMANIOS_PAGINA, TAMANIO_PAGINA_POR_DEFECTO, traerLogs, type ParametrosLogs } from '../api';
import { time } from '../format';
import type { EventRow, PaginaLogs, TamanioPagina } from '../types';
import LogDetailModal from './LogDetailModal';

type Categoria = NonNullable<ParametrosLogs['category']>;

const PESTANIAS: { clave: Categoria; rotulo: string }[] = [
  { clave: '', rotulo: 'Todos' },
  { clave: 'drone', rotulo: 'Drones' },
  { clave: 'usuarios', rotulo: 'Usuarios' },
  { clave: 'sistema', rotulo: 'Sistema' },
];

const CATEGORIA: Record<EventRow['category'], string> = {
  drone: 'Drones',
  usuarios: 'Usuarios',
  sistema: 'Sistema',
};

/* Flecha circular: gira mientras el pedido está en vuelo (clase .girando). */
const FLECHA_CIRCULAR = (
  <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    <path d="M23 4v6h-6" />
  </svg>
);

function paginaVacia(pageSize: TamanioPagina, page: number): PaginaLogs {
  return { items: [], total: 0, page, pageSize };
}

/**
 * Registro general del sistema (solo admin). El filtrado, el conteo y el corte
 * en páginas los hace el backend: la vista nunca tiene la lista entera en
 * memoria, así que crecer el historial no la vuelve más lenta.
 */
export default function LogsView() {
  const [categoria, setCategoria] = useState<Categoria>('');
  const [pagina, setPagina] = useState(1);
  const [tamanio, setTamanio] = useState<TamanioPagina>(TAMANIO_PAGINA_POR_DEFECTO);
  const [datos, setDatos] = useState<PaginaLogs>(paginaVacia(TAMANIO_PAGINA_POR_DEFECTO, 1));
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [recarga, setRecarga] = useState(0);
  const [abierta, setAbierta] = useState<EventRow | null>(null);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    traerLogs({ category: categoria, page: pagina, pageSize: tamanio })
      .then((p) => {
        if (!vigente) return;
        setDatos(p);
        setError('');
      })
      .catch((e) => {
        if (!vigente) return;
        setDatos(paginaVacia(tamanio, pagina));
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    // La respuesta que llega tarde es de una página que ya nadie está mirando.
    return () => {
      vigente = false;
    };
  }, [categoria, pagina, tamanio, recarga]);

  const paginas = Math.max(1, Math.ceil(datos.total / tamanio));
  // El total puede haber encogido desde el último pedido (otro admin filtrando,
  // una purga): mostrar "página 7 de 3" sería mentir.
  const actual = Math.min(pagina, paginas);
  const enLaPrimera = pagina <= 1;
  const enLaUltima = pagina >= paginas;

  function irA(destino: number) {
    setPagina(Math.min(Math.max(destino, 1), paginas));
  }

  function cambiarPestania(clave: Categoria) {
    setCategoria(clave);
    setPagina(1);
  }

  function cambiarTamanio(valor: string) {
    const numero = Number(valor);
    setTamanio(TAMANIOS_PAGINA.find((t) => t === numero) ?? TAMANIO_PAGINA_POR_DEFECTO);
    setPagina(1);
  }

  function abrirConTeclado(ev: KeyboardEvent<HTMLDivElement>, fila: EventRow) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault(); // el espacio, si no, scrollea la lista
    setAbierta(fila);
  }

  return (
    /* .page-main es `flex: 1` con base 0%, y contra un alto indefinido (el
       .dashboard sólo fija min-height) ese 0% se resuelve como el contenido: la
       vista crecía y scrolleaba la página entera. Con la base en 0px el main se
       queda con el alto sobrante exacto y el que scrollea es .vista-alta-cuerpo. */
    <main className="page-main" style={{ flexBasis: 0 }}>
      <section className="card vista-alta">
        <div className="log-head">
          <h2>Registro del sistema</h2>
          <div className="barra-acciones">
            <label className="etiqueta">
              Por página{' '}
              <select value={tamanio} onChange={(e) => cambiarTamanio(e.target.value)}>
                {TAMANIOS_PAGINA.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={cargando ? 'icono-boton girando' : 'icono-boton'}
              aria-label="Actualizar"
              title="Actualizar"
              onClick={() => setRecarga((n) => n + 1)}
            >
              {FLECHA_CIRCULAR}
            </button>
          </div>
        </div>

        <div className="tabs" role="tablist">
          {PESTANIAS.map((p) => (
            <button
              key={p.clave}
              id={`pestania-${p.clave || 'todos'}`}
              type="button"
              role="tab"
              aria-selected={categoria === p.clave}
              className={categoria === p.clave ? 'active' : ''}
              onClick={() => cambiarPestania(p.clave)}
            >
              {p.rotulo}
            </button>
          ))}
        </div>

        <div className="vista-alta-cuerpo" role="tabpanel" aria-labelledby={`pestania-${categoria || 'todos'}`}>
          {error && <p className="aviso malo">No se pudo traer el registro: {error}</p>}
          {!error && datos.items.length === 0 && !cargando && <p className="vacio">Sin registros.</p>}
          {datos.items.length > 0 && (
            <div className="log">
              {datos.items.map((l) => (
                <div
                  key={l.id}
                  className="log-row log-row-general cliqueable"
                  role="button"
                  tabIndex={0}
                  aria-label={`Ver el detalle de ${l.type}: ${l.message}`}
                  onClick={() => setAbierta(l)}
                  onKeyDown={(ev) => abrirConTeclado(ev, l)}
                >
                  <span className="muted mono">{time(l.ts)}</span>
                  <span className={`cat-badge cat-${l.category}`}>{CATEGORIA[l.category]}</span>
                  <span className="event-type mono">{l.type}</span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <nav className="paginador" aria-label="Paginación">
          <div className="paginador-botones">
            <button type="button" className="chico" disabled={enLaPrimera} onClick={() => irA(1)}>
              Primera
            </button>
            <button type="button" className="chico" disabled={enLaPrimera} onClick={() => irA(pagina - 1)}>
              Anterior
            </button>
          </div>
          <span className="paginador-info" aria-live="polite">
            Página <strong>{actual}</strong> de <strong>{paginas}</strong> · <strong>{datos.total}</strong>{' '}
            {datos.total === 1 ? 'registro' : 'registros'}
          </span>
          <div className="paginador-botones">
            <button type="button" className="chico" disabled={enLaUltima} onClick={() => irA(pagina + 1)}>
              Siguiente
            </button>
            <button type="button" className="chico" disabled={enLaUltima} onClick={() => irA(paginas)}>
              Última
            </button>
          </div>
        </nav>
      </section>

      {abierta && <LogDetailModal fila={abierta} onCerrar={() => setAbierta(null)} />}
    </main>
  );
}
