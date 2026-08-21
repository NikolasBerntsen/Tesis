import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { ROLE_RANK, requireAuth, requireRoles, signDroneToken, type AuthedRequest } from '../auth';
import {
  asignarRutas, basesDeRuta, contarDronesEnBase, createBase, createDrone, createLog, createRoute, createUser, distanciaM, generarContrasenia, getBase, restoreRoute, rutasDeBase, softDeleteRoute, updateRoute, listBases, restoreBase, softDeleteBase, updateBase, decideAlert, getAlert, getDrone, getDroneIdentity, getRoute, getRoutes,
  getUser, listAlerts, listEvents, listLogs, listUsers, restoreDrone, restoreUser, setWaypointLabel,
  softDeleteDrone, softDeleteUser, updateDrone, updateUser,
  type BasePatch, type BaseView, type DroneAssetView, type DronePatch, type PatrolRoute, type RoutePatch, type Waypoint, type LogCategory, type Role,
} from '../store';
import {
  broadcastDroneUpdated, broadcastOperators, droneCard, getController, kickDrone, kickUser, listDroneCards,
  metaDron, releaseAllControlledBy, releaseControl, sendToDrone, takeControl,
} from '../ws';

export const apiRouter = Router();

const CATEGORIAS: LogCategory[] = ['drone', 'usuarios', 'sistema'];

/** Los flags de query llegan como texto: se aceptan las dos formas usuales. */
function flag(valor: unknown): boolean {
  return valor === '1' || valor === 'true';
}

function esSupervisorOMas(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.supervisor;
}

/**
 * Techo y piso de un límite que va a terminar en un LIMIT de SQL. Un valor no
 * numérico no puede llegar al bind: SQLite corta con "datatype mismatch" y el
 * cliente se come un 500 en vez de la página por defecto.
 */
function leerLimite(raw: unknown, porDefecto: number, techo: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, techo) : porDefecto;
}

type LecturaBaseId = { ok: true; baseId: number | null } | { ok: false; error: string };

/**
 * `null` desasigna la base; un número la referencia. Se valida que exista, que
 * no esté eliminada y que esté activa: asignar un dron a una base dada de baja
 * dejaría un vuelo de retorno apuntando a un lugar que ya no opera.
 */
function leerBaseId(raw: unknown): LecturaBaseId {
  if (raw === null) return { ok: true, baseId: null };
  const id = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'baseId debe ser el identificador de una base' };
  const base = getBase(id);
  if (!base) return { ok: false, error: 'La base indicada no existe' };
  if (base.deletedAt) return { ok: false, error: 'La base indicada fue eliminada' };
  if (!base.active) return { ok: false, error: 'La base indicada no está activa' };
  return { ok: true, baseId: id };
}

/**
 * Instantánea GPS del operador al emparejar. Puede no venir (el usuario pudo
 * negar el permiso de ubicación) y eso no invalida el emparejamiento.
 */
function leerUbicacion(body: Record<string, unknown>): { lat: number; lon: number; accuracyM: number | null } | null {
  const lat = typeof body.lat === 'number' ? body.lat : NaN;
  const lon = typeof body.lon === 'number' ? body.lon : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const accuracyM = typeof body.accuracyM === 'number' ? body.accuracyM : NaN;
  return { lat, lon, accuracyM: Number.isFinite(accuracyM) ? accuracyM : null };
}

/**
 * Campos comparables de un dron para las columnas antes/después del pop-up.
 * Van planos a propósito: la consola resalta clave por clave lo que cambió.
 */
function estadoDron(d: DroneAssetView) {
  return {
    displayName: d.displayName,
    model: d.model,
    inventario: d.inventoryCode,
    operativo: d.active,
    eliminado: !!d.deletedAt,
    base: d.base?.name ?? null,
  };
}

// Ficha del usuario autenticado. La app del dron la usa tras el emparejamiento
// para saber su nombre visible y su base; la consola, para saber rol y flags.
apiRouter.get('/me', requireAuth(), (req: AuthedRequest, res) => {
  const { sub, role, canControl } = req.user!;
  if (role === 'drone') {
    const identity = getDroneIdentity(sub);
    if (!identity) return res.status(404).json({ error: 'Dron inexistente' });
    return res.json({ username: sub, role, ...identity });
  }
  res.json({ username: sub, role, canControl });
});

apiRouter.get('/routes', requireAuth(), (req: AuthedRequest, res) => {
  const includeDeleted = flag(req.query.includeDeleted) && esSupervisorOMas(req.user!.role);
  const rutas = getRoutes({ includeDeleted });
  // La app del dron pide sólo las de SU base: es lo que el operador puede
  // patrullar desde ahí, y mandarle el catálogo entero lo obliga a elegir mal.
  if (req.user!.role === 'drone') {
    const baseId = getDrone(req.user!.sub)?.baseId;
    return res.json(baseId ? rutasDeBase(baseId) : []);
  }
  const deBase = req.query.baseId !== undefined ? Number(req.query.baseId) : null;
  res.json(deBase && Number.isInteger(deBase) ? rutasDeBase(deBase) : rutas);
});

