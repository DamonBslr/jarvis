# Jarvis webhook relay. Build from this folder: docker build -t jarvis-relay relay/
FROM node:24-alpine

WORKDIR /app
COPY package.json server.ts ./

# PORT: where the relay listens. DATA_DIR: hook registrations + queued deliveries (mount a volume).
# TRUST_PROXY=1: the relay sits behind a reverse proxy (Coolify/Traefik), so the client IP for rate
# limiting comes from X-Forwarded-For. Set it to 0 when the port is exposed directly.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TRUST_PROXY=1

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

# RELAY_SECRET must be provided at runtime (the relay refuses to start without it).
CMD ["node", "--disable-warning=ExperimentalWarning", "server.ts"]
