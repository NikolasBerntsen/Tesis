import { useCallback, useEffect, useRef, useState } from 'react';
import { guardarPreferencias, traerPreferencias } from '../api';
import {
  CONTROLES_POR_DEFECTO,
  guardarCacheDeControles,
  leerCacheDeControles,
  normalizarControles,
  quedoSinGuardar,
  type ControlesDeVuelo,
} from '../preferenciasDeControl';

/**
 * Cuánto se espera después del último cambio para guardar en el Comando
 * Central. Un deslizador arrastrado dispara decenas de cambios por segundo: lo
 * que se guarda es donde quedó, no cada paso del camino.
 */
export const ESPERA_PARA_GUARDAR_MS = 700;

export const AVISO_SIN_GUARDAR =
  'No se pudieron guardar tus ajustes del control en el Comando Central: siguen valiendo en esta computadora.';

type Clave = keyof ControlesDeVuelo;

/**
 * Lo que contestó el Comando Central, con las claves que la persona ya movió
 * como las dejó ella. El PUT reemplaza el juego entero: quedarse con lo suyo
 * completo era mandar, junto con la rueda que movió, los valores de fábrica (o
 * los viejos de esta computadora) en lugar de la sensibilidad y el eje que
 * traía guardados de otra.
 */
function combinar(delComando: unknown, propios: ControlesDeVuelo, tocadas: ReadonlySet<Clave>): ControlesDeVuelo {
  const suyos = Object.fromEntries([...tocadas].map((clave) => [clave, propios[clave]]));
  return normalizarControles({ ...normalizarControles(delComando), ...suyos });
}

/**
 * Los ajustes del control de la persona que inició sesión, para la vista de
 * pilotaje.
 *
 * - Arranca con la copia local de ESTE usuario (o los valores por defecto), así
 *   la vista no parpadea con los de fábrica mientras contesta la red, y pide los
 *   del Comando Central al montarse: son los que valen si se cambiaron en otra
 *   computadora. Lo que la persona ya movió antes de que lleguen queda como lo
 *   dejó, y el resto toma lo del Comando Central (ver `combinar`).
 * - Cada cambio se aplica en el acto (también en pleno vuelo), va a la copia
 *   local marcada como sin guardar y se guarda en el Comando Central cuando la
 *   mano se queda quieta. Si el guardado falla, el ajuste sigue valiendo y queda
 *   un aviso discreto; el próximo cambio, "Reintentar" o cerrar el panel o la
 *   vista lo vuelven a mandar entero. Y si la vista se cierra sin que haya
 *   salido, la próxima manda la copia local en vez de creerle al GET: lo viejo
 *   del Comando Central no puede pisar lo último que se eligió acá.
 * - Los guardados van de a uno (ver `enviar`), y al cerrarse la vista (y al
 *   cerrar el panel, con `guardarYa`) lo que esperaba su turno sale en el acto:
 *   cerrar enseguida de mover un deslizador no puede perder el cambio.
 */
