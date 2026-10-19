// FICTIONAL loyalty-join-earn-v1 journeys (playwright.loyalty.config.ts): the
// real wallet, BFF, journal, assertions and proofs against the local fake
// api-v3 (with a fictional provider world) and a LOCAL FAKE Loyalty runtime.
// Not Studio, not Dual, not a member: source proof of the wallet's half.
import { expect, test, type Page } from "@playwright/test";
// @ts-expect-error -- plain ES module shared with the fixture runner
import { FICTIONAL_ACCOUNTS } from "./tickets-home/environment.mjs";
import {
  CANON,
  LOYALTY_SLUG,
  RECORD_ID,
  loyaltyFixtureEnvironment,
  // @ts-expect-error -- plain ES module shared with the fixture runner
} from "./loyalty/environment.mjs";

const { apiOrigin, runtimeOrigin } = loyaltyFixtureEnvironment();
const PAGE = `/products/${LOYALTY_SLUG}/loyalty`;

async function post(origin: string, path: string, body: unknown = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
const counts = async () =>
  (await post(runtimeOrigin, "/__test__/counts")) as Record<string, number>;

function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

async function signInTo(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email address").fill(FICTIONAL_ACCOUNTS.holder.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(FICTIONAL_ACCOUNTS.holder.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(path);
}

async function tabTo(page: Page, locator: ReturnType<Page["getByRole"]>) {
  for (let step = 0; step < 40; step++) {
    if (
      await locator
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    )
      return;
    await page.keyboard.press("Tab");
  }
  await expect(locator).toBeFocused();
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** Joined from the page, approved and created by the fictional staff. */
async function activeMember(page: Page) {
  await signInTo(page, PAGE);
  await page.getByRole("checkbox", { name: /I agree to these terms/ }).check();
  await page.getByRole("button", { name: "Join the programme" }).click();
  await expect(
    page.getByText("Your request to join is with the programme team."),
  ).toBeVisible();
  await post(runtimeOrigin, "/__test__/approve");
  await post(runtimeOrigin, "/__test__/create");
  await page.reload();
  await expect(page.getByText("You're a member.")).toBeVisible();
}

test.beforeEach(async () => {
  await post(apiOrigin, "/__test__/reset");
  await post(runtimeOrigin, "/__test__/reset");
});

test("at phone width, from the keyboard: consent, join, approval, membership, an activity verified", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  await signInTo(page, PAGE);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Harbour Makers Circle (fictional)",
    }),
  ).toBeVisible();

  // Consent is the member's own act, from the keyboard; nothing before it.
  const agree = page.getByRole("checkbox", { name: /I agree to these terms/ });
  await tabTo(page, agree);
  await page.keyboard.press("Space");
  await expect(agree).toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "Join the programme" }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Your request to join is with the programme team."),
  ).toBeVisible();
  // The programme's record of the consent, not a Dual fact.
  await expect(page.getByText(/Programme record: you agreed/)).toBeVisible();
  await noHorizontalOverflow(page);

  await post(runtimeOrigin, "/__test__/approve");
  await page.reload();
  await expect(
    page.getByText("Approved. Your membership is being created."),
  ).toBeVisible();

  // Created by the issuer, with the member's own pass: proven active.
  await post(runtimeOrigin, "/__test__/create");
  await page.reload();
  await expect(page.getByText("You're a member.")).toBeVisible();

  const evidence = page.getByRole("textbox", { name: "What you did" });
  await tabTo(page, evidence);
  await page.keyboard.type("Workshop sign-in 0042");
  await tabTo(page, page.getByRole("button", { name: "Submit activity" }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Submitted. Waiting for the programme to verify it."),
  ).toBeVisible();
  expect((await counts())["loyalty.activity.submit"]).toBe(1);
  // The page re-reads the membership after a submission; a staff change
  // landing between the runtime's read and the wallet's public read would
  // (rightly) make that read unconfirmed, so let it settle first.
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("You're a member.")).toBeVisible();

  // The verifier accepts it; the member checks, and it counts.
  await post(runtimeOrigin, "/__test__/verify");
  await tabTo(page, page.getByRole("button", { name: "Check status" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Verified. This activity counts.")).toBeVisible();
  // Nothing invented: no points, tier or balance anywhere.
  await expect(page.getByText(/points|tier|balance/i)).toHaveCount(0);
  await noHorizontalOverflow(page);

  // The home's membership card says only what was proven.
  await page.goto("/");
  const card = page.getByRole("region", { name: "Your membership" });
  await expect(card.getByText("You're a member.")).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Open your membership" }),
  ).toHaveAttribute("href", PAGE);
  await noHorizontalOverflow(page);
  expect((await counts())["loyalty.activity.submit"]).toBe(1);
  expect(problems).toEqual([]);
});

test("a lost submission reply is unknown, never resent, and read back after a reload", async ({
  page,
}) => {
  const problems = watch(page);
  await activeMember(page);
  await post(runtimeOrigin, "/__test__/mode", { loseSubmit: true });
  await page
    .getByRole("textbox", { name: "What you did" })
    .fill("Workshop sign-in 0042");
  await page.getByRole("button", { name: "Submit activity" }).click();
  await expect(
    page.getByText(/Sent, but its outcome isn't confirmed yet/),
  ).toBeVisible();
  // The same evidence again is refused by the wallet; nothing is sent.
  await page
    .getByRole("textbox", { name: "What you did" })
    .fill("Workshop sign-in 0042");
  await page.getByRole("button", { name: "Submit activity" }).click();
  await expect(
    page.getByText("This activity was already sent. Check its status instead."),
  ).toBeVisible();
  expect((await counts())["loyalty.activity.submit"]).toBe(1);

  // Reloaded (a new launch): the original operation, read back only.
  await page.reload();
  await expect(page.getByText("Not checked on this page yet.")).toBeVisible();
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(
    page.getByText("Submitted. Waiting for the programme to verify it."),
  ).toBeVisible();
  expect((await counts())["loyalty.activity.submit"]).toBe(1);
  expect(problems).toEqual([]);
});

test("a membership without the member's own pass is not active, and nothing can be submitted", async ({
  page,
}) => {
  await signInTo(page, PAGE);
  await page.getByRole("checkbox", { name: /I agree to these terms/ }).check();
  await page.getByRole("button", { name: "Join the programme" }).click();
  await expect(
    page.getByText("Your request to join is with the programme team."),
  ).toBeVisible();
  await post(runtimeOrigin, "/__test__/approve");
  await post(runtimeOrigin, "/__test__/create", { pass: false });
  await page.reload();
  await expect(
    page.getByText(/its pass isn't in your wallet yet/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);
  // The fixture's record reference and object id are distinct identities.
  expect(RECORD_ID).not.toBe(CANON);
});
