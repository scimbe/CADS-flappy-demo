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
# Agent.Dockerfile pin convention. Bumped 2026-08-12 (live-diagnosed): the previous pin
# (86ab198f) predated ct-agent#15's TCP-fallback keepalive/ping-role fix (a parked connection
# generating no real payload traffic got treated as idle and dropped by some firewall/DPI
# gateways -- observed live here as intermittent "attestation failed"/stalled-admission/EOF
# errors on every crew role, not a config bug). This ref also needs the operator-side edge's own
# half of the same fix (CADS-Tunnel commit ff415a8) to actually take effect -- that's the remote
# bunsenbrenner.org edge infrastructure this demo tunnels through, not anything built or deployed
# from this repo.
ARG CT_AGENT_REF=eb4de4d2427ce51e301c0bf31582cce4bbaa097c
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
