/**
 * @jest-environment node
 */
// P4.3 ticket-admission-v1, wallet side, through the REAL route handlers,
// journal cookie and /api/backend execution binding. The Tickets runtime and
// Dual here are LOCAL FICTIONAL FAKES (no network, no keys beyond a per-run
// test key): this proves the wallet's half of the contract only, not the
// shared service and not live Dual.
import { createHash, generateKeyPairSync } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORGANIZATION_ID } from "@/api/tenant";
import type { HostJourneys } from "@/app/_domain/wallet-host";
import { canonicalJson } from "@/app/_domain/product-face";
import { edit, HOLDER } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
} from "@/test/wallet-host-fixtures";

const getWallet = jest.fn();
const getObjectById = jest.fn();
jest.mock("@/api/web-sdk-client", () => ({
  getWalletsApi: () => ({ getWallet, logout: jest.fn() }),
  getObjectsApi: () => ({ getObjectById, listObjects: jest.fn() }),
}));

import { establishSessionState } from "@/api/server-session";
import { resetWalletHostCache } from "@/api/wallet-host";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import { POST as admissionPOST } from "@/app/api/faces/[slug]/tickets/[objectId]/admission/route";
import { POST as backendPOST } from "@/app/api/backend/[...path]/route";

const SLUG = "morrow-home";
const TICKET = "7d00000000000000000000a1";
const TEMPLATE = "65f0a1b2c3d4e5f6a7b8c9d0";
const REQUEST_ID = `tad-${"1".repeat(32)}`;
const OTHER = "0x00000000000000000000000000000000000000aa";
const BIRTH_OP = `op_${"b".repeat(40)}`;
const BIRTH_KEY = `tig:dual-operation:${"b".repeat(64)}`;
const ADMIT_OP = `op_${"c".repeat(40)}`;
const ADMIT_KEY = `tig:dual-operation:${"c".repeat(64)}`;
const ACTIVATION = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

const TICKET_RULES = {
  fields: {
    event: "title",
    startsAt: "admissionWindowStartsAt",
    venue: "venueRef",
    entryClass: "accessClass",
    entryGuidance: null,
    issueOperation: "activation_hash",
    state: "state",
  },
  states: { pending: [], issued: ["Valid"], ended: ["Cancelled", "Expired"] },
  admission: {
    contract: "ticket-admission-v1",
    action: "update",
    inputPath: "data.custom",
    leaves: {
      state: { enum: ["Admitted"] },
      admissionStatus: { enum: ["Admitted"] },
      operation_id: { runtimeIssued: "^op_[0-9a-f]{40}$" },
      idempotency_key: { runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$" },
    },
    customKeys: [
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
    ],
    fromStates: ["Valid"],
    targetStates: ["Admitted"],
    preserveUnlisted: true,
  },
};

/** The fictional ticket's closed 16-key custom map, as issued. */
function issuedCustom(): Record<string, unknown> {
  return {
    accessClass: "Standing",
    activation_hash: ACTIVATION,
    admissionStatus: "Valid",
    admissionWindowEndsAt: "2026-10-18T23:00:00.000Z",
    admissionWindowStartsAt: "2026-10-18T18:00:00.000Z",
    app_namespace: "fictional-tickets",
    eventRef: "harbour-night-2026",
    idempotency_key: BIRTH_KEY,
    operation_id: BIRTH_OP,
    product_type: "event_ticket",
    recipient_mint_projection: true,
    recordId: "tkt-harbour-0001",
    seatRef: "",
    state: "Valid",
    title: "Harbour Night",
    venueRef: "Quay Hall",
  };
}

/** The ONE map the contract permits: four governed leaves over the fresh read. */
const admittedCustom = () => ({
  ...issuedCustom(),
  state: "Admitted",
  admissionStatus: "Admitted",
  operation_id: ADMIT_OP,
  idempotency_key: ADMIT_KEY,
});

interface DualObject {
  id: string;
  templateId: string;
  orgId: string;
  owner: string;
  custom: Record<string, unknown>;
}
let dual: DualObject;

function configure({ admission = true } = {}) {
  const document = morrowDocument();
  edit(document, "entrance.origin", "http://localhost");
  edit(document, "entrance.organizationId", DEFAULT_ORGANIZATION_ID);
  edit(document, "navigation", []);
  edit(document, "journeys", {
    ...(document.journeys as HostJourneys),
    tickets: true,
  });
  const withoutAdmission: Record<string, unknown> = { ...TICKET_RULES };
  delete withoutAdmission.admission;
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, {
      PRODUCT_FACE_APPLICATIONS: JSON.stringify([
        {
          ...morrowBinding(),
          templateIds: [TEMPLATE],
          tickets: admission ? TICKET_RULES : withoutAdmission,
        },
      ]),
    }),
  );
}

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

