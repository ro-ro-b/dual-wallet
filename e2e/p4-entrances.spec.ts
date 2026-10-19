// FICTIONAL P4 native entrances (playwright.p4-entrances.config.ts): the real
// wallet as a branded host with Tickets AND Loyalty on two of its own faces,
// both bound to one LOCAL FAKE backend behind (fake) Vercel Authentication
// that refuses every request without this run's fictional workload token.
// The Tickets face is the exact pinned artifact Studio H2 emitted. Not Dual,
// Vercel, Studio or a member: source proof of the wallet's half.
import { expect, test, type Page } from "@playwright/test";
import {
  FICTIONAL_ACCOUNTS,
  TICKET_IDS,
  // @ts-expect-error -- plain ES module shared with the fixture runner
} from "./tickets-home/environment.mjs";
import {
  FOREIGN_SLUG,
  LOYALTY_SLUG,
  p4FixtureEnvironment,
  TICKET_FACE_PATH,
  TICKETS_SLUG,
  // @ts-expect-error -- plain ES module shared with the fixture runner
} from "./p4-entrances/environment.mjs";

const env = p4FixtureEnvironment();
const runtimeOrigin = `http://localhost:${env.runtime.FAKE_LOYALTY_RUNTIME_PORT}`;
const TICKETS = `/products/${TICKETS_SLUG}/tickets`;
const MEMBERSHIP = `/products/${LOYALTY_SLUG}/loyalty`;
const UNAVAILABLE = /unavailable right now|could not be verified/;
/** The holder's own Today ticket, read through the Tickets BFF. */
const TODAY = `${TICKETS}/${TICKET_IDS.today}`;

interface BackendRequest {
  method: string;
  path: string;
  authenticated: boolean;
  token: "missing" | "wrong" | "this run's";
  browser: boolean;
}

async function post(origin: string, path: string, body: unknown = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
const backendRequests = async () =>
  (await (
    await fetch(`${env.controlOrigin}/__test__/requests`)
  ).json()) as BackendRequest[];

/**
 * Everything the browser sent or was sent, for the token-leak and
 * protected-backend checks, and console or page errors (Chromium's own
 * "Failed to load resource" lines for 404 pages are not errors here).
 */
function watch(page: Page) {
  const problems: string[] = [];
  const seen: string[] = [];
  const backend: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", async (request) => {
    if (new URL(request.url()).origin === env.backendOrigin) {
      backend.push(request.url());
    }
    seen.push(request.url(), request.postData() ?? "");
    try {
      seen.push(JSON.stringify(await request.allHeaders()));
    } catch {
      // The page closed first.
    }
  });
  page.on("response", async (response) => {
    try {
      seen.push(JSON.stringify(await response.allHeaders()));
      seen.push(await response.text());
    } catch {
      // A redirect, a body the browser did not keep, or the page closed.
    }
  });
  return { problems, seen, backend };
}

async function signIn(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email address").fill(FICTIONAL_ACCOUNTS.holder.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(FICTIONAL_ACCOUNTS.holder.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signInTo(page: Page, path: string, landing = path) {
  await page.goto(path);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
  await signIn(page);
  await expect(page).toHaveURL(landing);
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

/** A native entrance page: no frame, nothing unavailable, its own links. */
async function expectNative(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText(UNAVAILABLE)).toHaveCount(0);
}

/** Nothing reached the protected backend without this run's token. */
async function backendSawOnlyTheWallet() {
  const requests = await backendRequests();
  expect(requests.filter((item) => !item.authenticated)).toEqual([]);
  expect(requests.filter((item) => item.browser)).toEqual([]);
  // A native-only face is never read: no artifact request at all.
  expect(requests.filter((item) => item.path.startsWith("/face/"))).toEqual([]);
  return requests;
}

async function noTokenInTheBrowser(page: Page, seen: string[]) {
  const stored = await page.evaluate(() =>
    JSON.stringify({
      cookie: document.cookie,
      local: { ...localStorage },
      session: { ...sessionStorage },
      html: document.documentElement.outerHTML,
    }),
  );
  const cookies = JSON.stringify(await page.context().cookies());
  for (const text of [...seen, stored, cookies]) {
    expect(text.includes(env.token)).toBe(false);
    expect(text.includes(env.token.split(".")[1])).toBe(false);
    expect(text.includes("x-vercel-trusted-oidc-idp-token")).toBe(false);
  }
}

test.beforeEach(async () => {
  await post(env.apiOrigin, "/__test__/reset");
  await post(runtimeOrigin, "/__test__/reset");
  await fetch(`${env.controlOrigin}/__test__/reset`);
});

/** One GET to the protected backend, trusting this run's certificate. */
async function backendGet(path: string, token?: string) {
  const https = await import("node:https");
  const { readFileSync } = await import("node:fs");
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    https
      .get(
        `${env.backendOrigin}${path}`,
        {
          ca: readFileSync(env.backend.P4_BACKEND_CERT),
          headers: token ? { "x-vercel-trusted-oidc-idp-token": token } : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks),
            }),
          );
        },
      )
      .on("error", reject);
  });
}

