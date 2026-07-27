# syntax=docker/dockerfile:1
# flappy-crew-bridge (Node.js thin bridge — migrated out of CADS-Tunnel core, see #219): the HTTP
# server + wire-format assembly (server.js/server.lib.js) is plain Node with zero dependencies. It
# still needs the `ct-agent` CLI to actually dial role channels — that's a generic core primitive,
# not pipeline-specific, so it's compiled here from a sibling CADS-Tunnel checkout via a named
# additional build context (compose.flappy-demo.yml wires `tunnel-src` to
# ${CT_TUNNEL_SRC:-../CADS-Tunnel}) rather than vendoring/duplicating core source in this repo.
#
# Two stages: compile just the one binary this service needs (not the full ct-testbed image),
# then ship it next to the Node server in a lean runtime image. Cached the same way as core's own
# Dockerfile (BuildKit cache mounts for the cargo registry + target/) — needs BuildKit/buildx.
#
# Runtime MUST be glibc, matching the -bookworm builder (same rule as core's own Dockerfile,
# #165): node:*-alpine is musl-based, and a glibc-linked ct-agent silently fails to exec there
# ("not found", not an obvious linker error) — node:*-slim (Debian) keeps both stages on glibc.

FROM rust:1-slim-bookworm AS ctagent-builder
WORKDIR /build
COPY --from=tunnel-src . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --bin ct-agent \
    && cp target/release/ct-agent /build/ct-agent

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ctagent-builder /build/ct-agent /usr/local/bin/ct-agent
WORKDIR /srv
COPY bridge/server.js bridge/server.lib.js ./
EXPOSE 8788
CMD ["node", "server.js"]