class Browser {
  cookies = new Map<string, string>();
  constructor(readonly launchId = `launch-${"q".repeat(28)}`) {
    const response = NextResponse.json({});
    establishSessionState(
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
  /** The same browser, another tab: same cookies, a new launch. */
  reopen() {
    const next = new Browser(`launch-${"r".repeat(28)}`);
    next.cookies = new Map(this.cookies);
    return next;
  }
  async admission(body: Record<string, unknown>, objectId = TICKET) {
    const response = await admissionPOST(
      new NextRequest(
        `http://localhost/api/faces/${SLUG}/tickets/${objectId}/admission`,
        {
          method: "POST",
          headers: {
            host: "localhost",
            origin: "http://localhost",
            "content-type": "application/json",
            "x-dual-face-launch": this.launchId,
            cookie: Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join(
              "; ",
            ),
          },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ slug: SLUG, objectId }) },
    );
    this.take(response);
    const parsed = (await response.json()) as Record<string, unknown>;
    seen.push(JSON.stringify(parsed));
    return { status: response.status, body: parsed };
  }
  /** The wallet executor's request through /api/backend (contract r18). */
  async execute(
    operationId: string,
    custom: Record<string, unknown>,
    path = "ebus/execute",
  ) {
    const response = await backendPOST(
      new NextRequest(`http://localhost/api/backend/${path}`, {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          "content-type": "application/json",
          "x-dual-face-launch": this.launchId,
          "x-dual-face-slug": SLUG,
          "x-dual-face-operation": operationId,
          "x-dual-face-wallet": "wallet-1",
          cookie: Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; "),
        },
        body: JSON.stringify({
          action: { update: { id: TICKET, data: { custom } } },
          nonce: 1,
        }),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    const parsed = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { status: response.status, body: parsed };
  }
}

/** Everything the BFF answered the browser (checked for credentials). */
let seen: string[];

/**
 * LOCAL FICTIONAL FAKE of the shared Tickets service's ticket-admission-v1
 * leg and of Dual's execute. It checks every assertion's binding the way the
 * contract requires, and counts runtime calls and holder executions.
 */
function fakeServices({
  lose = new Set<string>(),
  proposalCustom,
  pending,
}: {
  lose?: Set<string>;
  proposalCustom?: () => Record<string, unknown>;
  pending?: () => Record<string, unknown> | undefined;
} = {}) {
  const calls: Array<{
    operation: string;
    origin: string | null;
    holder: unknown;
  }> = [];
  let reserved: string | undefined;
  let admitted = false;
  let executions = 0;
  const requestExpires = {
    value: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const proposalMap = () =>
    proposalCustom ? proposalCustom() : admittedCustom();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    const { origin, pathname } = new URL(url);
    const raw = init.body;
    const text =
      raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
        ? Buffer.from(raw as ArrayBuffer).toString("utf8")
        : String(raw ?? "{}");
    const body = JSON.parse(text) as Record<string, unknown>;
    if (origin !== "https://faces.example") {
      // Fictional Dual: the holder's own prepare and execute.
      if (pathname.endsWith("/ebus/prepare"))
        return json(200, { nonce: 1, challenge: "x" });
      if (pathname.endsWith("/ebus/execute")) {
        executions += 1;
        const update = (
          body.action as {
            update: { data: { custom: Record<string, unknown> } };
          }
        ).update;
        dual = { ...dual, custom: update.data.custom };
        if (lose.has("execute"))
          throw new TypeError("connection reset after execute");
        return json(200, { action_id: "act-admit-0001" });
      }
      return json(404, {});
    }
    const headers = new Headers(init.headers);
    const claims = JSON.parse(
      Buffer.from(String(body.assertion).split(".")[1], "base64url").toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    const operation = String(body.operation);
    calls.push({
      operation,
      origin: headers.get("origin"),
      holder: claims.holder,
    });
    const expectedHash = sha({
      operation,
      operationId: body.operationId,
      target: body.target,
      input: body.input,
    });
    if (
      claims.operation !== operation ||
      claims.op_id !== body.operationId ||
      claims.request_hash !== expectedHash
    ) {
      return json(403, { ok: false, status: "face_assertion_mismatch" });
    }
    const object_id = TICKET;
    const request = {
      request_id: REQUEST_ID,
      event_ref: "harbour-night-2026",
      created_at: new Date().toISOString(),
      expires_at: requestExpires.value,
    };
    const verifiedNow = () =>
      admitted && canonicalJson(dual.custom) === canonicalJson(proposalMap());
    const answer = (): Response => {
      switch (operation) {
        case "admission.pending.read": {
          const override = pending?.();
          if (override) return json(200, { ok: true, object_id, ...override });
          if (admitted) {
            return json(200, {
              ok: true,
              object_id,
              status: verifiedNow() ? "admitted" : "admission_unverified",
              ...(verifiedNow()
                ? {
                    admission: {
                      request_id: REQUEST_ID,
                      action_id: "act-admit-0001",
                      admitted_at: new Date().toISOString(),
                      receipt_id: "rcpt-admit-0001",
                      readback: {
                        state: "Admitted",
                        admission_status: "Admitted",
                        operation_id: ADMIT_OP,
                        idempotency_key: ADMIT_KEY,
                      },
                    },
                  }
                : { request }),
            });
          }
          return json(200, {
            ok: true,
            object_id,
            status: reserved ? "awaiting_holder" : "awaiting_holder",
            request,
          });
        }
        case "admission.propose": {
          const proposal = {
            proposal_id: "adp-0001",
            request_id: REQUEST_ID,
            object_id,
            action: "update",
            input: { data: { custom: proposalMap() } },
            expires_at: requestExpires.value,
          };
          return json(200, {
            ok: true,
            status: "proposed",
            proposal: {
              ...proposal,
              proposal_hash: sha({
                object_id,
                action: "update",
                input: proposal.input,
              }),
            },
          });
        }
        case "admission.reserve": {
          if (reserved)
            return json(409, {
              ok: false,
              status: "already_reserved",
              dispatch: "already_claimed",
              holder_dispatch: "reserved",
            });
          reserved = String(body.operationId);
          return json(200, {
            ok: true,
            status: "granted",
            dispatch: "won",
            holder_dispatch: "reserved",
            reservation: {
              admission_operation_id: body.operationId,
              object_id,
              proposal_id: "adp-0001",
              request_id: REQUEST_ID,
            },
          });
        }
        case "admission.verify":
        case "admission.status": {
          if (reserved !== body.operationId)
            return json(409, {
              ok: false,
              status: "admission_reservation_required",
              holder_dispatch: "none",
            });
          if (canonicalJson(dual.custom) !== canonicalJson(proposalMap())) {
            return json(202, {
              ok: false,
              status: "outcome_unknown",
              holder_dispatch: "reserved",
            });
          }
          admitted = true;
          return json(200, {
            ok: true,
            status: "admitted",
            holder_dispatch: "verified",
            admission: {
              request_id: REQUEST_ID,
              object_id,
              action_id: "act-admit-0001",
              admitted_at: new Date().toISOString(),
              receipt_id: "rcpt-admit-0001",
              readback: {
                state: "Admitted",
                admission_status: "Admitted",
                operation_id: ADMIT_OP,
                idempotency_key: ADMIT_KEY,
              },
            },
          });
        }
        case "ticket.pass.read":
          return json(200, {
            ok: true,
            status: "ticket_pass_ready",
            object_id,
            pass: {
              schema_version: "tig-ticket-pass-code-v1",
              code: `DT1.tkt-harbour-0001.${"d".repeat(20)}`,
            },
            issuance: {
              schema_version: "ticket-issuance-proof-v1",
              record_id: "tkt-harbour-0001",
              object_id,
              activation_hash: ACTIVATION,
              birth_operation_id: BIRTH_OP,
              birth_idempotency_key: BIRTH_KEY,
              birth_action_id: "act-mint-0001",
              evidence: {
                birth_action: "verified",
                activation_hash: "verified",
                operation_commitment: "verified",
                operation_readback:
                  dual.custom.operation_id === BIRTH_OP
                    ? "current"
                    : "superseded",
              },
            },
          });
        default:
          return json(400, { ok: false, status: "face_request_invalid" });
      }
    };
    const response = answer();
    if (lose.has(operation))
      throw new TypeError(`connection reset after ${operation}`);
    return response;
  });
  return {
    fetchImpl,
    calls,
    requestExpires,
    selfUpdate(custom: Record<string, unknown>) {
      dual = { ...dual, custom };
    },
    get executions() {
      return executions;
    },
    count: (operation: string) =>
      calls.filter((call) => call.operation === operation).length,
  };
}

const original = global.fetch;
beforeEach(() => {
  seen = [];
  process.env.FACE_ASSERTION_KEY_ID = "wallet-face-test";
  process.env.FACE_ASSERTION_SIGNING_KEY = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  configure();
  dual = {
    id: TICKET,
    templateId: TEMPLATE,
    orgId: DEFAULT_ORGANIZATION_ID,
    owner: HOLDER,
    custom: issuedCustom(),
  };
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
      controller: { address: "0xc", type: "SECP256K1", custody: "custodial" },
      smartAccount: {},
    },
    whenCreated: new Date(),
    whenModified: new Date(),
  });
  getObjectById
    .mockReset()
    .mockImplementation(async ({ objectId }: { objectId: string }) => ({
      ...dual,
      // Any other ticket id is another, equally valid ticket of this holder.
      id: objectId,
      custom: structuredClone(dual.custom),
      metadata: { name: "Harbour Night entry" },
      whenModified: new Date("2026-10-01T00:00:00Z"),
    }));
});
afterEach(() => {
  global.fetch = original;
  delete process.env.FACE_ASSERTION_KEY_ID;
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
  clearHostEnvironment();
  resetWalletHostCache();
});

