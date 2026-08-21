import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db';

// Usuarios, drones y rutas de demostración. Ejecutar con: npm run seed
const humans = [
  { username: 'campo', password: 'campo123', role: 'field_operator', fullName: 'Camila Ferreira' },
  { username: 'operador', password: 'operador123', role: 'operator', fullName: 'Martín Olivera' },
  { username: 'supervisor', password: 'supervisor123', role: 'supervisor', fullName: 'Lucía Sosa' },
  { username: 'admin', password: 'admin123', role: 'admin', fullName: 'Diego Antúnez' },
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

/* Las tres bases de demostración están repartidas por la Ciudad de Buenos
   Aires, con el Obelisco de referencia: los mapas abren ahí y no hay que
   arrastrarlos hasta la ciudad antes de poder trabajar. */
const BASES = {
  obelisco: { name: 'Base Obelisco', lat: -34.6037, lon: -58.3816 },
  retiro:   { name: 'Base Retiro',   lat: -34.5925, lon: -58.3745 },
  palermo:  { name: 'Base Palermo',  lat: -34.5735, lon: -58.4120 },
};

const drones = [
  { semilla: 'alfa',    displayName: 'Alfa',    model: 'DJI Mini 3',  base: BASES.obelisco },
  { semilla: 'bravo',   displayName: 'Bravo',   model: 'DJI Mini 3',  base: BASES.retiro },
  { semilla: 'charlie', displayName: 'Charlie', model: 'DJI Air 3',   base: BASES.palermo },
];

/* Cada ruta nace asignada a una base: un dron sólo puede patrullar las rutas
   de la base de la que sale, así que una ruta sin base no la puede volar
   nadie. */
const routes = [
  {
    name: 'Perímetro 9 de Julio',
    description: 'Vuelta a la manzana del Obelisco',
    bases: [BASES.obelisco],
    waypoints: [
      { lat: -34.6015, lon: -58.3840, alt: 40, label: 'Cerrito' },
      { lat: -34.6015, lon: -58.3792, alt: 40 },
      { lat: -34.6060, lon: -58.3792, alt: 40 },
      { lat: -34.6060, lon: -58.3840, alt: 40 },
    ],
  },
  {
    name: 'Corredor Corrientes',
    description: 'Recorrido sobre la avenida, del Obelisco al este',
    bases: [BASES.obelisco],
    waypoints: [
      { lat: -34.6034, lon: -58.3800, alt: 45 },
      { lat: -34.6029, lon: -58.3760, alt: 45 },
      { lat: -34.6024, lon: -58.3720, alt: 45 },
      { lat: -34.6019, lon: -58.3690, alt: 45, label: 'Alem' },
    ],
  },
  {
    name: 'Circuito Retiro',
    description: 'Perímetro de la plaza y la estación',
    bases: [BASES.retiro],
    waypoints: [
      { lat: -34.5905, lon: -58.3765, alt: 50 },
      { lat: -34.5905, lon: -58.3722, alt: 50 },
      { lat: -34.5948, lon: -58.3722, alt: 50 },
      { lat: -34.5948, lon: -58.3765, alt: 50 },
    ],
  },
  {
    name: 'Bosques de Palermo',
    description: 'Vuelta a los lagos',
    bases: [BASES.palermo],
    waypoints: [
      { lat: -34.5708, lon: -58.4162, alt: 55 },
      { lat: -34.5708, lon: -58.4082, alt: 55 },
      { lat: -34.5766, lon: -58.4082, alt: 55 },
      { lat: -34.5766, lon: -58.4162, alt: 55 },
      { lat: -34.5735, lon: -58.4120, alt: 55, label: 'Rosedal' },
    ],
  },
];

for (const h of humans) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(h.username);
  if (!exists) {
    db.prepare('INSERT INTO users (username, full_name, password_hash, role, can_control) VALUES (?, ?, ?, ?, ?)').run(
      h.username,
      h.fullName,
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
  const ya = db.prepare('SELECT id FROM bases WHERE name = ? AND deleted = 0').get(b.name) as { id: number } | undefined;
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
  const ya = db.prepare('SELECT id FROM patrol_routes WHERE name = ?').get(r.name) as { id: number } | undefined;
  let routeId = ya?.id;
  if (!routeId) {
    const info = db
      .prepare('INSERT INTO patrol_routes (name, description, waypoints) VALUES (?, ?, ?)')
      .run(r.name, r.description, JSON.stringify(r.waypoints));
    routeId = Number(info.lastInsertRowid);
    console.log(`Ruta creada: ${r.name} (${r.waypoints.length} nodos)`);
  }
  // Sin esto la demostración arranca con todas las bases vacías y ningún dron
  // tiene una sola ruta para patrullar.
  for (const b of r.bases) {
    db.prepare('INSERT OR IGNORE INTO base_routes (base_id, route_id) VALUES (?, ?)').run(idDeBase(b), routeId);
    console.log(`  asignada a ${b.name}`);
  }
}

console.log('Seed completo.');
