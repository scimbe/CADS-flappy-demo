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
# Bumped 2026-08-13 (v0.4.6, live-diagnosed): the previous pin (v0.4.4,
# eb4de4d2) had ct-agent#15's TCP-fallback keepalive fix but was still
# missing two later, more directly relevant fixes found via a live test
# against this exact production edge the same day: v0.4.5 added a
# low-DPI-visibility channel-dial fallback rung (ALPN h2 / SNI
# edge-cdn.invalid, indistinguishable from ordinary HTTPS to
# protocol-fingerprinting DPI/middleboxes), and v0.4.6 fixed
# present_channel_join_via_ladder treating a Refused outcome as "rung
# finished" instead of falling through to try the next rung -- which meant
# v0.4.5's new fallback rung could never actually run in exactly the case
# it exists for. This is very likely the actual fix for the persistent
# "channel join admission exchange stalled (#140)" hot-loop observed on
# every one of this demo's role-serve containers. Keep in sync with
# bridge/Dockerfile's own CT_AGENT_REF.
ARG CT_AGENT_REF=8f59ea1f0dc122b7257146bebe9072218ad79786
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
