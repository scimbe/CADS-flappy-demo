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
# Bumped 2026-08-13 (v0.4.7): v0.4.7's own changelog directly confirms this
# demo's root cause -- "a session admitted over QUIC dies with the next flap
# at the edge's 10s idle timeout (the observed ~14-15s 'healthy then drops,
# even mid-traffic' signature -- an in-flight LLM call sends no QUIC
# packets)" -- exactly the ~14-15s window this repo's role-serve containers
# were live-diagnosed hitting (see CADS-Tunnel#494). v0.4.7 adds
# CT_CHANNEL_FRONT_DOOR_ONLY to pin channel sessions onto the :443 TLS-TCP
# front door instead of flaky QUIC, plus fixes ct-agent#16 (this repo's own
# filed regression: agent registration only fell back to TCP on the FIRST
# dial, so a mid-life UDP flap took the whole demo down for the flap's
# duration). Keep in sync with bridge/Dockerfile's own CT_AGENT_REF.
ARG CT_AGENT_REF=9dcc455c4a050a5e7d24b766a41e0d7e04428086
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
