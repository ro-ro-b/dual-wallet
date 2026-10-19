// FICTIONAL ticket-admission-v1 journeys (playwright.tickets-admission.config.ts):
// the real wallet, BFF, journal, native page, executor and /api/backend
// against the local fake api-v3 and a LOCAL FAKE Tickets runtime. Not the
// shared service, not Dual, not a holder: source proof of the wallet's half.
import { expect, test, type Page } from "@playwright/test";
import {
  ADMISSION_TICKET,
  FICTIONAL_ACCOUNTS,
  SLUG,
  admissionFixtureEnvironment,
  // @ts-expect-error -- plain ES module shared with the fixture runner
} from "./tickets-home/environment.mjs";

const { apiOrigin, runtimeOrigin } = admissionFixtureEnvironment();
const DETAIL = `/products/${SLUG}/tickets/${ADMISSION_TICKET}`;

async function post(origin: string, path: string, body: unknown = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
const dualCustom = async () =>
  (
    (await (
      await fetch(`${apiOrigin}/__test__/objects/${ADMISSION_TICKET}`)
    ).json()) as { custom: Record<string, unknown> }
  ).custom;

function watch(page: Page) {
  const problems: string[] = [];
  const executes: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/backend/ebus/execute")
      executes.push(request.url());
  });
  return { problems, executes };
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

async function tabTo(page: Page, name: string) {
  const target = page.getByRole("button", { name });
  for (let step = 0; step < 30; step++) {
    if (
      await target
        .evaluate((element) => element === document.activeElement)
        .catch(() => false)
    )
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

const BIRTH_OPERATION = `op_${"b".repeat(40)}`;
const BIRTH_ACTION = "act-mint-fictional-0001";
const CURRENT = "This is still the ticket's current operation.";
const SUPERSEDED =
  "A later update changed the ticket since it was issued; this is the original issue operation.";

/** Every ticket status badge on the page, in order. */
const badges = (page: Page) => page.locator("main .status");

/** Nothing on the page says the ticket is unissued or unconfirmed. */
async function noContradiction(page: Page) {
  for (const text of ["Not confirmed", "Being issued", "No longer valid"]) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/could not be confirmed/)).toHaveCount(0);
}

