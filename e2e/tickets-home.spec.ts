// FICTIONAL branded-host Tickets/Home journeys (playwright.tickets-home.config.ts).
// The real wallet, session BFF, Tickets BFF and parsers against the local fake
// API's made-up ticket objects. Nothing here is Dual, a provider or a holder.
import { expect, test, type Page } from "@playwright/test";
import {
  FICTIONAL_ACCOUNTS,
  fixtureEnvironment,
  SLUG,
  TICKET_IDS,
  // @ts-expect-error -- plain ES module shared with the fixture runner
} from "./tickets-home/environment.mjs";

const { apiOrigin } = fixtureEnvironment();
const LIST = `/products/${SLUG}/tickets`;
const detail = (id: string) => `${LIST}/${id}`;

async function fixture(body: Record<string, unknown>) {
  const response = await fetch(`${apiOrigin}/__test__/tickets`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
}

/**
 * Console errors, uncaught errors, failed responses and every Tickets BFF
 * request on a page. Chromium also logs each 4xx/5xx response as a console
 * error; those are kept apart, by URL, as `failedResponses`.
 */
function watch(page: Page) {
  const problems: string[] = [];
  const ticketReads: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      problems.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const { pathname } = new URL(response.url());
      failedResponses.push(`${response.status()} ${pathname}`);
    }
  });
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith(`/api/faces/${SLUG}/tickets`)) {
      ticketReads.push(pathname);
    }
  });
  return { problems, ticketReads, failedResponses };
}

async function signIn(
  page: Page,
  account: { email: string; password: string } = FICTIONAL_ACCOUNTS.holder,
) {
  // Hydration resets input typed before it; wait for the form to settle.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

const yourTickets = (page: Page) =>
  page.getByRole("region", { name: "Your tickets" });

test.beforeEach(async () => {
  await fixture({ reset: true });
});

test("signed out, the branded home is public and fetches nothing private", async ({
  page,
}) => {
  const seen = watch(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Your Harbour Nights tickets (fictional).",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(yourTickets(page)).toHaveCount(0);
  await expect(page.getByText("Harbour Night", { exact: true })).toHaveCount(0);
  expect(seen.ticketReads).toEqual([]);
  expect(seen.problems).toEqual([]);
  expect(seen.failedResponses).toEqual([]);
});

test("sign in, see Today and Coming up, open the exact ticket from the keyboard, reopen it and go back", async ({
  page,
}) => {
  const seen = watch(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/login");
  await signIn(page);
  // A branded host lands a signed-in visitor on its home.
  await expect(page).toHaveURL("/");

  const tickets = yourTickets(page);
  const today = tickets.getByRole("region", { name: "Today" });
  await expect(today.getByRole("link")).toHaveCount(1);
  const todayLink = today.getByRole("link");
  await expect(todayLink).toHaveAttribute("href", detail(TICKET_IDS.today));
  await expect(todayLink).toContainText("Harbour Night");
  await expect(todayLink).toContainText("Issued");
  // The viewer's zone is named next to the time (Sydney: AEDT/AEST/GMT+11).
  await expect(todayLink).toContainText(/AEDT|AEST|GMT\+1[01]/);

  const coming = tickets.getByRole("region", { name: "Coming up" });
  await expect(coming.getByRole("link")).toHaveCount(2);
  await expect(coming.getByRole("link").nth(0)).toContainText("Lantern Walk");
  await expect(coming.getByRole("link").nth(1)).toContainText("Pier Concert");
  await expect(coming.getByRole("link").nth(1)).toContainText("Being issued");

  const attention = tickets.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("link")).toContainText("Dawn Swim");
  await expect(attention.getByRole("link")).toContainText("Not confirmed");

  // Past tickets are not on the home; other clients' and holders' never are.
  for (const title of [
    "Winter Fair",
    "Other Client Gala",
    "Second Holder Night",
  ]) {
    await expect(page.getByText(title)).toHaveCount(0);
  }
  await expect(
    tickets.getByRole("link", { name: "See all your tickets" }),
  ).toHaveAttribute("href", LIST);

  // Keyboard: Tab to Today's ticket and open it with Enter.
  await page.locator("body").focus();
  for (let step = 0; step < 15; step++) {
    if (await todayLink.evaluate((link) => link === document.activeElement)) {
      break;
    }
    await page.keyboard.press("Tab");
  }
  await expect(todayLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(detail(TICKET_IDS.today));
  await expect(
    page.getByRole("heading", { level: 1, name: "Harbour Night" }),
  ).toBeVisible();
  await expect(page.getByText("fx-issue-0001")).toBeVisible();
  await expect(page.getByText(/Entry check-in is not available/)).toBeVisible();

  // Reopen: the same exact ticket, read afresh.
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Harbour Night" }),
  ).toBeVisible();

  // Back: the home again, with the same Today.
  await page.goto("/");
  await page.goto(detail(TICKET_IDS.comingUp));
  await expect(
    page.getByRole("heading", { level: 1, name: "Lantern Walk" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/");
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }).getByRole("link"),
  ).toContainText("Harbour Night");
  expect(seen.problems).toEqual([]);
  // The only failed response: the signed-out session read on /login.
  expect(seen.failedResponses).toEqual(["401 /api/session"]);
});

test("another holder's or another client's ticket stays refused, even by direct link", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL("/");
  for (const id of [TICKET_IDS.otherClient, TICKET_IDS.otherHolder]) {
    await page.goto(detail(id));
    await expect(
      page.getByText(
        "This ticket isn't held by your account, so it can't be shown here.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  }

  // The second fictional holder, in its own browser context, sees only its
  // own ticket, and none of the first holder's.
  const other = await browser.newContext({ timezoneId: "Australia/Sydney" });
  const second = await other.newPage();
  await second.goto("/login");
  await signIn(second, FICTIONAL_ACCOUNTS.secondHolder);
  await expect(second).toHaveURL("/");
  const coming = yourTickets(second).getByRole("region", { name: "Coming up" });
  await expect(coming.getByRole("link")).toHaveCount(1);
  await expect(coming.getByRole("link")).toContainText("Second Holder Night");
  await expect(second.getByText("Harbour Night", { exact: true })).toHaveCount(
    0,
  );
  await second.goto(detail(TICKET_IDS.today));
  await expect(
    second.getByText(
      "This ticket isn't held by your account, so it can't be shown here.",
    ),
  ).toBeVisible();
  await other.close();
});

test("at phone width the home and the ticket fit, with no horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const seen = watch(page);
  await page.goto("/login");
  await signIn(page);
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await yourTickets(page)
    .getByRole("region", { name: "Today" })
    .getByRole("link")
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Harbour Night" }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  expect(seen.problems).toEqual([]);
  expect(seen.failedResponses).toEqual(["401 /api/session"]);
});

test("empty-with-more and unavailable reads are never shown as no tickets", async ({
  page,
}) => {
  await page.goto("/login");
  await signIn(page);
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }),
  ).toBeVisible();

  await fixture({ mode: "emptyWithMore" });
  await page.reload();
  await expect(
    yourTickets(page).getByText(/No tickets found yet/),
  ).toBeVisible();
  await expect(page.getByText("No tickets in this account.")).toHaveCount(0);

  await fixture({ mode: "unavailable" });
  await page.reload();
  const alert = yourTickets(page).getByRole("alert");
  await expect(alert).toContainText("couldn't read your tickets");
  await expect(page.getByText("No tickets in this account.")).toHaveCount(0);
  await expect(page.getByText("Harbour Night", { exact: true })).toHaveCount(0);

  // Recovered upstream: the customer's own Try again reads again.
  await fixture({ mode: "normal" });
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }),
  ).toBeVisible();
});