/** Nodos de una ruta, ya validados. Una ruta sin al menos dos no es una ruta. */
function leerNodos(raw: unknown): { ok: true; waypoints: Waypoint[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'waypoints debe ser una lista de nodos' };
  if (raw.length < 2) return { ok: false, error: 'Una ruta necesita al menos dos nodos' };
  if (raw.length > 60) return { ok: false, error: 'Una ruta no puede superar los 60 nodos' };
  const waypoints: Waypoint[] = [];
  for (const w of raw) {
    const o = (w ?? {}) as Record<string, unknown>;
    const lat = typeof o.lat === 'number' ? o.lat : NaN;
    const lon = typeof o.lon === 'number' ? o.lon : NaN;
    const alt = typeof o.alt === 'number' ? o.alt : 40;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'Cada nodo necesita lat y lon numéricos' };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false, error: 'Nodo con coordenadas fuera de rango' };
    if (alt < 0 || alt > 500) return { ok: false, error: 'La altura de un nodo va entre 0 y 500 metros' };
    const label = String(o.label ?? '').trim();
    if (label.length > 40) return { ok: false, error: 'El apodo de un nodo no puede superar 40 caracteres' };
    waypoints.push(label ? { lat, lon, alt, label } : { lat, lon, alt });
  }
  return { ok: true, waypoints };
}

function estadoRuta(r: PatrolRoute) {
  return { nombre: r.name, descripcion: r.description, nodos: r.waypoints.length, eliminada: !!r.deletedAt };
}

apiRouter.post('/routes', requireRoles('field_operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'El nombre de la ruta es requerido' });
  if (name.length > 60) return res.status(400).json({ error: 'El nombre no puede superar 60 caracteres' });
  const description = String(req.body?.description ?? '').trim();
  if (description.length > 200) return res.status(400).json({ error: 'La descripción no puede superar 200 caracteres' });
  const lectura = leerNodos(req.body?.waypoints);
  if (!lectura.ok) return res.status(400).json({ error: lectura.error });

  const ruta = createRoute({ name, description, waypoints: lectura.waypoints }, req.user!.sub);
  const ev = createLog('drone', 'ROUTE_CREATED', req.user!.sub, `${req.user!.sub} creó la ruta "${name}" con ${ruta.waypoints.length} nodos`, {
    meta: { despues: estadoRuta(ruta) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route: ruta });
  res.status(201).json(ruta);
});

apiRouter.patch('/routes/:id', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const actual = getRoute(id);
  if (!actual) return res.status(404).json({ error: 'Ruta inexistente' });
  if (actual.deletedAt) return res.status(409).json({ error: 'La ruta está eliminada: restaurala antes de modificarla' });

  const patch: RoutePatch = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'El nombre de la ruta es requerido' });
    if (name.length > 60) return res.status(400).json({ error: 'El nombre no puede superar 60 caracteres' });
    patch.name = name;
  }
  if (req.body?.description !== undefined) patch.description = String(req.body.description).trim().slice(0, 200);
  if (req.body?.waypoints !== undefined) {
    const lectura = leerNodos(req.body.waypoints);
    if (!lectura.ok) return res.status(400).json({ error: lectura.error });
    patch.waypoints = lectura.waypoints;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para modificar' });

  const result = updateRoute(id, patch)!;
  const ev = createLog('drone', 'ROUTE_UPDATED', req.user!.sub, `${req.user!.sub} modificó la ruta "${result.after.name}"`, {
    meta: { antes: estadoRuta(result.before), despues: estadoRuta(result.after) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route: result.after });
  res.json(result.after);
});

apiRouter.delete('/routes/:id', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const actual = getRoute(id);
  if (!actual) return res.status(404).json({ error: 'Ruta inexistente' });
  if (actual.deletedAt) return res.status(409).json({ error: 'La ruta ya estaba eliminada' });

  const ruta = softDeleteRoute(id, req.user!.sub)!;
  const ev = createLog('drone', 'ROUTE_DELETED', req.user!.sub, `${req.user!.sub} eliminó la ruta "${ruta.name}"`, {
    meta: { antes: estadoRuta(actual), despues: estadoRuta(ruta) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route: ruta });
  res.json(ruta);
});

apiRouter.post('/routes/:id/restore', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const actual = getRoute(id);
  if (!actual) return res.status(404).json({ error: 'Ruta inexistente' });
  if (!actual.deletedAt) return res.status(409).json({ error: 'La ruta no estaba eliminada' });

  const ruta = restoreRoute(id)!;
  const ev = createLog('drone', 'ROUTE_RESTORED', req.user!.sub, `${req.user!.sub} restauró la ruta "${ruta.name}"`, {
    meta: { antes: estadoRuta(actual), despues: estadoRuta(ruta) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route: ruta });
  res.json(ruta);
});

// ---- Rutas asignadas a una base ----

apiRouter.get('/bases/:id/routes', requireRoles('field_operator', 'operator', 'supervisor', 'admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!getBase(id)) return res.status(404).json({ error: 'Base inexistente' });
  res.json(rutasDeBase(id));
});

