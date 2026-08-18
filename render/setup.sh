#!/usr/bin/env bash
#
# One-shot setup for the native render worker.
#
#   ./setup.sh
#
# Downloads a PINNED Blender build into render/.blender/ (never system-wide,
# never committed), verifies it against the official sha256 list, then pulls the
# CC0 texture sets the material library references.
#
# Idempotent: an already-installed binary and already-fetched textures are
# skipped, so re-running it is the cheap way to repair a partial setup.
#
# macOS + Apple Silicon is the primary target (Cycles/Metal has no container
# story on macOS, so the render process runs natively). Linux x64 is supported
# for CI and for the NVIDIA path.
set -euo pipefail

# ---------------------------------------------------------------------------
# Pin. Bump BOTH this and the expectations in README.md when moving to a new
# LTS; the sha256 comes from Blender's own list, so nothing else needs editing.
# ---------------------------------------------------------------------------
BLENDER_VERSION="${BLENDER_VERSION:-5.2.0}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/.blender"
SERIES="Blender${BLENDER_VERSION%.*}"          # 5.2.0 -> Blender5.2
BASE_URL="https://download.blender.org/release/$SERIES"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# platform
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS/$ARCH" in
  Darwin/arm64)  ARCHIVE="blender-${BLENDER_VERSION}-macos-arm64.dmg";  KIND="dmg" ;;
  Darwin/x86_64) ARCHIVE="blender-${BLENDER_VERSION}-macos-x64.dmg";    KIND="dmg" ;;
  Linux/x86_64)  ARCHIVE="blender-${BLENDER_VERSION}-linux-x64.tar.xz"; KIND="tar" ;;
  *) die "unsupported platform $OS/$ARCH — install Blender $BLENDER_VERSION yourself and export BLENDER=/path/to/blender" ;;
esac

if [ "$KIND" = "dmg" ]; then
  BINARY="$DEST/Blender.app/Contents/MacOS/Blender"
else
  BINARY="$DEST/blender"
fi

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "no shasum/sha256sum available to verify the download (set BLENDER_SKIP_VERIFY=1 to bypass, at your own risk)"
  fi
}

fetch() { # url dest
  say "downloading $(basename "$2")"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

verify() { # file archive-name
  if [ "${BLENDER_SKIP_VERIFY:-0}" = "1" ]; then
    warn "BLENDER_SKIP_VERIFY=1 — skipping checksum verification of $2"
    return 0
  fi
  local sums="$TMP/blender-${BLENDER_VERSION}.sha256"
  if ! fetch "$BASE_URL/blender-${BLENDER_VERSION}.sha256" "$sums"; then
    die "could not fetch the checksum list $BASE_URL/blender-${BLENDER_VERSION}.sha256
     (set BLENDER_SKIP_VERIFY=1 to install without verification — only do this
      if you have checked the download some other way)"
  fi
  local expected
  expected="$(grep -F " $2" "$sums" | awk '{print $1}' | head -n1)"
  [ -n "$expected" ] || die "no checksum line for $2 in blender-${BLENDER_VERSION}.sha256"
  local actual
  actual="$(sha256_of "$1")"
  if [ "$expected" != "$actual" ]; then
    rm -f "$1"
    die "sha256 MISMATCH for $2
     expected: $expected
     actual:   $actual
     The download was discarded. Retry; if it keeps failing, the pinned
     version or the mirror has changed and BLENDER_VERSION needs review."
  fi
  say "sha256 ok ($expected)"
}

# ---------------------------------------------------------------------------
# 1. Blender
# ---------------------------------------------------------------------------
if [ -x "$BINARY" ]; then
  say "Blender already installed: $BINARY"
else
  mkdir -p "$DEST"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"; [ -n "${MOUNT:-}" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true' EXIT

  fetch "$BASE_URL/$ARCHIVE" "$TMP/$ARCHIVE"
  verify "$TMP/$ARCHIVE" "$ARCHIVE"

  if [ "$KIND" = "dmg" ]; then
    MOUNT="$TMP/mnt"
    mkdir -p "$MOUNT"
    say "mounting $ARCHIVE"
    hdiutil attach "$TMP/$ARCHIVE" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
    say "copying Blender.app -> $DEST"
    rm -rf "$DEST/Blender.app"
    cp -R "$MOUNT/Blender.app" "$DEST/Blender.app"
    hdiutil detach "$MOUNT" -quiet
    MOUNT=""
    # Gatekeeper quarantines anything that arrived from a browser-style
    # download; the flag makes the first `render.sh` run not pop a dialog.
    xattr -dr com.apple.quarantine "$DEST/Blender.app" 2>/dev/null || true
  else
    say "extracting $ARCHIVE -> $DEST"
    tar -xJf "$TMP/$ARCHIVE" -C "$TMP"
    EXTRACTED="$(find "$TMP" -maxdepth 1 -type d -name 'blender-*' | head -n1)"
    [ -n "$EXTRACTED" ] || die "unexpected archive layout in $ARCHIVE"
    rm -rf "${DEST:?}"/*
    mv "$EXTRACTED"/* "$DEST/"
  fi

  [ -x "$BINARY" ] || die "install finished but $BINARY is missing"
  say "installed $("$BINARY" --version 2>/dev/null | head -n1 || echo "Blender $BLENDER_VERSION")"
fi

# ---------------------------------------------------------------------------
# 2. textures (CC0, fetched, never committed)
# ---------------------------------------------------------------------------
say "fetching pinned CC0 texture sets"
if command -v python3 >/dev/null 2>&1; then
  if ! python3 "$HERE/materials/fetch_textures.py"; then
    warn "texture fetch failed (offline?). Renders will still work — materials
      fall back to flat OpenPBR parameters. Re-run:
        python3 render/materials/fetch_textures.py"
  fi
else
  warn "python3 not found; skipping texture fetch"
fi

# ---------------------------------------------------------------------------
# 3. next steps
# ---------------------------------------------------------------------------
cat <<EOF

$(say "setup complete")

  Blender:  $BINARY
  Textures: $HERE/materials/textures/

Next:
  1. In the app: Export ▾ → "Render package (.zip)…"  →  interior-render.zip
  2. Fast look:  ./render.sh interior-render.zip --out out.png --tier preview
  3. Full res:   ./render.sh interior-render.zip --out out.png --tier final --save-blend

Useful flags: --probe (dump transforms, no render) · --no-portals · --no-ceiling
              --device cpu|metal|optix|cuda · --denoise-cpu · --uv-box
EOF
