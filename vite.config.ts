import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  base: './',
  plugins: [react()],
  // Stamped into the render manifest (src/app/version.ts) — a plain string
  // literal at build/dev time, not a runtime read of package.json.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // three.js alone is ~500 kB minified; it gets its own cached chunk
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // react is versioned independently of the app code, so it caches
        // separately too — same reasoning as the three chunk above.
        // 'react-dom/client' and 'react/jsx-runtime' are listed explicitly:
        // they are separate module ids, unreachable from the package roots,
        // so without them the renderer (~57 kB gz) lands in the app chunk.
        manualChunks: {
          three: ['three'],
          react: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