export function usePreferenciasDeControl(usuario: string) {
  const [controles, setControles] = useState<ControlesDeVuelo>(
    () => leerCacheDeControles(usuario) ?? { ...CONTROLES_POR_DEFECTO },
  );
  const [aviso, setAviso] = useState('');
  // Los manejadores leen y escriben acá: dos cambios en el mismo render no
  // pueden partir los dos del mismo juego viejo.
  const controlesRef = useRef(controles);
  // Las claves que la persona movió en esta vista: lo que conteste después el
  // Comando Central ya es viejo para ellas, no para las demás.
  const tocadas = useRef(new Set<Clave>());
  // La copia local va adelante del Comando Central (la marca de la caché).
  const sinGuardar = useRef(false);
  const pendiente = useRef<ControlesDeVuelo | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fila = useRef<{ enCamino: boolean; siguiente: ControlesDeVuelo | null }>({ enCamino: false, siguiente: null });
  const montado = useRef(false);

  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  /** Lo que vale desde ahora: en la vista, en la copia local y en su marca. */
  const aplicar = useCallback(
    (nuevos: ControlesDeVuelo, adelantados: boolean) => {
      controlesRef.current = nuevos;
      setControles(nuevos);
      sinGuardar.current = adelantados;
      guardarCacheDeControles(usuario, nuevos, adelantados);
    },
    [usuario],
  );

  /**
   * Cómo quedó el último guardado de la fila. Sólo uno que salió con nada más
   * esperando deja la copia local al día; la marca se borra aunque la vista ya
   * se haya cerrado, que es justamente cuando la próxima la va a leer.
   */
  const terminar = useCallback(
    (salio: boolean) => {
      if (salio && pendiente.current === null) {
        sinGuardar.current = false;
        guardarCacheDeControles(usuario, controlesRef.current);
      }
      if (montado.current) setAviso(salio ? '' : AVISO_SIN_GUARDAR);
    },
    [usuario],
  );

  /**
   * Manda un juego con un PUT, de a uno: si hay otro en camino, éste espera a
   * que vuelva y sale sólo el último que quedó esperando. Dos en paralelo podían
   * llegar al revés —el navegador abre varias conexiones— y el viejo quedaba
   * guardado en el Comando Central mientras la consola mostraba el nuevo. Por lo
   * mismo, sólo el último de la fila dice cómo quedó: un fallo viejo no tapa un
   * guardado que salió después.
   */
  const enviar = useCallback(
    (primero: ControlesDeVuelo) => {
      const estado = fila.current;
      if (estado.enCamino) {
        estado.siguiente = primero;
        return;
      }
      estado.enCamino = true;
      const mandar = (aGuardar: ControlesDeVuelo) => {
        guardarPreferencias(aGuardar).then(
          () => volvio(true),
          () => volvio(false),
        );
      };
      const volvio = (salio: boolean) => {
        const siguiente = estado.siguiente;
        estado.siguiente = null;
        if (siguiente) {
          mandar(siguiente);
          return;
        }
        estado.enCamino = false;
        terminar(salio);
      };
      mandar(primero);
    },
    [terminar],
  );

  /**
   * Lo que esperaba su turno sale en el acto. Sin nada esperando, si el último
   * guardado falló (la marca sigue puesta y no hay ninguno en camino), se vuelve
   * a mandar el juego entero: cerrar es dar el cambio por terminado.
   */
  const guardarYa = useCallback(() => {
    if (temporizador.current !== null) clearTimeout(temporizador.current);
    temporizador.current = null;
    const fallo = sinGuardar.current && !fila.current.enCamino;
    const aGuardar = pendiente.current ?? (fallo ? controlesRef.current : null);
    pendiente.current = null;
    if (aGuardar) enviar(aGuardar);
  }, [enviar]);

  const programar = useCallback(
    (aGuardar: ControlesDeVuelo) => {
      pendiente.current = aGuardar;
      if (temporizador.current !== null) clearTimeout(temporizador.current);
      temporizador.current = setTimeout(guardarYa, ESPERA_PARA_GUARDAR_MS);
    },
    [guardarYa],
  );

  useEffect(() => {
    // Lo que quedó sin guardar la vez anterior es lo último que la persona
    // eligió: se manda eso, y el GET sólo traería lo de antes.
    if (quedoSinGuardar(usuario)) {
      sinGuardar.current = true;
      enviar(controlesRef.current);
      return;
    }
    let vigente = true;
    traerPreferencias()
      .then((guardadas) => {
        if (!vigente) return;
        const propios = tocadas.current.size > 0;
        const combinados = combinar(guardadas.controles, controlesRef.current, tocadas.current);
        aplicar(combinados, propios);
        // Lo que ya salió (o espera su turno) se armó sin lo del Comando
        // Central: el juego combinado lo reemplaza.
        if (propios) programar(combinados);
      })
      .catch(() => {
        /* sin respuesta se vuela con la copia local o con los valores por defecto */
      });
    return () => {
      vigente = false;
    };
  }, [usuario, enviar, aplicar, programar]);

  const cambiar = useCallback(
    (cambios: Partial<ControlesDeVuelo>) => {
      for (const clave of Object.keys(cambios) as Clave[]) tocadas.current.add(clave);
      const nuevos = normalizarControles({ ...controlesRef.current, ...cambios });
      aplicar(nuevos, true);
      programar(nuevos);
    },
    [aplicar, programar],
  );

  const restablecer = useCallback(() => cambiar(CONTROLES_POR_DEFECTO), [cambiar]);
  const reintentar = useCallback(() => enviar(controlesRef.current), [enviar]);

  // Al cerrarse la vista, lo pendiente sale en el acto (ver arriba).
  useEffect(() => () => guardarYa(), [guardarYa]);

  return { controles, cambiar, restablecer, guardarYa, reintentar, aviso };
}
