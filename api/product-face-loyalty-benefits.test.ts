/**
 * @jest-environment node
 */
// loyalty-benefit-redeem-v1, wallet side, through the REAL route handler,
// sessions, journal cookies and assertions. The Loyalty runtime, the shared
// stock ledger, Dual's reads and the provider's public object, action log and
// history are LOCAL FICTIONAL FAKES; operator grants, partner confirmations
// and settlements are test hooks standing in for Studio's own scoped role
// sessions. This proves the wallet's half only: not Studio, not live Dual,
// not a partner and not any physical fulfilment.
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
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
import { resetWalletHostCache } from "@/api/wallet-host";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import { POST as loyaltyPOST } from "@/app/api/faces/[slug]/loyalty/route";

const SLUG = "morrow-home";
const ORG = DEFAULT_ORGANIZATION_ID;
const CANON_TEMPLATE = "6c0000000000000000000001";
const PASS_TEMPLATE = "6c0000000000000000000002";
const ISSUER = "0x00000000000000000000000000000000000000e1";
const FORGER = "0x00000000000000000000000000000000000000f9";
const PURPOSE = "membership-loyalty-rewards";
const BENEFIT = "studio-hour";
const PARTNER = { partner_id: "harbour-workshop", name: "Harbour Workshop" };
const keys = generateKeyPairSync("ed25519");
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = (value: string) => `sha256:${hex(value)}`;
const REVISION = sha("fictional-programme-revision-1");
const DAY = 24 * 60 * 60 * 1000;

/** Two FICTIONAL members of one programme, each with their own record. */
const MEMBERS = {
  a: {
    walletId: "wallet-1",
    holder: HOLDER,
    canon: "6c00000000000000000000a1",
    pass: "6c00000000000000000000a2",
    recordId: "mbr-fictional-000a",
  },
  b: {
    walletId: "wallet-2",
    holder: "0x00000000000000000000000000000000000000b2",
    canon: "6c00000000000000000000b1",
    pass: "6c00000000000000000000b2",
    recordId: "mbr-fictional-000b",
  },
} as const;
type Who = keyof typeof MEMBERS;

const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: CANON_TEMPLATE,
  passTemplateId: PASS_TEMPLATE,
  canonicalIssuerAccount: ISSUER,
  benefits: "loyalty-benefit-redeem-v1",
};

function configure({ benefits = true } = {}) {
  const document = morrowDocument();
  edit(document, "entrance.origin", "http://localhost");
  edit(document, "entrance.organizationId", ORG);
  edit(document, "navigation", []);
  edit(document, "journeys", {
    ...(document.journeys as HostJourneys),
    loyalty: true,
  });
  const loyalty: Record<string, unknown> = { ...LOYALTY };
  if (!benefits) delete loyalty.benefits;
  resetWalletHostCache();
  applyHostEnvironment(
    hostEnvironment(document, {
      PRODUCT_FACE_APPLICATIONS: JSON.stringify([
        { ...morrowBinding(), loyalty },
      ]),
    }),
  );
}

