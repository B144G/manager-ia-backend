# Image Docker de Brij-IA (Node 20). Les données sont dans PostgreSQL (Neon) : le conteneur ne garde rien, il peut être remplacé à tout moment.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --omit=optional; else npm install --omit=dev --omit=optional; fi

FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
