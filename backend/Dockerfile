FROM node:20-slim

# better-sqlite3 es un módulo nativo: estas herramientas permiten compilarlo
# si npm no encuentra un binario precompilado para esta plataforma.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 4000

# El seed es idempotente: crea usuarios y rutas solo si no existen.
CMD ["sh", "-c", "npm run seed && npm run dev"]