apiRouter.put('/bases/:id/routes', requireRoles('field_operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const base = getBase(id);
  if (!base) return res.status(404).json({ error: 'Base inexistente' });
  if (base.deletedAt) return res.status(409).json({ error: 'La base está eliminada' });

  const crudos = req.body?.routeIds;
  if (!Array.isArray(crudos)) return res.status(400).json({ error: 'routeIds debe ser una lista' });
  const ids: number[] = [];
  for (const c of crudos) {
    const n = Number(c);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'routeIds debe traer identificadores enteros' });
    const ruta = getRoute(n);
    if (!ruta || ruta.deletedAt) return res.status(400).json({ error: `La ruta ${n} no existe o fue eliminada` });
    ids.push(n);
  }

  const antes = rutasDeBase(id).map((r) => r.name);
  asignarRutas(id, ids);
  const despues = rutasDeBase(id).map((r) => r.name);
  const ev = createLog('drone', 'BASE_ROUTES_SET', req.user!.sub, `${req.user!.sub} asignó ${ids.length} ruta(s) a la base "${base.name}"`, {
    meta: { antes: { rutas: antes.join(', ') || '(ninguna)' }, despues: { rutas: despues.join(', ') || '(ninguna)' } },
  });
  broadcastOperators({ type: 'event', event: ev });
  res.json(rutasDeBase(id));
});

// Apodo de un nodo de patrullaje, para identificar zonas puntuales en el mapa.
apiRouter.patch('/routes/:routeId/waypoints/:index', requireAuth('operator'), (req: AuthedRequest, res) => {
  const routeId = Number(req.params.routeId);
  const index = Number(req.params.index);
  const label = String(req.body?.label ?? '').trim();
  if (label.length > 40) return res.status(400).json({ error: 'El apodo no puede superar 40 caracteres' });

  const antes = getRoute(routeId)?.waypoints[index]?.label ?? '';
  if (!getRoute(routeId)) return res.status(404).json({ error: 'Ruta inexistente' });
  const route = setWaypointLabel(routeId, index, label);
  if (!route) return res.status(404).json({ error: 'Nodo inexistente en esa ruta' });

  const ev = createLog(
    'drone',
    'WAYPOINT_RENAMED',
    req.user!.sub,
    `${req.user!.sub} renombró el nodo ${index + 1} de "${route.name}" a "${label || '(sin apodo)'}"`,
    {
      meta: {
        antes: { apodo: antes },
        despues: { apodo: label },
        detalle: { ruta: route.name, rutaId: route.id, nodo: index + 1 },
      },
    },
  );
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route });
  res.json(route);
});

// ---- Drones como activos ----

// El operador de campo entra acá para dar de alta drones y generar sus QR, así
// que no alcanza con el rango: es un permiso lateral, no jerárquico.
apiRouter.get('/drones', requireRoles('field_operator', 'operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const includeDeleted = flag(req.query.includeDeleted) && esSupervisorOMas(req.user!.role);
  res.json(listDroneCards({ includeDeleted }));
});

