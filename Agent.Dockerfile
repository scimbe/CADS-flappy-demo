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
# Bumped 2026-08-13 (v0.4.8): THE actual root cause of this demo's original
# admission-stall (CADS-Tunnel#494), pinned by the operator via live edge
# logs -- the edge parks a lone first pairing member for a 30s TTL waiting
# for its partner, but the CLIENT's own ADMISSION_EXCHANGE_TIMEOUT was only
# 15s. v0.4.8 raised it to 45s. Superseded the v0.4.7 CT_CHANNEL_FRONT_DOOR_ONLY
# workaround entirely.
#
# Bumped 2026-08-14 to v0.4.12: fixes a SECOND, distinct root cause found via
# packet capture after v0.4.8 alone didn't fully resolve #494 -- the
# post-signature stream shutdown() was a close_notify + TCP FIN half-closing
# the WHOLE connection (not just the QUIC stream) on the :443 TCP front-door
# leg. A parked member then waited out its park as a dying connection to
# every stateful middlebox; at real-world RTT the edge's own FIN-then-RST
# reap-teardown raced the in-flight admission record and discarded it,
# producing the exact "edge broker refused the channel join" / near-miss
# admission-timing symptom this session diagnosed live (successful admissions
# on both sides landing tens to hundreds of ms apart, never overlapping).
# Needed the matching edge-side fix (CADS-Tunnel 36a1547) to fully resolve --
# client alone keeps the connection open on non-QUIC legs but can't fix a
# stale edge.
#
# Bumped 2026-08-14 to v0.4.15: covers v0.4.13 (KA-ALPN park-keepalive work,
# #500), v0.4.14 (phase-marked :443 joins, #495 slice 2a), and v0.4.15 (fix
# #502: retry a rejected hostname bind instead of one-shot) -- #502 is the
# exact "agent logs registered, edge TLS handshake still fails" symptom this
# session live-diagnosed on 4/5 demo tunnels post-reboot; landed and closed
# 2026-08-14T10:28 UTC, right as the full-platform outage this session
# reported cleared.
#
# Bumped 2026-08-14 to v0.4.16: THE actual #494 root cause -- channel.rs:203's
# rendezvous-ack reader (`recv.take(512).read_to_end`) only completes on EOF,
# which QUIC gives (stream finish()) but the :443 relay-pair completer never
# does (it acks then splices the same stream onward) -- both sides of a fresh
# :443 pairing deadlocked waiting for an EOF only the other side's death could
# produce, explaining every #140/"edge broker refused"/standby-fallback
# symptom this session hit. v0.4.16 reads to newline-or-EOF instead. Verified
# by core: fresh :443 contact 45-100s -> sub-second (536ms lab, 124-823ms
# field, 8/8 no bimodal distribution) with zero admission-refusal symptoms.
# This is the fix that should finally make flappy-demo's physics/art roles
# stop losing every admission race to the central (standby) fallback. Keep in
# sync with bridge/Dockerfile's own CT_AGENT_REF.
#
# Bumped again 2026-09-02 to v0.7.22 (operator directive: comprehensive
# host-wide ct-agent update, overriding the earlier 2026-08-24 deliberate
# deferral of this specific pin -- flappy-demo has no bump-ct-agent.yml CI
# safety net, so this needs extra manual admission-behavior verification
# post-deploy, not just "container is up").
ARG CT_AGENT_REF=c27e9aee8465c6605df98bd7268cc419e3c484a1
# Optional gh-token secret (--secret id=gh_token,src=<file>): GitHub's anonymous
# git-clone rate limit for this host's IP was hit 2026-09-02 (same fix already
# applied to CADS-cookbook-demo/CADS-DEMO-deutschlandatlas-callcenter/
# CADS-webconference-demo/CADS-a2a-demo/CADS-auction-demo). Falls back to a
# plain anonymous clone when no secret is passed, so this is a no-op for
# anyone building without a token.
RUN --mount=type=secret,id=gh_token \
    if [ -s /run/secrets/gh_token ]; then \
      git -c http.https://github.com/.extraheader="AUTHORIZATION: basic $(printf 'x:%s' "$(cat /run/secrets/gh_token)" | base64 -w0)" clone https://github.com/scimbe/ct-agent.git /build; \
    else \
      git clone https://github.com/scimbe/ct-agent.git /build; \
    fi \
    && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p ct-agent \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
# python3: this image doubles as the role-serve runtime (serve-role-container.sh runs
# handlers/*.sh in it via CT_AGENT_SERVICE_HANDLER_CMD) -- art-handler.sh's complete_palette()
# needs it for JSON post-processing. Missing it doesn't fail loudly: the LLM call itself
# succeeds (llm_status=0), but the python3 pipeline stage silently drops out, the "theme"
# grep check fails on the corrupted output, and the handler falls back to its hardcoded
# defaults ({"theme":"day",...}) -- exactly the "physics/art always return the same default
# config, never the real prompted theme" symptom this session spent hours chasing as a
# channel-pairing bug (CADS-Tunnel#494) before finding this separate, local cause once
# pairing itself was fixed.
# curl+jq: needed by litellm-shim.sh (CADS-Tunnel#528-follow, opt-in CT_LLM_CMD backend) when
# a role is switched from the bind-mounted claude CLI to the litellm HTTP shim -- unused
# otherwise, small enough to keep in the base image rather than a second variant.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 curl jq \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
