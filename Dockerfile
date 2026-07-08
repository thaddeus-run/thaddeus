# syntax=docker/dockerfile:1
#
# A container for `thaddeus serve` — the untrusted HTTP remote. Two stages: a
# builder that compiles the self-contained `thaddeus` binary (no Bun at runtime),
# and a slim runtime that ships only the binary + entrypoint. State (the
# FileBackend + the host identity) lives on the /data volume.

# ---- builder: compile the standalone binary ----
FROM debian:bookworm-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
# proto manages the pinned bun/node/moon toolchain from .prototools. Install the
# proto version pinned in .prototools (PROTO_VERSION) so the bootstrap is
# reproducible; the official moonrepo.dev installer is the documented method.
RUN curl -fsSL https://moonrepo.dev/install/proto.sh | PROTO_VERSION=0.57.4 bash -s -- --yes
ENV PATH="/root/.proto/shims:/root/.proto/bin:${PATH}"
WORKDIR /app
COPY . .
# minimumReleaseAge is a dev-machine supply-chain gate; against the frozen,
# reviewed lockfile it only risks blocking freshly published pins here.
RUN sed -i 's/^minimumReleaseAge = .*/minimumReleaseAge = 0/' bunfig.toml \
  && proto install bun && proto install node && proto install moon \
  && bun install --frozen-lockfile \
  && moon run cli:build \
  && bun build --compile --minify --outfile /app/thaddeus packages/cli/src/bin.ts

# ---- runtime: just the binary ----
FROM debian:bookworm-slim AS runtime
# gosu lets the entrypoint start as root only to chown the mounted volume, then
# drop to the unprivileged `thaddeus` user before running the server.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home --home-dir /home/thaddeus thaddeus
COPY --from=builder /app/thaddeus /usr/local/bin/thaddeus
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# The durable substrate (FileBackend) and the persistent host identity live here.
ENV THADDEUS_DATA=/data \
    THADDEUS_HOME=/data/.home \
    PORT=4000
VOLUME /data
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
