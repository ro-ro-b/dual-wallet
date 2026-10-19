import { defineConfig, devices } from "@playwright/test";
// @ts-expect-error -- a plain ES module shared with the fixture runner
import { loyaltyFixtureEnvironment } from "./e2e/loyalty/environment.mjs";

// FICTIONAL loyalty-join-earn-v1 suite (opt-in):
//   npx playwright test -c playwright.loyalty.config.ts
// The real wallet (next dev) as the made-up host on http://localhost:3340,
// the local fake api-v3 with a FICTIONAL provider world on 127.0.0.1:4340,
// and a LOCAL FAKE Loyalty runtime on localhost:4350 that verifies the
// wallet's assertions with this run's public key. None of it is Dual, a
// provider or Studio.
const env = loyaltyFixtureEnvironment();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "loyalty.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/loyalty",
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
      url: `${env.runtimeOrigin}/health`,
      reuseExistingServer: false,
      env: { ...process.env, ...env.runtime },
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