test("the protected backend holds the exact H2 face, and refuses anything without the deployment's token", async () => {
  // The fixture's own premise, from outside the wallet: the pinned face is
  // there, byte for byte, yet no read without the token ever succeeds.
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const committed = (name: string) =>
    readFileSync(
      `${process.cwd()}/e2e/fixtures/p4-ticket-face/${TICKET_FACE_PATH.slice(6)}${name}`,
    );
  const manifest = JSON.parse(committed("manifest.json").toString("utf8"));
  for (const name of ["manifest.json", "index.html"]) {
    const path = `${TICKET_FACE_PATH}${name}`;
    expect((await backendGet(path)).status).toBe(401);
    expect((await backendGet(path, `${env.token}x`)).status).toBe(401);
    const served = await backendGet(path, env.token);
    expect(served.status).toBe(200);
    expect(served.body.equals(committed(name))).toBe(true);
  }
  expect(manifest.artifactHash).toBe(
    `sha256:${TICKET_FACE_PATH.split("/")[4]}`,
  );
  expect(manifest.walletOrigins).toEqual([env.origin]);
  expect(
    `sha256:${createHash("sha256").update(committed("index.html")).digest("hex")}`,
  ).toBe(manifest.files["index.html"]);
  const requests = await backendRequests();
  expect(requests.map((item) => item.token)).toEqual([
    "missing",
    "wrong",
    "this run's",
    "missing",
    "wrong",
    "this run's",
  ]);
});

test("each product entrance, help and ended route is native, signs in back to itself and never meets the protected frame", async ({
  page,
}) => {
  const { problems, seen, backend } = watch(page);

  // Signed out, the help route signs in and returns to exactly itself.
  await signInTo(page, `/products/${TICKETS_SLUG}/support`);
  await expectNative(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Help" }),
  ).toBeVisible();
  await expect(
    page.getByText("A fictional event brand for the local Tickets fixture."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Your Harbour Nights (fictional) tickets are kept in this wallet, not on this page.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open your tickets" }),
  ).toHaveAttribute("href", TICKETS);
  await expect(
    page.getByRole("link", { name: "Back to Harbour Nights home" }),
  ).toHaveAttribute("href", "/");

  // The ordinary product entrance (and its /home task) is the native journey.
  for (const path of [
    `/products/${TICKETS_SLUG}`,
    `/products/${TICKETS_SLUG}/home`,
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(TICKETS);
    await expectNative(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Your tickets" }),
    ).toBeVisible();
  }
  for (const path of [
    `/products/${LOYALTY_SLUG}`,
    `/products/${LOYALTY_SLUG}/home`,
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(MEMBERSHIP);
    await expectNative(page);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Harbour Makers Circle (fictional)",
      }),
    ).toBeVisible();
  }

  // Help and the end state of the Loyalty face; the end state of Tickets.
  await page.goto(`/products/${LOYALTY_SLUG}/support`);
  await expectNative(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Help" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open your membership" }),
  ).toHaveAttribute("href", MEMBERSHIP);
  for (const [slug, link, href] of [
    [LOYALTY_SLUG, "Open your membership", MEMBERSHIP],
    [TICKETS_SLUG, "Open your tickets", TICKETS],
  ]) {
    await page.goto(`/products/${slug}/ended`);
    await expectNative(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "This page has closed" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: link })).toHaveAttribute(
      "href",
      href,
    );
  }
  // A deeper path under a no-journey task goes back to the entrance.
  await page.goto(`/products/${TICKETS_SLUG}/support/more`);
  await expect(page).toHaveURL(TICKETS);

  expect(backend).toEqual([]);
  await backendSawOnlyTheWallet();
  await noTokenInTheBrowser(page, seen);
  expect(problems).toEqual([]);
});

test("canonical native data still comes through the real BFF and assertions, the runtime reached only server-side with the workload token", async ({
  page,
}) => {
  const { problems, seen, backend } = watch(page);
  await signInTo(page, MEMBERSHIP);
  await page.getByRole("checkbox", { name: /I agree to these terms/ }).check();
  await page.getByRole("button", { name: "Join the programme" }).click();
  await expect(
    page.getByText("Your request to join is with the programme team."),
  ).toBeVisible();
  await post(runtimeOrigin, "/__test__/approve");
  await post(runtimeOrigin, "/__test__/create");
  await page.reload();
  await expect(page.getByText("You're a member.")).toBeVisible();

  // Tickets: the holder's own objects through the Tickets BFF.
  await page.goto(TICKETS);
  await expect(page.locator(`a[href="${TODAY}"]`)).toContainText(
    "Harbour Night",
  );

  // The Home's native cards name each journey's own face, never another's.
  await page.goto("/");
  await expect(
    page
      .getByRole("region", { name: "Your membership" })
      .getByRole("link", { name: "Open your membership" }),
  ).toHaveAttribute("href", MEMBERSHIP);

  const requests = await backendSawOnlyTheWallet();
  const operations = requests.filter(
    (item) => item.path === "/api/product-face/v1/operations",
  );
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.every((item) => item.token === "this run's")).toBe(true);
  expect(backend).toEqual([]);
  await noTokenInTheBrowser(page, seen);
  expect(problems).toEqual([]);
});

