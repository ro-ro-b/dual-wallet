// loyalty-benefit-redeem-v1 (docs/proposals/loyalty-benefit-redeem-v1.md):
// the exact wire of the member's benefits read, redemption request, its
// status and its explicit one-time reference, and the pure proof rules the
// BFF applies to them. Every Dual claim is an ActionReceipt proven with the
// loyalty-join-earn-v1 §5 rules (src/_domain/loyalty.ts checkReceipt); stock,
// terms, progress labels and validity are the programme's APPLICATION
// records, labelled as such and never a substitute for canonical state.
// Shared by the BFF and the native page (relative imports only).
import {
  ACTIVITY_TYPE,
  LOYALTY_PURPOSE,
  parseAccounting,
  parseActionReceipt,
  parseCanonicalRead,
  verificationFollows,
  type ActionReceipt,
  type CanonicalRead,
} from "./loyalty";
import { canonicalJson, isObjectId, isOperationId } from "./product-face";

export const BENEFIT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ALLOCATION_ID = /^alc_[0-9a-f]{32}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Studio's one-time reference: 8 letters of its 32-letter alphabet. */
export const REDEMPTION_REFERENCE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
/** Bounds of one benefits read (Studio's own content limits). */
const MAX_BENEFITS = 12;
const MAX_RULES = 8;
export const MAX_VERIFIED_ACTIVITIES = 100;
/** Earlier handover attempts of one reward a read may carry (§4.1). */
export const MAX_FAILED_ATTEMPTS = 50;

const STOCK_STATUSES = [
  "available",
  "reserved_pending",
  "exhausted",
  "proof_unverified",
  "proof_partially_checked",
] as const;
type StockStatus = (typeof STOCK_STATUSES)[number];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max = 500) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const count = (value: unknown, max = 1_000_000) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max
    ? value
    : undefined;
const benefitId = (value: unknown) =>
  typeof value === "string" && BENEFIT_ID.test(value) ? value : undefined;
const iso = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;

// ---------------------------------------------------------------- types

/** APPLICATION: the app's shared-stock ledger entry of one grant. */
export interface Allocation {
  allocationId: string;
  benefitId: string;
  eventId: string;
  proof: { objectId: string; actionId: string };
}

/** APPLICATION: Studio's availability view of one benefit's shared stock. */
export interface StockView {
  stock: number;
  remaining: number | null;
  status: StockStatus;
}

/** APPLICATION: one benefit of the record's programme revision. */
export interface BenefitTerms {
  benefitId: string;
  title: string;
  description: string;
  type: string;
  value: number | null;
  partner: { partnerId: string; name: string } | null;
  validDays: number;
  terms: string;
  /** A verified confirm of this benefit on this record before (perMemberLimit 1). */
  redeemedBefore: boolean;
  stock: StockView;
}

/** APPLICATION: the programme's own count for one rule. */
export interface RuleProgress {
  ruleId: string;
  label: string;
  activityTypes: string[];
  benefitIds: string[];
  requiredVerified: number;
  verified: number;
  pendingVerification: 0 | 1;
}

/** One verified activity: two Dual receipts, the type the programme's label. */
export interface VerifiedActivity {
  activityType: string;
  evidenceHash: string;
  submission: ActionReceipt;
  verification: ActionReceipt;
}

/**
 * One earlier handover attempt of the same reward that a definitive failure
 * ended (§2 (5)): the member's request, the partner's confirmation and the
 * partner's failed handover, each the very next change after the one before.
 */
export interface FailedAttempt {
  request: ActionReceipt;
  confirmation: ActionReceipt;
  failure: ActionReceipt;
}

