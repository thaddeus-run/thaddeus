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
# proto manages the pinned bun/node/moon toolchain from .prototools.
RUN curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --yes
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
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
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
