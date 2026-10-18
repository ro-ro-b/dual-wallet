/**
 * @jest-environment node
 */
// The Tickets journey's BFF: the current holder's own tickets only, read from
// Dual with the session's credential, projected through the binding's ticket
// rules, and served only by a branded host that opted in.
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORGANIZATION_ID } from "@/api/tenant";
import type { HostJourneys } from "@/app/_domain/wallet-host";
import {
  CHECKSUM_HOLDER,
  edit,
  HOLDER,
  TEMPLATE_A,
  TEMPLATE_B,
} from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
} from "@/test/wallet-host-fixtures";

const getWallet = jest.fn();
const getObjectById = jest.fn();
const listObjects = jest.fn();
jest.mock("@/api/web-sdk-client", () => ({
  getWalletsApi: () => ({ getWallet, logout: jest.fn() }),
  getObjectsApi: () => ({ getObjectById, listObjects }),
}));

import { establishSessionState } from "@/api/server-session";
import { resetWalletHostCache } from "@/api/wallet-host";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import { MAX_UPSTREAM_READS } from "@/api/product-face-tickets";
import { GET as listGET } from "@/app/api/faces/[slug]/tickets/route";
import { GET as detailGET } from "@/app/api/faces/[slug]/tickets/[objectId]/route";
import { ResponseError } from "@/api/web-sdk/runtime";

const SLUG = "morrow-home";
const TICKET = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const LAUNCH = `launch-${"x".repeat(28)}`;

