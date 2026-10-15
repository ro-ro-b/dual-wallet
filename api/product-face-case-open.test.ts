/**
 * @jest-environment node
 */
// Contract r10 linked cases, wallet side: the holder opens the service
// request Studio prepared for their unit. LOCAL FAKES ONLY: fictional ids, no
// network, no credentials.
//
// The face (1.0.0, src/product-face-client.mjs openForm -> caseStep ->
// runtimeOperation) sends ONE programme.runtime.authorize for case.open with
// target {object_id, case_id} (the prepared case it read with case.read) and
// request_hash over its exact runtime body {operation, operationId, target,
// input}. Studio's linked Warranty runtime accepts case.open ONLY with target
// exactly {case_id, object_id} (src/product-face-cases.mjs
// productFaceCaseRequestShape; docs/product-face.md "every other target
// {object_id, case_id}").
//
// What is real here: the bridge capability (resolveProductFaceRequest on a
// ProductFaceSession), the host client services
// (app/_services/product-face.client) wired as
// app/_hooks/use-product-face-host.ts wires them, and every wallet BFF route
// handler they reach (context, selection, operations journal, assertions).
// What is fake: the Dual object read (one owned unit), the pinned artifact
// check of the context read (covered elsewhere), and the holder's answer to
// the wallet's native confirmation. Any request that is not to a wallet route
// fails the test: nothing leaves the process.
import { createHash, generateKeyPairSync } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORGANIZATION_ID } from "@/api/tenant";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import {
  ARTIFACT_HEX,
  bindingInput,
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
// The pinned artifact itself is verified elsewhere; the context read here
// stands in a verified one.
jest.mock("@/api/face-artifact", () => {
  const actual = jest.requireActual("@/api/face-artifact");
  return { ...actual, verifyFaceArtifact: jest.fn(async () => ({ ok: true })) };
});

import { resetIssueGuard } from "@/api/product-face-operations";
import { establishSession, unsealForPurpose } from "@/api/server-session";
import { POST as assertionsPOST } from "@/app/api/faces/[slug]/assertions/route";
import { GET as contextGET } from "@/app/api/faces/[slug]/context/route";
import {
  GET as operationsGET,
  POST as operationsPOST,
} from "@/app/api/faces/[slug]/operations/route";
import { POST as selectionPOST } from "@/app/api/faces/[slug]/selection/route";
import type {
  ProductFaceApplication,
  ProductFaceConfirmation,
} from "@/app/_domain/product-face";
import {
  ProductFaceSession,
  resolveProductFaceRequest,
  type ProductFaceHandlers,
} from "@/app/_lib/external-face-bridge";
import {
  loadProductFaceContext,
  mintFaceAssertion,
  readFaceOperationStatus,
  selectProgrammeProduct,
  sha256Hash,
  writeFaceJournal,
} from "@/app/_services/product-face.client";

type Custom = Record<string, unknown>;

const SLUG = "morrow-home";
// Fictional ids in the live shapes: a 24-hex unit, a prepared case
// "clm-" + 16 hex, and the face's own "case-" + 20 hex operation ids.
const UNIT = "0a1b2c3d4e5f60718293a4b5";
const CASE_ID = "clm-0123456789abcdef";
const LINKED_WARRANTY = {
  purpose: "claims-warranty",
  applicationId: "tig.claims.morrow-warranty",
  origin: "https://warranty.example",
  instanceId: "tig-app-warranty0001",
};
const LAUNCH = `launch-${"c".repeat(28)}`;
const keys = generateKeyPairSync("ed25519");

// The face's canonical JSON (src/product-face-client.mjs canonicalJson).
function faceCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : faceCanonical(item),
    );
  }
  if (value && typeof value === "object") {
    const out: Custom = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Custom)[key];
      if (item !== undefined) out[key] = faceCanonical(item);
    }
    return out;
  }
  return value;
}
const canonicalJson = (value: unknown) => JSON.stringify(faceCanonical(value));
const sha = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function jwt(claims: Custom) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}
function claimsOf(assertion: string) {
  return JSON.parse(
    Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"),
  ) as Custom;
}

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<unknown> },
) => Promise<Response>;

