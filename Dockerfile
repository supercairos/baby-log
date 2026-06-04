# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /app

# Install deps first for better layer caching. --legacy-peer-deps: openapi-typescript@7
# declares a typescript@^5 peer but works fine with the project's TS 6 (codegen-only tool).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps

# Build: generate the typed client from the committed schema, then tsc + vite (no network).
COPY . .
RUN npm run gen:api && npm run build

# ── Runtime: serve the built PWA + proxy /api to the Baby Buddy instance ──────
FROM docker.io/nginxinc/nginx-unprivileged:alpine

# The app is served SAME-ORIGIN with the instance, so nginx proxies /api there. Only our own
# vars are substituted in the config template (nginx's own $uri/$host/… are left untouched).
ENV BABYBUDDY_UPSTREAM=https://babybuddy.la-ruche.info \
    PORT=8080 \
    NGINX_ENVSUBST_FILTER="^(BABYBUDDY_UPSTREAM|PORT)$"

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
# Inherit the base entrypoint: it envsubst's templates → /etc/nginx/conf.d, then runs nginx.
