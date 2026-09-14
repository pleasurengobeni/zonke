# syntax=docker/dockerfile:1

# Build stage: better-sqlite3 is a native module - needs a C++ toolchain to compile its
# binding. Only this stage carries that toolchain; the final image copies just the
# already-compiled node_modules across, not python3/make/g++.
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R app:app /app /data
USER app
ENV DATA_DIR=/data
ENV PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
