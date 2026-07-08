# Deploying a Thaddeus server

`thaddeus serve` is the untrusted HTTP remote: it holds no keys, verifies what
it ingests, and serves ciphertext. It is a **stateful, long-running process**
that keeps its durable state (the `FileBackend` and a host identity) on a
**persistent volume** — so deploy it as a container with a mounted volume, not
as a serverless function.

> **Pre-alpha.** Single-node (one writer per repo). Horizontal scale and a
> host-agnostic object-storage backend are on the roadmap (see the end).

## What it needs

- A **container** running the compiled `thaddeus` binary (the
  [Dockerfile](../Dockerfile)).
- A **persistent volume** mounted at `/data` — the substrate and the host key.
- One **HTTP port** (the platform terminates TLS at its edge; the server speaks
  plain HTTP internally).

### Configuration (environment)

| Variable              | Default       | Meaning                                           |
| --------------------- | ------------- | ------------------------------------------------- |
| `PORT`                | `4000`        | listen port (Railway/Fly set this for you)        |
| `THADDEUS_DATA`       | `/data`       | durable data dir (the volume)                     |
| `THADDEUS_HOME`       | `/data/.home` | where the persistent host identity lives          |
| `THADDEUS_HOST`       | —             | set to `1` to run an **attesting** instance (P07) |
| `THADDEUS_MIN_MERGES` | —             | gate a land on N attested merges per op author    |

The entrypoint mints the host identity once (idempotent) on the volume, so
attestations stay stable across restarts.

## Run it locally

```sh
docker build -t thaddeus .
docker run --rm -p 4000:4000 -v thaddeus_data:/data thaddeus
curl http://localhost:4000/repos      # {"repos":[]}
```

## Railway

1. New project → **Deploy from GitHub repo** (Railway auto-detects the
   Dockerfile).
2. Add a **Volume** mounted at `/data`.
3. Railway injects `PORT` and provisions HTTPS automatically. Optionally set
   `THADDEUS_HOST=1`.
4. Deploy. Your server is at `https://<service>.up.railway.app`.

## Fly.io

The repo ships a [`fly.toml`](../fly.toml) with everything wired: the `/data`
volume, TLS, a health check, and port **8080** — Fly's proxy default. The server
reads `$PORT`, so it binds 8080 on Fly (it defaults to 4000 only for a local
`docker run`). Edit `app` to a unique name and pick a region, then:

```sh
fly launch --copy-config --no-deploy          # create the app, keep this fly.toml
fly volumes create thaddeus_data --size 3 --region fra
fly deploy
```

Fly builds the Dockerfile, mounts the volume at `/data`, and terminates TLS
(`force_https`).

> **Keep `PORT` and `internal_port` equal.** fly-proxy routes to
> `internal_port`; the server listens on `$PORT`. This file sets both to 8080,
> which is Fly's default — so its CLI and web/GitHub Launch flows won't drift
> them apart. If a deploy ever ends in `timeout trying to get your app` (with
> _"not listening on the expected address"_), the two have diverged: set them to
> the same value and re-run `fly deploy` (the built image is reused, so it's a
> config-only change).

## A plain VPS (e.g. Oracle Cloud always-free, a KVM)

Run the container and put a TLS-terminating reverse proxy in front:

```sh
docker run -d --name thaddeus --restart unless-stopped \
  -p 127.0.0.1:4000:4000 -v /srv/thaddeus:/data thaddeus
```

Then, with [Caddy](https://caddyserver.com) (automatic HTTPS):

```
# /etc/caddy/Caddyfile
thaddeus.example.com {
  reverse_proxy 127.0.0.1:4000
}
```

## Point a client at it

```sh
thaddeus create https://your-host acme/web
thaddeus clone  https://your-host acme/web
```

## Backups

Everything is under `/data`. Snapshot the volume (Fly `fly volumes snapshots`,
Railway volume backups, or `tar`/`rsync` on a VPS). Content is content-addressed
and write-once, so incremental backups are cheap.

## Roadmap

- **Object-storage backend (portability + scale).** An S3-compatible `Backend`
  (deferred) moves state off the local disk into object storage — the _same_
  container then runs against **AWS S3**, **Cloudflare R2**, or self-hosted
  **MinIO**, making a host switch a config change and enabling multiple server
  replicas.
- **Replay-nonce hardening.** The signed-request check currently allows a ±5-min
  window (`packages/server/src/sign.ts`); a server-side nonce cache closes the
  replay window for a public deployment.
