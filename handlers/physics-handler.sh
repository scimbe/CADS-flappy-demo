#!/usr/bin/env bash
# service/<slug> reference handler for source-2's PHYSICS role (#171/#173).
#
# Contract: the customer's free-text prompt on STDIN → ONE JSON object on STDOUT:
#   {"gravity": <int>, "flapPower": <int>, "pipeGap": <int>, "pipeSpeed": <int>}
# These are the field names `ct_common::crew::PhysicsFragment` parses (the bridge maps
# flapPower→jump, pipeGap→gap, pipeSpeed→speed). Isolated, NO tool access — pure generation.
# Point CT_LLM_CMD at your non-interactive LLM CLI (default: `claude`).
set -uo pipefail

# #204: extract the JSON object from the LLM output, FLATTENING newlines first (`tr -d '\n'`) so the
# match spans a pretty-printed / ```json-fenced multi-line response. `grep` is line-oriented, so
# without the flatten a multi-line object (the LLM emits one ~1 in 3 calls) matched NOTHING on every
# line and the handler silently fell through to its fallback — the "ask for eggs, get plain pasta" bug.
extract_json_object() { tr -d '\n' | grep -o '{[^}]*}' | head -1; }

if [ "${1:-}" = "--selftest" ]; then
  sample='```json
{
  "k": ["eggs", "spinach"],
  "n": 2
}
```'
  got="$(printf '%s' "$sample" | extract_json_object)"
  [ -n "$got" ] || { echo "SELFTEST FAIL (#204): multi-line/fenced JSON yielded an EMPTY match" >&2; exit 1; }
  printf '%s' "$got" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>/dev/null \
    || { echo "SELFTEST FAIL (#204): extracted text is not valid JSON" >&2; exit 1; }
  echo "SELFTEST OK (#204): multi-line/fenced JSON extraction recovers a valid object"
  exit 0
fi
# Structured, professional logging to stderr (never stdout — that's the JSON contract).
# Never logs prompt content or any credential/key material, only shape + timing + outcome,
# so this is safe to leave on in production and useful for on-call debugging.
REQ_ID="$$-$(date -u +%s)-$RANDOM"
log() { printf "[%s] handler=physics req=%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REQ_ID" "$*" | tee -a "${CT_HANDLER_LOG_DIR:-/home/becke/workflow-pipelines/.demo-checkouts/handler-logs}/physics.log" >&2; }

# A hung `claude -p` call (network blip, rate limit, etc.) would otherwise block this serve
# slot FOREVER — ct-agent's --serve pool is finite (8 concurrent sessions), so a handful of
# silent hangs over a long-running process's lifetime exhausts the pool and every future call
# stalls, indistinguishable from a dead agent. A hard timeout guarantees the slot is always
# freed, with the same balanced-defaults fallback already used for a malformed response.
LLM_TIMEOUT="${CT_HANDLER_TIMEOUT:-45}"
LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"
log "start input_len=${#INPUT}"
T0=$(date +%s)

SYS="You tune the PHYSICS of a Flappy Bird clone from a free-text prompt. Output ONLY a compact JSON object, no prose, with exactly these integer keys and ranges: gravity (900-2600), flapPower (280-620), pipeGap (90-200), pipeSpeed (90-260). Read the prompt's difficulty intent: 'hard/insane' -> higher gravity+speed and tighter (smaller) pipeGap; 'easy/chill' -> the reverse; 'fast/slow' adjust pipeSpeed. If the prompt implies nothing about difficulty, return balanced defaults (gravity 1800, flapPower 430, pipeGap 140, pipeSpeed 130). Respond with the JSON object and nothing else."

OUT="$(timeout "$LLM_TIMEOUT" "$LLM" -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>/dev/null)"
LLM_STATUS=$?
[ $LLM_STATUS -eq 124 ] && log "warn llm_timeout after=${LLM_TIMEOUT}s"

# Extract the first {...} block; fall back to balanced defaults if the LLM misbehaves (the
# bridge fails closed on a malformed fragment, but a sane default keeps the demo resilient).
JSON="$(printf '%s' "$OUT" | extract_json_object)"
DUR=$(( $(date +%s) - T0 ))
if printf '%s' "$JSON" | grep -q '"gravity"'; then
  log "done outcome=ok duration=${DUR}s"
  printf '%s\n' "$JSON"
else
  log "done outcome=fallback duration=${DUR}s llm_status=${LLM_STATUS}"
  printf '{"gravity":1800,"flapPower":430,"pipeGap":140,"pipeSpeed":130}\n'
fi