apiRouter.post('/drones', requireRoles('field_operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const displayName = String(req.body?.displayName ?? '').trim();
  if (!displayName) return res.status(400).json({ error: 'displayName es requerido' });
  if (displayName.length > 40) return res.status(400).json({ error: 'displayName no puede superar 40 caracteres' });
  const model = String(req.body?.model ?? '').trim();
  if (model.length > 40) return res.status(400).json({ error: 'model no puede superar 40 caracteres' });

  const inventoryCode = String(req.body?.inventoryCode ?? '').trim();
  if (inventoryCode.length > 30) return res.status(400).json({ error: 'El número de inventario no puede superar 30 caracteres' });

  let baseId: number | null = null;
  if (req.body?.baseId !== undefined) {
    const lectura = leerBaseId(req.body.baseId);
    if (!lectura.ok) return res.status(400).json({ error: lectura.error });
    baseId = lectura.baseId;
  }

  const drone = createDrone({ displayName, model, inventoryCode, baseId }, req.user!.sub);
  const ev = createLog('drone', 'DRONE_CREATED', req.user!.sub, `${req.user!.sub} dio de alta el dron "${displayName}"`, {
    droneId: drone.hash,
    meta: { drone: metaDron(drone.hash), despues: estadoDron(drone) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastDroneUpdated(drone.hash);
  res.status(201).json(droneCard(drone.hash));
});

// Emparejamiento por QR: el celular manda el hash escaneado y recibe el token
// de máquina del dron. Va antes de las rutas con :droneId por claridad.
apiRouter.post('/drones/pair', requireRoles('field_operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hash = String(body.hash ?? '').trim();
  if (!hash) return res.status(400).json({ error: 'hash es requerido' });

  const drone = getDrone(hash);
  if (!drone) return res.status(404).json({ error: 'El código QR no corresponde a ningún dron registrado' });
  if (drone.deletedAt) return res.status(403).json({ error: 'El dron fue eliminado del sistema' });
  if (!drone.active) return res.status(403).json({ error: 'El dron está desactivado' });

  const ubicacion = leerUbicacion(body);
  const dispositivo = String(body.deviceModel ?? '').trim() || null;
  const token = signDroneToken(hash);

  const ev = createLog(
    'drone',
    'DRONE_PAIRED',
    req.user!.sub,
    `${req.user!.sub} emparejó el dron "${drone.displayName}"${dispositivo ? ` desde ${dispositivo}` : ''}`,
    {
      droneId: hash,
      meta: { por: req.user!.sub, ubicacion, dispositivo, drone: metaDron(hash) },
    },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ token, drone: droneCard(hash) });
});

apiRouter.post('/drones/:droneId/restore', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  const before = getDrone(droneId);
  if (!before) return res.status(404).json({ error: 'Dron inexistente' });
  const after = restoreDrone(droneId);
  if (!after) return res.status(409).json({ error: 'El dron no estaba eliminado' });

  const ev = createLog('drone', 'DRONE_RESTORED', req.user!.sub, `${req.user!.sub} restauró el dron "${after.displayName}"`, {
    droneId,
    meta: { drone: metaDron(droneId), antes: estadoDron(before), despues: estadoDron(after) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastDroneUpdated(droneId);
  res.json(droneCard(droneId));
});

// Lo que puede tocar el operador de campo: es quien está parado al lado del
// aparato cuando lo despliega, así que reasignarle la base y ponerle nombre es
// justamente su trabajo. El modelo, el inventario y el alta/baja no.
const CAMPOS_DE_CAMPO = new Set(['displayName', 'baseId']);

/**
 * Renombrar y reasignar la base las hacen el operador y el operador de campo;
 * tocar el resto del activo —modelo, inventario, alta/baja— es de supervisor.
 */
apiRouter.patch('/drones/:droneId', requireRoles('field_operator', 'operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const claves = Object.keys(body);
  const soloDeCampo = claves.every((k) => CAMPOS_DE_CAMPO.has(k));
  if (!soloDeCampo && !esSupervisorOMas(req.user!.role)) {
    return res.status(403).json({ error: 'Solo un supervisor puede modificar el activo' });
  }

  const patch: DronePatch = {};
  if (body.displayName !== undefined) {
    const displayName = String(body.displayName).trim();
    if (!displayName) return res.status(400).json({ error: 'displayName es requerido' });
    if (displayName.length > 40) return res.status(400).json({ error: 'displayName no puede superar 40 caracteres' });
    patch.displayName = displayName;
  }
  if (body.model !== undefined) {
    const model = String(body.model).trim();
    if (model.length > 40) return res.status(400).json({ error: 'model no puede superar 40 caracteres' });
    patch.model = model;
  }
  if (body.inventoryCode !== undefined) {
    const inventoryCode = String(body.inventoryCode).trim();
    if (inventoryCode.length > 30) return res.status(400).json({ error: 'El número de inventario no puede superar 30 caracteres' });
    patch.inventoryCode = inventoryCode;
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (body.baseId !== undefined) {
    const lectura = leerBaseId(body.baseId);
    if (!lectura.ok) return res.status(400).json({ error: lectura.error });
    patch.baseId = lectura.baseId;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para modificar' });

  const before = getDrone(droneId);
  if (!before) return res.status(404).json({ error: 'Dron inexistente' });
  if (before.deletedAt) return res.status(409).json({ error: 'El dron está eliminado: restauralo antes de modificarlo' });

  const result = updateDrone(droneId, patch)!;
  // El renombre se avisa a los dos lados para que la app muestre el nombre nuevo
  if (patch.displayName && patch.displayName !== before.displayName) {
    broadcastOperators({ type: 'drone_renamed', droneId, displayName: patch.displayName });
    sendToDrone(droneId, { type: 'renamed', displayName: patch.displayName });
  }
  if (patch.active === false) {
    releaseControl(droneId, req.user!.sub, { resume: 'none', forced: true, reason: 'el dron fue desactivado' });
    kickDrone(droneId, 'Dron desactivado');
  }

  const cambios = Object.keys(patch);
  const ev = createLog(
    'drone',
    'DRONE_UPDATED',
    req.user!.sub,
    `${req.user!.sub} modificó el dron "${result.after.displayName}" (${cambios.join(', ')})`,
    {
      droneId,
      meta: { drone: metaDron(droneId), antes: estadoDron(result.before), despues: estadoDron(result.after) },
    },
  );
  broadcastOperators({ type: 'event', event: ev });
  broadcastDroneUpdated(droneId);
  res.json(droneCard(droneId));
});

// Borrado lógico: el historial de eventos y alertas sigue apuntando al hash.
apiRouter.delete('/drones/:droneId', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  const before = getDrone(droneId);
  if (!before) return res.status(404).json({ error: 'Dron inexistente' });
  const after = softDeleteDrone(droneId, req.user!.sub);
  if (!after) return res.status(409).json({ error: 'El dron ya estaba eliminado' });

  releaseControl(droneId, req.user!.sub, { resume: 'none', forced: true, reason: 'el dron fue eliminado' });
  kickDrone(droneId, 'Dron eliminado');

  const ev = createLog('drone', 'DRONE_DELETED', req.user!.sub, `${req.user!.sub} eliminó el dron "${before.displayName}"`, {
    droneId,
    meta: { drone: metaDron(droneId), antes: estadoDron(before), despues: estadoDron(after) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastDroneUpdated(droneId);
  res.json(droneCard(droneId));
});

// ---- Patrullaje y control del dron ----

/**
 * Si el dron está bajo control manual, solo el titular (o un supervisor)
 * puede darle órdenes de vuelo. Devuelve el error listo para responder.
 */
function checkNotControlledByOther(droneId: string, user: { sub: string; role: Role }): string | null {
  const holder = getController(droneId);
  if (holder && holder !== user.sub && ROLE_RANK[user.role] < ROLE_RANK.supervisor) return holder;
  return null;
}

apiRouter.post('/drones/:droneId/route/start', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });
  const route = getRoute(Number(req.body?.routeId));
  if (!route) return res.status(404).json({ error: 'Ruta inexistente' });
  // Con Number a secas, un fromIndex de basura da NaN y ninguna comparación lo
  // atrapa: la orden salía con "desde el nodo NaN".
  const fromIndex = Number(req.body?.fromIndex ?? 0);
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= route.waypoints.length) {
    return res.status(400).json({ error: 'fromIndex debe ser un nodo de la ruta' });
  }
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const delivered = sendToDrone(droneId, { type: 'start_route', routeId: route.id, fromIndex, orderedBy: req.user!.sub });
  const ev = createLog(
    'drone',
    'ROUTE_STARTED',
    req.user!.sub,
    `${req.user!.sub} ordenó patrullar "${route.name}" desde el nodo ${fromIndex + 1}`,
    { droneId, meta: { drone: metaDron(droneId), detalle: { ruta: route.name, rutaId: route.id, desdeNodo: fromIndex + 1 } } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true, delivered });
});

apiRouter.post('/drones/:droneId/route/stop', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const delivered = sendToDrone(droneId, { type: 'stop_patrol', orderedBy: req.user!.sub });
  const ev = createLog(
    'drone',
    'PATROL_STOPPED',
    req.user!.sub,
    `${req.user!.sub} interrumpió el patrullaje del dron ${droneId}`,
    { droneId, meta: { drone: metaDron(droneId), detalle: { por: req.user!.sub } } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true, delivered });
});

// Reanudar el patrullaje: desde el último nodo alcanzado o desde uno elegido.
// Si el dron estaba bajo control manual, esto lo libera.
apiRouter.post('/drones/:droneId/resume', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const fromIndex = req.body?.fromIndex;
  if (getController(droneId)) {
    releaseControl(droneId, req.user!.sub, { resume: typeof fromIndex === 'number' ? fromIndex : 'last' });
  } else {
    const msg: Record<string, unknown> = { type: 'resume_patrol', orderedBy: req.user!.sub };
    if (typeof fromIndex === 'number') msg.fromIndex = fromIndex;
    sendToDrone(droneId, msg);
  }
  const detalle = typeof fromIndex === 'number' ? `desde el nodo ${fromIndex + 1}` : 'desde el último nodo recorrido';
  const ev = createLog(
    'drone',
    'PATROL_RESUME_ORDERED',
    req.user!.sub,
    `${req.user!.sub} ordenó reanudar el patrullaje ${detalle}`,
    {
      droneId,
      meta: {
        drone: metaDron(droneId),
        detalle: { por: req.user!.sub, desdeNodo: typeof fromIndex === 'number' ? fromIndex + 1 : null },
      },
    },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true });
});

// Vuelo forzado hacia un nodo puntual ("Forzar ruta" en el popup del nodo)
apiRouter.post('/drones/:droneId/goto', requireAuth('operator'), (req: AuthedRequest, res) => {
  if (!req.user!.canControl) return res.status(403).json({ error: 'No estás autorizado a controlar drones' });
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });
  const route = getRoute(Number(req.body?.routeId));
  const index = Number(req.body?.index);
  if (!route || !route.waypoints[index]) return res.status(404).json({ error: 'Nodo inexistente' });
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const delivered = sendToDrone(droneId, { type: 'force_goto', routeId: route.id, index, orderedBy: req.user!.sub });
  const nombre = route.waypoints[index].label || `nodo ${index + 1}`;
  const ev = createLog(
    'drone',
    'FORCED_GOTO',
    req.user!.sub,
    `${req.user!.sub} forzó al dron ${droneId} hacia ${nombre} de "${route.name}"`,
    { droneId, meta: { drone: metaDron(droneId), detalle: { ruta: route.name, rutaId: route.id, nodo: index + 1 } } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true, delivered });
});

