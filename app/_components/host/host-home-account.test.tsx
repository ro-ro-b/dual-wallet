import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostHomeAccount } from "@/app/_components/host/host-home-account";
import { LoyaltyTodaySection } from "@/app/_components/host/loyalty-today";
import { TicketsTodaySection } from "@/app/_components/host/tickets-today";
import type { ViewerWallet } from "@/app/_domain/wallet";
import {
  SessionProvider,
  sessionQueryKey,
} from "@/app/_providers/session-provider";

// The signed-in branded home's header (FICTIONAL wallets): the verified
// account and sign-out, from the real SessionProvider and its session read.

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
  };
});
const refresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: jest.fn(), push: jest.fn() }),
}));

const SLUG = "harbour-nights";
const NAVIGATION = [
  { entry: "inventory", href: "/inventory" },
  { entry: "settings", href: "/settings" },
] as const;

const walletOf = (id: string, email: string) =>
  ({
    id,
    nickname: `Holder ${id}`,
    email,
    language: "en",
    fqdn: "wallet.example",
    activated: true,
    emailVerified: true,
    disabled: false,
    account: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      type: "SMART_WALLET",
    },
    controller: { address: "0xc0", type: "SECP256K1" },
    smartAccount: {},
    hasPasskey: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    modifiedAt: "2026-10-01T00:00:00.000Z",
  }) as unknown as ViewerWallet;

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const signedIn = (id: string, email: string) =>
  ok({
    authenticated: true,
    authenticationMethod: "email",
    wallet: walletOf(id, email),
  });
let session: () => Promise<Reply>;
let signOut: () => Promise<Reply>;
let tickets: Reply;
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  const reply =
    url === "/api/session"
      ? await session()
      : url === "/api/session/logout" && init?.method === "POST"
        ? await signOut()
        : url.startsWith(`/api/faces/${SLUG}/tickets`)
          ? tickets
          : { status: 404, body: {} };
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
  };
});
const calls = (prefix: string) =>
  fetchMock.mock.calls.filter(([url]) => url.startsWith(prefix));

beforeEach(() => {
  fetchMock.mockClear();
  refresh.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  session = async () => signedIn("wallet-a", "a@example.com");
  signOut = async () => ok({ ok: true });
  tickets = ok({
    tickets: [
      {
        objectId: "a".repeat(24),
        templateId: "b".repeat(24),
        clientId: "c".repeat(24),
        holder: "0x1234567890abcdef1234567890abcdef12345678",
        issueOperationId: "issue-op-0001",
        status: "issued",
        name: "Entry",
        entryClass: null,
        entryGuidance: null,
        admission: "unavailable",
        modifiedAt: "2026-10-01T00:00:00.000Z",
        event: {
          title: "Account A's event",
          startsAt: new Date().toISOString(),
          venue: null,
        },
      },
    ],
    next: null,
  });
});

function home({ today = false } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <header>
          <HostHomeAccount navigation={[...NAVIGATION]} />
        </header>
        {today ? (
          <>
            <TicketsTodaySection
              slug={SLUG}
              href={`/products/${SLUG}/tickets`}
            />
            <LoyaltyTodaySection
              slug={SLUG}
              href={`/products/${SLUG}/loyalty`}
            />
          </>
        ) : null}
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

describe("the signed-in home's account", () => {
  it("shows nothing until the session read answers, then the host's navigation, the verified profile and sign-out", async () => {
    let answer: (reply: Reply) => void = () => {};
    session = () => new Promise((resolve) => (answer = resolve));
    home();
    // Pending: no identity, no navigation, no sign-in guessed.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => answer(signedIn("wallet-a", "a@example.com")));
    const nav = await screen.findByRole("navigation", { name: "Wallet" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Inventory", "/inventory"],
      ["Settings", "/settings"],
    ]);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Open user profile" }),
    );
    expect(
      within(screen.getByRole("region", { name: "User profile" })).getByText(
        "a@example.com",
      ),
    ).toBeTruthy();
  });

  it("a cookie that names no live session gets the public home's sign-in, never an account", async () => {
    session = async () => ({ status: 401, body: {} });
    home();
    const nav = await screen.findByRole("navigation", { name: "Wallet" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Sign in", "/login"],
      ["Create an account", "/register"],
    ]);
    expect(
      screen.queryByRole("button", { name: "Open user profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("signing out withholds the account and Today at once, before the session is revoked, reads nothing more and re-renders the public home", async () => {
    let revoked: (reply: Reply) => void = () => {};
    signOut = () => new Promise((resolve) => (revoked = resolve));
    const { client } = home({ today: true });
    expect(await screen.findByText("Account A's event")).toBeTruthy();
    expect(
      await screen.findByRole("region", { name: "Your membership" }),
    ).toBeTruthy();
    const ticketReads = calls("/api/faces/").length;

    // Two quick presses send one sign-out.
    const button = screen.getByRole("button", { name: "Sign out" });
    await userEvent.dblClick(button);
    expect(screen.getByRole("status").textContent).toBe("Signing out…");
    expect(screen.queryByText("Account A's event")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open user profile" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "Your tickets" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Your membership" }),
    ).toBeNull();
    expect(calls("/api/session/logout")).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();

    session = async () => ({ status: 401, body: {} });
    await act(async () => revoked(ok({ ok: true })));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // Nothing of the account is cached for whoever signs in next, and
    // nothing private was read while it ended.
    expect(
      client
        .getQueryCache()
        .findAll()
        .map((query) => query.queryKey)
        .filter((key) => key[0] !== sessionQueryKey[0]),
    ).toEqual([]);
    expect(calls("/api/faces/").length).toBe(ticketReads);
    expect(screen.queryByText("Account A's event")).toBeNull();
    expect(screen.queryByText("a@example.com")).toBeNull();
  });

  it("a sign-out that fails says so and keeps the account, while Today stays withheld", async () => {
    signOut = async () => ({ status: 500, body: {} });
    home({ today: true });
    expect(await screen.findByText("Account A's event")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByText(
        "We couldn't sign you out. You're still signed in; try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open user profile" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText("Account A's event")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
