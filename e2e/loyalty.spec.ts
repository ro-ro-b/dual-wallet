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
const WAITING_FOR_VERIFICATION =
  "Waiting for the programme to verify your last activity. You can record another once it's verified.";
const PAGE = `/products/${LOYALTY_SLUG}/loyalty`;
// Set by playwright.loyalty-studio.config.ts: the runtime is Studio's real
// Loyalty member leg on a client Loyalty service, whose staff act only under
// the client's own grants and never create a membership without its pass.
const STUDIO_INTEGRATED = process.env.LOYALTY_FIXTURE_STUDIO_INTEGRATED === "1";

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
    page.getByText(
      "Approved. The programme team still needs to create your membership. You can record activities once it's created.",
    ),
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
    page.getByText(/may have been sent, but its outcome isn't confirmed yet/),
  ).toBeVisible();
  // The runtime wrote it: no new activity is offered until it is verified
  // (the BFF also refuses the same evidence while it is unresolved).
  await expect(page.getByText(WAITING_FOR_VERIFICATION)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);
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

const received = async () =>
  (await post(runtimeOrigin, "/__test__/received")) as Array<{
    operation: string;
    operationId: string;
  }>;
const idsOf = (
  list: Array<{ operation: string; operationId: string }>,
  operation: string,
) =>
  list
    .filter((item) => item.operation === operation)
    .map((item) => item.operationId);