function jwt(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** Whose session the request in flight carries (the fake wallet read). */
let current: Who = "a";
/** Everything the BFF answered any browser. */
let seen: string[];

class Browser {
  cookies = new Map<string, string>();
  constructor(
    readonly who: Who = "a",
    readonly launchId = `launch-${"q".repeat(28)}`,
  ) {
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
    const next = new Browser(this.who, this.launchId);
    next.cookies = new Map(this.cookies);
    return next;
  }
  /** After a reload: the same cookies, a new launch. */
  reopen() {
    const next = new Browser(this.who, `launch-${"r".repeat(28)}`);
    next.cookies = new Map(this.cookies);
    return next;
  }
  /** Signed in again: only the launch journals carry over. */
  signInAgain() {
    const next = new Browser(this.who, `launch-${"s".repeat(28)}`);
    for (const [name, value] of this.cookies) {
      if (name.includes("face_launch")) next.cookies.set(name, value);
    }
    return next;
  }
  /** One request; `lose` throws the ENTIRE answer away, Set-Cookie too. */
  async loyalty(body: Record<string, unknown>, { lose = false } = {}) {
    current = this.who;
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
type Receipt = Record<string, unknown>;
interface Reward {
  benefitId: string;
  grant: Receipt;
  allocation: Record<string, unknown>;
  validUntil: string;
  eventId: string;
  /** Earlier attempts a definitive failed handover ended (the same reward). */
  failed: Array<{
    request: Receipt;
    confirmation: Receipt;
    failure: Receipt;
    requestEvent: string;
  }>;
  request?: Receipt;
  requestEvent?: string;
  confirmation?: Receipt;
  recording?: boolean;
  fulfilment?: Receipt;
  handoverRecording?: boolean;
  settlement?: Receipt;
}

const BASE32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** The runtime's own record of one request operation (the r20 echo). */
type Recorded = {
  binding: Record<string, unknown>;
  requestHash: string;
  requestEvent: string;
};

/**
 * A FICTIONAL programme world: each member's issuer-owned canonical record
 * and own pass, the provider's logs and history, one shared stock ledger,
 * and the runtime's retained receipts. Hooks are what Studio staff,
 * the programme operator and the partner would do in their own sessions.
 */
function world() {
  let counter = 0;
  const objects = new Map<string, Obj>();
  const logs = new Map<
    string,
    {
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
  >();
  const changes: Array<{
    id: string;
    actionId: string;
    actionName: string;
    objectId: string;
    nextNonce: number;
    nextContentHash: string;
    prevOwner: string;
    currentOwner: string;
  }> = [];
  const ledger = new Map<string, Record<string, unknown>>();
  /** Units a definitive failure returned to stock (each exactly once). */
  const returned = new Set<string>();
  const stock: Record<string, number> = { [BENEFIT]: 1 };
  let stockStatus: string | null = null;
  const members = Object.fromEntries(
    (Object.keys(MEMBERS) as Who[]).map((who) => [
      who,
      {
        opening: null as Receipt | null,
        pass: false,
        pairs: [] as Array<Record<string, unknown>>,
        reward: null as Reward | null,
        requests: new Map<string, Recorded>(),
      },
    ]),
  ) as Record<
    Who,
    {
      opening: Receipt | null;
      pass: boolean;
      pairs: Array<Record<string, unknown>>;
      reward: Reward | null;
      requests: Map<string, Recorded>;
    }
  >;

  const fingerprint = (value: unknown) => `0x${hex(canonicalJson(value))}`;
  function act(
    objectId: string,
    name: "mint" | "update",
    written: Record<string, unknown>,
    semantic: string,
    init?: { templateId: string; owner: string; to?: string },
  ): Receipt {
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
      account: ISSUER,
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
      semantic,
      object_id: objectId,
      account: ISSUER,
      next_nonce: object.nonce,
      readback_content_hash: object.contentHash,
      written_custom: written,
      written_custom_hash: sha(canonicalJson(written)),
    };
  }
  const base = (who: Who, state: string, benefitReference = "") => ({
    generic_semantic_purpose: PURPOSE,
    recordId: MEMBERS[who].recordId,
    title: "Harbour Makers Circle membership",
    programmeId: "HARBOUR-MAKERS",
    memberReference: sha(MEMBERS[who].walletId),
    state,
    tierStatus: "",
    eligibilitySummary: "",
    benefitReference,
    redemptionStatus: "",
  });
  const step = (
    semantic: string,
    state: string,
    eventId: string,
    publicFields: string[] = [],
  ) => ({
    lifecycle: {
      current_state: state,
      target_state: state,
      action_id: `${PURPOSE}_${semantic}_${eventId}`,
    },
    proof_event: { public_fields: [`action:${semantic}`, ...publicFields] },
  });
  const canonicalRead = (who: Who) => {
    const object = objects.get(MEMBERS[who].canon)!;
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
  const stateOf = (who: Who) =>
    String(objects.get(MEMBERS[who].canon)?.custom.state ?? "");
  const benefitOf = (who: Who) =>
    String(objects.get(MEMBERS[who].canon)?.custom.benefitReference ?? "");
  const zero = (reason: string) => ({ dual_writes: 0, reason });
  /** Studio's HMAC one-time reference of one request event. */
  const referenceOf = (who: Who, eventId: string) => {
    const digest = createHmac("sha256", "fictional-redemption-key")
      .update(`tig-loyalty-redemption-v1\n${MEMBERS[who].recordId}\n${eventId}`)
      .digest();
    const code = [...digest]
      .slice(0, 8)
      .map((byte) => BASE32[byte % BASE32.length])
      .join("");
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  };
  const counts = (benefit: string) => {
    let used = 0;
    for (const [id, allocation] of ledger) {
      // A unit a definitive failure returned is stock again (exactly once).
      if (allocation.benefit_id === benefit && !returned.has(id)) used += 1;
    }
    return used;
  };
  const chainOf = (reward: Reward, requestKey: "request" | "action") => ({
    grant: reward.grant,
    allocation: reward.allocation,
    ...(reward.failed.length
      ? {
          failed_attempts: reward.failed.map((item) => ({
            request: item.request,
            confirmation: item.confirmation,
            failure: item.failure,
          })),
        }
      : {}),
    ...(reward.request ? { [requestKey]: reward.request } : {}),
    ...(reward.confirmation ? { confirmation: reward.confirmation } : {}),
    ...(reward.recording && !reward.confirmation
      ? { confirmation_recording: true }
      : {}),
    ...(reward.fulfilment ? { fulfilment: reward.fulfilment } : {}),
    ...(reward.handoverRecording && reward.confirmation && !reward.fulfilment
      ? { handover_recording: true }
      : {}),
    ...(reward.settlement ? { settlement: reward.settlement } : {}),
  });
  const binding = (reward: Reward) => ({
    revision_hash: REVISION,
    benefit_id: reward.benefitId,
    grant_action_id: String(reward.grant.action_id),
    allocation_id: String(reward.allocation.allocation_id),
  });

  return {
    objects,
    logs,
    changes,
    ledger,
    members,
    stock,
    referenceOf,
    /** Staff: the member's created membership and own opening pass. */
    enrol(who: Who) {
      const member = MEMBERS[who];
      members[who].opening = act(
        member.canon,
        "mint",
        base(who, "Member"),
        "create_membership",
        { templateId: CANON_TEMPLATE, owner: ISSUER, to: ISSUER },
      );
      act(
        member.pass,
        "mint",
        {
          schema: "participant-opening-pass-v1",
          product_type: "participant_opening_pass",
          canonical_object_id: member.canon,
          canonical_template_id: CANON_TEMPLATE,
          canonical_issuer_account: ISSUER,
          organization_id: ORG,
          opening_action_id: String(members[who].opening!.action_id),
          openingState: "Member",
        },
        "pass",
        {
          templateId: PASS_TEMPLATE,
          owner: member.holder.toLowerCase(),
          to: member.holder.toLowerCase(),
        },
      );
      members[who].pass = true;
    },
    /** A submission and its verification (member, then verifier). */
    verifiedActivity(who: Who, evidence: string) {
      const evidenceHash = sha(evidence);
      const submission = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Activity pending", benefitOf(who)),
          ...step("submit_activity", "Activity pending", `evt-${counter}`, [
            `activityEvidenceHash:${evidenceHash}`,
          ]),
        },
        "submit_activity",
      );
      const verification = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Activity verified", benefitOf(who)),
          ...step("verify_activity", "Activity verified", `evt-${counter}`),
        },
        "verify_activity",
      );
      members[who].pairs.push({
        activity_type: "workshop",
        evidence_hash: evidenceHash,
        submission,
        verification,
      });
    },
    /** Any other issuer change, leaving the state as it is. */
    touch(who: Who) {
      act(
        MEMBERS[who].canon,
        "update",
        base(who, stateOf(who), benefitOf(who)),
        "touch",
      );
    },
    /** The programme operator's grant: eligibility, then shared stock. */
    grant(who: Who, benefit = BENEFIT) {
      if (stateOf(who) !== "Activity verified") return "not_permitted";
      if (members[who].pairs.length < 2) return "not_eligible";
      // Zero-write when every unit is already consumed or reserved.
      if (counts(benefit) >= (stock[benefit] ?? 0)) return "exhausted";
      const eventId = `evt-unlock-${who}-${counter}`;
      const allocationId = `alc_${hex(`${benefit}\n${MEMBERS[who].recordId}\n${eventId}`).slice(0, 32)}`;
      const grant = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Benefit eligible", benefit),
          ...step("unlock_benefit", "Benefit eligible", eventId, [
            `benefitReference:${benefit}`,
          ]),
        },
        "unlock_benefit",
      );
      const allocation = {
        allocation_id: allocationId,
        benefit_id: benefit,
        event_id: eventId,
        status: "consumed",
        proof: { object_id: MEMBERS[who].canon, action_id: grant.action_id },
      };
      ledger.set(allocationId, allocation);
      members[who].reward = {
        benefitId: benefit,
        grant,
        allocation,
        eventId,
        validUntil: new Date(Date.now() + 30 * DAY).toISOString(),
        failed: [],
      };
      return "granted";
    },
    /** The partner, presenting the member's reference in its own session. */
    partnerConfirm(who: Who, reference: string) {
      const reward = members[who].reward;
      if (
        stateOf(who) !== "Redemption pending" ||
        !reward?.requestEvent ||
        reference !== referenceOf(who, reward.requestEvent)
      ) {
        return "loyalty_redemption_reference_invalid";
      }
      reward.confirmation = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Redeemed", reward.benefitId),
          ...step("confirm_redemption", "Redeemed", `evt-confirm-${counter}`, [
            `benefitReference:${reward.benefitId}`,
          ]),
        },
        "confirm_redemption",
      );
      return "confirmed";
    },
    /** The programme records the partner's confirmation, not yet on Dual. */
    recording(who: Who) {
      members[who].reward!.recording = true;
    },
    /** The partner records the handover in its own session. */
    fulfil(who: Who) {
      const reward = members[who].reward!;
      if (stateOf(who) !== "Redeemed") return "not_permitted";
      reward.fulfilment = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Fulfilled", reward.benefitId),
          ...step("record_fulfilment", "Fulfilled", `evt-fulfil-${counter}`, [
            `benefitReference:${reward.benefitId}`,
          ]),
        },
        "record_fulfilment",
      );
      return "fulfilled";
    },
    /**
     * The partner's definitive failed handover: the same reward restored for a
     * new request; an available unit is stock again, a damaged one never.
     */
    fail(who: Who, disposition: "available" | "damaged" = "available") {
      const reward = members[who].reward!;
      if (stateOf(who) !== "Redeemed") return "not_permitted";
      const failure = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Fulfilment failed", reward.benefitId),
          ...step(
            "fail_fulfilment",
            "Fulfilment failed",
            `evt-fail-${counter}`,
            [
              `benefitReference:${reward.benefitId}`,
              "failureReason:not_handed_over",
            ],
          ),
        },
        "fail_fulfilment",
      );
      reward.failed.push({
        request: reward.request!,
        confirmation: reward.confirmation!,
        failure,
        requestEvent: reward.requestEvent!,
      });
      const unit =
        [...ledger].find(
          ([, item]) => item.attempt === reward.requestEvent,
        )?.[0] ?? String(reward.allocation.allocation_id);
      if (disposition === "available") returned.add(unit);
      delete reward.request;
      delete reward.requestEvent;
      delete reward.confirmation;
      delete reward.recording;
      return "failed";
    },
    /** The partner's handover outcome is recorded, not yet on Dual. */
    handoverRecording(who: Who) {
      members[who].reward!.handoverRecording = true;
    },
    settle(who: Who) {
      const reward = members[who].reward!;
      reward.settlement = act(
        MEMBERS[who].canon,
        "update",
        {
          ...base(who, "Member", reward.benefitId),
          ...step("settle_partner", "Member", `evt-settle-${counter}`),
        },
        "settle_partner",
      );
    },
    suspend(who: Who) {
      act(
        MEMBERS[who].canon,
        "update",
        base(who, "Suspended", benefitOf(who)),
        "suspend_membership",
      );
    },
    expireReward(who: Who) {
      members[who].reward!.validUntil = new Date(
        Date.now() - DAY,
      ).toISOString();
    },
    /** Studio's availability view says its proof coverage is incomplete. */
    stockUnverified(status: string) {
      stockStatus = status;
    },
    canonicalRead,
    stateOf,
    /** The runtime's answer to one operation, for one member. */
    answer(
      who: Who,
      operation: string,
      operationId: string,
      input: Record<string, unknown>,
    ): [number, unknown] {
      const member = members[who];
      switch (operation) {
        case "loyalty.membership.read":
          return [
            200,
            member.opening && member.pass
              ? {
                  ok: true,
                  status:
                    stateOf(who) === "Suspended"
                      ? "held"
                      : stateOf(who) === "Expired"
                        ? "ended"
                        : "active",
                  canonical: canonicalRead(who),
                  opening: member.opening,
                  pass: {
                    object_id: MEMBERS[who].pass,
                    template_id: PASS_TEMPLATE,
                  },
                  accounting: zero("membership_read"),
                }
              : {
                  ok: true,
                  status: "none",
                  accounting: zero("membership_read"),
                },
          ];
        case "loyalty.benefits.read": {
          const used = counts(BENEFIT);
          const remaining = Math.max(0, stock[BENEFIT] - used);
          return [
            200,
            {
              ok: true,
              status: "benefits_read",
              programme: {
                programme_id: "HARBOUR-MAKERS",
                revision_hash: REVISION,
              },
              canonical: canonicalRead(who),
              progress: [
                {
                  rule_id: "two-workshops",
                  label: "Two verified workshops",
                  activity_types: ["workshop"],
                  benefit_ids: [BENEFIT],
                  required_verified: 2,
                  verified: member.pairs.length,
                  pending_verification:
                    stateOf(who) === "Activity pending" ? 1 : 0,
                },
              ],
              verified_activities: member.pairs,
              benefits: [
                {
                  benefit_id: BENEFIT,
                  title: "A studio hour",
                  description: "One hour in the open studio.",
                  type: "access_pass",
                  partner: PARTNER,
                  valid_days: 30,
                  terms: "Book at the studio desk.",
                  redeemed_before: false,
                  stock: stockStatus
                    ? {
                        stock: stock[BENEFIT],
                        remaining: null,
                        status: stockStatus,
                      }
                    : {
                        stock: stock[BENEFIT],
                        remaining,
                        status: remaining > 0 ? "available" : "exhausted",
                      },
                },
              ],
              reward: member.reward
                ? {
                    benefit_id: member.reward.benefitId,
                    valid_until: member.reward.validUntil,
                    ...chainOf(member.reward, "request"),
                  }
                : null,
              accounting: zero("benefits_read"),
            },
          ];
        }
        case "loyalty.redemption.request": {
          // Idempotent by operationId, before every other check.
          if (member.requests.has(operationId)) {
            return [
              409,
              {
                ok: false,
                status: "operation_already_received",
                accounting: zero("operation_already_received"),
              },
            ];
          }
          const reward = member.reward;
          const refuse = (status: string) =>
            [409, { ok: false, status, accounting: zero(status) }] as [
              number,
              unknown,
            ];
          // A first request, or a new one of the same reward a definitive
          // failed handover restored.
          const restored =
            stateOf(who) === "Fulfilment failed" &&
            Boolean(reward?.failed.length) &&
            !reward?.request;
          if ((stateOf(who) !== "Benefit eligible" && !restored) || !reward) {
            return refuse("loyalty_redemption_not_permitted");
          }
          if (canonicalJson(input) !== canonicalJson(binding(reward))) {
            return refuse("loyalty_reward_changed");
          }
          if (Date.now() >= Date.parse(reward.validUntil)) {
            return refuse("loyalty_reward_expired");
          }
          const eventId = `evt-request-${counter}`;
          // A restored reward's attempt needs its own unit, reserved now.
          if (restored) {
            if (counts(reward.benefitId) >= (stock[reward.benefitId] ?? 0)) {
              return refuse("loyalty_benefit_stock_exhausted");
            }
            ledger.set(`retry-${eventId}`, {
              benefit_id: reward.benefitId,
              attempt: eventId,
            });
          }
          reward.request = act(
            MEMBERS[who].canon,
            "update",
            {
              ...base(who, "Redemption pending", reward.benefitId),
              ...step("request_redemption", "Redemption pending", eventId),
            },
            "request_redemption",
          );
          reward.requestEvent = eventId;
          member.requests.set(operationId, {
            requestEvent: eventId,
            binding: binding(reward),
            requestHash: sha(
              canonicalJson({
                operation,
                operationId,
                target: {
                  model_id: "harbour-makers",
                  object_id: MEMBERS[who].canon,
                },
                input,
              }),
            ),
          });
          return [
            200,
            {
              ok: true,
              status: "redemption_requested",
              canonical: canonicalRead(who),
              grant: reward.grant,
              allocation: reward.allocation,
              ...(reward.failed.length
                ? { failed_attempts: chainOf(reward, "action").failed_attempts }
                : {}),
              action: reward.request,
              accounting: { dual_writes: 1, reason: "redemption_requested" },
            },
          ];
        }
        case "loyalty.redemption.status": {
          const held = member.requests.get(operationId);
          const reward = member.reward;
          if (!held || !reward) {
            return [
              200,
              {
                ok: true,
                status: "not_received",
                operation_id: operationId,
                accounting: zero("operation_not_received"),
              },
            ];
          }
          // This operation's own attempt: an earlier one a definitive failure
          // ended, or the current one.
          const failedAt = reward.failed.findIndex(
            (item) => item.requestEvent === held.requestEvent,
          );
          return [
            200,
            {
              ok: true,
              status:
                failedAt >= 0
                  ? "fulfilment_failed"
                  : reward.fulfilment
                    ? "fulfilled"
                    : reward.confirmation
                      ? "confirmed"
                      : reward.recording
                        ? "confirmation_recording"
                        : "requested",
              ...(failedAt >= 0 ? { failed_attempt: failedAt } : {}),
              operation_id: operationId,
              request_hash: held.requestHash,
              binding: held.binding,
              canonical: canonicalRead(who),
              valid_until: reward.validUntil,
              ...chainOf(reward, "action"),
            },
          ];
        }
        case "loyalty.redemption.reference": {
          const reward = member.reward;
          if (
            stateOf(who) !== "Redemption pending" ||
            !reward?.request ||
            input.request_action_id !== reward.request.action_id
          ) {
            return [
              409,
              {
                ok: false,
                status: "loyalty_redemption_not_current",
                accounting: zero("loyalty_redemption_not_current"),
              },
            ];
          }
          return [
            200,
            {
              ok: true,
              status: "reference_shown",
              reference: referenceOf(who, reward.requestEvent!),
              canonical: canonicalRead(who),
              grant: reward.grant,
              allocation: reward.allocation,
              ...(reward.failed.length
                ? { failed_attempts: chainOf(reward, "action").failed_attempts }
                : {}),
              action: reward.request,
              accounting: zero("reference_shown"),
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
/** Operations the fake runtime received, in order, with whose session. */
let received: Array<{ who: Who; operation: string; operationId: string }>;
let lose: Set<string>;
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
  const who = (Object.keys(MEMBERS) as Who[]).find(
    (key) => MEMBERS[key].walletId === claims.sub,
  );
  // What the contract asks of the runtime: an exact, request-bound assertion
  // for exactly this member's own record.
  if (
    !who ||
    claims.operation !== operation ||
    claims.op_id !== body.operationId ||
    claims.request_hash !== requestHash ||
    claims.holder !== MEMBERS[who].holder.toLowerCase() ||
    canonicalJson(claims.target) !== canonicalJson(body.target) ||
    (body.target as Record<string, unknown>).model_id !== "harbour-makers" ||
    ((body.target as Record<string, unknown>).object_id !== undefined &&
      (body.target as Record<string, unknown>).object_id !== MEMBERS[who].canon)
  ) {
    return Response.json(
      { ok: false, status: "face_assertion_mismatch" },
      { status: 403 },
    );
  }
  received.push({ who, operation, operationId: String(body.operationId) });
  const answer = rewrite(
    operation,
    w.answer(
      who,
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
  lose = new Set();
  rewrite = (_operation, answer) => answer;
  mockFault.afterDispatch = false;
  resetIssueGuard();
  w = world();
  process.env.FACE_ASSERTION_KEY_ID = "wallet-face-test";
  process.env.FACE_ASSERTION_SIGNING_KEY = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  configure();
  global.fetch = runtimeFetch as unknown as typeof fetch;
  runtimeFetch.mockClear();
  getWallet.mockReset().mockImplementation(async () => ({
    id: MEMBERS[current].walletId,
    language: "en",
    fqdn: "localhost",
    activated: true,
    emailVerified: true,
    disabled: false,
    account: {
      address: MEMBERS[current].holder,
      type: "SMART_WALLET",
      controller: { address: "0xc", type: "SECP256K1", custody: "custodial" },
      smartAccount: {},
    },
    whenCreated: new Date(),
    whenModified: new Date(),
  }));
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
        "benefitReference",
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
  objectsApi.listObjects
    .mockReset()
    .mockImplementation(
      async (input: { id?: string; owner: string; templateId: string }) => ({
        objects: [...w.objects.values()].filter(
          (object) =>
            object.owner.toLowerCase() === input.owner.toLowerCase() &&
            object.templateId === input.templateId &&
            (!input.id || object.id === input.id),
        ),
      }),
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

// ------------------------------------------------------------- helpers

type View = {
  state: string;
  held: boolean;
  benefits: Array<Record<string, unknown>>;
  reward: Record<string, unknown> | null;
  actions: Record<string, boolean>;
  next: string | null;
  progress: Array<Record<string, unknown>>;
};
const benefitsOf = async (browser: Browser) => {
  const answer = await browser.loyalty({ transition: "benefits" });
  return answer.body as {
    benefits: View | null;
    unconfirmed: boolean;
    redemptions: Array<{ operationId: string; benefitId: string }>;
  };
};
const viewOf = async (browser: Browser) =>
  (await benefitsOf(browser)).benefits!;
const writes = (operation: string) =>
  received.filter((call) => call.operation === operation);

/** Enrolled, two verified workshops, and the operator's grant. */
async function granted(who: Who = "a") {
  w.enrol(who);
  w.verifiedActivity(who, `Workshop sign-in ${who}-1`);
  w.verifiedActivity(who, `Workshop sign-in ${who}-2`);
  expect(w.grant(who)).toBe("granted");
  return new Browser(who);
}

async function prepareRequest(browser: Browser) {
  const view = await viewOf(browser);
  return browser.loyalty({
    transition: "redeem_prepare",
    benefit_id: BENEFIT,
    grant_action_id: view.reward!.grantActionId,
  });
}
async function submitPrepared(
  browser: Browser,
  prepared: { body: Record<string, unknown> },
  options: { lose?: boolean } = {},
) {
  const value = prepared.body.prepared as Record<string, unknown>;
  return browser.loyalty(
    {
      transition: "redeem_submit",
      operation_id: value.operationId,
      ...(value.binding as Record<string, unknown>),
    },
    options,
  );
}
const operationOf = (prepared: { body: Record<string, unknown> }) =>
  String((prepared.body.prepared as Record<string, unknown>).operationId);
const statusOf = async (browser: Browser, operationId: string) =>
  (
    await browser.loyalty({
      transition: "redeem_status",
      operation_id: operationId,
    })
  ).body.redemption as Record<string, unknown>;
const showReference = async (browser: Browser) => {
  const view = await viewOf(browser);
  return browser.loyalty({
    transition: "reference",
    request_action_id: view.reward?.requestActionId ?? "act-none",
  });
};

// --------------------------------------------------------------- tests

describe("only a binding that states loyalty-benefit-redeem-v1 serves benefits", () => {
  it("without the key: no benefits call reaches the runtime, and the membership says so", async () => {
    configure({ benefits: false });
    w.enrol("a");
    const browser = new Browser();
    const refused = await browser.loyalty({ transition: "benefits" });
    expect(refused.status).toBe(403);
    expect(writes("loyalty.benefits.read")).toHaveLength(0);
    expect(
      (await browser.loyalty({ transition: "membership" })).body.benefits,
    ).toBe(false);
  });
});

describe("progress, verified eligibility and availability are distinct", () => {
  it("one verified activity is progress, not eligibility; two proven are eligible and available", async () => {
    w.enrol("a");
    w.verifiedActivity("a", "Workshop sign-in a-1");
    const browser = new Browser();
    let view = await viewOf(browser);
    expect(view.progress[0]).toEqual(
      expect.objectContaining({ verified: 1, requiredVerified: 2 }),
    );
    expect(view.benefits[0]).toEqual(
      expect.objectContaining({ status: "locked", availability: "available" }),
    );
    w.verifiedActivity("a", "Workshop sign-in a-2");
    view = await viewOf(browser);
    expect(view.benefits[0]).toEqual(
      expect.objectContaining({
        status: "eligible",
        availability: "available",
        partnerName: "Harbour Workshop",
      }),
    );
    // The programme team grants; the member never does.
    expect(view.next).toBe("programme_team");
    expect(view.actions).toEqual({
      submitActivity: true,
      requestRedemption: false,
      showReference: false,
    });
  });

  it.each([
    [
      "verifications that are not the very next change after their submissions",
      (pairs: Array<Record<string, unknown>>) => [
        { ...pairs[0], verification: pairs[1].verification },
        { ...pairs[1], verification: pairs[0].verification },
      ],
    ],
    [
      "one verified activity claimed twice",
      (pairs: Array<Record<string, unknown>>) => [pairs[0], pairs[0]],
    ],
  ])("never counts %s towards eligibility", async (_label, forge) => {
    w.enrol("a");
    w.verifiedActivity("a", "Workshop sign-in a-1");
    w.verifiedActivity("a", "Workshop sign-in a-2");
    const pairs = w.members.a.pairs;
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.benefits.read"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              verified_activities: forge(pairs),
            },
          ]
        : [status, body];
    const view = await viewOf(new Browser());
    expect(view.benefits[0].status).toBe("eligible_unconfirmed");
    expect(view.next).toBeNull();
  });

  it("stock without full proof coverage is never shown as available or as none", async () => {
    w.enrol("a");
    w.verifiedActivity("a", "Workshop sign-in a-1");
    w.verifiedActivity("a", "Workshop sign-in a-2");
    for (const status of ["proof_unverified", "proof_partially_checked"]) {
      w.stockUnverified(status);
      const view = await viewOf(new Browser());
      expect(view.benefits[0].availability).toBe("unconfirmed");
      // Nobody is told the programme team will grant what it cannot verify.
      expect(view.next).toBeNull();
    }
  });

  it("two members, one last unit: the grant goes to one; the other stays eligible and unavailable, never granted", async () => {
    w.enrol("a");
    w.enrol("b");
    for (const who of ["a", "b"] as Who[]) {
      w.verifiedActivity(who, `Workshop sign-in ${who}-1`);
      w.verifiedActivity(who, `Workshop sign-in ${who}-2`);
    }
    expect(w.grant("a")).toBe("granted");
    // The ledger refuses the second unit with zero writes.
    const writesBefore = w.changes.length;
    expect(w.grant("b")).toBe("exhausted");
    expect(w.changes.length).toBe(writesBefore);
    const a = await viewOf(new Browser("a"));
    const b = await viewOf(new Browser("b"));
    expect(a.reward).toEqual(expect.objectContaining({ status: "granted" }));
    expect(b.reward).toBeNull();
    expect(b.benefits[0]).toEqual(
      expect.objectContaining({
        status: "eligible",
        availability: "unavailable",
      }),
    );
    expect(b.actions.requestRedemption).toBe(false);
    expect(b.next).toBeNull();
  });
});

describe("an operator-granted reward, redeemed once through the partner", () => {
  it("grant, the member's request, one reference, the partner's recorded confirmation, settlement, a fresh reopen", async () => {
    const browser = await granted();
    let view = await viewOf(browser);
    expect(view.reward).toEqual(
      expect.objectContaining({ benefitId: BENEFIT, status: "granted" }),
    );
    // Only the member's own next step: no activity that would strand it.
    expect(view.actions).toEqual({
      submitActivity: false,
      requestRedemption: true,
      showReference: false,
    });
    const prepared = await prepareRequest(browser);
    expect(prepared.status).toBe(200);
    expect(writes("loyalty.redemption.request")).toHaveLength(0);
    const sent = await submitPrepared(browser, prepared);
    expect(sent.body.redemption).toEqual(
      expect.objectContaining({ status: "requested", benefitId: BENEFIT }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(1);
    view = await viewOf(browser);
    expect(view.reward!.status).toBe("requested");
    expect(view.next).toBe("partner");

    // The member shows the reference; the same one every time, anywhere.
    const shown = await showReference(browser);
    const reference = (shown.body.reference as Record<string, string>).code;
    expect(reference).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(
      (
        (await showReference(browser.signInAgain())).body.reference as Record<
          string,
          string
        >
      ).code,
    ).toBe(reference);
    // A wrong reference changes nothing.
    expect(w.partnerConfirm("a", "AAAA-AAAA")).toBe(
      "loyalty_redemption_reference_invalid",
    );
    expect(w.stateOf("a")).toBe("Redemption pending");
    expect(w.partnerConfirm("a", reference)).toBe("confirmed");
    // Reused: no current request is left to confirm.
    expect(w.partnerConfirm("a", reference)).toBe(
      "loyalty_redemption_reference_invalid",
    );
    view = await viewOf(browser);
    expect(view.reward!.status).toBe("confirmed");
    // A confirmation is not the handover: the partner records it next.
    expect(view.next).toBe("partner");
    // The reference is gone once confirmed.
    expect((await showReference(browser)).status).toBe(409);
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "confirmed" }),
    );

    expect(w.fulfil("a")).toBe("fulfilled");
    view = await viewOf(browser);
    expect(view.reward!.status).toBe("fulfilled");
    expect(view.next).toBe("settlement");
    expect(view.actions.submitActivity).toBe(false);
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "fulfilled" }),
    );

    w.settle("a");
    const reopened = browser.reopen();
    view = await viewOf(reopened);
    expect(view.reward!.status).toBe("settled");
    expect(view.actions.submitActivity).toBe(true);
    expect(await statusOf(reopened, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "settled" }),
    );
    // One request was ever written, and nothing of the reference was kept.
    expect(writes("loyalty.redemption.request")).toHaveLength(1);
    const cookies = [...browser.cookies.values(), ...reopened.cookies.values()];
    expect(cookies.join("")).not.toContain(reference);
  });

  it("a member's activity is never prepared from a state that would strand the reward or the settlement", async () => {
    const browser = await granted();
    const refused = await browser.loyalty({
      transition: "prepare",
      activity_type: "workshop",
      evidence_ref: "Workshop sign-in a-9",
    });
    expect(refused.body).toEqual(
      expect.objectContaining({ code: "loyalty_activity_not_permitted" }),
    );
    expect(writes("loyalty.activity.submit")).toHaveLength(0);
    expect(
      (await browser.loyalty({ transition: "membership" })).body.submissions,
    ).toEqual([]);
  });
});

describe("the partner's handover, or its definitive failure restoring the same reward", () => {
  /** Granted, requested, the reference shown and confirmed by the partner. */
  async function confirmed(browser: Browser) {
    const prepared = await prepareRequest(browser);
    expect((await submitPrepared(browser, prepared)).body.redemption).toEqual(
      expect.objectContaining({ status: "requested" }),
    );
    const code = (
      (await showReference(browser)).body.reference as Record<string, string>
    ).code;
    expect(w.partnerConfirm("a", code)).toBe("confirmed");
    return { prepared, code };
  }

  it("a definitive failed handover restores the same reward until its original validity; the new request is proven through the earlier attempt, and the original operation reads its own failure", async () => {
    const browser = await granted();
    const before = await viewOf(browser);
    const first = await confirmed(browser);
    expect(w.fail("a", "available")).toBe("failed");
    let view = await viewOf(browser);
    expect(view.reward).toEqual({
      benefitId: BENEFIT,
      status: "restored",
      // The same grant and its original validity, never extended.
      validUntil: before.reward!.validUntil,
      grantActionId: before.reward!.grantActionId,
      requestActionId: null,
      failedHandovers: 1,
    });
    expect(view.state).toBe("Fulfilment failed");
    expect(view.actions).toEqual({
      submitActivity: false,
      requestRedemption: true,
      showReference: false,
    });
    expect(view.next).toBeNull();
    // The original operation's own outcome, read back, never re-sent.
    expect(await statusOf(browser, operationOf(first.prepared))).toEqual(
      expect.objectContaining({ status: "fulfilment_failed" }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(1);

    // A new request of the same grant: its own operation, unit and reference.
    const second = await prepareRequest(browser);
    expect(second.status).toBe(200);
    expect(operationOf(second)).not.toBe(operationOf(first.prepared));
    expect((await submitPrepared(browser, second)).body.redemption).toEqual(
      expect.objectContaining({ status: "requested" }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(2);
    view = await viewOf(browser);
    expect(view.reward!.status).toBe("requested");
    expect(view.reward!.failedHandovers).toBe(1);
    const code = (
      (await showReference(browser)).body.reference as Record<string, string>
    ).code;
    expect(code).not.toBe(first.code);
    expect(w.partnerConfirm("a", first.code)).toBe(
      "loyalty_redemption_reference_invalid",
    );
    expect(w.partnerConfirm("a", code)).toBe("confirmed");
    expect(w.fulfil("a")).toBe("fulfilled");
    w.settle("a");
    view = await viewOf(browser.reopen());
    expect(view.reward!.status).toBe("settled");
    expect(view.reward!.failedHandovers).toBe(1);
    // Each operation keeps its own outcome.
    expect(await statusOf(browser, operationOf(first.prepared))).toEqual(
      expect.objectContaining({ status: "fulfilment_failed" }),
    );
    expect(await statusOf(browser, operationOf(second))).toEqual(
      expect.objectContaining({ status: "settled" }),
    );
  });

  it("a damaged unit never returns: the restored reward is kept, never offered, and nothing is sent", async () => {
    const browser = await granted();
    await confirmed(browser);
    expect(w.fail("a", "damaged")).toBe("failed");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("restored");
    expect(view.benefits[0].availability).toBe("unavailable");
    expect(view.actions.requestRedemption).toBe(false);
    const refused = await prepareRequest(browser);
    expect(refused.body).toEqual(
      expect.objectContaining({ code: "loyalty_redemption_not_permitted" }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(1);
  });

  it("the runtime's stock refusal of a restored reward's request is an exact zero-write refusal, settled as never sent", async () => {
    const browser = await granted();
    await confirmed(browser);
    expect(w.fail("a", "available")).toBe("failed");
    const prepared = await prepareRequest(browser);
    expect(prepared.status).toBe(200);
    // Another member is granted the returned unit between the read and the send.
    w.enrol("b");
    w.verifiedActivity("b", "Workshop sign-in b-1");
    w.verifiedActivity("b", "Workshop sign-in b-2");
    expect(w.grant("b")).toBe("granted");
    const changes = w.changes.length;
    const sent = await submitPrepared(browser, prepared);
    expect(sent.body).toEqual(
      expect.objectContaining({ code: "loyalty_benefit_stock_exhausted" }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(2);
    // Nothing was written; the reward stays the member's, kept, not offered.
    expect(w.changes.length).toBe(changes);
    expect(w.stateOf("a")).toBe("Fulfilment failed");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("restored");
    expect(view.actions.requestRedemption).toBe(false);
    // Settled as never sent: only the first, failed attempt stays listed.
    expect(
      (await benefitsOf(browser)).redemptions.map((item) => item.operationId),
    ).not.toContain(operationOf(prepared));
  });

  it("an unknown handover outcome is held: never handed over, never restored, nothing offered", async () => {
    const browser = await granted();
    const { prepared } = await confirmed(browser);
    w.handoverRecording("a");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("handover_recording");
    expect(view.actions).toEqual({
      submitActivity: false,
      requestRedemption: false,
      showReference: false,
    });
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "handover_recording" }),
    );
  });

  it("a settlement without the partner's handover, or a failure that is not the definitive one, is never proven", async () => {
    const browser = await granted();
    const { prepared } = await confirmed(browser);
    expect(w.fulfil("a")).toBe("fulfilled");
    w.settle("a");
    // The answer drops the handover: a settlement straight after a confirmation.
    rewrite = (operation, [status, body]) => {
      if (
        operation !== "loyalty.benefits.read" &&
        operation !== "loyalty.redemption.status"
      )
        return [status, body];
      const copy = JSON.parse(JSON.stringify(body));
      const chain = operation === "loyalty.benefits.read" ? copy.reward : copy;
      delete chain.fulfilment;
      if (operation === "loyalty.redemption.status") copy.status = "confirmed";
      return [status, copy];
    };
    // Not a reward chain at all: the read supplies nothing, the status nothing.
    const read = await browser.loyalty({ transition: "benefits" });
    expect(read.status).toBe(502);
    expect(read.body.benefits).toBeUndefined();
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    rewrite = (_operation, answer) => answer;
  });

  it("a failure receipt without the definitive reason never restores the reward", async () => {
    const browser = await granted();
    await confirmed(browser);
    expect(w.fail("a", "available")).toBe("failed");
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.benefits.read") return [status, body];
      const copy = JSON.parse(JSON.stringify(body));
      const failure = copy.reward.failed_attempts[0].failure;
      failure.written_custom.proof_event.public_fields =
        failure.written_custom.proof_event.public_fields.filter(
          (field: string) => !field.startsWith("failureReason:"),
        );
      return [status, copy];
    };
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("unconfirmed");
    expect(view.actions.requestRedemption).toBe(false);
    rewrite = (_operation, answer) => answer;
  });
});

describe("a request's whole answer can be lost; it is read back, never sent again", () => {
  it("lost whole after the write: the prepared journal finds the original operation, read back only", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    const operationId = operationOf(prepared);
    await submitPrepared(browser, prepared, { lose: true });
    expect(w.stateOf("a")).toBe("Redemption pending");
    for (const next of [browser.reopen(), browser.signInAgain()]) {
      expect((await benefitsOf(next)).redemptions).toEqual([
        { operationId, benefitId: BENEFIT },
      ]);
      // The same grant again: refused, nothing prepared.
      const again = await next.loyalty({
        transition: "redeem_prepare",
        benefit_id: BENEFIT,
        grant_action_id: String(w.members.a.reward!.grant.action_id),
      });
      expect(again.status).toBe(409);
      expect(await statusOf(next, operationId)).toEqual(
        expect.objectContaining({ operationId, status: "requested" }),
      );
    }
    // The page replaying its stale prepared journal: not sent again here.
    expect((await submitPrepared(browser, prepared)).body).toEqual(
      expect.objectContaining({ code: "redemption_in_progress" }),
    );
    expect(
      writes("loyalty.redemption.request").map((call) => call.operationId),
    ).toEqual([operationId]);
    expect(
      writes("loyalty.redemption.status").every(
        (call) => call.operationId === operationId,
      ),
    ).toBe(true);
  });

  it("a BFF failure after the runtime wrote returns the issued journal as unknown; status then proves it", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    mockFault.afterDispatch = true;
    const sent = await submitPrepared(browser, prepared);
    mockFault.afterDispatch = false;
    expect(sent.status).toBe(200);
    expect(sent.body.redemption).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "requested" }),
    );
    expect(writes("loyalty.redemption.request")).toHaveLength(1);
  });

  it("two concurrent submits of one prepared request dispatch once", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    const answers = await Promise.all([
      submitPrepared(browser, prepared),
      submitPrepared(browser.twin(), prepared),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(writes("loyalty.redemption.request")).toHaveLength(1);
  });

  it("a status answer for another grant than the one journalled is unconfirmed", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.redemption.status"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              binding: {
                ...((body as Record<string, unknown>).binding as object),
                revision_hash: sha("another revision"),
              },
            },
          ]
        : [status, body];
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "unconfirmed" }),
    );
  });

  it("an exact zero-write refusal is settled as never sent; anything else stays unknown", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    w.expireReward("a");
    const refused = await submitPrepared(browser, prepared);
    expect(refused.body).toEqual(
      expect.objectContaining({ code: "loyalty_reward_expired" }),
    );
    expect(w.stateOf("a")).toBe("Benefit eligible");
    expect((await benefitsOf(browser)).redemptions).toEqual([]);
  });
});

