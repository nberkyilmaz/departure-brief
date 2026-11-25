#!/usr/bin/env bash
# Puts the files in deploy/server where the server uses them. Run as root from
# the checkout at /opt/depbrief/src; depbrief-update runs it after every pull,
# and it is safe to run again. It touches no secrets and nothing outside the
# paths below.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

command -v jq >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null

install -m 755 "$here"/bin/* /usr/local/sbin/
install -m 644 "$here/cron.d/depbrief" /etc/cron.d/depbrief
install -m 644 "$here/logrotate.d/depbrief" /etc/logrotate.d/depbrief
install -m 644 "$here/apt/52unattended-upgrades-local" /etc/apt/apt.conf.d/52unattended-upgrades-local
install -d -m 700 /etc/depbrief /etc/server-check /var/lib/server-check /var/backups/depbrief

# The network Caddy shares with whatever it serves. Containers get addresses
# from the top half; the bottom half is for fixed ones, like Caddy's .2.
docker network inspect edge >/dev/null 2>&1 ||
  docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 edge >/dev/null

# Caddy's configuration is a mounted folder, not single files, so a change
# here reaches the running container.
install -d -m 755 /opt/caddy/conf/sites
install -m 644 "$here/caddy/compose.yml" /opt/caddy/compose.yml
install -m 644 "$here/caddy/Caddyfile" /opt/caddy/conf/Caddyfile
install -m 644 "$here"/caddy/sites/*.caddy /opt/caddy/conf/sites/
if docker ps --format '{{.Names}}' | grep -qx caddy; then
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi
