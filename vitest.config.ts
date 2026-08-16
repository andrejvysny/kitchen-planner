import { defineConfig } from 'vitest/config';

/**
 * Unit suite only. `e2e/**` holds Playwright specs — they match Vitest's
 * default `*.spec.ts` glob but need a browser, so they must be excluded or
 * `npm run test:unit` fails collecting them.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
});
