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

# #207-follow-up: CREW_ART_STANDBY_GRANT/CREW_PHYSICS_STANDBY_GRANT were once silently
# duplicated from their own primary CREW_*_GRANT (a copy-paste provisioning mistake, not
# a real distinct channel) -- the standby candidate then dialed the SAME channel as
# primary instead of a genuine fallback, defeating #207's whole failover design without
# any visible error (both candidates "succeeded", just at the same peer). Caught live
# 2026-08-13 by re-deriving and comparing every *_GRANT/*_STANDBY_GRANT pair below;
# fixed by re-provisioning genuinely distinct channels. This check makes that mistake
# loud and immediate on every boot/restart instead of silently shipping again.
log "verifying no CREW_*_GRANT duplicates its own CREW_*_STANDBY_GRANT (#207 follow-up)"
DUP_FOUND=0
for primary_var in $(grep -oE '^CREW_[A-Z]+_GRANT=' .env | sed 's/=$//'); do
  role="${primary_var#CREW_}"; role="${role%_GRANT}"
  standby_var="CREW_${role}_STANDBY_GRANT"
  primary_val="$(grep "^${primary_var}=" .env | cut -d= -f2-)"
  standby_val="$(grep "^${standby_var}=" .env | cut -d= -f2-)"
  if [ -n "$standby_val" ] && [ "$primary_val" = "$standby_val" ]; then
    log "FATAL: ${primary_var} and ${standby_var} are IDENTICAL -- the standby candidate is not a distinct channel, #207 failover is silently broken for this role"
    DUP_FOUND=1
  fi
done
[ "$DUP_FOUND" -eq 0 ] || { log "aborting -- fix .env before bringing the crew up (re-provision the affected STANDBY_GRANT via provision-link-channel.sh)"; exit 1; }

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
