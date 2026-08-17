import { defineConfig, devices } from '@playwright/test';

/**
 * Specs under e2e/ run against the PRODUCTION build, exactly like
 * test/interact.mjs — the bespoke runner stays the full regression net while
 * these specs cover what the editor refactor actually touches, with traces and
 * per-test isolation the old runner cannot give.
 *
 * The GL flags match interact.mjs: CI has no GPU, so the whole suite renders
 * through SwiftShader. Anything asserting the end state of an animation or a
 * queued rebuild must poll (expect.poll / toPass), never sleep — a fixed sleep
 * silently encodes a frame-rate assumption that only holds on a dev machine.
 */

const PORT = Number(process.env.KP_E2E_PORT ?? 4173);
const baseURL = process.env.KP_BASE_URL ?? `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    viewport: { width: 1600, height: 950 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 950 },
        launchOptions: {
          ...(process.env.KP_CHROMIUM_PATH ? { executablePath: process.env.KP_CHROMIUM_PATH } : {}),
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],

  // reuse an already-running preview locally; always start one on CI
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