/** The record's latest grant and what followed it (Dual receipts). */
export interface RewardChain {
  benefitId: string;
  grant: ActionReceipt;
  allocation: Allocation;
  /** APPLICATION: grant time + the benefit's valid days (never extended). */
  validUntil: string;
  /** Earlier attempts, oldest first; the reward restored after each. */
  failedAttempts: FailedAttempt[];
  request?: ActionReceipt;
  confirmation?: ActionReceipt;
  /** APPLICATION: the partner's confirmation is recorded, not yet on Dual. */
  confirmationRecording: boolean;
  fulfilment?: ActionReceipt;
  /** APPLICATION: the partner's handover outcome is recorded, not yet on Dual. */
  handoverRecording: boolean;
  settlement?: ActionReceipt;
}

export interface BenefitsRead {
  programme: { programmeId: string; revisionHash: string };
  canonical: CanonicalRead;
  progress: RuleProgress[];
  verified: VerifiedActivity[];
  benefits: BenefitTerms[];
  reward: RewardChain | null;
}

/** The exact grant a member's request redeems (§4.2), as the runtime names it. */
export interface RedemptionBinding {
  revisionHash: string;
  benefitId: string;
  grantActionId: string;
  allocationId: string;
}

// -------------------------------------------------------------- parsers

function parseAllocation(value: unknown): Allocation | undefined {
  if (
    !record(value) ||
    !exactKeys(value, [
      "allocation_id",
      "benefit_id",
      "event_id",
      "status",
      "proof",
    ]) ||
    typeof value.allocation_id !== "string" ||
    !ALLOCATION_ID.test(value.allocation_id) ||
    !benefitId(value.benefit_id) ||
    typeof value.event_id !== "string" ||
    !EVENT_ID.test(value.event_id) ||
    // Only a consumed allocation is a grant's backing (Studio ledger).
    value.status !== "consumed" ||
    !record(value.proof) ||
    !exactKeys(value.proof, ["object_id", "action_id"]) ||
    !isObjectId(value.proof.object_id) ||
    typeof value.proof.action_id !== "string" ||
    !ACTION_ID.test(value.proof.action_id)
  ) {
    return undefined;
  }
  return {
    allocationId: value.allocation_id,
    benefitId: value.benefit_id as string,
    eventId: value.event_id,
    proof: { objectId: value.proof.object_id, actionId: value.proof.action_id },
  };
}

function parseStock(value: unknown): StockView | undefined {
  if (!record(value) || !exactKeys(value, ["stock", "remaining", "status"])) {
    return undefined;
  }
  const stock = count(value.stock);
  const remaining =
    value.remaining === null ? null : count(value.remaining, stock);
  if (
    stock === undefined ||
    remaining === undefined ||
    !(STOCK_STATUSES as readonly unknown[]).includes(value.status)
  ) {
    return undefined;
  }
  return { stock, remaining, status: value.status as StockStatus };
}

function parseBenefit(value: unknown): BenefitTerms | undefined {
  if (!record(value)) return undefined;
  const id = benefitId(value.benefit_id);
  const partner = value.partner;
  const amount =
    value.value === undefined
      ? null
      : record(value.value) && exactKeys(value.value, ["amount"])
        ? (count(value.value.amount, 100_000) ?? undefined)
        : undefined;
  const validDays = count(value.valid_days, 3650);
  const stock = parseStock(value.stock);
  const parsedPartner =
    partner === null
      ? null
      : record(partner) &&
          exactKeys(partner, ["partner_id", "name"]) &&
          benefitId(partner.partner_id) &&
          text(partner.name, 120) !== undefined
        ? {
            partnerId: partner.partner_id as string,
            name: partner.name as string,
          }
        : undefined;
  if (
    !id ||
    text(value.title, 140) === undefined ||
    text(value.description, 300) === undefined ||
    typeof value.type !== "string" ||
    !CODE.test(value.type) ||
    amount === undefined ||
    parsedPartner === undefined ||
    !validDays ||
    text(value.terms, 400) === undefined ||
    typeof value.redeemed_before !== "boolean" ||
    !stock
  ) {
    return undefined;
  }
  return {
    benefitId: id,
    title: value.title as string,
    description: value.description as string,
    type: value.type,
    value: amount,
    partner: parsedPartner,
    validDays,
    terms: value.terms as string,
    redeemedBefore: value.redeemed_before,
    stock,
  };
}

