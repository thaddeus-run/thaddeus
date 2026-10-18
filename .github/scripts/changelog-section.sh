#!/usr/bin/env bash
# Print the CHANGELOG.md section for one version: the lines after its
# "## [<version>]" heading, up to the next "## " heading. Exits 1 with a
# message when the section is missing or empty, so a tag without release notes
# stops in release preflight instead of publishing a bare release page.
set -euo pipefail

version="${1:?usage: changelog-section.sh <version> [changelog]}"
file="${2:-CHANGELOG.md}"

section=$(awk -v heading="## [$version]" '
  /^## / { if (found) exit; found = (substr($0, 1, length(heading)) == heading); next }
  found { print }
' "$file")

if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "$file has no \"## [$version]\" section with content; add one before tagging v$version" >&2
  exit 1
fi

printf '%s\n' "$section"
