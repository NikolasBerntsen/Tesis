import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Me, UserView } from '../types';

const ROL = { operator: 'Operador', supervisor: 'Supervisor', admin: 'Administrador' } as const;

/**
 * Gestión de usuarios. El supervisor ve operadores y suspende/restaura su
 * capacidad de controlar drones; el admin además crea, desactiva, reactiva y
 * elimina usuarios.
 */
export default function UsersView({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState('');
  const [nuevo, setNuevo] = useState({ username: '', password: '', role: 'operator', canControl: true });

  const esAdmin = me.role === 'admin';

  function cargar() {
    api<UserView[]>('/users').then(setUsers).catch((e) => setError(String(e.message ?? e)));
  }
  useEffect(cargar, []);

  async function accion(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const patch = (username: string, body: object) => () =>
    accion(() => api(`/users/${username}`, { method: 'PATCH', body: JSON.stringify(body) }));

  function crear(e: FormEvent) {
    e.preventDefault();
    accion(async () => {
      await api('/users', { method: 'POST', body: JSON.stringify(nuevo) });
      setNuevo({ username: '', password: '', role: 'operator', canControl: true });
    });
  }

  return (
    <main className="page-main">
      <div className="card">
        <h2>Usuarios</h2>
        {error && <p className="bad">{error}</p>}
        <table className="tabla">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Control de drones</th>
              <th>Estado</th>
              {esAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const esYo = u.username === me.username;
              const puedeTocarControl = !esYo && (esAdmin || u.role === 'operator');
              return (
                <tr key={u.username}>
                  <td>{u.username}{esYo && <span className="muted"> (vos)</span>}</td>
                  <td>{ROL[u.role]}</td>
                  <td>
                    <span className={u.canControl ? 'ok' : 'bad'}>{u.canControl ? 'Autorizado' : 'Suspendido'}</span>{' '}
                    {puedeTocarControl && (
                      <button className="chico" onClick={patch(u.username, { canControl: !u.canControl })}>
                        {u.canControl ? 'Suspender' : 'Restaurar'}
                      </button>
                    )}
                  </td>
                  <td>
                    <span className={u.active ? 'ok' : 'muted'}>{u.active ? 'Activo' : 'Desactivado'}</span>{' '}
                    {esAdmin && !esYo && (
                      <button className="chico" onClick={patch(u.username, { active: !u.active })}>
                        {u.active ? 'Desactivar' : 'Reactivar'}
                      </button>
                    )}
                  </td>
                  {esAdmin && (
                    <td>
                      {!esYo && (
                        <button
                          className="chico dismiss"
                          onClick={() =>
                            confirm(`¿Eliminar definitivamente a ${u.username}?`) &&
                            accion(() => api(`/users/${u.username}`, { method: 'DELETE' }))
                          }
                        >
                          Eliminar
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {esAdmin && (
        <div className="card">
          <h2>Crear usuario</h2>
          <form className="form-crear" onSubmit={crear}>
            <label>
              Usuario
              <input value={nuevo.username} onChange={(e) => setNuevo({ ...nuevo, username: e.target.value })} required />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={nuevo.password}
                onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })}
                minLength={6}
                required
              />
            </label>
            <label>
              Rol
              <select value={nuevo.role} onChange={(e) => setNuevo({ ...nuevo, role: e.target.value })}>
                <option value="operator">Operador</option>
                <option value="supervisor">Supervisor</option>
              </select>
            </label>
            <label className="fila">
              <input
                type="checkbox"
                checked={nuevo.canControl}
                onChange={(e) => setNuevo({ ...nuevo, canControl: e.target.checked })}
              />
              Puede controlar drones
            </label>
            <button type="submit">Crear</button>
          </form>
        </div>
      )}
    </main>
  );
}
