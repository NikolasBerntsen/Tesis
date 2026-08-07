import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'secreto-dev-cambiar',
  dbFile: process.env.DB_FILE ?? './data/comando-central.db',
  tokenTtl: '12h',
};