// ---- Control manual exclusivo ----

apiRouter.post('/drones/:droneId/control', requireAuth('operator'), (req: AuthedRequest, res) => {
  if (!req.user!.canControl) return res.status(403).json({ error: 'No estás autorizado a controlar drones' });
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });

  const result = takeControl(droneId, req.user!.sub);
  if (!result.ok) return res.status(409).json({ error: `El dron ya está controlado por ${result.heldBy}` });
  res.json(droneCard(droneId));
});

apiRouter.delete('/drones/:droneId/control', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  const holder = getController(droneId);
  if (!holder) return res.status(409).json({ error: 'El dron no está bajo control manual' });

  const esTitular = holder === req.user!.sub;
  const esSupervisor = esSupervisorOMas(req.user!.role);
  if (!esTitular && !esSupervisor) return res.status(403).json({ error: `El control lo tiene ${holder}` });

  const resume = req.body?.resume;
  releaseControl(droneId, req.user!.sub, {
    resume: typeof resume === 'number' ? resume : resume === 'none' ? 'none' : 'last',
    forced: !esTitular,
  });
  res.json(droneCard(droneId));
});

apiRouter.post('/drones/:droneId/manual_move', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (getController(droneId) !== req.user!.sub) {
    return res.status(409).json({ error: 'No tenés el control manual de este dron' });
  }
  const bearing = Number(req.body?.bearing);
  const distanceM = Number(req.body?.distanceM);
  if (!Number.isFinite(bearing) || !Number.isFinite(distanceM) || distanceM <= 0 || distanceM > 200) {
    return res.status(400).json({ error: 'bearing y distanceM (1..200) son requeridos' });
  }
  const delivered = sendToDrone(droneId, { type: 'manual_move', bearing, distanceM, by: req.user!.sub });
  res.json({ ok: true, delivered });
});

