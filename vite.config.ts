import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // three.js alone is ~500 kB minified; it gets its own cached chunk
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: {
    port: 5173,
  },
});