const TICKET_RULES = {
  fields: {
    event: "event.title",
    startsAt: "event.starts_at",
    venue: "event.venue",
    entryClass: "ticket.class",
    entryGuidance: "ticket.entry_guidance",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: {
    pending: ["Issuing"],
    issued: ["Issued"],
    ended: ["Cancelled"],
  },
};

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function object(overrides: Record<string, unknown> = {}, custom = {}) {
  return {
    id: TICKET,
    orgId: DEFAULT_ORGANIZATION_ID,
    templateId: TEMPLATE_A,
    owner: HOLDER,
    metadata: { name: "Harbour Night entry" },
    custom: {
      event: {
        title: "Harbour Night",
        starts_at: "2026-11-20T19:30:00Z",
        venue: "Quay Hall",
      },
      ticket: {
        class: "Standing",
        entry_guidance: "Doors open at 18:30. Bring photo ID.",
        state: "Issued",
      },
      issue: { operation_id: "issue-op-0001" },
      ...custom,
    },
    whenModified: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

function configure({
  tickets = true,
  rules = TICKET_RULES as unknown,
}: { tickets?: boolean; rules?: unknown } = {}) {
  const declared = rules === "none" ? undefined : rules;
  const document = morrowDocument();
  edit(document, "entrance.origin", "http://localhost");
  edit(document, "entrance.organizationId", DEFAULT_ORGANIZATION_ID);
  edit(document, "navigation", []);
  if (tickets) {
    edit(document, "journeys", {
      ...(document.journeys as HostJourneys),
      tickets: true,
    });
  }
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, {
      PRODUCT_FACE_APPLICATIONS: JSON.stringify([
        { ...morrowBinding(), tickets: declared },
      ]),
    }),
  );
}

let cookies: Map<string, string>;

function signIn() {
  cookies = new Map();
  const response = NextResponse.json({});
  establishSessionState(
    response,
    {
      accessToken: jwt({
        org_id: DEFAULT_ORGANIZATION_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      refreshToken: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
    } as unknown as LoginOut,
    {
      organizationId: DEFAULT_ORGANIZATION_ID,
      subdomain: "*",
      host: "localhost",
    },
    "email",
  )!;
  for (const cookie of response.cookies.getAll()) {
    cookies.set(cookie.name, cookie.value);
  }
}

async function get<P>(
  handler: (
    request: NextRequest,
    context: { params: Promise<P> },
  ) => Promise<Response>,
  path: string,
  params: P,
) {
  const request = new NextRequest(`http://localhost${path}`, {
    headers: {
      host: "localhost",
      cookie: Array.from(cookies, ([k, v]) => `${k}=${v}`).join("; "),
      "x-dual-face-launch": LAUNCH,
    },
  });
  const response = await handler(request, { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
}

const list = (query = "") =>
  get(listGET, `/api/faces/${SLUG}/tickets${query}`, { slug: SLUG });
const detail = (objectId: string) =>
  get(detailGET, `/api/faces/${SLUG}/tickets/${objectId}`, {
    slug: SLUG,
    objectId,
  });

function responseError(status: number) {
  return new ResponseError(new Response(null, { status }), "upstream");
}

beforeEach(() => {
  getWallet.mockReset().mockResolvedValue({
    id: "wallet-1",
    language: "en",
    fqdn: "localhost",
    activated: true,
    emailVerified: true,
    disabled: false,
    account: {
      address: HOLDER,
      type: "SMART_WALLET",
      controller: { address: "0xc", type: "SECP256K1", custody: "custodial" },
      smartAccount: {},
    },
    whenCreated: new Date(),
    whenModified: new Date(),
  });
  getObjectById.mockReset();
  listObjects.mockReset();
  signIn();
});
afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
});

describe("the ticket list", () => {
  it("lists the holder's own tickets, read by owner and template, never organisation-wide", async () => {
    configure();
    listObjects.mockResolvedValue({ objects: [object()], next: null });
    const result = await list();
    expect(result.status).toBe(200);
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(listObjects.mock.calls[0][0]).toEqual(
      expect.objectContaining({ owner: HOLDER, templateId: TEMPLATE_A }),
    );
    expect(result.body).toEqual({
      tickets: [
        {
          objectId: TICKET,
          templateId: TEMPLATE_A,
          clientId: DEFAULT_ORGANIZATION_ID,
          holder: HOLDER,
          issueOperationId: "issue-op-0001",
          status: "issued",
          name: "Harbour Night entry",
          event: {
            title: "Harbour Night",
            startsAt: "2026-11-20T19:30:00Z",
            venue: "Quay Hall",
          },
          entryClass: "Standing",
          entryGuidance: "Doors open at 18:30. Bring photo ID.",
          admission: "unavailable",
          modifiedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      next: null,
    });
  });

  it("drops anything that is not the holder's, this client's or the programme's", async () => {
    configure();
    listObjects.mockResolvedValue({
      objects: [
        object({
          id: OTHER,
          owner: "0x00000000000000000000000000000000000000aa",
        }),
        object({ id: "cccccccccccccccccccccccc", orgId: "d".repeat(24) }),
        object({ id: "dddddddddddddddddddddddd", templateId: TEMPLATE_B }),
        // The same account, in the mixed case Dual writes it.
        object({
          id: "eeeeeeeeeeeeeeeeeeeeeeee",
          owner: HOLDER.toUpperCase().replace("0X", "0x"),
        }),
      ],
      next: null,
    });
    const result = await list();
    expect(
      result.body.tickets.map((t: { objectId: string }) => t.objectId),
    ).toEqual(["eeeeeeeeeeeeeeeeeeeeeeee"]);
  });

  it("matches the holder case-insensitively", async () => {
    configure();
    const wallet = (await getWallet()) as { account: object };
    getWallet.mockResolvedValue({
      ...wallet,
      account: { ...wallet.account, address: CHECKSUM_HOLDER },
    });
    listObjects.mockResolvedValue({
      objects: [object({ owner: CHECKSUM_HOLDER.toLowerCase() })],
      next: null,
    });
    const result = await list();
    expect(result.body.tickets).toHaveLength(1);
  });

  it("never reads pending as issued, unknown as issued, or any state as admitted", async () => {
    configure();
    listObjects.mockResolvedValue({
      objects: [
        object(
          { id: "a1a1a1a1a1a1a1a1a1a1a1a1" },
          { ticket: { state: "Issuing" } },
        ),
        object(
          { id: "a2a2a2a2a2a2a2a2a2a2a2a2" },
          { ticket: { state: "Admitted" } },
        ),
        object(
          { id: "a3a3a3a3a3a3a3a3a3a3a3a3" },
          { ticket: { state: "Cancelled" } },
        ),
        // Issued by state but with no original issue operation recorded.
        object({ id: "a4a4a4a4a4a4a4a4a4a4a4a4" }, { issue: {} }),
        object({ id: "a5a5a5a5a5a5a5a5a5a5a5a5" }, { ticket: { state: 7 } }),
      ],
      next: null,
    });
    const result = await list();
    expect(
      result.body.tickets.map((t: { status: string }) => t.status),
    ).toEqual([
      "pending",
      "unconfirmed",
      "ended",
      "unconfirmed",
      "unconfirmed",
    ]);
    expect(
      result.body.tickets.every(
        (t: { admission: string }) => t.admission === "unavailable",
      ),
    ).toBe(true);
  });

  it("shows untrusted brand text only as bounded plain text", async () => {
    configure();
    listObjects.mockResolvedValue({
      objects: [
        object(
          {},
          {
            event: {
              title: "<b>Harbour</b>",
              venue: "x".repeat(500),
              starts_at: "next Friday",
            },
            ticket: {
              class: "VIP",
              entry_guidance: "<img src=x>",
              state: "Issued",
            },
          },
        ),
      ],
      next: null,
    });
    const [ticket] = (await list()).body.tickets;
    expect(ticket.event).toEqual({
      title: "Harbour Night entry",
      startsAt: null,
      venue: null,
    });
    expect(ticket.entryGuidance).toBeNull();
    expect(ticket.entryClass).toBe("VIP");
  });

  it("continues across an empty first template without saying 'none' early, with an opaque cursor", async () => {
    configure();
    // Two templates in the programme.
    resetWalletHostCache();
    const document = morrowDocument();
    edit(document, "entrance.origin", "http://localhost");
    edit(document, "entrance.organizationId", DEFAULT_ORGANIZATION_ID);
    edit(document, "navigation", []);
    edit(document, "journeys", {
      ...(document.journeys as HostJourneys),
      tickets: true,
    });
    applyHostEnvironment(
      hostEnvironment(document, {
        PRODUCT_FACE_APPLICATIONS: JSON.stringify([
          {
            ...morrowBinding(),
            templateIds: [TEMPLATE_A, TEMPLATE_B],
            tickets: TICKET_RULES,
          },
        ]),
      }),
    );
    listObjects
      .mockResolvedValueOnce({ objects: [], next: "upstream-page-2" })
      .mockResolvedValueOnce({
        objects: [object({ templateId: TEMPLATE_A })],
        next: null,
      });
    const first = await list();
    // The empty first page is not the end: the second page of the same
    // template is read before anything is reported.
    expect(first.body.tickets).toHaveLength(1);
    expect(first.body.next).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
    expect(listObjects.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        next: "upstream-page-2",
        templateId: TEMPLATE_A,
      }),
    );
  });

  describe("bounded upstream paging", () => {
    // Objects of the programme's template that are not this holder's tickets:
    // a large mixed programme can return many pages of them.
    const notMine = () =>
      object({ owner: "0x00000000000000000000000000000000000000aa" });

    it("reads at most a fixed number of upstream pages per request and hands back a continuation, never 'none'", async () => {
      configure();
      listObjects.mockImplementation(({ next }: { next?: string }) =>
        Promise.resolve({
          objects: [notMine()],
          next: `page-${Number((next ?? "page-0").slice(5)) + 1}`,
        }),
      );
      const first = await list();
      expect(first.status).toBe(200);
      expect(listObjects).toHaveBeenCalledTimes(MAX_UPSTREAM_READS);
      // Nothing found yet, but not the end: an empty page with a continuation.
      expect(first.body.tickets).toEqual([]);
      expect(first.body.next).toEqual(
        expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      );

      // The continuation resumes at exactly the next unread upstream page.
      listObjects.mockClear();
      listObjects.mockResolvedValueOnce({ objects: [object()], next: null });
      const second = await list(`?next=${first.body.next}`);
      expect(listObjects).toHaveBeenCalledTimes(1);
      expect(listObjects.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          next: `page-${MAX_UPSTREAM_READS}`,
          owner: HOLDER,
          templateId: TEMPLATE_A,
        }),
      );
      expect(second.body).toEqual(
        expect.objectContaining({
          next: null,
          tickets: [expect.objectContaining({ objectId: TICKET })],
        }),
      );
    });

    it("treats an upstream continuation that repeats as unavailable, not as no tickets", async () => {
      configure();
      // The same page again and again.
      listObjects.mockResolvedValue({ objects: [notMine()], next: "stuck" });
      expect(await list()).toEqual({
        status: 502,
        body: expect.objectContaining({ code: "upstream_unavailable" }),
      });
      expect(listObjects).toHaveBeenCalledTimes(2);

      // A two-page cycle: a -> b -> a.
      listObjects.mockReset();
      listObjects.mockImplementation(({ next }: { next?: string }) =>
        Promise.resolve({
          objects: [notMine()],
          next: next === "a" ? "b" : "a",
        }),
      );
      expect((await list()).status).toBe(502);
      expect(listObjects).toHaveBeenCalledTimes(3);
    });

    it("refuses an upstream continuation too long to carry back", async () => {
      configure();
      listObjects.mockResolvedValue({
        objects: [notMine()],
        next: "x".repeat(301),
      });
      expect((await list()).status).toBe(502);
      expect(listObjects).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses injected query values and malformed cursors", async () => {
    configure();
    expect((await list("?owner=0xabc")).status).toBe(400);
    expect((await list("?next=!!")).status).toBe(400);
    expect((await list("?next=bm90LWEtY3Vyc29y")).status).toBe(400);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("says unavailable, not empty, when Dual cannot be read; an ended session is its own answer", async () => {
    configure();
    listObjects.mockRejectedValueOnce(new Error("boom"));
    expect(await list()).toEqual({
      status: 502,
      body: expect.objectContaining({ code: "upstream_unavailable" }),
    });
    listObjects.mockRejectedValueOnce(responseError(401));
    expect((await list()).status).toBe(401);
  });
});

describe("one ticket", () => {
  it("is re-read for the holder and answers the same not_found for anything else", async () => {
    configure();
    getObjectById.mockResolvedValue(object());
    const ok = await detail(TICKET);
    expect(ok.status).toBe(200);
    expect(ok.body.ticket).toEqual(
      expect.objectContaining({ objectId: TICKET, status: "issued" }),
    );

    for (const other of [
      object({ owner: "0x00000000000000000000000000000000000000aa" }),
      object({ orgId: "d".repeat(24) }),
      object({ templateId: TEMPLATE_B }),
    ]) {
      getObjectById.mockResolvedValue(other);
      expect(await detail(TICKET)).toEqual({
        status: 404,
        body: expect.objectContaining({ code: "not_found" }),
      });
    }
    getObjectById.mockRejectedValue(responseError(404));
    expect((await detail(TICKET)).status).toBe(404);
    getObjectById.mockRejectedValue(responseError(401));
    expect((await detail(TICKET)).status).toBe(401);
  });

  it("refuses an id that is not an object id and an object that answers as another", async () => {
    configure();
    expect((await detail("not-an-id")).status).toBe(400);
    getObjectById.mockResolvedValue(object({ id: OTHER }));
    expect((await detail(TICKET)).status).toBe(404);
  });
});

describe("who serves Tickets", () => {
  it("a branded host that did not enable them refuses before any read", async () => {
    configure({ tickets: false });
    expect(await list()).toEqual({
      status: 403,
      body: expect.objectContaining({ code: "capability_not_granted" }),
    });
    expect((await detail(TICKET)).status).toBe(403);
    expect(listObjects).not.toHaveBeenCalled();
    expect(getObjectById).not.toHaveBeenCalled();
  });

  it("the generic wallet serves none, even for a binding that declares rules", async () => {
    clearHostEnvironment();
    resetWalletHostCache();
    process.env.PRODUCT_FACE_APPLICATIONS = JSON.stringify([
      { ...morrowBinding(), tickets: TICKET_RULES },
    ]);
    try {
      // No host configuration: the tenant map decides the organisation.
      const result = await list();
      expect([401, 403]).toContain(result.status);
      expect(listObjects).not.toHaveBeenCalled();
    } finally {
      delete process.env.PRODUCT_FACE_APPLICATIONS;
    }
  });

  it("a host cannot enable Tickets for a face with no ticket rules: it fails closed", async () => {
    configure({ rules: "none" });
    const result = await list();
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("host_unavailable");
    expect(listObjects).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", { ...TICKET_RULES, extra: true }],
    [
      "a path used twice",
      {
        ...TICKET_RULES,
        fields: { ...TICKET_RULES.fields, venue: "event.title" },
      },
    ],
    [
      "a state in two lists",
      {
        ...TICKET_RULES,
        states: { ...TICKET_RULES.states, pending: ["Issued"] },
      },
    ],
    [
      "no issued state",
      { ...TICKET_RULES, states: { ...TICKET_RULES.states, issued: [] } },
    ],
    [
      "no issue operation path",
      {
        ...TICKET_RULES,
        fields: { ...TICKET_RULES.fields, issueOperation: undefined },
      },
    ],
  ])("rejects binding ticket rules with %s", async (_name, rules) => {
    configure({ rules });
    expect((await list()).status).toBe(503);
  });
});