function walletRoute(method: string, pathname: string) {
  const faces = /^\/api\/faces\/([^/]+)(\/.*)$/.exec(pathname);
  if (!faces) return undefined;
  const handler = (
    {
      "GET /context": contextGET,
      "POST /selection": selectionPOST,
      "GET /operations": operationsGET,
      "POST /operations": operationsPOST,
      "POST /assertions": assertionsPOST,
    } as Record<string, RouteHandler | undefined>
  )[`${method} ${faces[2]}`];
  return handler
    ? { handler, params: { slug: decodeURIComponent(faces[1]) } }
    : undefined;
}

interface Exchange {
  method: string;
  path: string;
  body: Custom | undefined;
  status: number;
  answer: Custom | null;
}

/** One browser with one wallet session; same-origin requests reach the REAL
 *  route handlers with its cookie jar. Every exchange is logged. */
class Browser {
  cookies = new Map<string, string>();
  readonly exchanges: Exchange[] = [];

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
    for (const cookie of (response as NextResponse).cookies.getAll()) {
      if (cookie.value) this.cookies.set(cookie.name, cookie.value);
      else this.cookies.delete(cookie.name);
    }
  }

  async send(url: string, init: RequestInit = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const { pathname, search } = new URL(url, "http://localhost");
    const route = walletRoute(method, pathname);
    if (!route) throw new Error(`unexpected wallet route ${method} ${url}`);
    const headers = new Headers(init.headers);
    headers.set("host", "localhost");
    if (method !== "GET") headers.set("origin", "http://localhost");
    headers.set(
      "cookie",
      Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join(
        "; ",
      ),
    );
    const response = await route.handler(
      new NextRequest(`http://localhost${pathname}${search}`, {
        method,
        headers,
        body: init.body ?? undefined,
      }),
      { params: Promise.resolve(route.params) },
    );
    this.take(response);
    this.exchanges.push({
      method,
      path: pathname,
      body: init.body ? (JSON.parse(String(init.body)) as Custom) : undefined,
      status: response.status,
      answer: (await response
        .clone()
        .json()
        .catch(() => null)) as Custom | null,
    });
    return response;
  }

  journal() {
    const sealed = this.cookies.get(`dual_face_launch_${LAUNCH}`);
    if (!sealed) return undefined;
    return unsealForPurpose(`dual-face-journal-v2:${LAUNCH}`, sealed) as {
      entries: Custom[];
    };
  }
}

let browser: Browser;
const originalFetch = global.fetch;
// Every request the host makes: same-origin wallet routes only.
let requests: string[] = [];

/** A normal owned-product face launch, with the handlers wired as
 *  use-product-face-host.ts wires them (the native dialog answered by
 *  `answer`). */
async function launch(answer = true) {
  browser = new Browser();
  requests = [];
  global.fetch = jest.fn(
    async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      requests.push(`${(init.method ?? "GET").toUpperCase()} ${url}`);
      if (url.startsWith("/")) return browser.send(url, init);
      throw new Error(`unexpected network request ${url}`);
    },
  ) as unknown as typeof fetch;
  const face = { slug: SLUG, launchId: LAUNCH };
  const { application } = (await loadProductFaceContext(face, "/service")) as {
    application: ProductFaceApplication;
  };
  const session = new ProductFaceSession(application, HOLDER, "/service");
  const confirmations: ProductFaceConfirmation[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error("not part of this journey");
  };
  const handlers: ProductFaceHandlers = {
    listProducts: notUsed,
    selectProduct: (objectId) => selectProgrammeProduct(face, objectId),
    readProduct: notUsed,
    readActions: notUsed,
    readAttributes: notUsed,
    readHistory: notUsed,
    readUnit: notUsed,
    journal: (request) =>
      writeFaceJournal(face, request as unknown as Record<string, unknown>),
    operationStatus: (operationId) =>
      readFaceOperationStatus(face, operationId),
    mintAssertion: (request) => mintFaceAssertion(face, request),
    readSettleProposal: notUsed,
    executorIdentity: () => null,
    executeSettle: notUsed,
    readTransferProposal: notUsed,
    readAcceptOffer: notUsed,
    executeTransfer: notUsed,
    transferProgress: notUsed,
    confirm: async (request) => {
      // The wallet's own native dialog, answered by the holder.
      confirmations.push(request);
      return answer;
    },
    navigate: () => {},
    sha256: sha256Hash,
  };
  let id = 0;
  const call = (operation: string, payload: unknown = {}) =>
    resolveProductFaceRequest(
      {
        type: "dual.face.request",
        protocol: "dual.face.bridge",
        version: 1,
        request_id: `request-${(id += 1)}`,
        operation,
        payload,
      },
      { session, handlers, events: { contextChanged: jest.fn() } },
    ) as Promise<Custom>;
  // The face's runtimeOperation(): exactly the authorize request it sends.
  const authorize = (
    operation: string,
    operationId: string,
    target: Custom,
    input: Custom,
  ) =>
    call("programme.runtime.authorize", {
      operation,
      operation_id: operationId,
      target,
      request_hash: sha(
        canonicalJson({ operation, operationId, target, input }),
      ),
    });
  // enterService(): the face selects the product before any case work.
  const selected = await call("programme.product.select", { object_id: UNIT });
  return { call, authorize, confirmations, selected, session };
}

