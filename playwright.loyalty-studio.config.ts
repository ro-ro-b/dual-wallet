import { defineConfig, devices } from "@playwright/test";
import {
  CANON_TEMPLATE,
  ISSUER,
  PASS_TEMPLATE,
  loyaltyFixtureEnvironment,
  loyaltyRegistry,
  // @ts-expect-error -- a plain ES module shared with the fixture runner
} from "./e2e/loyalty/environment.mjs";
// @ts-expect-error -- a plain ES module shared with the fixture runner
import { FICTIONAL_ORGANIZATION } from "./e2e/tickets-home/environment.mjs";

// INTEGRATED FICTIONAL Loyalty suite (opt-in):
//   STUDIO_LOYALTY_DIR=<Studio checkout> npx playwright test -c playwright.loyalty-studio.config.ts
// The same e2e/loyalty.spec.ts as playwright.loyalty.config.ts, with the local
// fake runtime replaced by Studio's REAL Loyalty member leg and record runtime
// (Studio scripts/loyalty-face-integrated.mjs --serve on localhost:4350: a
// client Loyalty service whose staff hooks are client staff steps under the
// client's own bootstrapped grants) and the fake api-v3's
// Loyalty provider world forwarded to that driver's FICTIONAL provider
// (127.0.0.1:4360). The real wallet (next dev) on http://localhost:3340. None
// of it is Dual, a live Studio, a client or a member.
const studio = process.env.STUDIO_LOYALTY_DIR;
if (!studio) {
  throw new Error(
    "STUDIO_LOYALTY_DIR must name the Studio checkout whose Loyalty runtime this suite drives.",
  );
}
// (read by e2e/loyalty.spec.ts in this config's runner and workers)
process.env.LOYALTY_FIXTURE_STUDIO_INTEGRATED = "1";
const env = loyaltyFixtureEnvironment();
const dualPort = Number(process.env.LOYALTY_FIXTURE_STUDIO_DUAL_PORT || 4360);
const [binding] = loyaltyRegistry(env.runtimeOrigin);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "loyalty.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/loyalty-studio",
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
      env: {
        ...process.env,
        ...env.api,
        MOCK_LOYALTY_DUAL_URL: `http://127.0.0.1:${dualPort}`,
      },
    },
    {
      command: `node ${studio}/scripts/loyalty-face-integrated.mjs --serve`,
      url: `${env.runtimeOrigin}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        LOYALTY_STUDIO_RUNTIME_PORT: new URL(env.runtimeOrigin).port,
        LOYALTY_STUDIO_DUAL_PORT: String(dualPort),
        LOYALTY_STUDIO_FACE_JSON: JSON.stringify({
          applicationId: binding.applicationId,
          artifactHash: binding.artifactHash,
          faceProgramme: binding.programmeId,
          origin: env.runtimeOrigin,
          publisher: binding.publisher,
          version: binding.version,
        }),
        LOYALTY_STUDIO_WALLET_ORIGIN: env.origin,
        LOYALTY_STUDIO_WALLET_KEY_ID: env.wallet.FACE_ASSERTION_KEY_ID,
        FACE_ASSERTION_PUBLIC_KEY: env.runtime.FACE_ASSERTION_PUBLIC_KEY,
        LOYALTY_STUDIO_ORGANIZATION: FICTIONAL_ORGANIZATION,
        LOYALTY_STUDIO_CANONICAL_TEMPLATE: CANON_TEMPLATE,
        LOYALTY_STUDIO_PASS_TEMPLATE: PASS_TEMPLATE,
        LOYALTY_STUDIO_ISSUER: ISSUER,
      },
    },
    {
      command: `npx next dev -p ${new URL(env.origin).port}`,
      url: `${env.origin}/api/host/configuration`,
      reuseExistingServer: false,
      timeout: 300_000,
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
