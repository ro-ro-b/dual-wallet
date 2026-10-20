import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketsView } from "@/app/_components/products/tickets-view";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({
      // Names the zone it was asked to format in, so a test can tell a
      // ticket's own wall clock from a machine-local conversion.
      dateTime: (
        value: Date,
        options: { timeZone?: string; timeZoneName?: string },
      ) =>
        `formatted:${value.toISOString()}${options.timeZone ? ` [${options.timeZone}]` : ""}${options.timeZoneName ? ` (${options.timeZoneName} zone)` : ""}`,
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

function view(props: { objectId?: string; admission?: boolean } = {}) {
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

describe("paging the ticket list from the keyboard", () => {
  const SECOND = "e".repeat(24);

  /** Tabs forward until `target` has focus, as a keyboard user would. */
  async function tabTo(target: HTMLElement) {
    for (let step = 0; step < 20 && document.activeElement !== target; step++) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(target);
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  it("keeps focus on Show more while loading, then moves it to the announced end of the list", async () => {
    const lastPage = deferred<unknown>();
    fetchMock
      .mockImplementationOnce(() =>
        json({ tickets: [wire()], next: "cursor_1" }),
      )
      .mockImplementationOnce(() => lastPage.promise);
    view();
    const more = await screen.findByRole("button", {
      name: "Show more tickets",
    });
    await tabTo(more);
    await userEvent.keyboard("{Enter}");

    // Loading: the same control, still focused, says what it is doing, and
    // pressing it again sends nothing more.
    const pending = await screen.findByRole("button", {
      name: "Loading more tickets…",
    });
    expect(pending).toBe(more);
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    lastPage.resolve(
      await json({ tickets: [wire({ objectId: SECOND })], next: null }),
    );
    const end = await screen.findByText("All your tickets are shown.");
    // The control is gone; focus is on the completion, not the page body.
    expect(
      screen.queryByRole("button", { name: /Show more|Loading more/ }),
    ).toBeNull();
    expect(end.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(end);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("never says 'no tickets' for a page that found none yet, and lets the holder keep checking", async () => {
    fetchMock
      .mockImplementationOnce(() => json({ tickets: [], next: "cursor_1" }))
      .mockImplementationOnce(() => json({ tickets: [wire()], next: null }));
    view();
    expect(await screen.findByText(/No tickets found yet/)).toBeTruthy();
    expect(screen.queryByText("No tickets in this account")).toBeNull();
    const keepChecking = screen.getByRole("button", {
      name: "Keep checking for tickets",
    });
    await tabTo(keepChecking);
    await userEvent.keyboard("{Enter}");
    expect(
      await screen.findByRole("link", { name: /Harbour Night/ }),
    ).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/faces/morrow-home/tickets?next=cursor_1",
    );
    expect(document.activeElement).toBe(
      screen.getByText("All your tickets are shown."),
    );
  });

  it("says there are none, with focus, only once checking has reached the end", async () => {
    fetchMock
      .mockImplementationOnce(() => json({ tickets: [], next: "cursor_1" }))
      .mockImplementationOnce(() => json({ tickets: [], next: null }));
    view();
    const keepChecking = await screen.findByRole("button", {
      name: "Keep checking for tickets",
    });
    await tabTo(keepChecking);
    await userEvent.keyboard("{Enter}");
    const none = await screen.findByText("No tickets in this account");
    expect(document.activeElement).toBe(none);
    expect(screen.queryByText(/No tickets found yet/)).toBeNull();
  });

  it("keeps the tickets already shown when a later page fails, and retries from the same place", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({ tickets: [wire()], next: "cursor_1" }),
      )
      .mockImplementationOnce(() => json({ code: "upstream_unavailable" }, 502))
      .mockImplementationOnce(() =>
        json({ tickets: [wire({ objectId: SECOND })], next: null }),
      );
    view();
    const more = await screen.findByRole("button", {
      name: "Show more tickets",
    });
    await tabTo(more);
    await userEvent.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The tickets above are still yours");
    // Focus moves to the failure rather than falling to the page body.
    expect(alert.contains(document.activeElement)).toBe(true);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const retry = within(alert).getByRole("button", { name: "Try again" });
    await tabTo(retry);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/faces/morrow-home/tickets?next=cursor_1",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByText("All your tickets are shown."),
    );
  });
});

describe("a session that ends while paging", () => {
  it("offers sign-in back to the list, with focus, and keeps the tickets shown", async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({ tickets: [wire()], next: "cursor_1" }),
      )
      .mockImplementationOnce(() => json({ code: "session_expired" }, 401));
    view();
    await userEvent.click(
      await screen.findByRole("button", { name: "Show more tickets" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session has ended");
    expect(document.activeElement).toBe(alert);
    expect(
      within(alert)
        .getByRole("link", { name: "Sign in again" })
        .getAttribute("href"),
    ).toBe("/products/morrow-home/tickets");
    expect(screen.getAllByRole("link", { name: /Harbour Night/ })).toHaveLength(
      1,
    );
  });
});

// The value shown for one fact of the ticket detail (its <dt>'s <dd>).
const fact = (label: string) => {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
};

describe("one ticket", () => {
  it("shows a ticket's canonical entry window in its own offset, and says plainly that no event start is stated", async () => {
    // The P4 client ticket's shape (FICTIONAL ids): Studio's map gives no
    // event start, only the entry window, written at minute precision.
    fetchMock.mockImplementation(() =>
      json({
        ticket: wire({
          event: {
            title: "Harbour Night",
            startsAt: null,
            venue: "p4-acceptance-venue",
          },
          entryClass: "general",
          entryGuidance: null,
          entryWindow: {
            startsAt: "2026-10-20T17:30+11:00",
            endsAt: "2026-10-20T20:30+11:00",
            closed: false,
          },
        }),
      }),
    );
    view({ objectId: TICKET });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    expect(within(fact("Event starts")).getByText("Not stated")).toBeTruthy();
    // 17:30 and 20:30 at +11:00, exactly as written: not converted to UTC
    // (06:30, 09:30) or to the machine's zone.
    expect(
      within(fact("Entry opens")).getByText(
        "formatted:2026-10-20T17:30:00.000Z [UTC] (UTC+11:00)",
      ),
    ).toBeTruthy();
    expect(
      within(fact("Entry closes")).getByText(
        "formatted:2026-10-20T20:30:00.000Z [UTC] (UTC+11:00)",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("When")).toBeNull();
    expect(screen.getByText("p4-acceptance-venue")).toBeTruthy();
    expect(screen.getByText("general")).toBeTruthy();
  });

  it("states an unknown side of the entry window as not stated, never guessed", async () => {
    fetchMock.mockImplementation(() =>
      json({
        ticket: wire({
          event: { title: "Harbour Night", startsAt: null, venue: "Quay Hall" },
          entryWindow: {
            startsAt: "2026-10-20T17:30+11:00",
            endsAt: null,
            closed: false,
          },
        }),
      }),
    );
    view({ objectId: TICKET });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    expect(within(fact("Event starts")).getByText("Not stated")).toBeTruthy();
    expect(within(fact("Entry closes")).getByText("Not stated")).toBeTruthy();
    expect(
      within(fact("Entry opens")).getByText(
        "formatted:2026-10-20T17:30:00.000Z [UTC] (UTC+11:00)",
      ),
    ).toBeTruthy();
  });

  it("shows the event, class and entry guidance, and says admission is unavailable", async () => {
    fetchMock.mockImplementation(() => json({ ticket: wire() }));
    view({ objectId: TICKET });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Harbour Night" }),
    ).toBeTruthy();
    // The event's own start, in its own stated offset (here UTC), named.
    expect(
      within(fact("Event starts")).getByText(
        "formatted:2026-11-20T19:30:00.000Z [UTC] (UTC)",
      ),
    ).toBeTruthy();
    // No entry window is stated, so none is shown.
    expect(screen.queryByText("Entry opens")).toBeNull();
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

describe("one ticket with ticket-admission-v1", () => {
  const ADMISSION = `/api/faces/morrow-home/tickets/${TICKET}/admission`;
  const admitted = {
    status: "admitted",
    admission: {
      requestId: `tad-${"1".repeat(32)}`,
      actionId: "act-1",
      admittedAt: "2026-10-18T19:01:00.000Z",
      receiptId: "rcpt-1",
    },
  };
  let ticketStatus: string;
  let checked: unknown;
  beforeEach(() => {
    ticketStatus = "issued";
    checked = admitted;
    fetchMock.mockImplementation((url: string) =>
      url === ADMISSION
        ? json({ state: checked })
        : json({ ticket: wire({ status: ticketStatus }) }),
    );
  });
  const header = () =>
    screen.getByRole("heading", { level: 1, name: "Harbour Night" })
      .parentElement!.parentElement!;
  const reads = () =>
    fetchMock.mock.calls.filter(([url]) => url !== ADMISSION).length;

  it("says Dual's recorded entry, never 'not confirmed', and confirms it only from the gate's check and a fresh read", async () => {
    ticketStatus = "admission_recorded";
    view({ objectId: TICKET, admission: true });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    expect(within(header()).getByText("Entry recorded")).toBeTruthy();
    expect(screen.getByText(/That alone does not confirm it/)).toBeTruthy();
    expect(screen.queryByText("Not confirmed")).toBeNull();
    expect(screen.queryByText("Entry confirmed")).toBeNull();
    // The issue reference is not the binding's content hash.
    expect(screen.queryByText("issue-op-0001")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Check for entry request" }),
    );
    await waitFor(() =>
      expect(within(header()).getByText("Entry confirmed")).toBeTruthy(),
    );
    expect(reads()).toBe(2);
    expect(screen.queryByText("Entry recorded")).toBeNull();
  });

  it("a verified entry that a fresh Dual read does not show stays unconfirmed in the header", async () => {
    // The ticket read after the gate's answer is still Valid (or drifted).
    view({ objectId: TICKET, admission: true });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    await userEvent.click(
      screen.getByRole("button", { name: "Check for entry request" }),
    );
    await screen.findByText(/Entry confirmed\. Gate request/);
    await waitFor(() => expect(reads()).toBe(2));
    expect(within(header()).getByText("Issued")).toBeTruthy();
    expect(within(header()).queryByText("Entry confirmed")).toBeNull();
  });

  it("an answer that changed nothing does not read the ticket again", async () => {
    checked = { status: "none" };
    view({ objectId: TICKET, admission: true });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    await userEvent.click(
      screen.getByRole("button", { name: "Check for entry request" }),
    );
    await screen.findByText(/no entry request/);
    expect(reads()).toBe(1);
  });

  it("a legacy binding keeps the ticket's own status and no entry steps", async () => {
    ticketStatus = "unconfirmed";
    view({ objectId: TICKET });
    expect(await screen.findByText("Not confirmed")).toBeTruthy();
    expect(screen.getByText(/Entry check-in is not available/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Check for entry request" }),
    ).toBeNull();
  });
});

describe("why a verified ticket can't be used", () => {
  const ADMISSION = `/api/faces/morrow-home/tickets/${TICKET}/admission`;
  const WINDOW_END = "2026-10-19T11:00:00.000Z";
  let ticket: Record<string, unknown>;
  let checked: unknown;
  beforeEach(() => {
    checked = { status: "none" };
    fetchMock.mockImplementation((url: string) =>
      url === ADMISSION ? json({ state: checked }) : json({ ticket }),
    );
  });
  const header = () =>
    screen.getByRole("heading", { level: 1, name: "Harbour Night" })
      .parentElement!.parentElement!;
  const open = async (admission = true) => {
    view({ objectId: TICKET, admission });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
  };

  it.each([
    ["cancelled", "Cancelled", "Dual records this ticket as cancelled."],
    ["expired", "Expired", "Dual records this ticket as expired."],
  ])(
    "names the exact end state, %s, with no reason and no new entry, while an entry already sent stays checkable",
    async (endedAs, badge, explanation) => {
      ticket = wire({ status: "ended", endedAs });
      checked = {
        status: "unknown",
        operationId: "adm-0123456789abcdef01234567",
      };
      await open();
      expect(within(header()).getByText(badge)).toBeTruthy();
      expect(within(header()).getByText(new RegExp(explanation))).toBeTruthy();
      expect(screen.queryByText("No longer valid")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Check for entry request" }),
      ).toBeNull();
      expect(screen.queryByText(/check for their request/)).toBeNull();
      expect(screen.getByText(/No new entry can be confirmed/)).toBeTruthy();
      // The original operation of an entry sent earlier is still read back.
      await userEvent.click(
        screen.getByRole("button", { name: "Check entry status" }),
      );
      expect(
        await screen.findByText(/outcome is not confirmed yet/),
      ).toBeTruthy();
      expect(screen.queryByText("Entry confirmed")).toBeNull();
    },
  );

  it("any other ended state stays 'No longer valid'; a state the rules don't place stays 'Not confirmed'", async () => {
    ticket = wire({ status: "ended", endedAs: null });
    const first = view({ objectId: TICKET });
    expect(await screen.findByText("No longer valid")).toBeTruthy();
    expect(screen.queryByText(/cancelled|expired/i)).toBeNull();
    first.unmount();
    ticket = wire({ status: "unconfirmed" });
    view({ objectId: TICKET });
    expect(await screen.findByText("Not confirmed")).toBeTruthy();
    expect(screen.queryByText(/cancelled|expired|window/i)).toBeNull();
  });

  it("a still-issued ticket past its verified entry window says so apart from its unchanged state, and offers no new entry", async () => {
    ticket = wire({
      status: "issued",
      entryWindow: { endsAt: WINDOW_END, closed: true },
    });
    await open();
    expect(within(header()).getByText("Issued")).toBeTruthy();
    expect(
      screen.getByText(
        `The entry window for this ticket closed on formatted:${WINDOW_END} [UTC] (UTC). Dual still records it as issued, but it can no longer be used to get in.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/expired/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for entry request" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Check entry status" }),
    );
    expect(await screen.findByText(/no entry request/)).toBeTruthy();
    expect(screen.queryByText("Entry confirmed")).toBeNull();
  });

  it("an open window, or none the wallet could verify, changes nothing", async () => {
    ticket = wire({
      status: "issued",
      entryWindow: { endsAt: WINDOW_END, closed: false },
    });
    const first = view({ objectId: TICKET, admission: true });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    expect(screen.queryByText(/window/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Check for entry request" }),
    ).toBeTruthy();
    first.unmount();
    // An older server's ticket, without the new keys.
    ticket = wire({ status: "issued" });
    view({ objectId: TICKET, admission: true });
    await screen.findByRole("heading", { level: 1, name: "Harbour Night" });
    expect(screen.queryByText(/window/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Check for entry request" }),
    ).toBeTruthy();
  });

  it("the list names the end state and the closed window too", async () => {
    fetchMock.mockImplementation(() =>
      json({
        tickets: [
          wire({ status: "ended", endedAs: "cancelled" }),
          wire({
            objectId: "d".repeat(24),
            status: "issued",
            entryWindow: { endsAt: WINDOW_END, closed: true },
          }),
        ],
        next: null,
      }),
    );
    view();
    const [cancelled, closed] = await screen.findAllByRole("link", {
      name: /Harbour Night/,
    });
    expect(within(cancelled).getByText("Cancelled")).toBeTruthy();
    expect(within(closed).getByText("Issued")).toBeTruthy();
    expect(within(closed).getByText("Entry window closed")).toBeTruthy();
  });
});
