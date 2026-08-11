import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { ROLE_RANK, requireAuth, type AuthedRequest } from '../auth';
import {
  createLog, createUser, decideAlert, deleteUser, getAlert, getDroneIdentity, getRoute, getRoutes,
  getUser, listAlerts, listEvents, listLogs, listUsers, setWaypointLabel, updateUser, type LogCategory, type Role,
} from '../store';
import {
  applyRename, broadcastOperators, droneCard, getController, listDroneCards,
  releaseAllControlledBy, releaseControl, sendToDrone, takeControl,
} from '../ws';

export const apiRouter = Router();

// Ficha del usuario autenticado. La app del dron la usa tras iniciar sesión
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

apiRouter.get('/routes', requireAuth(), (_req, res) => {
  res.json(getRoutes());
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
    { meta: { antes, despues: label } },
  );
  broadcastOperators({ type: 'event', event: ev });
  broadcastOperators({ type: 'route_updated', route });
  res.json(route);
});

apiRouter.get('/drones', requireAuth('operator'), (_req, res) => {
  res.json(listDroneCards());
});

// Renombrado desde el Comando Central: se avisa al dron para que la app
// actualice el nombre que muestra.
apiRouter.patch('/drones/:droneId', requireAuth('operator'), (req: AuthedRequest, res) => {
  const displayName = String(req.body?.displayName ?? '').trim();
  if (!displayName) return res.status(400).json({ error: 'displayName es requerido' });
  if (displayName.length > 40) return res.status(400).json({ error: 'displayName no puede superar 40 caracteres' });

  const antes = getDroneIdentity(req.params.droneId)?.displayName;
  const identity = applyRename(req.params.droneId, displayName, true);
  if (!identity) return res.status(404).json({ error: 'Dron inexistente' });

  const ev = createLog(
    'drone',
    'DRONE_RENAMED',
    req.user!.sub,
    `${req.user!.sub} renombró al dron ${identity.droneId} como "${displayName}"`,
    { droneId: identity.droneId, meta: { antes, despues: displayName } },
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json(droneCard(identity.droneId));
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
  const fromIndex = Number(req.body?.fromIndex ?? 0);
  if (fromIndex < 0 || fromIndex >= route.waypoints.length) return res.status(400).json({ error: 'fromIndex fuera de rango' });
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const delivered = sendToDrone(droneId, { type: 'start_route', routeId: route.id, fromIndex, orderedBy: req.user!.sub });
  const ev = createLog('drone', 'ROUTE_STARTED', req.user!.sub, `${req.user!.sub} ordenó patrullar "${route.name}" desde el nodo ${fromIndex + 1}`, { droneId });
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true, delivered });
});

apiRouter.post('/drones/:droneId/route/stop', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });
  const holder = checkNotControlledByOther(droneId, req.user!);
  if (holder) return res.status(409).json({ error: `El dron está controlado por ${holder}` });

  const delivered = sendToDrone(droneId, { type: 'stop_patrol', orderedBy: req.user!.sub });
  const ev = createLog('drone', 'PATROL_STOPPED', req.user!.sub, `${req.user!.sub} interrumpió el patrullaje del dron ${droneId}`, { droneId });
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
  const ev = createLog('drone', 'PATROL_RESUME_ORDERED', req.user!.sub, `${req.user!.sub} ordenó reanudar el patrullaje ${detalle}`, { droneId });
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
  const ev = createLog('drone', 'FORCED_GOTO', req.user!.sub, `${req.user!.sub} forzó al dron ${droneId} hacia ${nombre} de "${route.name}"`, { droneId });
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
  const esSupervisor = ROLE_RANK[req.user!.role] >= ROLE_RANK.supervisor;
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

// ---- Alertas ----

apiRouter.get('/alerts', requireAuth('operator'), (req, res) => {
  res.json(listAlerts(req.query.status ? String(req.query.status) : undefined));
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
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json(listEvents(limit, req.query.droneId ? String(req.query.droneId) : undefined));
});

// Log general del sistema: todas las categorías juntas. Solo el administrador.
apiRouter.get('/logs', requireAuth('admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const category = req.query.category ? (String(req.query.category) as LogCategory) : undefined;
  res.json(listLogs(limit, category));
});

// ---- Usuarios ----

// Supervisor: ve operadores. Admin: ve todos los usuarios humanos.
apiRouter.get('/users', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const roles: Role[] = req.user!.role === 'admin' ? ['operator', 'supervisor', 'admin'] : ['operator'];
  res.json(listUsers(roles));
});

apiRouter.post('/users', requireAuth('admin'), (req: AuthedRequest, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = String(req.body?.role ?? 'operator') as Role;
  const canControl = Boolean(req.body?.canControl ?? true);
  if (!/^[a-z0-9_.-]{3,30}$/i.test(username)) return res.status(400).json({ error: 'username inválido (3-30 caracteres alfanuméricos)' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (role !== 'operator' && role !== 'supervisor') return res.status(400).json({ error: 'role debe ser operator o supervisor' });
  if (getUser(username)) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre' });

  const user = createUser(username, bcrypt.hashSync(password, 10), role, canControl);
  const ev = createLog('usuarios', 'USER_CREATED', req.user!.sub, `${req.user!.sub} creó el usuario ${username} (${role})`, {
    meta: { despues: user },
  });
  broadcastOperators({ type: 'event', event: ev });
  res.status(201).json(user);
});

// Supervisor: solo el flag canControl de operadores. Admin: todo.
apiRouter.patch('/users/:username', requireAuth('supervisor'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  const target = getUser(username);
  if (!target || target.role === 'drone') return res.status(404).json({ error: 'Usuario inexistente' });
  if (username === req.user!.sub) return res.status(400).json({ error: 'No podés modificarte a vos mismo' });

  const esAdmin = req.user!.role === 'admin';
  if (!esAdmin && target.role !== 'operator') return res.status(403).json({ error: 'Un supervisor solo administra operadores' });

  const patch: { canControl?: boolean; active?: boolean; passwordHash?: string } = {};
  if (req.body?.canControl !== undefined) patch.canControl = Boolean(req.body.canControl);
  if (esAdmin && req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (esAdmin && typeof req.body?.password === 'string' && req.body.password.length >= 6) {
    patch.passwordHash = bcrypt.hashSync(req.body.password, 10);
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para modificar' });

  const result = updateUser(username, patch)!;
  // La suspensión del control o la desactivación cortan el control manual en el acto
  if (patch.canControl === false || patch.active === false) {
    releaseAllControlledBy(username, req.user!.sub, patch.active === false ? 'cuenta desactivada' : 'control suspendido');
  }
  const cambios = Object.keys(patch).filter((k) => k !== 'passwordHash');
  if (patch.passwordHash) cambios.push('password');
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

apiRouter.delete('/users/:username', requireAuth('admin'), (req: AuthedRequest, res) => {
  const { username } = req.params;
  if (username === req.user!.sub) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  const target = getUser(username);
  if (!target || target.role === 'drone') return res.status(404).json({ error: 'Usuario inexistente' });

  releaseAllControlledBy(username, req.user!.sub, 'usuario eliminado');
  const before = deleteUser(username)!;
  const ev = createLog('usuarios', 'USER_DELETED', req.user!.sub, `${req.user!.sub} eliminó el usuario ${username}`, {
    meta: { antes: before },
  });
  broadcastOperators({ type: 'event', event: ev });
  res.json({ ok: true });
});