// ---- Bases ----

// El operador de campo da de alta bases en el terreno; el operador común las ve
// para ubicarse en el mapa. Editarlas y darlas de baja es de supervisor.
apiRouter.get('/bases', requireRoles('field_operator', 'operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const includeDeleted = flag(req.query.includeDeleted) && esSupervisorOMas(req.user!.role);
  res.json(listBases({ includeDeleted, soloActivas: flag(req.query.soloActivas) }));
});

/** Nombre y coordenada de una base, ya validados. */
function leerDatosDeBase(body: Record<string, unknown>, parcial: boolean) {
  const tieneNombre = body.name !== undefined;
  const name = String(body.name ?? '').trim();
  if ((!parcial || tieneNombre) && !name) return { ok: false as const, error: 'El nombre de la base es requerido' };
  if (name.length > 60) return { ok: false as const, error: 'El nombre no puede superar 60 caracteres' };

  const tieneCoord = body.lat !== undefined || body.lon !== undefined;
  if (!parcial || tieneCoord) {
    const lat = typeof body.lat === 'number' ? body.lat : NaN;
    const lon = typeof body.lon === 'number' ? body.lon : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false as const, error: 'lat y lon son requeridos y numéricos' };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false as const, error: 'Coordenadas fuera de rango' };
    return { ok: true as const, name, lat, lon };
  }
  return { ok: true as const, name, lat: undefined, lon: undefined };
}

function estadoBase(b: BaseView) {
  return { nombre: b.name, lat: b.lat, lon: b.lon, activa: b.active, eliminada: !!b.deletedAt };
}

apiRouter.post('/bases', requireRoles('field_operator', 'supervisor', 'admin'), (req: AuthedRequest, res) => {
  const lectura = leerDatosDeBase((req.body ?? {}) as Record<string, unknown>, false);
  if (!lectura.ok) return res.status(400).json({ error: lectura.error });

  const base = createBase({ name: lectura.name, lat: lectura.lat!, lon: lectura.lon! }, req.user!.sub);
  const ev = createLog('drone', 'BASE_CREATED', req.user!.sub, `${req.user!.sub} dio de alta la base "${base.name}"`, {
    meta: { despues: estadoBase(base), ubicacion: { lat: base.lat, lon: base.lon, accuracyM: null } },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'base_updated', base });
  res.status(201).json(base);
});

apiRouter.patch('/bases/:id', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lectura = leerDatosDeBase(body, true);
  if (!lectura.ok) return res.status(400).json({ error: lectura.error });

  const patch: BasePatch = {};
  if (body.name !== undefined) patch.name = lectura.name;
  if (lectura.lat !== undefined) { patch.lat = lectura.lat; patch.lon = lectura.lon; }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para modificar' });

  const actual = getBase(id);
  if (!actual) return res.status(404).json({ error: 'Base inexistente' });
  if (actual.deletedAt) return res.status(409).json({ error: 'La base está eliminada: restaurala antes de modificarla' });

  const result = updateBase(id, patch)!;
  const ev = createLog('drone', 'BASE_UPDATED', req.user!.sub, `${req.user!.sub} modificó la base "${result.after.name}"`, {
    meta: { antes: estadoBase(result.before), despues: estadoBase(result.after) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'base_updated', base: result.after });
  res.json(result.after);
});

apiRouter.delete('/bases/:id', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const actual = getBase(id);
  if (!actual) return res.status(404).json({ error: 'Base inexistente' });
  if (actual.deletedAt) return res.status(409).json({ error: 'La base ya estaba eliminada' });

  // Dar de baja una base que todavía es el destino de retorno de algún dron
  // dejaría vuelos apuntando a un lugar que no opera más.
  const enUso = contarDronesEnBase(id);
  if (enUso > 0) {
    return res.status(409).json({
      error: `La base tiene ${enUso} ${enUso === 1 ? 'dron asignado' : 'drones asignados'}: reasignalos antes de eliminarla`,
    });
  }

  const base = softDeleteBase(id, req.user!.sub)!;
  const ev = createLog('drone', 'BASE_DELETED', req.user!.sub, `${req.user!.sub} eliminó la base "${base.name}"`, {
    meta: { antes: estadoBase(actual), despues: estadoBase(base) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'base_updated', base });
  res.json(base);
});

apiRouter.post('/bases/:id/restore', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const actual = getBase(id);
  if (!actual) return res.status(404).json({ error: 'Base inexistente' });
  if (!actual.deletedAt) return res.status(409).json({ error: 'La base no estaba eliminada' });

  const base = restoreBase(id)!;
  const ev = createLog('drone', 'BASE_RESTORED', req.user!.sub, `${req.user!.sub} restauró la base "${base.name}"`, {
    meta: { antes: estadoBase(actual), despues: estadoBase(base) },
  });
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'base_updated', base });
  res.json(base);
});

