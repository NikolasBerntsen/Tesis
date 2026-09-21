import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DronesMap, { type MapItem } from './DronesMap';
import type { DroneStatus, PatrolRoute } from '../types';

/*
 * Leaflet no corre en jsdom: no hay canvas, ni teselas, ni tamaño de
 * contenedor. El doble de abajo no lo imita por completo — imita lo que este
 * componente le pide: crear capas, moverlas, sacarlas, y devolver el elemento
 * del globo para que el formulario de apodo se pueda escribir de verdad.
 *
 * Con eso alcanza para probar lo que importa acá, que no es Leaflet sino las
 * decisiones del componente: cuándo se dibuja el cono de la cámara, cuándo se
 * muestra la línea a la base, qué pasa cuando un dron deja de reportar, y —lo
 * más delicado— que un nombre de dron con HTML adentro no se inyecte en el
 * globo.
 */

interface CapaFalsa {
  tipo: string;
  enMapa: boolean;
  pos: unknown;
  puntos: unknown;
  estilo: Record<string, unknown>;
  icono: unknown;
  htmlGlobo: string | null;
  tooltip: string | null;
  tooltipPos: unknown;
  globoAbierto: boolean;
  handlers: Record<string, () => void>;
  [k: string]: unknown;
}

const { estado } = vi.hoisted(() => ({
  estado: {
    agregadas: [] as string[],
    quitadas: [] as string[],
    creadas: [] as string[],
    capas: [] as CapaFalsa[],
    encuadres: 0,
  },
}));

vi.mock('leaflet', () => {
  // `vestir` usa style.setProperty: el doble necesita un elemento de verdad.
  const paneFalso = document.createElement('div');

  function nuevaCapa(tipo: string, extra: Partial<CapaFalsa> = {}): CapaFalsa {
    const capa: CapaFalsa = {
      tipo,
      enMapa: false,
      pos: null,
      puntos: null,
      estilo: {},
      icono: null,
      htmlGlobo: null,
      tooltip: null,
      tooltipPos: null,
      globoAbierto: false,
      handlers: {},
      ...extra,
      addTo() {
        capa.enMapa = true;
        return capa;
      },
      remove() {
        capa.enMapa = false;
        return capa;
      },
      setLatLng(p: unknown) {
        capa.pos = p;
        return capa;
      },
      setLatLngs(p: unknown) {
        capa.puntos = p;
        return capa;
      },
      setStyle(s: Record<string, unknown>) {
        Object.assign(capa.estilo, s);
        return capa;
      },
      setIcon(i: unknown) {
        capa.icono = i;
        return capa;
      },
      on(evento: string, cb: () => void) {
        capa.handlers[evento] = cb;
        return capa;
      },
      // --- globo
      bindPopup(html: string) {
        capa.htmlGlobo = html;
        return capa;
      },
      setPopupContent(html: string) {
        capa.htmlGlobo = html;
        return capa;
      },
      getPopup() {
        if (capa.htmlGlobo === null) return null;
        return {
          getElement() {
            // El elemento tiene que ser de verdad: wireWaypointForm busca
            // adentro con querySelector y le cuelga handlers.
            if (!capa.elementoGlobo) {
              const div = document.createElement('div');
              capa.elementoGlobo = div;
            }
            const div = capa.elementoGlobo as HTMLElement;
            div.innerHTML = capa.htmlGlobo as string;
            return div;
          },
        };
      },
      isPopupOpen: () => capa.globoAbierto,
      closePopup() {
        capa.globoAbierto = false;
        capa.handlers.popupclose?.();
        return capa;
      },
      // --- etiqueta
      bindTooltip(texto: string) {
        capa.tooltip = texto;
        return capa;
      },
      setTooltipContent(texto: string) {
        capa.tooltip = texto;
        return capa;
      },
      getTooltip() {
        if (capa.tooltip === null) return null;
        return {
          setContent(t: string) {
            capa.tooltip = t;
          },
          setLatLng(p: unknown) {
            capa.tooltipPos = p;
          },
        };
      },
    };
    estado.capas.push(capa);
    return capa;
  }

  const mapa = {
    setView: () => mapa,
    on: () => mapa,
    off: () => mapa,
    remove: vi.fn(),
    getPane: () => paneFalso,
    removeLayer: (capa: { nombre: string }) => estado.quitadas.push(capa.nombre),
    addControl: vi.fn(),
    removeControl: vi.fn(),
    addLayer: vi.fn(),
    fitBounds: () => {
      estado.encuadres += 1;
    },
    getZoom: () => 15,
    // Distancia de mentira pero estable: alcanza para ver el texto de la etiqueta.
    distance: () => 1234,
    attributionControl: { setPrefix: vi.fn(), getContainer: () => paneFalso },
  };

  function capaDeFondo(url: string) {
    const nombre = url.includes('arcgis') ? 'satelite' : 'mapa';
    estado.creadas.push(nombre);
    return { nombre, addTo: () => estado.agregadas.push(nombre) };
  }

  return {
    default: {
      map: () => mapa,
      tileLayer: capaDeFondo,
      divIcon: (opts: { html?: string }) => ({ html: opts?.html ?? '' }),
      marker: (pos: unknown, opts: { icon?: unknown } = {}) => nuevaCapa('marker', { pos, icono: opts.icon ?? null }),
      polyline: (puntos: unknown, estilo: Record<string, unknown>) => nuevaCapa('polyline', { puntos, estilo: { ...estilo } }),
      circleMarker: (pos: unknown, estilo: Record<string, unknown>) =>
        nuevaCapa('circleMarker', { pos, estilo: { ...estilo } }),
      polygon: (puntos: unknown, estilo: Record<string, unknown>) => nuevaCapa('polygon', { puntos, estilo: { ...estilo } }),
      Control: class {
        onAdd = () => paneFalso;
        addTo = () => this;
        remove = () => this;
      },
      DomUtil: { create: () => paneFalso },
      DomEvent: { disableClickPropagation: vi.fn(), disableScrollPropagation: vi.fn(), on: vi.fn() },
      latLngBounds: () => ({ isValid: () => true, pad: () => ({}) }),
    },
  };
});