/** The pass names exactly the original birth operation and action. */
async function expectBirth(page: Page) {
  const pass = page.locator(".ticket-pass");
  await expect(
    pass.locator("dt", { hasText: "Issue operation" }).locator("+ dd"),
  ).toHaveText(BIRTH_OPERATION);
  await expect(
    pass.locator("dt", { hasText: "Issue action" }).locator("+ dd"),
  ).toHaveText(BIRTH_ACTION);
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

test.beforeEach(async () => {
  await post(apiOrigin, "/__test__/reset");
  await post(runtimeOrigin, "/__test__/reset");
});

test("at phone width, from the keyboard: check, review natively, confirm, and see verified entry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seen = watch(page);
  const { request_id: requestId } = await post(
    runtimeOrigin,
    "/__test__/gate-request",
    { object_id: ADMISSION_TICKET },
  );
  await signInTo(page, DETAIL);
  await expect(
    page.getByRole("heading", { level: 1, name: "Night Market" }),
  ).toBeVisible();
  // The content hash is never shown as the issue reference; no "not available" text.
  await expect(page.getByText("Issue reference")).toHaveCount(0);
  await expect(page.getByText(/Entry check-in is not available/)).toHaveCount(
    0,
  );
  // Before entry, the whole page agrees: issued, the original issue current.
  await expect(badges(page)).toHaveText(["Issued"]);
  await noContradiction(page);
  const before = await dualCustom();
  await page.getByRole("button", { name: "Show entry pass" }).click();
  await expect(page.getByText(CURRENT)).toBeVisible();
  await expectBirth(page);

  await tabTo(page, "Check for entry request");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Gate staff asked to admit you/)).toBeVisible();
  await tabTo(page, "Review entry request");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm your entry" });
  await expect(dialog).toBeVisible();
  for (const fact of [
    "Night Market",
    "Pier Shed (fictional)",
    requestId,
    "This ticket's status changes from Valid to Admitted. Nothing else on the ticket changes.",
  ]) {
    await expect(dialog.getByText(fact, { exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await noHorizontalOverflow(page);
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Confirm entry" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Entry confirmed\. Gate request/)).toBeVisible();
  expect(seen.executes).toHaveLength(1);
  // Exactly the four governed leaves changed on the fictional Dual object.
  const after = await dualCustom();
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  expect(
    Object.keys(after)
      .filter((key) => after[key] !== before[key])
      .sort(),
  ).toEqual(["admissionStatus", "idempotency_key", "operation_id", "state"]);
  expect(after).toEqual(
    expect.objectContaining({
      state: "Admitted",
      admissionStatus: "Admitted",
      activation_hash: "a".repeat(64),
    }),
  );
  expect(after.operation_id).toMatch(/^op_[0-9a-f]{40}$/);
  expect(after.operation_id).not.toBe(BIRTH_OPERATION);

  // After entry, the whole page agrees from fresh facts: the header confirms
  // the verified entry (no stale "Issued", nothing "not confirmed"), and the
  // open pass was read again: superseded, the same original issue.
  await expect(badges(page)).toHaveText(["Entry confirmed"]);
  await expect(
    page.getByText(/The gate confirmed your entry with this ticket/),
  ).toBeVisible();
  await noContradiction(page);
  await expect(page.getByText(SUPERSEDED)).toBeVisible();
  await expect(page.getByText(CURRENT)).toHaveCount(0);
  await expectBirth(page);

  // The home and the list read Dual again: entry recorded, never "not
  // confirmed", and never confirmed by Dual's state alone.
  await page.goto("/");
  const today = page
    .getByRole("region", { name: "Your tickets" })
    .getByRole("region", { name: "Today" });
  await expect(today.getByRole("link")).toHaveAttribute("href", DETAIL);
  await expect(today.getByRole("link")).toContainText("Entry recorded");
  await noContradiction(page);
  await expect(page.getByText("Entry confirmed")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.goto(`/products/${SLUG}/tickets`);
  const card = page.getByRole("link", { name: /Night Market/ });
  await expect(card).toContainText("Entry recorded");
  await noContradiction(page);
  await expect(page.getByText("Entry confirmed")).toHaveCount(0);

  // Reopened: recorded until the holder checks; confirmed again only from the
  // fresh request-bound proof, and the pass still names the original issue.
  await card.click();
  await expect(page).toHaveURL(DETAIL);
  await expect(badges(page)).toHaveText(["Entry recorded"]);
  await expect(
    page.getByText(/Dual records an entry with this ticket\. Check it/),
  ).toBeVisible();
  await noContradiction(page);
  await page.getByRole("button", { name: "Check for entry request" }).click();
  await expect(page.getByText(/Entry confirmed\. Gate request/)).toBeVisible();
  await expect(badges(page)).toHaveText(["Entry confirmed"]);
  await page.getByRole("button", { name: "Show entry pass" }).click();
  await expect(page.getByText(SUPERSEDED)).toBeVisible();
  await expectBirth(page);
  await noContradiction(page);
  await noHorizontalOverflow(page);
  expect(seen.executes).toHaveLength(1);
  expect(seen.problems).toEqual([]);
});

test("a lost verification keeps the original operation: reopened, it is read back, never sent again", async ({
  page,
}) => {
  const seen = watch(page);
  await post(runtimeOrigin, "/__test__/gate-request", {
    object_id: ADMISSION_TICKET,
  });
  await post(runtimeOrigin, "/__test__/mode", { loseVerify: true });
  await signInTo(page, DETAIL);
  await page.getByRole("button", { name: "Check for entry request" }).click();
  await page.getByRole("button", { name: "Review entry request" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm entry" })
    .click();
  await expect(page.getByText(/It will not be sent again/)).toBeVisible();
  expect(seen.executes).toHaveLength(1);
  // Unknown is never entry: the page reads Dual again and says only what it
  // records, with nothing confirmed and nothing "not confirmed".
  await expect(badges(page)).toHaveText(["Entry recorded"]);
  await noContradiction(page);

  // A reopened page is a new launch: it finds the original operation.
  await page.reload();
  await expect(badges(page)).toHaveText(["Entry recorded"]);
  await page.getByRole("button", { name: "Check for entry request" }).click();
  await expect(page.getByText(/It will not be sent again/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review entry request" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Check entry status" }).click();
  await expect(page.getByText(/Entry confirmed\./)).toBeVisible();
  await expect(badges(page)).toHaveText(["Entry confirmed"]);
  await page.getByRole("button", { name: "Show entry pass" }).click();
  await expect(page.getByText(SUPERSEDED)).toBeVisible();
  await expectBirth(page);
  await noContradiction(page);
  expect(seen.executes).toHaveLength(1);
  expect(seen.problems).toEqual([]);
});

test("Escape at the confirmation cancels with zero writes", async ({
  page,
}) => {
  const seen = watch(page);
  await post(runtimeOrigin, "/__test__/gate-request", {
    object_id: ADMISSION_TICKET,
  });
  await signInTo(page, DETAIL);
  await page.getByRole("button", { name: "Check for entry request" }).click();
  await page.getByRole("button", { name: "Review entry request" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Gate staff asked to admit you/)).toBeVisible();
  expect(seen.executes).toHaveLength(0);
  expect((await dualCustom()).state).toBe("Valid");
  await expect(badges(page)).toHaveText(["Issued"]);
});

test("at phone width, the native detail says exactly why a verified ticket can't be used: cancelled, expired, or its entry window closed; never guessed, never usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const seen = watch(page);
  const header = page.locator("main .page-header");
  const entry = page.getByRole("region", { name: "Entry" });
  const noUsableEntry = async () => {
    await expect(
      page.getByRole("button", { name: "Check for entry request" }),
    ).toHaveCount(0);
    await expect(page.getByText(/check for their request/)).toHaveCount(0);
    await expect(page.getByText(/Entry confirmed/)).toHaveCount(0);
    await expect(
      entry.getByRole("button", { name: "Check entry status" }),
    ).toBeVisible();
  };

  // Cancelled, as Dual records it now (a fictional operator change).
  await post(apiOrigin, "/__test__/admission-ticket", { state: "Cancelled" });
  await signInTo(page, DETAIL);
  await expect(badges(page)).toHaveText(["Cancelled"]);
  await expect(header).toContainText(
    "Dual records this ticket as cancelled. It can no longer be used.",
  );
  await expect(page.getByText("No longer valid", { exact: true })).toHaveCount(
    0,
  );
  await noUsableEntry();
  // The ticket itself, and its original issue, stay readable.
  await expect(page.getByText("Night Market").first()).toBeVisible();
  await page.getByRole("button", { name: "Show entry pass" }).click();
  await expectBirth(page);
  await noHorizontalOverflow(page);

  // Expired.
  await post(apiOrigin, "/__test__/admission-ticket", { state: "Expired" });
  await page.reload();
  await expect(badges(page)).toHaveText(["Expired"]);
  await expect(header).toContainText(
    "Dual records this ticket as expired. It can no longer be used.",
  );
  await expect(page.getByText(/cancelled/i)).toHaveCount(0);
  await noUsableEntry();

  // Still Valid, but its verified entry window has passed: the canonical
  // state is unchanged and said so; the closed window is said apart.
  await post(apiOrigin, "/__test__/admission-ticket", {
    state: "Valid",
    windowClosed: true,
  });
  await page.reload();
  await expect(badges(page)).toHaveText(["Issued"]);
  await expect(
    page.getByText(
      /^The entry window for this ticket closed on .+\. Dual still records it as issued, but it can no longer be used to get in\.$/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/expired/i)).toHaveCount(0);
  await noUsableEntry();
  await noHorizontalOverflow(page);

  // A state the rules don't place is not guessed at.
  await post(apiOrigin, "/__test__/admission-ticket", { state: "Suspended" });
  await page.reload();
  await expect(badges(page)).toHaveText(["Not confirmed"]);
  for (const word of [/cancelled/i, /expired/i, /window .* closed/i]) {
    await expect(page.getByText(word)).toHaveCount(0);
  }
  // Nothing was ever written.
  expect(seen.executes).toEqual([]);
  expect((await dualCustom()).state).toBe("Suspended");
  expect(seen.problems).toEqual([]);
});