describe("a reward is granted only from fresh, exact, role-bound evidence", () => {
  const forgedGrant = (
    forge: (
      grant: Receipt,
      body: Record<string, unknown>,
    ) => Record<string, unknown>,
  ) => {
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.benefits.read") return [status, body];
      const value = body as Record<string, unknown>;
      const reward = value.reward as Record<string, unknown> | null;
      return reward
        ? [status, { ...value, reward: forge(reward.grant as Receipt, reward) }]
        : [status, body];
    };
  };

  it("a genuine update claimed as the grant over a map C was never written with is never granted", async () => {
    w.enrol("a");
    w.verifiedActivity("a", "Workshop sign-in a-1");
    w.verifiedActivity("a", "Workshop sign-in a-2");
    // C is still Activity verified at this nonce; its last action is real.
    w.touch("a");
    const touch = [...w.logs.values()].at(-1)!;
    const change = w.changes.at(-1)!;
    const eventId = "evt-forged";
    const claimed = {
      ...(w.objects.get(MEMBERS.a.canon)!.custom as object),
      state: "Benefit eligible",
      benefitReference: BENEFIT,
      lifecycle: {
        current_state: "Benefit eligible",
        target_state: "Benefit eligible",
        action_id: `${PURPOSE}_unlock_benefit_${eventId}`,
      },
      proof_event: {
        public_fields: ["action:unlock_benefit", `benefitReference:${BENEFIT}`],
      },
    };
    const allocationId = `alc_${hex(`${BENEFIT}\n${MEMBERS.a.recordId}\n${eventId}`).slice(0, 32)}`;
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.benefits.read"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              reward: {
                benefit_id: BENEFIT,
                valid_until: new Date(Date.now() + DAY).toISOString(),
                grant: {
                  action_id: touch.id,
                  action_name: "update",
                  semantic: "unlock_benefit",
                  object_id: MEMBERS.a.canon,
                  account: ISSUER,
                  next_nonce: change.nextNonce,
                  readback_content_hash: change.nextContentHash,
                  written_custom: claimed,
                  written_custom_hash: sha(canonicalJson(claimed)),
                },
                allocation: {
                  allocation_id: allocationId,
                  benefit_id: BENEFIT,
                  event_id: eventId,
                  status: "consumed",
                  proof: { object_id: MEMBERS.a.canon, action_id: touch.id },
                },
              },
            },
          ]
        : [status, body];
    const view = await viewOf(new Browser());
    expect(view.reward!.status).toBe("unconfirmed");
    expect(view.actions.requestRedemption).toBe(false);
  });

  it.each([
    [
      "a grant signed by someone else",
      () => {
        const grant = w.members.a.reward!.grant;
        w.logs.get(String(grant.action_id))!.account = FORGER;
      },
    ],
    [
      "a grant on another member's record",
      () => {
        forgedGrant((grant, reward) => ({
          ...reward,
          grant: { ...grant, object_id: MEMBERS.b.canon },
        }));
      },
    ],
    [
      "a grant naming another action",
      () => {
        forgedGrant((grant, reward) => ({
          ...reward,
          grant: {
            ...grant,
            action_id: String(w.members.a.opening!.action_id),
          },
        }));
      },
    ],
    [
      "an allocation backing another action",
      () => {
        forgedGrant((_grant, reward) => ({
          ...reward,
          allocation: {
            ...(reward.allocation as object),
            proof: {
              object_id: MEMBERS.a.canon,
              action_id: String(w.members.a.opening!.action_id),
            },
          },
        }));
      },
    ],
    [
      "an allocation of another intent",
      () => {
        // Internally consistent (its id recomputed), naming the real grant:
        // only the grant's own intent event can tell them apart.
        forgedGrant((_grant, reward) => ({
          ...reward,
          allocation: {
            ...(reward.allocation as object),
            event_id: "evt-other-intent",
            allocation_id: `alc_${hex(`${BENEFIT}\n${MEMBERS.a.recordId}\nevt-other-intent`).slice(0, 32)}`,
          },
        }));
      },
    ],
  ])("is never granted with %s", async (_label, forge) => {
    const browser = await granted();
    forge();
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("unconfirmed");
    expect(view.actions.requestRedemption).toBe(false);
    expect(
      (
        await browser.loyalty({
          transition: "redeem_prepare",
          benefit_id: BENEFIT,
          grant_action_id: String(w.members.a.reward!.grant.action_id),
        })
      ).status,
    ).toBe(409);
  });

  it("a reward without its allocation is never read as granted", async () => {
    const browser = await granted();
    forgedGrant((_grant, reward) =>
      Object.fromEntries(
        Object.entries(reward).filter(([key]) => key !== "allocation"),
      ),
    );
    const answer = await browser.loyalty({ transition: "benefits" });
    expect(answer.status).toBe(502);
  });

  it("a request receipt that is not the very next change after the grant is never a request of it", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.benefits.read") return [status, body];
      const value = body as Record<string, unknown>;
      const reward = value.reward as Record<string, unknown>;
      // The request claims the grant's own state change position.
      return [
        status,
        {
          ...value,
          reward: {
            ...reward,
            request: { ...(reward.request as object), next_nonce: 99 },
          },
        },
      ];
    };
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("unconfirmed");
    expect(view.actions.showReference).toBe(false);
  });
});

