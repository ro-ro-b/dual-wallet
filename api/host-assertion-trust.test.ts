/**
 * @jest-environment node
 */
// The host's face-assertion trust in GET /api/host/configuration: the public
// key Studio binds a client's Tickets or Loyalty service to, derived from the
// signer the wallet actually validated. Never private material, never for a
// host that serves neither, and null when the signer is unusable.
import {
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from "node:crypto";
import { mintFaceAssertion } from "@/api/face-assertion";
import { productFaceBinding } from "@/api/product-face-registry";
import {
  ASSERTION_TRUST_SCHEMA,
  resetWalletHostCache,
} from "@/api/wallet-host";
import { GET as readbackGET } from "@/app/api/host/configuration/route";
import { edit } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
  MORROW_ORIGIN,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

const KEY_ID = "fictional-morrow-face-key";
const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const TICKETS = {
  fields: {
    event: "event.title",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: { pending: [], issued: ["Issued"], ended: ["Cancelled"] },
};
// One client wallet: its Tickets and Loyalty products on the same face binding.
const bothProducts = () =>
  JSON.stringify([{ ...morrowBinding(), tickets: TICKETS, loyalty: LOYALTY }]);
const LEGACY_KEYS = [
  "schema",
  "brandId",
  "organizationId",
  "origin",
  "configurationSha256",
  "configVersion",
  "engine",
  "journeys",
  "faces",
  "status",
];

const pkcs8Pem = (key: KeyObject) =>
  key.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs8Der = (key: KeyObject) =>
  key.export({ type: "pkcs8", format: "der" }).toString("base64");

function withJourneys(...journeys: ("tickets" | "loyalty")[]) {
  const document: HostDocument = morrowDocument();
  for (const journey of journeys) edit(document, `journeys.${journey}`, true);
  return document;
}

function serve(
  document: HostDocument,
  signer: { key?: string; kid?: string } = {},
  registry = bothProducts(),
) {
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: registry }),
  );
  if (signer.key === undefined) delete process.env.FACE_ASSERTION_SIGNING_KEY;
  else process.env.FACE_ASSERTION_SIGNING_KEY = signer.key;
  if (signer.kid === undefined) delete process.env.FACE_ASSERTION_KEY_ID;
  else process.env.FACE_ASSERTION_KEY_ID = signer.kid;
}

async function readback() {
  const response = readbackGET();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  return { text, body: JSON.parse(text) };
}

afterEach(() => {
  clearHostEnvironment();
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
  delete process.env.FACE_ASSERTION_KEY_ID;
  resetWalletHostCache();
});

