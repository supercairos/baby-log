# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Build with a PLACEHOLDER base; the real BASE_PATH is substituted at container start, so a
# single image can be served at any subpath via `docker run -e BASE_PATH=/quick-ui/`.
FROM node:24-slim AS builder
ENV BASE_PATH=/__BASE_PATH__/
WORKDIR /app

# Install deps first for better layer caching. --legacy-peer-deps: openapi-typescript@7
# declares a typescript@^5 peer but works fine with the project's TS 6 (codegen-only tool).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps

# Build: generate the typed client from the committed schema, then tsc + vite (no network).
# build-docker bakes react-env values from .env.docker into the app (public/env/__ENV.js).
COPY . .
RUN npm run gen:api && npm run build-docker

# ── Runtime: serve the built PWA + proxy /api to the Baby Buddy instance ──────
FROM docker.io/nginxinc/nginx-unprivileged:alpine
USER root

# BASE_PATH (runtime) is substituted into the build + the nginx config at start. The other
# vars: nginx proxies /api to the instance (same-origin); the filter keeps nginx's own
# $uri/$host/… untouched during envsubst.
ENV BABYBUDDY_UPSTREAM=https://babybuddy.la-ruche.info \
    PORT=8080 \
    BASE_PATH=/ \
    NGINX_ENVSUBST_FILTER="^(BABYBUDDY_UPSTREAM|PORT|BASE_PATH)$"

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/05-normalize-base-path.envsh /docker-entrypoint.d/05-normalize-base-path.envsh
COPY docker/99-base-path.sh /docker-entrypoint.d/99-base-path.sh

# The non-root user must own the web root (the entrypoint rewrites + relocates the build).
RUN chown -R 101:101 /usr/share/nginx/html \
 && chmod +x /docker-entrypoint.d/99-base-path.sh

USER 101
EXPOSE 8080
# Base entrypoint: sources *.envsh (05 normalizes BASE_PATH) → envsubst's templates →
# runs *.sh (99 bakes BASE_PATH into the build + relocates it) → starts nginx.
