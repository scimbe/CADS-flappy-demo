#!/usr/bin/env bash
# start-crew-on-boot.sh — bring the flappy-demo crew (bridge + physics/art/safety
# serve roles) back up after a host reboot. Nothing in this stack had a restart
# policy or boot hook before this (confirmed 2026-08-12: a 2026-08-10 reboot left
# the three role-serve containers gone entirely, with the bridge itself only
# surviving because its own `restart: unless-stopped` policy covers the container
# but not its dependency-on-a-network-that-existed-at-boot). Installed via
# start-crew-on-boot.service (systemd, After=docker.service).
#
# Idempotent: safe to re-run manually too (e.g. after editing .env/.env.crew-serve) --
# --force-recreate on the bridge and start-crew-serve.sh's own docker run (which
# already fails loudly on a name collision, not silently) mean this never leaves
# two overlapping instances of anything running.
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '[%s] start-crew-on-boot: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Docker itself may still be starting up right after boot -- wait for it rather
# than failing once and never being retried (this script only runs once at boot).
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  log "waiting for docker (attempt $i/30)..."
  sleep 2
done
docker info >/dev/null 2>&1 || { log "docker never became ready -- giving up"; exit 1; }

log "recreating flappy-crew-bridge (uses .env, --no-deps so flappy-origin/-agent are never touched)"
docker compose --profile crew -f compose.flappy-demo.yml up -d --no-deps --force-recreate flappy-crew-bridge

log "removing any existing role-serve containers first (start-crew-serve.sh's own docker run fails on a name collision, not silently -- this is what actually makes re-running this script safe)"
docker rm -f flappy-physics-serve flappy-art-serve flappy-safety-serve >/dev/null 2>&1 || true

log "starting the 3 role-serve containers via start-crew-serve.sh"
ENV_FILE="$(pwd)/.env.crew-serve" \
CT_TUNNEL_SRC=/home/becke/workflow-pipelines/.demo-checkouts/CADS-Tunnel \
CT_AGENT_EDGE_BROKER=57.131.133.91:4435 \
CT_AGENT_EDGE_RELAY=57.131.133.91:4436 \
DOCKER_NETWORK=flappy-demo_default \
  ./start-crew-serve.sh || log "start-crew-serve.sh failed -- role-serve containers may already exist from a prior run; check 'docker ps | grep flappy-.*-serve'"

log "done"
