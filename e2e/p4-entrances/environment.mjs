// FICTIONAL environment for the P4 native-entrance browser fixture: one
// branded wallet host ("Harbour Nights", made up) with BOTH native journeys,
// Tickets and Loyalty, on two of its own face bindings, whose one bound
// backend is a LOCAL FAKE of a backend behind Vercel Authentication
// (e2e/p4-entrances/protected-backend.mjs): every request without this run's
// fictional workload token is refused 401, the browser's included. The
// Tickets binding pins the exact Ticket face Studio H2's own emitter
// (governed-workflow-studio-app@3e5ede0, src/ticket-face-artifact.mjs) wrote
// for this host, committed verbatim under e2e/fixtures/p4-ticket-face/. A third
// binding is another client's and never this host's. Every id, key, token and
// certificate is made up or generated for this run only; nothing here is Dual,
// Vercel, Studio or a released configuration.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANON_TEMPLATE,
  ISSUER,
  MODEL_ID,
  PASS_TEMPLATE,
  PROGRAMME_ID,
} from "../loyalty/environment.mjs";
import {
  FICTIONAL_ORGANIZATION,
  faceRegistry,
  hostConfiguration,
} from "../tickets-home/environment.mjs";

export const TICKETS_SLUG = "harbour-nights";
export const LOYALTY_SLUG = "harbour-circle";
/** Another client's face: bound in the deployment, never on this host. */
export const FOREIGN_SLUG = "harbour-elsewhere";
export const TICKETS_APPLICATION = "fictional.tickets.harbour-nights";
export const LOYALTY_APPLICATION = "fictional.loyalty.harbour-circle";

/** The Ticket face Studio H2 emitted for this host (wallet origin :3370). */
export const TICKET_FACE = {
  hash: "88acc4b43c1765b28ff72203585c98448be94ae1adc0b84512d04dbfed18bf85",
  version: "1.0.0",
  programmeName: "Harbour Nights (fictional)",
};
export const TICKET_FACE_PATH = `/face/${TICKETS_APPLICATION}/${TICKET_FACE.version}/${TICKET_FACE.hash}/`;

export function p4Ports() {
  return {
    // The emitted face names http://localhost:3370 as its only wallet origin.
    wallet: 3370,
    api: Number(process.env.P4_ENTRANCES_API_PORT || 4370),
    backend: Number(process.env.P4_ENTRANCES_BACKEND_PORT || 4371),
    runtime: Number(process.env.P4_ENTRANCES_RUNTIME_PORT || 4372),
    control: Number(process.env.P4_ENTRANCES_CONTROL_PORT || 4373),
  };
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/**
 * Per-run values every process of one run must share (the Playwright runner,
 * its workers, the servers): generated once and handed down through the
 * environment. The token only looks like a platform OIDC token (an unexpired
 * compact JWS); the fake backend compares it byte for byte and nothing
 * verifies its made-up signature.
 */
function runSecrets() {
  if (!process.env.P4_ENTRANCES_TLS_DIR) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "p4-entrances-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    process.env.P4_ENTRANCES_TLS_DIR = dir;
  }
  if (!process.env.P4_ENTRANCES_OIDC_TOKEN) {
    process.env.P4_ENTRANCES_OIDC_TOKEN = [
      base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fictional" })),
      base64url(
        JSON.stringify({
          iss: "https://oidc.example.invalid/fictional",
          sub: "owner:fictional:project:wallet:environment:preview",
          aud: "https://example.invalid/fictional",
          exp: Math.floor(Date.now() / 1000) + 6 * 3600,
          jti: randomBytes(12).toString("hex"),
        }),
      ),
      randomBytes(32).toString("base64url"),
    ].join(".");
  }
  const dir = process.env.P4_ENTRANCES_TLS_DIR;
  return {
    cert: path.join(dir, "cert.pem"),
    key: path.join(dir, "key.pem"),
    token: process.env.P4_ENTRANCES_OIDC_TOKEN,
  };
}