/** check -> begin: the confirmation and the map the holder may sign. */
async function begun(browser: Browser) {
  const checked = await browser.admission({ transition: "check" });
  expect(checked.body.state).toEqual(
    expect.objectContaining({ status: "awaiting_holder" }),
  );
  const begin = await browser.admission({
    transition: "begin",
    request_id: REQUEST_ID,
  });
  expect(begin.status).toBe(200);
  const confirmation = begin.body.confirmation as Record<string, unknown>;
  return {
    confirmation,
    operationId: String(confirmation.operationId),
    custom: begin.body.custom as Record<string, unknown>,
  };
}

describe("an authorised holder admits their own ticket", () => {
  it("confirms natively, signs exactly once, and sees entry only after verified readback", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { confirmation, operationId, custom } = await begun(browser);
    // The native confirmation: server-read facts only.
    expect(confirmation).toEqual(
      expect.objectContaining({
        objectId: TICKET,
        holder: HOLDER.toLowerCase(),
        event: {
          title: "Harbour Night",
          venue: "Quay Hall",
          startsAt: "2026-10-18T18:00:00.000Z",
        },
        window: {
          startsAt: "2026-10-18T18:00:00.000Z",
          endsAt: "2026-10-18T23:00:00.000Z",
        },
        effect: { from: "Valid", to: "Admitted" },
        request: expect.objectContaining({ requestId: REQUEST_ID }),
      }),
    );
    // Exactly the four governed leaves differ from the fresh read.
    const changed = Object.keys(custom)
      .filter(
        (key) =>
          canonicalJson(custom[key]) !== canonicalJson(issuedCustom()[key]),
      )
      .sort();
    expect(changed).toEqual([
      "admissionStatus",
      "idempotency_key",
      "operation_id",
      "state",
    ]);

    expect(services.count("admission.reserve")).toBe(0);
    const confirm = await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    expect(confirm).toEqual({ status: 200, body: { reservation: "won" } });
    expect((await browser.execute(operationId, custom)).status).toBe(200);
    expect(services.executions).toBe(1);
    const verified = await browser.admission({
      transition: "record_action",
      operation_id: operationId,
      action_id: "act-admit-0001",
    });
    expect(verified.body.outcome).toEqual({
      status: "admitted",
      admission: expect.objectContaining({
        requestId: REQUEST_ID,
        actionId: "act-admit-0001",
        receiptId: "rcpt-admit-0001",
      }),
    });
    // Reopened later: the runtime's admitted plus the wallet's own fresh read.
    expect(
      (await browser.reopen().admission({ transition: "check" })).body.state,
    ).toEqual(expect.objectContaining({ status: "admitted" }));
    // Server to server only; the holder is always the session's.
    expect(
      services.calls.every(
        (call) => call.origin === null && call.holder === HOLDER.toLowerCase(),
      ),
    ).toBe(true);
  });

  it("forwards nothing but this step's exact map, once, and never after it was recorded", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    // Before the reservation: no execution at all.
    expect((await browser.execute(operationId, custom)).body).toEqual(
      expect.objectContaining({ code: "face_execution_not_pending" }),
    );
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    for (const tampered of [
      { ...custom, eventRef: "another-event" },
      { ...custom, extra: "leaf" },
      { ...custom, state: "Valid" },
    ]) {
      expect((await browser.execute(operationId, tampered)).body).toEqual(
        expect.objectContaining({ code: "face_execution_mismatch" }),
      );
    }
    expect(services.executions).toBe(0);
    expect((await browser.execute(operationId, custom)).status).toBe(200);
    await browser.admission({
      transition: "record_action",
      operation_id: operationId,
      action_id: "act-admit-0001",
    });
    expect((await browser.execute(operationId, custom)).body).toEqual(
      expect.objectContaining({ code: "face_execution_not_pending" }),
    );
    expect(services.executions).toBe(1);
  });
});

