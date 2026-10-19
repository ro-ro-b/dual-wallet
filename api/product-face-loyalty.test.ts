/**
 * @jest-environment node
 */
// loyalty-join-earn-v1, wallet side, through the REAL route handler, session,
// journal cookies and assertions. The Loyalty runtime, Dual's authenticated
// reads and the provider's public object, action log and history are LOCAL
// FICTIONAL FAKES: this proves the wallet's half and its proof rules only,
// not the Studio runtime, not live Dual.
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
const objectsApi = {
  getObjectById: jest.fn(),
  listObjects: jest.fn(),
  getObjectByIdPublic: jest.fn(),
  listStateChangesPublic: jest.fn(),
};
const ebusApi = { listActionLogsPublic: jest.fn() };
jest.mock("@/api/web-sdk-client", () => ({
  getWalletsApi: () => ({ getWallet, logout: jest.fn() }),
  getObjectsApi: () => objectsApi,
  getEbusApi: () => ebusApi,
}));
/** A BFF failure injected AFTER the runtime answered (its proof reads). */
const mockFault = { afterDispatch: false };
jest.mock("@/api/loyalty-provider", () => {
  const actual = jest.requireActual("@/api/loyalty-provider");
  return {
    ...actual,
    publicAction: (...args: unknown[]) => {
      if (mockFault.afterDispatch) {
        throw new Error("the wallet BFF failed after the runtime answered");
      }
      return actual.publicAction(...args);
    },
  };
});

import { resetIssueGuard } from "@/api/product-face-operations";
import { establishSessionState } from "@/api/server-session";
import { ResponseError } from "@/api/web-sdk/runtime";
import { resetWalletHostCache } from "@/api/wallet-host";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import { POST as loyaltyPOST } from "@/app/api/faces/[slug]/loyalty/route";

const SLUG = "morrow-home";
const ORG = DEFAULT_ORGANIZATION_ID;
const OTHER_ORG = "6b00000000000000000000ff";
const CANON_TEMPLATE = "6c0000000000000000000001";
const PASS_TEMPLATE = "6c0000000000000000000002";
const CANON = "6c00000000000000000000c1";
const PASS = "6c00000000000000000000d1";
const ISSUER = "0x00000000000000000000000000000000000000e1";
const FORGER = "0x00000000000000000000000000000000000000f9";
const PURPOSE = "membership-loyalty-rewards";
const keys = generateKeyPairSync("ed25519");
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = (value: string) => `sha256:${hex(value)}`;
const MEMBER = sha("wallet-1");
const FINGERPRINT = sha("fictional-consent");

const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: CANON_TEMPLATE,
  passTemplateId: PASS_TEMPLATE,
  canonicalIssuerAccount: ISSUER,
};

function configure({ loyalty = true, journey = true } = {}) {
  const document = morrowDocument();
  edit(document, "entrance.origin", "http://localhost");
  edit(document, "entrance.organizationId", ORG);
  edit(document, "navigation", []);
  edit(document, "journeys", {
    ...(document.journeys as HostJourneys),
    ...(journey ? { loyalty: true } : {}),
  });
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, {
      PRODUCT_FACE_APPLICATIONS: JSON.stringify([
        { ...morrowBinding(), ...(loyalty ? { loyalty: LOYALTY } : {}) },
      ]),
    }),
  );
}

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** Everything the BFF answered the browser. */
let seen: string[];

