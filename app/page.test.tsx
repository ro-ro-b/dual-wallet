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

import { HostHomeAccount } from "@/app/_components/host/host-home-account";
import Home from "@/app/page";
import { Providers } from "@/app/_providers/providers";

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

type Island = ReactElement<{ slug: string; href: string }> | null;
interface HomeProps {
  account?: ReactElement<{ navigation: unknown }>;
  today?: ReactElement<{ children: Island[] }> | null;
}

/** The home element, and whether one provider tree wraps the whole of it. */
async function home() {
  const element = (await Home()) as ReactElement<{
    children?: ReactElement<HomeProps>;
  }>;
  expect(isValidElement(element)).toBe(true);
  const providers = element.type === Providers;
  const page = (
    providers ? element.props.children : element
  ) as ReactElement<HomeProps>;
  return { providers, ...page.props };
}

afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
  redirect.mockClear();
});

describe("the home route", () => {
  it("is the public home for a visitor without a session cookie: no island, no provider", async () => {
    serve(ticketsOn());
    cookiePresent = false;
    const props = await home();
    expect(props.providers).toBe(false);
    expect(props.account).toBeUndefined();
    expect(props.today).toBeUndefined();
  });

  it("with a session cookie, mounts the header's account island and the Today island in one provider tree", async () => {
    serve(ticketsOn());
    cookiePresent = true;
    const { providers, account, today } = await home();
    expect(providers).toBe(true);
    // The island gets the host's own navigation; identity is its own read.
    expect(account?.type).toBe(HostHomeAccount);
    expect(account?.props).toEqual({
      navigation: [
        { entry: "inventory", href: "/inventory" },
        { entry: "products", href: "/products" },
        { entry: "activity", href: "/activity" },
        { entry: "settings", href: "/settings" },
      ],
    });
    // Today for exactly the configured face, and no membership card on a
    // host without Loyalty.
    const [tickets, loyalty] = today?.props.children ?? [];
    expect(tickets?.props).toEqual({
      slug: "morrow-home",
      href: "/products/morrow-home/tickets",
    });
    expect(loyalty).toBeNull();
  });

  it("a host without Tickets mounts no Today island, signed in or out; signed in, still the account island", async () => {
    serve(morrowDocument(), false);
    cookiePresent = false;
    expect((await home()).today).toBeUndefined();
    cookiePresent = true;
    const signedIn = await home();
    expect(signedIn.today).toBeNull();
    expect(signedIn.account?.type).toBe(HostHomeAccount);
  });

  it("keeps the generic wallet's redirects", async () => {
    serve(null);
    cookiePresent = true;
    await expect(Home()).rejects.toThrow("redirect:/inventory");
    cookiePresent = false;
    await expect(Home()).rejects.toThrow("redirect:/login");
  });
});