/* --- Datos de prueba ------------------------------------------------------ */

const BASE = { name: 'Base Obelisco', lat: -34.6037, lon: -58.3816 };

function status(over: Partial<DroneStatus> = {}): DroneStatus {
  return {
    droneId: 'd1',
    displayName: 'Alfa',
    state: 'ORBITING',
    battery: 80,
    lat: -34.6,
    lon: -58.38,
    routeId: null,
    waypointIndex: 0,
    waypointTotal: 0,
    signal: 'OK',
    signalPct: 90,
    mode: 'DEPLOY',
    ...over,
  };
}

function item(over: Partial<MapItem> = {}): MapItem {
  return { droneId: 'd1', displayName: 'Alfa', base: BASE, status: status(), ...over };
}

function ruta(over: Partial<PatrolRoute> = {}): PatrolRoute {
  return {
    id: 7,
    name: 'Perímetro',
    description: '',
    waypoints: [
      { lat: -34.601, lon: -58.384, alt: 40 },
      { lat: -34.601, lon: -58.379, alt: 40, label: 'Cerrito' },
      { lat: -34.606, lon: -58.379, alt: 40 },
    ],
    createdBy: null,
    deleted: false,
    deletedAt: null,
    ...over,
  } as PatrolRoute;
}

/** Las capas de un tipo que están puestas en el mapa ahora mismo. */
const enMapa = (tipo: string) => estado.capas.filter((c) => c.tipo === tipo && c.enMapa);
const todas = (tipo: string) => estado.capas.filter((c) => c.tipo === tipo);

beforeEach(() => {
  estado.agregadas.length = 0;
  estado.quitadas.length = 0;
  estado.creadas.length = 0;
  estado.capas.length = 0;
  estado.encuadres = 0;
});