test("a wallet answer lost whole after the write (Set-Cookie included): the old cookies still find the original operation, read back only", async ({
  page,
  context,
}) => {
  const problems = watch(page);
  await activeMember(page);
  const loyaltyRoute = `**/api/faces/${LOYALTY_SLUG}/loyalty`;
  let jarAsSent: Awaited<ReturnType<typeof context.cookies>> | undefined;
  await page.route(loyaltyRoute, async (route) => {
    const body = route.request().postDataJSON() as { transition?: string };
    if (body?.transition !== "submit") return route.continue();
    // The browser's cookie jar exactly as this request left it.
    jarAsSent = await context.cookies();
    // The wallet BFF runs it to the end (the runtime writes once)...
    await route.fetch();
    // ...and its ENTIRE answer, Set-Cookie included, never reaches the browser.
    await route.abort("connectionreset");
  });
  await page
    .getByRole("textbox", { name: "What you did" })
    .fill("Workshop sign-in 0042");
  await page.getByRole("button", { name: "Submit activity" }).click();
  await expect
    .poll(async () => (await counts())["loyalty.activity.submit"])
    .toBe(1);
  const [original] = idsOf(await received(), "loyalty.activity.submit");
  // Shown at once as sent with an unknown outcome, never "nothing recorded".
  await expect
    .soft(
      page.getByText(/may have been sent, but its outcome isn't confirmed yet/),
    )
    .toBeVisible();
  await expect.soft(page.getByText(/Nothing new was recorded/)).toHaveCount(0);

  // Reloaded with exactly the cookies the browser had: nothing of the lost
  // answer survives, whatever route.fetch did with its Set-Cookie.
  await page.unroute(loyaltyRoute);
  expect(jarAsSent).toBeDefined();
  await context.clearCookies();
  await context.addCookies(jarAsSent!);
  await page.reload();
  // The original operation is found, and only ever read back; nothing new
  // is offered while it waits for verification.
  await expect(page.getByText("Not checked on this page yet.")).toBeVisible();
  await expect(page.getByText(WAITING_FOR_VERIFICATION)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Check status" }).click();
  await expect(
    page.getByText("Submitted. Waiting for the programme to verify it."),
  ).toBeVisible();
  const after = await received();
  // One write, under its original id; every status read named that same id.
  expect(idsOf(after, "loyalty.activity.submit")).toEqual([original]);
  expect(idsOf(after, "loyalty.activity.status")).toEqual([original]);
  expect(problems).toEqual([]);
});

test("a double click prepares once and sends that one operation once", async ({
  page,
}) => {
  const problems = watch(page);
  await activeMember(page);
  const steps: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/faces/${LOYALTY_SLUG}/loyalty`)) {
      const body = request.postDataJSON() as { transition?: string };
      if (body?.transition === "prepare" || body?.transition === "submit") {
        steps.push(body.transition);
      }
    }
  });
  await page
    .getByRole("textbox", { name: "What you did" })
    .fill("Workshop sign-in 0042");
  await page.getByRole("button", { name: "Submit activity" }).dblclick();
  await expect(
    page.getByText("Submitted. Waiting for the programme to verify it."),
  ).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  expect(steps).toEqual(["prepare", "submit"]);
  expect(idsOf(await received(), "loyalty.activity.submit")).toHaveLength(1);
  expect(problems).toEqual([]);
});

test("at phone width, from the keyboard: the membership page, the brand's Home link, the membership card, back again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  await activeMember(page);
  // The one Home control on a phone: the mobile top bar's mark and name.
  const home = page.getByRole("link", { name: "Harbour Nights home" });
  await expect(home).toHaveCount(1);
  await expect(home).toHaveAttribute("href", "/");
  await page.locator("body").focus();
  await tabTo(page, home);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  const card = page.getByRole("region", { name: "Your membership" });
  await expect(card.getByText("You're a member.")).toBeVisible();
  const open = card.getByRole("link", { name: "Open your membership" });
  await page.locator("body").focus();
  await tabTo(page, open);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(PAGE);
  await expect(page.getByText("You're a member.")).toBeVisible();
  await noHorizontalOverflow(page);
  expect(problems).toEqual([]);
});

test("approved but not yet created: the programme team still has to create it, and nothing can be submitted", async ({
  page,
}) => {
  await signInTo(page, PAGE);
  await page.getByRole("checkbox", { name: /I agree to these terms/ }).check();
  await page.getByRole("button", { name: "Join the programme" }).click();
  await expect(
    page.getByText("Your request to join is with the programme team."),
  ).toBeVisible();
  await post(runtimeOrigin, "/__test__/approve");
  await page.reload();
  await expect(
    page.getByText(/The programme team still needs to create your membership/),
  ).toBeVisible();
  await expect(page.getByText(/being created/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);
  // The home's card says the same, and offers nothing more.
  await page.goto("/");
  const card = page.getByRole("region", { name: "Your membership" });
  await expect(
    card.getByText(/The programme team still needs to create your membership/),
  ).toBeVisible();
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
  if (STUDIO_INTEGRATED) {
    // Studio's client Loyalty service refuses the passless birth itself: its
    // setup delegation is no client staff (only a step under the client's own
    // staff grant creates a membership, with the member's pass). Nothing is
    // written, so the member still waits for the programme team.
    const refused = await fetch(`${runtimeOrigin}/__test__/create`, {
      method: "POST",
      body: JSON.stringify({ pass: false }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).status).toBe(
      "loyalty_client_staff_authority_required",
    );
    await page.reload();
    await expect(
      page.getByText(
        /The programme team still needs to create your membership/,
      ),
    ).toBeVisible();
  } else {
    await post(runtimeOrigin, "/__test__/create", { pass: false });
    await page.reload();
    await expect(
      page.getByText(/its pass isn't in your wallet yet/),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);
  // The fixture's record reference and object id are distinct identities.
  expect(RECORD_ID).not.toBe(CANON);
});

/** Two verified workshops, submitted from the page and verified by staff. */
async function twoVerifiedActivities(page: Page) {
  for (const evidence of ["Workshop sign-in 0101", "Workshop sign-in 0102"]) {
    await page.getByRole("textbox", { name: "What you did" }).fill(evidence);
    await page.getByRole("button", { name: "Submit activity" }).click();
    await expect(page.getByText(WAITING_FOR_VERIFICATION)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await post(runtimeOrigin, "/__test__/verify");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Submit activity" }),
    ).toBeVisible();
  }
}

test("at phone width, from the keyboard: a granted reward, one request lost whole, the one-time reference, the partner's recorded confirmation, settlement and a fresh reopen", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watch(page);
  await activeMember(page);
  await twoVerifiedActivities(page);
  const benefit = page
    .getByRole("listitem")
    .filter({ hasText: "A studio hour (fictional)" });
  // Verified eligibility, availability and the next actor, each distinct.
  await expect(
    benefit.getByText("You've earned this. The programme team grants it."),
  ).toBeVisible();
  await expect(
    benefit.getByText("Available now (programme record)."),
  ).toBeVisible();
  await expect(page.getByText("Next: the programme team.")).toBeVisible();
  await expect(page.getByText(/2 of 2 verified/)).toBeVisible();

  // The programme operator grants it, in its own session.
  await post(runtimeOrigin, "/__test__/grant");
  await page.reload();
  const reward = page.getByRole("region", { name: "Your reward" });
  await expect(
    reward.getByText("Granted to you. Request it when you're ready."),
  ).toBeVisible();
  // Nothing that would strand it: no new activity is offered.
  await expect(
    page.getByRole("button", { name: "Submit activity" }),
  ).toHaveCount(0);

  // The member's one request; its whole answer (Set-Cookie too) is lost.
  const loyaltyRoute = `**/api/faces/${LOYALTY_SLUG}/loyalty`;
  let jarAsSent: Awaited<ReturnType<typeof context.cookies>> | undefined;
  await page.route(loyaltyRoute, async (route) => {
    const body = route.request().postDataJSON() as { transition?: string };
    if (body?.transition !== "redeem_submit") return route.continue();
    jarAsSent = await context.cookies();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.locator("body").focus();
  await tabTo(page, reward.getByRole("button", { name: "Request redemption" }));
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await counts())["loyalty.redemption.request"])
    .toBe(1);
  const [original] = idsOf(await received(), "loyalty.redemption.request");
  await expect(
    page.getByText(/may have been sent, but its outcome isn't confirmed yet/),
  ).toBeVisible();
  await page.unroute(loyaltyRoute);
  await context.clearCookies();
  await context.addCookies(jarAsSent!);
  await page.reload();
  const requests = page.getByRole("region", {
    name: "Redemption requests from this wallet",
  });
  await expect(
    requests.getByText("Not checked on this page yet."),
  ).toBeVisible();
  await expect(
    reward.getByText("Requested. Show your one-time reference to the partner."),
  ).toBeVisible();
  await expect(
    page.getByText("Next: the partner confirms your redemption."),
  ).toBeVisible();
  await expect(
    reward.getByRole("button", { name: "Request redemption" }),
  ).toHaveCount(0);
  await requests.getByRole("button", { name: "Check status" }).click();
  await expect(requests.getByText("Requested.")).toBeVisible();

  // The reference, only on the member's own action, from the keyboard.
  await page.locator("body").focus();
  await tabTo(
    page,
    reward.getByRole("button", { name: "Show my one-time reference" }),
  );
  await page.keyboard.press("Enter");
  const shown = page.getByRole("region", { name: "Your one-time reference" });
  await expect(shown).toBeVisible();
  const code = (
    await shown.locator(".loyalty-reference-code").innerText()
  ).trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  await noHorizontalOverflow(page);
  // Never in a URL, a cookie or browser storage.
  expect(page.url()).not.toContain(code);
  expect(JSON.stringify(await context.cookies())).not.toContain(code);
  expect(
    await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    ),
  ).not.toContain(code);

  // The partner, in its own session: a wrong reference changes nothing;
  // the member's reference confirms once; reused, it is refused.
  const confirm = (reference: string) =>
    fetch(`${runtimeOrigin}/__test__/partner/confirm`, {
      method: "POST",
      body: JSON.stringify({ reference }),
    });
  expect((await confirm("AAAA-AAAA")).status).toBe(409);
  expect((await confirm(code)).status).toBe(200);
  expect((await confirm(code)).status).toBe(409);
  await page.reload();
  await expect(
    reward.getByText("The partner recorded your redemption."),
  ).toBeVisible();
  await expect(reward.getByText(/doesn't track delivery/)).toBeVisible();
  await expect(
    reward.getByRole("button", { name: "Show my one-time reference" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Next: the programme records the partner settlement."),
  ).toBeVisible();

  // Settlement recorded; a fresh reopen shows the same outcome.
  await post(runtimeOrigin, "/__test__/settle");
  await page.goto("/");
  const card = page.getByRole("region", { name: "Your membership" });
  await expect(
    card.getByText(
      "A studio hour (fictional): Redeemed, and the programme recorded the partner settlement.",
    ),
  ).toBeVisible();
  await expect(card.getByText(code)).toHaveCount(0);
  await page.goto(PAGE);
  await expect(
    reward.getByText(
      "Redeemed, and the programme recorded the partner settlement.",
    ),
  ).toBeVisible();
  await expect(reward.getByText(/isn't a payment to you/)).toBeVisible();
  // Nothing invented: no points, tier or balance anywhere.
  await expect(page.getByText(/points|tier|balance/i)).toHaveCount(0);
  const after = await received();
  // One request, under its original id; every status read named that id.
  expect(idsOf(after, "loyalty.redemption.request")).toEqual([original]);
  expect(
    idsOf(after, "loyalty.redemption.status").every((id) => id === original),
  ).toBe(true);
  await noHorizontalOverflow(page);
  expect(problems).toEqual([]);
});