function parseRule(value: unknown): RuleProgress | undefined {
  if (!record(value)) return undefined;
  const types = value.activity_types;
  const benefits = value.benefit_ids;
  const required = count(value.required_verified, 100);
  const verified = count(value.verified, 10_000);
  if (
    !benefitId(value.rule_id) ||
    text(value.label, 120) === undefined ||
    !Array.isArray(types) ||
    !types.length ||
    !types.every(
      (item) => typeof item === "string" && ACTIVITY_TYPE.test(item),
    ) ||
    !Array.isArray(benefits) ||
    !benefits.length ||
    !benefits.every((item) => benefitId(item)) ||
    !required ||
    verified === undefined ||
    (value.pending_verification !== 0 && value.pending_verification !== 1)
  ) {
    return undefined;
  }
  return {
    ruleId: value.rule_id as string,
    label: value.label as string,
    activityTypes: types as string[],
    benefitIds: benefits as string[],
    requiredVerified: required,
    verified,
    pendingVerification: value.pending_verification,
  };
}

function parseVerifiedActivity(value: unknown): VerifiedActivity | undefined {
  if (
    !record(value) ||
    !exactKeys(value, [
      "activity_type",
      "evidence_hash",
      "submission",
      "verification",
    ]) ||
    typeof value.activity_type !== "string" ||
    !ACTIVITY_TYPE.test(value.activity_type) ||
    typeof value.evidence_hash !== "string" ||
    !HASH.test(value.evidence_hash)
  ) {
    return undefined;
  }
  const submission = parseActionReceipt(value.submission, "submit_activity");
  const verification = parseActionReceipt(
    value.verification,
    "verify_activity",
  );
  return submission && verification
    ? {
        activityType: value.activity_type,
        evidenceHash: value.evidence_hash,
        submission,
        verification,
      }
    : undefined;
}

function parseFailedAttempt(value: unknown): FailedAttempt | undefined {
  if (
    !record(value) ||
    !exactKeys(value, ["request", "confirmation", "failure"])
  ) {
    return undefined;
  }
  const request = parseActionReceipt(value.request, "request_redemption");
  const confirmation = parseActionReceipt(
    value.confirmation,
    "confirm_redemption",
  );
  const failure = parseActionReceipt(value.failure, "fail_fulfilment");
  return request && confirmation && failure
    ? { request, confirmation, failure }
    : undefined;
}

