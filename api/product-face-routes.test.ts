/**
 * @jest-environment node
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ResponseError } from "@/api/web-sdk/runtime";
import { DEFAULT_ORGANIZATION_ID } from "@/api/tenant";
import {
  ARTIFACT_HEX,
  bindingInput,
  CHECKSUM_HOLDER,
  HOLDER,
  TEMPLATE_A,
} from "@/test/product-face-fixtures";

const getWallet = jest.fn();
const getObjectById = jest.fn();
const getObjectByIdPublic = jest.fn();
jest.mock("@/api/web-sdk-client", () => ({
  getWalletsApi: () => ({ getWallet, logout: jest.fn() }),
  getObjectsApi: () => ({ getObjectById, getObjectByIdPublic }),
}));
// Artifact verification is the real one for every test; only the navigation
// regression stands in a verified artifact for its own context reads.
jest.mock("@/api/face-artifact", () => {
  const actual = jest.requireActual("@/api/face-artifact");
  return { ...actual, verifyFaceArtifact: jest.fn(actual.verifyFaceArtifact) };
});

import {
  establishSession,
  sealForPurpose,
  unsealForPurpose,
} from "@/api/server-session";
import { resetIssueGuard } from "@/api/product-face-operations";
import {
  resetFaceArtifactCache,
  verifyFaceArtifact,
} from "@/api/face-artifact";
import { GET as contextGET } from "@/app/api/faces/[slug]/context/route";
import { POST as selectionPOST } from "@/app/api/faces/[slug]/selection/route";
import {
  GET as operationsGET,
  POST as operationsPOST,
} from "@/app/api/faces/[slug]/operations/route";
import { GET as statusGET } from "@/app/api/faces/[slug]/operations/[operationId]/route";
import { POST as assertionsPOST } from "@/app/api/faces/[slug]/assertions/route";
import { POST as proposalPOST } from "@/app/api/faces/[slug]/settle-proposal/route";
import { POST as logoutPOST } from "@/app/api/session/logout/route";
import {
  listFaceOperations,
  loadProductFaceContext,
  mintFaceAssertion,
  readFaceOperationStatus,
} from "@/app/_services/product-face.client";
import { MAX_FACE_LAUNCHES } from "@/api/face-journal";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";

const UNIT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const LINKED_WARRANTY = {
  purpose: "claims-warranty",
  applicationId: "tig.claims.morrow-warranty",
  origin: "https://warranty.example",
  instanceId: "tig-app-warranty0001",
};
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const SLUG = "morrow-home";
// r6: the face's hash over its entire exact runtime registrations body.
const REQUEST_HASH = `sha256:${"d".repeat(64)}`;
const keys = generateKeyPairSync("ed25519");

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function smartObject(
  id: string,
  owner: string,
  custom: Record<string, unknown> = { state: "Registered" },
  templateId = TEMPLATE_A,
) {
  return {
    id,
    templateId,
    owner,
    custom: { recordId: "rec-0001", ...custom },
    metadata: { name: `Arc grinder ${id.slice(0, 4)}` },
    whenModified: new Date("2026-10-01T00:00:00Z"),
  };
}

class Browser {
  cookies = new Map<string, string>();
  /** The host's launch id for the face frame this browser has open. */
  launchId = `launch-${"x".repeat(28)}`;

  constructor() {
    const response = NextResponse.json({});
    establishSession(
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
    );
    this.take(response);
  }

  take(response: Response) {
    const jar = (response as NextResponse).cookies;
    for (const cookie of jar.getAll()) {
      if (cookie.value) this.cookies.set(cookie.name, cookie.value);
      else this.cookies.delete(cookie.name);
    }
    return response;
  }

  request(path: string, body?: unknown) {
    return new NextRequest(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        cookie: Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; "),
        "x-dual-face-launch": this.launchId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async call<P>(
    handler: (
      request: NextRequest,
      context: { params: Promise<P> },
    ) => Promise<Response>,
    path: string,
    params: P,
    body?: unknown,
  ) {
    const response = this.take(
      await handler(this.request(path, body), {
        params: Promise.resolve(params),
      }),
    );
    return { status: response.status, body: await response.json() };
  }
}

const slugParams = { slug: SLUG };
const operations = (browser: Browser, body: unknown) =>
  browser.call(
    operationsPOST,
    `/api/faces/${SLUG}/operations`,
    slugParams,
    body,
  );
const mint = (browser: Browser, body: unknown) =>
  browser.call(
    assertionsPOST,
    `/api/faces/${SLUG}/assertions`,
    slugParams,
    body,
  );
const select = (browser: Browser, objectId: string | null) =>
  browser.call(selectionPOST, `/api/faces/${SLUG}/selection`, slugParams, {
    object_id: objectId,
  });
const status = (browser: Browser, operationId: string) =>
  browser.call(statusGET, `/api/faces/${SLUG}/operations/${operationId}`, {
    slug: SLUG,
    operationId,
  });

// The bound runtime's registrations/status, answering per operation id ("down":
// unreachable). Records every call the host makes to it.
type RuntimeAnswer = { status: number; body: Record<string, unknown> } | "down";
function runtimeRegistrationStatus(answers: Record<string, RuntimeAnswer>) {
  const calls: Array<{
    url: string;
    headers: Headers;
    init: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const original = global.fetch;
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: new Headers(init.headers), init, body });
    const answer = answers[body.operationId];
    if (!answer || answer === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}
// What the Passport runtime answers for an operation it holds no journal for.
const neverRecorded = (operationId: string): RuntimeAnswer => ({
  status: 404,
  body: {
    ok: false,
    status: "not_submitted",
    reason: "face_operation_not_found",
    operationId,
    objectId: null,
  },
});
const runtimeAnswered = (
  operationId: string,
  answer: string,
  httpStatus = 200,
): RuntimeAnswer => ({
  status: httpStatus,
  body: {
    ok: answer === "registered",
    status: answer,
    operationId,
    objectId: UNIT,
  },
});
// REGISTRATION_CLOSE_AFTER_MS: provable 30 minutes after the assertion was issued.
const CLOSE_AFTER_MS = 30 * 60 * 1000;

async function issueRegistration(browser: Browser, operationId: string) {
  await confirmRegistration(browser, operationId);
  const minted = await mint(browser, {
    operation: "registration.submit",
    operation_id: operationId,
    target: { object_id: UNIT },
    request_hash: REQUEST_HASH,
  });
  expect(minted.status).toBe(200);
  return minted;
}

async function confirmRegistration(browser: Browser, operationId: string) {
  getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
  expect(
    (
      await operations(browser, {
        transition: "begin",
        kind: "registration",
        operation: "registration.submit",
        operation_id: operationId,
        object_id: UNIT,
        record_id: "rec-0001",
        request_hash: REQUEST_HASH,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await operations(browser, {
        transition: "confirm",
        operation_id: operationId,
      })
    ).status,
  ).toBe(200);
}

beforeEach(() => {
  process.env.PRODUCT_FACE_APPLICATIONS = JSON.stringify([bindingInput()]);
  process.env.FACE_ASSERTION_KEY_ID = "wallet-face-test";
  process.env.FACE_ASSERTION_SIGNING_KEY = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  resetIssueGuard();
  resetFaceArtifactCache();
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
      controller: {
        address: "0xcontroller",
        type: "SECP256K1",
        custody: "custodial",
      },
      smartAccount: {},
    },
    whenCreated: new Date(),
    whenModified: new Date(),
  });
  getObjectById.mockReset();
  getObjectByIdPublic.mockReset();
});

afterEach(() => {
  delete process.env.PRODUCT_FACE_APPLICATIONS;
  delete process.env.FACE_ASSERTION_KEY_ID;
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
});

