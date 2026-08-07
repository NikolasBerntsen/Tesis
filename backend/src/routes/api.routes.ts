import { Router } from 'express';
import { requireAuth, type AuthedRequest } from '../auth';
import { createEvent, decideAlert, getAlert, getRoutes, listAlerts, listEvents } from '../store';
import { broadcastOperators, sendToDrones } from '../ws';

export const apiRouter = Router();

apiRouter.get('/routes', requireAuth(), (_req, res) => {
  res.json(getRoutes());
});

apiRouter.get('/events', requireAuth('operator'), (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json(listEvents(limit));
});

apiRouter.get('/alerts', requireAuth('operator'), (req, res) => {
  res.json(listAlerts(req.query.status ? String(req.query.status) : undefined));
});

// Decisión del operador sobre una alerta: VALIDATED (real) o DISMISSED (falso positivo).
// Queda registrado quién decidió y se notifica al dron para que actúe.
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
  sendToDrones({ type: 'alert_decision', alertId: id, decision, decidedBy: req.user!.sub });
  res.json(alert);
});

// Liberar al dron de una órbita sobre alerta validada y devolverlo a su ruta.
apiRouter.post('/drone/resume', requireAuth('operator'), (req: AuthedRequest, res) => {
  const ev = createEvent('PATROL_RESUME_ORDERED', 'operator', `${req.user!.sub} ordenó reanudar el patrullaje`);
  broadcastOperators({ type: 'event', event: ev });
  sendToDrones({ type: 'resume_patrol', orderedBy: req.user!.sub });
  res.json({ ok: true });
});