class Browser {
  cookies = new Map<string, string>();
  constructor(readonly launchId = `launch-${"q".repeat(28)}`) {
    const response = NextResponse.json({});
    establishSessionState(
      response,
      {
        accessToken: jwt({
          org_id: ORG,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refreshToken: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
      } as unknown as LoginOut,
      { organizationId: ORG, subdomain: "*", host: "localhost" },
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
  /** The same page in a second, concurrent request: the same cookies. */
  twin() {
    const next = new Browser(this.launchId);
    next.cookies = new Map(this.cookies);
    return next;
  }
  /** The same browser after a reload: same cookies, a new launch. */
  reopen() {
    const next = new Browser(`launch-${"r".repeat(28)}`);
    next.cookies = new Map(this.cookies);
    return next;
  }
  /** Signed in again (a new session): only the launch journals carry over. */
  signInAgain() {
    const next = new Browser(`launch-${"s".repeat(28)}`);
    for (const [name, value] of this.cookies) {
      if (name.includes("face_launch")) next.cookies.set(name, value);
    }
    return next;
  }
  /**
   * One request to the real route. `lose` throws the ENTIRE answer away
   * after the BFF ran it (body and Set-Cookie): the browser keeps exactly the
   * cookies it sent.
   */
  async loyalty(body: Record<string, unknown>, { lose = false } = {}) {
    const response = await loyaltyPOST(
      new NextRequest(`http://localhost/api/faces/${SLUG}/loyalty`, {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          "content-type": "application/json",
          "x-dual-face-launch": this.launchId,
          cookie: Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; "),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    seen.push(JSON.stringify(parsed));
    if (lose) return { status: 0, body: {} };
    this.take(response);
    return { status: response.status, body: parsed };
  }
}

// ------------------------------------------------------------ the world

interface Obj {
  id: string;
  templateId: string;
  orgId: string;
  owner: string;
  nonce: number;
  stateHash: string;
  contentHash: string;
  custom: Record<string, unknown>;
}
interface Log {
  id: string;
  name: string;
  account: string;
  affectedObjects: Array<{
    id: string;
    templateId: string;
    stateChangeId: string;
  }>;
  params: { to?: string; templateId?: string };
}
interface Change {
  id: string;
  actionId: string;
  actionName: string;
  objectId: string;
  nextNonce: number;
  nextContentHash: string;
  prevOwner: string;
  currentOwner: string;
}

/**
 * A FICTIONAL programme world: the issuer-owned canonical membership, the
 * member's pass, the provider's logs and history, and the runtime's
 * retained receipts. Mutations are what Studio staff would do.
 */
function world() {
  let counter = 0;
  const objects = new Map<string, Obj>();
  const logs = new Map<string, Log>();
  const changes: Change[] = [];
  let join: Record<string, unknown> | null = null;
  let approval: "pending" | "approved" | "declined" = "pending";
  let opening: Record<string, unknown> | null = null;
  let passCreated = false;
  /** A dishonest runtime: its receipts claim maps C was never written with. */
  let forging = false;
  const submissions = new Map<
    string,
    {
      receipt: Record<string, unknown>;
      submission: Record<string, unknown>;
      verification?: Record<string, unknown>;
    }
  >();

  const fingerprint = (value: unknown) => `0x${hex(canonicalJson(value))}`;
  function act(
    objectId: string,
    name: "mint" | "update",
    account: string,
    written: Record<string, unknown>,
    init?: { templateId: string; owner: string; to?: string },
  ) {
    counter += 1;
    const actionId = `act-${String(counter).padStart(4, "0")}`;
    const stateChangeId = `sc-${String(counter).padStart(4, "0")}`;
    const before = objects.get(objectId);
    const object: Obj = before
      ? { ...before, custom: written, nonce: before.nonce + 1 }
      : {
          id: objectId,
          templateId: init!.templateId,
          orgId: ORG,
          owner: init!.owner,
          nonce: 1,
          stateHash: "",
          contentHash: "",
          custom: written,
        };
    object.contentHash = fingerprint({ written, nonce: object.nonce });
    object.stateHash = fingerprint({ owner: object.owner, n: object.nonce });
    objects.set(objectId, object);
    logs.set(actionId, {
      id: actionId,
      name,
      account,
      affectedObjects: [
        { id: objectId, templateId: object.templateId, stateChangeId },
      ],
      params: init?.to ? { to: init.to, templateId: object.templateId } : {},
    });
    changes.push({
      id: stateChangeId,
      actionId,
      actionName: name,
      objectId,
      nextNonce: object.nonce,
      nextContentHash: object.contentHash,
      prevOwner: before?.owner ?? "0x0000000000000000000000000000000000000000",
      currentOwner: object.owner,
    });
    return {
      action_id: actionId,
      action_name: name,
      object_id: objectId,
      account,
      next_nonce: object.nonce,
      readback_content_hash: object.contentHash,
      written_custom: written,
      written_custom_hash: sha(canonicalJson(written)),
    };
  }
  const base = (state: string) => ({
    generic_semantic_purpose: PURPOSE,
    recordId: "mbr-fictional-0001",
    title: "Harbour Makers Circle membership",
    programmeId: "HARBOUR-MAKERS",
    memberReference: MEMBER,
    state,
    tierStatus: "",
    eligibilitySummary: "",
    benefitReference: "",
    redemptionStatus: "",
  });
  const canonicalRead = () => {
    const object = objects.get(CANON)!;
    return {
      object_id: object.id,
      template_id: object.templateId,
      org_id: object.orgId,
      owner: object.owner,
      nonce: object.nonce,
      state_hash: object.stateHash,
      content_hash: object.contentHash,
      custom: object.custom,
      read: "authenticated_exact",
      read_at: new Date().toISOString(),
    };
  };
  const zero = (reason: string) => ({ dual_writes: 0, reason });

  return {
    objects,
    logs,
    changes,
    submissions,
    /** Staff: approve the join (zero Dual writes). */
    approve() {
      approval = "approved";
    },
    decline() {
      approval = "declined";
    },
    /** Staff: create the canonical membership (issuer-owned, issuer-signed). */
    create(written: Record<string, unknown> = base("Member")) {
      opening = {
        ...act(CANON, "mint", ISSUER, written, {
          templateId: CANON_TEMPLATE,
          owner: ISSUER,
          to: ISSUER,
        }),
        semantic: "create_membership",
      };
    },
    /** Runtime: the member's opening pass, minted by the issuer to them. */
    pass(custom: Partial<Record<string, unknown>> = {}) {
      act(
        PASS,
        "mint",
        ISSUER,
        {
          passType: "Membership opening acknowledgement",
          canonicalOpeningReference: sha("opening"),
          participantReference: sha("participant"),
          openingState: "Member",
          openingSnapshotHash: sha("snapshot"),
          acknowledgement:
            "This pass acknowledges one verified membership opening.",
          schema: "participant-opening-pass-v1",
          product_type: "participant_opening_pass",
          canonical_object_id: CANON,
          canonical_template_id: CANON_TEMPLATE,
          canonical_issuer_account: ISSUER,
          organization_id: ORG,
          opening_action_id: String(opening!.action_id),
          opening_snapshot_hash: sha("snapshot"),
          activation_hash: "a".repeat(64),
          idempotency_key: sha("pass"),
          operation_id: String(opening!.action_id),
          ...custom,
        },
        {
          templateId: PASS_TEMPLATE,
          owner: HOLDER.toLowerCase(),
          to: HOLDER.toLowerCase(),
        },
      );
      passCreated = true;
    },
    /** Staff: an activity verifier accepts the pending submission. */
    verify(operationId: string) {
      const held = submissions.get(operationId)!;
      held.verification = {
        ...act(CANON, "update", ISSUER, {
          ...base("Activity verified"),
          lifecycle: {
            current_state: "Activity verified",
            target_state: "Activity verified",
            action_id: `${PURPOSE}_verify_activity_evt-${operationId}`,
          },
          proof_event: { public_fields: ["action:verify_activity"] },
        }),
        semantic: "verify_activity",
      };
    },
    /** The runtime's receipts from here on claim maps never written. */
    forgeSubmissions() {
      forging = true;
    },
    /**
     * A genuine issuer update at the very next nonce that left C a Member,
     * claimed as this submission's verification (map rewritten, rehashed).
     */
    forgeVerification(operationId: string) {
      const held = submissions.get(operationId)!;
      const claimed = {
        ...base("Activity verified"),
        lifecycle: {
          current_state: "Activity verified",
          target_state: "Activity verified",
          action_id: `${PURPOSE}_verify_activity_evt-${operationId}`,
        },
        proof_event: { public_fields: ["action:verify_activity"] },
      };
      held.verification = {
        ...act(CANON, "update", ISSUER, base("Member")),
        written_custom: claimed,
        written_custom_hash: sha(canonicalJson(claimed)),
        semantic: "verify_activity",
      };
    },
    /** Any other issuer change to the canonical record. */
    touch() {
      act(CANON, "update", ISSUER, base("Member"));
    },
    canonicalRead,
    /** The runtime's answer to one operation. */
    answer(
      operation: string,
      operationId: string,
      input: Record<string, unknown>,
    ): [number, unknown] {
      switch (operation) {
        case "loyalty.programme.read":
          return [
            200,
            {
              ok: true,
              status: "programme_open",
              programme: {
                model_id: "harbour-makers",
                programme_id: "HARBOUR-MAKERS",
                revision_hash: sha("revision"),
                name: "Harbour Makers Circle",
                headline: "Make, learn and unlock studio time",
                member_promise: "Verified workshops count.",
                terms_version: "HMC-2026-1",
                consent_statement:
                  "I agree that my verified workshops are recorded.",
                data_use: "Used only for this programme.",
                consent_fingerprint: FINGERPRINT,
                activities: [
                  {
                    activity_type: "workshop",
                    label: "Workshop attendance",
                    evidence_hint: "Workshop sign-in",
                  },
                ],
              },
              accounting: zero("programme_read"),
            },
          ];
        case "loyalty.join.request": {
          const consent = input.consent as Record<string, unknown>;
          if (consent.fingerprint !== FINGERPRINT) {
            return [
              409,
              {
                ok: false,
                status: "consent_changed",
                accounting: zero("consent_changed"),
              },
            ];
          }
          if (join) {
            return [
              409,
              {
                ok: false,
                status: "join_already_requested",
                accounting: zero("join_already_requested"),
              },
            ];
          }
          join = {
            request_id: `areq_${"j".repeat(24)}`,
            terms_version: "HMC-2026-1",
            consent_hash: sha("consent-record"),
            requested_at: "2026-10-19T09:00:00.000Z",
          };
          return [
            200,
            {
              ok: true,
              status: "join_requested",
              join,
              accounting: zero("join_request_recorded"),
            },
          ];
        }
        case "loyalty.membership.read": {
          const accounting = zero("membership_read");
          if (!join) return [200, { ok: true, status: "none", accounting }];
          if (!opening) {
            const status =
              approval === "pending"
                ? "pending_approval"
                : approval === "declined"
                  ? "declined"
                  : "pending_creation";
            return [
              200,
              {
                ok: true,
                status,
                join,
                approval: {
                  status: approval,
                  ...(approval === "pending"
                    ? {}
                    : { decided_at: "2026-10-19T10:00:00.000Z" }),
                  accounting: zero(
                    approval === "pending"
                      ? "join_pending_approval"
                      : approval === "declined"
                        ? "join_declined"
                        : "join_approved",
                  ),
                },
                accounting,
              },
            ];
          }
          if (!passCreated) {
            return [
              200,
              {
                ok: true,
                status: "pending_pass",
                canonical: canonicalRead(),
                opening,
                accounting,
              },
            ];
          }
          return [
            200,
            {
              ok: true,
              status: "active",
              canonical: canonicalRead(),
              opening,
              pass: { object_id: PASS, template_id: PASS_TEMPLATE },
              accounting,
            },
          ];
        }
        case "loyalty.activity.submit": {
          // Idempotent by operationId, looked up before any other check.
          if (submissions.has(operationId)) {
            return [
              409,
              {
                ok: false,
                status: "operation_already_received",
                accounting: zero("operation_already_received"),
              },
            ];
          }
          const evidenceHash = sha(String(input.evidence_ref));
          if (
            [...submissions.values()].some(
              (item) => item.submission.evidence_hash === evidenceHash,
            )
          ) {
            return [
              409,
              {
                ok: false,
                status: "loyalty_activity_evidence_duplicate",
                accounting: zero("loyalty_activity_evidence_duplicate"),
              },
            ];
          }
          const claimed = {
            ...base("Activity pending"),
            lifecycle: {
              current_state: "Activity pending",
              target_state: "Activity pending",
              action_id: `${PURPOSE}_submit_activity_evt-${operationId}`,
            },
            proof_event: {
              public_fields: [
                "action:submit_activity",
                `activityEvidenceHash:${evidenceHash}`,
              ],
            },
          };
          // Forging: a GENUINE issuer update that left C a Member, claimed
          // as this submission with its retained map rewritten and rehashed.
          const receipt = {
            ...act(CANON, "update", ISSUER, forging ? base("Member") : claimed),
            written_custom: claimed,
            written_custom_hash: sha(canonicalJson(claimed)),
            semantic: "submit_activity",
          };
          const submission = {
            evidence_hash: evidenceHash,
            activity_type: input.activity_type,
            submitted_at: new Date().toISOString(),
          };
          submissions.set(operationId, { receipt, submission });
          return [
            200,
            {
              ok: true,
              status: "activity_submitted",
              submission,
              canonical: canonicalRead(),
              action: receipt,
              accounting: { dual_writes: 1, reason: "activity_submitted" },
            },
          ];
        }
        case "loyalty.activity.status": {
          const held = submissions.get(operationId);
          if (!held) {
            return [
              200,
              {
                ok: true,
                status: "not_received",
                accounting: zero("operation_not_received"),
              },
            ];
          }
          return [
            200,
            {
              ok: true,
              status: held.verification ? "verified" : "submitted",
              submission: held.submission,
              canonical: canonicalRead(),
              action: held.receipt,
              ...(held.verification ? { verification: held.verification } : {}),
            },
          ];
        }
      }
      return [400, { ok: false, status: "face_request_invalid" }];
    },
  };
}

type World = ReturnType<typeof world>;
let w: World;
/** The holder's pass read: answered, or a provider failure / malformed body. */
let passRead: "ok" | "malformed" | 401 | 403 | 404 | 503;
/** Operations the fake runtime received, in order. */
let received: Array<{ operation: string; operationId: string }>;
/** Per-call overrides: lose a reply, lose a request, or rewrite one. */
let lose: Set<string>;
let neverReached: Set<string>;
let rewrite: (
  operation: string,
  answer: [number, unknown],
) => [number, unknown];

const runtimeFetch = jest.fn(async (url: string, init: RequestInit) => {
  expect(new URL(url).origin).toBe("https://faces.example");
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  const claims = JSON.parse(
    Buffer.from(String(body.assertion).split(".")[1], "base64url").toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
  const operation = String(body.operation);
  const requestHash = sha(
    canonicalJson({
      operation,
      operationId: body.operationId,
      target: body.target,
      input: body.input,
    }),
  );
  // What the contract asks of the runtime: an exact, request-bound assertion.
  if (
    claims.operation !== operation ||
    claims.op_id !== body.operationId ||
    claims.request_hash !== requestHash ||
    claims.holder !== HOLDER.toLowerCase() ||
    claims.sub !== "wallet-1" ||
    canonicalJson(claims.target) !== canonicalJson(body.target) ||
    (body.target as Record<string, unknown>).model_id !== "harbour-makers"
  ) {
    return Response.json(
      { ok: false, status: "face_assertion_mismatch" },
      {
        status: 403,
      },
    );
  }
  if (neverReached.has(operation)) {
    neverReached.delete(operation);
    throw new TypeError(`${operation} never reached the runtime`);
  }
  received.push({ operation, operationId: String(body.operationId) });
  const answer = rewrite(
    operation,
    w.answer(
      operation,
      String(body.operationId),
      body.input as Record<string, unknown>,
    ),
  );
  if (lose.has(operation)) {
    lose.delete(operation);
    throw new TypeError(`connection reset after ${operation}`);
  }
  return Response.json(answer[1], { status: answer[0] });
});

const original = global.fetch;
beforeEach(() => {
  seen = [];
  received = [];
  passRead = "ok";
  mockFault.afterDispatch = false;
  resetIssueGuard();
  lose = new Set();
  neverReached = new Set();
  rewrite = (_operation, answer) => answer;
  w = world();
  process.env.FACE_ASSERTION_KEY_ID = "wallet-face-test";
  process.env.FACE_ASSERTION_SIGNING_KEY = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  configure();
  global.fetch = runtimeFetch as unknown as typeof fetch;
  runtimeFetch.mockClear();
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
  // The provider's public views and the holder's own authenticated list.
  objectsApi.getObjectByIdPublic
    .mockReset()
    .mockImplementation(async ({ objectId }: { objectId: string }) => {
      const object = w.objects.get(objectId);
      if (!object) throw new Error("not found");
      const published = [
        "recordId",
        "title",
        "memberReference",
        "programmeId",
        "state",
      ];
      return {
        ...object,
        custom: Object.fromEntries(
          published
            .filter((key) => key in object.custom)
            .map((key) => [key, object.custom[key]]),
        ),
      };
    });
  objectsApi.listStateChangesPublic
    .mockReset()
    .mockImplementation(
      async (input: { objectId: string; id?: string; order?: string }) => {
        const own = w.changes.filter(
          (change) => change.objectId === input.objectId,
        );
        const picked = input.id
          ? own.filter((change) => change.id === input.id)
          : input.order === "asc"
            ? own.slice(0, 1)
            : own.slice(-1);
        return { stateChanges: picked };
      },
    );
  // The holder's own list: newest first, at most 25 a page, every filter
  // (id included) applied, like the provider's.
  objectsApi.listObjects
    .mockReset()
    .mockImplementation(
      async (input: {
        id?: string;
        owner: string;
        templateId: string;
        limit?: number;
      }) => {
        if (passRead !== "ok") {
          if (passRead === "malformed") return { items: [] };
          throw new ResponseError(
            new Response(null, { status: passRead }),
            "fictional provider failure",
          );
        }
        return {
          objects: [...w.objects.values()]
            .reverse()
            .filter(
              (object) =>
                object.owner.toLowerCase() === input.owner.toLowerCase() &&
                object.templateId === input.templateId &&
                (!input.id || object.id === input.id),
            )
            .slice(0, Math.min(input.limit ?? 25, 25)),
        };
      },
    );
  objectsApi.getObjectById.mockReset();
  ebusApi.listActionLogsPublic
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) => ({
      actionLogs: w.logs.has(id) ? [w.logs.get(id)] : [],
    }));
});
afterEach(() => {
  global.fetch = original;
  delete process.env.FACE_ASSERTION_KEY_ID;
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
  clearHostEnvironment();
  resetWalletHostCache();
  jest.restoreAllMocks();
});

const consent = {
  accepted: true,
  terms_version: "HMC-2026-1",
  fingerprint: FINGERPRINT,
};
const membership = async (browser: Browser) =>
  (await browser.loyalty({ transition: "membership" })).body;
const count = (operation: string) =>
  received.filter((call) => call.operation === operation).length;

/**
 * The page's submission: `prepare` (journalled, returned, nothing sent),
 * then one `submit` of exactly that operation. `lose` throws the submit's
 * whole answer away, Set-Cookie included.
 */
async function prepare(browser: Browser, evidence = "Workshop sign-in 0042") {
  return browser.loyalty({
    transition: "prepare",
    activity_type: "workshop",
    evidence_ref: evidence,
  });
}
const preparedId = (answer: { body: Record<string, unknown> }) =>
  String((answer.body.prepared as Record<string, unknown>).operationId);
async function submitPrepared(
  browser: Browser,
  operationId: string,
  evidence = "Workshop sign-in 0042",
  options: { lose?: boolean } = {},
) {
  return browser.loyalty(
    {
      transition: "submit",
      operation_id: operationId,
      activity_type: "workshop",
      evidence_ref: evidence,
    },
    options,
  );
}
async function submit(
  browser: Browser,
  evidence = "Workshop sign-in 0042",
  options: { lose?: boolean } = {},
) {
  const prepared = await prepare(browser, evidence);
  if (prepared.status !== 200) return prepared;
  return submitPrepared(browser, preparedId(prepared), evidence, options);
}
const statusOf = async (browser: Browser, operationId: unknown) =>
  (await browser.loyalty({ transition: "status", operation_id: operationId }))
    .body.submission as Record<string, unknown>;

/** Joined, approved, created and passed: a proven active member. */
async function activeMember(browser = new Browser()) {
  await browser.loyalty({ transition: "join", consent });
  w.approve();
  w.create();
  w.pass();
  return browser;
}

describe("only a host and binding that state loyalty-join-earn-v1 serve Loyalty", () => {
  it("a binding without the loyalty block, or a host without the journey, is refused with no runtime call", async () => {
    configure({ loyalty: false, journey: false });
    const refused = await new Browser().loyalty({ transition: "programme" });
    expect(refused.status).toBeGreaterThanOrEqual(403);
    configure({ loyalty: true, journey: false });
    expect(
      (await new Browser().loyalty({ transition: "programme" })).status,
    ).toBeGreaterThanOrEqual(403);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("reads the bound programme, and refuses an answer without exact zero-write accounting", async () => {
    const browser = new Browser();
    const read = await browser.loyalty({ transition: "programme" });
    expect(read.status).toBe(200);
    expect(read.body.programme).toEqual(
      expect.objectContaining({
        name: "Harbour Makers Circle",
        termsVersion: "HMC-2026-1",
        consentFingerprint: FINGERPRINT,
      }),
    );
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.programme.read"
        ? [status, { ...(body as object), accounting: undefined }]
        : [status, body];
    expect((await browser.loyalty({ transition: "programme" })).status).toBe(
      502,
    );
  });
});

describe("join: the member's own consent, a programme record, zero Dual writes", () => {
  it("records the join only with the runtime's exact zero-write accounting", async () => {
    const browser = new Browser();
    const joined = await browser.loyalty({ transition: "join", consent });
    expect(joined.status).toBe(200);
    expect(joined.body.join).toEqual(
      expect.objectContaining({ termsVersion: "HMC-2026-1" }),
    );
    expect(w.changes).toHaveLength(0);
    expect((await membership(browser)).membership).toEqual(
      expect.objectContaining({ status: "pending_approval" }),
    );
  });

  it("refuses without consent, without any runtime call", async () => {
    const answer = await new Browser().loyalty({
      transition: "join",
      consent: { ...consent, accepted: false },
    });
    expect(answer).toEqual({
      status: 400,
      body: expect.objectContaining({ code: "consent_required" }),
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("passes on an exact zero-write refusal, and treats one without accounting as unavailable", async () => {
    const browser = new Browser();
    expect(
      (
        await browser.loyalty({
          transition: "join",
          consent: { ...consent, fingerprint: sha("other terms") },
        })
      ).body,
    ).toEqual(expect.objectContaining({ code: "consent_changed" }));
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.join.request"
        ? [409, { ok: false, status: "consent_changed" }]
        : [status, body];
    expect(
      (await browser.loyalty({ transition: "join", consent })).status,
    ).toBe(502);
  });

  it("reports approval and decline only as the programme's zero-write records", async () => {
    const browser = new Browser();
    await browser.loyalty({ transition: "join", consent });
    w.approve();
    expect((await membership(browser)).membership).toEqual(
      expect.objectContaining({ status: "pending_creation" }),
    );
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.membership.read") return [status, body];
      const value = body as Record<string, unknown>;
      return [
        status,
        {
          ...value,
          approval: {
            ...(value.approval as object),
            accounting: { dual_writes: 1, reason: "join_approved" },
          },
        },
      ];
    };
    expect((await browser.loyalty({ transition: "membership" })).status).toBe(
      502,
    );
  });
});

describe("membership is active only from fresh, exact, role-bound evidence", () => {
  it("is pending creation, then pending its pass, then active with the holder's own pass", async () => {
    const browser = new Browser();
    await browser.loyalty({ transition: "join", consent });
    w.approve();
    w.create();
    expect((await membership(browser)).membership).toEqual({
      status: "pending_pass",
    });
    w.pass();
    expect((await membership(browser)).membership).toEqual({
      status: "active",
      membership: expect.objectContaining({
        objectId: CANON,
        state: "Member",
      }),
    });
  });

  it.each([
    [
      "another client's record",
      () => (w.objects.get(CANON)!.orgId = OTHER_ORG),
    ],
    [
      "another member's record",
      () =>
        (w.objects.get(CANON)!.custom = {
          ...w.objects.get(CANON)!.custom,
          memberReference: sha("wallet-2"),
        }),
    ],
    [
      "a mint signed by someone else",
      () => {
        const log = [...w.logs.values()][0];
        log.account = FORGER;
      },
    ],
    [
      "a history that does not match the receipt",
      () => {
        w.changes[0].nextContentHash = "0xdeadbeefdeadbeefdeadbeef";
      },
    ],
    [
      "a pass for another membership",
      () => {
        w.objects.get(PASS)!.custom = {
          ...w.objects.get(PASS)!.custom,
          canonical_object_id: "6c00000000000000000000c9",
        };
      },
    ],
    [
      "a pass minted by someone else",
      () => {
        const passLog = [...w.logs.values()].find(
          (log) => log.affectedObjects[0].id === PASS,
        )!;
        passLog.account = FORGER;
      },
    ],
  ])("is never active for %s", async (_label, forge) => {
    const browser = await activeMember();
    forge();
    expect((await membership(browser)).membership).toEqual({
      status: "unconfirmed",
    });
  });

  it("is not active when the pass is not in the holder's own wallet", async () => {
    const browser = await activeMember();
    w.objects.get(PASS)!.owner = FORGER;
    expect((await membership(browser)).membership).toEqual({
      status: "pending_pass",
    });
  });
});

describe("activity: submitted, then counted, only from proof of exactly this submission", () => {
  it("submits once, journalled, and proves it submitted from the issuer-signed receipt and history", async () => {
    const browser = await activeMember();
    const sent = await submit(browser, "Workshop sign-in 0042");
    expect(sent.status).toBe(200);
    expect(sent.body.submission).toEqual(
      expect.objectContaining({
        activityType: "workshop",
        status: "submitted",
      }),
    );
    expect(count("loyalty.activity.submit")).toBe(1);
    // The member signed nothing; the issuer's update is the only write.
    expect(w.logs.size).toBe(3);
    expect([...w.logs.values()].every((log) => log.account === ISSUER)).toBe(
      true,
    );
    // The evidence text never comes back to the browser.
    expect(seen.join("\n")).not.toContain("Workshop sign-in 0042");
  });

  it("counts it only when the verifier's update is the very next change after it", async () => {
    const browser = await activeMember();
    const sent = await submit(browser, "Workshop sign-in 0042");
    const operationId = String(
      (sent.body.submission as Record<string, unknown>).operationId,
    );
    expect(
      (
        await browser.loyalty({
          transition: "status",
          operation_id: operationId,
        })
      ).body.submission,
    ).toEqual(expect.objectContaining({ status: "submitted" }));
    w.verify(operationId);
    expect(
      (
        await browser.loyalty({
          transition: "status",
          operation_id: operationId,
        })
      ).body.submission,
    ).toEqual(expect.objectContaining({ status: "counted" }));
  });

  it("a later or unrelated verified action is never proof of this submission", async () => {
    const browser = await activeMember();
    const sent = await submit(browser, "Workshop sign-in 0042");
    const operationId = String(
      (sent.body.submission as Record<string, unknown>).operationId,
    );
    // Another change lands between the submission and this verification.
    w.touch();
    w.verify(operationId);
    expect(
      (
        await browser.loyalty({
          transition: "status",
          operation_id: operationId,
        })
      ).body.submission,
    ).toEqual(expect.objectContaining({ status: "submitted" }));
  });

  it.each([
    [
      "the evidence hash of another submission",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        written_custom: {
          ...(receipt.written_custom as object),
          proof_event: {
            public_fields: [`activityEvidenceHash:${sha("someone else")}`],
          },
        },
      }),
    ],
    [
      "a written map that does not hash to its receipt",
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        written_custom_hash: sha("tampered"),
      }),
    ],
    [
      "a signer other than the issuer",
      (receipt: Record<string, unknown>) => ({ ...receipt, account: FORGER }),
    ],
  ])("never confirms a submission with %s", async (_label, forge) => {
    const browser = await activeMember();
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.activity.submit" && status === 200
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              action: forge(
                (body as Record<string, unknown>).action as Record<
                  string,
                  unknown
                >,
              ),
            },
          ]
        : [status, body];
    const sent = await submit(browser, "Workshop sign-in 0042");
    expect(sent.body.submission).toEqual(
      expect.objectContaining({ status: "unconfirmed" }),
    );
  });

  it("a duplicate is the runtime's exact zero-write refusal; a refusal without accounting stays unknown", async () => {
    const browser = await activeMember();
    const first = await submit(browser, "Workshop sign-in 0042");
    // Verified, so the lifecycle offers a new activity again.
    w.verify(
      String((first.body.submission as Record<string, unknown>).operationId),
    );
    const again = await submit(browser.reopen(), "Workshop sign-in 0042");
    expect(again.body).toEqual(
      expect.objectContaining({ code: "loyalty_activity_evidence_duplicate" }),
    );
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.activity.submit"
        ? [409, { ok: false, status: "loyalty_activity_evidence_duplicate" }]
        : [status, body];
    const unaccounted = await submit(browser, "Workshop sign-in 0043");
    expect(unaccounted.body.submission).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
  });

  it("refuses to submit for a membership that is not proven active", async () => {
    const browser = new Browser();
    await browser.loyalty({ transition: "join", consent });
    const refused = await submit(browser, "Workshop sign-in 0042");
    expect(refused.body).toEqual(
      expect.objectContaining({ code: "membership_not_active" }),
    );
    expect(count("loyalty.activity.submit")).toBe(0);
  });
});

describe("the application record and the Dual object are distinct identities", () => {
  const RECORD = "mbr-fictional-0001";

  it("proves membership and a submission with a record reference that is not the object id", async () => {
    expect(RECORD).not.toBe(CANON);
    const browser = await activeMember();
    expect(w.objects.get(CANON)!.custom.recordId).toBe(RECORD);
    expect((await membership(browser)).membership).toEqual({
      status: "active",
      membership: expect.objectContaining({ objectId: CANON }),
    });
    const sent = await submit(browser, "Workshop sign-in 0042");
    expect(sent.body.submission).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );
    // The receipt names the object by object_id and the record by recordId.
    const receipt = w.submissions.get(
      String((sent.body.submission as Record<string, unknown>).operationId),
    )!.receipt;
    expect(receipt.object_id).toBe(CANON);
    expect((receipt.written_custom as Record<string, unknown>).recordId).toBe(
      RECORD,
    );
  });

  it("refuses a submission receipt that names another record", async () => {
    const browser = await activeMember();
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.activity.submit" || status !== 200) {
        return [status, body];
      }
      const value = body as Record<string, unknown>;
      const action = value.action as Record<string, unknown>;
      const written = {
        ...(action.written_custom as object),
        recordId: "mbr-forged-0009",
      };
      return [
        status,
        {
          ...value,
          action: {
            ...action,
            written_custom: written,
            // Even internally consistent: the hash is recomputed.
            written_custom_hash: sha(canonicalJson(written)),
          },
        },
      ];
    };
    const sent = await submit(browser, "Workshop sign-in 0042");
    expect(sent.body.submission).toEqual(
      expect.objectContaining({ status: "unconfirmed" }),
    );
  });

  it("refuses an opening receipt that names another record", async () => {
    const browser = await activeMember();
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.membership.read") return [status, body];
      const value = body as Record<string, unknown>;
      const opening = value.opening as Record<string, unknown>;
      const written = {
        ...(opening.written_custom as object),
        recordId: "mbr-forged-0009",
      };
      return [
        status,
        {
          ...value,
          opening: {
            ...opening,
            written_custom: written,
            written_custom_hash: sha(canonicalJson(written)),
          },
        },
      ];
    };
    expect((await membership(browser)).membership).toEqual({
      status: "unconfirmed",
    });
  });

  it("refuses a canonical map whose record reference collapses into its object id", async () => {
    const browser = await activeMember();
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.membership.read") return [status, body];
      const value = body as Record<string, unknown>;
      const canonical = value.canonical as Record<string, unknown>;
      return [
        status,
        {
          ...value,
          canonical: {
            ...canonical,
            custom: {
              ...(canonical.custom as object),
              recordId: CANON,
            },
          },
        },
      ];
    };
    expect((await membership(browser)).membership).toEqual({
      status: "unconfirmed",
    });
  });
});