/** The grant, its allocation and the steps that followed it, exactly. */
function parseChain(
  value: Record<string, unknown>,
  withValidity: boolean,
): Omit<RewardChain, "benefitId" | "validUntil"> | undefined {
  const grant = parseActionReceipt(value.grant, "unlock_benefit");
  const allocation = parseAllocation(value.allocation);
  const failedAttempts = Array.isArray(value.failed_attempts)
    ? value.failed_attempts.map(parseFailedAttempt)
    : [];
  const request =
    value.request === undefined && value.action === undefined
      ? undefined
      : parseActionReceipt(value.request ?? value.action, "request_redemption");
  const confirmation =
    value.confirmation === undefined
      ? undefined
      : parseActionReceipt(value.confirmation, "confirm_redemption");
  const fulfilment =
    value.fulfilment === undefined
      ? undefined
      : parseActionReceipt(value.fulfilment, "record_fulfilment");
  const settlement =
    value.settlement === undefined
      ? undefined
      : parseActionReceipt(value.settlement, "settle_partner");
  if (
    !grant ||
    !allocation ||
    // Present only with at least one attempt; every attempt complete.
    (value.failed_attempts !== undefined &&
      (!Array.isArray(value.failed_attempts) ||
        !value.failed_attempts.length ||
        value.failed_attempts.length > MAX_FAILED_ATTEMPTS ||
        failedAttempts.some((item) => !item))) ||
    (value.request !== undefined && value.action !== undefined) ||
    ((value.request !== undefined || value.action !== undefined) && !request) ||
    (value.confirmation !== undefined && !confirmation) ||
    (value.fulfilment !== undefined && !fulfilment) ||
    (value.settlement !== undefined && !settlement) ||
    // Each later step needs the one before it; settlement only after the
    // partner's verified handover.
    (confirmation && !request) ||
    (fulfilment && !confirmation) ||
    (settlement && !fulfilment) ||
    (value.confirmation_recording !== undefined &&
      (value.confirmation_recording !== true || !request || confirmation)) ||
    (value.handover_recording !== undefined &&
      (value.handover_recording !== true || !confirmation || fulfilment)) ||
    (withValidity && !iso(value.valid_until))
  ) {
    return undefined;
  }
  return {
    grant,
    allocation,
    failedAttempts: failedAttempts as FailedAttempt[],
    ...(request ? { request } : {}),
    ...(confirmation ? { confirmation } : {}),
    confirmationRecording: value.confirmation_recording === true,
    ...(fulfilment ? { fulfilment } : {}),
    handoverRecording: value.handover_recording === true,
    ...(settlement ? { settlement } : {}),
  };
}

/**
 * §4.1, with its exact zero-write accounting, for exactly the binding's own
 * programme (as parseProgrammeRead: another programme's terms, progress or
 * revision are never this one's).
 */
export function parseBenefitsRead(
  httpStatus: number,
  body: unknown,
  programmeId: string,
): BenefitsRead | undefined {
  if (
    httpStatus !== 200 ||
    !record(body) ||
    body.ok !== true ||
    body.status !== "benefits_read"
  ) {
    return undefined;
  }
  const accounting = parseAccounting(body.accounting);
  const programme = body.programme;
  const canonical = parseCanonicalRead(body.canonical);
  const progress = Array.isArray(body.progress)
    ? body.progress.map(parseRule)
    : [];
  const verified = Array.isArray(body.verified_activities)
    ? body.verified_activities.map(parseVerifiedActivity)
    : [];
  const benefits = Array.isArray(body.benefits)
    ? body.benefits.map(parseBenefit)
    : [];
  if (
    accounting?.dualWrites !== 0 ||
    accounting.reason !== "benefits_read" ||
    !record(programme) ||
    !exactKeys(programme, ["programme_id", "revision_hash"]) ||
    programme.programme_id !== programmeId ||
    typeof programme.revision_hash !== "string" ||
    !HASH.test(programme.revision_hash) ||
    !canonical ||
    !Array.isArray(body.progress) ||
    body.progress.length > MAX_RULES ||
    progress.some((item) => !item) ||
    !Array.isArray(body.verified_activities) ||
    body.verified_activities.length > MAX_VERIFIED_ACTIVITIES ||
    verified.some((item) => !item) ||
    !Array.isArray(body.benefits) ||
    !body.benefits.length ||
    body.benefits.length > MAX_BENEFITS ||
    benefits.some((item) => !item) ||
    new Set(benefits.map((item) => item!.benefitId)).size !== benefits.length
  ) {
    return undefined;
  }
  let reward: RewardChain | null = null;
  if (body.reward !== null) {
    if (!record(body.reward)) return undefined;
    const id = benefitId(body.reward.benefit_id);
    const chain = parseChain(body.reward, true);
    if (!id || !chain || !benefits.some((item) => item!.benefitId === id)) {
      return undefined;
    }
    reward = {
      benefitId: id,
      validUntil: body.reward.valid_until as string,
      ...chain,
    };
  }
  return {
    programme: {
      programmeId: programme.programme_id,
      revisionHash: programme.revision_hash,
    },
    canonical,
    progress: progress as RuleProgress[],
    verified: verified as VerifiedActivity[],
    benefits: benefits as BenefitTerms[],
    reward,
  };
}

