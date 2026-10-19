/**
 * @jest-environment node
 */
// Loyalty (loyalty-join-earn-v1) as an opt-in journey of a branded host: the
// configuration, the page gate, the readback and the home card. The BFF is
// in product-face-loyalty.test.ts.
import {
  evaluateHostConfiguration,
  type HostConfigurationInput,
} from "@/api/host-configuration";
import { parseProductFaceApplications } from "@/api/product-face-binding";
import {
  hostHome,
  hostJourneyEnabled,
  hostPageAllowed,
  hostReadback,
  loyaltyServedBy,
  resetWalletHostCache,
} from "@/api/wallet-host";
import { edit } from "@/test/product-face-fixtures";
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

const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const withLoyalty = () =>
  JSON.stringify([{ ...morrowBinding(), loyalty: LOYALTY }]);

function inputFor(
  document: HostDocument,
  faceApplications = withLoyalty(),
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

function loyaltyOn(document = morrowDocument()) {
  edit(document, "journeys.loyalty", true);
  return document;
}

function serve(document: HostDocument, registry = withLoyalty()) {
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: registry }),
  );
}

afterEach(() => {
  clearHostEnvironment();
  resetWalletHostCache();
});

describe("the loyalty block on a face binding", () => {
  it("is optional, exact, and drops a binding that states it wrongly", () => {
    const plain = parseProductFaceApplications(
      JSON.stringify([morrowBinding()]),
      { production: true },
    );
    expect(plain[0].loyalty).toBeNull();
    expect(
      parseProductFaceApplications(withLoyalty(), { production: true })[0]
        .loyalty,
    ).toEqual(LOYALTY);
    expect(
      parseProductFaceApplications(
        JSON.stringify([
          { ...morrowBinding(), loyalty: { ...LOYALTY, points: 10 } },
        ]),
        { production: true },
      ),
    ).toEqual([]);
  });
});

describe("the loyalty journey in a host configuration", () => {
  it("is optional: absent is off, and the configuration's pin is unchanged", () => {
    const document = morrowDocument();
    const before = sealHost(document);
    const state = evaluateHostConfiguration(
      inputFor(document, JSON.stringify([morrowBinding()])),
    );
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configuration.journeys.loyalty).toBe(false);
    expect(sealHost(document)).toEqual(before);
  });

  it("is enabled by an explicit true, backed by a face with the loyalty block", () => {
    const state = evaluateHostConfiguration(inputFor(loyaltyOn()));
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configuration.journeys.loyalty).toBe(true);
  });

  it("is refused unbacked, or as anything but a boolean", () => {
    expect(
      evaluateHostConfiguration(
        inputFor(loyaltyOn(), JSON.stringify([morrowBinding()])),
      ),
    ).toEqual(
      expect.objectContaining({
        status: "invalid",
        problem: "journey_unbacked",
      }),
    );
    const document = morrowDocument();
    edit(document, "journeys.loyalty", "yes");
    expect(evaluateHostConfiguration(inputFor(document)).status).toBe(
      "invalid",
    );
  });
});

describe("a host serving loyalty", () => {
  it("serves the page, the home card and the readback only when the journey is on", () => {
    serve(loyaltyOn());
    expect(hostPageAllowed("/products/morrow-home/loyalty")).toBe(true);
    expect(hostHome()?.loyalty).toEqual({
      slug: "morrow-home",
      href: "/products/morrow-home/loyalty",
    });
    expect(hostReadback().journeys).toEqual(
      expect.objectContaining({ loyalty: true }),
    );
    serve(morrowDocument());
    expect(hostPageAllowed("/products/morrow-home/loyalty")).toBe(false);
    expect(hostHome()?.loyalty).toBeNull();
    expect(hostReadback().journeys).not.toHaveProperty("loyalty");
  });

  it("the generic wallet never serves it", () => {
    clearHostEnvironment();
    resetWalletHostCache();
    expect(hostJourneyEnabled("loyalty")).toBe(false);
    expect(loyaltyServedBy({ slug: "morrow-home", loyalty: LOYALTY })).toBe(
      false,
    );
  });
});
