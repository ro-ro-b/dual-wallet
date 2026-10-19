import "client-only";

import { isOperationId } from "@/app/_domain/product-face";
import {
  isLoyaltyBenefitsView,
  isLoyaltyRedemptionView,
  REDEMPTION_REFERENCE,
  type LoyaltyBenefitsView,
  type LoyaltyRedemptionView,
} from "@/app/_domain/loyalty-benefits";
import {
  ACTIVITY_TYPE,
  isLoyaltySubmissionView,
  type LoyaltyJoinRecord,
  type LoyaltyMembershipView,
  type LoyaltyProgramme,
  type LoyaltySubmissionView,
} from "@/app/_domain/loyalty";

// loyalty-join-earn-v1: the native Loyalty page's steps, through the wallet's
// own same-origin BFF only. No credential, assertion or runtime address ever
// reaches the browser; every status shown was proven by the BFF just now.

export class LoyaltyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LoyaltyError";
  }
}

export type Where = { slug: string; launchId: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const text = (value: unknown, max = 500) =>
  typeof value === "string" && value.length <= max;

async function loyaltyRequest(
  where: Where,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(
      `/api/faces/${encodeURIComponent(where.slug)}/loyalty`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-dual-face-launch": where.launchId,
        },
        body: JSON.stringify(body),
        signal,
      },
    );
  } catch {
    throw new LoyaltyError("unavailable");
  }
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      record(parsed) &&
      typeof parsed.code === "string" &&
      CODE.test(parsed.code)
        ? parsed.code
        : "unavailable";
    throw new LoyaltyError(response.status === 401 ? "session_expired" : code);
  }
  if (!record(parsed)) throw new LoyaltyError("unavailable");
  return parsed;
}

function programmeOf(value: unknown): LoyaltyProgramme | undefined {
  if (!record(value) || !Array.isArray(value.activities)) return undefined;
  const ok =
    typeof value.modelId === "string" &&
    typeof value.programmeId === "string" &&
    typeof value.open === "boolean" &&
    text(value.name, 200) &&
    text(value.headline) &&
    text(value.memberPromise) &&
    text(value.termsVersion, 64) &&
    text(value.consentStatement) &&
    text(value.dataUse) &&
    typeof value.consentFingerprint === "string" &&
    HASH.test(value.consentFingerprint) &&
    value.activities.every(
      (item) =>
        record(item) &&
        typeof item.activityType === "string" &&
        ACTIVITY_TYPE.test(item.activityType) &&
        text(item.label, 120) &&
        text(item.evidenceHint, 200),
    );
  return ok ? (value as unknown as LoyaltyProgramme) : undefined;
}

export async function readProgramme(
  where: Where,
  signal?: AbortSignal,
): Promise<LoyaltyProgramme> {
  const body = await loyaltyRequest(where, { transition: "programme" }, signal);
  const programme = programmeOf(body.programme);
  if (!programme) throw new LoyaltyError("unavailable");
  return programme;
}

function joinOf(value: unknown): LoyaltyJoinRecord | undefined {
  return record(value) &&
    typeof value.requestId === "string" &&
    text(value.termsVersion, 64) &&
    typeof value.consentHash === "string" &&
    HASH.test(value.consentHash) &&
    typeof value.requestedAt === "string" &&
    Number.isFinite(Date.parse(value.requestedAt))
    ? (value as unknown as LoyaltyJoinRecord)
    : undefined;
}

/** The member's own consent to exactly the terms version and text they saw. */
export async function joinProgramme(
  where: Where,
  consent: { termsVersion: string; fingerprint: string },
): Promise<LoyaltyJoinRecord> {
  const body = await loyaltyRequest(where, {
    transition: "join",
    consent: {
      accepted: true,
      terms_version: consent.termsVersion,
      fingerprint: consent.fingerprint,
    },
  });
  const join = joinOf(body.join);
  if (!join) throw new LoyaltyError("unavailable");
  return join;
}