describe("a historical step still names exactly its own benefit", () => {
  it("a historical grant whose retained map names another benefit is never this reward", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    // The grant is historical now; its retained map is rewritten and rehashed.
    rewrite = (operation, [status, body]) => {
      if (operation !== "loyalty.benefits.read") return [status, body];
      const value = body as Record<string, unknown>;
      const reward = value.reward as Record<string, unknown>;
      const grant = reward.grant as Record<string, unknown>;
      const written = {
        ...(grant.written_custom as object),
        benefitReference: "another-benefit",
      };
      return [
        status,
        {
          ...value,
          reward: {
            ...reward,
            grant: {
              ...grant,
              written_custom: written,
              written_custom_hash: sha(canonicalJson(written)),
            },
          },
        },
      ];
    };
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("unconfirmed");
  });

  it("a reference handed out for a request that is no longer current is refused by the wallet", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    const requestActionId = String(w.members.a.reward!.request!.action_id);
    // A later change: the membership is still active and Redemption
    // pending, but this request is no longer the record's current state.
    w.touch("a");
    // A dishonest runtime still answers with the old request's reference.
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.redemption.reference"
        ? [
            200,
            {
              ok: true,
              status: "reference_shown",
              reference: w.referenceOf("a", w.members.a.reward!.requestEvent!),
              canonical: w.canonicalRead("a"),
              grant: w.members.a.reward!.grant,
              allocation: w.members.a.reward!.allocation,
              action: w.members.a.reward!.request,
              accounting: { dual_writes: 0, reason: "reference_shown" },
            },
          ]
        : [status, body];
    const answer = await browser.loyalty({
      transition: "reference",
      request_action_id: requestActionId,
    });
    expect(answer.status).toBe(409);
    expect(answer.body.reference).toBeUndefined();
  });
});

