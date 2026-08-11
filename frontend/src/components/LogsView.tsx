import { useEffect, useState } from 'react';
import { api } from '../api';
import { time } from '../format';
import type { EventRow } from '../types';

const TABS = [
  { key: '', label: 'Todos' },
  { key: 'drone', label: 'Drones' },
  { key: 'usuarios', label: 'Usuarios' },
  { key: 'sistema', label: 'Sistema' },
] as const;

/** Registro general del sistema (solo admin): todas las categorías juntas. */
export default function LogsView() {
  const [tab, setTab] = useState<string>('');
  const [logs, setLogs] = useState<EventRow[]>([]);

  function cargar(categoria: string) {
    const q = categoria ? `?category=${categoria}&limit=500` : '?limit=500';
    api<EventRow[]>(`/logs${q}`).then(setLogs).catch(console.error);
  }
  useEffect(() => cargar(tab), [tab]);

  return (
    <main className="page-main">
      <div className="card log-card">
        <div className="log-head">
          <h2>Registro del sistema</h2>
          <div className="view-switch">
            {TABS.map((t) => (
              <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
            <button onClick={() => cargar(tab)}>Actualizar</button>
          </div>
        </div>
        <div className="log">
          {logs.length === 0 && <p className="muted">Sin registros.</p>}
          {logs.map((l) => (
            <div key={l.id} className="log-row log-row-general">
              <span className="muted mono">{time(l.ts)}</span>
              <span className={`cat-badge cat-${l.category}`}>{l.category}</span>
              <span className="event-type mono">{l.type}</span>
              <span>
                {l.message}
                {l.meta && (
                  <details className="meta">
                    <summary>antes / después</summary>
                    <pre>{JSON.stringify(JSON.parse(l.meta), null, 2)}</pre>
                  </details>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