// ---- Alertas ----

apiRouter.get('/alerts', requireAuth('operator'), (req, res) => {
  res.json(listAlerts(req.query.status ? String(req.query.status) : undefined));
});

// Alerta completa (con el snapshot): la pide el pop-up del registro.
apiRouter.get('/alerts/:id', requireAuth('operator'), (req, res) => {
  const alert = getAlert(Number(req.params.id));
  if (!alert) return res.status(404).json({ error: 'Alerta inexistente' });
  res.json(alert);
});

// Decisión del operador sobre una alerta: VALIDATED (real) o DISMISSED (falso positivo).
apiRouter.post('/alerts/:id/decision', requireAuth('operator'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { decision } = req.body ?? {};
  if (decision !== 'VALIDATED' && decision !== 'DISMISSED') {
    return res.status(400).json({ error: 'decision debe ser VALIDATED o DISMISSED' });
  }
  const alert = decideAlert(id, decision, req.user!.sub);
  if (!alert) {
    return res.status(getAlert(id) ? 409 : 404).json({ error: 'Alerta inexistente o ya decidida' });
  }

  const message =
    decision === 'VALIDATED'
      ? `Alerta #${id} confirmada como REAL por ${req.user!.sub}; el dron mantiene la órbita`
      : `Alerta #${id} descartada como falso positivo por ${req.user!.sub}; el dron reanuda el patrullaje`;
  const ev = createLog('drone', decision === 'VALIDATED' ? 'ALERT_VALIDATED' : 'ALERT_DISMISSED', req.user!.sub, message, {
    droneId: alert.drone_id,
    alertId: id,
    meta: {
      alerta: { id, tipo: alert.type },
      decision,
      por: req.user!.sub,
      antes: { estado: 'PENDING' },
      despues: { estado: alert.status, decidedBy: alert.decided_by, decidedAt: alert.decided_at },
      drone: alert.drone_id ? metaDron(alert.drone_id) : undefined,
    },
  });

  broadcastOperators({ type: 'alert_updated', alert });
  broadcastOperators({ type: 'event', event: ev });
  if (alert.drone_id) {
    sendToDrone(alert.drone_id, { type: 'alert_decision', alertId: id, decision, decidedBy: req.user!.sub });
  }
  res.json(alert);
});

// ---- Logs ----

apiRouter.get('/events', requireAuth('operator'), (req, res) => {
  const limit = leerLimite(req.query.limit, 200, 1000);
  res.json(listEvents(limit, req.query.droneId ? String(req.query.droneId) : undefined));
});

// Log general del sistema: todas las categorías juntas. Solo el administrador.
// Se pagina y se filtra en SQL; el store termina de sanear page y pageSize.
apiRouter.get('/logs', requireAuth('admin'), (req, res) => {
  const cruda = String(req.query.category ?? '');
  const category = (CATEGORIAS as string[]).includes(cruda) ? (cruda as LogCategory) : undefined;
  const droneId = req.query.droneId ? String(req.query.droneId) : undefined;
  const q = String(req.query.q ?? '').trim();

  res.json(
    listLogs({
      category,
      droneId,
      q: q || undefined,
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 25),
    }),
  );
});

// ---- Usuarios ----

// Supervisor: ve operadores. Admin: ve todos los usuarios humanos.
apiRouter.get('/users', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const roles: Role[] =
    req.user!.role === 'admin' ? ['field_operator', 'operator', 'supervisor', 'admin'] : ['operator'];
  res.json(listUsers(roles, { includeDeleted: flag(req.query.includeDeleted), q: String(req.query.q ?? '') }));
});

/**
 * La contraseña NO la elige quien crea la cuenta: la genera el sistema y se
 * devuelve una sola vez, en esta respuesta, para mostrarla en pantalla. Después
 * solo queda su hash, así que nadie —ni el admin— puede volver a leerla; lo
 * único posible es regenerarla, que deja rastro en el registro.
 */
apiRouter.post('/users', requireAuth('admin'), (req: AuthedRequest, res) => {
  const username = String(req.body?.username ?? '').trim();
  const fullName = String(req.body?.fullName ?? '').trim();
  const role = String(req.body?.role ?? 'operator') as Role;
  if (!/^[a-z0-9_.-]{3,30}$/i.test(username)) return res.status(400).json({ error: 'username inválido (3-30 caracteres alfanuméricos)' });
  if (fullName.length < 3) return res.status(400).json({ error: 'El nombre completo es requerido' });
  if (fullName.length > 60) return res.status(400).json({ error: 'El nombre completo no puede superar 60 caracteres' });
  if (role !== 'operator' && role !== 'supervisor' && role !== 'field_operator') {
    return res.status(400).json({ error: 'role debe ser operator, supervisor o field_operator' });
  }
  // El username sigue ocupado aunque el usuario esté borrado lógicamente
  if (getUser(username)) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });

  // El operador de campo despliega drones, no los pilotea: nunca lleva canControl
  const canControl = role === 'field_operator' ? false : Boolean(req.body?.canControl ?? true);
  const password = generarContrasenia();
  const user = createUser({ username, fullName, passwordHash: bcrypt.hashSync(password, 10), role, canControl });
  const ev = createLog('usuarios', 'USER_CREATED', req.user!.sub, `${req.user!.sub} creó el usuario ${username} (${role})`, {
    meta: { despues: user },
  });
  broadcastOperators({ type: 'event', event: ev });
  // `password` viaja solo acá: no se guarda en claro ni se vuelve a exponer.
  res.status(201).json({ ...user, password });
});