describe("a lost reply keeps the original operation, across reloads and sign-ins", () => {
  it("is unknown, never sent again, and read back only by its own operation", async () => {
    const browser = await activeMember();
    lose.add("loyalty.activity.submit");
    const sent = await submit(browser, "Workshop sign-in 0042");
    const submission = sent.body.submission as Record<string, unknown>;
    expect(submission.status).toBe("unknown");
    // The same evidence again, from a reloaded page: refused, nothing sent.
    const reloaded = browser.reopen();
    expect((await submit(reloaded, "Workshop sign-in 0042")).body).toEqual(
      expect.objectContaining({ code: "submission_in_progress" }),
    );
    expect(count("loyalty.activity.submit")).toBe(1);
    // A new session of the same wallet finds it and reads its status only.
    const again = reloaded.signInAgain();
    expect((await membership(again)).submissions).toEqual([
      { operationId: submission.operationId, activityType: "workshop" },
    ]);
    expect(
      (
        await again.loyalty({
          transition: "status",
          operation_id: submission.operationId,
        })
      ).body.submission,
    ).toEqual(expect.objectContaining({ status: "submitted" }));
    expect(count("loyalty.activity.submit")).toBe(1);
  });

  it("a runtime that never received it is believed only once its assertion expired", async () => {
    const browser = await activeMember();
    neverReached.add("loyalty.activity.submit");
    const sent = await submit(browser, "Workshop sign-in 0042");
    const submission = sent.body.submission as Record<string, unknown>;
    expect(submission.status).toBe("unknown");
    expect(count("loyalty.activity.submit")).toBe(0);
    const status = async () =>
      (
        await browser.loyalty({
          transition: "status",
          operation_id: submission.operationId,
        })
      ).body.submission as Record<string, unknown>;
    // Its assertion could still arrive: not yet "not received".
    expect((await status()).status).toBe("unknown");
    const later = Date.now() + 5 * 60_000;
    jest.spyOn(Date, "now").mockReturnValue(later);
    expect((await status()).status).toBe("not_received");
    // Nothing was written, so it is no longer listed as a submission.
    expect((await membership(browser)).submissions).toEqual([]);
  });

  it("an expired session refuses before any runtime call and keeps the journal", async () => {
    const browser = await activeMember();
    lose.add("loyalty.activity.submit");
    await submit(browser, "Workshop sign-in 0042");
    const calls = received.length;
    getWallet.mockRejectedValueOnce(
      Object.assign(new Error("expired"), { response: { status: 401 } }),
    );
    const expired = browser.reopen();
    const answer = await expired.loyalty({ transition: "membership" });
    expect([401, 503]).toContain(answer.status);
    expect(received.length).toBe(calls);
    // Signed in again: the original operation is still there to read back.
    const again = browser.signInAgain();
    expect((await membership(again)).submissions).toHaveLength(1);
  });
});

