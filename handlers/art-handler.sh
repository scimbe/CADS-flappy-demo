#!/usr/bin/env bash
# service/<slug> reference handler for sink's ART role (#171/#173).
#
# Contract: the customer's free-text prompt on STDIN → ONE JSON object on STDOUT:
#   {"theme": "<day|night|sunset|retro|candy>", "birdColor": "#rrggbb",
#    "birdEmoji": "<emoji or empty>", "title": "<short>"}
# These are the field names `ct_common::crew::ArtFragment` parses. birdEmoji may be ANY emoji
# (the studio's bird accepts arbitrary emoji since #169) or "" for the classic tinted bird.
# Isolated, NO tool access — pure generation. Point CT_LLM_CMD at your LLM CLI (default: `claude`).
set -uo pipefail

# #204: extract the JSON object from the LLM output, FLATTENING newlines first (`tr -d '\n'`) so the
# match spans a pretty-printed / ```json-fenced multi-line response. `grep` is line-oriented, so
# without the flatten a multi-line object (the LLM emits one ~1 in 3 calls) matched NOTHING on every
# line and the handler silently fell through to its fallback — the "ask for eggs, get plain pasta" bug.
extract_json_object() { tr -d '\n' | grep -o '{.*}' | head -1; }

# #210: the art LLM sometimes emits a PARTIAL `palette` (e.g. missing `skyBottom`), which fails
# assembly because `Palette` requires all seven keys (an ABSENT palette is fine — it falls back to the
# theme preset). This completes a present-but-incomplete palette in place: each missing key is filled
# from a COHERENT sibling in the same scheme (skyBottom↔skyTop, pipe↔pipeEdge, ground↔groundEdge,
# accent←pipe) so the filled colour matches the LLM's design, falling back to a neutral default only if
# no sibling is present. A complete palette is unchanged; no palette stays absent. Reads stdin, writes
# stdout; non-JSON passes through untouched (so the downstream `"theme"` check still triggers fallback).
complete_palette() {
  python3 -c '
import sys, json
REQ = ["skyTop", "skyBottom", "pipe", "pipeEdge", "ground", "groundEdge", "accent"]
SIB = {"skyBottom": "skyTop", "skyTop": "skyBottom", "pipeEdge": "pipe", "pipe": "pipeEdge",
       "groundEdge": "ground", "ground": "groundEdge", "accent": "pipe"}
DEF = {"skyTop": "#8ec5ff", "skyBottom": "#e0f7ff", "pipe": "#5cbf6a", "pipeEdge": "#2f8f3f",
       "ground": "#caa46a", "groundEdge": "#8a6a3a", "accent": "#ffffff"}
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    sys.stdout.write(raw); sys.exit(0)      # not JSON → pass through; caller falls back
p = d.get("palette") if isinstance(d, dict) else None
if isinstance(p, dict):
    for k in REQ:
        if k not in p:
            sib = SIB.get(k, "")
            p[k] = p[sib] if sib in p else DEF[k]
sys.stdout.write(json.dumps(d))
'
}

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
  # #210: a PARTIAL palette (missing skyBottom) is completed — coherently (skyBottom←skyTop) — and the
  # LLM's provided colours are preserved; an ABSENT palette stays absent (theme preset).
  partial='{"theme":"night","birdColor":"#00ff41","title":"X","palette":{"skyTop":"#001133","pipe":"#0f0","pipeEdge":"#080","ground":"#111","groundEdge":"#222","accent":"#fff"}}'
  printf '%s' "$partial" | complete_palette | python3 -c '
import sys, json
p = json.load(sys.stdin)["palette"]
req = ["skyTop","skyBottom","pipe","pipeEdge","ground","groundEdge","accent"]
assert all(k in p for k in req), ("palette not completed", p)
assert p["skyBottom"] == "#001133", ("skyBottom should fill from its sibling skyTop", p)
assert p["pipe"] == "#0f0", ("provided colours must be preserved", p)
' || { echo "SELFTEST FAIL (#210): partial palette not coherently completed" >&2; exit 1; }
  printf '%s' '{"theme":"day","birdColor":"#fff","title":"Y"}' | complete_palette | python3 -c 'import sys,json; assert "palette" not in json.load(sys.stdin)' \
    || { echo "SELFTEST FAIL (#210): an absent palette must stay absent" >&2; exit 1; }
  echo "SELFTEST OK (#204 extraction + #210 palette completion)"
  exit 0
fi
REQ_ID="$$-$(date -u +%s)-$RANDOM"
# Same fix as safety-check-handler.sh (2026-08-25): the tee target's default is a HOST path
# that doesn't exist inside the actual deployed container, so it silently swallowed every log
# line unless the file write and the stderr write both went through together -- stderr is now
# unconditional, the file tee is best-effort only when its directory actually exists.
LOG_DIR="${CT_HANDLER_LOG_DIR:-/home/becke/workflow-pipelines/.demo-checkouts/handler-logs}"
log() {
  local line
  line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] handler=art req=${REQ_ID} $*"
  printf '%s\n' "$line" >&2
  [ -d "$LOG_DIR" ] && printf '%s\n' "$line" >>"$LOG_DIR/art.log" 2>/dev/null
}

