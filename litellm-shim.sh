#!/usr/bin/env bash
# litellm-shim.sh — drop-in CT_LLM_CMD replacement for this repo's handlers/*.sh.
#
# The handlers invoke: "$LLM" -p "$INPUT" --output-format text \
#   --disallowedTools "..." --append-system-prompt "$SYS"
# and read the reply on stdout as plain text. This shim implements exactly that argument
# shape but talks to a litellm proxy's OpenAI-compatible /v1/chat/completions instead of
# shelling out to the claude CLI. --disallowedTools is accepted and ignored (the shim has
# no tool access to restrict — it's a single blocking HTTP call). --output-format is
# accepted and ignored (always plain text, matching --output-format text's own shape).
#
# Wired in via CADS-Tunnel's serve-role-container.sh LLM_SHIM_HOST/LLM_ENV_FILE opt-in
# (see that script's header) — leaving both unset there keeps every role on the claude CLI,
# byte-identical to before this file existed.
#
# Required env: LITELLM_BASE_URL, LITELLM_API_KEY, LITELLM_MODEL.
# Optional env: LITELLM_TIMEOUT (seconds, default 40 — keep below the handler's own
# CT_HANDLER_TIMEOUT so a slow upstream produces this script's own diagnostic on stderr
# instead of a bare SIGTERM from the handler's outer `timeout`).
set -uo pipefail

PROMPT=""
SYSTEM=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) PROMPT="${2:-}"; shift 2 ;;
    --append-system-prompt) SYSTEM="${2:-}"; shift 2 ;;
    --output-format) shift 2 ;;
    --disallowedTools) shift 2 ;;
    *) shift ;;
  esac
done

: "${LITELLM_BASE_URL:?set LITELLM_BASE_URL (e.g. https://llm-34a13a96.bunsenbrenner.org)}"
: "${LITELLM_API_KEY:?set LITELLM_API_KEY}"
: "${LITELLM_MODEL:?set LITELLM_MODEL (e.g. local-mistral-small)}"

BODY="$(jq -n --arg sys "$SYSTEM" --arg user "$PROMPT" --arg model "$LITELLM_MODEL" \
  '{model: $model, messages: [{role:"system", content:$sys}, {role:"user", content:$user}], temperature: 0.3}')"

RESP="$(curl -sS --max-time "${LITELLM_TIMEOUT:-40}" -w $'\n%{http_code}' \
  "$LITELLM_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY")"
CURL_STATUS=$?

HTTP_CODE="$(printf '%s' "$RESP" | tail -1)"
BODY_RESP="$(printf '%s' "$RESP" | sed '$d')"

if [ $CURL_STATUS -ne 0 ] || [ "$HTTP_CODE" != "200" ]; then
  printf 'litellm-shim: request failed (curl_status=%s http=%s) body=%s\n' \
    "$CURL_STATUS" "$HTTP_CODE" "$BODY_RESP" >&2
  exit 1
fi

CONTENT="$(printf '%s' "$BODY_RESP" | jq -r '.choices[0].message.content // empty')"
if [ -z "$CONTENT" ]; then
  printf 'litellm-shim: empty/unparseable content in response: %s\n' "$BODY_RESP" >&2
  exit 1
fi
printf '%s\n' "$CONTENT"
