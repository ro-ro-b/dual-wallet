/**
 * @jest-environment node
 */
// Tickets as an opt-in journey of a branded host: the configuration, the page
// gate, the readback and the home link. The BFF is in product-face-tickets.test.ts.
import { NextRequest } from "next/server";
import {
  evaluateHostConfiguration,
  type HostConfigurationInput,
} from "@/api/host-configuration";
import {
  resetWalletHostCache,
  hostHome,
  hostPageAllowed,
  hostReadback,
} from "@/api/wallet-host";
import { proxy } from "@/proxy";
import { edit, REMOVE } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
  MORROW_ORIGIN,
  sealHost,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

const RULES = {
  fields: {
    event: "event.title",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: { pending: [], issued: ["Issued"], ended: ["Cancelled"] },
};
const withRules = () =>
  JSON.stringify([{ ...morrowBinding(), tickets: RULES }]);

function inputFor(
  document: HostDocument,
  faceApplications = withRules(),
): HostConfigurationInput {
  const { raw, pin } = sealHost(document);
  return {
    raw,
    pin,
    appUrl: MORROW_ORIGIN,
    faceApplications,
    production: true,
  };
}

function ticketsOn(document = morrowDocument()) {
  edit(document, "journeys.tickets", true);
  return document;
}

afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
});

describe("the tickets journey in a host configuration", () => {
  it("is optional: a configuration without the key is valid and has it off", () => {
    const state = evaluateHostConfiguration(
      inputFor(morrowDocument(), JSON.stringify([morrowBinding()])),
    );
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configuration.journeys.tickets).toBe(false);
  });

  it("is enabled by an explicit true, backed by a face with ticket rules", () => {
    const state = evaluateHostConfiguration(inputFor(ticketsOn()));
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configuration.journeys.tickets).toBe(true);
  });

  it("an explicit false is the same as absent, and the document may state it", () => {
    const document = morrowDocument();
    edit(document, "journeys.tickets", false);
    const state = evaluateHostConfiguration(
      inputFor(document, JSON.stringify([morrowBinding()])),
    );
    expect(state.status).toBe("active");
  });

  it("is refused when no face of the host declares ticket rules", () => {
    expect(
      evaluateHostConfiguration(
        inputFor(ticketsOn(), JSON.stringify([morrowBinding()])),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "invalid",
        problem: "journey_unbacked",
      }),
    );
  });

  it.each([["yes"], [1], [null]])("refuses a non-boolean %j", (value) => {
    const document = morrowDocument();
    edit(document, "journeys.tickets", value);
    expect(evaluateHostConfiguration(inputFor(document)).status).toBe(
      "invalid",
    );
  });

  it("still refuses an unknown journey key and a missing original one", () => {
    const unknown = morrowDocument();
    edit(unknown, "journeys.loyalty", true);
    expect(evaluateHostConfiguration(inputFor(unknown)).status).toBe("invalid");
    const missing = morrowDocument();
    edit(missing, "journeys.transfer", REMOVE);
    expect(evaluateHostConfiguration(inputFor(missing)).status).toBe("invalid");
  });

  it("can be the primary journey", () => {
    const document = ticketsOn();
    edit(document, "home.primaryJourney", "tickets");
    expect(evaluateHostConfiguration(inputFor(document)).status).toBe("active");
  });
});

describe("a host serving tickets", () => {
  function serve(document: HostDocument, registry = withRules()) {
    resetWalletHostCache();
    applyHostEnvironment(
      hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: registry }),
    );
  }

  it("serves the tickets pages only when the journey is on", () => {
    serve(ticketsOn());
    expect(hostPageAllowed("/products/morrow-home/tickets")).toBe(true);
    expect(
      hostPageAllowed(`/products/morrow-home/tickets/${"a".repeat(24)}`),
    ).toBe(true);
    serve(morrowDocument(), JSON.stringify([morrowBinding()]));
    expect(hostPageAllowed("/products/morrow-home/tickets")).toBe(false);
    expect(
      hostPageAllowed(`/products/morrow-home/tickets/${"a".repeat(24)}`),
    ).toBe(false);
  });

  it("links the journey from the home and reports it in the readback", () => {
    const document = ticketsOn();
    edit(document, "home.primaryJourney", "tickets");
    serve(document);
    const home = hostHome();
    expect(home?.primary).toEqual({
      journey: "tickets",
      href: "/products/morrow-home/tickets",
    });
    expect(hostReadback().journeys).toEqual(
      expect.objectContaining({ tickets: true }),
    );
  });

  it("leaves the readback of a host that did not enable it unchanged", () => {
    serve(morrowDocument(), JSON.stringify([morrowBinding()]));
    expect(hostReadback().journeys).toEqual({
      registration: true,
      myProducts: true,
      serviceProgress: true,
      quoteDecisions: true,
      transfer: true,
    });
  });
});

describe("tickets pages at the request proxy", () => {
  const ID = "a".repeat(24);
  const list = "/products/morrow-home/tickets";
  const detail = `${list}/${ID}`;

  function visit(path: string, signedIn: boolean) {
    const { host } = new URL(MORROW_ORIGIN);
    const response = proxy(
      new NextRequest(`${MORROW_ORIGIN}${path}`, {
        headers: {
          host,
          ...(signedIn ? { cookie: "smarttoken_viewer=sealed" } : {}),
        },
      }),
    );
    if (response instanceof Promise) throw new Error("async");
    return response;
  }
  function serve(document: HostDocument, registry = withRules()) {
    resetWalletHostCache();
    applyHostEnvironment(
      hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: registry }),
    );
  }

  it("signs a signed-out visitor in and returns to the exact ticket", () => {
    serve(ticketsOn());
    for (const path of [list, detail]) {
      expect(visit(path, false).headers.get("location")).toBe(
        `${MORROW_ORIGIN}/login?next=${encodeURIComponent(path)}`,
      );
    }
  });

  it("reopens the same protected ticket directly when signed in", () => {
    serve(ticketsOn());
    expect(visit(detail, true).headers.get("x-middleware-next")).toBe("1");
  });

  it("answers not found, before any redirect, when the host did not enable Tickets", () => {
    serve(morrowDocument(), JSON.stringify([morrowBinding()]));
    for (const signedIn of [false, true]) {
      const response = visit(detail, signedIn);
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        `${MORROW_ORIGIN}/_wallet-host/not-found`,
      );
      expect(response.headers.get("location")).toBeNull();
    }
  });
});
