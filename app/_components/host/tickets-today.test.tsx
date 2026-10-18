import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TicketsTodaySection } from "@/app/_components/host/tickets-today";
import type { ViewerWallet } from "@/app/_domain/wallet";
import {
  SessionProvider,
  sessionQueryKey,
} from "@/app/_providers/session-provider";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    // Shows exactly which zone each time is formatted in.
    useFormatter: () => ({
      dateTime: (value: Date, options: { timeZone?: string }) =>
        `${value.toISOString()} in ${options.timeZone}`,
    }),
  };
});

const SLUG = "morrow-home";
const LIST = `/products/${SLUG}/tickets`;
// 21:00 on 18 October 2026 in Sydney (10:00 UTC).
const NOW = new Date("2026-10-18T10:00:00Z");
const ZONE = "Australia/Sydney";

const wire = (id: string, overrides: Record<string, unknown> = {}) => ({
  objectId: id.repeat(24),
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
  ...overrides,
  event: {
    title: `Event ${id}`,
    startsAt: null,
    venue: null,
    ...(overrides.event as object | undefined),
  },
});
const at = (startsAt: string) => ({
  event: { startsAt, venue: "Quay Hall" },
});

type Reply = { status: number; body: unknown };
let sessionReply: Reply;
let ticketReplies: Reply[];
const fetchMock = jest.fn((url: string, init?: RequestInit) => {
  void init;
  const reply = url.startsWith("/api/session")
    ? sessionReply
    : url.startsWith(`/api/faces/${SLUG}/tickets`)
      ? (ticketReplies.shift() ?? { status: 500, body: {} })
      : { status: 404, body: {} };
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: () => Promise.resolve(reply.body),
  });
});
const signedIn = (id: string): Reply => ({
  status: 200,
  body: {
    authenticated: true,
    authenticationMethod: "email",
    wallet: { id } as ViewerWallet,
  },
});
const ticketsCalls = () =>
  fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/faces/"));