export function p4Registry(backendOrigin) {
  const [tickets] = faceRegistry();
  return [
    {
      // The Tickets programme: its binding pins the H2-emitted face.
      ...tickets,
      programmeName: TICKET_FACE.programmeName,
      origin: backendOrigin,
      path: TICKET_FACE_PATH,
      artifactHash: `sha256:${TICKET_FACE.hash}`,
    },
    {
      // The Loyalty programme, on the same protected backend. Its face is
      // never published there: a native-only face is never read at all.
      ...tickets,
      slug: LOYALTY_SLUG,
      applicationId: LOYALTY_APPLICATION,
      publisher: "harbour-nights",
      programmeId: "harbour-circle",
      programmeName: "Harbour Makers Circle (fictional)",
      origin: backendOrigin,
      path: `/face/${LOYALTY_APPLICATION}/1.0.0/${"e".repeat(64)}/`,
      artifactHash: `sha256:${"e".repeat(64)}`,
      tickets: undefined,
      loyalty: {
        contract: "loyalty-join-earn-v1",
        modelId: MODEL_ID,
        programmeId: PROGRAMME_ID,
        canonicalTemplateId: CANON_TEMPLATE,
        passTemplateId: PASS_TEMPLATE,
        canonicalIssuerAccount: ISSUER,
        benefits: "loyalty-benefit-redeem-v1",
      },
    },
    {
      // Another client's Tickets programme in the same deployment registry.
      ...tickets,
      slug: FOREIGN_SLUG,
      applicationId: "fictional.tickets.harbour-elsewhere",
      publisher: "harbour-elsewhere",
      programmeId: "harbour-elsewhere-events",
      programmeName: "Harbour Elsewhere (fictional)",
      origin: backendOrigin,
      path: `/face/fictional.tickets.harbour-elsewhere/1.0.0/${"d".repeat(64)}/`,
      artifactHash: `sha256:${"d".repeat(64)}`,
    },
  ];
}

export function p4FixtureEnvironment() {
  const { wallet, api, backend, runtime, control } = p4Ports();
  const secrets = runSecrets();
  const origin = `http://localhost:${wallet}`;
  const apiOrigin = `http://127.0.0.1:${api}`;
  const backendOrigin = `https://localhost:${backend}`;
  const registry = JSON.stringify(p4Registry(backendOrigin));
  const host = hostConfiguration(origin, {
    journeys: {
      registration: false,
      myProducts: false,
      serviceProgress: false,
      quoteDecisions: false,
      transfer: false,
      tickets: true,
      loyalty: true,
    },
    faces: [TICKETS_SLUG, LOYALTY_SLUG],
  });
  const keys = generateKeyPairSync("ed25519");
  return {
    origin,
    apiOrigin,
    backendOrigin,
    controlOrigin: `http://localhost:${control}`,
    token: secrets.token,
    api: {
      MOCK_API_PORT: String(api),
      MOCK_TICKETS: "1",
      MOCK_LOYALTY: "1",
      DEFAULT_ORGANIZATION_ID: FICTIONAL_ORGANIZATION,
      PRODUCT_FACE_APPLICATIONS: registry,
    },
    runtime: {
      FAKE_LOYALTY_RUNTIME_PORT: String(runtime),
      FAKE_LOYALTY_API_ORIGIN: apiOrigin,
      FAKE_LOYALTY_WALLET_ORIGIN: origin,
      FAKE_LOYALTY_APPLICATION: LOYALTY_APPLICATION,
      // The audience the wallet's assertions name: the protected backend.
      FAKE_LOYALTY_RUNTIME_ORIGIN: backendOrigin,
      FAKE_LOYALTY_ORGANIZATION: FICTIONAL_ORGANIZATION,
      FACE_ASSERTION_PUBLIC_KEY: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    },
    backend: {
      P4_BACKEND_PORT: String(backend),
      P4_BACKEND_CONTROL_PORT: String(control),
      P4_BACKEND_CERT: secrets.cert,
      P4_BACKEND_KEY: secrets.key,
      P4_BACKEND_RUNTIME_ORIGIN: `http://localhost:${runtime}`,
      P4_BACKEND_OIDC_TOKEN: secrets.token,
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
      FACE_ASSERTION_KEY_ID: "fictional-p4-entrances-fixture",
      // The existing default-off exact-origin workload transport, on for
      // exactly the protected backend; the token is read only server-side.
      TIG_RUNTIME_OIDC_ORIGINS: backendOrigin,
      VERCEL_OIDC_TOKEN: secrets.token,
      // Trust this run's self-signed certificate for localhost only.
      NODE_EXTRA_CA_CERTS: secrets.cert,
    },
  };
}