describe("each reward step is the very next change after the one before", () => {
  it("a genuine request with another change between it and the grant is never a request of that grant", async () => {
    const browser = await granted();
    // Another issuer change lands between the grant and the request
    // (Studio has none from Benefit eligible); every receipt is genuine.
    w.touch("a");
    const prepared = await prepareRequest(browser);
    expect(prepared.status).toBe(409);
    // Even if the runtime then wrote one, it is not this grant's request.
    const reward = w.members.a.reward!;
    w.answer("a", "loyalty.redemption.request", "op-direct", {
      revision_hash: REVISION,
      benefit_id: BENEFIT,
      grant_action_id: String(reward.grant.action_id),
      allocation_id: String(reward.allocation.allocation_id),
    });
    expect(reward.request).toBeDefined();
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("unconfirmed");
    expect(view.actions.showReference).toBe(false);
  });

  it("a canonical read of another record of the same member is never this membership's", async () => {
    const browser = await granted();
    // A second record carrying the same member and programme.
    w.objects.set("6c00000000000000000000a9", {
      ...w.objects.get(MEMBERS.a.canon)!,
      id: "6c00000000000000000000a9",
    });
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.benefits.read"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              canonical: {
                ...w.canonicalRead("a"),
                object_id: "6c00000000000000000000a9",
              },
            },
          ]
        : [status, body];
    const answer = await benefitsOf(browser);
    expect(answer.benefits).toBeNull();
    expect(answer.unconfirmed).toBe(true);
  });
});