describe("repeats and lost replies keep the original operation", () => {
  it("a duplicate confirm or a new begin never reserves or signs again", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    expect(
      (
        await browser.admission({
          transition: "confirm",
          operation_id: operationId,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await browser.admission({
          transition: "cancel",
          operation_id: operationId,
        })
      ).body,
    ).toEqual({ code: "operation_already_submitted" });
    expect(
      (await browser.admission({ transition: "begin", request_id: REQUEST_ID }))
        .body,
    ).toEqual({ code: "admission_in_progress" });
    expect(services.count("admission.reserve")).toBe(1);
  });

  it("a lost reserve reply is unknown, never executable, and read back only by its own operation", async () => {
    const services = fakeServices({ lose: new Set(["admission.reserve"]) });
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    expect(
      (
        await browser.admission({
          transition: "confirm",
          operation_id: operationId,
        })
      ).body,
    ).toEqual({ code: "outcome_unknown" });
    expect((await browser.execute(operationId, custom)).body).toEqual(
      expect.objectContaining({ code: "face_execution_not_pending" }),
    );
    expect(
      (await browser.admission({ transition: "check" })).body.state,
    ).toEqual({ status: "unknown", operationId });
    // The runtime holds a reservation but nothing was executed: still unknown, not "not sent".
    expect(
      (
        await browser.admission({
          transition: "status",
          operation_id: operationId,
        })
      ).body.outcome,
    ).toEqual({ status: "unknown", operationId });
    expect(services.executions).toBe(0);
  });

  it("a lost verify reply stays unknown until the read-only status proves entry", async () => {
    const services = fakeServices({ lose: new Set(["admission.verify"]) });
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    await browser.execute(operationId, custom);
    expect(
      (
        await browser.admission({
          transition: "record_action",
          operation_id: operationId,
          action_id: "act-admit-0001",
        })
      ).body.outcome,
    ).toEqual({ status: "unknown", operationId });
    // A reopened tab finds the original operation, never a new attempt.
    const reopened = browser.reopen();
    expect(
      (await reopened.admission({ transition: "check" })).body.state,
    ).toEqual({ status: "unknown", operationId });
    expect(
      (
        await reopened.admission({
          transition: "begin",
          request_id: REQUEST_ID,
        })
      ).body,
    ).toEqual({ code: "admission_in_progress" });
    expect(
      (
        await reopened.admission({
          transition: "status",
          operation_id: operationId,
        })
      ).body.outcome,
    ).toEqual(expect.objectContaining({ status: "admitted" }));
    expect(services.executions).toBe(1);
  });
});

describe("an operation belongs to exactly its URL ticket", () => {
  it("ticket A's operation sent through ticket B's path is refused with no runtime, reserve or execute", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId } = await begun(browser);
    const before = services.calls.length;
    const B = "7d00000000000000000000b9";
    for (const body of [
      { transition: "confirm", operation_id: operationId },
      { transition: "cancel", operation_id: operationId },
      {
        transition: "record_action",
        operation_id: operationId,
        action_id: "act-admit-0001",
      },
      { transition: "status", operation_id: operationId },
    ]) {
      expect(await browser.admission(body, B)).toEqual({
        status: 404,
        body: { code: "unknown_operation" },
      });
    }
    expect(services.calls.length).toBe(before);
    expect(services.executions).toBe(0);
    // A's own step is untouched and still confirmable on A's own path.
    expect(
      (
        await browser.admission({
          transition: "confirm",
          operation_id: operationId,
        })
      ).body,
    ).toEqual({ reservation: "won" });
  });
});

