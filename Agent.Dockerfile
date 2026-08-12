# The Browser-Plane agent for this demo (SNI passthrough) -- built from the
# standalone scimbe/ct-agent repo, same shape as bridge/Dockerfile's own
# ctagent-builder stage and CADS-webconference-demo/Agent.Dockerfile.
#
# compose.flappy-demo.yml's flappy-agent service previously built from a
# sibling CADS-Tunnel checkout (context: ${CT_TUNNEL_SRC}, dockerfile:
# docker/Dockerfile, args: CRATE=ct-agent) -- that stopped working once
# ct-agent's source was extracted out of CADS-Tunnel core into its own repo
# (see docker/Dockerfile's own header comment there: "The native ct-agent
# binary itself was extracted to its own repo ... and is NOT built here").
# crates/agent no longer exists in that checkout at all, so the old build
# path silently produced an image with no ct-agent binary in it -- the
# container that had been running for days only worked because its image
# predated the extraction. Switched to this dedicated Dockerfile (same fix
# already applied to bridge/Dockerfile) so a fresh build actually works.

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Bumped 2026-08-12 (live-diagnosed): the previous pin predated ct-agent#15's
# TCP-fallback keepalive/ping-role fix (a parked connection generating no
# real payload traffic got treated as idle and dropped by some firewall/DPI
# gateways -- observed live here as intermittent "attestation failed"/
# stalled-admission/EOF errors on every crew role, not a config bug). Keep in
# sync with bridge/Dockerfile's own CT_AGENT_REF.
ARG CT_AGENT_REF=eb4de4d2427ce51e301c0bf31582cce4bbaa097c
RUN git clone https://github.com/scimbe/ct-agent.git /build && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p ct-agent \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