function membershipOf(value: unknown): LoyaltyMembershipView | undefined {
  if (!record(value)) return undefined;
  switch (value.status) {
    case "none":
    case "pending_pass":
    case "unconfirmed":
      return { status: value.status };
    case "pending_approval":
    case "declined":
    case "pending_creation": {
      const join = joinOf(value.join);
      return join ? { status: value.status, join } : undefined;
    }
    case "active":
    case "held":
    case "ended": {
      const membership = record(value.membership) ? value.membership : {};
      return typeof membership.objectId === "string" &&
        typeof membership.state === "string" &&
        typeof membership.recordedAt === "string"
        ? {
            status: value.status,
            membership: {
              objectId: membership.objectId,
              state: membership.state,
              recordedAt: membership.recordedAt,
            },
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

export interface MembershipRead {
  membership: LoyaltyMembershipView;
  submissions: Array<{ operationId: string; activityType: string }>;
  /** Whether this binding states loyalty-benefit-redeem-v1. */
  benefits: boolean;
}

export async function readMembership(
  where: Where,
  signal?: AbortSignal,
): Promise<MembershipRead> {
  const body = await loyaltyRequest(
    where,
    { transition: "membership" },
    signal,
  );
  const membership = membershipOf(body.membership);
  const submissions = Array.isArray(body.submissions) ? body.submissions : [];
  if (
    !membership ||
    !submissions.every(
      (item) =>
        record(item) &&
        isOperationId(item.operationId) &&
        typeof item.activityType === "string" &&
        ACTIVITY_TYPE.test(item.activityType),
    )
  ) {
    throw new LoyaltyError("unavailable");
  }
  if (typeof body.benefits !== "boolean") {
    throw new LoyaltyError("unavailable");
  }
  return {
    membership,
    submissions: submissions as MembershipRead["submissions"],
    benefits: body.benefits,
  };
}

/**
 * One launch's journal-writing steps (prepare, submit, status), one at a
 * time: each answer's journal cookie then always builds on the one before,
 * so no slower answer can overwrite a newer prepared submission.
 */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(where: Where, step: () => Promise<T>): Promise<T> {
  const key = `${where.slug} ${where.launchId}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(step, step);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

async function submissionAnswer(
  where: Where,
  body: Record<string, unknown>,
): Promise<LoyaltySubmissionView> {
  const answer = await loyaltyRequest(where, body);
  if (!isLoyaltySubmissionView(answer.submission)) {
    throw new LoyaltyError("unavailable");
  }
  return answer.submission;
}

/** The runtime's own zero-write refusals of a sent submission. */
const REFUSALS = [
  "loyalty_activity_evidence_duplicate",
  "loyalty_activity_type_unknown",
  "membership_not_active",
];

export type SubmitOutcome =
  /** Prepare failed or was refused: nothing was sent. */
  | { kind: "not_sent"; code: string }
  /** Sent, and the runtime refused it with zero writes: nothing recorded. */
  | { kind: "refused"; code: string }
  /** Sent, or possibly sent: shown under its original operation only. */
  | { kind: "sent"; submission: LoyaltySubmissionView };

/**
 * One activity submission: `prepare` (journalled and returned to this
 * browser, nothing sent), then exactly one `submit` of that operation. Any
 * failure after the prepare leaves it possibly sent: it is shown as unknown
 * under its original id and never sent again.
 */
export function submitActivity(
  where: Where,
  activityType: string,
  evidenceRef: string,
): Promise<SubmitOutcome> {
  return serial(where, async () => {
    let operationId: string;
    try {
      const prepared = await loyaltyRequest(where, {
        transition: "prepare",
        activity_type: activityType,
        evidence_ref: evidenceRef,
      });
      const value = record(prepared.prepared) ? prepared.prepared : {};
      if (!isOperationId(value.operationId)) {
        throw new LoyaltyError("unavailable");
      }
      operationId = value.operationId;
    } catch (error) {
      return {
        kind: "not_sent",
        code: error instanceof LoyaltyError ? error.code : "unavailable",
      };
    }
    try {
      return {
        kind: "sent",
        submission: await submissionAnswer(where, {
          transition: "submit",
          operation_id: operationId,
          activity_type: activityType,
          evidence_ref: evidenceRef,
        }),
      };
    } catch (error) {
      if (error instanceof LoyaltyError && REFUSALS.includes(error.code)) {
        return { kind: "refused", code: error.code };
      }
      return {
        kind: "sent",
        submission: { operationId, activityType, status: "unknown" },
      };
    }
  });
}

/** Read-only status of one of this wallet's own submissions. Never resends. */
export function submissionStatus(where: Where, operationId: string) {
  return serial(where, () =>
    submissionAnswer(where, {
      transition: "status",
      operation_id: operationId,
    }),
  );
}

// ------------------------------------------- loyalty-benefit-redeem-v1

export interface BenefitsRead {
  /** Null before the membership exists, or when it cannot be confirmed. */
  benefits: LoyaltyBenefitsView | null;
  unconfirmed: boolean;
  redemptions: Array<{ operationId: string; benefitId: string }>;
}

export async function readBenefits(
  where: Where,
  signal?: AbortSignal,
): Promise<BenefitsRead> {
  const body = await loyaltyRequest(where, { transition: "benefits" }, signal);
  const redemptions = Array.isArray(body.redemptions) ? body.redemptions : [];
  if (
    (body.benefits !== null && !isLoyaltyBenefitsView(body.benefits)) ||
    typeof body.unconfirmed !== "boolean" ||
    !redemptions.every(
      (item) =>
        record(item) &&
        isOperationId(item.operationId) &&
        typeof item.benefitId === "string",
    )
  ) {
    throw new LoyaltyError("unavailable");
  }
  return {
    benefits: body.benefits as LoyaltyBenefitsView | null,
    unconfirmed: body.unconfirmed,
    redemptions: redemptions as BenefitsRead["redemptions"],
  };
}

async function redemptionAnswer(
  where: Where,
  body: Record<string, unknown>,
): Promise<LoyaltyRedemptionView> {
  const answer = await loyaltyRequest(where, body);
  if (!isLoyaltyRedemptionView(answer.redemption)) {
    throw new LoyaltyError("unavailable");
  }
  return answer.redemption;
}

/** The runtime's own zero-write refusals of a sent request. */
const REDEEM_REFUSALS = [
  "loyalty_redemption_not_permitted",
  "loyalty_reward_changed",
  "loyalty_reward_expired",
  "loyalty_reward_unverified",
  "loyalty_redemption_already_requested",
  "membership_not_active",
];

export type RedeemOutcome =
  | { kind: "not_sent"; code: string }
  | { kind: "refused"; code: string }
  | { kind: "sent"; redemption: LoyaltyRedemptionView };

/**
 * One redemption request for exactly the grant shown: `redeem_prepare`
 * (journalled and returned, nothing sent), then exactly one `redeem_submit`.
 * Any failure after the prepare leaves it possibly sent: shown as unknown
 * under its original id and never sent again.
 */
export function requestRedemption(
  where: Where,
  benefitId: string,
  grantActionId: string,
): Promise<RedeemOutcome> {
  return serial(where, async () => {
    let operationId: string;
    let binding: Record<string, unknown>;
    try {
      const answer = await loyaltyRequest(where, {
        transition: "redeem_prepare",
        benefit_id: benefitId,
        grant_action_id: grantActionId,
      });
      const value = record(answer.prepared) ? answer.prepared : {};
      if (!isOperationId(value.operationId) || !record(value.binding)) {
        throw new LoyaltyError("unavailable");
      }
      operationId = value.operationId;
      binding = value.binding;
    } catch (error) {
      return {
        kind: "not_sent",
        code: error instanceof LoyaltyError ? error.code : "unavailable",
      };
    }
    try {
      return {
        kind: "sent",
        redemption: await redemptionAnswer(where, {
          transition: "redeem_submit",
          operation_id: operationId,
          benefit_id: binding.benefit_id,
          grant_action_id: binding.grant_action_id,
          allocation_id: binding.allocation_id,
          revision_hash: binding.revision_hash,
        }),
      };
    } catch (error) {
      if (
        error instanceof LoyaltyError &&
        REDEEM_REFUSALS.includes(error.code)
      ) {
        return { kind: "refused", code: error.code };
      }
      return {
        kind: "sent",
        redemption: { operationId, benefitId, status: "unknown" },
      };
    }
  });
}

/** Read-only status of one of this wallet's own requests. Never resends. */
export function redemptionStatus(where: Where, operationId: string) {
  return serial(where, () =>
    redemptionAnswer(where, {
      transition: "redeem_status",
      operation_id: operationId,
    }),
  );
}

/**
 * The member's one-time reference for the current request, on their own
 * explicit action. Returned to the caller only: never cached, stored, put in
 * a URL or logged.
 */
export async function showRedemptionReference(
  where: Where,
  requestActionId: string,
): Promise<string> {
  const answer = await loyaltyRequest(where, {
    transition: "reference",
    request_action_id: requestActionId,
  });
  const value = record(answer.reference) ? answer.reference : {};
  if (
    typeof value.code !== "string" ||
    !REDEMPTION_REFERENCE.test(value.code) ||
    value.requestActionId !== requestActionId
  ) {
    throw new LoyaltyError("unavailable");
  }
  return value.code;
}