test("disabled journeys and another client's face are refused, with no fallback to another face", async ({
  page,
}) => {
  const { problems, backend } = watch(page);
  await signInTo(page, TICKETS);
  const notFound = async (path: string) => {
    const response = await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    return response?.status();
  };
  // Refused by the host before any page: framed journeys it does not serve,
  // and every route of another client's face, native or not.
  for (const path of [
    `/products/${TICKETS_SLUG}/register`,
    `/products/${TICKETS_SLUG}/products`,
    `/products/${TICKETS_SLUG}/service`,
    `/products/${TICKETS_SLUG}/accept`,
    "/products",
    `/products/${FOREIGN_SLUG}`,
    `/products/${FOREIGN_SLUG}/support`,
    `/products/${FOREIGN_SLUG}/ended`,
    `/products/${FOREIGN_SLUG}/tickets`,
  ]) {
    expect(await notFound(path), path).toBe(404);
  }
  // A native journey the face does not carry: the page's own not-found
  // (streamed under the signed-in layout, as every native page's is).
  for (const path of [
    `/products/${TICKETS_SLUG}/loyalty`,
    `/products/${LOYALTY_SLUG}/tickets`,
  ]) {
    await notFound(path);
  }
  for (const route of ["tickets", "context"]) {
    const answer = await page.request.get(
      `/api/faces/${FOREIGN_SLUG}/${route}`,
    );
    expect(answer.status()).toBe(404);
    expect((await answer.json()).code).toBe("unknown_application");
  }
  // Every product link on the Home names one of this host's own faces.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const hrefs = await page
    .locator('a[href^="/products/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href?.startsWith(TICKETS) || href === MEMBERSHIP, String(href)).toBe(
      true,
    );
  }
  expect(backend).toEqual([]);
  await backendSawOnlyTheWallet();
  expect(problems).toEqual([]);
});

test("at phone width, from the keyboard: the end state, the native tickets, the brand's Home link, the membership", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { problems, backend } = watch(page);
  await signInTo(page, `/products/${TICKETS_SLUG}/ended`);
  await expectNative(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "This page has closed" }),
  ).toBeVisible();
  await noHorizontalOverflow(page);

  await tabTo(page, page.getByRole("link", { name: "Open your tickets" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(TICKETS);
  await expect(
    page.getByRole("heading", { level: 1, name: "Your tickets" }),
  ).toBeVisible();
  await noHorizontalOverflow(page);

  await tabTo(page, page.getByRole("link", { name: "Harbour Nights home" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  const card = page.getByRole("region", { name: "Your membership" });
  await expect(card).toBeVisible();
  await tabTo(page, card.getByRole("link").first());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(MEMBERSHIP);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Harbour Makers Circle (fictional)",
    }),
  ).toBeVisible();
  await noHorizontalOverflow(page);

  // And back to help, then from it to the Home, from the keyboard.
  await page.goto(`/products/${LOYALTY_SLUG}/support`);
  await expectNative(page);
  await noHorizontalOverflow(page);
  await tabTo(
    page,
    page.getByRole("link", { name: "Back to Harbour Nights home" }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  expect(backend).toEqual([]);
  await backendSawOnlyTheWallet();
  expect(problems).toEqual([]);
});

test("a fresh reopen lands on the same native pages, read afresh, with no frame", async ({
  context,
  page,
}) => {
  await signInTo(page, `/products/${LOYALTY_SLUG}/support`);
  await expectNative(page);
  await page.close();

  // The wallet reopened in a new tab of the same browser session.
  const reopened = await context.newPage();
  const { problems, seen, backend } = watch(reopened);
  const ticketReads: string[] = [];
  reopened.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith(`/api/faces/${TICKETS_SLUG}/tickets`)) {
      ticketReads.push(pathname);
    }
  });
  await reopened.goto(`/products/${LOYALTY_SLUG}/support`);
  await expectNative(reopened);
  await expect(
    reopened.getByRole("heading", { level: 1, name: "Help" }),
  ).toBeVisible();
  await reopened.goto(`/products/${TICKETS_SLUG}`);
  await expect(reopened).toHaveURL(TICKETS);
  await expect(reopened.locator(`a[href="${TODAY}"]`)).toContainText(
    "Harbour Night",
  );
  expect(ticketReads.length).toBeGreaterThan(0);
  await reopened.reload();
  await expectNative(reopened);
  await expect(
    reopened.getByRole("heading", { level: 1, name: "Your tickets" }),
  ).toBeVisible();
  expect(backend).toEqual([]);
  await backendSawOnlyTheWallet();
  await noTokenInTheBrowser(reopened, seen);
  expect(problems).toEqual([]);
});
