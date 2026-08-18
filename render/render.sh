#!/usr/bin/env bash
#
# Render a package with the pinned Blender.
#
#   ./render.sh interior-render.zip --out out.png [--tier preview|final] [flags]
#
# Everything after the package is forwarded verbatim to the worker
# (worker/kprender/cli.py); run `./render.sh --help` for the full flag list.
#
# Blender is resolved in this order:
#   1. $BLENDER                                     (explicit override)
#   2. render/.blender/Blender.app/Contents/MacOS/Blender   (setup.sh, macOS)
#   3. render/.blender/blender                              (setup.sh, Linux)
#   4. whatever `blender` is on PATH                (your own install)
#
# --factory-startup keeps a user's add-ons, themes and unit preferences out of
# the render: the same package must produce the same picture on every machine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$HERE/worker/blender_entry.py"

[ -f "$ENTRY" ] || {
  printf '\033[31merror:\033[0m worker entry point missing: %s\n' "$ENTRY" >&2
  exit 1
}

resolve_blender() {
  if [ -n "${BLENDER:-}" ]; then
    [ -x "$BLENDER" ] || return 1
    printf '%s' "$BLENDER"
    return 0
  fi
  local candidate
  for candidate in \
    "$HERE/.blender/Blender.app/Contents/MacOS/Blender" \
    "$HERE/.blender/blender"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if command -v blender >/dev/null 2>&1; then
    command -v blender
    return 0
  fi
  return 1
}

if ! BLENDER_BIN="$(resolve_blender)"; then
  cat >&2 <<EOF
$(printf '\033[31merror:\033[0m') no Blender found.

Tried, in order:
  \$BLENDER                                          ${BLENDER:-(unset)}
  $HERE/.blender/Blender.app/Contents/MacOS/Blender
  $HERE/.blender/blender
  blender on PATH

Fix it with either:
  ./setup.sh                       # download the pinned build into render/.blender/
  export BLENDER=/path/to/blender  # use an install you already have
EOF
  exit 1
fi

exec "$BLENDER_BIN" -b --factory-startup -P "$ENTRY" -- "$@"