const exchangesTo = (path: string, method = "POST") =>
  browser.exchanges.filter(
    (item) =>
      item.method === method && item.path === `/api/faces/${SLUG}${path}`,
  );
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: { code?: string }) => error.code,
  );

// The face's exact case.open (openForm -> caseStep): the prepared case it
// read, the claim type it chose and the problem described once.
const OPEN_TARGET = { object_id: UNIT, case_id: CASE_ID };
const OPEN_INPUT = {
  claimType: "manufacturing_defect",
  problemStatement: "The grinder stops after a few seconds under load.",
};
const OPEN_OPERATION = "case-0123456789abcdef0123";

beforeEach(() => {
  process.env.PRODUCT_FACE_APPLICATIONS = JSON.stringify([
    bindingInput({ linkedRuntimes: [LINKED_WARRANTY] }),
  ]);
  process.env.FACE_ASSERTION_KEY_ID = "wallet-face-test";
  process.env.FACE_ASSERTION_SIGNING_KEY = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  resetIssueGuard();
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
  // LOCAL FAKE Dual read: the holder's registered unit.
  getObjectById.mockReset().mockResolvedValue({
    id: UNIT,
    templateId: TEMPLATE_A,
    owner: HOLDER,
    custom: { recordId: "rec-0001", state: "Registered" },
    metadata: { name: "Arc grinder" },
    whenModified: new Date("2026-10-01T00:00:00Z"),
  });
  getObjectByIdPublic.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.PRODUCT_FACE_APPLICATIONS;
  delete process.env.FACE_ASSERTION_KEY_ID;
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
});

