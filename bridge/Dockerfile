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
# CADS-Tunnel#494, pinned by the operator via live edge logs -- the edge parks a lone first
# pairing member for a 30s TTL, but the client's own ADMISSION_EXCHANGE_TIMEOUT was only 15s, so
# any pairing whose second side took 15-30s to arrive failed deterministically. v0.4.8 raises it
# to 45s. Keep in sync with Agent.Dockerfile's own CT_AGENT_REF.
ARG CT_AGENT_REF=3823343fdc47ea4ed91819cb68bfa8e89399f3f8
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
