#!/bin/bash
# setup-ssl.sh — Run ONCE on the server AFTER the domain actually resolves here.
# Mirrors /opt/hungu/scripts/setup-ssl.sh, the pattern every site on this host uses.
#
# What this does:
#   1. Installs nginx/certbot on the host if not already present (every other site
#      on this box shares the one host nginx - it is not reinstalled per app)
#   2. Gets a Let's Encrypt cert for zonkegame.co.za via certbot
#   3. Deploys the reverse-proxy config from this repo
#   4. Reloads nginx — zonkegame.co.za is now live on HTTPS
#
# Usage (on server, from this repo's checkout at /opt/zonkegame):
#   bash scripts/setup-ssl.sh

set -euo pipefail

DOMAIN="zonkegame.co.za"
EMAIL="ngobeni.pleasure@gmail.com"
APP_DIR="/opt/zonkegame"

echo "==> Confirming nginx and certbot are installed..."
apt-get update -qq
apt-get install -y -qq nginx certbot

mkdir -p /var/www/certbot

# Minimal HTTP-only config first, so certbot's webroot challenge has somewhere to answer -
# the full config (below) references a cert that doesn't exist until after this succeeds.
cat > /etc/nginx/sites-available/${DOMAIN} <<EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF

ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
nginx -t && systemctl reload nginx

echo "==> Obtaining SSL certificate for ${DOMAIN}..."
certbot certonly \
  --webroot -w /var/www/certbot \
  -d "${DOMAIN}" -d "www.${DOMAIN}" \
  --non-interactive --agree-tos -m "${EMAIL}"

echo "==> Deploying reverse-proxy config..."
cp "${APP_DIR}/services/web/nginx.host.conf" /etc/nginx/sites-available/${DOMAIN}
nginx -t && systemctl reload nginx

# Renewal: this host already runs certbot.timer for its other sites, so this just confirms
# it's on - a single timer renews every domain's cert, this one included.
if systemctl list-timers certbot.timer &>/dev/null; then
  systemctl enable --now certbot.timer
fi

echo ""
echo "✓ Done! https://${DOMAIN} is live."
