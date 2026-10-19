import "client-only";

import { isOperationId } from "@/app/_domain/product-face";
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
  return {
    membership,
    submissions: submissions as MembershipRead["submissions"],
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
