import bcrypt from 'bcryptjs';
import { db } from './db';

// Usuarios y rutas de demostración. Ejecutar con: npm run seed
const users = [
  { username: 'operador', password: 'operador123', role: 'operator' },
  { username: 'drone1', password: 'drone123', role: 'drone' },
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
];

for (const u of users) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      u.username,
      bcrypt.hashSync(u.password, 10),
      u.role,
    );
    console.log(`Usuario creado: ${u.username} (${u.role})`);
  }
}

const routeCount = (db.prepare('SELECT COUNT(*) AS c FROM patrol_routes').get() as { c: number }).c;
if (routeCount === 0) {
  for (const r of routes) {
    db.prepare('INSERT INTO patrol_routes (name, description, waypoints) VALUES (?, ?, ?)').run(
      r.name,
      r.description,
      JSON.stringify(r.waypoints),
    );
    console.log(`Ruta creada: ${r.name} (${r.waypoints.length} waypoints)`);
  }
}

console.log('Seed completo.');
