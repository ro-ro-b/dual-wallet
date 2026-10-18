/**
 * @jest-environment node
 */
// Tickets as an opt-in journey of a branded host: the configuration, the page
// gate, the readback and the home link. The BFF is in product-face-tickets.test.ts.
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