describe("the benefits read is exactly this binding's programme, and a status exactly this operation's", () => {
  it("a benefits answer naming another programme supplies nothing: no view, no prepare, no dispatch", async () => {
    const browser = await granted();
    // The canonical record, grant and allocation are this member's own and
    // valid; only the answer's programme block is another programme's.
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.benefits.read"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              programme: {
                programme_id: "ANOTHER-PROGRAMME",
                revision_hash: sha("another programme's revision"),
              },
            },
          ]
        : [status, body];
    const read = await browser.loyalty({ transition: "benefits" });
    expect(read.status).toBe(502);
    expect(read.body.benefits).toBeUndefined();
    const prepared = await browser.loyalty({
      transition: "redeem_prepare",
      benefit_id: BENEFIT,
      grant_action_id: String(w.members.a.reward!.grant.action_id),
    });
    expect(prepared.status).toBe(502);
    expect(prepared.body.prepared).toBeUndefined();
    expect(writes("loyalty.redemption.request")).toHaveLength(0);
    expect(
      (await browser.reopen().loyalty({ transition: "membership" })).status,
    ).toBe(200);
    expect(w.stateOf("a")).toBe("Benefit eligible");
  });

  it.each([
    [
      "another operation's id",
      { operation_id: "loy-0123456789abcdef01234567" },
    ],
    ["another request's hash", { request_hash: sha("another request") }],
    ["no operation echo", { operation_id: undefined, request_hash: undefined }],
  ])(
    "a status answer with %s is not this operation's, however exact its grant",
    async (_label, echo) => {
      const browser = await granted();
      const prepared = await prepareRequest(browser);
      await submitPrepared(browser, prepared);
      rewrite = (operation, [status, body]) =>
        operation === "loyalty.redemption.status"
          ? [status, { ...(body as Record<string, unknown>), ...echo }]
          : [status, body];
      expect(await statusOf(browser, operationOf(prepared))).toEqual(
        expect.objectContaining({ status: "unconfirmed" }),
      );
    },
  );

  it("a not_received about another operation never closes this one", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared, { lose: true });
    const later = Date.now() + 10 * 60_000;
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.redemption.status"
        ? [
            200,
            {
              ok: true,
              status: "not_received",
              operation_id: "loy-0123456789abcdef01234567",
              accounting: { dual_writes: 0, reason: "operation_not_received" },
            },
          ]
        : [status, body];
    jest.spyOn(Date, "now").mockReturnValue(later);
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    // Still listed (possibly sent): it was never closed.
    expect((await benefitsOf(browser.reopen())).redemptions).toHaveLength(1);
  });
});