describe("an active Tickets or Loyalty host's assertion trust", () => {
  it.each([
    ["Loyalty", ["loyalty"] as const],
    ["Tickets", ["tickets"] as const],
    ["Tickets and Loyalty", ["tickets", "loyalty"] as const],
  ])(
    "%s: the public key of the validated signer, under its key ID and the entrance origin",
    async (_label, journeys) => {
      const { privateKey } = generateKeyPairSync("ed25519");
      serve(withJourneys(...journeys), {
        key: pkcs8Pem(privateKey),
        kid: KEY_ID,
      });
      const { body } = await readback();
      expect(body.status).toBe("active");
      expect(body.origin).toBe(MORROW_ORIGIN);
      const expected = createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString();
      expect(body.assertionTrust).toEqual({
        schema: ASSERTION_TRUST_SCHEMA,
        issuer: MORROW_ORIGIN,
        keys: { [KEY_ID]: { publicKey: expected, issuer: MORROW_ORIGIN } },
      });
      expect(ASSERTION_TRUST_SCHEMA).toBe("dual-wallet-assertion-trust-v1");
    },
  );

  it("verifies exactly the assertions this host signs", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    serve(withJourneys("loyalty"), { key: pkcs8Pem(privateKey), kid: KEY_ID });
    const { body } = await readback();
    const binding = productFaceBinding("morrow-home");
    expect(binding).toBeDefined();
    const minted = mintFaceAssertion({
      issuer: MORROW_ORIGIN,
      binding: binding!,
      walletId: "a".repeat(24),
      holder: `0x${"b".repeat(40)}`,
      operation: "loyalty.programme.read",
      operationId: "op-trust-0001",
      target: { model_id: "harbour-makers" },
      requestHash: `sha256:${"c".repeat(64)}`,
      sidHash: `sha256:${"d".repeat(64)}`,
    });
    expect(minted).toBeDefined();
    const [header, claims, signature] = minted!.assertion.split(".");
    const kid = JSON.parse(Buffer.from(header, "base64url").toString()).kid;
    const trusted = body.assertionTrust.keys[kid];
    expect(trusted.issuer).toBe(
      JSON.parse(Buffer.from(claims, "base64url").toString()).iss,
    );
    const valid = (publicKey: string) =>
      verify(
        null,
        Buffer.from(`${header}.${claims}`),
        createPublicKey(publicKey),
        Buffer.from(signature, "base64url"),
      );
    expect(valid(trusted.publicKey)).toBe(true);
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(valid(other)).toBe(false);
  });

  it.each([
    ["PEM", (key: KeyObject) => pkcs8Pem(key)],
    ["base64 DER", (key: KeyObject) => pkcs8Der(key)],
    [
      "base64 PEM",
      (key: KeyObject) => Buffer.from(pkcs8Pem(key)).toString("base64"),
    ],
  ])(
    "never carries the private key or the raw variable (%s)",
    async (_label, encode) => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const raw = encode(privateKey);
      serve(withJourneys("tickets", "loyalty"), { key: raw, kid: KEY_ID });
      const { text, body } = await readback();
      expect(Object.keys(body.assertionTrust.keys)).toEqual([KEY_ID]);
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain(raw.slice(0, 64));
      expect(text).not.toContain(pkcs8Der(privateKey).slice(-48));
      expect(text).not.toContain(
        privateKey.export({ format: "jwk" }).d as string,
      );
      expect(text).not.toContain("FACE_ASSERTION");
      expect(body.assertionTrust.keys[KEY_ID].publicKey).toMatch(
        /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/,
      );
    },
  );
});

describe("an active Tickets or Loyalty host without a usable signer", () => {
  it.each([
    ["no signing key", {}],
    ["a key without its key ID", { key: "VALID" }],
    ["a key ID that is not one", { key: "VALID", kid: "not a key id!" }],
    ["an unreadable key", { key: "not-a-key", kid: KEY_ID }],
    ["a key that is not Ed25519", { key: "RSA", kid: KEY_ID }],
  ])(
    "%s reports null",
    async (_label, signer: { key?: string; kid?: string }) => {
      const key =
        signer.key === "VALID"
          ? pkcs8Pem(generateKeyPairSync("ed25519").privateKey)
          : signer.key === "RSA"
            ? pkcs8Pem(
                generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
              )
            : signer.key;
      serve(withJourneys("tickets", "loyalty"), { key, kid: signer.kid });
      const { body } = await readback();
      expect(body.status).toBe("active");
      expect(body).toHaveProperty("assertionTrust", null);
    },
  );
});

describe("every other host keeps its readback shape", () => {
  it("an active host that serves neither Tickets nor Loyalty", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    serve(morrowDocument(), { key: pkcs8Pem(privateKey), kid: KEY_ID });
    const { body } = await readback();
    expect(body.status).toBe("active");
    expect(Object.keys(body)).toEqual(LEGACY_KEYS);
  });

  it("an invalid configuration", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    serve(withJourneys("tickets", "loyalty"), {
      key: pkcs8Pem(privateKey),
      kid: KEY_ID,
    });
    process.env.WALLET_HOST_CONFIGURATION_SHA256 = "2".repeat(64);
    resetWalletHostCache();
    const { body } = await readback();
    expect(body.status).toBe("invalid");
    expect(Object.keys(body)).toEqual(LEGACY_KEYS);
  });

  it("the generic wallet (absent)", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    applyHostEnvironment({});
    process.env.FACE_ASSERTION_SIGNING_KEY = pkcs8Pem(privateKey);
    process.env.FACE_ASSERTION_KEY_ID = KEY_ID;
    resetWalletHostCache();
    const { body } = await readback();
    expect(body.status).toBe("absent");
    expect(Object.keys(body)).toEqual(LEGACY_KEYS);
  });
});
