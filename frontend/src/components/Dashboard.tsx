import { useEffect, useState } from 'react';
import { api, getUsername } from '../api';
import type { Alert, DroneStatus, EventRow } from '../types';
import { useWebSocket } from '../useWebSocket';
import AlertsPanel from './AlertsPanel';
import DroneStatusCard from './DroneStatusCard';
import EventLog from './EventLog';
import LiveVideo from './LiveVideo';

const MAX_EVENTS = 300;

export default function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [status, setStatus] = useState<DroneStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    api<Alert[]>('/alerts').then(setAlerts).catch(console.error);
    api<EventRow[]>('/events').then(setEvents).catch(console.error);
  }, []);

  const connected = useWebSocket((msg) => {
    switch (msg.type) {
      case 'status':
        setStatus(msg);
        break;
      case 'video_frame':
        setFrame(msg.jpegBase64);
        break;
      case 'event':
        setEvents((prev) => [msg.event, ...prev].slice(0, MAX_EVENTS));
        break;
      case 'alert_created':
        setAlerts((prev) => [msg.alert, ...prev]);
        break;
      case 'alert_updated':
        setAlerts((prev) => prev.map((a) => (a.id === msg.alert.id ? msg.alert : a)));
        break;
    }
  });

  async function decide(id: number, decision: 'VALIDATED' | 'DISMISSED') {
    await api(`/alerts/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
  }

  async function resumePatrol() {
    await api('/drone/resume', { method: 'POST' });
  }

  return (
    <div className="dashboard">
      <header className="topbar">
        <h1>Comando Central</h1>
        <div className="topbar-right">
          <span className={connected ? 'conn ok' : 'conn bad'}>{connected ? '● conectado' : '● sin conexión'}</span>
          <span className="username">{getUsername()}</span>
          <button className="ghost" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      <main className="grid">
        <section className="col">
          <DroneStatusCard status={status} onResumePatrol={resumePatrol} />
          <AlertsPanel alerts={alerts} onDecide={decide} />
        </section>
        <section className="col">
          <LiveVideo frame={frame} />
          <EventLog events={events} />
        </section>
      </main>
    </div>
  );
}
