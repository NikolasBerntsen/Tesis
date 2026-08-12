import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db';

// Usuarios, drones y rutas de demostración. Ejecutar con: npm run seed
const humans = [
  { username: 'campo', password: 'campo123', role: 'field_operator' },
  { username: 'operador', password: 'operador123', role: 'operator' },
  { username: 'supervisor', password: 'supervisor123', role: 'supervisor' },
  { username: 'admin', password: 'admin123', role: 'admin' },
];

/**
 * Hash determinista SOLO para los drones de demostración: así el seed es
 * idempotente y los QR de prueba que se imprimieron una vez siguen sirviendo
 * después de recrear la base. Los drones reales se dan de alta desde la consola,
 * que genera el hash con randomBytes.
 */
function hashDemo(semilla: string): string {
  return createHash('sha256').update(`tesis-demo:${semilla}`).digest('hex').slice(0, 32);
}

const drones = [
  { semilla: 'alfa',    displayName: 'Alfa',    model: 'DJI Mini 3',  base: { name: 'Base Norte', lat: -34.8565, lon: -56.2075 } },
  { semilla: 'bravo',   displayName: 'Bravo',   model: 'DJI Mini 3',  base: { name: 'Base Sur',   lat: -34.86,   lon: -56.205  } },
  { semilla: 'charlie', displayName: 'Charlie', model: 'DJI Air 3',   base: { name: 'Base Este',  lat: -34.8575, lon: -56.201  } },
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
      { lat: -34.859, lon: -56.2, alt: 45 },
    ],
  },
];

for (const h of humans) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(h.username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, password_hash, role, can_control) VALUES (?, ?, ?, ?)').run(
      h.username,
      bcrypt.hashSync(h.password, 10),
      h.role,
      // El operador de campo despliega drones, no los pilotea
      h.role === 'field_operator' ? 0 : 1,
    );
    console.log(`Usuario creado: ${h.username} (${h.role})`);
  }
}

/** Las bases son un activo propio: se dan de alta una vez y los drones apuntan. */
function idDeBase(b: { name: string; lat: number; lon: number }): number {
  const ya = db.prepare('SELECT id FROM bases WHERE name = ? AND deleted_at IS NULL').get(b.name) as { id: number } | undefined;
  if (ya) return ya.id;
  const info = db
    .prepare("INSERT INTO bases (name, lat, lon, created_at, created_by) VALUES (?, ?, ?, ?, 'seed')")
    .run(b.name, b.lat, b.lon, new Date().toISOString());
  console.log(`Base creada: ${b.name}`);
  return Number(info.lastInsertRowid);
}

console.log('Drones de demostración (el contenido del QR es el hash):');
for (const d of drones) {
  const hash = hashDemo(d.semilla);
  // Si la base venía del esquema viejo, la migración ya creó este dron con otro
  // hash: se respeta el existente en vez de duplicarlo.
  const existente = db
    .prepare('SELECT hash FROM drones WHERE hash = ? OR display_name = ?')
    .get(hash, d.displayName) as { hash: string } | undefined;

  if (existente) {
    console.log(`  ${d.displayName.padEnd(8)} ${existente.hash}  (ya existía)`);
    continue;
  }
  db.prepare(
    `INSERT INTO drones (hash, display_name, model, inventory_code, base_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'seed')`,
  ).run(hash, d.displayName, d.model, `INV-${d.semilla.toUpperCase()}`, idDeBase(d.base), new Date().toISOString());
  console.log(`  ${d.displayName.padEnd(8)} ${hash}  (${d.model}, ${d.base.name})`);
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
