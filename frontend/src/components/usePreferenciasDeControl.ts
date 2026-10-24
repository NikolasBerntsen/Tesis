import { useCallback, useEffect, useRef, useState } from 'react';
import { guardarPreferencias, traerPreferencias } from '../api';
import {
  CONTROLES_POR_DEFECTO,
  guardarCacheDeControles,
  leerCacheDeControles,
  normalizarControles,
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

/**
 * Los ajustes del control de la persona que inició sesión, para la vista de
 * pilotaje.
 *
 * - Arranca con la copia local de ESTE usuario (o los valores por defecto), así
 *   la vista no parpadea con los de fábrica mientras contesta la red, y pide los
 *   del Comando Central al montarse: son los que valen si se cambiaron en otra
 *   computadora. Si la persona ya movió algo antes de que lleguen, ganan los
 *   suyos.
 * - Cada cambio se aplica en el acto (también en pleno vuelo), va a la copia
 *   local y se guarda en el Comando Central cuando la mano se queda quieta. Si
 *   el guardado falla, el ajuste sigue valiendo y queda un aviso discreto; el
 *   próximo cambio, o "Reintentar", lo vuelve a mandar entero.
 * - Al cerrarse la vista (y al cerrar el panel, con `guardarYa`), lo que
 *   esperaba su turno sale en el acto: cerrar enseguida de mover un deslizador
 *   no puede perder el cambio.
 */
export function usePreferenciasDeControl(usuario: string) {
  const [controles, setControles] = useState<ControlesDeVuelo>(
    () => leerCacheDeControles(usuario) ?? { ...CONTROLES_POR_DEFECTO },
  );
  const [aviso, setAviso] = useState('');
  // Los manejadores leen y escriben acá: dos cambios en el mismo render no
  // pueden partir los dos del mismo juego viejo.
  const controlesRef = useRef(controles);
  // Si la persona ya movió algo en esta vista: lo que conteste el Comando
  // Central después de eso ya es viejo.
  const tocados = useRef(false);
  const pendiente = useRef<ControlesDeVuelo | null>(null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cada guardado lleva su número, y sólo la respuesta del último dice cómo
  // quedó: un fallo viejo que llega tarde no puede tapar un guardado que salió.
  const ultimoEnvio = useRef(0);
  const montado = useRef(false);

  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  useEffect(() => {
    let vigente = true;
    traerPreferencias()
      .then((guardadas) => {
        if (!vigente || tocados.current) return;
        const delComando = normalizarControles(guardadas.controles);
        controlesRef.current = delComando;
        setControles(delComando);
        guardarCacheDeControles(usuario, delComando);
      })
      .catch(() => {
        /* sin respuesta se vuela con la copia local o con los valores por defecto */
      });
    return () => {
      vigente = false;
    };
  }, [usuario]);

  const enviar = useCallback((aGuardar: ControlesDeVuelo) => {
    ultimoEnvio.current += 1;
    const este = ultimoEnvio.current;
    const vigente = () => montado.current && este === ultimoEnvio.current;
    guardarPreferencias(aGuardar).then(
      () => {
        if (vigente()) setAviso('');
      },
      () => {
        if (vigente()) setAviso(AVISO_SIN_GUARDAR);
      },
    );
  }, []);

  const guardarYa = useCallback(() => {
    if (temporizador.current !== null) clearTimeout(temporizador.current);
    temporizador.current = null;
    const aGuardar = pendiente.current;
    pendiente.current = null;
    if (aGuardar) enviar(aGuardar);
  }, [enviar]);

  const cambiar = useCallback(
    (cambios: Partial<ControlesDeVuelo>) => {
      tocados.current = true;
      const nuevos = normalizarControles({ ...controlesRef.current, ...cambios });
      controlesRef.current = nuevos;
      setControles(nuevos);
      guardarCacheDeControles(usuario, nuevos);
      pendiente.current = nuevos;
      if (temporizador.current !== null) clearTimeout(temporizador.current);
      temporizador.current = setTimeout(guardarYa, ESPERA_PARA_GUARDAR_MS);
    },
    [usuario, guardarYa],
  );

  const restablecer = useCallback(() => cambiar(CONTROLES_POR_DEFECTO), [cambiar]);
  const reintentar = useCallback(() => enviar(controlesRef.current), [enviar]);

  // Al cerrarse la vista, lo pendiente sale en el acto (ver arriba).
  useEffect(() => () => guardarYa(), [guardarYa]);

  return { controles, cambiar, restablecer, guardarYa, reintentar, aviso };
}
