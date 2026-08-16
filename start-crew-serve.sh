#!/usr/bin/env bash
# start-crew-serve.sh — bring up containerized serve processes for all of flappy-demo's
# crew roles (physics, art, safety_check), each wired to its real handlers/*.sh via
# CADS-Tunnel's scripts/channel-ops/serve-role-container.sh (#219, #117).
#
# Per-role keys/grants come from ENV_FILE (SERVE_FLAPPY_<ROLE>_HOLDER_KEY/_NOISE_KEY/_GRANT),
# NOT committed here — this repo only holds the generic wiring, not secrets.
#
# POSIX/portable: no GNU-only flags, works under bash on Linux or macOS.
#
# Usage:
#   ENV_FILE=/path/to/shared.env CT_TUNNEL_SRC=../CADS-Tunnel \
#   CT_AGENT_EDGE_BROKER=1.2.3.4:4433 CT_AGENT_EDGE_RELAY=1.2.3.4:4433 \
#     ./start-crew-serve.sh
#
#   ./start-crew-serve.sh --selftest   # verify the core script + handlers resolve, no network
#
# Optional: LLM_SHIM_HOST=/abs/path/to/litellm-shim.sh LLM_ENV_FILE=/abs/path/to/litellm.env
# switches ALL THREE roles from the bind-mounted claude CLI to that shim (passed straight
# through to serve-role-container.sh, see its own header for the exact opt-in contract).
# Leave both unset for byte-identical old behavior (claude CLI, as before this existed).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'start-crew-serve: %s\n' "$*" >&2; exit 1; }

CT_TUNNEL_SRC="${CT_TUNNEL_SRC:-$SCRIPT_DIR/../CADS-Tunnel}"
CORE_SCRIPT="$CT_TUNNEL_SRC/scripts/channel-ops/serve-role-container.sh"
[ -x "$CORE_SCRIPT" ] || die "serve-role-container.sh not found/executable at $CORE_SCRIPT — set CT_TUNNEL_SRC to a CADS-Tunnel checkout with scripts/channel-ops/"

IMAGE="${IMAGE:-cads-flappy-demo-flappy-agent:latest}"
DOCKER_NETWORK="${DOCKER_NETWORK:-flappy-demo_default}"
LLM_SHIM_HOST="${LLM_SHIM_HOST:-}"
LLM_ENV_FILE="${LLM_ENV_FILE:-}"

ROLES="physics:text_generation:physics-handler.sh art:text_generation:art-handler.sh safety:safety_check:safety-check-handler.sh"

if [ "${1:-}" = "--selftest" ]; then
  ok=1
  for entry in $ROLES; do
    role="${entry%%:*}"; rest="${entry#*:}"; service="${rest%%:*}"; handler="${rest#*:}"
    IMAGE="$IMAGE" \
    LLM_SHIM_HOST="$LLM_SHIM_HOST" \
    LLM_ENV_FILE="$LLM_ENV_FILE" \
    HANDLER_CMD_HOST="$SCRIPT_DIR/handlers/$handler" \
    CONTAINER_NAME="flappy-${role}-serve" \
      "$CORE_SCRIPT" --selftest || ok=0
  done
  [ "$ok" = "1" ] || die "one or more roles failed selftest"
  echo "start-crew-serve: all flappy-demo crew roles passed selftest"
  exit 0
fi

: "${ENV_FILE:?set ENV_FILE (path to an env file with SERVE_FLAPPY_<ROLE>_HOLDER_KEY/_NOISE_KEY/_GRANT per role)}"
[ -f "$ENV_FILE" ] || die "ENV_FILE=$ENV_FILE not found"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${CT_AGENT_EDGE_BROKER:?set CT_AGENT_EDGE_BROKER (edge rendezvous host:port — must be an IP, see #214)}"
: "${CT_AGENT_EDGE_RELAY:?set CT_AGENT_EDGE_RELAY}"

for entry in $ROLES; do
  role="${entry%%:*}"; rest="${entry#*:}"; service="${rest%%:*}"; handler="${rest#*:}"
  role_upper="$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')"
  holder_var="SERVE_FLAPPY_${role_upper}_HOLDER_KEY"
  noise_var="SERVE_FLAPPY_${role_upper}_NOISE_KEY"
  grant_var="SERVE_FLAPPY_${role_upper}_GRANT"
  holder="$(eval "printf '%s' \"\${$holder_var:-}\"")"
  noise="$(eval "printf '%s' \"\${$noise_var:-}\"")"
  grant="$(eval "printf '%s' \"\${$grant_var:-}\"")"
  [ -n "$holder" ] && [ -n "$noise" ] && [ -n "$grant" ] \
    || die "missing $holder_var/$noise_var/$grant_var in $ENV_FILE for role=$role"

  IMAGE="$IMAGE" \
  DOCKER_NETWORK="$DOCKER_NETWORK" \
  CT_AGENT_EDGE_BROKER="$CT_AGENT_EDGE_BROKER" \
  CT_AGENT_EDGE_RELAY="$CT_AGENT_EDGE_RELAY" \
  HOLDER_KEY="$holder" NOISE_KEY="$noise" GRANT="$grant" \
  SERVICE="$service" \
  LLM_SHIM_HOST="$LLM_SHIM_HOST" \
  LLM_ENV_FILE="$LLM_ENV_FILE" \
  HANDLER_CMD_HOST="$SCRIPT_DIR/handlers/$handler" \
  CONTAINER_NAME="flappy-${role}-serve" \
    "$CORE_SCRIPT"
done

echo "start-crew-serve: all flappy-demo crew roles started (docker ps | grep flappy- to check status)"