describe("a submission is in the browser's journal before it can leave (§6)", () => {
  const launchJar = (browser: Browser) =>
    [...browser.cookies].filter(([name]) => name.includes("face_launch"));
  const submits = () =>
    received.filter((call) => call.operation === "loyalty.activity.submit");

  it("reads and the join carry no launch journal; prepare does, and sends nothing", async () => {
    const browser = new Browser();
    await browser.loyalty({ transition: "programme" });
    await browser.loyalty({ transition: "join", consent });
    w.approve();
    w.create();
    w.pass();
    await membership(browser);
    expect(launchJar(browser)).toEqual([]);
    const prepared = await prepare(browser);
    expect(prepared.status).toBe(200);
    expect(launchJar(browser)).toHaveLength(1);
    expect(count("loyalty.activity.submit")).toBe(0);
    // Listed (possibly sent) from the moment its journal reached the browser.
    expect((await membership(browser)).submissions).toEqual([
      { operationId: preparedId(prepared), activityType: "workshop" },
    ]);
  });

  it("a submit answer lost whole after the write: the prepared journal finds the original operation, read back only", async () => {
    const browser = await activeMember();
    const operationId = preparedId(await prepare(browser));
    // The runtime writes once; the browser never sees the answer or its cookie.
    await submitPrepared(browser, operationId, "Workshop sign-in 0042", {
      lose: true,
    });
    expect(w.submissions.has(operationId)).toBe(true);
    for (const next of [browser.reopen(), browser.signInAgain()]) {
      expect((await membership(next)).submissions).toEqual([
        { operationId, activityType: "workshop" },
      ]);
      // The same evidence again: refused, nothing prepared or sent.
      expect((await prepare(next)).body).toEqual(
        expect.objectContaining({ code: "submission_in_progress" }),
      );
      expect(await statusOf(next, operationId)).toEqual(
        expect.objectContaining({ operationId, status: "submitted" }),
      );
    }
    // The page replaying its stale prepared journal: not sent again here.
    expect((await submitPrepared(browser, operationId)).body).toEqual(
      expect.objectContaining({ code: "submission_in_progress" }),
    );
    // One write, under its original id; every status read named that id.
    expect(submits()).toEqual([
      { operation: "loyalty.activity.submit", operationId },
    ]);
    expect(
      received
        .filter((call) => call.operation === "loyalty.activity.status")
        .every((call) => call.operationId === operationId),
    ).toBe(true);
    expect(w.logs.size).toBe(3);
  });

  it("past the same-instance damper (another instance), a stale replay is the runtime's operation_already_received: unknown, never a refusal", async () => {
    const browser = await activeMember();
    const operationId = preparedId(await prepare(browser));
    await submitPrepared(browser, operationId, "Workshop sign-in 0042", {
      lose: true,
    });
    resetIssueGuard();
    const replay = await submitPrepared(browser, operationId);
    expect(replay.body.submission).toEqual(
      expect.objectContaining({ operationId, status: "unknown" }),
    );
    // The same operation id, never a new one; still written once.
    expect(submits().map((call) => call.operationId)).toEqual([
      operationId,
      operationId,
    ]);
    expect(w.logs.size).toBe(3);
    expect(await statusOf(browser, operationId)).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );
  });

  it("a BFF failure after the runtime wrote returns the issued journal as unknown; lost whole, the prepared one still finds it", async () => {
    const browser = await activeMember();
    const first = preparedId(await prepare(browser));
    mockFault.afterDispatch = true;
    const kept = await submitPrepared(browser, first);
    mockFault.afterDispatch = false;
    expect(kept.status).toBe(200);
    expect(kept.body.submission).toEqual(
      expect.objectContaining({ operationId: first, status: "unknown" }),
    );
    expect(await statusOf(browser, first)).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );

    // Verified, so the lifecycle offers a new activity again.
    w.verify(first);
    const second = preparedId(await prepare(browser, "Workshop sign-in 0043"));
    mockFault.afterDispatch = true;
    await submitPrepared(browser, second, "Workshop sign-in 0043", {
      lose: true,
    });
    mockFault.afterDispatch = false;
    const reloaded = browser.reopen();
    expect(
      (
        (await membership(reloaded)).submissions as Array<{
          operationId: string;
        }>
      ).map((item) => item.operationId),
    ).toEqual(expect.arrayContaining([first, second]));
    expect(await statusOf(reloaded, second)).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );
    expect(submits().map((call) => call.operationId)).toEqual([first, second]);
  });

  it("two concurrent submits of one prepared operation dispatch once; the other writes no journal", async () => {
    const browser = await activeMember();
    const operationId = preparedId(await prepare(browser));
    const twin = browser.twin();
    const before = launchJar(twin);
    const answers = await Promise.all([
      submitPrepared(browser, operationId),
      submitPrepared(twin, operationId),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const refused = answers.find((answer) => answer.status === 409)!;
    expect(refused.body).toEqual(
      expect.objectContaining({ code: "submission_in_progress" }),
    );
    expect(submits()).toHaveLength(1);
    if (answers[1] === refused) expect(launchJar(twin)).toEqual(before);
  });

  it("two concurrent prepares from one page: only the operation the browser's journal kept can be sent", async () => {
    const browser = await activeMember();
    const twin = browser.twin();
    const [first, second] = await Promise.all([
      prepare(browser),
      prepare(twin),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    // The page's one launch cookie is the later answer's (here the twin's).
    expect((await submitPrepared(twin, preparedId(first))).body).toEqual(
      expect.objectContaining({ code: "unknown_operation" }),
    );
    expect(submits()).toHaveLength(0);
    expect(
      (await submitPrepared(twin, preparedId(second))).body.submission,
    ).toEqual(expect.objectContaining({ status: "submitted" }));
    expect(submits()).toHaveLength(1);
  });

  it("past its window a prepared submission is never minted or sent", async () => {
    const browser = await activeMember();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(t0);
    const operationId = preparedId(await prepare(browser));
    clock.mockReturnValue(t0 + 31_000);
    expect((await submitPrepared(browser, operationId)).body).toEqual(
      expect.objectContaining({ code: "submission_window_closed" }),
    );
    expect(
      runtimeFetch.mock.calls.some(([, init]) =>
        String(init.body).includes('"loyalty.activity.submit"'),
      ),
    ).toBe(false);
    // Still possibly sent as far as this cookie can tell: listed, read back.
    expect((await membership(browser)).submissions).toEqual([
      { operationId, activityType: "workshop" },
    ]);
  });

  it("not_received waits for the latest assertion it could have had, never for the prepare time alone", async () => {
    const browser = await activeMember();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(t0);
    const operationId = preparedId(await prepare(browser));
    // Minted and dispatched at the end of its window; it never arrives
    // (yet), and the answer is lost whole: the cookie says only "prepared".
    clock.mockReturnValue(t0 + 29_000);
    neverReached.add("loyalty.activity.submit");
    await submitPrepared(browser, operationId, "Workshop sign-in 0042", {
      lose: true,
    });
    // 120 s after prepare is NOT 120 s after that assertion.
    clock.mockReturnValue(t0 + 121_000);
    expect(await statusOf(browser, operationId)).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    clock.mockReturnValue(t0 + 149_000);
    expect(await statusOf(browser, operationId)).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    // Window plus the assertion's lifetime and skew: never received, never can be.
    clock.mockReturnValue(t0 + 151_000);
    expect(await statusOf(browser, operationId)).toEqual(
      expect.objectContaining({ status: "not_received" }),
    );
    expect((await membership(browser)).submissions).toEqual([]);
    expect(count("loyalty.activity.submit")).toBe(0);
  });
});

describe("a receipt at the canonical's current nonce is its fresh full map", () => {
  it("a genuine update claimed as this submission over a map C was never written with is never submitted", async () => {
    const browser = await activeMember();
    w.forgeSubmissions();
    const sent = await submit(browser);
    const submission = sent.body.submission as Record<string, unknown>;
    expect(submission.status).toBe("unconfirmed");
    // Its action, signer, state change, nonce and hash are all genuine; the
    // fresh and public map at that nonce still say Member.
    expect(w.objects.get(CANON)!.custom.state).toBe("Member");
    expect(await statusOf(browser, submission.operationId)).toEqual(
      expect.objectContaining({ status: "unconfirmed" }),
    );
  });

  it("a genuine next update claimed as its verification over a map C was never written with is never counted", async () => {
    const browser = await activeMember();
    const sent = await submit(browser);
    const operationId = String(
      (sent.body.submission as Record<string, unknown>).operationId,
    );
    expect(sent.body.submission).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );
    w.forgeVerification(operationId);
    expect(w.objects.get(CANON)!.custom.state).toBe("Member");
    // The submission stays proven (historical receipt); it is not counted.
    expect(await statusOf(browser, operationId)).toEqual(
      expect.objectContaining({ status: "submitted" }),
    );
  });
});

describe("the holder's pass is read by its exact id, and an unavailable read claims no absence", () => {
  it("finds the named pass behind more than a page of newer passes of its template", async () => {
    const browser = await activeMember();
    for (let index = 0; index < 30; index += 1) {
      const id = `6c000000000000000000e0${index.toString(16).padStart(2, "0")}`;
      w.objects.set(id, { ...w.objects.get(PASS)!, id, custom: {} });
    }
    expect((await membership(browser)).membership).toEqual(
      expect.objectContaining({ status: "active" }),
    );
    expect(objectsApi.listObjects).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: PASS,
        owner: HOLDER,
        templateId: PASS_TEMPLATE,
      }),
      expect.anything(),
    );
  });

  it.each([[503], [403], ["malformed"]] as const)(
    "a %s pass read is unconfirmed, never 'not in your wallet yet'",
    async (fault) => {
      const browser = await activeMember();
      passRead = fault;
      expect((await membership(browser)).membership).toEqual({
        status: "unconfirmed",
      });
    },
  );

  it("only an exact empty or not-found read is pending its pass; a 401 is an expired session", async () => {
    const browser = await activeMember();
    passRead = 404;
    expect((await membership(browser)).membership).toEqual({
      status: "pending_pass",
    });
    passRead = "ok";
    w.objects.get(PASS)!.owner = FORGER;
    expect((await membership(browser)).membership).toEqual({
      status: "pending_pass",
    });
    passRead = 401;
    expect((await browser.loyalty({ transition: "membership" })).status).toBe(
      401,
    );
  });
});