function parseBinding(value: unknown): RedemptionBinding | undefined {
  if (
    !record(value) ||
    !exactKeys(value, [
      "revision_hash",
      "benefit_id",
      "grant_action_id",
      "allocation_id",
    ]) ||
    typeof value.revision_hash !== "string" ||
    !HASH.test(value.revision_hash) ||
    !benefitId(value.benefit_id) ||
    typeof value.grant_action_id !== "string" ||
    !ACTION_ID.test(value.grant_action_id) ||
    typeof value.allocation_id !== "string" ||
    !ALLOCATION_ID.test(value.allocation_id)
  ) {
    return undefined;
  }
  return {
    revisionHash: value.revision_hash,
    benefitId: value.benefit_id as string,
    grantActionId: value.grant_action_id,
    allocationId: value.allocation_id,
  };
}

/** The runtime input of a request: exactly the four ids of its binding. */
export const redemptionInput = (binding: RedemptionBinding) => ({
  benefit_id: binding.benefitId,
  grant_action_id: binding.grantActionId,
  allocation_id: binding.allocationId,
  revision_hash: binding.revisionHash,
});

/** The preimage of the journalled binding hash (canonical JSON of the ids). */
export const bindingPreimage = (binding: RedemptionBinding) =>
  canonicalJson(redemptionInput(binding));

export const REDEEM_REFUSALS = [
  "loyalty_redemption_not_permitted",
  "loyalty_reward_changed",
  "loyalty_reward_expired",
  "loyalty_reward_unverified",
  "loyalty_redemption_already_requested",
  // A restored reward's new request: no unit to hand over now (§2 (5)).
  "loyalty_benefit_stock_exhausted",
  "membership_not_active",
] as const;
export type RedeemRefusal = (typeof REDEEM_REFUSALS)[number];

export type RedeemAnswer =
  | {
      kind: "requested";
      canonical: CanonicalRead;
      grant: ActionReceipt;
      allocation: Allocation;
      failedAttempts: FailedAttempt[];
      request: ActionReceipt;
    }
  | { kind: "refused"; reason: RedeemRefusal }
  /** Anything else, operation_already_received included: never a refusal. */
  | { kind: "unknown" };

/** §4.2. */
export function parseRedeemAnswer(
  httpStatus: number,
  body: unknown,
): RedeemAnswer {
  if (!record(body)) return { kind: "unknown" };
  const accounting = parseAccounting(body.accounting);
  if (httpStatus === 200 && body.ok === true) {
    const canonical = parseCanonicalRead(body.canonical);
    const chain = parseChain(body, false);
    return body.status === "redemption_requested" &&
      canonical &&
      chain?.request &&
      !chain.confirmation &&
      !chain.settlement &&
      !chain.confirmationRecording &&
      accounting?.dualWrites === 1 &&
      accounting.reason === "redemption_requested"
      ? {
          kind: "requested",
          canonical,
          grant: chain.grant,
          allocation: chain.allocation,
          failedAttempts: chain.failedAttempts,
          request: chain.request,
        }
      : { kind: "unknown" };
  }
  const reason = (REDEEM_REFUSALS as readonly string[]).includes(
    String(body.status),
  )
    ? (body.status as RedeemRefusal)
    : undefined;
  return httpStatus === 409 &&
    body.ok === false &&
    reason &&
    accounting?.dualWrites === 0 &&
    accounting.reason === reason
    ? { kind: "refused", reason }
    : { kind: "unknown" };
}

const STATUS_KINDS = [
  "requested",
  "confirmation_recording",
  "confirmed",
  "fulfilled",
  "fulfilment_failed",
] as const;
type StatusKind = (typeof STATUS_KINDS)[number];

