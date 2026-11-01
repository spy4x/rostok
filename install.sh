#!/bin/sh
# Installs the rostok binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/spy4x/rostok/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/spy4x/rostok/main/install.sh | sh -s -- 1.24.0
#
# Downloads rostok-<target>.gz and SHA256SUMS of the latest (or the given) release, checks the
# checksum, and installs to ~/.local/bin/rostok. ROSTOK_INSTALL=<dir> installs elsewhere.
# ROSTOK_TEST_RELEASES_URL replaces the GitHub releases URL; it exists for tests.
set -eu

releases="${ROSTOK_TEST_RELEASES_URL:-https://github.com/spy4x/rostok/releases}"
dir="${ROSTOK_INSTALL:-$HOME/.local/bin}"
version="${1:-}"

fail() {
  echo "rostok install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os="unknown-linux-gnu" ;;
  Darwin) os="apple-darwin" ;;
  *) fail "no rostok binary for $(uname -s); install with Deno instead: deno install -g -A -n rostok jsr:@rostok/cli" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  aarch64 | arm64) arch="aarch64" ;;
  *) fail "no rostok binary for CPU $(uname -m)" ;;
esac
asset="rostok-${arch}-${os}.gz"

if [ -z "$version" ]; then
  base="$releases/latest/download"
else
  version="${version#v}"
  echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "not a version: $version"
  base="$releases/download/v$version"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "needs curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset..."
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS does not list $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset: expected $expected, got $actual"

mkdir -p "$dir"
# Unpack next to the target, then rename: a rename on one filesystem replaces it atomically.
gunzip -c "$tmp/$asset" >"$dir/.rostok-install-$$"
chmod 755 "$dir/.rostok-install-$$"
mv -f "$dir/.rostok-install-$$" "$dir/rostok"

echo "Installed $(NO_COLOR=1 ROSTOK_NO_UPDATE_CHECK=1 "$dir/rostok" --version 2>/dev/null) to $dir/rostok"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add it to your PATH, e.g. in ~/.profile: export PATH=\"$dir:\$PATH\"" ;;
esac
