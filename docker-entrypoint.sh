#!/bin/sh
# Start `thaddeus serve`, configured from the environment, over the /data volume.
#
#   PORT                 listen port (default 4000; platforms like Railway set this)
#   THADDEUS_DATA        durable data dir (default /data)
#   THADDEUS_HOME        home for the persistent host identity (default /data/.home)
#   THADDEUS_HOST=1      run as an ATTESTING instance (co-signs reputation)
#   THADDEUS_MIN_MERGES  gate land on N attested merges per op author
set -eu

DATA="${THADDEUS_DATA:-/data}"
PORT="${PORT:-4000}"
export HOME="${THADDEUS_HOME:-$DATA/.home}"
mkdir -p "$HOME" "$DATA"

# Run as the unprivileged `thaddeus` user. We start as root only to take
# ownership of the (often root-owned) mounted volume, then re-exec dropped.
if [ "$(id -u)" = 0 ]; then
  chown -R thaddeus:thaddeus "$DATA"
  exec gosu thaddeus "$0" "$@"
fi

# A persistent host identity on the volume, minted once (idempotent) so
# attestations stay stable across restarts. Errors are NOT swallowed — a real
# failure (e.g. an unwritable volume) surfaces and stops the container.
thaddeus init >/dev/null

set -- serve --port "$PORT" --data "$DATA"
case "${THADDEUS_HOST:-}" in
  1 | true | yes) set -- "$@" --host ;;
esac
if [ -n "${THADDEUS_MIN_MERGES:-}" ]; then
  set -- "$@" --min-merges "$THADDEUS_MIN_MERGES"
fi

echo "thaddeus: $* (home=$HOME)"
exec thaddeus "$@"
