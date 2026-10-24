import { Router } from 'express';
import { requireRoles, type AuthedRequest } from '../auth';
import { CUERPO_MAXIMO_BYTES, excedeElTamanio, guardarPreferencias, leerPreferencias, preferenciasDe } from '../preferencias';

/**
 * Las preferencias de quien inició sesión (PROTOCOLS §5). No hay ruta con un
 * username a propósito: de quién son lo dice el token, y no existe forma de leer
 * ni de escribir las de otra persona, ni siquiera siendo admin. Son ajustes de la
 * mano de cada uno; nadie los necesita mirar por otro.
 *
 * Tampoco dejan registro: la consola guarda con cada movimiento de un
 * deslizador (agrupados, pero varios por minuto mientras alguien prueba), y un
 * evento por cada uno taparía en el Registro lo que sí es operación.
 */
export const preferenciasRouter = Router();

// Las personas, no los drones: el token de máquina del celular no vuela con
// mouse ni teclado. El operador de campo entra porque es una persona con
// consola, aunque hoy no pilotee: las preferencias son de la cuenta, no del
// permiso de volar.
const personas = requireRoles('field_operator', 'operator', 'supervisor', 'admin');

preferenciasRouter.get('/', personas, (req: AuthedRequest, res) => {
  res.json(preferenciasDe(req.user!.sub));
});

preferenciasRouter.put('/', personas, (req: AuthedRequest, res) => {
  if (excedeElTamanio(req.body)) {
    return res.status(413).json({ error: `Las preferencias no pueden superar ${CUERPO_MAXIMO_BYTES} bytes` });
  }
  const lectura = leerPreferencias(req.body);
  if (!lectura.ok) return res.status(400).json({ error: lectura.error });
  res.json(guardarPreferencias(req.user!.sub, lectura.controles));
});