describe("stale or wrong facts never reach a signature", () => {
  it("a ticket changed since begin is refused before any reservation; cancel is zero writes", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId } = await begun(browser);
    services.selfUpdate({ ...issuedCustom(), seatRef: "B12" });
    expect(
      (
        await browser.admission({
          transition: "confirm",
          operation_id: operationId,
        })
      ).body,
    ).toEqual({ code: "proposal_rejected" });
    expect(
      (
        await browser.admission({
          transition: "cancel",
          operation_id: operationId,
        })
      ).status,
    ).toBe(200);
    expect(services.count("admission.reserve")).toBe(0);
    expect(services.executions).toBe(0);
  });

  it("an expired gate request is refused at confirm", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId } = await begun(browser);
    services.requestExpires.value = new Date(Date.now() - 1000).toISOString();
    expect(
      (
        await browser.admission({
          transition: "confirm",
          operation_id: operationId,
        })
      ).body,
    ).toEqual({ code: "admission_request_mismatch" });
    expect(services.count("admission.reserve")).toBe(0);
  });

  it.each([
    ["eventRef changed", () => ({ ...admittedCustom(), eventRef: "other" })],
    ["an extra key", () => ({ ...admittedCustom(), extra: "x" })],
    [
      "a missing key",
      () => {
        const map: Record<string, unknown> = admittedCustom();
        delete map.seatRef;
        return map;
      },
    ],
    [
      "a malformed operation id",
      () => ({ ...admittedCustom(), operation_id: "op_not-hex" }),
    ],
    ["another target state", () => ({ ...admittedCustom(), state: "Valid" })],
  ])(
    "a proposal with %s is rejected before anything is journalled",
    async (_label, proposalCustom) => {
      const services = fakeServices({ proposalCustom });
      global.fetch = services.fetchImpl as unknown as typeof fetch;
      const browser = new Browser();
      expect(
        (
          await browser.admission({
            transition: "begin",
            request_id: REQUEST_ID,
          })
        ).body,
      ).toEqual({ code: "proposal_rejected" });
      expect(services.count("admission.reserve")).toBe(0);
    },
  );

  it("a ticket that is not on the closed template is unsupported", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const custom = issuedCustom();
    delete custom.seatRef;
    dual = { ...dual, custom };
    expect(
      (
        await new Browser().admission({
          transition: "begin",
          request_id: REQUEST_ID,
        })
      ).body,
    ).toEqual({ code: "admission_unsupported" });
  });

  it.each([
    ["another holder's", { owner: OTHER }],
    ["another client's", { orgId: "f".repeat(24) }],
    ["another programme's", { templateId: "e".repeat(24) }],
  ])(
    "%s ticket is not found and no runtime call is made",
    async (_label, change) => {
      const services = fakeServices();
      global.fetch = services.fetchImpl as unknown as typeof fetch;
      dual = { ...dual, ...change };
      const browser = new Browser();
      for (const transition of ["check", "pass"]) {
        expect((await browser.admission({ transition })).body).toEqual({
          code: "not_found",
        });
      }
      expect(
        (
          await browser.admission({
            transition: "begin",
            request_id: REQUEST_ID,
          })
        ).body,
      ).toEqual({ code: "not_found" });
      expect(services.calls).toEqual([]);
    },
  );

  it("a ticket that cannot be read is unavailable, never a step", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    getObjectById.mockImplementation(async () => {
      throw Object.assign(new Error("nf"), { response: { status: 404 } });
    });
    expect(
      (
        await new Browser().admission(
          { transition: "check" },
          "7d00000000000000000000ff",
        )
      ).status,
    ).toBe(502);
  });
});