export type RedemptionStatusAnswer =
  | {
      kind: StatusKind;
      binding: RedemptionBinding;
      canonical: CanonicalRead;
      chain: Omit<RewardChain, "benefitId">;
      /** fulfilment_failed: this operation's attempt among the failed ones. */
      failedAttempt: number | null;
    }
  /** A committed answer that does not echo exactly this operation. */
  | { kind: "foreign" }
  | { kind: "not_received" }
  | { kind: "unknown" };

/**
 * §4.3, for exactly one original operation: every answer echoes its
 * `operation_id`, and a committed one the `request_hash` the runtime
 * recorded for it (the r20 echo rule). The same grant is not enough: only
 * this operation's own record is its outcome.
 */
export function parseRedemptionStatus(
  httpStatus: number,
  body: unknown,
  expected: { operationId: string; requestHash: string },
): RedemptionStatusAnswer {
  if (!record(body)) return { kind: "unknown" };
  const accounting = parseAccounting(body.accounting);
  if (
    httpStatus === 200 &&
    body.ok === true &&
    body.status === "not_received"
  ) {
    // Never received: only ever about the operation it names.
    return accounting?.dualWrites === 0 &&
      accounting.reason === "operation_not_received" &&
      body.operation_id === expected.operationId
      ? { kind: "not_received" }
      : { kind: "unknown" };
  }
  if (
    httpStatus !== 200 ||
    body.ok !== true ||
    !(STATUS_KINDS as readonly string[]).includes(String(body.status))
  ) {
    return { kind: "unknown" };
  }
  const binding = parseBinding(body.binding);
  const canonical = parseCanonicalRead(body.canonical);
  const chain = parseChain(body, true);
  const kind = body.status as StatusKind;
  const failedAttempt =
    kind === "fulfilment_failed" ? count(body.failed_attempt) : undefined;
  if (
    !binding ||
    !canonical ||
    !chain ||
    binding.benefitId !== chain.allocation.benefitId ||
    // The status names exactly what its chain shows: an earlier attempt a
    // definitive failure ended, or the current one at its own step.
    (kind === "fulfilment_failed"
      ? failedAttempt === undefined ||
        failedAttempt >= chain.failedAttempts.length
      : body.failed_attempt !== undefined ||
        !chain.request ||
        (kind === "fulfilled") !== Boolean(chain.fulfilment) ||
        (kind === "confirmed") !==
          Boolean(chain.confirmation && !chain.fulfilment) ||
        (kind === "confirmation_recording") !== chain.confirmationRecording)
  ) {
    return { kind: "unknown" };
  }
  if (
    body.operation_id !== expected.operationId ||
    body.request_hash !== expected.requestHash
  ) {
    return { kind: "foreign" };
  }
  return {
    kind,
    binding,
    canonical,
    chain: { ...chain, validUntil: body.valid_until as string },
    failedAttempt: failedAttempt ?? null,
  };
}

export type ReferenceAnswer =
  | {
      kind: "shown";
      reference: string;
      canonical: CanonicalRead;
      grant: ActionReceipt;
      allocation: Allocation;
      failedAttempts: FailedAttempt[];
      request: ActionReceipt;
    }
  | { kind: "not_current" }
  | { kind: "unknown" };

/** §4.4. */
export function parseReferenceAnswer(
  httpStatus: number,
  body: unknown,
): ReferenceAnswer {
  if (!record(body)) return { kind: "unknown" };
  const accounting = parseAccounting(body.accounting);
  if (httpStatus === 409 && body.ok === false) {
    return body.status === "loyalty_redemption_not_current" &&
      accounting?.dualWrites === 0 &&
      accounting.reason === "loyalty_redemption_not_current"
      ? { kind: "not_current" }
      : { kind: "unknown" };
  }
  const canonical = parseCanonicalRead(body.canonical);
  const chain = parseChain(body, false);
  return httpStatus === 200 &&
    body.ok === true &&
    body.status === "reference_shown" &&
    typeof body.reference === "string" &&
    REDEMPTION_REFERENCE.test(body.reference) &&
    canonical &&
    chain?.request &&
    !chain.confirmation &&
    accounting?.dualWrites === 0 &&
    accounting.reason === "reference_shown"
    ? {
        kind: "shown",
        reference: body.reference,
        canonical,
        grant: chain.grant,
        allocation: chain.allocation,
        failedAttempts: chain.failedAttempts,
        request: chain.request,
      }
    : { kind: "unknown" };
}

