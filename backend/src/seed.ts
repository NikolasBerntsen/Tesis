import bcrypt from 'bcryptjs';
import { db } from './db';

// Usuarios y rutas de demostración. Ejecutar con: npm run seed
const operators = [{ username: 'operador', password: 'operador123' }];

// Cada dron tiene su propia cuenta (con ella inicia sesión la app) y su base.
const drones = [
  { username: 'drone1', password: 'drone123', displayName: 'Alfa',   base: { name: 'Base Norte',  lat: -34.8565, lon: -56.2075 } },
  { username: 'drone2', password: 'drone123', displayName: 'Bravo',  base: { name: 'Base Sur',    lat: -34.8600, lon: -56.2050 } },
  { username: 'drone3', password: 'drone123', displayName: 'Charlie', base: { name: 'Base Este',  lat: -34.8575, lon: -56.2010 } },
];

const routes = [
  {
    name: 'Perímetro Norte',
    description: 'Rectángulo sobre el sector norte del predio',
    waypoints: [
      { lat: -34.856, lon: -56.207, alt: 40 },
      { lat: -34.8532, lon: -56.207, alt: 40 },
      { lat: -34.8532, lon: -56.2036, alt: 40 },
      { lat: -34.856, lon: -56.2036, alt: 40 },
    ],
  },
  {
    name: 'Perímetro Sur',
    description: 'Rectángulo sobre el sector sur del predio',
    waypoints: [
      { lat: -34.8588, lon: -56.207, alt: 40 },
      { lat: -34.8588, lon: -56.2038, alt: 40 },
      { lat: -34.861, lon: -56.2038, alt: 40 },
      { lat: -34.861, lon: -56.207, alt: 40 },
    ],
  },
  {
    name: 'Acceso Este',
    description: 'Recorrido sobre el camino de acceso',
    waypoints: [
      { lat: -34.8575, lon: -56.2015, alt: 45 },
      { lat: -34.8548, lon: -56.2015, alt: 45 },
      { lat: -34.8548, lon: -56.1985, alt: 45 },
      { lat: -34.8575, lon: -56.1985, alt: 45 },
      { lat: -34.8590, lon: -56.2000, alt: 45 },
    ],
  },
];

for (const o of operators) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(o.username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      o.username,
      bcrypt.hashSync(o.password, 10),
      'operator',
    );
    console.log(`Operador creado: ${o.username}`);
  }
}

for (const d of drones) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(d.username);
  if (!exists) {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, display_name, base_name, base_lat, base_lon)
       VALUES (?, ?, 'drone', ?, ?, ?, ?)`,
    ).run(d.username, bcrypt.hashSync(d.password, 10), d.displayName, d.base.name, d.base.lat, d.base.lon);
    console.log(`Dron creado: ${d.username} ("${d.displayName}") en ${d.base.name}`);
  } else {
    // Base de datos anterior al multi-dron: se completan los campos que falten
    // sin pisar un nombre que el usuario ya haya cambiado.
    const info = db
      .prepare(
        `UPDATE users
            SET display_name = COALESCE(display_name, ?),
                base_name    = COALESCE(base_name, ?),
                base_lat     = COALESCE(base_lat, ?),
                base_lon     = COALESCE(base_lon, ?)
          WHERE username = ? AND role = 'drone'
            AND (display_name IS NULL OR base_lat IS NULL OR base_lon IS NULL OR base_name IS NULL)`,
      )
      .run(d.displayName, d.base.name, d.base.lat, d.base.lon, d.username);
    if (info.changes > 0) console.log(`Dron completado: ${d.username} ("${d.displayName}") en ${d.base.name}`);
  }
}

for (const r of routes) {
  const exists = db.prepare('SELECT 1 FROM patrol_routes WHERE name = ?').get(r.name);
  if (!exists) {
    db.prepare('INSERT INTO patrol_routes (name, description, waypoints) VALUES (?, ?, ?)').run(
      r.name,
      r.description,
      JSON.stringify(r.waypoints),
    );
    console.log(`Ruta creada: ${r.name} (${r.waypoints.length} waypoints)`);
  }
}

console.log('Seed completo.');
