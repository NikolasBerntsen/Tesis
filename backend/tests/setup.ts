// Se ejecuta antes de importar cualquier módulo del backend en CADA archivo de
// test (modo aislado). Garantiza que config.ts/db.ts abran una base efímera en
// memoria y usen un secreto de JWT conocido, pase lo que pase con el .env real.
process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-vitest';
process.env.NODE_ENV = 'test';
