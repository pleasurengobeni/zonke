# syntax=docker/dockerfile:1

# Stage 1: build the static bundle.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve it from an already-hardened, non-root nginx image - no manual user/chown
# work needed, nginx-unprivileged listens on 8080 as uid 101 out of the box.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY services/web/nginx.container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
