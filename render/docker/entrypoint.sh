#!/usr/bin/env bash
#
# Container entrypoint. Thin on purpose — the same invocation ../render.sh
# uses natively, just with the Blender binary and worker paths baked into
# the image instead of resolved at runtime:
#
#   blender -b --factory-startup -P blender_entry.py -- <args>
#
# Everything after the image's ENTRYPOINT (i.e. the container's CMD, or
# `docker run ... <args>`) becomes "$@" here and is forwarded verbatim to
# worker/kprender/cli.py — see docker-compose.yml for the two services'
# default commands, or run with --help to see the flags.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLENDER_BIN="${BLENDER_BIN:-/opt/blender/blender}"
ENTRY="$HERE/worker/blender_entry.py"

[ -x "$BLENDER_BIN" ] || {
  printf '\033[31merror:\033[0m Blender not found or not executable: %s\n' "$BLENDER_BIN" >&2
  exit 1
}
[ -f "$ENTRY" ] || {
  printf '\033[31merror:\033[0m worker entry point missing: %s\n' "$ENTRY" >&2
  exit 1
}

exec "$BLENDER_BIN" -b --factory-startup -P "$ENTRY" -- "$@"
