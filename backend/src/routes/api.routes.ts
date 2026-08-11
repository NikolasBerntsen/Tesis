import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../auth';
import { createEvent, decideAlert, getAlert, getDroneIdentity, getRoutes, listAlerts, listEvents } from '../store';
import { applyRename, broadcastOperators, droneCard, listDroneCards, sendToDrone } from '../ws';

export const apiRouter = Router();

// Ficha del usuario autenticado. La app del dron la usa tras iniciar sesión
// para saber su nombre visible y su base.
apiRouter.get('/me', requireAuth(), (req: AuthedRequest, res) => {
  const { sub, role } = req.user!;
  if (role === 'drone') {
    const identity = getDroneIdentity(sub);
    if (!identity) return res.status(404).json({ error: 'Dron inexistente' });
    return res.json({ username: sub, role, ...identity });
  }
  res.json({ username: sub, role });
});

apiRouter.get('/routes', requireAuth(), (_req, res) => {
  res.json(getRoutes());
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

  const identity = applyRename(req.params.droneId, displayName, true);
  if (!identity) return res.status(404).json({ error: 'Dron inexistente' });

  const ev = createEvent(
    'DRONE_RENAMED',
    'operator',
    `${req.user!.sub} renombró al dron ${identity.droneId} como "${displayName}"`,
    identity.droneId,
  );
  broadcastOperators({ type: 'event', event: ev });
  res.json(droneCard(identity.droneId));
});

apiRouter.get('/events', requireAuth('operator'), (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json(listEvents(limit, req.query.droneId ? String(req.query.droneId) : undefined));
});

apiRouter.get('/alerts', requireAuth('operator'), (req, res) => {
  res.json(listAlerts(req.query.status ? String(req.query.status) : undefined));
});

// Decisión del operador sobre una alerta: VALIDATED (real) o DISMISSED (falso positivo).
// Queda registrado quién decidió y se notifica al dron que la generó.
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
  const ev = createEvent(decision === 'VALIDATED' ? 'ALERT_VALIDATED' : 'ALERT_DISMISSED', 'operator', message, alert.drone_id, id);

  broadcastOperators({ type: 'alert_updated', alert });
  broadcastOperators({ type: 'event', event: ev });
  if (alert.drone_id) {
    sendToDrone(alert.drone_id, { type: 'alert_decision', alertId: id, decision, decidedBy: req.user!.sub });
  }
  res.json(alert);
});

// Liberar a un dron de una órbita sobre alerta validada y devolverlo a su ruta.
apiRouter.post('/drones/:droneId/resume', requireAuth('operator'), (req: AuthedRequest, res) => {
  const { droneId } = req.params;
  if (!getDroneIdentity(droneId)) return res.status(404).json({ error: 'Dron inexistente' });

  const ev = createEvent('PATROL_RESUME_ORDERED', 'operator', `${req.user!.sub} ordenó reanudar el patrullaje`, droneId);
  broadcastOperators({ type: 'event', event: ev });
  const delivered = sendToDrone(droneId, { type: 'resume_patrol', orderedBy: req.user!.sub });
  res.json({ ok: true, delivered });
});
