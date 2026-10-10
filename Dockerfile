# ---- build: compile the Tailwind CSS ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build:css

# ---- run: production dependencies only ----
FROM node:22-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

# The database and uploaded images live here. Mount a persistent volume on it.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