describe('DronesMap — fondo del mapa', () => {
  it('arranca en el mapa callejero y ofrece el satélite', () => {
    render(<DronesMap items={[]} />);
    // las dos capas se crean una sola vez; sólo una se muestra
    expect(estado.creadas.sort()).toEqual(['mapa', 'satelite']);
    expect(estado.agregadas).toEqual(['mapa']);

    expect(screen.getByRole('button', { name: 'Mapa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Satélite' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('cambiar a satélite intercambia la capa sin recrear el mapa', async () => {
    render(<DronesMap items={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));

    expect(estado.agregadas).toContain('satelite');
    expect(estado.quitadas).toContain('mapa');
    // no se crearon capas nuevas: se reusan las dos de siempre
    expect(estado.creadas).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Satélite' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('se puede volver al callejero', async () => {
    render(<DronesMap items={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Satélite' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mapa' }));

    expect(estado.quitadas).toContain('satelite');
    expect(screen.getByRole('button', { name: 'Mapa' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('DronesMap — drones y bases', () => {
  it('dibuja la base y el dron de cada item', () => {
    render(<DronesMap items={[item()]} />);

    // Dos marcadores: la base y el dron.
    expect(enMapa('marker')).toHaveLength(2);
    const globos = enMapa('marker').map((m) => m.htmlGlobo as string);
    expect(globos.some((h) => h.includes('Base Obelisco'))).toBe(true);
    expect(globos.some((h) => h.includes('Alfa'))).toBe(true);
  });

  it('mover el dron reposiciona el marcador en vez de crear otro', () => {
    const { rerender } = render(<DronesMap items={[item()]} />);
    const antes = todas('marker').length;

    rerender(<DronesMap items={[item({ status: status({ lat: -34.59, lon: -58.37 }) })]} />);

    expect(todas('marker')).toHaveLength(antes);
    const dron = todas('marker')[1];
    expect(dron.pos).toEqual([-34.59, -58.37]);
  });

  it('renombrar el dron le cambia el ícono', () => {
    const { rerender } = render(<DronesMap items={[item()]} />);
    const dron = todas('marker')[1];
    const iconoInicial = dron.icono;

    rerender(<DronesMap items={[item({ displayName: 'Alfa-2' })]} />);

    // El ícono muestra las iniciales, no el nombre entero.
    expect(dron.icono).not.toBe(iconoInicial);
    expect((dron.icono as { html: string }).html).not.toBe((iconoInicial as { html: string }).html);
  });

  it('un dron que deja de reportar pierde su marcador, su línea y su cono', () => {
    const { rerender } = render(
      <DronesMap items={[item({ status: status({ heading: 90 }) })]} alwaysShowLine />,
    );
    expect(enMapa('polygon')).toHaveLength(1); // el cono
    expect(enMapa('polyline')).toHaveLength(1); // la línea a la base

    rerender(<DronesMap items={[item({ status: null })]} alwaysShowLine />);

    // La base queda (el activo sigue existiendo); lo del dron se va.
    expect(enMapa('polygon')).toHaveLength(0);
    expect(enMapa('polyline')).toHaveLength(0);
    expect(enMapa('marker')).toHaveLength(1);
    expect((enMapa('marker')[0].htmlGlobo as string)).toContain('Base Obelisco');
  });

  it('un dron que desaparece de la lista se lleva todas sus capas', () => {
    const { rerender } = render(<DronesMap items={[item()]} />);
    expect(enMapa('marker')).toHaveLength(2);

    rerender(<DronesMap items={[]} />);

    expect(enMapa('marker')).toHaveLength(0);
  });

  describe('cono de visión de la cámara', () => {
    it('se dibuja cuando el dron vuela y hay rumbo', () => {
      render(<DronesMap items={[item({ status: status({ heading: 45, state: 'ORBITING' }) })]} />);
      expect(enMapa('polygon')).toHaveLength(1);
    });

    it('no se dibuja sin rumbo', () => {
      render(<DronesMap items={[item({ status: status({ heading: undefined }) })]} />);
      expect(enMapa('polygon')).toHaveLength(0);
    });

    it.each(['IDLE', 'LANDED'])('no se dibuja con el dron en tierra (%s)', (state) => {
      render(<DronesMap items={[item({ status: status({ heading: 45, state }) })]} />);
      expect(enMapa('polygon')).toHaveLength(0);
    });

    it('se saca al aterrizar y el cono no queda flotando', () => {
      const { rerender } = render(<DronesMap items={[item({ status: status({ heading: 45 }) })]} />);
      expect(enMapa('polygon')).toHaveLength(1);

      rerender(<DronesMap items={[item({ status: status({ heading: 45, state: 'LANDED' }) })]} />);

      expect(enMapa('polygon')).toHaveLength(0);
    });

    it('girando, mueve el cono existente en vez de apilar polígonos', () => {
      const { rerender } = render(<DronesMap items={[item({ status: status({ heading: 0 }) })]} />);
      const cono = todas('polygon')[0];
      const antes = cono.puntos;

      rerender(<DronesMap items={[item({ status: status({ heading: 180 }) })]} />);

      expect(todas('polygon')).toHaveLength(1);
      expect(cono.puntos).not.toEqual(antes);
    });
  });

  describe('línea del dron a su base', () => {
    it('queda oculta mientras nadie mira ese dron', () => {
      render(<DronesMap items={[item()]} />);
      expect(todas('polyline')).toHaveLength(1);
      expect(enMapa('polyline')).toHaveLength(0);
    });

    it('con alwaysShowLine se muestra, con la distancia escrita', () => {
      render(<DronesMap items={[item()]} alwaysShowLine />);
      const linea = todas('polyline')[0];
      expect(linea.enMapa).toBe(true);
      expect(linea.tooltip).toBeTruthy();
    });

    it('la etiqueta de distancia se recoloca al moverse el dron, no se duplica', () => {
      const { rerender } = render(<DronesMap items={[item()]} alwaysShowLine />);
      const linea = todas('polyline')[0];
      expect(linea.tooltipPos).toBeNull();

      rerender(<DronesMap items={[item({ status: status({ lat: -34.55, lon: -58.3 }) })]} alwaysShowLine />);

      expect(todas('polyline')).toHaveLength(1);
      expect(linea.tooltipPos).not.toBeNull();
    });

    it('abrir el globo del dron muestra su línea, y cerrarlo la vuelve a ocultar', () => {
      render(<DronesMap items={[item()]} />);
      const dron = todas('marker')[1];
      const linea = todas('polyline')[0];

      dron.handlers.popupopen();
      expect(linea.enMapa).toBe(true);

      dron.handlers.popupclose();
      expect(linea.enMapa).toBe(false);
    });
  });

  it('encuadra una sola vez: después no le pelea el zoom al operador', () => {
    const { rerender } = render(<DronesMap items={[item()]} />);
    expect(estado.encuadres).toBe(1);

    rerender(<DronesMap items={[item({ status: status({ lat: -34.4, lon: -58.1 }) })]} />);

    expect(estado.encuadres).toBe(1);
  });

  // El nombre del dron lo escribe una persona desde la consola y termina
  // adentro del HTML del globo. Si no se escapa, alcanza con llamar a un dron
  // `<img onerror>` para ejecutar código en la sesión de quien mire el mapa.
  it('un nombre con HTML adentro se escapa en vez de inyectarse', () => {
    const malicioso = '<img src=x onerror="alert(1)">';
    render(<DronesMap items={[item({ displayName: malicioso, status: status({ displayName: malicioso }) })]} />);

    const globo = todas('marker')[1].htmlGlobo as string;
    expect(globo).not.toContain('<img');
    // Se escapa con entidades numéricas: `<` queda como `&#60;`.
    expect(globo).toContain('&#60;img');
    expect(globo).not.toContain('onerror="alert(1)"');
    // Y el HTML del globo, puesto en el DOM, no crea ningún elemento.
    const caja = document.createElement('div');
    caja.innerHTML = globo;
    expect(caja.querySelector('img')).toBeNull();
  });
});

describe('DronesMap — nodos de la ruta', () => {
  const capaDeNodos = (over = {}) => ({ route: ruta(), visitedIndex: -1, onLabel: vi.fn(), ...over });

  it('pone un marcador por nodo', () => {
    render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
    expect(enMapa('circleMarker')).toHaveLength(3);
  });

  it('pinta de visitado hasta el índice recorrido y deja el resto pendiente', () => {
    render(<DronesMap items={[]} waypoints={capaDeNodos({ visitedIndex: 1 })} />);
    const colores = todas('circleMarker').map((m) => m.estilo.fillColor);

    expect(colores[0]).toBe(colores[1]); // los dos visitados
    expect(colores[2]).not.toBe(colores[0]); // el pendiente, distinto
  });

  it('en vista previa todos van del mismo color, sin importar el recorrido', () => {
    render(<DronesMap items={[]} waypoints={capaDeNodos({ visitedIndex: 1, preview: true })} />);
    const colores = todas('circleMarker').map((m) => m.estilo.fillColor);
    expect(new Set(colores).size).toBe(1);
  });

  it('avanzar de nodo no recrea los marcadores: reusa los mismos', () => {
    const { rerender } = render(<DronesMap items={[]} waypoints={capaDeNodos({ visitedIndex: 0 })} />);
    const creados = todas('circleMarker').length;

    rerender(<DronesMap items={[]} waypoints={capaDeNodos({ visitedIndex: 2 })} />);

    expect(todas('circleMarker')).toHaveLength(creados);
  });

  it('cambiar de ruta sí los recrea', () => {
    const { rerender } = render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
    const primeros = todas('circleMarker').length;

    rerender(<DronesMap items={[]} waypoints={capaDeNodos({ route: ruta({ id: 9 }) })} />);

    expect(todas('circleMarker').length).toBeGreaterThan(primeros);
    expect(enMapa('circleMarker')).toHaveLength(3);
  });

  it('quitar la capa saca los nodos del mapa', () => {
    const { rerender } = render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
    rerender(<DronesMap items={[]} waypoints={null} />);
    expect(enMapa('circleMarker')).toHaveLength(0);
  });

  it('el apodo del nodo viaja a la etiqueta', () => {
    render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
    const etiquetas = todas('circleMarker').map((m) => m.tooltip as string);
    expect(etiquetas[1]).toContain('Cerrito');
  });

  describe('formulario de apodo del globo', () => {
    /** Abre el globo del nodo `i` y devuelve su elemento ya cableado. */
    function abrirGlobo(i: number) {
      const marcador = todas('circleMarker')[i];
      marcador.globoAbierto = true;
      marcador.handlers.popupopen();
      return { marcador, el: marcador.elementoGlobo as HTMLElement };
    }

    it('arranca en modo lectura aunque el globo se reuse', () => {
      render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
      const { el } = abrirGlobo(1);
      expect(el.querySelector('.wp-popup')!.classList.contains('editando')).toBe(false);
    });

    it('el lápiz abre la edición y, apretado de nuevo, la cancela', () => {
      render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
      const { el } = abrirGlobo(1);
      const raiz = el.querySelector('.wp-popup') as HTMLElement;
      const lapiz = el.querySelector('.wp-edit') as HTMLButtonElement;

      lapiz.onclick!(new MouseEvent('click'));
      expect(raiz.classList.contains('editando')).toBe(true);

      lapiz.onclick!(new MouseEvent('click'));
      expect(raiz.classList.contains('editando')).toBe(false);
    });

    it('guardar avisa el apodo nuevo y cierra el globo', () => {
      const capa = capaDeNodos();
      render(<DronesMap items={[]} waypoints={capa} />);
      const { marcador, el } = abrirGlobo(0);

      const input = el.querySelector('.wp-alias') as HTMLInputElement;
      input.value = '  Portón  ';
      (el.querySelector('.wp-save') as HTMLButtonElement).onclick!(new MouseEvent('click'));

      // Se recorta al guardar: un apodo con espacios al costado no es otro apodo.
      expect(capa.onLabel).toHaveBeenCalledWith(0, 'Portón');
      expect(marcador.globoAbierto).toBe(false);
    });

    it('Enter guarda y Escape descarta lo tipeado', () => {
      const capa = capaDeNodos();
      render(<DronesMap items={[]} waypoints={capa} />);
      const { el } = abrirGlobo(1);
      const input = el.querySelector('.wp-alias') as HTMLInputElement;

      input.value = 'Otro nombre';
      input.onkeydown!(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(capa.onLabel).not.toHaveBeenCalled();
      // Vuelve al que ya tenía, no queda el tipeado a medias.
      expect(input.value).toBe('Cerrito');

      input.value = 'Definitivo';
      input.onkeydown!(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(capa.onLabel).toHaveBeenCalledWith(1, 'Definitivo');
    });

    it('sin autorización de control no aparecen las acciones de vuelo', () => {
      render(<DronesMap items={[]} waypoints={capaDeNodos()} />);
      const { el } = abrirGlobo(0);
      expect(el.querySelector('.wp-force')).toBeNull();
      expect(el.querySelector('.wp-continue')).toBeNull();
    });

    it('"Forzar ruta" manda el índice del nodo y cierra el globo', () => {
      const onForce = vi.fn();
      render(<DronesMap items={[]} waypoints={capaDeNodos({ canForce: true, onForce })} />);
      const { marcador, el } = abrirGlobo(2);

      (el.querySelector('.wp-force') as HTMLButtonElement).onclick!(new MouseEvent('click'));

      expect(onForce).toHaveBeenCalledWith(2);
      expect(marcador.globoAbierto).toBe(false);
    });

    it('"Continuar desde acá" hace lo propio', () => {
      const onContinue = vi.fn();
      render(<DronesMap items={[]} waypoints={capaDeNodos({ canContinue: true, onContinue })} />);
      const { el } = abrirGlobo(1);

      (el.querySelector('.wp-continue') as HTMLButtonElement).onclick!(new MouseEvent('click'));

      expect(onContinue).toHaveBeenCalledWith(1);
    });

    it('un apodo con HTML adentro tampoco se inyecta en el globo', () => {
      const malicioso = '<b onmouseover="robar()">x</b>';
      const r = ruta();
      r.waypoints[0] = { ...r.waypoints[0], label: malicioso };
      render(<DronesMap items={[]} waypoints={capaDeNodos({ route: r })} />);

      const globo = todas('circleMarker')[0].htmlGlobo as string;
      expect(globo).not.toContain('<b onmouseover');
      expect(globo).toContain('&#60;b');
      const caja = document.createElement('div');
      caja.innerHTML = globo;
      expect(caja.querySelector('b')).toBeNull();
    });
  });
});