// ---------------------------------------------------------------- proofs

/** Studio's allocation id input: `alc_` + 32 hex of sha256 over this. */
export const allocationPreimage = (
  benefit: string,
  recordId: string,
  eventId: string,
) => `${benefit}\n${recordId}\n${eventId}`;

/**
 * §5 Grant: the consumed allocation of exactly this grant, by its own id,
 * object, action and intent event (the grant's lifecycle action id).
 */
export function allocationBacksGrant(
  allocation: Allocation,
  grant: ActionReceipt,
  canonical: CanonicalRead,
  benefit: string,
  expectedAllocationId: string,
) {
  const lifecycle = record(grant.writtenCustom.lifecycle)
    ? grant.writtenCustom.lifecycle
    : {};
  return (
    allocation.benefitId === benefit &&
    allocation.allocationId === expectedAllocationId &&
    allocation.proof.objectId === canonical.objectId &&
    allocation.proof.actionId === grant.actionId &&
    grant.objectId === canonical.objectId &&
    lifecycle.action_id ===
      `${LOYALTY_PURPOSE}_unlock_benefit_${allocation.eventId}`
  );
}

/** §5 chain: `next` is the very next change to the object after `previous`. */
export const nextChange = verificationFollows;

/** A receipt at the canonical's own nonce: the record's current state. */
export const isCurrent = (receipt: ActionReceipt, canonical: CanonicalRead) =>
  receipt.objectId === canonical.objectId &&
  receipt.nextNonce === canonical.nonce;

/**
 * §5 Verified eligibility for one rule: enough of its own types among the
 * pairs the caller PROVED (distinct, adjacent, on this object).
 */
export const ruleProven = (rule: RuleProgress, proven: VerifiedActivity[]) =>
  proven.filter((pair) => rule.activityTypes.includes(pair.activityType))
    .length >= rule.requiredVerified;

/** APPLICATION availability, as the page may say it (§5 Stock). */
export function availabilityOf(stock: StockView) {
  if (stock.status === "available" && (stock.remaining ?? 0) > 0) {
    return "available" as const;
  }
  if (stock.status === "exhausted" || stock.status === "reserved_pending") {
    return "unavailable" as const;
  }
  return "unconfirmed" as const;
}

// ----------------------------------------------------------------- views

export const benefitStatuses = [
  "locked",
  "eligible_unconfirmed",
  "eligible",
  "already_redeemed",
  "granted",
  "expired",
  "requested",
  "confirmation_recording",
  "confirmed",
  "handover_recording",
  "fulfilled",
  "restored",
  "settled",
  "not_redeemable",
  "unconfirmed",
] as const;
export type BenefitStatus = (typeof benefitStatuses)[number];
export type RewardStatus = Extract<
  BenefitStatus,
  | "granted"
  | "expired"
  | "requested"
  | "confirmation_recording"
  | "confirmed"
  | "handover_recording"
  | "fulfilled"
  | "restored"
  | "settled"
  | "not_redeemable"
  | "unconfirmed"
>;
const rewardStatuses: readonly string[] = [
  "granted",
  "expired",
  "requested",
  "confirmation_recording",
  "confirmed",
  "handover_recording",
  "fulfilled",
  "restored",
  "settled",
  "not_redeemable",
  "unconfirmed",
];

export const nextActors = [
  "verifier",
  "programme_team",
  "partner",
  "settlement",
] as const;
export type NextActor = (typeof nextActors)[number];