test("an expired or invalid session shows no tickets and signs in back to the home", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await signIn(page);
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }),
  ).toBeVisible();

  // The upstream session ends (refresh refused): nothing private remains.
  await fixture({ expireSessions: true });
  await page.reload();
  await expect(page.getByText("Sign in to see your tickets.")).toBeVisible();
  await expect(page.getByText("Harbour Night", { exact: true })).toHaveCount(0);

  // Ordinary sign-in returns to the home with the tickets again.
  await yourTickets(page).getByRole("link", { name: "Sign in" }).click();
  await signIn(page);
  await expect(page).toHaveURL("/");
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }).getByRole("link"),
  ).toContainText("Harbour Night");

  // A forged session cookie is presentation only: no private read happens.
  await context.clearCookies();
  await context.addCookies([
    {
      name: "smarttoken_viewer",
      value: "not-a-real-session",
      url: new URL(page.url()).origin,
    },
  ]);
  const seen = watch(page);
  await page.reload();
  await expect(page.getByText("Sign in to see your tickets.")).toBeVisible();
  expect(seen.ticketReads).toEqual([]);
});

test("signing out clears the private tickets", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await expect(
    yourTickets(page).getByRole("region", { name: "Today" }),
  ).toBeVisible();
  // Sign out from the wallet shell (the Tickets list page).
  await page.goto(LIST);
  await expect(page.getByRole("link", { name: /Harbour Night/ })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/login");
  const seen = watch(page);
  await page.goto("/");
  await expect(yourTickets(page)).toHaveCount(0);
  await expect(page.getByText("Harbour Night", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(seen.ticketReads).toEqual([]);
});
