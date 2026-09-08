#!/usr/bin/env bash
# Publishes the built game to the server on a port of its own.
#
# Deliberately isolated from the existing site: its own document root, its own
# nginx site file, its own port. It never edits or reloads another vhost's config.
#
#   SSH_USER=youruser ./deploy/deploy.sh
#
set -euo pipefail

SSH_USER="${SSH_USER:?set SSH_USER, e.g. SSH_USER=ubuntu ./deploy/deploy.sh}"
SSH_HOST="${SSH_HOST:-156.155.250.65}"
PORT="${PORT:-8080}"
ROOT="/var/www/zonke"
TARGET="$SSH_USER@$SSH_HOST"

echo "==> building"
npm run build

echo "==> uploading dist/ to $TARGET:$ROOT"
tar -czf - -C dist . | ssh "$TARGET" "sudo mkdir -p '$ROOT' && sudo tar -xzf - -C '$ROOT'"

echo "==> installing nginx site on port $PORT"
sed "s/__PORT__/$PORT/g" deploy/zonke.nginx.conf | ssh "$TARGET" "cat > /tmp/zonke.conf"
ssh "$TARGET" bash -se <<EOF
set -euo pipefail
sudo mv /tmp/zonke.conf /etc/nginx/sites-available/zonke
sudo ln -sfn /etc/nginx/sites-available/zonke /etc/nginx/sites-enabled/zonke
sudo chown -R www-data:www-data '$ROOT'
sudo nginx -t                 # aborts here if the config is bad, before any reload
sudo systemctl reload nginx
command -v ufw >/dev/null && sudo ufw allow $PORT/tcp || true
EOF

echo "==> live at http://$SSH_HOST:$PORT/"
