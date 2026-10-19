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

// ------------------------------------------------- admission (P4.3) variant
// A separate FICTIONAL fixture for ticket-admission-v1: one closed-template
// ticket (the shared Tickets service's 16-key map), a binding with the
// optional `tickets.admission` block, and a LOCAL FAKE Tickets runtime
// (e2e/tickets-home/fake-tickets-runtime.mjs) that verifies the wallet's
// assertions with this run's public key. Nothing here is the shared service.
export const ADMISSION_TEMPLATE = "7d0000000000000000000002";
export const ADMISSION_TICKET = "7d00000000000000000000c1";

export function admissionPorts() {
  return {
    wallet: Number(process.env.TICKETS_ADMISSION_WALLET_PORT || 3320),
    api: Number(process.env.TICKETS_ADMISSION_API_PORT || 4320),
    runtime: Number(process.env.TICKETS_ADMISSION_RUNTIME_PORT || 4330),
  };
}

const ADMISSION_CUSTOM_KEYS = [
  "accessClass",
  "activation_hash",
  "admissionStatus",
  "admissionWindowEndsAt",
  "admissionWindowStartsAt",
  "app_namespace",
  "eventRef",
  "idempotency_key",
  "operation_id",
  "product_type",
  "recipient_mint_projection",
  "recordId",
  "seatRef",
  "state",
  "title",
  "venueRef",
];

export function admissionRegistry(runtimeOrigin) {
  const [binding] = faceRegistry();
  return [
    {
      ...binding,
      origin: runtimeOrigin,
      templateIds: [ADMISSION_TEMPLATE],
      canonicalRegistration: {
        stateField: "state",
        lifecycleTargetField: "admissionStatus",
        settledStates: ["Valid"],
        unconfirmedStates: ["Issuing"],
        endedStates: ["Cancelled", "Expired"],
      },
      // No settle step: this programme's tickets are not registered here.
      settle: undefined,
      tickets: {
        fields: {
          event: "title",
          startsAt: "admissionWindowStartsAt",
          venue: "venueRef",
          entryClass: "accessClass",
          entryGuidance: null,
          // The P4.2 "issuance recorded" gate only: a content hash, never
          // shown as an operation (contract §4).
          issueOperation: "activation_hash",
          state: "state",
        },
        states: {
          pending: [],
          issued: ["Valid"],
          ended: ["Cancelled", "Expired"],
        },
        admission: {
          contract: "ticket-admission-v1",
          action: "update",
          inputPath: "data.custom",
          leaves: {
            state: { enum: ["Admitted"] },
            admissionStatus: { enum: ["Admitted"] },
            operation_id: { runtimeIssued: "^op_[0-9a-f]{40}$" },
            idempotency_key: {
              runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$",
            },
          },
          customKeys: ADMISSION_CUSTOM_KEYS,
          fromStates: ["Valid"],
          targetStates: ["Admitted"],
          preserveUnlisted: true,
        },
      },
    },
  ];
}

export function admissionFixtureEnvironment() {
  const { wallet, api, runtime } = admissionPorts();
  const origin = `http://localhost:${wallet}`;
  const runtimeOrigin = `http://localhost:${runtime}`;
  const registry = JSON.stringify(admissionRegistry(runtimeOrigin));
  const host = hostConfiguration(origin);
  const keys = generateKeyPairSync("ed25519");
  return {
    origin,
    apiOrigin: `http://127.0.0.1:${api}`,
    runtimeOrigin,
    api: {
      MOCK_API_PORT: String(api),
      MOCK_TICKETS_ADMISSION: "1",
      DEFAULT_ORGANIZATION_ID: FICTIONAL_ORGANIZATION,
      PRODUCT_FACE_APPLICATIONS: registry,
    },
    runtime: {
      FAKE_TICKETS_RUNTIME_PORT: String(runtime),
      FAKE_TICKETS_API_ORIGIN: `http://127.0.0.1:${api}`,
      FAKE_TICKETS_WALLET_ORIGIN: origin,
      FAKE_TICKETS_APPLICATION: "fictional.tickets.harbour-nights",
      FAKE_TICKETS_RUNTIME_ORIGIN: runtimeOrigin,
      FACE_ASSERTION_PUBLIC_KEY: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    },
    wallet: {
      API_URL: `http://127.0.0.1:${api}`,
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
