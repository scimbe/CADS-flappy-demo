# syntax=docker/dockerfile:1
# flappy-crew-bridge (Node.js thin bridge — migrated out of CADS-Tunnel core, see #219): the HTTP
# server + wire-format assembly (server.js/server.lib.js) is plain Node with zero dependencies. It
# still needs the `ct-agent` CLI to actually dial role channels.
#
# ct-agent's source was extracted out of CADS-Tunnel core into its own repo (scimbe/ct-agent) --
# building it from a sibling CADS-Tunnel checkout (the old `tunnel-src` additional build context)
# stopped working once that extraction landed (crates/agent no longer exists there at all, so
# `cargo build --bin ct-agent` fails outright). Same fix already applied to the standalone demos'
# own Agent.Dockerfile (e.g. CADS-webconference-demo/Agent.Dockerfile): clone scimbe/ct-agent
# directly at a pinned ref instead.
#
# Two stages: compile just the one binary this service needs, then ship it next to the Node
# server in a lean runtime image. Cached the same way as core's own Dockerfile (BuildKit cache
# mounts for the cargo registry + target/) — needs BuildKit/buildx.
#
# Runtime MUST be glibc, matching the -bookworm builder (same rule as core's own Dockerfile,
# #165): node:*-alpine is musl-based, and a glibc-linked ct-agent silently fails to exec there
# ("not found", not an obvious linker error) — node:*-slim (Debian) keeps both stages on glibc.

FROM rust:1-slim-bookworm AS ctagent-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Which ct-agent commit to build -- bump deliberately, matching CADS-webconference-demo's own
# Agent.Dockerfile pin convention. Bumped 2026-08-13 (v0.4.8): THE actual root cause of
# CADS-Tunnel#494's original admission-stall symptom, pinned by the operator via live edge logs
# -- the edge parks a lone first pairing member for a 30s TTL, but the client's own
# ADMISSION_EXCHANGE_TIMEOUT was only 15s. v0.4.8 raised it to 45s.
#
# Bumped 2026-08-14 to v0.4.12: fixed a second, distinct #494 root cause -- see Agent.Dockerfile's
# own comment for the full packet-capture-proven explanation (a stream shutdown() half-closing the
# whole connection on non-QUIC legs, racing the edge's reap teardown).
#
# Bumped 2026-08-14 to v0.4.15 -- see Agent.Dockerfile's own comment for what v0.4.13-v0.4.15 cover,
# in particular #502's rejected-hostname-bind retry fix.
#
# Bumped 2026-08-14 to v0.4.16 -- THE actual #494 root cause fix (a rendezvous-ack-reader deadlock
# on every fresh :443 pairing). See Agent.Dockerfile's own comment for the full mechanism. This is
# what the flappy-crew-bridge's role dials needed the whole time -- physics/art losing every
# admission race to standby was this exact deadlock. Keep in sync with Agent.Dockerfile's own
# CT_AGENT_REF.
ARG CT_AGENT_REF=738502252eba6763c6d2c6407d06b28d3174d15e
RUN git clone https://github.com/scimbe/ct-agent.git /build && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p ct-agent \
    && cp target/release/ct-agent /build/ct-agent

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ctagent-builder /build/ct-agent /usr/local/bin/ct-agent
WORKDIR /srv
COPY bridge/server.js bridge/server.lib.js ./
EXPOSE 8788
CMD ["node", "server.js"]
