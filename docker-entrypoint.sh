#!/bin/sh
# Start `thaddeus serve`, configured from the environment, over the /data volume.
#
#   PORT                 listen port (default 4000; platforms like Railway set this)
#   THADDEUS_DATA        durable data dir (default /data)
#   THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN exact managed Ed25519 signing key ARN
#   THADDEUS_ATTESTATION_RATE_LIMIT per-subject rolling-hour cap (default/max 20)
#   THADDEUS_MIN_MERGES  gate land on N attested merges per op author
#   THADDEUS_MAX_REQUEST_BODY_BYTES maximum accepted request body (default 16 MiB)
#   THADDEUS_REPLAY_NONCE_CAPACITY maximum live durable replay nonces (default 100000)
#   THADDEUS_REQUEST_SKEW_MS accepted signed timestamp skew (default/max 300000)
#   THADDEUS_TRUST_HOSTS comma-separated foreign host DIDs whose proofs count
set -eu

DATA="${THADDEUS_DATA:-/data}"
PORT="${PORT:-4000}"
mkdir -p "$DATA"

# Run as the unprivileged `thaddeus` user. We start as root only to take
# ownership of the (often root-owned) mounted volume, then re-exec dropped.
if [ "$(id -u)" = 0 ]; then
  chown -R thaddeus:thaddeus "$DATA"
  exec gosu thaddeus "$0" "$@"
fi

set -- serve --port "$PORT" --data "$DATA"
if [ -n "${THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN:-}" ]; then
  set -- "$@" --attestation-aws-kms-key-arn "$THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN"
fi
if [ -n "${THADDEUS_ATTESTATION_RATE_LIMIT:-}" ]; then
  set -- "$@" --attestation-rate-limit "$THADDEUS_ATTESTATION_RATE_LIMIT"
fi
if [ -n "${THADDEUS_MIN_MERGES:-}" ]; then
  set -- "$@" --min-merges "$THADDEUS_MIN_MERGES"
fi
if [ -n "${THADDEUS_MAX_REQUEST_BODY_BYTES:-}" ]; then
  set -- "$@" --max-request-body-bytes "$THADDEUS_MAX_REQUEST_BODY_BYTES"
fi
if [ -n "${THADDEUS_REPLAY_NONCE_CAPACITY:-}" ]; then
  set -- "$@" --replay-nonce-capacity "$THADDEUS_REPLAY_NONCE_CAPACITY"
fi
if [ -n "${THADDEUS_REQUEST_SKEW_MS:-}" ]; then
  set -- "$@" --request-skew-ms "$THADDEUS_REQUEST_SKEW_MS"
fi
if [ -n "${THADDEUS_TRUST_HOSTS:-}" ]; then
  old_ifs="$IFS"
  IFS=','
  for did in $THADDEUS_TRUST_HOSTS; do
    set -- "$@" --trust-host "$did"
  done
  IFS="$old_ifs"
fi

echo "thaddeus: $*"
exec thaddeus "$@"
