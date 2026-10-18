// FICTIONAL branded-host environment for the Tickets/Home browser fixture.
// Every value here is illustrative: "Harbour Nights" is not a brand, its
// organisation and template ids are made up, the face origin is never loaded
// (Tickets pages render no frame) and the session/signing keys are generated
// per process and never written anywhere. Nothing here is a released host
// configuration; the wallet's own parser (api/host-configuration.ts) validates
// it at startup and fails closed if it is not exactly right.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export const FICTIONAL_ORGANIZATION = "7e7e7e7e7e7e7e7e7e7e7e7e";
export const TICKET_TEMPLATE = "7d0000000000000000000001";
export const SLUG = "harbour-nights";

/** The fictional ticket objects the fake API seeds with MOCK_TICKETS=1. */
export const TICKET_IDS = {
  today: "7d00000000000000000000a1",
  comingUp: "7d00000000000000000000a2",
  pending: "7d00000000000000000000a3",
  unconfirmed: "7d00000000000000000000a4",
  past: "7d00000000000000000000a5",
  // Owned by the holder but issued by another organisation.
  otherClient: "7d00000000000000000000b1",
  // This client's, held by the second fictional account.
  otherHolder: "7d00000000000000000000b2",
};
export const OTHER_ORGANIZATION = "7d7d7d7d7d7d7d7d7d7d7d7d";

/** The fictional sign-in the local fake API accepts (e2e/mock-api.mjs). */
export const FICTIONAL_ACCOUNTS = {
  holder: {
    email: "face-e2e@example.com",
    password: "correct horse battery staple",
  },
  secondHolder: {
    email: "face-e2e-b@example.com",
    password: "another correct horse battery",
  },
};

export function ports() {
  return {
    wallet: Number(process.env.TICKETS_FIXTURE_WALLET_PORT || 3310),
    api: Number(process.env.TICKETS_FIXTURE_API_PORT || 4310),
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The wallet's canonical JSON (app/_domain/product-face.ts canonicalJson):
// sorted keys, no whitespace. A difference here fails the pin, closed.
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

// A 2x2 PNG (the same illustrative bytes as test/wallet-host-fixtures.ts).
const LOGO_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgjvHijvFigFAAEm4CxUaOB1wAAAAASUVORK5CYII=";

export function faceRegistry() {
  const hash = "f".repeat(64);
  return [
    {
      slug: SLUG,
      applicationId: "fictional.tickets.harbour-nights",
      version: "1.0.0",
      publisher: "harbour-nights",
      programmeId: "harbour-nights-events",
      programmeName: "Harbour Nights events (fictional)",
      // Never loaded: the Tickets pages render no face frame.
      origin: "http://localhost:4399",
      path: `/face/fictional.tickets.harbour-nights/1.0.0/${hash}/`,
      artifactHash: `sha256:${hash}`,
      templateIds: [TICKET_TEMPLATE],
      projectionFields: ["state"],
      canonicalRegistration: {
        stateField: "ticket.state",
        lifecycleTargetField: "lifecycle.target_state",
        settledStates: ["Issued"],
        unconfirmedStates: ["Issuing"],
        endedStates: ["Cancelled"],
      },
      settle: {
        action: "update",
        inputTemplate: {
          custom: { ticket: { state: { enum: ["Issued"] } } },
        },
        fromStates: ["Issuing"],
        targetStates: ["Issued"],
        preserveUnlisted: true,
      },
      // Where this programme's objects keep each ticket fact (P4.2 rules).
      tickets: {
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
      },
    },
  ];
}

export function hostConfiguration(origin) {
  const document = {
    schema: "dual-wallet-host-configuration-v1",
    brand: {
      id: "harbour-nights",
      name: "Harbour Nights",
      shortName: "Harbour",
      description: "A fictional event brand for the local Tickets fixture.",
    },
    entrance: { origin, organizationId: FICTIONAL_ORGANIZATION },
    identity: {
      logo: {
        mediaType: "image/png",
        sha256: sha256(Buffer.from(LOGO_BASE64, "base64")),
        dataBase64: LOGO_BASE64,
      },
      colours: {
        brand: "#2f7d5b",
        brandStrong: "#1d5c41",
        brandSoft: "#e6f4ec",
        ink: "#10261c",
        muted: "#4d6358",
        actionPrimary: "#1d5c41",
        actionPrimaryHover: "#154631",
        onActionPrimary: "#ffffff",
        surface: "#ffffff",
        surfaceSubtle: "#f4f7f5",
        border: "#d5e2da",
      },
      typography: { family: "system-sans" },
    },
    home: {
      headline: "Your Harbour Nights tickets (fictional).",
      introduction:
        "A local fixture: every event, ticket and account here is made up.",
      primaryJourney: "tickets",
    },
    navigation: ["inventory", "settings"],
    journeys: {
      registration: false,
      myProducts: false,
      serviceProgress: false,
      quoteDecisions: false,
      transfer: false,
      tickets: true,
    },
    faces: [SLUG],
    release: {
      configVersion: "0.0.1",
      approvedContentHash: "",
      studioVersionRef: "fixture@local",
    },
  };
  const { release, ...content } = document;
  const sealed = {
    ...document,
    release: {
      ...release,
      approvedContentHash: `sha256:${sha256(canonicalJson(content))}`,
    },
  };
  const raw = canonicalJson(sealed);
  return { raw, pin: sha256(raw) };
}

/** Environment for the fake API and the wallet, for one fixture run. */
export function fixtureEnvironment() {
  const { wallet, api } = ports();
  const origin = `http://localhost:${wallet}`;
  const registry = JSON.stringify(faceRegistry());
  const host = hostConfiguration(origin);
  const keys = generateKeyPairSync("ed25519");
  return {
    origin,
    apiOrigin: `http://127.0.0.1:${api}`,
    api: {
      MOCK_API_PORT: String(api),
      MOCK_TICKETS: "1",
      DEFAULT_ORGANIZATION_ID: FICTIONAL_ORGANIZATION,
      PRODUCT_FACE_APPLICATIONS: registry,
    },
    wallet: {
      API_URL: `http://127.0.0.1:${api}`,
      // Ephemeral per run; there is no fallback key.
      SESSION_SECRET: randomBytes(32).toString("base64"),
      NEXT_PUBLIC_APP_URL: origin,
      PRODUCT_FACE_APPLICATIONS: registry,
      WALLET_HOST_CONFIGURATION: host.raw,
      WALLET_HOST_CONFIGURATION_SHA256: host.pin,
      FACE_ASSERTION_SIGNING_KEY: keys.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      FACE_ASSERTION_KEY_ID: "fictional-tickets-fixture",
    },
  };
}
