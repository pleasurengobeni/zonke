# Deploying zonkegame.co.za

Follows the same convention as every other site on the host (see `/opt/hungu`,
`/opt/xwall`, `/opt/lulamisapay`): its own folder under `/opt`, its own Docker
container bound to `127.0.0.1` only, and the one host nginx as the single
internet-facing hop that terminates TLS and proxies inward. Nothing here is
shared with another app, and nothing here touches another app's config.

## Layout

- `Dockerfile` — multi-stage build: `node:22-alpine` builds the Vite bundle,
  `nginxinc/nginx-unprivileged:1.27-alpine` serves it as a non-root user on
  port 8080 inside the container.
- `services/web/nginx.container.conf` — nginx config baked into the image.
- `services/web/nginx.host.conf` — the **host** nginx vhost for
  `zonkegame.co.za` / `www.zonkegame.co.za`, deployed to
  `/etc/nginx/sites-available/` on the server.
- `scripts/setup-ssl.sh` — one-time bootstrap: gets the Let's Encrypt cert,
  then deploys the full host vhost. Mirrors `/opt/hungu/scripts/setup-ssl.sh`.
- `docker-compose.yml` — runs the container hardened: read-only root
  filesystem, all capabilities dropped, no privilege escalation, published
  only to `127.0.0.1:8090`.

## First deploy (once the domain resolves to this server)

```bash
cd /opt
git clone https://github.com/pleasurengobeni/zonke.git zonkegame
cd zonkegame
docker compose up -d --build
curl http://127.0.0.1:8090/          # sanity check before going near nginx/TLS
bash scripts/setup-ssl.sh            # requires DNS to already resolve here
```

## Redeploying after a change

```bash
cd /opt/zonkegame
git pull
docker compose up -d --build
```

Certificate renewal is handled by the host's existing `certbot.timer` — the
same one renewing every other site's certs, not a per-app cron job.
