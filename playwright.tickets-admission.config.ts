import { defineConfig, devices } from "@playwright/test";
// @ts-expect-error -- a plain ES module shared with the fixture runner
import { admissionFixtureEnvironment } from "./e2e/tickets-home/environment.mjs";

// FICTIONAL ticket-admission-v1 (P4.3) suite (opt-in):
//   npx playwright test -c playwright.tickets-admission.config.ts
// The real wallet (next dev) as the made-up "Harbour Nights" host on
// http://localhost:3320, the local fake api-v3 with one closed-template ticket
// on 127.0.0.1:4320, and a LOCAL FAKE Tickets runtime on localhost:4330 that
// verifies the wallet's assertions with this run's public key. None of it is
// Dual, a provider or the shared Tickets service.
const env = admissionFixtureEnvironment();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "tickets-admission.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/tickets-admission",
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
      command: "node e2e/tickets-home/fake-tickets-runtime.mjs",
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
