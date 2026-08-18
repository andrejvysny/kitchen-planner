# Render worker — Docker (Linux + NVIDIA only)

**macOS users: use `../setup.sh` + `../render.sh` instead.** Docker on macOS
has no Metal passthrough, so a container here cannot reach the GPU at all —
Cycles would fall back to CPU inside the container, which is strictly worse
than running the native worker directly on the host. This directory exists
for the **secondary target**: Linux hosts with an NVIDIA GPU and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
installed, where container GPU passthrough actually works.

## Status: optional, unexercised

This is a follow-up path, not the milestone's spike target — it has not been
built or run against a real GPU as part of this change. It is kept **simple
and honest** on purpose: a Dockerfile that installs the same pinned Blender
build `../setup.sh` downloads natively, copies in the worker + material
library, and an entrypoint that calls it exactly the way `../render.sh` does.
The real exercise of this path — and the place a serverless/queued render
service would actually live — is milestone 2's `render/api/` (see that
directory's README). Treat everything here as a documented starting point,
not a validated one: build it, run it against `render/worker/tests/
make_synthetic_package.py`'s output first, and expect to iterate on base-image
and driver versions before it sees production traffic.

## What's here

| File | Purpose |
|---|---|
| `Dockerfile` | CUDA runtime base + the pinned Linux Blender build + the worker/materials/manifest directories |
| `entrypoint.sh` | Thin wrapper: `blender -b --factory-startup -P blender_entry.py -- "$@"`, exactly like `../render.sh`'s exec line |
| `docker-compose.yml` | `render-gpu` (NVIDIA device reservation) and a `cpu` Compose profile with `render-cpu`, both mounting `./in` (read-only) and `./out` |

## Build & run

```bash
cd render/docker
docker compose build

# GPU (needs the NVIDIA Container Toolkit on the host)
mkdir -p in out
cp /path/to/interior-render.zip in/
docker compose run --rm render-gpu

# CPU fallback (any Linux host, no GPU needed)
docker compose --profile cpu run --rm render-cpu
```

Both services pass their package/flags as the container command — edit the
`command:` list in `docker-compose.yml` (package filename, `--tier`,
`--device`) rather than baking one render into the image.

## What is NOT handled here

- **Textures are not baked into the image.** `render/materials/textures/` is
  gitignored (CC0 assets fetched on demand, never committed) — this
  Dockerfile does not run `fetch_textures.py` at build time. Mount a
  pre-fetched `textures/` directory over `/app/render/materials/textures` if
  you want library texture maps; without it every material still renders,
  just from its flat OpenPBR parameters (the same graceful-degradation path
  `cli.py`/`materials.py` already use for a missing library or a missing map).
- **No health check, no job queue, no retry/backoff.** One `docker run` = one
  render, same as `render.sh` on the command line.
- **Driver/CUDA version drift is on you.** The NVIDIA Container Toolkit needs
  a host driver new enough for the image's CUDA runtime; pin both deliberately
  when this path actually gets used.
