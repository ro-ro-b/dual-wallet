// FICTIONAL environment for the Loyalty (loyalty-join-earn-v1) browser
// fixture. "Harbour Makers Circle" is not a programme; every id, address and
// key here is made up, and the session/signing keys are generated per
// process. Nothing here is a released configuration, Studio or Dual.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  FICTIONAL_ORGANIZATION,
  faceRegistry,
  hostConfiguration,
} from "../tickets-home/environment.mjs";

export const LOYALTY_SLUG = "harbour-nights";
export const CANON_TEMPLATE = "7c0000000000000000000001";
export const PASS_TEMPLATE = "7c0000000000000000000002";
export const CANON = "7c00000000000000000000c1";
export const PASS = "7c00000000000000000000d1";
/** The fictional issuer account that owns and signs the canonical record. */
export const ISSUER = "0x00000000000000000000000000000000000e1e1e";
export const MODEL_ID = "harbour-makers";
export const PROGRAMME_ID = "HARBOUR-MAKERS";
/** Studio's application record reference: NOT the Dual object id. */
export const RECORD_ID = "mbr-fictional-0001";

export function loyaltyPorts() {
  return {
    wallet: Number(process.env.LOYALTY_FIXTURE_WALLET_PORT || 3340),
    api: Number(process.env.LOYALTY_FIXTURE_API_PORT || 4340),
    runtime: Number(process.env.LOYALTY_FIXTURE_RUNTIME_PORT || 4350),
  };
}

export function loyaltyRegistry(runtimeOrigin) {
  const [binding] = faceRegistry();
  return [
    {
      ...binding,
      origin: runtimeOrigin,
      // A Loyalty programme: no tickets.
      tickets: undefined,
      loyalty: {
        contract: "loyalty-join-earn-v1",
        modelId: MODEL_ID,
        programmeId: PROGRAMME_ID,
        canonicalTemplateId: CANON_TEMPLATE,
        passTemplateId: PASS_TEMPLATE,
        canonicalIssuerAccount: ISSUER,
      },
    },
  ];
}

export function loyaltyFixtureEnvironment() {
  const { wallet, api, runtime } = loyaltyPorts();
  const origin = `http://localhost:${wallet}`;
  const runtimeOrigin = `http://localhost:${runtime}`;
  const apiOrigin = `http://127.0.0.1:${api}`;
  const registry = JSON.stringify(loyaltyRegistry(runtimeOrigin));
  const host = hostConfiguration(origin, {
    journeys: {
      registration: false,
      myProducts: false,
      serviceProgress: false,
      quoteDecisions: false,
      transfer: false,
      loyalty: true,
    },
    home: {
      headline: "Your Harbour Makers membership (fictional).",
      introduction:
        "A local fixture: every programme, member and account here is made up.",
      primaryJourney: "loyalty",
    },
  });
  const keys = generateKeyPairSync("ed25519");
  return {
    origin,
    apiOrigin,
    runtimeOrigin,
    api: {
      MOCK_API_PORT: String(api),
      MOCK_LOYALTY: "1",
      DEFAULT_ORGANIZATION_ID: FICTIONAL_ORGANIZATION,
      PRODUCT_FACE_APPLICATIONS: registry,
    },
    runtime: {
      FAKE_LOYALTY_RUNTIME_PORT: String(runtime),
      FAKE_LOYALTY_API_ORIGIN: apiOrigin,
      FAKE_LOYALTY_WALLET_ORIGIN: origin,
      FAKE_LOYALTY_APPLICATION: "fictional.tickets.harbour-nights",
      FAKE_LOYALTY_RUNTIME_ORIGIN: runtimeOrigin,
      FAKE_LOYALTY_ORGANIZATION: FICTIONAL_ORGANIZATION,
      FACE_ASSERTION_PUBLIC_KEY: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    },
    wallet: {
      API_URL: apiOrigin,
      SESSION_SECRET: randomBytes(32).toString("base64"),
      NEXT_PUBLIC_APP_URL: origin,
      PRODUCT_FACE_APPLICATIONS: registry,
      WALLET_HOST_CONFIGURATION: host.raw,
      WALLET_HOST_CONFIGURATION_SHA256: host.pin,
      FACE_ASSERTION_SIGNING_KEY: keys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      FACE_ASSERTION_KEY_ID: "fictional-loyalty-fixture",
    },
  };
}
