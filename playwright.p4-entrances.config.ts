import { defineConfig, devices } from "@playwright/test";
// @ts-expect-error -- a plain ES module shared with the fixture runner
import { p4FixtureEnvironment } from "./e2e/p4-entrances/environment.mjs";

// FICTIONAL P4 native-entrance suite (opt-in):
//   npx playwright test -c playwright.p4-entrances.config.ts
// The real wallet (next dev) as the made-up branded host on
// http://localhost:3370 with Tickets and Loyalty; the local fake api-v3 with
// fictional tickets and a fictional provider world on 127.0.0.1:4370; a LOCAL
// FAKE protected backend on https://localhost:4371 that refuses every request
// without this run's fictional workload token, serving the pinned Studio H2
// Ticket face and forwarding to a LOCAL FAKE Loyalty runtime on
// localhost:4372. None of it is Dual, Vercel, a provider or Studio.
const env = p4FixtureEnvironment();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "p4-entrances.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/p4-entrances",
  use: {
    baseURL: env.origin,
    timezoneId: "Australia/Sydney",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node e2e/mock-api.mjs",
      url: `${env.apiOrigin}/health`,
      reuseExistingServer: false,
      env: { ...process.env, ...env.api },
    },
    {
      command: "node e2e/loyalty/fake-loyalty-runtime.mjs",
      url: `http://localhost:${env.runtime.FAKE_LOYALTY_RUNTIME_PORT}/health`,
      reuseExistingServer: false,
      env: { ...process.env, ...env.runtime },
    },
    {
      command: "node e2e/p4-entrances/protected-backend.mjs",
      url: `${env.controlOrigin}/health`,
      reuseExistingServer: false,
      env: { ...process.env, ...env.backend },
    },
    {
      command: `npx next dev -p ${new URL(env.origin).port}`,
      url: `${env.origin}/api/host/configuration`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { ...process.env, ...env.wallet },
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        },
      },
    },
  ],
});