describe("product face BFF", () => {
  it("knows no application for an unknown slug", async () => {
    const browser = new Browser();
    const result = await browser.call(
      contextGET,
      "/api/faces/unknown/context",
      { slug: "unknown" },
    );
    expect(result).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "unknown_application" }),
    });
    expect(
      (
        await browser.call(
          assertionsPOST,
          "/api/faces/unknown/assertions",
          { slug: "unknown" },
          {},
        )
      ).status,
    ).toBe(404);
  });

  it("refuses to open a frame when the pinned artifact does not verify", async () => {
    const original = global.fetch;
    global.fetch = jest.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const result = await new Browser().call(
        contextGET,
        `/api/faces/${SLUG}/context`,
        slugParams,
      );
      expect(result).toEqual({
        status: 409,
        body: expect.objectContaining({ code: "artifact_mismatch" }),
      });
      expect(result.body).not.toHaveProperty("frameUrl");
    } finally {
      global.fetch = original;
    }
  });

  it("mints registration.submit only after a confirmed journal entry, once", async () => {
    const browser = new Browser();
    const operationId = "register-op-0001";
    expect(
      await mint(browser, {
        operation: "registration.submit",
        operation_id: operationId,
        target: { object_id: UNIT },
        request_hash: REQUEST_HASH,
      }),
    ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });

    await confirmRegistration(browser, operationId);
    const minted = await mint(browser, {
      operation: "registration.submit",
      operation_id: operationId,
      target: { object_id: UNIT },
      request_hash: REQUEST_HASH,
    });
    expect(minted.status).toBe(200);
    const claims = JSON.parse(
      Buffer.from(minted.body.assertion.split(".")[1], "base64url").toString(),
    );
    expect(claims).toMatchObject({
      holder: HOLDER,
      sub: "wallet-1",
      operation: "registration.submit",
      op_id: operationId,
      target: { object_id: UNIT },
      artifact: `sha256:${ARTIFACT_HEX}`,
      iss: "http://localhost",
      // Carried unchanged from the face; the runtime recomputes it.
      request_hash: REQUEST_HASH,
    });

    // The journal now records the issued assertion; no second mint.
    expect(
      await mint(browser, {
        operation: "registration.submit",
        operation_id: operationId,
        target: { object_id: UNIT },
        request_hash: REQUEST_HASH,
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "operation_already_submitted" },
    });
    const listed = await browser.call(
      operationsGET,
      `/api/faces/${SLUG}/operations`,
      slugParams,
    );
    expect(listed.body.operations).toEqual([
      expect.objectContaining({
        operation_id: operationId,
        phase: "assertion_issued",
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(minted.body.assertion);
  });

  it("an EIP-55 mixed-case Dual account: assertions carry the canonical lowercase holder, and the face still binds the same wallet", async () => {
    const base = await getWallet();
    getWallet.mockResolvedValue({
      ...base,
      account: { ...base.account, address: CHECKSUM_HOLDER },
    });
    const lowercase = CHECKSUM_HOLDER.toLowerCase();
    const browser = new Browser();
    const operationId = "register-op-0090";
    await confirmRegistration(browser, operationId);
    const minted = await mint(browser, {
      operation: "registration.submit",
      operation_id: operationId,
      target: { object_id: UNIT },
      request_hash: REQUEST_HASH,
    });
    expect(minted.status).toBe(200);
    const claims = JSON.parse(
      Buffer.from(minted.body.assertion.split(".")[1], "base64url").toString(),
    );
    expect(claims).toMatchObject({ holder: lowercase, sub: "wallet-1" });
    // Ownership stays case-insensitive: a unit Dual reports in either case is this wallet's.
    for (const owner of [lowercase, CHECKSUM_HOLDER]) {
      getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, owner));
      expect(
        await operations(browser, {
          transition: "begin",
          kind: "registration",
          operation: "registration.submit",
          operation_id: `register-op-009${owner === lowercase ? 1 : 2}`,
          object_id: UNIT,
          record_id: "rec-0001",
          request_hash: REQUEST_HASH,
        }),
      ).toMatchObject({
        status: 409,
        body: { code: "already_registered_to_you" },
      });
      getObjectById.mockResolvedValue(smartObject(UNIT, owner));
      const selected = await select(browser, UNIT);
      expect(selected.status).toBe(200);
      const read = await mint(browser, {
        operation: "products.private.read",
        operation_id: `read-op-009${owner === lowercase ? 1 : 2}`,
        target: { object_id: UNIT },
        request_hash: `sha256:${"1".repeat(64)}`,
        context_id: selected.body.context_id,
      });
      expect(read.status).toBe(200);
      expect(
        JSON.parse(
          Buffer.from(
            read.body.assertion.split(".")[1],
            "base64url",
          ).toString(),
        ).holder,
      ).toBe(lowercase);
    }
  });

  it("binds registration to the projection's record and the face's request hash", async () => {
    const browser = new Browser();
    getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
    const begin = (extra: Record<string, unknown>) =>
      operations(browser, {
        transition: "begin",
        kind: "registration",
        operation: "registration.submit",
        operation_id: "register-op-0050",
        object_id: UNIT,
        ...extra,
      });
    expect(await begin({ request_hash: REQUEST_HASH })).toMatchObject({
      status: 400,
      body: { code: "invalid_request" },
    });
    expect(await begin({ record_id: "rec-0001" })).toMatchObject({
      status: 400,
      body: { code: "invalid_request" },
    });
    expect(
      await begin({ record_id: "rec-9999", request_hash: REQUEST_HASH }),
    ).toMatchObject({ status: 409, body: { code: "record_mismatch" } });

    await confirmRegistration(browser, "register-op-0051");
    // A hash other than the confirmed one, or none, mints nothing.
    for (const requestHash of [`sha256:${"f".repeat(64)}`, undefined]) {
      expect(
        (
          await mint(browser, {
            operation: "registration.submit",
            operation_id: "register-op-0051",
            target: { object_id: UNIT },
            ...(requestHash ? { request_hash: requestHash } : {}),
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    const minted = await mint(browser, {
      operation: "registration.submit",
      operation_id: "register-op-0051",
      target: { object_id: UNIT },
      request_hash: REQUEST_HASH,
    });
    expect(minted.status).toBe(200);
    expect(
      JSON.parse(
        Buffer.from(
          minted.body.assertion.split(".")[1],
          "base64url",
        ).toString(),
      ).request_hash,
    ).toBe(REQUEST_HASH);
  });

  it("never accepts a holder, wallet or subject from the browser", async () => {
    const browser = new Browser();
    await confirmRegistration(browser, "register-op-0002");
    for (const extra of [
      { holder: "0xattacker" },
      { sub: "w" },
      { wallet: "w" },
    ]) {
      expect(
        await mint(browser, {
          operation: "registration.submit",
          operation_id: "register-op-0002",
          target: { object_id: UNIT },
          request_hash: REQUEST_HASH,
          ...extra,
        }),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    }
  });

  it("fails closed with 503 when unprovisioned and issues nothing", async () => {
    const browser = new Browser();
    await confirmRegistration(browser, "register-op-0003");
    delete process.env.FACE_ASSERTION_SIGNING_KEY;
    expect(
      await mint(browser, {
        operation: "registration.submit",
        operation_id: "register-op-0003",
        target: { object_id: UNIT },
        request_hash: REQUEST_HASH,
      }),
    ).toMatchObject({
      status: 503,
      body: { code: "face_assertion_unprovisioned" },
    });
    const listed = await browser.call(
      operationsGET,
      `/api/faces/${SLUG}/operations`,
      slugParams,
    );
    expect(listed.body.operations[0]).toMatchObject({ phase: "confirmed" });
  });

  it("refuses registration for another programme or an already held unit", async () => {
    const browser = new Browser();
    const begin = (operationId: string) =>
      operations(browser, {
        transition: "begin",
        kind: "registration",
        operation: "registration.submit",
        operation_id: operationId,
        object_id: UNIT,
        record_id: "rec-0001",
        request_hash: REQUEST_HASH,
      });
    getObjectByIdPublic.mockResolvedValue(
      smartObject(UNIT, "0xissuer", {}, "000000000000000000000000"),
    );
    expect(await begin("register-op-0010")).toMatchObject({
      status: 404,
      body: { code: "not_in_programme" },
    });
    getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, HOLDER));
    expect(await begin("register-op-0011")).toMatchObject({
      status: 409,
      body: { code: "already_registered_to_you" },
    });
    getObjectByIdPublic.mockResolvedValue(
      smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
    );
    expect(await begin("register-op-0012")).toMatchObject({
      status: 409,
      body: { code: "ownership_moved_state_pending" },
    });
  });

  it("reconciles status read-only from the journal and canonical readback", async () => {
    const browser = new Browser();
    const operationId = "register-op-0020";
    await confirmRegistration(browser, operationId);
    await mint(browser, {
      operation: "registration.submit",
      operation_id: operationId,
      target: { object_id: UNIT },
      request_hash: REQUEST_HASH,
    });
    getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
    expect((await status(browser, operationId)).body).toMatchObject({
      status: "outcome_unknown",
      readback: { owner_is_you: false },
    });
    // Owner equality with a pending transfer is NOT registered; and the
    // unit's state is this operation's only when the runtime journalled it.
    getObjectByIdPublic.mockResolvedValue(
      smartObject(UNIT, HOLDER, {
        state: "Transfer pending",
        lifecycle: { target_state: "Registered" },
      }),
    );
    const pending = runtimeRegistrationStatus({
      [operationId]: runtimeAnswered(
        operationId,
        "ownership_moved_state_pending",
      ),
    });
    try {
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "ownership_moved_state_pending",
        readback: { owner_is_you: true, state: "Transfer pending" },
      });
    } finally {
      pending.restore();
    }
    const unrecorded = runtimeRegistrationStatus({
      [operationId]: neverRecorded(operationId),
    });
    try {
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "outcome_unknown",
        readback: { owner_is_you: true, state: "Transfer pending" },
      });
    } finally {
      unrecorded.restore();
    }
    getObjectByIdPublic.mockResolvedValue(
      smartObject(UNIT, HOLDER, { state: "Registered" }),
    );
    // The readback names the unit, not the operation: registered (and
    // settled) only when the runtime says THIS operation registered.
    const unreachable = runtimeRegistrationStatus({ [operationId]: "down" });
    try {
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "outcome_unknown",
        phase: "assertion_issued",
      });
    } finally {
      unreachable.restore();
    }
    const runtime = runtimeRegistrationStatus({
      [operationId]: runtimeAnswered(operationId, "registered"),
    });
    try {
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "registered",
      });
      expect(runtime.calls).toHaveLength(1);
      // Settled: answered from the journal, the runtime is not asked again.
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "registered",
        phase: "settled",
      });
      expect(runtime.calls).toHaveLength(1);
    } finally {
      runtime.restore();
    }
  });

  it("closes a registration the runtime refused before recording it (401) only once it provably never ran, and keeps it", async () => {
    // The hosted case: Dual names the account in EIP-55 mixed case; the
    // runtime refused the face's POST /registrations with 401
    // face_assertion_claims_invalid before it recorded anything.
    const account = await getWallet();
    getWallet.mockResolvedValue({
      ...account,
      account: { ...account.account, address: CHECKSUM_HOLDER },
    });
    const browser = new Browser();
    const operationId = "reg-bae6ab93779af98103c0";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [operationId]: neverRecorded(operationId),
    });
    try {
      await issueRegistration(browser, operationId);
      getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
      // Check status before it is provable: unknown, and the runtime is not
      // asked (nothing to attribute, nothing to close yet).
      for (const at of [5 * 60 * 1000, CLOSE_AFTER_MS - 1000]) {
        clock.mockReturnValue(issuedAt + at);
        expect((await status(browser, operationId)).body).toMatchObject({
          status: "outcome_unknown",
          phase: "assertion_issued",
        });
      }
      expect(runtime.calls).toHaveLength(0);
      // Provable: one read-only status read for exactly this operation, and
      // the runtime holds no journal for it, so it never ran and never can.
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect((await status(browser, operationId)).body).toMatchObject({
        operation_id: operationId,
        kind: "registration",
        status: "not_submitted",
        phase: "settled",
      });
      expect(runtime.calls).toHaveLength(1);
      const [call] = runtime.calls;
      expect(call.url).toBe(
        "https://faces.example/api/product-face/v1/registrations/status",
      );
      expect(call.headers.get("x-tig-product-face-application")).toBe(
        "tig.passport.morrow-home",
      );
      expect(call.headers.get("origin")).toBeNull();
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.init.credentials).toBe("omit");
      expect(Object.keys(call.body).sort()).toEqual([
        "assertion",
        "operationId",
      ]);
      const claims = JSON.parse(
        Buffer.from(
          String(call.body.assertion).split(".")[1],
          "base64url",
        ).toString("utf8"),
      );
      expect(claims).toMatchObject({
        operation: "registration.status",
        op_id: operationId,
        target: { object_id: UNIT },
        holder: CHECKSUM_HOLDER.toLowerCase(),
        request_hash: `sha256:${createHash("sha256")
          .update(JSON.stringify({ operationId }))
          .digest("hex")}`,
      });
      // Kept, closed with its reason (the sealed journal holds the closure).
      const listed = await browser.call(
        operationsGET,
        `/api/faces/${SLUG}/operations`,
        slugParams,
      );
      expect(listed.body.operations).toEqual([
        expect.objectContaining({
          operation_id: operationId,
          phase: "settled",
          status: "not_submitted",
        }),
      ]);
      // The unit later registered to this wallet by a NEW operation: the
      // closed one still never ran, and the runtime is not asked again.
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, CHECKSUM_HOLDER, { state: "Registered" }),
      );
      expect((await status(browser, operationId)).body).toMatchObject({
        status: "not_submitted",
        phase: "settled",
      });
      expect(runtime.calls).toHaveLength(1);
      // Never minted for submission again; the face's own status read still is.
      expect(
        await mint(browser, {
          operation: "registration.submit",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: REQUEST_HASH,
        }),
      ).toMatchObject({
        status: 409,
        body: { code: "operation_already_submitted" },
      });
      expect(
        (
          await mint(browser, {
            operation: "registration.status",
            operation_id: operationId,
            target: { object_id: UNIT },
            request_hash: `sha256:${"e".repeat(64)}`,
          })
        ).status,
      ).toBe(200);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("never attributes a later registration of the same unit to an earlier open operation", async () => {
    const browser = new Browser();
    const earlier = "register-op-0201";
    const later = "register-op-0202";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [earlier]: neverRecorded(earlier),
      [later]: runtimeAnswered(later, "registered"),
    });
    try {
      await issueRegistration(browser, earlier);
      clock.mockReturnValue(issuedAt + 60 * 1000);
      await issueRegistration(browser, later);
      // The later operation moved the unit to this wallet, state pending:
      // that is not the earlier operation's state either.
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
      );
      expect((await status(browser, earlier)).body).toMatchObject({
        status: "outcome_unknown",
        phase: "assertion_issued",
      });
      // The later operation registered the unit to this wallet.
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Registered" }),
      );
      clock.mockReturnValue(issuedAt + 2 * 60 * 1000);
      expect((await status(browser, later)).body).toMatchObject({
        status: "registered",
      });
      // The earlier one is not that registration: unknown until provable.
      expect((await status(browser, earlier)).body).toMatchObject({
        status: "outcome_unknown",
        phase: "assertion_issued",
      });
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect((await status(browser, earlier)).body).toMatchObject({
        status: "not_submitted",
        phase: "settled",
      });
      expect((await status(browser, later)).body).toMatchObject({
        status: "registered",
        phase: "settled",
      });
      expect(runtime.calls.map((call) => call.body.operationId)).toEqual([
        earlier,
        later,
        earlier,
        earlier,
      ]);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("closes nothing on any other runtime answer past the point it could run", async () => {
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const id = (index: number) =>
      `register-op-03${String(index).padStart(2, "0")}`;
    const answers: RuntimeAnswer[] = [
      "down",
      {
        status: 503,
        body: {
          status: "refused",
          reason: "face_runtime_unprovisioned",
          operationId: id(1),
        },
      },
      // The runtime holds a journal for it: whatever it says, it was accepted.
      runtimeAnswered(id(2), "outcome_unknown", 202),
      runtimeAnswered(id(3), "refused", 200),
      // Not found, but not the journal (another reason or another operation).
      {
        status: 404,
        body: {
          status: "not_submitted",
          reason: "face_record_not_found",
          operationId: id(4),
        },
      },
      {
        status: 404,
        body: {
          status: "not_submitted",
          reason: "face_operation_not_found",
          operationId: "register-op-9999",
        },
      },
      {
        status: 403,
        body: {
          status: "refused",
          reason: "face_operation_not_yours",
          operationId: id(6),
        },
      },
    ];
    const runtime = runtimeRegistrationStatus(
      Object.fromEntries(answers.map((answer, index) => [id(index), answer])),
    );
    try {
      for (let index = 0; index < answers.length; index += 1) {
        const browser = new Browser();
        clock.mockReturnValue(issuedAt);
        await issueRegistration(browser, id(index));
        getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
        clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 60 * 1000);
        expect((await status(browser, id(index))).body).toMatchObject({
          status: "outcome_unknown",
          phase: "assertion_issued",
        });
      }
      expect(runtime.calls).toHaveLength(answers.length);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("mints product-scoped reads only for the current server-side selection", async () => {
    const browser = new Browser();
    getObjectById.mockImplementation(async ({ objectId }) =>
      smartObject(objectId, HOLDER),
    );
    const read = (contextId: string | undefined, objectId: string) =>
      mint(browser, {
        operation: "products.private.read",
        operation_id: "read-op-0001",
        target: { object_id: objectId },
        request_hash: `sha256:${"1".repeat(64)}`,
        ...(contextId ? { context_id: contextId } : {}),
      });
    expect(await read(undefined, UNIT)).toMatchObject({
      status: 409,
      body: { code: "stale_context" },
    });
    const first = await select(browser, UNIT);
    expect(first.status).toBe(200);
    expect((await read(first.body.context_id, UNIT)).status).toBe(200);
    const second = await select(browser, OTHER);
    expect(second.body.context_id).not.toBe(first.body.context_id);
    // After a product switch nothing is minted for the old context.
    expect(await read(first.body.context_id, UNIT)).toMatchObject({
      status: 409,
      body: { code: "stale_context" },
    });
    getObjectById.mockResolvedValue(smartObject(UNIT, "0xsomeoneelse"));
    expect(await select(browser, UNIT)).toMatchObject({
      status: 403,
      body: { code: "not_owned" },
    });
  });

  it("caps outstanding unexpired assertions per launch", async () => {
    const browser = new Browser();
    getObjectById.mockResolvedValue(smartObject(UNIT, HOLDER));
    const { body } = await select(browser, UNIT);
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const result = await mint(browser, {
        operation: "products.private.read",
        operation_id: `read-op-${String(index).padStart(4, "0")}`,
        target: { object_id: UNIT },
        request_hash: `sha256:${"2".repeat(64)}`,
        context_id: body.context_id,
      });
      statuses.push(result.status);
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
  });

  it("binds quote decisions to the quote the wallet read itself", async () => {
    // contract r10: case operations belong to the linked Warranty runtime.
    process.env.PRODUCT_FACE_APPLICATIONS = JSON.stringify([
      bindingInput({ linkedRuntimes: [LINKED_WARRANTY] }),
    ]);
    const browser = new Browser();
    getObjectById.mockResolvedValue(smartObject(UNIT, HOLDER));
    const { body } = await select(browser, UNIT);
    const original = global.fetch;
    const runtimeCalls: Array<Record<string, unknown>> = [];
    // The runtime's case view carries its quote version as an integer
    // (contract r10); anything else is not the contract.
    let runtimeQuoteVersion: unknown = 2;
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      // The linked runtime's fixed endpoint and routing header, no browser
      // Origin or cookies.
      expect(url).toBe(
        "https://warranty.example/api/product-face/v1/operations",
      );
      const headers = new Headers(init.headers);
      expect(headers.get("x-tig-product-face-application")).toBe(
        "tig.claims.morrow-warranty",
      );
      expect(headers.get("origin")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(init.credentials).toBe("omit");
      runtimeCalls.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          case: {
            case_id: "case-1",
            quote: {
              quote_version: runtimeQuoteVersion,
              provider: "Morrow Service Centre",
              amount: "149.90",
              currency: "EUR",
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      // A case view whose quote version is not the contract's integer is
      // never shown or bound: quote_unavailable, nothing journalled.
      runtimeQuoteVersion = "2";
      const unparsed = await operations(browser, {
        transition: "begin",
        kind: "runtime",
        operation: "case.quote.approve",
        operation_id: "quote-op-0000",
        object_id: UNIT,
        case_id: "case-1",
        context_id: body.context_id,
      });
      expect(unparsed).toMatchObject({
        status: 502,
        body: { code: "quote_unavailable" },
      });
      runtimeQuoteVersion = 2;
      runtimeCalls.length = 0;
      const begun = await operations(browser, {
        transition: "begin",
        kind: "runtime",
        operation: "case.quote.approve",
        operation_id: "quote-op-0001",
        object_id: UNIT,
        case_id: "case-1",
        context_id: body.context_id,
      });
      expect(begun.body.quote).toEqual({
        case_id: "case-1",
        quote_version: 2,
        provider: "Morrow Service Centre",
        amount: "149.90",
        currency: "EUR",
      });
      expect(runtimeCalls).toEqual([
        expect.objectContaining({
          operation: "case.read",
          target: { object_id: UNIT, case_id: "case-1" },
        }),
      ]);
      await operations(browser, {
        transition: "confirm",
        operation_id: "quote-op-0001",
        context_id: body.context_id,
      });
      const approve = (amount: string, change: Record<string, unknown> = {}) =>
        mint(browser, {
          operation: "case.quote.approve",
          operation_id: "quote-op-0001",
          target: {
            object_id: UNIT,
            case_id: "case-1",
            quote_version: 2,
            amount,
            currency: "EUR",
            ...change,
          },
          request_hash: `sha256:${"3".repeat(64)}`,
          context_id: body.context_id,
        });
      expect(await approve("99.00")).toMatchObject({
        status: 409,
        body: { code: "quote_changed" },
      });
      // A stale version or currency is bound to nothing: quote_changed.
      for (const change of [{ quote_version: 1 }, { currency: "USD" }]) {
        expect(await approve("149.90", change)).toMatchObject({
          status: 409,
          body: { code: "quote_changed" },
        });
      }
      // A version that is not the contract's integer is not a target at all.
      for (const quote_version of ["2", 0, 1.5, null]) {
        expect(await approve("149.90", { quote_version })).toMatchObject({
          status: 400,
          body: { code: "invalid_request" },
        });
      }
      const approved = await approve("149.90");
      expect(approved.status).toBe(200);
      // r10: the Warranty runtime is the audience; the artifact is the face's.
      const claims = JSON.parse(
        Buffer.from(
          approved.body.assertion.split(".")[1],
          "base64url",
        ).toString("utf8"),
      );
      expect(claims).toMatchObject({
        aud: "tig.claims.morrow-warranty@https://warranty.example",
        app_id: "tig.passport.morrow-home",
        artifact: `sha256:${ARTIFACT_HEX}`,
        origin: "https://faces.example",
        operation: "case.quote.approve",
      });
      const readClaims = JSON.parse(
        Buffer.from(
          String(runtimeCalls[0].assertion).split(".")[1],
          "base64url",
        ).toString("utf8"),
      );
      expect(readClaims.aud).toBe(
        "tig.claims.morrow-warranty@https://warranty.example",
      );
      // The runtime was read once; no payment endpoint exists or was called.
      expect(runtimeCalls).toHaveLength(1);
    } finally {
      global.fetch = original;
    }
  });

  it("mints case operations only for a linked Warranty runtime; others keep the face audience", async () => {
    const browser = new Browser();
    getObjectById.mockResolvedValue(smartObject(UNIT, HOLDER));
    const { body } = await select(browser, UNIT);
    const request = (operation: string) =>
      mint(browser, {
        operation,
        operation_id: "read-op-0001",
        target:
          operation === "case.read"
            ? { object_id: UNIT, case_id: "case-1" }
            : { object_id: UNIT },
        request_hash: `sha256:${"4".repeat(64)}`,
        context_id: body.context_id,
      });
    expect(await request("case.read")).toMatchObject({
      status: 409,
      body: { code: "case_runtime_not_linked" },
    });
    const own = await request("products.private.read");
    expect(own.status).toBe(200);
    expect(
      JSON.parse(
        Buffer.from(own.body.assertion.split(".")[1], "base64url").toString(
          "utf8",
        ),
      ).aud,
    ).toBe("tig.passport.morrow-home@https://faces.example");
  });

  it("obtains and validates the settle proposal itself", async () => {
    getObjectById.mockResolvedValue(
      smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
    );
    const proposalInput = {
      custom: {
        recordId: "rec-0001",
        state: "Authenticity verified",
        lifecycle: { target_state: "Authenticity verified" },
      },
    };
    const canonical = (input: unknown, objectId = UNIT) =>
      JSON.stringify({ action: "update", input, object_id: objectId });
    const respond = (proposal: Record<string, unknown>) => {
      global.fetch = jest.fn(
        async () => new Response(JSON.stringify({ proposal }), { status: 200 }),
      ) as unknown as typeof fetch;
    };
    const good = {
      proposal_id: "proposal-1",
      operation_id: "register-op-0030",
      object_id: UNIT,
      action: "update",
      input: proposalInput,
      proposal_hash: `sha256:${createHash("sha256")
        .update(
          '{"action":"update","input":{"custom":{"lifecycle":{"target_state":"Authenticity verified"},"recordId":"rec-0001","state":"Authenticity verified"}},"object_id":"' +
            UNIT +
            '"}',
        )
        .digest("hex")}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(canonical(proposalInput)).toContain("Authenticity verified");
    const original = global.fetch;
    const request = async () => {
      const browser = new Browser();
      const { body } = await select(browser, UNIT);
      return browser.call(
        proposalPOST,
        `/api/faces/${SLUG}/settle-proposal`,
        slugParams,
        {
          context_id: body.context_id,
          operation_id: "register-op-0030",
          object_id: UNIT,
        },
      );
    };
    try {
      respond(good);
      expect(await request()).toMatchObject({
        status: 200,
        body: { proposal: { proposal_id: "proposal-1", object_id: UNIT } },
      });
      for (const bad of [
        { ...good, proposal_hash: `sha256:${"0".repeat(64)}` },
        { ...good, object_id: OTHER },
        { ...good, operation_id: "register-op-9999" },
        { ...good, expires_at: new Date(Date.now() - 1000).toISOString() },
        { ...good, action: "claim_ownership" },
        {
          ...good,
          input: { custom: { ...proposalInput.custom, owner: "0xattacker" } },
        },
        {
          ...good,
          input: { custom: { ...proposalInput.custom, state: "Registered" } },
        },
      ]) {
        respond(bad);
        expect(await request()).toMatchObject({
          status: 422,
          body: { code: "proposal_rejected" },
        });
      }
      // G6b: no proposal right now, and why; the reason reaches the host as
      // the runtime stated it (a refusal is never reported as a quote change).
      for (const reason of [
        "issuer_preauthorisation_absent",
        "issuer_preauthorisation_expired",
        "issuer_auto_proposal_used",
      ]) {
        global.fetch = jest.fn(
          async () =>
            new Response(
              JSON.stringify({
                ok: false,
                status: "settle_proposal_unavailable",
                reason,
                nextStep: "brand_operator_proposal",
              }),
              { status: 409 },
            ),
        ) as unknown as typeof fetch;
        expect(await request()).toMatchObject({
          status: 409,
          body: { code: "settle_proposal_unavailable", reason },
        });
      }
      // An unknown reason is not passed on.
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              status: "settle_proposal_unavailable",
              reason: "something_else",
            }),
            { status: 409 },
          ),
      ) as unknown as typeof fetch;
      const unknownReason = await request();
      expect(unknownReason).toMatchObject({
        status: 409,
        body: { code: "settle_proposal_unavailable" },
      });
      expect(unknownReason.body).not.toHaveProperty("reason");
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              status: "face_settle_proposal_required",
            }),
            { status: 409 },
          ),
      ) as unknown as typeof fetch;
      expect(await request()).toMatchObject({
        status: 409,
        body: { code: "proposal_rejected" },
      });
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, status: "settle_not_required" }),
            { status: 409 },
          ),
      ) as unknown as typeof fetch;
      expect(await request()).toMatchObject({
        status: 409,
        body: { code: "settle_not_required" },
      });
      getObjectById.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Registered" }),
      );
      respond(good);
      expect(await request()).toMatchObject({
        status: 409,
        body: { code: "settle_not_required" },
      });
    } finally {
      global.fetch = original;
    }
  });

  it("passes on the runtime's stale and release-changed refusals so the brand proposes again; other reasons stay dropped", async () => {
    getObjectById.mockResolvedValue(
      smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
    );
    // The Studio face runtime's own refusal: its status, reason, next step
    // and detail text, as registration.settle.propose answers it.
    const refuse = (reason: string, detail: string) => {
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              status: "settle_proposal_unavailable",
              code: "settle_proposal_unavailable",
              reason,
              nextStep: "brand_operator_proposal",
              detail,
              blindRetryAllowed: false,
              secretReturned: false,
            }),
            { status: 409 },
          ),
      ) as unknown as typeof fetch;
    };
    const request = async () => {
      const browser = new Browser();
      const { body } = await select(browser, UNIT);
      return browser.call(
        proposalPOST,
        `/api/faces/${SLUG}/settle-proposal`,
        slugParams,
        {
          context_id: body.context_id,
          operation_id: "register-op-0031",
          object_id: UNIT,
        },
      );
    };
    const original = global.fetch;
    try {
      for (const [reason, detail] of [
        [
          "face_settle_proposal_stale",
          "The brand's confirmation was prepared for an earlier version of this product's record, so the brand proposes it again from its operator home. Nothing was changed.",
        ],
        [
          "face_settle_proposal_release_changed",
          "The brand's confirmation was prepared for an earlier version of the app, so the brand proposes it again from its operator home. Nothing was changed.",
        ],
      ]) {
        refuse(reason, detail);
        const refused = await request();
        expect(refused).toEqual({
          status: 409,
          // The reason only: never the runtime's detail text.
          body: { code: "settle_proposal_unavailable", reason },
        });
      }
      // Not on the allowlist: a real runtime reason the wallet has no copy
      // for, a near miss and free text are not passed on.
      for (const reason of [
        "face_settle_proposal_expired",
        "face_settle_proposal_stale_v2",
        "Face_settle_proposal_stale",
        "The brand proposes it again",
      ]) {
        refuse(reason, "Nothing was changed.");
        const dropped = await request();
        expect(dropped).toMatchObject({
          status: 409,
          body: { code: "settle_proposal_unavailable" },
        });
        expect(dropped.body).not.toHaveProperty("reason");
        expect(JSON.stringify(dropped.body)).not.toContain(
          "Nothing was changed",
        );
      }
    } finally {
      global.fetch = original;
    }
  });

  it("clears the session and journal on logout; a terminal 401 clears the session and keeps the sealed journal", async () => {
    const browser = new Browser();
    await confirmRegistration(browser, "register-op-0040");
    const journalCookie = `dual_face_launch_${browser.launchId}`;
    expect(browser.cookies.has(journalCookie)).toBe(true);
    const logout = await browser.call(
      (request: NextRequest) => logoutPOST(request),
      "/api/session/logout",
      {},
      {},
    );
    expect(logout.status).toBe(200);
    expect(browser.cookies.has(journalCookie)).toBe(false);
    expect(browser.cookies.has("smarttoken_viewer")).toBe(false);

    const expired = new Browser();
    const operationId = "register-op-0041";
    await issueRegistration(expired, operationId);
    const kept = `dual_face_launch_${expired.launchId}`;
    const sealed = expired.cookies.get(kept);
    expect(sealed).toBeTruthy();
    const account = await getWallet();
    getWallet.mockRejectedValue(
      new ResponseError(new Response(null, { status: 401 })),
    );
    // The face's own status read is what sees the session end.
    const result = await status(expired, operationId);
    expect(result.status).toBe(401);
    expect(expired.cookies.has("smarttoken_viewer")).toBe(false);
    // As /api/session does when it sees the session end: the launch journal
    // stays as it was, sealed to the ended session (no session reads it as
    // its own); only sign-out clears it.
    expect(expired.cookies.get(kept)).toBe(sealed);
    // So the same wallet, signed in again, still reaches that operation.
    getWallet.mockResolvedValue(account);
    const again = signInAgain(expired);
    expect(again.cookies.has("smarttoken_viewer")).toBe(true);
    expect(await status(again, operationId)).toMatchObject({
      status: 200,
      body: { operation_id: operationId, kind: "registration" },
    });
  });
});

/**
 * The same browser signed in again: a new session (a new session id) and the
 * face host remounted with a fresh launch id. The launch journal cookies the
 * browser held stay in the jar, as a browser keeps them.
 */
function signInAgain(browser: Browser, launchId = `launch-${"y".repeat(28)}`) {
  const next = new Browser();
  for (const [name, value] of browser.cookies) {
    if (name.startsWith("dual_face_launch_")) next.cookies.set(name, value);
  }
  next.launchId = launchId;
  return next;
}

/** The same session, the face host remounted with a fresh launch id. */
function reload(browser: Browser, launchId: string) {
  const next = new Browser();
  next.cookies = new Map(browser.cookies);
  next.launchId = launchId;
  return next;
}

function claimsOf(assertion: unknown) {
  return JSON.parse(
    Buffer.from(String(assertion).split(".")[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("registration history after a fresh sign-in (exact operation, read-only)", () => {
  it("the same wallet signed in again reaches the exact definitive status of a registration an earlier session issued, from that session's sealed evidence", async () => {
    const operationId = "register-op-0501";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [operationId]: neverRecorded(operationId),
    });
    try {
      const earlier = new Browser();
      const issued = await issueRegistration(earlier, operationId);
      const evidenceName = `dual_face_launch_${earlier.launchId}`;
      const evidence = earlier.cookies.get(evidenceName)!;
      expect(evidence).toBeTruthy();
      getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));

      // A reload in that same session (a fresh launch) finds it too.
      const reloaded = reload(earlier, `launch-${"r".repeat(28)}`);
      clock.mockReturnValue(issuedAt + 60 * 1000);
      expect(await status(reloaded, operationId)).toMatchObject({
        status: 200,
        body: { operation_id: operationId, status: "outcome_unknown" },
      });

      const again = signInAgain(earlier);
      // Before it is provable: the operation is known, its outcome is not
      // (and the runtime is not asked: nothing to attribute or close yet).
      clock.mockReturnValue(issuedAt + 5 * 60 * 1000);
      expect(await status(again, operationId)).toEqual({
        status: 200,
        body: {
          operation_id: operationId,
          kind: "registration",
          phase: "assertion_issued",
          status: "outcome_unknown",
          object_id: UNIT,
          readback: { owner_is_you: false, state: "Registered" },
        },
      });
      expect(runtime.calls).toHaveLength(0);

      // Provable: the same one read-only status read for exactly this
      // operation, by the wallet's own current session, and the runtime holds
      // no journal for it: it never ran and never can.
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect(await status(again, operationId)).toMatchObject({
        status: 200,
        body: {
          operation_id: operationId,
          kind: "registration",
          phase: "settled",
          status: "not_submitted",
          object_id: UNIT,
        },
      });
      expect(runtime.calls).toHaveLength(1);
      const read = claimsOf(runtime.calls[0].body.assertion);
      const original = claimsOf(issued.body.assertion);
      expect(read).toMatchObject({
        operation: "registration.status",
        op_id: operationId,
        target: { object_id: UNIT },
        sub: original.sub,
        holder: original.holder,
      });
      // Under the new session, never the ended one's.
      expect(read.sid_hash).not.toBe(original.sid_hash);

      // The earlier session's sealed evidence is kept exactly as it was:
      // neither deleted nor re-sealed under the new session.
      expect(again.cookies.get(evidenceName)).toBe(evidence);
      // Derived again on every read, the same answer; nothing kept for it.
      expect((await status(again, operationId)).body).toMatchObject({
        status: "not_submitted",
        phase: "settled",
      });
      expect(runtime.calls).toHaveLength(2);
      expect(again.cookies.get(evidenceName)).toBe(evidence);

      // Ordinary writes of the new session keep it too.
      getObjectById.mockResolvedValue(smartObject(OTHER, HOLDER));
      expect((await select(again, OTHER)).status).toBe(200);
      expect(again.cookies.has(`dual_face_launch_${again.launchId}`)).toBe(
        true,
      );
      expect(again.cookies.get(evidenceName)).toBe(evidence);
      expect((await status(again, operationId)).body).toMatchObject({
        status: "not_submitted",
      });
      // The new launch's own journal never holds it.
      const listed = await again.call(
        operationsGET,
        `/api/faces/${SLUG}/operations`,
        slugParams,
      );
      expect(listed.body.operations).toEqual([]);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("gives another account signed in on the same browser nothing, and that account's first write drops it", async () => {
    const operationId = "register-op-0502";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [operationId]: neverRecorded(operationId),
    });
    try {
      const earlier = new Browser();
      await issueRegistration(earlier, operationId);
      const evidenceName = `dual_face_launch_${earlier.launchId}`;
      const account = await getWallet();
      getWallet.mockResolvedValue({
        ...account,
        id: "wallet-2",
        account: {
          ...account.account,
          address: "0x00000000000000000000000000000000000000b2",
        },
      });
      const other = signInAgain(earlier);
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect(await status(other, operationId)).toMatchObject({
        status: 404,
        body: { code: "unknown_operation" },
      });
      expect(
        await mint(other, {
          operation: "registration.status",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: `sha256:${"e".repeat(64)}`,
        }),
      ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      expect(runtime.calls).toHaveLength(0);
      // Its own first journal write drops the other wallet's journal.
      await confirmRegistration(other, "register-op-0503");
      expect(other.cookies.has(evidenceName)).toBe(false);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("never credits a later registration of the same unit, by the new session, to the earlier session's operation", async () => {
    const earlierId = "register-op-0511";
    const laterId = "register-op-0512";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [earlierId]: neverRecorded(earlierId),
      [laterId]: runtimeAnswered(laterId, "registered"),
    });
    try {
      const earlier = new Browser();
      await issueRegistration(earlier, earlierId);
      const evidenceName = `dual_face_launch_${earlier.launchId}`;
      const evidence = earlier.cookies.get(evidenceName)!;
      const again = signInAgain(earlier);
      clock.mockReturnValue(issuedAt + 60 * 1000);
      await issueRegistration(again, laterId);
      // The new session's own journal writes keep the earlier evidence.
      expect(again.cookies.get(evidenceName)).toBe(evidence);
      // The later operation registered the unit to this wallet.
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Registered" }),
      );
      clock.mockReturnValue(issuedAt + 2 * 60 * 1000);
      expect((await status(again, earlierId)).body).toMatchObject({
        operation_id: earlierId,
        status: "outcome_unknown",
        phase: "assertion_issued",
      });
      expect((await status(again, laterId)).body).toMatchObject({
        operation_id: laterId,
        status: "registered",
      });
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect((await status(again, earlierId)).body).toMatchObject({
        operation_id: earlierId,
        status: "not_submitted",
        phase: "settled",
      });
      expect((await status(again, laterId)).body).toMatchObject({
        status: "registered",
        phase: "settled",
      });
      // Each read names exactly its own operation.
      expect(runtime.calls.map((call) => call.body.operationId)).toEqual([
        earlierId,
        laterId,
        earlierId,
      ]);
      expect(again.cookies.get(evidenceName)).toBe(evidence);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("lets a recovered operation authorise nothing but its own read-only status read: no submit, no new begin under its id, no transition", async () => {
    const operationId = "register-op-0521";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [operationId]: neverRecorded(operationId),
    });
    try {
      const earlier = new Browser();
      await issueRegistration(earlier, operationId);
      const evidenceName = `dual_face_launch_${earlier.launchId}`;
      const evidence = earlier.cookies.get(evidenceName)!;
      const again = signInAgain(earlier);
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      expect((await status(again, operationId)).body).toMatchObject({
        status: "not_submitted",
      });
      const calls = runtime.calls.length;
      expect(
        await mint(again, {
          operation: "registration.submit",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: REQUEST_HASH,
        }),
      ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      // The read-only status read takes only its own exact request hash.
      expect(
        await mint(again, {
          operation: "registration.status",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: REQUEST_HASH,
        }),
      ).toMatchObject({ status: 409, body: { code: "operation_conflict" } });
      // Never begun again under its id, so never confirmed, minted or
      // submitted anew, whatever the face asks.
      getObjectByIdPublic.mockResolvedValue(smartObject(UNIT, "0xissuer"));
      expect(
        await operations(again, {
          transition: "begin",
          kind: "registration",
          operation: "registration.submit",
          operation_id: operationId,
          object_id: UNIT,
          record_id: "rec-0001",
          request_hash: REQUEST_HASH,
        }),
      ).toMatchObject({
        status: 409,
        body: { code: "operation_already_submitted" },
      });
      for (const transition of ["confirm", "submit"]) {
        expect(
          await operations(again, { transition, operation_id: operationId }),
        ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      }
      expect(
        await operations(again, {
          transition: "cancel",
          operation_id: operationId,
        }),
      ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      // Read-only: the refusals asked the runtime nothing more.
      expect(runtime.calls).toHaveLength(calls);
      const listed = await again.call(
        operationsGET,
        `/api/faces/${SLUG}/operations`,
        slugParams,
      );
      expect(listed.body.operations).toEqual([]);
      expect(again.cookies.get(evidenceName)).toBe(evidence);
      // A different operation id still begins as before.
      expect(
        (
          await operations(again, {
            transition: "begin",
            kind: "registration",
            operation: "registration.submit",
            operation_id: "register-op-0522",
            object_id: UNIT,
            record_id: "rec-0001",
            request_hash: REQUEST_HASH,
          })
        ).status,
      ).toBe(200);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("recovers the one issued registration when another launch resumed it (observed through the settle proposal), and nothing when a copy names another unit", async () => {
    const operationId = "register-op-0541";
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const original = global.fetch;
    let runtime: ReturnType<typeof runtimeRegistrationStatus> | undefined;
    try {
      const earlier = new Browser();
      await issueRegistration(earlier, operationId);
      const issuedName = `dual_face_launch_${earlier.launchId}`;
      const issuedEvidence = earlier.cookies.get(issuedName)!;

      // The runtime ran it: the unit moved to this wallet, its state not yet
      // settled. A reload in the same session (another launch) resumes it
      // with Finish registration: the host obtains the settle proposal for
      // exactly this original operation, and that launch's journal records
      // it as observed, under the same operation id.
      clock.mockReturnValue(issuedAt + 60 * 1000);
      const pendingUnit = smartObject(UNIT, HOLDER, {
        state: "Transfer pending",
      });
      getObjectById.mockResolvedValue(pendingUnit);
      const resumed = reload(earlier, `launch-${"b".repeat(28)}`);
      const { body: selected } = await select(resumed, UNIT);
      const input = {
        custom: {
          recordId: "rec-0001",
          state: "Authenticity verified",
          lifecycle: { target_state: "Authenticity verified" },
        },
      };
      const proposal = {
        proposal_id: "proposal-0541",
        operation_id: operationId,
        object_id: UNIT,
        action: "update",
        input,
        proposal_hash: `sha256:${createHash("sha256")
          .update(
            '{"action":"update","input":{"custom":{"lifecycle":{"target_state":"Authenticity verified"},"recordId":"rec-0001","state":"Authenticity verified"}},"object_id":"' +
              UNIT +
              '"}',
          )
          .digest("hex")}`,
        expires_at: new Date(issuedAt + 10 * 60 * 1000).toISOString(),
      };
      global.fetch = jest.fn(
        async () => new Response(JSON.stringify({ proposal }), { status: 200 }),
      ) as unknown as typeof fetch;
      expect(
        await resumed.call(
          proposalPOST,
          `/api/faces/${SLUG}/settle-proposal`,
          slugParams,
          {
            context_id: selected.context_id,
            operation_id: operationId,
            object_id: UNIT,
          },
        ),
      ).toMatchObject({
        status: 200,
        body: { proposal: { operation_id: operationId, object_id: UNIT } },
      });
      global.fetch = original;
      const observedName = `dual_face_launch_${resumed.launchId}`;
      const observedEvidence = resumed.cookies.get(observedName)!;
      const observed = unsealForPurpose(
        `dual-face-journal-v2:${resumed.launchId}`,
        observedEvidence,
      ) as { entries: Array<Record<string, unknown>> };
      expect(observed.entries).toEqual([
        expect.objectContaining({
          operationId,
          kind: "registration",
          operation: "registration.submit",
          objectId: UNIT,
          phase: "observed",
        }),
      ]);
      // Both launches' journals carry the id; only the first issued it.
      expect(resumed.cookies.get(issuedName)).toBe(issuedEvidence);

      // The same wallet signs in again; its result screen polls the original
      // operation and reaches its exact definitive status.
      runtime = runtimeRegistrationStatus({
        [operationId]: runtimeAnswered(operationId, "registered"),
      });
      const again = signInAgain(resumed);
      getObjectByIdPublic.mockResolvedValue(pendingUnit);
      clock.mockReturnValue(issuedAt + 2 * 60 * 1000);
      expect((await status(again, operationId)).body).toMatchObject({
        operation_id: operationId,
        kind: "registration",
        phase: "assertion_issued",
        status: "ownership_moved_state_pending",
        object_id: UNIT,
      });
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Authenticity verified" }),
      );
      expect((await status(again, operationId)).body).toMatchObject({
        operation_id: operationId,
        kind: "registration",
        status: "registered",
        object_id: UNIT,
        readback: { owner_is_you: true, state: "Authenticity verified" },
      });
      // Each a read of exactly that operation, under the new session.
      expect(runtime.calls.map((call) => call.body.operationId)).toEqual([
        operationId,
        operationId,
      ]);
      // Both launches' sealed journals are exactly as they were.
      expect(again.cookies.get(issuedName)).toBe(issuedEvidence);
      expect(again.cookies.get(observedName)).toBe(observedEvidence);

      // A copy under the id that names another unit is a conflict: nothing
      // is recovered, and the runtime is not asked.
      const conflict = `launch-${"k".repeat(28)}`;
      again.cookies.set(
        `dual_face_launch_${conflict}`,
        sealForPurpose(`dual-face-journal-v2:${conflict}`, {
          ...observed,
          launch: conflict,
          entries: observed.entries.map((entry) => ({
            ...entry,
            objectId: OTHER,
          })),
        }),
      );
      const calls = runtime.calls.length;
      expect(await status(again, operationId)).toMatchObject({
        status: 404,
        body: { code: "unknown_operation" },
      });
      expect(runtime.calls).toHaveLength(calls);
      // Without it, the one issued registration is recovered again.
      again.cookies.delete(`dual_face_launch_${conflict}`);
      expect((await status(again, operationId)).body).toMatchObject({
        operation_id: operationId,
        status: "registered",
      });
    } finally {
      global.fetch = original;
      runtime?.restore();
      clock.mockRestore();
    }
  });

  it("recovers nothing for a registration that never left the wallet, or an id two journals carry", async () => {
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({});
    try {
      const earlier = new Browser();
      // Confirmed, never minted: no assertion left the wallet.
      const confirmedOnly = "register-op-0531";
      await confirmRegistration(earlier, confirmedOnly);
      const twice = "register-op-0532";
      // Two launches of the session (two tabs) that both began the same id
      // before either issued it can each issue it: two journals of this
      // wallet then issued it, and which of the two it is is never guessed.
      await confirmRegistration(earlier, twice);
      const copy = `launch-${"c".repeat(28)}`;
      const tab = reload(earlier, copy);
      await confirmRegistration(tab, twice);
      for (const launch of [earlier, tab]) {
        expect(
          (
            await mint(launch, {
              operation: "registration.submit",
              operation_id: twice,
              target: { object_id: UNIT },
              request_hash: REQUEST_HASH,
            })
          ).status,
        ).toBe(200);
      }
      const again = signInAgain(earlier);
      again.cookies.set(
        `dual_face_launch_${copy}`,
        tab.cookies.get(`dual_face_launch_${copy}`)!,
      );
      clock.mockReturnValue(issuedAt + CLOSE_AFTER_MS + 1000);
      for (const operationId of [confirmedOnly, twice]) {
        expect(await status(again, operationId)).toMatchObject({
          status: 404,
          body: { code: "unknown_operation" },
        });
      }
      expect(runtime.calls).toHaveLength(0);
      // Without the copy, the issued one is recovered; the confirmed one
      // still is not.
      again.cookies.delete(`dual_face_launch_${copy}`);
      expect((await status(again, twice)).body).toMatchObject({
        operation_id: twice,
        status: "outcome_unknown",
      });
      expect((await status(again, confirmedOnly)).status).toBe(404);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });
});

// Routes the wallet's host client's relative /api/faces requests to the real
// route handlers with this browser's cookies and launch; anything else (the
// runtime) goes to the runtime double already installed.
function hostClient(browser: Browser) {
  const runtimeFetch = global.fetch;
  global.fetch = jest.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(`/api/faces/${SLUG}`)) return runtimeFetch(input, init);
    const body =
      init.body === undefined ? undefined : JSON.parse(String(init.body));
    const path = url.slice(`/api/faces/${SLUG}`.length).split("?")[0];
    const statusPath = /^\/operations\/([^/]+)$/.exec(path);
    type Handler = (
      request: NextRequest,
      context: { params: Promise<unknown> },
    ) => Promise<Response>;
    const handler = (
      statusPath
        ? statusGET
        : path === "/assertions"
          ? assertionsPOST
          : path === "/context"
            ? contextGET
            : path === "/operations" && body === undefined
              ? operationsGET
              : undefined
    ) as Handler | undefined;
    if (!handler) throw new Error(`unexpected face path ${path}`);
    const params = statusPath
      ? { slug: SLUG, operationId: decodeURIComponent(statusPath[1]) }
      : slugParams;
    return browser.take(
      await handler(browser.request(url, body), {
        params: Promise.resolve(params),
      }),
    );
  }) as unknown as typeof fetch;
  return () => {
    global.fetch = runtimeFetch;
  };
}

// The face's own status sequence for a recovered registration, through the
// wallet's real host client (what the bridge's programme.operation.status and
// programme.runtime.authorize capabilities call): the host's recovered status,
// then a read-only registration.status assertion for exactly that operation and
// unit, with the request hash the face computes (sha256 of canonical
// {operationId}). Nothing else is authorised, recorded or re-sealed.
describe("the face's status read after a recovered registration (host client sequence)", () => {
  const faceStatusHash = (operationId: string) =>
    `sha256:${createHash("sha256").update(JSON.stringify({ operationId })).digest("hex")}`;

  async function recoveredFixture(operationId: string, { signIn = true } = {}) {
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(issuedAt);
    const runtime = runtimeRegistrationStatus({
      [operationId]: runtimeAnswered(
        operationId,
        "ownership_moved_state_pending",
      ),
    });
    const earlier = new Browser();
    await issueRegistration(earlier, operationId);
    const evidenceName = `dual_face_launch_${earlier.launchId}`;
    const evidence = earlier.cookies.get(evidenceName)!;
    // Root's observation: the unit moved to this wallet; Dual still says Transfer pending.
    getObjectByIdPublic.mockResolvedValue(
      smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
    );
    clock.mockReturnValue(issuedAt + 60 * 1000);
    const again = signIn
      ? signInAgain(earlier)
      : reload(earlier, `launch-${"z".repeat(28)}`);
    return { clock, runtime, again, evidenceName, evidence };
  }

  for (const [label, signIn] of [
    ["a reload", false],
    ["a fresh sign-in", true],
  ] as const) {
    it(`after ${label}: the recovered host status (200) is followed by the face's read-only status assertion (200), never 404`, async () => {
      const operationId = signIn ? "register-op-0561" : "register-op-0562";
      const { clock, runtime, again, evidenceName, evidence } =
        await recoveredFixture(operationId, { signIn });
      const restore = hostClient(again);
      try {
        const face = { slug: SLUG, launchId: again.launchId };
        // 1. programme.operation.status
        const host = await readFaceOperationStatus(face, operationId);
        expect(host).toMatchObject({
          objectId: UNIT,
          readback: { ownerIsYou: true, state: "Transfer pending" },
        });
        // 2. programme.runtime.authorize registration.status, exactly as the bridge passes it.
        const assertion = await mintFaceAssertion(face, {
          operation: "registration.status",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: faceStatusHash(operationId),
        });
        expect(claimsOf(assertion)).toMatchObject({
          holder: HOLDER,
          sub: "wallet-1",
          operation: "registration.status",
          op_id: operationId,
          target: { object_id: UNIT },
          request_hash: faceStatusHash(operationId),
        });
        // Read-only: the recovered registration never joins this launch's journal,
        // and its original sealed evidence is byte-identical.
        const listed = await again.call(
          operationsGET,
          `/api/faces/${SLUG}/operations`,
          slugParams,
        );
        expect(
          listed.body.operations.map(
            (item: { operation_id: string }) => item.operation_id,
          ),
        ).not.toContain(operationId);
        expect(again.cookies.get(evidenceName)).toBe(evidence);
        // Still no business authority: no submit, no begin under its id, no settle step.
        await expect(
          mintFaceAssertion(face, {
            operation: "registration.submit",
            operation_id: operationId,
            target: { object_id: UNIT },
            request_hash: REQUEST_HASH,
          }),
        ).rejects.toMatchObject({ code: "unknown_operation" });
        expect(
          await operations(again, {
            transition: "begin",
            kind: "registration",
            operation: "registration.submit",
            operation_id: operationId,
            object_id: UNIT,
            record_id: "rec-0001",
            request_hash: REQUEST_HASH,
          }),
        ).toMatchObject({
          status: 409,
          body: { code: "operation_already_submitted" },
        });
        const settle = await mint(again, {
          operation: "registration.settle.verify",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: faceStatusHash(operationId),
        });
        expect(settle.status).not.toBe(200);
        expect(settle.body.assertion).toBeUndefined();
        expect(again.cookies.get(evidenceName)).toBe(evidence);
      } finally {
        restore();
        runtime.restore();
        clock.mockRestore();
      }
    });
  }

  it("fails closed: another unit, another request hash, another account, an ambiguous history, or an operation that never left the wallet", async () => {
    const operationId = "register-op-0563";
    const { clock, runtime, again } = await recoveredFixture(operationId);
    try {
      const statusRead = (
        browser: Browser,
        overrides: Record<string, unknown> = {},
      ) =>
        mint(browser, {
          operation: "registration.status",
          operation_id: operationId,
          target: { object_id: UNIT },
          request_hash: faceStatusHash(operationId),
          ...overrides,
        });
      expect(
        await statusRead(again, { target: { object_id: OTHER } }),
      ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      expect(
        await statusRead(again, { request_hash: REQUEST_HASH }),
      ).toMatchObject({ status: 409, body: { code: "operation_conflict" } });
      expect(
        await statusRead(again, { operation_id: "register-op-0569" }),
      ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
      expect((await statusRead(again)).status).toBe(200);
      // Another account signed in on the same browser: nothing, even with the exact hash.
      const account = await getWallet();
      getWallet.mockResolvedValue({
        ...account,
        id: "wallet-2",
        account: {
          ...account.account,
          address: "0x00000000000000000000000000000000000000b2",
        },
      });
      const other = signInAgain(again, `launch-${"w".repeat(28)}`);
      expect(await statusRead(other)).toMatchObject({
        status: 404,
        body: { code: "unknown_operation" },
      });
      getWallet.mockResolvedValue(account);
      // An ambiguous history (a second launch also issued this id): nothing is recovered, so nothing is authorised.
      const second = reload(again, `launch-${"v".repeat(28)}`);
      const forgedTwin = new Browser();
      forgedTwin.launchId = `launch-${"u".repeat(28)}`;
      await issueRegistration(forgedTwin, operationId);
      for (const [name, value] of forgedTwin.cookies)
        if (name.startsWith("dual_face_launch_"))
          second.cookies.set(name, value);
      expect(await statusRead(second)).toMatchObject({
        status: 404,
        body: { code: "unknown_operation" },
      });
      // The status read never asked the runtime: minting is the host's only part.
      expect(runtime.calls).toHaveLength(0);
    } finally {
      runtime.restore();
      clock.mockRestore();
    }
  });

  it("an operation only confirmed (never issued) in an earlier launch authorises no status read", async () => {
    const operationId = "register-op-0564";
    const earlier = new Browser();
    await confirmRegistration(earlier, operationId);
    const again = signInAgain(earlier);
    expect(
      await mint(again, {
        operation: "registration.status",
        operation_id: operationId,
        target: { object_id: UNIT },
        request_hash: faceStatusHash(operationId),
      }),
    ).toMatchObject({ status: 404, body: { code: "unknown_operation" } });
  });
});

// Ordinary result-page navigation in ONE session: every face-host mount takes
// a fresh launch id and its bootstrap (context, then the operations list)
// persists that launch's journal, usually empty. The launch that holds an
// unresolved issued registration must survive those empty launches inside
// the same MAX_FACE_LAUNCHES budget, untouched (never re-sealed), so the
// recovered status keeps answering for it.
describe("launch retention during ordinary result-page navigation (one session)", () => {
  const launchCookies = (browser: Browser) =>
    [...browser.cookies.keys()].filter((name) =>
      name.startsWith("dual_face_launch_"),
    );
  // One face-host mount: a fresh launch, the host's bootstrap reads, and the
  // result page's status read for the registration it shows.
  async function mountResultPage(
    browser: Browser,
    launchId: string,
    operationId: string,
  ) {
    browser.launchId = launchId;
    const face = { slug: SLUG, launchId };
    await loadProductFaceContext(face, "/");
    await listFaceOperations(face);
    return readFaceOperationStatus(face, operationId);
  }
  const launchId = (n: number) => `launch-${String(n).padStart(28, "0")}`;

  it("keeps the unresolved registration's launch while empty launches fill the budget, so the status keeps answering", async () => {
    const operationId = "register-op-0581";
    const runtime = runtimeRegistrationStatus({
      [operationId]: runtimeAnswered(
        operationId,
        "ownership_moved_state_pending",
      ),
    });
    jest
      .mocked(verifyFaceArtifact)
      .mockImplementation(async () => ({ ok: true }));
    const browser = new Browser();
    let restore = () => {};
    try {
      await issueRegistration(browser, operationId);
      const evidenceName = `dual_face_launch_${browser.launchId}`;
      const evidence = browser.cookies.get(evidenceName)!;
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
      );
      restore = hostClient(browser);
      // Current result -> earlier result -> back to current, repeatedly.
      for (let mount = 1; mount <= 2 * MAX_FACE_LAUNCHES; mount += 1) {
        const status = await mountResultPage(
          browser,
          launchId(mount),
          operationId,
        );
        expect(status).toMatchObject({
          objectId: UNIT,
          readback: { ownerIsYou: true, state: "Transfer pending" },
        });
        // The registration's own sealed evidence: kept, byte for byte.
        expect(browser.cookies.get(evidenceName)).toBe(evidence);
        // Still inside the same budget.
        expect(launchCookies(browser).length).toBeLessThanOrEqual(
          MAX_FACE_LAUNCHES,
        );
      }
      // The face's read-only status read still follows it (07315e4).
      const face = { slug: SLUG, launchId: browser.launchId };
      const assertion = await mintFaceAssertion(face, {
        operation: "registration.status",
        operation_id: operationId,
        target: { object_id: UNIT },
        request_hash: `sha256:${createHash("sha256").update(JSON.stringify({ operationId })).digest("hex")}`,
      });
      expect(claimsOf(assertion)).toMatchObject({
        operation: "registration.status",
        op_id: operationId,
      });
    } finally {
      restore();
      runtime.restore();
      jest
        .mocked(verifyFaceArtifact)
        .mockImplementation(
          jest.requireActual("@/api/face-artifact").verifyFaceArtifact,
        );
    }
  });

  it("stays bounded: with more unresolved registrations than slots the oldest goes first, empty launches before any of them, and another account still clears them", async () => {
    const ids = [
      "register-op-0591",
      "register-op-0592",
      "register-op-0593",
      "register-op-0594",
    ];
    const runtime = runtimeRegistrationStatus(
      Object.fromEntries(
        ids.map((id) => [
          id,
          runtimeAnswered(id, "ownership_moved_state_pending"),
        ]),
      ),
    );
    jest
      .mocked(verifyFaceArtifact)
      .mockImplementation(async () => ({ ok: true }));
    const browser = new Browser();
    let restore = () => {};
    try {
      const evidence: string[] = [];
      for (const [index, id] of ids.entries()) {
        browser.launchId = launchId(100 + index);
        await issueRegistration(browser, id);
        evidence.push(`dual_face_launch_${browser.launchId}`);
      }
      restore = hostClient(browser);
      getObjectByIdPublic.mockResolvedValue(
        smartObject(UNIT, HOLDER, { state: "Transfer pending" }),
      );
      // An empty mount: four unresolved launches compete for three other slots;
      // the oldest unresolved one is the one dropped, never an evidence cookie
      // for a newer one, and the empty current launch stays as the current one.
      await mountResultPage(browser, launchId(200), ids[3]);
      expect(launchCookies(browser).length).toBe(MAX_FACE_LAUNCHES);
      expect(browser.cookies.has(evidence[0])).toBe(false);
      for (const name of evidence.slice(1))
        expect(browser.cookies.has(name)).toBe(true);
      // Further empty mounts drop the previous empty launch, not the evidence.
      await mountResultPage(browser, launchId(201), ids[3]);
      expect(browser.cookies.has(`dual_face_launch_${launchId(200)}`)).toBe(
        false,
      );
      for (const name of evidence.slice(1))
        expect(browser.cookies.has(name)).toBe(true);
      restore();
      restore = () => {};
      // Another account on the same browser: its first write still drops them.
      const account = await getWallet();
      getWallet.mockResolvedValue({
        ...account,
        id: "wallet-2",
        account: {
          ...account.account,
          address: "0x00000000000000000000000000000000000000b2",
        },
      });
      const other = signInAgain(browser, launchId(300));
      restore = hostClient(other);
      await loadProductFaceContext(
        { slug: SLUG, launchId: launchId(300) },
        "/",
      );
      for (const name of evidence) expect(other.cookies.has(name)).toBe(false);
      expect(launchCookies(other)).toEqual([
        `dual_face_launch_${launchId(300)}`,
      ]);
      getWallet.mockResolvedValue(account);
    } finally {
      restore();
      runtime.restore();
      jest
        .mocked(verifyFaceArtifact)
        .mockImplementation(
          jest.requireActual("@/api/face-artifact").verifyFaceArtifact,
        );
    }
  });
});
