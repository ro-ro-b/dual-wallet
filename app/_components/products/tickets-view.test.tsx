import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketsView } from "@/app/_components/products/tickets-view";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({
      dateTime: (value: Date, options: { timeZoneName?: string }) =>
        `formatted:${value.toISOString()}${options.timeZoneName ? ` (${options.timeZoneName} zone)` : ""}`,
    }),
  };
});
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({ wallet: { id: "wallet-1" } }),
}));

const TICKET = "a".repeat(24);
const wire = (overrides: Record<string, unknown> = {}) => ({
  objectId: TICKET,
  templateId: "b".repeat(24),
  clientId: "c".repeat(24),
  holder: "0x1234567890abcdef1234567890abcdef12345678",
  issueOperationId: "issue-op-0001",
  status: "issued",
  name: "Harbour Night entry",
  event: {
    title: "Harbour Night",
    startsAt: "2026-11-20T19:30:00Z",
    venue: "Quay Hall",
  },
  entryClass: "Standing",
  entryGuidance: "Doors open at 18:30.",
  admission: "unavailable",
  modifiedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function json(body: unknown, status = 200) {
  // jsdom has no Response; the service reads only ok, status and json().
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function view(props: { objectId?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TicketsView
        slug="morrow-home"
        programmeName="Harbour Nights"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("the ticket list", () => {
  it("lists the holder's tickets with an honest status and links to each", async () => {
    fetchMock.mockImplementation(() =>
      json({
        tickets: [
          wire(),
          wire({
            objectId: "d".repeat(24),
            status: "pending",
            event: { title: "Second", startsAt: null, venue: null },
          }),
        ],
        next: null,
      }),
    );
    view();
    // The link's name is its visible content (title, time, class, status).
    const link = await screen.findByRole("link", { name: /Harbour Night/ });
    expect(link.getAttribute("aria-label")).toBeNull();
    expect(link.getAttribute("href")).toBe(
      `/products/morrow-home/tickets/${TICKET}`,
    );
    expect(within(link).getByText("Issued")).toBeTruthy();
    expect(screen.getByText("Being issued")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/faces/morrow-home/tickets");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    // Nothing identifying the account or object travels from the browser.
    expect(Object.keys(init.headers).sort()).toEqual([
      "Accept",
      "x-dual-face-launch",
    ]);
  });

  it("says there are none only when the read succeeded and was empty", async () => {
    fetchMock.mockImplementation(() => json({ tickets: [], next: null }));
    view();
    expect(await screen.findByText("No tickets in this account")).toBeTruthy();
  });

  it("is unavailable, not empty, when the read fails; Try again reads again", async () => {
    fetchMock.mockImplementationOnce(() =>
      json({ code: "upstream_unavailable" }, 502),
    );
    view();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This doesn't mean you have none.");
    expect(screen.queryByText("No tickets in this account")).toBeNull();
    fetchMock.mockImplementation(() => json({ tickets: [wire()], next: null }));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: /Harbour Night/ }),
    ).toBeTruthy();
  });

  it("an ended session offers sign-in that returns to this page", async () => {
    fetchMock.mockImplementation(() => json({ code: "session_expired" }, 401));
    view();
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/products/morrow-home/tickets");
  });

  it("shows a malformed body as unavailable, never as tickets", async () => {
    fetchMock.mockImplementation(() =>
      json({ tickets: [wire({ admission: "admitted" })], next: null }),
    );
    view();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "couldn't read",
    );
  });

  it("loads more with the server's opaque continuation", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({ tickets: [wire()], next: "cursor_1" }),
      )
      .mockImplementationOnce(() =>
        json({ tickets: [wire({ objectId: "e".repeat(24) })], next: null }),
      );
    view();
    await screen.findByRole("link", { name: /Harbour Night/ });
    await userEvent.click(
      screen.getByRole("button", { name: "Show more tickets" }),
    );
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/faces/morrow-home/tickets?next=cursor_1",
    );
  });
});

describe("one ticket", () => {
  it("shows the event, class and entry guidance, and says admission is unavailable", async () => {
    fetchMock.mockImplementation(() => json({ ticket: wire() }));
    view({ objectId: TICKET });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Harbour Night" }),
    ).toBeTruthy();
    // The event time names its time zone rather than leaving it implied.
    expect(
      screen.getByText(/formatted:2026-11-20T19:30:00.000Z \(short zone\)/),
    ).toBeTruthy();
    expect(screen.getByText("Quay Hall")).toBeTruthy();
    expect(screen.getByText("Standing")).toBeTruthy();
    expect(screen.getByText("issue-op-0001")).toBeTruthy();
    expect(screen.getByText("Doors open at 18:30.")).toBeTruthy();
    expect(screen.getByText(/Entry check-in is not available/)).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/faces/morrow-home/tickets/${TICKET}`,
    );
  });

  it("a pending or unconfirmed ticket is not described as issued", async () => {
    fetchMock.mockImplementation(() =>
      json({ ticket: wire({ status: "unconfirmed", issueOperationId: null }) }),
    );
    view({ objectId: TICKET });
    expect(await screen.findByText("Not confirmed")).toBeTruthy();
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.queryByText("Issued")).toBeNull();
  });

  it("a ticket that is not the holder's is a calm not-found with a way back", async () => {
    fetchMock.mockImplementation(() => json({ code: "not_found" }, 404));
    view({ objectId: TICKET });
    expect(await screen.findByText(/isn't held by your account/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All tickets" }).getAttribute("href"),
    ).toBe("/products/morrow-home/tickets");
  });

  it("never shows a different object than the one asked for", async () => {
    fetchMock.mockImplementation(() =>
      json({ ticket: wire({ objectId: "f".repeat(24) }) }),
    );
    view({ objectId: TICKET });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "couldn't read",
    );
  });
});
