# Render API (placeholder)

Reserved for the future job API: a TypeScript service (Fastify or Hono) that
accepts an `interior-render.zip` upload, queues it with BullMQ over Redis,
and reports job status/results back to the app. Not implemented yet — see
milestone plan §5/§9 ("Deferred").

The API and its queue are ordinary containerizable services (Docker is fine
for them). The Blender render process itself is not: it must run natively on
the worker host to get Metal on Apple Silicon (see `render/README.md`), so
the API's job runner shells out to `render/render.sh` on a native macOS
worker rather than spawning Blender inside a container.
