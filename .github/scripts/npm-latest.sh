#!/usr/bin/env bash
# Points npm `latest` for both launchers (npm/thaddeus, npm/lazythad) at a
# release version. release.yml's npm-latest and npm-promote jobs call it, each
# holding the npm-latest concurrency group, so `latest` is read fresh here and
# no other run moves it in between.
#
#   forward  The release path. Moves `latest` only up: a newer or equal
#            `latest` is left alone and logged.
#   promote  An explicit request. Checks that both launchers have the version
#            before moving either, then moves `latest` even backwards, and
#            logs when it does.
#
# --dry-run checks and logs what would move, and moves nothing. A nightly
# version is always refused: nightlies never touch `latest`.
#
# Run it from the repository root with the pinned npm (>= 11.21.0, which can
# move dist-tags over OIDC) on PATH and `id-token: write`. Versions are ordered
# by the semver package bundled in npm, because these jobs have no bun.
# Moving a dist-tag also needs "Allow npm dist-tag" in each package's trusted
# publisher settings on npmjs.com.
#
# Usage: .github/scripts/npm-latest.sh forward|promote <version> [--dry-run]
set -euo pipefail

usage() {
  echo "usage: $0 forward|promote <version> [--dry-run]" >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
mode=$1
version=$2
dry_run=false
case "${3:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) usage ;;
esac
# What the failure message tells the reader to do next.
case "$mode" in
  forward) next_step="run the promote dispatch" ;;
  promote) next_step="re-run this job" ;;
  *) usage ;;
esac
[ -n "$version" ] || usage
case "$version" in
  *-nightly*)
    echo "refusing to point npm latest at nightly $version" >&2
    exit 1
    ;;
esac

names=()
for pkg in thaddeus lazythad; do
  names+=("$(node -p "require('./npm/$pkg/package.json').name")")
done

semver="$(npm root -g)/npm/node_modules/semver"
# Prints 1, 0 or -1 as $1 sorts after, with or before $2.
order() {
  node -p 'require(process.argv[1]).compare(process.argv[2], process.argv[3])' \
    "$semver" "$1" "$2"
}

# A promote never leaves the launchers on different releases.
if [ "$mode" = promote ]; then
  for name in "${names[@]}"; do
    published=$(npm view "$name@$version" version 2>/dev/null) || published=""
    if [ "$published" != "$version" ]; then
      echo "refusing to promote $version: $name@$version is not on npm" >&2
      exit 1
    fi
  done
fi

failed=false
for name in "${names[@]}"; do
  current="$(npm view "$name" dist-tags.latest)"
  cmp=1
  if [ -n "$current" ]; then cmp=$(order "$version" "$current"); fi
  if [ "$cmp" -eq 0 ]; then
    echo "$name: latest is already $version"
    continue
  fi
  direction=""
  if [ "$cmp" -lt 0 ]; then
    if [ "$mode" = forward ]; then
      echo "$name: latest is $current, newer than $version; leaving it"
      continue
    fi
    direction=" backwards"
  fi
  if [ "$dry_run" = true ]; then
    echo "$name: dry run; would move latest$direction from ${current:-nothing} to $version"
    continue
  fi
  if [ -n "$direction" ]; then
    echo "$name: moving latest backwards from $current to $version, as requested"
  fi
  # Retried for the same flaky OIDC token exchange as npm publish.
  moved=false
  for attempt in 1 2 3; do
    if npm dist-tag add "$name@$version" latest; then
      moved=true
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      echo "dist-tag attempt $attempt for $name failed; retrying in 15s" >&2
      sleep 15
    fi
  done
  if [ "$moved" = true ]; then
    echo "$name: latest moved from ${current:-nothing} to $version"
  else
    echo "npm refused to move latest; enable \"Allow npm dist-tag\" in the trusted publisher settings of $name on npmjs.com, then $next_step" >&2
    failed=true
  fi
done
[ "$failed" = false ]