describe("Dual's state alone is never entry", () => {
  it("a later drift after admission reads as unverified, not admitted", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    await browser.execute(operationId, custom);
    await browser.admission({
      transition: "record_action",
      operation_id: operationId,
      action_id: "act-admit-0001",
    });
    services.selfUpdate({
      ...admittedCustom(),
      operation_id: `op_${"9".repeat(40)}`,
    });
    expect(
      (await browser.reopen().admission({ transition: "check" })).body.state,
    ).toEqual({ status: "unverified", requestId: REQUEST_ID });
  });

  it("a runtime that claims admitted while the fresh object disagrees is unverified", async () => {
    const services = fakeServices({
      pending: () => ({
        status: "admitted",
        admission: {
          request_id: REQUEST_ID,
          action_id: "act-x",
          admitted_at: new Date().toISOString(),
          receipt_id: "r-1",
          readback: {
            state: "Admitted",
            admission_status: "Admitted",
            operation_id: ADMIT_OP,
            idempotency_key: ADMIT_KEY,
          },
        },
      }),
    });
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    // The holder's own self-update writing Admitted with other identifiers.
    services.selfUpdate({
      ...issuedCustom(),
      state: "Admitted",
      admissionStatus: "Admitted",
    });
    expect(
      (await new Browser().admission({ transition: "check" })).body.state,
    ).toEqual({ status: "unverified", requestId: REQUEST_ID });
  });

  it("a self-update the runtime does not know of reads as no request", async () => {
    const services = fakeServices({ pending: () => ({ status: "none" }) });
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    services.selfUpdate({
      ...issuedCustom(),
      state: "Admitted",
      admissionStatus: "Admitted",
    });
    expect(
      (await new Browser().admission({ transition: "check" })).body.state,
    ).toEqual({ status: "none" });
  });
});

