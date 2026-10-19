/**
 * @jest-environment node
 */
// The home route decides only whether the signed-in Today island is mounted;
// what it shows is decided by its own session read and the Tickets BFF.
import { isValidElement, type ReactElement } from "react";
import { resetWalletHostCache } from "@/api/wallet-host";
import { edit } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

jest.mock("next-intl", () => jest.requireActual("@/test/intl-mock").intlMock);
let cookiePresent = false;
jest.mock("next/headers", () => ({
  cookies: async () => ({ has: () => cookiePresent }),
}));
const redirect = jest.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
jest.mock("next/navigation", () => ({
  redirect: (to: string) => redirect(to),
}));

import Home from "@/app/page";

const RULES = {
  fields: {
    event: "event.title",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: { pending: [], issued: ["Issued"], ended: [] },
};

function serve(document: HostDocument | null, rules = true) {
  resetWalletHostCache();
  if (!document) return clearHostEnvironment();
  applyHostEnvironment(
    hostEnvironment(document, {
      PRODUCT_FACE_APPLICATIONS: JSON.stringify([
        rules ? { ...morrowBinding(), tickets: RULES } : morrowBinding(),
      ]),
    }),
  );
}
const ticketsOn = () => {
  const document = morrowDocument();
  edit(document, "journeys.tickets", true);
  return document;
};

async function home() {
  const element = (await Home()) as ReactElement<{
    signedIn: boolean;
    today: ReactElement<{
      children: Array<ReactElement<{ slug: string; href: string }> | null>;
    }> | null;
  }>;
  expect(isValidElement(element)).toBe(true);
  return element.props;
}

afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
  redirect.mockClear();
});

describe("the home route", () => {
  it("mounts no private island for a signed-out visitor", async () => {
    serve(ticketsOn());
    cookiePresent = false;
    expect((await home()).today).toBeNull();
  });

  it("mounts the Today island for the host's own Tickets face when a session cookie is present", async () => {
    serve(ticketsOn());
    cookiePresent = true;
    const { today } = await home();
    // Inside the providers: the island for exactly the configured face, and
    // no membership card on a host without Loyalty.
    const [tickets, loyalty] = today?.props.children ?? [];
    expect(tickets?.props).toEqual({
      slug: "morrow-home",
      href: "/products/morrow-home/tickets",
    });
    expect(loyalty).toBeNull();
  });

  it("is unchanged for a host without Tickets, signed in or out", async () => {
    for (const present of [false, true]) {
      cookiePresent = present;
      serve(morrowDocument(), false);
      expect((await home()).today).toBeNull();
    }
  });

  it("keeps the generic wallet's redirects", async () => {
    serve(null);
    cookiePresent = true;
    await expect(Home()).rejects.toThrow("redirect:/inventory");
    cookiePresent = false;
    await expect(Home()).rejects.toThrow("redirect:/login");
  });
});
