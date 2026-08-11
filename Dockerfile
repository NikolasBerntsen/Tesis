# --- Etapa 1: build del frontend ---
FROM node:20-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Etapa 2: build del backend ---
FROM node:20-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /be
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# --- Etapa 3: imagen final ---
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
# Solo dependencias de produccion (compila better-sqlite3, modulo nativo)
RUN npm ci --omit=dev && apt-get purge -y make g++ 2>/dev/null || true
COPY --from=backend /be/dist ./dist
# El backend sirve el frontend desde ./public (ver src/app.ts)
COPY --from=frontend /fe/dist ./public
# El seed se ejecuta al arrancar (idempotente) para tener usuarios y rutas
COPY --from=backend /be/dist/seed.js ./dist/seed.js

EXPOSE 4000
ENV PORT=4000
ENV DB_FILE=/data/comando-central.db
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

# Siembra (idempotente) y arranca
CMD ["sh", "-c", "node dist/seed.js && node dist/index.js"]