describe("the original issue", () => {
  it("names the same birth operation and action before and after admission changes operation_id", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const before = (await browser.admission({ transition: "pass" })).body
      .pass as Record<string, Record<string, unknown>>;
    expect(before.issuance).toEqual(
      expect.objectContaining({
        birthOperationId: BIRTH_OP,
        birthActionId: "act-mint-0001",
        operationReadback: "current",
        activationHash: ACTIVATION,
      }),
    );
    const { operationId, custom } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    await browser.execute(operationId, custom);
    await browser.admission({
      transition: "record_action",
      operation_id: operationId,
      action_id: "act-admit-0001",
    });
    expect(dual.custom.operation_id).toBe(ADMIT_OP);
    const after = (await browser.reopen().admission({ transition: "pass" }))
      .body.pass as Record<string, Record<string, unknown>>;
    expect(after.issuance).toEqual({
      ...before.issuance,
      operationReadback: "superseded",
    });
  });

  it("shows no original issue when the proof contradicts the fresh object", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    // A fresh object whose activation hash is not the proof's.
    dual = {
      ...dual,
      custom: { ...issuedCustom(), activation_hash: "9".repeat(64) },
    };
    const pass = (await new Browser().admission({ transition: "pass" })).body
      .pass as Record<string, unknown>;
    expect(pass.issuance).toBeNull();
  });
});

describe("capability and session", () => {
  it("without the admission block the steps are refused and nothing is called", async () => {
    configure({ admission: false });
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    expect(
      (await new Browser().admission({ transition: "check" })).body,
    ).toEqual({ code: "capability_not_granted" });
    expect(services.calls).toEqual([]);
  });

  it("another account's session cannot execute this launch's step", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    // Signed in again as another wallet in the same browser: the launch
    // journal is sealed to the first session and reads as empty.
    getWallet.mockResolvedValue({ ...(await getWallet()), id: "wallet-2" });
    const other = new Browser();
    other.cookies = new Map(
      [...browser.cookies].filter(
        ([name]) => !name.includes("smarttoken_viewer"),
      ),
    );
    for (const [name, value] of new Browser().cookies)
      other.cookies.set(name, value);
    expect(
      (await other.execute(operationId, custom)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(services.executions).toBe(0);
  });

  it("answers the browser with no assertion, token or runtime address", async () => {
    const services = fakeServices();
    global.fetch = services.fetchImpl as unknown as typeof fetch;
    const browser = new Browser();
    const { operationId, custom } = await begun(browser);
    await browser.admission({
      transition: "confirm",
      operation_id: operationId,
    });
    await browser.execute(operationId, custom);
    await browser.admission({
      transition: "record_action",
      operation_id: operationId,
      action_id: "act-admit-0001",
    });
    await browser.admission({ transition: "pass" });
    const all = seen.join("\n");
    expect(all).not.toMatch(
      /assertion|eyJ|faces\.example|access_?token|refresh/i,
    );
  });
});