/**
 * Regenerar es la ÚNICA forma de recuperar el acceso a una cuenta: la anterior
 * se pisa y la nueva se muestra una sola vez. Queda registrado quién lo hizo.
 */
apiRouter.post('/users/:username/regenerate-password', requireAuth('admin'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  const target = getUser(username);
  if (!target) return res.status(404).json({ error: 'Usuario inexistente' });
  if (target.deleted) return res.status(409).json({ error: 'El usuario está eliminado: restauralo antes' });

  const password = generarContrasenia();
  const result = updateUser(username, { passwordHash: bcrypt.hashSync(password, 10) })!;
  const ev = createLog(
    'usuarios',
    'USER_PASSWORD_RESET',
    req.user!.sub,
    `${req.user!.sub} regeneró la contraseña de ${username}`,
    { meta: { detalle: { usuario: username, por: req.user!.sub } } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ...result.after, password });
});

// Supervisor: solo el flag canControl de operadores. Admin: todo.
apiRouter.patch('/users/:username', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  const target = getUser(username);
  if (!target) return res.status(404).json({ error: 'Usuario inexistente' });
  if (target.deleted) return res.status(409).json({ error: 'El usuario está eliminado: restauralo antes de modificarlo' });
  if (username === req.user!.sub) return res.status(400).json({ error: 'No podés modificarte a vos mismo' });

  const esAdmin = req.user!.role === 'admin';
  if (!esAdmin && target.role !== 'operator') return res.status(403).json({ error: 'Un supervisor solo administra operadores' });

  const patch: { canControl?: boolean; active?: boolean; fullName?: string } = {};
  if (req.body?.canControl !== undefined) {
    // El mismo invariante que impone el alta: el operador de campo despliega
    // drones, no los pilotea, y por PATCH tampoco puede pasar a hacerlo.
    if (target.role === 'field_operator' && Boolean(req.body.canControl)) {
      return res.status(400).json({ error: 'El operador de campo no controla drones' });
    }
    patch.canControl = Boolean(req.body.canControl);
  }
  if (esAdmin && req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (esAdmin && req.body?.fullName !== undefined) {
    const fullName = String(req.body.fullName).trim();
    if (fullName.length < 3) return res.status(400).json({ error: 'El nombre completo es requerido' });
    if (fullName.length > 60) return res.status(400).json({ error: 'El nombre completo no puede superar 60 caracteres' });
    patch.fullName = fullName;
  }
  // La contraseña no se fija a mano: se regenera con su propio endpoint, que
  // la muestra una sola vez y deja rastro de quién lo hizo.
  if (req.body?.password !== undefined) {
    return res.status(400).json({ error: 'La contraseña no se modifica: usá regenerar contraseña' });
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para modificar' });

  const result = updateUser(username, patch)!;
  // La suspensión del control o la desactivación cortan el control manual en el acto
  if (patch.canControl === false || patch.active === false) {
    releaseAllControlledBy(username, req.user!.sub, patch.active === false ? 'cuenta desactivada' : 'control suspendido');
  }
  // Y la desactivación además le cierra la consola: el token que tiene en el
  // navegador sigue siendo válido, así que el corte va explícito.
  if (patch.active === false) kickUser(username, 'Cuenta desactivada');
  const cambios = Object.keys(patch);
  const ev = createLog(
    'usuarios',
    'USER_UPDATED',
    req.user!.sub,
    `${req.user!.sub} modificó a ${username} (${cambios.join(', ')})`,
    { meta: { antes: result.before, despues: result.after } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json(result.after);
});

// Borrado lógico: la fila queda y el nombre sigue ocupado, para que el
// historial que menciona a ese usuario siga teniendo sentido.
apiRouter.delete('/users/:username', requireAuth('admin'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  if (username === req.user!.sub) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  const target = getUser(username);
  if (!target) return res.status(404).json({ error: 'Usuario inexistente' });

  releaseAllControlledBy(username, req.user!.sub, 'usuario eliminado');
  const result = softDeleteUser(username, req.user!.sub);
  if (!result) return res.status(409).json({ error: 'El usuario ya estaba eliminado' });
  kickUser(username, 'Cuenta eliminada');

  const ev = createLog('usuarios', 'USER_DELETED', req.user!.sub, `${req.user!.sub} eliminó el usuario ${username}`, {
    meta: { antes: result.before, despues: result.after },
  });
  broadcastOperators({ type: 'event', event: ev });
  res.json(result.after);
});

apiRouter.post('/users/:username/restore', requireAuth('admin'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  const target = getUser(username);
  if (!target) return res.status(404).json({ error: 'Usuario inexistente' });
  const result = restoreUser(username);
  if (!result) return res.status(409).json({ error: 'El usuario no estaba eliminado' });

  const ev = createLog('usuarios', 'USER_RESTORED', req.user!.sub, `${req.user!.sub} restauró el usuario ${username}`, {
    meta: { antes: result.before, despues: result.after },
  });
  broadcastOperators({ type: 'event', event: ev });
  res.json(result.after);
});
