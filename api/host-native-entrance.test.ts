/**
 * @jest-environment node
 */
// Which faces are native-only (api/wallet-host.ts nativeOnlyJourneys): their
// entrance, help and end routes are wallet-native pages and no frame of them
// is rendered. Every face of the generic wallet, and every face of a host
// with a framed journey it backs, keeps its frame exactly as before.
import { productFaceBinding } from "@/api/product-face-registry";
import {
  hostPageAllowed,
  nativeOnlyJourneys,
  resetWalletHostCache,
} from "@/api/wallet-host";
import { bindingInput, edit } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

const TICKETS = {
  fields: {
    event: "event.title",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: { pending: [], issued: ["Issued"], ended: ["Cancelled"] },
};
const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const face = (slug: string, extra: Record<string, unknown>) =>
  bindingInput({
    slug,
    applicationId: `tig.fictional.${slug}`,
    path: `/face/tig.fictional.${slug}/1.0.0/${"a".repeat(64)}/`,
    ...extra,
  });
const REGISTRY = JSON.stringify([
  // A P3-style face backing every framed journey, with ticket rules too.
  { ...morrowBinding(), tickets: TICKETS },
  face("harbour-nights", { tickets: TICKETS }),
  face("harbour-circle", { loyalty: LOYALTY }),
  face("harbour-both", { tickets: TICKETS, loyalty: LOYALTY }),
  // Another client's face in the same deployment registry.
  face("harbour-elsewhere", { tickets: TICKETS }),
]);
const FRAMED_OFF = {
  registration: false,
  myProducts: false,
  serviceProgress: false,
  quoteDecisions: false,
  transfer: false,
};

function serve(document?: HostDocument) {
  resetWalletHostCache();
  if (!document) {
    clearHostEnvironment();
    process.env.PRODUCT_FACE_APPLICATIONS = REGISTRY;
    return;
  }
  applyHostEnvironment(
    hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: REGISTRY }),
  );
}

/** A branded host with only native journeys, on its own faces. */
function nativeHost(
  faces = ["harbour-nights", "harbour-circle", "harbour-both"],
  journeys: Record<string, boolean> = {},
) {
  const document = morrowDocument();
  edit(document, "journeys", {
    ...FRAMED_OFF,
    tickets: true,
    loyalty: true,
    ...journeys,
  });
  edit(document, "home.primaryJourney", "tickets");
  edit(document, "navigation", ["inventory", "settings"]);
  edit(document, "faces", faces);
  return document;
}

const native = (slug: string) => {
  const binding = productFaceBinding(slug);
  return binding && nativeOnlyJourneys(binding);
};

afterEach(() => {
  clearHostEnvironment();
  delete process.env.PRODUCT_FACE_APPLICATIONS;
  resetWalletHostCache();
});

describe("native-only faces", () => {
  it("the generic wallet frames every face, whatever its blocks", () => {
    serve();
    for (const slug of ["morrow-home", "harbour-nights", "harbour-circle"]) {
      expect(productFaceBinding(slug)).toBeDefined();
      expect(native(slug)).toBeUndefined();
    }
  });

  it("a P3 host frames its face, Tickets enabled or not", () => {
    const document = morrowDocument();
    serve(document);
    expect(productFaceBinding("morrow-home")).toBeDefined();
    expect(native("morrow-home")).toBeUndefined();
    edit(document, "journeys.tickets", true);
    serve(document);
    expect(productFaceBinding("morrow-home")).toBeDefined();
    expect(native("morrow-home")).toBeUndefined();
  });

  it("a host with only Tickets and Loyalty serves each of its faces natively, by the journeys that face serves", () => {
    serve(nativeHost());
    expect(native("harbour-nights")).toEqual(["tickets"]);
    expect(native("harbour-circle")).toEqual(["loyalty"]);
    expect(native("harbour-both")).toEqual(["tickets", "loyalty"]);
    // Another client's face is not this host's at all.
    expect(productFaceBinding("harbour-elsewhere")).toBeUndefined();
    // Its entrance, help and end routes need no journey; framed ones stay off.
    for (const task of ["", "/home", "/support", "/ended"]) {
      expect(hostPageAllowed(`/products/harbour-nights${task}`)).toBe(true);
    }
    for (const task of ["/register", "/products", "/service", "/accept"]) {
      expect(hostPageAllowed(`/products/harbour-nights${task}`)).toBe(false);
    }
    expect(hostPageAllowed("/products/harbour-elsewhere/support")).toBe(false);
  });

  it("a disabled native journey is not served: a face serving none of the enabled ones keeps its frame", () => {
    serve(nativeHost(["harbour-nights", "harbour-circle"], { loyalty: false }));
    expect(native("harbour-nights")).toEqual(["tickets"]);
    expect(productFaceBinding("harbour-circle")).toBeDefined();
    expect(native("harbour-circle")).toBeUndefined();
  });

  it("an enabled framed journey a face backs keeps that face framed; a face that backs none stays native", () => {
    // Transfer is backed by the P3 face only (its transfer template and
    // handover); the Tickets-only face backs no framed journey.
    serve(
      nativeHost(["morrow-home", "harbour-nights"], {
        loyalty: false,
        transfer: true,
      }),
    );
    expect(native("morrow-home")).toBeUndefined();
    expect(native("harbour-nights")).toEqual(["tickets"]);
    // Registration and My products are backed by every face.
    serve(nativeHost(["harbour-nights"], { loyalty: false, myProducts: true }));
    expect(productFaceBinding("harbour-nights")).toBeDefined();
    expect(native("harbour-nights")).toBeUndefined();
  });
});