LLM_TIMEOUT="${CT_HANDLER_TIMEOUT:-45}"
LLM="${CT_LLM_CMD:-claude}"
INPUT="$(cat)"
log "start input_len=${#INPUT}"
T0=$(date +%s)

# #230: small local models (litellm/Ollama-backed) reliably miss specific brand/mascot/
# franchise identities that a broad-training model gets right without help (e.g. "freebsd
# theme" -> a local model picked generic blue with no bird emoji at all, missing the
# FreeBSD "Beastie" red-devil association). Case-insensitive substring-match the prompt
# against handlers/art-reference-hints.txt and hand any matched facts to the model
# directly -- turns "does the model already know this" into "can it use a fact it's
# given", which closes most of the gap regardless of which backend CT_LLM_CMD points at.
HINTS_FILE="$(dirname "$0")/art-reference-hints.txt"
REFERENCE_HINTS=""
if [ -f "$HINTS_FILE" ]; then
  LOWER_INPUT="$(printf '%s' "$INPUT" | tr '[:upper:]' '[:lower:]')"
  while IFS=: read -r hint_key hint_text; do
    case "$hint_key" in ""|"#"*) continue ;; esac
    case "$LOWER_INPUT" in
      *"$hint_key"*) REFERENCE_HINTS="$REFERENCE_HINTS
- $hint_text" ;;
    esac
  done < "$HINTS_FILE"
fi
[ -n "$REFERENCE_HINTS" ] && log "reference hints matched: $(printf '%s' "$REFERENCE_HINTS" | tr '\n' ' ')"

SYS="You art-direct a Flappy Bird clone from a free-text prompt. Output ONLY a compact JSON object, no prose, with these keys: theme (one of: day, night, sunset, retro, candy — the closest mood, a fallback), birdColor (a #rrggbb hex), birdEmoji (a single emoji that fits the prompt, or an empty string for a plain tinted bird), title (a short on-topic game title, <= 28 chars), and — IMPORTANT (#176) — a 'palette' object so you can invent a FULL custom colour scheme instead of only picking a preset: palette has exactly skyTop, skyBottom, pipe, pipeEdge, ground, groundEdge, accent, each a #rrggbb hex — ALL SEVEN are REQUIRED, include every one (a missing key breaks the game). Design the palette to match the prompt (e.g. 'cozy autumn forest at dusk' -> warm dusk sky gradient, amber pipes, dark-earth ground). Always include palette. Optionally (#177) also include 'pipeEmoji': a SINGLE emoji used as the obstacle shape when it fits the theme (🌲 forest, 🌵 desert, 🧊 ice, 🏭 industrial), or omit it for classic pipes. Optionally (#178) also include 'bgEffect': an animated background named 'matrix-rain' (falling green glyphs), 'snow', or 'stars' when it fits the prompt (e.g. 'matrix' -> matrix-rain), or omit it for a static sky. Match the prompt's vibe (e.g. 'matrix' -> green #00ff41 bird, 🕶️, dark palette, matrix-rain background, a Matrix-y title). Respond with the JSON object and nothing else."
if [ -n "$REFERENCE_HINTS" ]; then
  SYS="$SYS

Known facts relevant to this prompt (use them if they fit; stay creative for anything else):$REFERENCE_HINTS"
fi

# #231: capture+log stderr instead of discarding it, so an infrastructure failure
# (backend unreachable/rate-limited/malformed) is distinguishable after the fact from the
# model simply misbehaving -- stdout stays strict JSON either way.
LLM_STDERR="$(mktemp)"
OUT="$(timeout "$LLM_TIMEOUT" "$LLM" -p "$INPUT" --output-format text \
  --disallowedTools "Edit,Write,Bash,WebFetch,WebSearch,Agent" \
  --append-system-prompt "$SYS" 2>"$LLM_STDERR")"
LLM_STATUS=$?
[ $LLM_STATUS -eq 124 ] && log "warn llm_timeout after=${LLM_TIMEOUT}s"
[ -s "$LLM_STDERR" ] && log "warn llm_stderr: $(tr '\n' ' ' < "$LLM_STDERR")"
rm -f "$LLM_STDERR"

JSON="$(printf '%s' "$OUT" | extract_json_object | complete_palette)"
DUR=$(( $(date +%s) - T0 ))
if printf '%s' "$JSON" | grep -q '"theme"'; then
  log "done outcome=ok duration=${DUR}s"
  printf '%s\n' "$JSON"
else
  log "done outcome=fallback duration=${DUR}s llm_status=${LLM_STATUS}"
  printf '{"theme":"day","birdColor":"#f7d51d","birdEmoji":"","title":"My Flappy Bird"}\n'
fi