describe("expired, held and partial outcomes keep their exact state", () => {
  it("an expired reward offers no request; the programme team is next", async () => {
    const browser = await granted();
    w.expireReward("a");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("expired");
    expect(view.actions.requestRedemption).toBe(false);
    expect(view.next).toBe("programme_team");
    expect((await prepareRequest(browser)).status).toBe(409);
  });

  it("held after the request: no reference, no action, the request kept as the past", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    w.suspend("a");
    const view = await viewOf(browser);
    expect(view.held).toBe(true);
    expect(view.reward!.status).toBe("not_redeemable");
    expect(view.actions).toEqual({
      submitActivity: false,
      requestRedemption: false,
      showReference: false,
    });
    expect(view.next).toBe("programme_team");
    expect((await showReference(browser)).status).toBe(409);
    // The operation itself was written and stays readable as such.
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "requested" }),
    );
  });

  it("the partner's confirmation recorded but not yet on Dual is never shown as confirmed", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    w.recording("a");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("confirmation_recording");
    expect(view.actions.showReference).toBe(false);
    expect(await statusOf(browser, operationOf(prepared))).toEqual(
      expect.objectContaining({ status: "confirmation_recording" }),
    );
  });

  it("a reward stranded by a later change is not redeemable here", async () => {
    const browser = await granted();
    // A legacy caller's activity from Benefit eligible (Studio allows it).
    w.verifiedActivity("a", "Workshop sign-in a-3");
    const view = await viewOf(browser);
    expect(view.reward!.status).toBe("not_redeemable");
    expect(view.actions.requestRedemption).toBe(false);
  });
});

describe("one member's reward is never another's", () => {
  it("a runtime answering with another member's record is never this member's", async () => {
    await granted("a");
    w.enrol("b");
    rewrite = (operation, [status, body]) =>
      operation === "loyalty.benefits.read"
        ? [
            status,
            {
              ...(body as Record<string, unknown>),
              canonical: w.canonicalRead("a"),
            },
          ]
        : [status, body];
    const answer = await benefitsOf(new Browser("b"));
    expect(answer.benefits).toBeNull();
    expect(answer.unconfirmed).toBe(true);
    expect(writes("loyalty.redemption.reference")).toHaveLength(0);
  });

  it("the reference is never in the journal, a cookie or a list; it is shown only on its own read", async () => {
    const browser = await granted();
    const prepared = await prepareRequest(browser);
    await submitPrepared(browser, prepared);
    const reference = w.referenceOf("a", w.members.a.reward!.requestEvent!);
    const before = seen.join("\n");
    expect(before).not.toContain(reference);
    await showReference(browser);
    // Only that one answer carried it.
    expect(seen.filter((answer) => answer.includes(reference))).toHaveLength(1);
    expect([...browser.cookies.values()].join("")).not.toContain(reference);
  });
});
