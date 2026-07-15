#!/bin/sh
# Start `thaddeus serve`, configured from the environment, over the /data volume.
#
#   PORT                 listen port (default 4000; platforms like Railway set this)
#   THADDEUS_DATA        durable data dir (default /data)
#   THADDEUS_ATTESTATION_AWS_KMS_KEY_ARN exact managed Ed25519 signing key ARN
#   THADDEUS_ATTESTATION_RATE_LIMIT per-subject rolling-hour cap (default/max 20)
#   THADDEUS_MIN_MERGES  gate land on N attested merges per op author
#   THADDEUS_MAX_REQUEST_BODY_BYTES maximum accepted request body (default 16 MiB)
#   THADDEUS_MAX_REPUTATION_ARCHIVE_BYTES nested archive cap (default 4 MiB)
#   THADDEUS_MAX_REPUTATION_CONTRIBUTIONS raw archive contribution cap (default 4096)
#   THADDEUS_MAX_FIELD_BYTES logical UTF-8 text cap (default 16 KiB)
#   THADDEUS_DEFAULT_PAGE_SIZE default collection page size (default 100)
#   THADDEUS_MAX_PAGE_SIZE maximum collection page size (default 1000)
#   THADDEUS_MAX_PAGE_RESPONSE_BYTES encoded JSON page cap (default 16 MiB)
#   THADDEUS_PAGINATION_CURSOR_CAPACITY live cursor cap (default 1000)
#   THADDEUS_PAGINATION_CURSOR_TTL_MS cursor idle expiry (default 300000)
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
if [ -n "${THADDEUS_MAX_REPUTATION_ARCHIVE_BYTES:-}" ]; then
  set -- "$@" --max-reputation-archive-bytes "$THADDEUS_MAX_REPUTATION_ARCHIVE_BYTES"
fi
if [ -n "${THADDEUS_MAX_REPUTATION_CONTRIBUTIONS:-}" ]; then
  set -- "$@" --max-reputation-contributions "$THADDEUS_MAX_REPUTATION_CONTRIBUTIONS"
fi
if [ -n "${THADDEUS_MAX_FIELD_BYTES:-}" ]; then
  set -- "$@" --max-field-bytes "$THADDEUS_MAX_FIELD_BYTES"
fi
if [ -n "${THADDEUS_DEFAULT_PAGE_SIZE:-}" ]; then
  set -- "$@" --default-page-size "$THADDEUS_DEFAULT_PAGE_SIZE"
fi
if [ -n "${THADDEUS_MAX_PAGE_SIZE:-}" ]; then
  set -- "$@" --max-page-size "$THADDEUS_MAX_PAGE_SIZE"
fi
if [ -n "${THADDEUS_MAX_PAGE_RESPONSE_BYTES:-}" ]; then
  set -- "$@" --max-page-response-bytes "$THADDEUS_MAX_PAGE_RESPONSE_BYTES"
fi
if [ -n "${THADDEUS_PAGINATION_CURSOR_CAPACITY:-}" ]; then
  set -- "$@" --pagination-cursor-capacity "$THADDEUS_PAGINATION_CURSOR_CAPACITY"
fi
if [ -n "${THADDEUS_PAGINATION_CURSOR_TTL_MS:-}" ]; then
  set -- "$@" --pagination-cursor-ttl-ms "$THADDEUS_PAGINATION_CURSOR_TTL_MS"
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
