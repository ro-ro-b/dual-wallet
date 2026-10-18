import { defineConfig, devices } from "@playwright/test";
// @ts-expect-error -- a plain ES module shared with the manual runner
// (e2e/tickets-home/serve.mjs), so both start exactly the same fixture.
import { fixtureEnvironment } from "./e2e/tickets-home/environment.mjs";

// FICTIONAL branded-host Tickets/Home suite (opt-in):
//   npx playwright test -c playwright.tickets-home.config.ts
// The actual wallet (next dev) as the made-up "Harbour Nights" host on
// http://localhost:3310 and the local fake api-v3 with its opt-in ticket
// objects on 127.0.0.1:4310 (both ports configurable). No sibling repository,
// no Dual, no provider and no released host configuration is used.
const env = fixtureEnvironment();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "tickets-home.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/tickets-home",
  use: {
    baseURL: env.origin,
    // The viewer's zone: "Today" and every time shown use it.
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
