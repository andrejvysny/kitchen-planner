# Render worker — Linux + NVIDIA only. See README.md: macOS should use
# ../setup.sh + ../render.sh natively instead (no Metal passthrough in
# containers). This image is optional and unexercised — kept simple and
# honest until the future serverless milestone actually drives it.
#
# Build context is render/ (this Dockerfile COPYs worker/materials/manifest,
# all siblings of this docker/ directory) — build from render/, not from here:
#
#   docker build -f docker/Dockerfile -t kitchen-planner-render ..   (from render/docker/)
#
# docker-compose.yml sets this up correctly (context: .., dockerfile:
# docker/Dockerfile); see README.md.

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Keep this equal to render/setup.sh's BLENDER_VERSION pin — same build,
# same sha256 list, just fetched at image-build time instead of by the
# script. Bump both together when moving to a new LTS.
ARG BLENDER_VERSION=5.2.0
ENV BLENDER_VERSION=${BLENDER_VERSION} \
    DEBIAN_FRONTEND=noninteractive \
    BLENDER_BIN=/opt/blender/blender

# Blender's official Linux tarball is a self-contained build (bundled Python,
# bundled libs) — it only needs a handful of system libraries a minimal
# Ubuntu image doesn't ship: X11/GL client libs used even in `-b` background
# mode, plus curl/xz to fetch and unpack the tarball itself.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      xz-utils \
      libxrender1 \
      libxi6 \
      libxkbcommon0 \
      libxfixes3 \
      libxxf86vm1 \
      libsm6 \
      libgl1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fL --retry 3 \
      "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      -o /tmp/blender.tar.xz \
    && mkdir -p /opt/blender \
    && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz \
    && test -x "$BLENDER_BIN"

# Mirror the repo's own render/{worker,materials,manifest} layout under
# /app/render — kprender's own path maths (e.g. openpbr_map.py's
# LIBRARY_PATH) walks up from worker/kprender/*.py to find materials/ and
# manifest/ as siblings of worker/, so the relative layout must match.
WORKDIR /app/render
COPY worker/ ./worker/
COPY materials/ ./materials/
COPY manifest/ ./manifest/
COPY docker/entrypoint.sh /app/render/entrypoint.sh
RUN chmod +x /app/render/entrypoint.sh

ENTRYPOINT ["/app/render/entrypoint.sh"]