/** What the native page may show about benefits: proven, or labelled. */
export interface LoyaltyBenefitsView {
  state: string;
  held: boolean;
  progress: Array<{
    ruleId: string;
    label: string;
    requiredVerified: number;
    verified: number;
    pendingVerification: 0 | 1;
    benefitIds: string[];
  }>;
  benefits: Array<{
    benefitId: string;
    title: string;
    description: string;
    terms: string;
    partnerName: string | null;
    validDays: number;
    status: BenefitStatus;
    availability: "available" | "unavailable" | "unconfirmed";
  }>;
  reward: {
    benefitId: string;
    status: RewardStatus;
    validUntil: string;
    grantActionId: string | null;
    requestActionId: string | null;
    /** Proven earlier handovers that failed (the reward restored after each). */
    failedHandovers: number;
  } | null;
  actions: {
    submitActivity: boolean;
    requestRedemption: boolean;
    showReference: boolean;
  };
  next: NextActor | null;
}

export const redemptionStatuses = [
  "requested",
  "confirmation_recording",
  "confirmed",
  "handover_recording",
  "fulfilled",
  "fulfilment_failed",
  "settled",
  "unknown",
  "not_received",
  "unconfirmed",
] as const;
export type LoyaltyRedemptionStatus = (typeof redemptionStatuses)[number];

export interface LoyaltyRedemptionView {
  operationId: string;
  benefitId: string;
  status: LoyaltyRedemptionStatus;
}

export function isLoyaltyRedemptionView(
  value: unknown,
): value is LoyaltyRedemptionView {
  return (
    record(value) &&
    isOperationId(value.operationId) &&
    typeof value.benefitId === "string" &&
    BENEFIT_ID.test(value.benefitId) &&
    (redemptionStatuses as readonly unknown[]).includes(value.status)
  );
}

const flag = (value: unknown) => typeof value === "boolean";

/** The page's own check of a benefits view (defence in depth). */
export function isLoyaltyBenefitsView(
  value: unknown,
): value is LoyaltyBenefitsView {
  if (!record(value) || !record(value.actions)) return false;
  const reward = value.reward;
  return (
    typeof value.state === "string" &&
    flag(value.held) &&
    Array.isArray(value.progress) &&
    value.progress.every(
      (item) =>
        record(item) &&
        typeof item.ruleId === "string" &&
        typeof item.label === "string" &&
        count(item.requiredVerified, 100) !== undefined &&
        count(item.verified, 10_000) !== undefined &&
        (item.pendingVerification === 0 || item.pendingVerification === 1) &&
        Array.isArray(item.benefitIds),
    ) &&
    Array.isArray(value.benefits) &&
    value.benefits.every(
      (item) =>
        record(item) &&
        typeof item.benefitId === "string" &&
        BENEFIT_ID.test(item.benefitId) &&
        typeof item.title === "string" &&
        typeof item.description === "string" &&
        typeof item.terms === "string" &&
        (item.partnerName === null || typeof item.partnerName === "string") &&
        count(item.validDays, 3650) !== undefined &&
        (benefitStatuses as readonly unknown[]).includes(item.status) &&
        ["available", "unavailable", "unconfirmed"].includes(
          String(item.availability),
        ),
    ) &&
    (reward === null ||
      (record(reward) &&
        typeof reward.benefitId === "string" &&
        rewardStatuses.includes(String(reward.status)) &&
        iso(reward.validUntil) !== undefined &&
        (reward.grantActionId === null ||
          typeof reward.grantActionId === "string") &&
        (reward.requestActionId === null ||
          typeof reward.requestActionId === "string") &&
        count(reward.failedHandovers, MAX_FAILED_ATTEMPTS) !== undefined)) &&
    flag(value.actions.submitActivity) &&
    flag(value.actions.requestRedemption) &&
    flag(value.actions.showReference) &&
    (value.next === null ||
      (nextActors as readonly unknown[]).includes(value.next))
  );
}