describe("case.open of the prepared case (contract r10 linked cases)", () => {
  it("reads the prepared case, then opens it through the wallet's native confirmation, journal and linked-runtime assertion", async () => {
    const { authorize, confirmations, selected } = await launch();

    // The face's case.read of the prepared case: minted with no dialog.
    const read = await authorize(
      "case.read",
      "case-00000000000000000001",
      OPEN_TARGET,
      {},
    );
    expect(claimsOf(String(read.assertion))).toMatchObject({
      aud: "tig.claims.morrow-warranty@https://warranty.example",
      operation: "case.read",
      target: OPEN_TARGET,
    });
    expect(confirmations).toEqual([]);

    // ONE "Open service request".
    const before = requests.length;
    const opened = await authorize(
      "case.open",
      OPEN_OPERATION,
      OPEN_TARGET,
      OPEN_INPUT,
    );

    // The wallet's own native confirmation names the product and the case.
    expect(confirmations).toEqual([
      {
        kind: "runtime",
        operation: "case.open",
        product: { objectId: UNIT, name: "Arc grinder" },
        caseId: CASE_ID,
      },
    ]);
    // Journal begin (with the case), confirm, then the BFF assertion mint;
    // nothing else, and only to the wallet's own routes.
    expect(requests.slice(before)).toEqual([
      `POST /api/faces/${SLUG}/operations`,
      `POST /api/faces/${SLUG}/operations`,
      `POST /api/faces/${SLUG}/assertions`,
    ]);
    expect(
      exchangesTo("/operations")
        .filter((item) => item.body?.operation_id === OPEN_OPERATION)
        .map((item) => [item.body?.transition, item.status]),
    ).toEqual([
      ["begin", 200],
      ["confirm", 200],
    ]);
    expect(
      exchangesTo("/operations").find(
        (item) => item.body?.transition === "begin",
      )?.body,
    ).toEqual({
      transition: "begin",
      kind: "runtime",
      operation: "case.open",
      operation_id: OPEN_OPERATION,
      object_id: UNIT,
      context_id: selected.context_id,
      case_id: CASE_ID,
    });
    // The one-time assertion binds exactly the face's request, for the
    // linked Warranty runtime (the only runtime that accepts it).
    expect(claimsOf(String(opened.assertion))).toMatchObject({
      aud: "tig.claims.morrow-warranty@https://warranty.example",
      app_id: "tig.passport.morrow-home",
      artifact: `sha256:${ARTIFACT_HEX}`,
      holder: HOLDER,
      operation: "case.open",
      op_id: OPEN_OPERATION,
      target: OPEN_TARGET,
      request_hash: sha(
        canonicalJson({
          operation: "case.open",
          operationId: OPEN_OPERATION,
          target: OPEN_TARGET,
          input: OPEN_INPUT,
        }),
      ),
    });
    expect(
      browser
        .journal()!
        .entries.find((entry) => entry.operationId === OPEN_OPERATION),
    ).toMatchObject({
      kind: "runtime",
      operation: "case.open",
      objectId: UNIT,
      caseId: CASE_ID,
      phase: "assertion_issued",
    });
  });

  it("a holder who cancels the native dialog sends nothing and mints nothing", async () => {
    const { authorize, confirmations } = await launch(false);
    expect(
      await failure(
        authorize("case.open", OPEN_OPERATION, OPEN_TARGET, OPEN_INPUT),
      ),
    ).toBe("user_cancelled");
    expect(confirmations).toHaveLength(1);
    expect(exchangesTo("/assertions")).toEqual([]);
    expect(
      exchangesTo("/operations").map((item) => item.body?.transition),
    ).toEqual(["begin", "cancel"]);
  });

  it.each([
    ["no case (the prepared case is required)", { object_id: UNIT }],
    ["an empty case id", { object_id: UNIT, case_id: "" }],
    ["a case id with a space", { object_id: UNIT, case_id: "clm 0123" }],
    ["a case id starting with a dash", { object_id: UNIT, case_id: "-clm-01" }],
    [
      "an over-long case id",
      { object_id: UNIT, case_id: `clm-${"a".repeat(128)}` },
    ],
    ["a numeric case id", { object_id: UNIT, case_id: 82034 }],
    ["a malformed unit", { object_id: "not-a-unit", case_id: CASE_ID }],
    ["no unit", { case_id: CASE_ID }],
    ["an extra target key", { ...OPEN_TARGET, quote_version: "1" }],
    ["a non-object target", [UNIT, CASE_ID]],
  ])(
    "refuses case.open with %s before any dialog or request",
    async (_label, target) => {
      const { call, confirmations } = await launch();
      const before = requests.length;
      expect(
        await failure(
          call("programme.runtime.authorize", {
            operation: "case.open",
            operation_id: OPEN_OPERATION,
            target,
            request_hash: sha("{}"),
          }),
        ),
      ).toBe("invalid_request");
      expect(confirmations).toEqual([]);
      expect(requests.slice(before)).toEqual([]);
    },
  );

  it("refuses a case.open for another unit than the selected one", async () => {
    const { authorize, confirmations } = await launch();
    const before = requests.length;
    expect(
      await failure(
        authorize(
          "case.open",
          OPEN_OPERATION,
          { object_id: "bbbbbbbbbbbbbbbbbbbbbbbb", case_id: CASE_ID },
          OPEN_INPUT,
        ),
      ),
    ).toBe("stale_context");
    expect(confirmations).toEqual([]);
    expect(requests.slice(before)).toEqual([]);
  });

  it("the BFF itself refuses a case.open journal begin or mint without a case", async () => {
    const { selected } = await launch();
    const begin = await browser.send(`/api/faces/${SLUG}/operations`, {
      method: "POST",
      headers: { "x-dual-face-launch": LAUNCH },
      body: JSON.stringify({
        transition: "begin",
        kind: "runtime",
        operation: "case.open",
        operation_id: OPEN_OPERATION,
        object_id: UNIT,
        context_id: selected.context_id,
      }),
    });
    expect(begin.status).toBe(400);
    expect(await begin.json()).toMatchObject({ code: "invalid_request" });
    const mint = await browser.send(`/api/faces/${SLUG}/assertions`, {
      method: "POST",
      headers: { "x-dual-face-launch": LAUNCH },
      body: JSON.stringify({
        operation: "case.open",
        operation_id: OPEN_OPERATION,
        target: { object_id: UNIT },
        request_hash: sha("{}"),
        context_id: selected.context_id,
      }),
    });
    expect(mint.status).toBe(400);
    expect(await mint.json()).toMatchObject({ code: "invalid_request" });
    expect(browser.journal()?.entries ?? []).toEqual([]);
  });
});