beforeEach(() => {
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  sessionReply = signedIn("wallet-1");
  ticketReplies = [];
  jest.useFakeTimers({ now: NOW, advanceTimers: true });
  // A viewer whose machine is in Sydney: any formatter without an explicit
  // zone uses it (installed after the fake clock, which replaces Intl).
  const Real = Intl.DateTimeFormat;
  jest
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(
      (
        locales?: ConstructorParameters<typeof Real>[0],
        options?: Intl.DateTimeFormatOptions,
      ) => new Real(locales, { timeZone: ZONE, ...options }),
    );
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <TicketsTodaySection slug={SLUG} href={LIST} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { client, ...result };
}

describe("the signed-in home's tickets", () => {
  it("shows Today, Coming up and Needs attention in the viewer's zone, each linking to the exact ticket", async () => {
    ticketReplies = [
      {
        status: 200,
        body: {
          tickets: [
            // 20 October in Sydney: coming up.
            wire("1", at("2026-10-19T19:00:00Z")),
            // 22:30 on 18 October in Sydney (11:30 UTC): today.
            wire("2", at("2026-10-18T11:30:00Z")),
            // Pending, undated: needs attention.
            wire("3", { status: "pending" }),
            // Earlier today in UTC but yesterday in Sydney: not shown, and
            // not called ended or expired.
            wire("4", at("2026-10-17T12:00:00Z")),
          ],
          next: null,
        },
      },
    ];
    view();
    const today = await screen.findByRole("region", { name: "Today" });
    const todayLink = within(today).getByRole("link");
    expect(todayLink.getAttribute("href")).toBe(`${LIST}/${"2".repeat(24)}`);
    expect(todayLink.textContent).toContain(
      `2026-10-18T11:30:00.000Z in ${ZONE}`,
    );
    expect(within(today).getByText("Issued")).toBeTruthy();
    const coming = screen.getByRole("region", { name: "Coming up" });
    expect(within(coming).getByRole("link").getAttribute("href")).toBe(
      `${LIST}/${"1".repeat(24)}`,
    );
    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText("Being issued")).toBeTruthy();
    expect(screen.queryByText(/Event 4/)).toBeNull();
    expect(screen.queryByText(/No longer valid|expired/i)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "See all your tickets" })
        .getAttribute("href"),
    ).toBe(LIST);
    // One read of the first page, through the Tickets BFF only.
    expect(ticketsCalls().map(([url]) => url)).toEqual([
      `/api/faces/${SLUG}/tickets`,
    ]);
  });

  it("is reachable and readable from the keyboard, ticket by ticket", async () => {
    ticketReplies = [
      {
        status: 200,
        body: {
          tickets: [
            wire("1", at("2026-10-18T11:30:00Z")),
            wire("2", at("2026-10-19T19:00:00Z")),
          ],
          next: null,
        },
      },
    ];
    view();
    await screen.findByRole("region", { name: "Today" });
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe(
      `${LIST}/${"1".repeat(24)}`,
    );
    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe(
      `${LIST}/${"2".repeat(24)}`,
    );
    await user.tab();
    expect(document.activeElement?.textContent).toBe("See all your tickets");
  });

  it("never claims the nearest or the whole set from a partial first page", async () => {
    ticketReplies = [
      {
        status: 200,
        body: { tickets: [wire("1", at("2026-10-19T19:00:00Z"))], next: "c1" },
      },
    ];
    view();
    await screen.findByRole("region", { name: "Coming up" });
    expect(screen.getByText(/You may have more/)).toBeTruthy();
    // The home reads one page; it never pages on its own.
    expect(ticketsCalls()).toHaveLength(1);
  });

  it("keeps empty-but-more, none and unavailable distinct, and never retries on its own", async () => {
    ticketReplies = [{ status: 200, body: { tickets: [], next: "c1" } }];
    const first = view();
    expect(await screen.findByText(/No tickets found yet/)).toBeTruthy();
    expect(screen.queryByText("No tickets in this account.")).toBeNull();
    first.unmount();

    ticketReplies = [{ status: 200, body: { tickets: [], next: null } }];
    const second = view();
    expect(await screen.findByText("No tickets in this account.")).toBeTruthy();
    second.unmount();

    fetchMock.mockClear();
    ticketReplies = [
      { status: 502, body: { code: "upstream_unavailable" } },
      {
        status: 200,
        body: { tickets: [wire("1", at("2026-10-18T11:30:00Z"))], next: null },
      },
    ];
    view();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("doesn't mean you have none");
    expect(screen.queryByText("No tickets in this account.")).toBeNull();
    expect(ticketsCalls()).toHaveLength(1);
    await userEvent
      .setup({ advanceTimers: jest.advanceTimersByTime })
      .click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Today" })).toBeTruthy();
    expect(ticketsCalls()).toHaveLength(2);
  });

  it("offers ordinary sign-in when the session ends, keeping no tickets", async () => {
    ticketReplies = [{ status: 401, body: { code: "session_expired" } }];
    view();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session has ended");
    expect(
      within(alert).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
  });
});

