#!/bin/sh
# Thaddeus installer — downloads the `thaddeus` CLI and `lazythad` TUI binaries
# and puts them on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/thaddeus-run/thaddeus/main/install.sh | sh
#
# Env:
#   THADDEUS_VERSION   release tag to install (default: latest)
#   THADDEUS_INSTALL   install prefix (default: ~/.thaddeus; binaries go in bin/)
set -eu

REPO="thaddeus-run/thaddeus"
INSTALL_DIR="${THADDEUS_INSTALL:-$HOME/.thaddeus}"
BIN_DIR="$INSTALL_DIR/bin"

info() { printf '  %s\n' "$*"; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# A missing curl AND wget is fatal; otherwise `dl <url> <dest>` fetches quietly
# and returns non-zero on any HTTP error (so a 404 is a soft miss for callers).
dl() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "need curl or wget on PATH"
  fi
}
fetch() { # print a URL's body to stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}
# sha256 hex of a file via whichever tool is present ('' if none available).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf ''
  fi
}

# --- detect platform ---
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) err "unsupported OS: $os" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture: $arch" ;;
esac
ext=""
[ "$os" = windows ] && ext=".exe"

# --- resolve the release tag ---
version="${THADDEUS_VERSION:-}"
if [ -z "$version" ]; then
  body=$(fetch "https://api.github.com/repos/$REPO/releases/latest") ||
    err "could not reach the GitHub releases API"
  version=$(printf '%s' "$body" | grep -m1 '"tag_name"' |
    sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')
  [ -n "$version" ] || err "could not determine the latest release"
fi
base="https://github.com/$REPO/releases/download/$version"
# The release's checksum manifest — each binary is verified against it below.
sums=$(fetch "$base/SHA256SUMS" 2>/dev/null || printf '')

mkdir -p "$BIN_DIR"
alias_path="$BIN_DIR/thad$ext"
if [ -d "$alias_path" ] && [ ! -L "$alias_path" ]; then
  err "$alias_path is a directory; remove or rename it before installing"
fi
printf 'Installing Thaddeus %s (%s-%s) → %s\n' "$version" "$os" "$arch" "$BIN_DIR"

# --- download each tool (a binary not built for this platform is a soft skip) ---
installed=""
for tool in thaddeus lazythad; do
  asset="$tool-$os-$arch$ext"
  dest="$BIN_DIR/$tool$ext"
  info "↓ $asset"
  if dl "$base/$asset" "$dest.tmp" 2>/dev/null; then
    # Verify against SHA256SUMS when the manifest lists this asset — a tampered
    # asset or compromised CDN edge is then rejected rather than installed.
    expected=$(printf '%s\n' "$sums" |
      awk -v a="$asset" '($2 == a) || ($2 == "*" a) { print $1 }' | head -1)
    if [ -n "$expected" ]; then
      actual=$(sha256_of "$dest.tmp")
      if [ -z "$actual" ]; then
        rm -f "$dest.tmp"
        err "need sha256sum or shasum to verify $asset"
      elif [ "$actual" != "$expected" ]; then
        rm -f "$dest.tmp"
        err "checksum mismatch for $asset (expected $expected, got $actual)"
      fi
    fi
    chmod +x "$dest.tmp"
    mv "$dest.tmp" "$dest"
    installed="$installed $tool"
  else
    rm -f "$dest.tmp"
    info "  (no $tool binary for $os-$arch in $version — skipped)"
  fi
done
[ -n "$installed" ] || err "nothing was installed for $os-$arch"

# The CLI's documented short name points at the same installed binary. Use a
# relative symlink on Unix so moving the install prefix keeps it valid; copy on
# Windows shells where creating symlinks commonly requires extra privileges.
if [ -x "$BIN_DIR/thaddeus$ext" ]; then
  rm -f "$alias_path"
  if [ "$os" = windows ]; then
    cp "$BIN_DIR/thaddeus$ext" "$alias_path"
  else
    ln -s "thaddeus$ext" "$alias_path"
  fi
fi

# --- ensure BIN_DIR is on PATH ---
case ":${PATH:-}:" in
  *":$BIN_DIR:"*)
    info "PATH already includes $BIN_DIR"
    ;;
  *)
    line="export PATH=\"$BIN_DIR:\$PATH\""
    added=""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -qF "$BIN_DIR" "$rc" 2>/dev/null && continue
      printf '\n# Thaddeus\n%s\n' "$line" >>"$rc"
      added="$added $rc"
    done
    if [ -n "$added" ]; then
      info "Added $BIN_DIR to PATH in:$added"
      info "Restart your shell, or run:  $line"
    else
      info "Add this to your shell profile:  $line"
    fi
    ;;
esac

printf 'Done —%s installed. Try:  thaddeus --version\n' "$installed"
