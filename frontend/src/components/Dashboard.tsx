import { useMemo, useState } from 'react';
import type { RastroObjetivo } from '../rastro';
import type { Alert, Drone, DroneStatus, Relevo } from '../types';
import type { DecidirAlerta } from '../useDecisionDeAlerta';
import AlertaEnCurso from './AlertaEnCurso';
import CameraTile from './CameraTile';
import DronesMap, { type MapItem } from './DronesMap';
import EncabezadoDeVista from './EncabezadoDeVista';
import { EstadoVacio } from './EstadosDeVista';

// Fijo y no `{}` en la firma: un objeto nuevo en cada render rehacía los
// items del mapa en cada render, y el mapa los redibuja cuando cambian.
const SIN_RASTROS: Record<string, RastroObjetivo> = {};
const SIN_RELEVOS: readonly Relevo[] = [];

export default function Dashboard({
  drones,
  statuses,
  frames,
  alerts,
  pendingAlerts,
  relevos = SIN_RELEVOS,
  rastros = SIN_RASTROS,
  onDecidir,
  onOpenDrone,
  onRename,
}: {
  drones: Drone[];
  statuses: Record<string, DroneStatus>;
  frames: Record<string, string>;
  alerts: Alert[];
  pendingAlerts: Record<string, number>;
  /** Los relevos que conoce la consola: de acá salen las insignias de cada mosaico. */
  relevos?: readonly Relevo[];
  /** Rastro del objetivo de cada dron que está sobre uno (ver rastro.ts). */
  rastros?: Record<string, RastroObjetivo>;
  /** Validar o descartar desde el tablero, con el mismo camino que la campana. */
  onDecidir: DecidirAlerta;
  onOpenDrone: (droneId: string) => void;
  onRename: (droneId: string, displayName: string) => void;
}) {
  const [view, setView] = useState<'cameras' | 'map'>('cameras');
  const active = drones.filter((d) => d.online);
  // "En vuelo" quiere decir en el aire: un dron conectado y apoyado en su base
  // tiene cámara para mostrar, pero contarlo como volando era lo mismo que el
  // "En vuelo" del detalle con el dron en el suelo. Sin el dato (`flying` no
  // viene de una app vieja) se lo cuenta, como antes.
  const enVuelo = active.filter((d) => statuses[d.droneId]?.flying !== false);

  const items = useMemo<MapItem[]>(
    () =>
      drones.map((d) => ({
        droneId: d.droneId,
        displayName: d.displayName,
        base: d.base,
        status: statuses[d.droneId] ?? null,
        // El mapa de la flota también muestra hacia dónde se fue cada objetivo:
        // con dos drones sobre dos objetivos, es la vista que reparte la gente.
        rastroObjetivo: rastros[d.droneId]?.puntos,
      })),
    [drones, statuses, rastros],
  );

  // Las pendientes de toda la flota, una por vez y con flechas para recorrerlas.
  // Antes era una franja de chips que cortaba en cuatro ("+2 más") y no dejaba
  // ver la captura de ninguna: para saber si valía la pena ir al dron había que
  // ir. Ahora cada una muestra su captura, de qué dron es y el camino a su vista.
  const pendientes = useMemo(() => alerts.filter((a) => a.status === 'PENDING'), [alerts]);
  // Qué alertas tienen un dron encima de su objetivo: la tarjeta lo dice, como
  // en la vista del dron, porque ahí la comparación con el video es inmediata.
  const seguidas = useMemo(
    () => Object.values(statuses).flatMap((s) => (s.target ? [s.target.alertId] : [])),
    [statuses],
  );

  return (
    <main className="dashboard-main">
      {/* La misma cabecera que el resto de las vistas: el título, el conteo de
          la flota al lado, y a la derecha cómo se la mira. */}
      <EncabezadoDeVista
        titulo="Operación"
        subtitulo={`${enVuelo.length} en vuelo · ${drones.length} ${drones.length === 1 ? 'registrado' : 'registrados'}`}
        opciones={
          <div className="view-switch" role="group" aria-label="Cómo ver la flota">
            <button
              type="button"
              className={view === 'cameras' ? 'active' : ''}
              aria-pressed={view === 'cameras'}
              onClick={() => setView('cameras')}
            >
              Cámaras
            </button>
            <button
              type="button"
              className={view === 'map' ? 'active' : ''}
              aria-pressed={view === 'map'}
              onClick={() => setView('map')}
            >
              Mapa
            </button>
          </div>
        }
      />

      {/* La alerta va pegada debajo de la cabecera, arriba de las cámaras:
          es lo único del tablero que no puede esperar. */}
      {pendientes.length > 0 && (
        <AlertaEnCurso
          alertas={pendientes}
          titulo={`${pendientes.length} ${pendientes.length === 1 ? 'alerta sin atender' : 'alertas sin atender'}`}
          apaisada
          seguidas={seguidas}
          drones={drones}
          onVerDron={onOpenDrone}
          onDecidir={onDecidir}
        />
      )}

      {view === 'cameras' ? (
        active.length === 0 ? (
          <div className="card con-esquina">
            <EstadoVacio titulo="No hay drones activos.">
              Cuando un dron se conecte al Comando Central, su cámara aparece acá. Los que están dados de alta se ven
              en Drones.
            </EstadoVacio>
          </div>
        ) : (
          <div className="camera-grid">
            {active.map((d) => (
              <CameraTile
                key={d.droneId}
                drone={d}
                status={statuses[d.droneId] ?? null}
                frame={frames[d.droneId] ?? null}
                pendingAlerts={pendingAlerts[d.droneId] ?? 0}
                relevos={relevos}
                onOpen={() => onOpenDrone(d.droneId)}
                onRename={(name) => onRename(d.droneId, name)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="card">
          <h2>Posición de la flota</h2>
          <DronesMap items={items} />
        </div>
      )}
    </main>
  );
}
