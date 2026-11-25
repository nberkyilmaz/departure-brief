# The API on the Hetzner server

The API and its database run on a Hetzner CAX11 (ARM64, 2 vCPU, 4 GB, Ubuntu 24.04) at
`5.75.174.24`, always on, behind Caddy at **<https://depbrief-api.nberkyilmaz.com>**. The same
server runs another, unrelated job from cron, outside Docker; everything here is kept away
from it and capped so it can't starve it.

```sh
ssh root@5.75.174.24    
```

## What runs where

| | What | Where |
| --- | --- | --- |
| Caddy | HTTPS for every site on the server, certificates from Let's Encrypt | Docker, `/opt/caddy` |
| API | this repository's `Dockerfile`, built on the server | Docker, `/opt/depbrief/src/deploy/server/compose.yml` |
| Postgres 16 | the API's database, volume `depbrief_pgdata`, no port outside Docker | same compose file |
| `server-check` | every 5 minutes: is it all answering? Pushes to the phone through ntfy | cron, `/etc/cron.d/depbrief` |
| `depbrief-backup` | 03:23 nightly: copy, restore-test, push to a private repository | cron, `/etc/cron.d/depbrief` |

Limits, from `compose.yml`: the API 768 MB and one core, Postgres 512 MB and three quarters of
a core, Caddy 128 MB and half a core, none of them allowed to swap. Their CPU weight is a
quarter of the default, so anything else on the server wins when both want the processor, and
their OOM score is raised so the kernel takes them first if memory ever runs out. There is also
a 2 GB swap file for everything outside Docker.

The containers start with Docker after a restart, by themselves. Only TCP 22, 80 and 443 are
open (ufw). Postgres isn't published at all, and the API only on `127.0.0.1:3000`.

## Secrets

Made on the server, readable by root only, never in git:

- `/etc/depbrief/db.env`: `POSTGRES_PASSWORD` (random, made with `openssl rand`).
- `/etc/depbrief/api.env`: `DATABASE_URL`, with the same password.
- `/etc/server-check/ntfy-topic`: where alerts are pushed. Set it with `server-ntfy-topic`.
- `/root/.ssh/depbrief-backups`: the deploy key that can push to
  `nberkyilmaz/departure-brief-backups`, and nothing else.

The password only matters the first time Postgres starts on an empty volume. Changing it later
means `ALTER ROLE` inside the database as well as both files.

## Everyday

```sh
depbrief-update                       # pull master, rebuild the API, refresh images and these files
cd /opt/depbrief/src/deploy/server
docker compose ps                     # what's running, and healthy
docker compose logs -f --tail 50 api  # the API's log
docker logs --tail 50 caddy           # Caddy's, including certificates
tail /var/log/server-check.log        # what the check has seen and pushed
tail /var/log/depbrief-backup.log     # the nightly copies
```

`depbrief-update` keeps the image it replaces as `depbrief-api:previous`. To go back:

```sh
docker tag depbrief-api:previous depbrief-api:latest
docker compose -f /opt/depbrief/src/deploy/server/compose.yml up -d api
```

Merging to master doesn't deploy the API; `depbrief-update` does. Building takes a minute or
two and most of a core, so run it outside 7 am to 11 pm server time when you can.

## Alerts

`server-check` asks the API on the server, then (from the moment the DNS record points here)
asks Caddy for `https://depbrief-api.nberkyilmaz.com/api/health` with the real certificate. It
also watches the certificate's expiry, the disk, and the age of the last good backup. A problem
has to show twice in a row (ten minutes) before it's pushed. Then there's one push when it starts,
one when it clears, and a reminder every six hours while it lasts.

Pushes go to ntfy.sh as JSON, the same way the server's other job sends its own. Until a topic
is saved they are only written to `/var/log/server-check.log`. To save one (it asks, and doesn't
show what you type), then get a test push:

```sh
server-ntfy-topic
```

The check can't say anything if the whole server is down. The backups repository's daily
workflow covers that from outside: no fresh copy, and GitHub emails you.

The first time the DNS record resolves to this server, the check restarts Caddy once so it asks
for the certificate straight away instead of waiting out its retry back-off, and pushes
"HTTPS is live" when it's done.

## Backups

Every night at 03:23 `depbrief-backup` dumps the database, restores the dump into a scratch
database and counts every table, then pushes the dump and a manifest to the private repository
[`nberkyilmaz/departure-brief-backups`](https://github.com/nberkyilmaz/departure-brief-backups)
as the branch `copy/YYYY-MM-DD`. A workflow there restores the newest copy again every day,
compares the rows with the manifest, deletes copies older than 90 days, and fails, which emails
you, when the newest copy is missing, more than 26 hours old, or wrong. The server keeps the last
seven in `/var/backups/depbrief` too. How to restore is in that repository's README.

## Updates and restarts

Ubuntu's security updates install themselves every day (`unattended-upgrades`). When one needs a
restart, like a new kernel, the server restarts at 04:30, after the backup and outside the other
job's hours (`apt/52unattended-upgrades-local`). The images are refreshed by `depbrief-update`.

## Setting up a new server

On a fresh Ubuntu 24.04, as root:

```sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf && sysctl -p /etc/sysctl.d/90-swappiness.conf
mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
apt-get update && apt-get install -y docker.io docker-compose-v2 docker-buildx jq
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

git clone https://github.com/nberkyilmaz/departure-brief.git /opt/depbrief/src
install -d -m 700 /etc/depbrief
pw=$(openssl rand -hex 24)
(umask 077
 printf 'POSTGRES_PASSWORD=%s\n' "$pw" > /etc/depbrief/db.env
 printf 'DATABASE_URL=postgres://depbrief:%s@db:5432/depbrief\n' "$pw" > /etc/depbrief/api.env)
unset pw

# The backup key: add the .pub as a deploy key with write access to departure-brief-backups.
ssh-keygen -t ed25519 -N '' -C 'departure-brief server backups' -f /root/.ssh/depbrief-backups
printf 'Host github-depbrief-backups\n  HostName github.com\n  User git\n  IdentityFile /root/.ssh/depbrief-backups\n  IdentitiesOnly yes\n' >> /root/.ssh/config
# github.com's host keys, from https://api.github.com/meta, into /root/.ssh/known_hosts.

bash /opt/depbrief/src/deploy/server/install.sh && depbrief-update
server-ntfy-topic
```

The database starts empty and loads the airport snapshot by itself; to bring the old data
across, restore the newest copy as the backups repository's README describes.

Docker publishes ports past ufw, which is why nothing but Caddy publishes one on a public
address. Keep it that way.
