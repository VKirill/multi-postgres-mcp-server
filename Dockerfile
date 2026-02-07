FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# --- Production ---
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/

# Config file should be mounted at runtime
# docker run -v /path/to/config.json:/app/config.json mcp-postgres --config /app/config.json
ENV MCP_POSTGRES_CONFIG=/app/config.json

ENTRYPOINT ["node", "dist/index.js"]