describe("whose tickets", () => {
  it("fetches nothing private when the session read says signed out (an invalid cookie)", async () => {
    sessionReply = { status: 401, body: {} };
    view();
    expect(
      await screen.findByText("Sign in to see your tickets."),
    ).toBeTruthy();
    expect(ticketsCalls()).toEqual([]);
  });

  it("renders nothing while the session is still being read", () => {
    sessionReply = signedIn("wallet-1");
    const { container } = view();
    // The first render (and the server render) knows no session yet.
    expect(container.textContent).toBe("");
  });

  it("drops one account's tickets when the session is replaced, and reads the new account's", async () => {
    const second = {
      status: 200,
      body: {
        tickets: [wire("2", at("2026-10-18T12:30:00Z"))],
        next: null,
      },
    };
    ticketReplies = [
      {
        status: 200,
        body: {
          tickets: [wire("1", at("2026-10-18T11:30:00Z"))],
          next: null,
        },
      },
    ];
    const { client } = view();
    await screen.findByText(/Event 1/);
    // From here the server answers for the new account (its cookie).
    ticketReplies = [second, second, second];
    sessionReply = signedIn("wallet-2");
    await act(() => client.invalidateQueries({ queryKey: sessionQueryKey }));
    expect(await screen.findByText(/Event 2/)).toBeTruthy();
    expect(screen.queryByText(/Event 1/)).toBeNull();
    // The new account's read is a fresh launch scope, not the old one's.
    const launches = ticketsCalls().map(
      ([, init]) =>
        (init as unknown as { headers: Record<string, string> }).headers[
          "x-dual-face-launch"
        ],
    );
    expect(launches.at(-1)).not.toBe(launches[0]);
  });

  it("clears the tickets on sign-out", async () => {
    ticketReplies = [
      {
        status: 200,
        body: { tickets: [wire("1", at("2026-10-18T11:30:00Z"))], next: null },
      },
    ];
    const { client } = view();
    await screen.findByText(/Event 1/);
    // What logout does to the cache once the session is revoked.
    act(() => {
      client.setQueryData(sessionQueryKey, null);
    });
    await waitFor(() => expect(screen.queryByText(/Event 1/)).toBeNull());
    expect(screen.getByText("Sign in to see your tickets.")).toBeTruthy();
  });
});

describe("a home left open across the viewer's midnight", () => {
  // 23:59:30 on 18 October in Sydney (12:59:30 UTC).
  const LATE = new Date("2026-10-18T12:59:30Z");
  const tickets = {
    status: 200,
    body: {
      tickets: [
        // 22:00 on the 18th in Sydney.
        wire("1", at("2026-10-18T11:00:00Z")),
        // 10:00 on the 19th in Sydney.
        wire("2", at("2026-10-18T23:00:00Z")),
      ],
      next: null,
    },
  };
  const titles = (name: string) =>
    within(screen.getByRole("region", { name }))
      .getAllByRole("link")
      .map((link) => link.textContent);

  it("moves Today on at midnight without reading or writing anything", async () => {
    jest.setSystemTime(LATE);
    ticketReplies = [tickets];
    view();
    await screen.findByRole("region", { name: "Today" });
    expect(titles("Today")).toEqual([expect.stringContaining("Event 1")]);
    expect(titles("Coming up")).toEqual([expect.stringContaining("Event 2")]);
    const reads = ticketsCalls().length;

    await act(async () => {
      jest.advanceTimersByTime(40_000);
    });
    expect(titles("Today")).toEqual([expect.stringContaining("Event 2")]);
    // Yesterday's event is no longer Today, and is not called ended either.
    expect(screen.queryByText(/Event 1/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Coming up" })).toBeNull();
    expect(screen.queryByText(/No longer valid/)).toBeNull();
    // The day changed locally: no ticket read, no retry, no write.
    expect(ticketsCalls()).toHaveLength(reads);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => init?.method && init.method !== "GET",
      ),
    ).toEqual([]);
  });

  it("catches up when a hidden tab is shown again on a later day", async () => {
    jest.setSystemTime(new Date("2026-10-18T09:00:00Z"));
    ticketReplies = [tickets];
    view();
    await screen.findByRole("region", { name: "Today" });
    expect(titles("Today")).toEqual([expect.stringContaining("Event 1")]);
    const reads = ticketsCalls().length;

    // The tab slept past midnight: no timer ran, the clock moved on.
    jest.setSystemTime(new Date("2026-10-18T22:00:00Z"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(titles("Today")).toEqual([expect.stringContaining("Event 2")]);
    expect(ticketsCalls()).toHaveLength(reads);
  });

  it("stops its clock and its listener when it goes away", async () => {
    jest.setSystemTime(LATE);
    ticketReplies = [tickets];
    const removed = jest.spyOn(document, "removeEventListener");
    const { unmount } = view();
    await screen.findByRole("region", { name: "Today" });
    unmount();
    expect(removed).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    const reads = ticketsCalls().length;
    // Nothing fires after unmount (no state update on an unmounted tree).
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(errors).not.toHaveBeenCalled();
    expect(ticketsCalls()).toHaveLength(reads);
  });
});
