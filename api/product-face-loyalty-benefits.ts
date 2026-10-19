import "server-only";

import { sha256Hash } from "@/api/face-assertion";
import type { FaceJournal } from "@/api/face-journal";
import {
  applyIn,
  bare,
  call,
  closeNotReceived,
  dispatchPrepared,
  latestAssertion,
  loyaltyRules,
  loyaltyWriteRequest,
  NOT_RECEIVED_AFTER_MS,
  operationIdOf,
  ownLoyaltySteps,
  proofContext,
  proveCanonical,
  proveReceipt,
  readMembership,
  settled,
  unavailable,
  unresolved,
  type LoyaltyResult,
} from "@/api/product-face-loyalty";
import { fail, type FaceOperationFailure } from "@/api/product-face-operations";
import type { FaceRequestContext } from "@/api/product-face-server";
import {
  SUBMITTABLE_STATES,
  type ActionReceipt,
  type CanonicalRead,
  type LoyaltyRules,
  type ProofContext,
} from "@/app/_domain/loyalty";
import {
  allocationBacksGrant,
  allocationPreimage,
  availabilityOf,
  BENEFIT_ID,
  bindingPreimage,
  isCurrent,
  nextChange,
  parseBenefitsRead,
  parseRedeemAnswer,
  parseRedemptionStatus,
  parseReferenceAnswer,
  redemptionInput,
  ruleProven,
  type Allocation,
  type BenefitsRead,
  type FailedAttempt,
  type LoyaltyBenefitsView,
  type LoyaltyRedemptionStatus,
  type LoyaltyRedemptionView,
  type NextActor,
  type RedemptionBinding,
  type RewardStatus,
  type VerifiedActivity,
} from "@/app/_domain/loyalty-benefits";
import {
  LOYALTY_REDEEM_OPERATION,
  preparedLoyaltyStep,
  type FaceJournalEntry,
} from "@/app/_domain/product-face-journal";
import { isOperationId } from "@/app/_domain/product-face";

// loyalty-benefit-redeem-v1 (docs/proposals/loyalty-benefit-redeem-v1.md):
// the member's side of benefits and one-time redemption, on the wallet BFF.
// The member only reads, requests and shows; the operator's grant, the
// verifier, the partner's confirmation and the settlement are Studio's own
// scoped role sessions and never wallet operations. Every Dual claim is
// re-proven from this request's own reads (§5); the programme's stock,
// terms, labels and validity are its APPLICATION records and are labelled.
// A request is the same durable prepare-then-dispatch as an activity
// (loyalty-join-earn-v1 §6), bound to the exact grant it redeems; its
// one-time reference is never journalled, logged or put in a URL.

const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HELD = ["Suspended", "Expired"];

/** The binding's Loyalty rules, only where it states the benefits extension. */
function benefitRules(context: FaceRequestContext): LoyaltyRules | null {
  const rules = loyaltyRules(context);
  return rules?.benefits ? rules : null;
}

const ownRedemptions = (context: FaceRequestContext) =>
  ownLoyaltySteps(context, LOYALTY_REDEEM_OPERATION);

/** Studio's allocation id of one grant intent (loyaltyAllocationId). */
const expectedAllocationId = (
  benefit: string,
  recordId: string,
  eventId: string,
) =>
  `alc_${sha256Hash(allocationPreimage(benefit, recordId, eventId)).slice(7, 39)}`;

const bindingHash = (binding: RedemptionBinding) =>
  sha256Hash(bindingPreimage(binding));

interface Chain {
  grant: ActionReceipt;
  allocation: Allocation;
  failedAttempts: FailedAttempt[];
  request?: ActionReceipt;
  confirmation?: ActionReceipt;
  fulfilment?: ActionReceipt;
  settlement?: ActionReceipt;
}

/** Every step after the grant, in order: earlier attempts, then the current. */
function stepsOf(chain: Chain): ActionReceipt[] | undefined {
  const current = [
    chain.request,
    chain.confirmation,
    chain.fulfilment,
    chain.settlement,
  ];
  // Each later step needs the one before it (a gap is never a chain).
  const present = current.findLastIndex(Boolean);
  if (current.slice(0, present + 1).some((step) => !step)) return undefined;
  return [
    ...chain.failedAttempts.flatMap((item) => [
      item.request,
      item.confirmation,
      item.failure,
    ]),
    ...(current.slice(0, present + 1) as ActionReceipt[]),
  ];
}

/**
 * §5 reward chain: the grant and its consumed allocation, then each present
 * step the very next change after the one before, every receipt proven:
 * each earlier attempt's request, confirmation and definitive failed
 * handover, then the current attempt's request, confirmation, handover and
 * settlement.
 */
async function proveChain(
  chain: Chain,
  canonical: CanonicalRead,
  proof: ProofContext,
  benefit: string,
) {
  const recordId = String(canonical.custom.recordId);
  const steps = stepsOf(chain);
  if (
    !steps ||
    !allocationBacksGrant(
      chain.allocation,
      chain.grant,
      canonical,
      benefit,
      expectedAllocationId(benefit, recordId, chain.allocation.eventId),
    ) ||
    !(await proveReceipt(chain.grant, canonical, proof, undefined, benefit))
  ) {
    return false;
  }
  let previous = chain.grant;
  for (const step of steps) {
    if (
      !nextChange(previous, step) ||
      !(await proveReceipt(step, canonical, proof, undefined, benefit))
    ) {
      return false;
    }
    previous = step;
  }
  return true;
}

/**
 * The reward's status from its PROVEN chain and the canonical's current
 * state: a step offered to the member is always the record's current one.
 * After a definitive failed handover the same reward is restored, until its
 * original validity only.
 */
function rewardStatus(
  chain: Chain & {
    validUntil: string;
    confirmationRecording: boolean;
    handoverRecording: boolean;
  },
  canonical: CanonicalRead,
  now: number,
): RewardStatus {
  if (chain.settlement) return "settled";
  if (chain.fulfilment) return "fulfilled";
  if (chain.confirmation) {
    return chain.handoverRecording ? "handover_recording" : "confirmed";
  }
  if (chain.request) {
    if (!isCurrent(chain.request, canonical)) return "not_redeemable";
    return chain.confirmationRecording ? "confirmation_recording" : "requested";
  }
  const failure = chain.failedAttempts.at(-1)?.failure;
  if (!isCurrent(failure ?? chain.grant, canonical)) return "not_redeemable";
  if (now >= Date.parse(chain.validUntil)) return "expired";
  return failure ? "restored" : "granted";
}

/**
 * §5 verified eligibility: distinct verified pairs, each a proven submission
 * of its evidence and a proven verification as the very next change, both
 * on this object. Proves only as many as the programme's own count needs.
 */
async function provenPairs(
  read: BenefitsRead,
  canonical: CanonicalRead,
  proof: ProofContext,
) {
  const targets = read.progress.filter(
    (rule) => rule.verified >= rule.requiredVerified,
  );
  const proven: VerifiedActivity[] = [];
  const used = new Set<string>();
  for (const pair of read.verified) {
    if (targets.every((rule) => ruleProven(rule, proven))) break;
    if (
      !targets.some(
        (rule) =>
          !ruleProven(rule, proven) &&
          rule.activityTypes.includes(pair.activityType),
      ) ||
      used.has(pair.submission.actionId) ||
      used.has(pair.verification.actionId) ||
      !nextChange(pair.submission, pair.verification) ||
      !(await proveReceipt(
        pair.submission,
        canonical,
        proof,
        pair.evidenceHash,
      )) ||
      !(await proveReceipt(pair.verification, canonical, proof))
    ) {
      continue;
    }
    used.add(pair.submission.actionId);
    used.add(pair.verification.actionId);
    proven.push(pair);
  }
  return proven;
}

type ProvenBenefits =
  | { ok: true; view: null; unconfirmed: boolean; journal: FaceJournal }
  | {
      ok: true;
      view: LoyaltyBenefitsView;
      unconfirmed: false;
      journal: FaceJournal;
      canonical: CanonicalRead;
      /** The current reward's exact binding, only when its chain proved. */
      binding: RedemptionBinding | null;
    };

/** §4.1 read and §5 proofs, for the holder's proven created membership. */
async function proveBenefits(
  context: FaceRequestContext,
  rules: LoyaltyRules,
): Promise<ProvenBenefits | FaceOperationFailure> {
  const membership = await readMembership(context, context.journal, rules);
  if (!membership.ok) return membership;
  const status = membership.proven.view.status;
  const created = membership.proven.canonical;
  if (!created || !["active", "held", "ended"].includes(status)) {
    return {
      ok: true,
      view: null,
      unconfirmed: false,
      journal: membership.journal,
    };
  }
  const called = await call(
    context,
    membership.journal,
    rules,
    "loyalty.benefits.read",
    operationIdOf("lrd"),
    created.objectId,
    {},
  );
  if (!called.ok) return bare(called.failure);
  const read = called.answer.reached
    ? parseBenefitsRead(
        called.answer.status,
        called.answer.body,
        rules.programmeId,
      )
    : undefined;
  if (!read) return unavailable();
  const proof = proofContext(context, rules);
  const canonical = read.canonical;
  const unconfirmed = {
    ok: true as const,
    view: null,
    unconfirmed: true,
    journal: called.journal,
  };
  if (
    canonical.objectId !== created.objectId ||
    !(await proveCanonical(canonical, proof))
  ) {
    return unconfirmed;
  }
  const state = String(canonical.custom.state);
  const held = HELD.includes(state);
  const now = Date.now();
  let reward: LoyaltyBenefitsView["reward"] = null;
  let binding: RedemptionBinding | null = null;
  if (read.reward) {
    const chainProven = await proveChain(
      read.reward,
      canonical,
      proof,
      read.reward.benefitId,
    );
    const status = chainProven
      ? rewardStatus(read.reward, canonical, now)
      : "unconfirmed";
    reward = {
      benefitId: read.reward.benefitId,
      status,
      validUntil: read.reward.validUntil,
      grantActionId: chainProven ? read.reward.grant.actionId : null,
      requestActionId:
        chainProven && read.reward.request
          ? read.reward.request.actionId
          : null,
      failedHandovers: chainProven ? read.reward.failedAttempts.length : 0,
    };
    if (chainProven) {
      binding = {
        revisionHash: read.programme.revisionHash,
        benefitId: read.reward.benefitId,
        grantActionId: read.reward.grant.actionId,
        allocationId: read.reward.allocation.allocationId,
      };
    }
  }
  const proven = await provenPairs(read, canonical, proof);
  const benefits = read.benefits.map((benefit) => {
    const rulesOf = read.progress.filter((rule) =>
      rule.benefitIds.includes(benefit.benefitId),
    );
    const counted = rulesOf.some(
      (rule) => rule.verified >= rule.requiredVerified,
    );
    const status =
      reward?.benefitId === benefit.benefitId
        ? reward.status
        : benefit.redeemedBefore
          ? ("already_redeemed" as const)
          : counted && rulesOf.some((rule) => ruleProven(rule, proven))
            ? ("eligible" as const)
            : counted
              ? ("eligible_unconfirmed" as const)
              : ("locked" as const);
    return {
      benefitId: benefit.benefitId,
      title: benefit.title,
      description: benefit.description,
      terms: benefit.terms,
      partnerName: benefit.partner?.name ?? null,
      validDays: benefit.validDays,
      status,
      availability: availabilityOf(benefit.stock),
    };
  });
  const next: NextActor | null = held
    ? "programme_team"
    : state === "Activity pending"
      ? "verifier"
      : state === "Activity verified"
        ? benefits.some(
            (item) =>
              item.status === "eligible" && item.availability === "available",
          )
          ? "programme_team"
          : null
        : state === "Benefit eligible"
          ? reward?.status === "granted"
            ? null
            : "programme_team"
          : state === "Redemption pending" || state === "Redeemed"
            ? "partner"
            : state === "Fulfilled"
              ? "settlement"
              : null;
  // A restored reward needs a unit to hand over again: never offered when
  // the programme says none is available (its refusal would write nothing).
  const restoredOffer =
    reward?.status === "restored" &&
    benefits.some(
      (item) =>
        item.benefitId === reward?.benefitId &&
        item.availability !== "unavailable",
    );
  return {
    ok: true,
    unconfirmed: false,
    journal: called.journal,
    canonical,
    binding,
    view: {
      state,
      held,
      progress: read.progress.map((rule) => ({
        ruleId: rule.ruleId,
        label: rule.label,
        requiredVerified: rule.requiredVerified,
        verified: rule.verified,
        pendingVerification: rule.pendingVerification,
        benefitIds: rule.benefitIds,
      })),
      benefits,
      reward,
      actions: {
        submitActivity: !held && SUBMITTABLE_STATES.includes(state),
        requestRedemption:
          !held && (reward?.status === "granted" || restoredOffer),
        showReference: !held && reward?.status === "requested",
      },
      next,
    },
  };
}

/** §4.1: the proven benefits view and this wallet's own requests. */
export async function readBenefits(context: FaceRequestContext): Promise<
  LoyaltyResult<{
    benefits: LoyaltyBenefitsView | null;
    unconfirmed: boolean;
    redemptions: Array<{ operationId: string; benefitId: string }>;
  }>
> {
  const rules = benefitRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const proven = await proveBenefits(context, rules);
  if (!proven.ok) return proven;
  return {
    ok: true,
    benefits: proven.view,
    unconfirmed: proven.unconfirmed,
    // Listed only: each status is proven by its own status read.
    redemptions: ownRedemptions(context).map((entry) => ({
      operationId: entry.operationId,
      benefitId: entry.benefitId as string,
    })),
  };
}

const view = (
  entry: { operationId: string; benefitId?: string },
  status: LoyaltyRedemptionStatus,
): LoyaltyRedemptionView => ({
  operationId: entry.operationId,
  benefitId: entry.benefitId as string,
  status,
});

/**
 * §7 prepare: the member's confirmed request for exactly the proven,
 * current, unexpired grant they saw, journalled with its binding and request
 * hashes and returned to the browser. Nothing is sent.
 */
export async function prepareRedemption(
  context: FaceRequestContext,
  benefitId: unknown,
  grantActionId: unknown,
): Promise<
  LoyaltyResult<{
    prepared: {
      operationId: string;
      benefitId: string;
      binding: ReturnType<typeof redemptionInput>;
    };
  }>
> {
  const rules = benefitRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (
    typeof benefitId !== "string" ||
    !BENEFIT_ID.test(benefitId) ||
    typeof grantActionId !== "string" ||
    !ACTION_ID.test(grantActionId)
  ) {
    return fail("invalid_request", 400);
  }
  const proven = await proveBenefits(context, rules);
  if (!proven.ok) return proven;
  if (
    !proven.view ||
    !proven.binding ||
    !proven.view.actions.requestRedemption ||
    proven.binding.benefitId !== benefitId ||
    proven.binding.grantActionId !== grantActionId
  ) {
    return fail("loyalty_redemption_not_permitted", 409);
  }
  const binding = proven.binding;
  const hash = bindingHash(binding);
  // One unresolved request per grant: never a second for the same value.
  if (
    ownRedemptions(context).some(
      (entry) => unresolved(entry) && entry.evidenceHash === hash,
    )
  ) {
    return fail("redemption_in_progress", 409);
  }
  const operationId = operationIdOf("loy");
  const objectId = proven.canonical.objectId;
  const { requestHash } = loyaltyWriteRequest(
    rules,
    LOYALTY_REDEEM_OPERATION,
    operationId,
    objectId,
    redemptionInput(binding),
  );
  let journal: FaceJournal | FaceOperationFailure = applyIn(proven.journal, {
    kind: "begin",
    entry: {
      operationId,
      kind: "loyalty",
      operation: LOYALTY_REDEEM_OPERATION,
      slug: context.binding.slug,
      programmeId: context.binding.programmeId,
      objectId,
      evidenceHash: hash,
      benefitId: binding.benefitId,
      requestHash,
    },
  });
  if ("entries" in journal) {
    journal = applyIn(journal, { kind: "confirm", operationId, objectId });
  }
  if (!("entries" in journal)) return bare(journal);
  return {
    ok: true,
    journal,
    prepared: {
      operationId,
      benefitId: binding.benefitId,
      binding: redemptionInput(binding),
    },
  };
}

function parseInputBinding(
  value: Record<string, unknown>,
): RedemptionBinding | undefined {
  return typeof value.benefit_id === "string" &&
    BENEFIT_ID.test(value.benefit_id) &&
    typeof value.grant_action_id === "string" &&
    ACTION_ID.test(value.grant_action_id) &&
    typeof value.allocation_id === "string" &&
    /^alc_[0-9a-f]{32}$/.test(value.allocation_id) &&
    typeof value.revision_hash === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value.revision_hash)
    ? {
        benefitId: value.benefit_id,
        grantActionId: value.grant_action_id,
        allocationId: value.allocation_id,
        revisionHash: value.revision_hash,
      }
    : undefined;
}

/** The answer's own chain names exactly the journalled grant, for this record. */
async function provenRequest(
  context: FaceRequestContext,
  rules: LoyaltyRules,
  entry: FaceJournalEntry,
  binding: RedemptionBinding,
  canonical: CanonicalRead,
  chain: Chain,
) {
  const proof = proofContext(context, rules);
  return (
    canonical.objectId === entry.objectId &&
    chain.grant.actionId === binding.grantActionId &&
    chain.allocation.allocationId === binding.allocationId &&
    chain.allocation.benefitId === binding.benefitId &&
    (await proveCanonical(canonical, proof)) &&
    (await proveChain(chain, canonical, proof, binding.benefitId))
  );
}

/**
 * §7 submit: dispatch exactly the prepared request of THIS launch, once.
 * Whatever happens after it may have left, it is `unknown` with the issued
 * journal, and only ever read back.
 */
export async function submitRedemption(
  context: FaceRequestContext,
  operationId: unknown,
  body: Record<string, unknown>,
): Promise<LoyaltyResult<{ redemption: LoyaltyRedemptionView }>> {
  const rules = benefitRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const binding = parseInputBinding(body);
  if (!isOperationId(operationId) || !binding) {
    return fail("invalid_request", 400);
  }
  const entry = context.journal.entries.find(
    (item) => item.operationId === operationId,
  );
  if (
    !entry ||
    entry.kind !== "loyalty" ||
    entry.operation !== LOYALTY_REDEEM_OPERATION ||
    entry.slug !== context.binding.slug
  ) {
    return fail("unknown_operation", 404);
  }
  if (!preparedLoyaltyStep(entry)) {
    return fail("operation_already_submitted", 409);
  }
  const hash = bindingHash(binding);
  const write = loyaltyWriteRequest(
    rules,
    LOYALTY_REDEEM_OPERATION,
    operationId,
    entry.objectId,
    redemptionInput(binding),
  );
  // Exactly the grant the member confirmed, and exactly its request.
  if (
    entry.evidenceHash !== hash ||
    entry.benefitId !== binding.benefitId ||
    entry.requestHash !== write.requestHash
  ) {
    return fail("operation_conflict", 409);
  }
  const called = await dispatchPrepared(
    context,
    rules,
    entry,
    LOYALTY_REDEEM_OPERATION,
    write,
    (item) => item.evidenceHash === hash,
    "redemption_in_progress",
  );
  if (!called.ok) return called.failure;
  const journal = called.journal;
  const unknown = {
    ok: true as const,
    journal,
    redemption: view(entry, "unknown"),
  };
  try {
    if (!called.answer.reached) return unknown;
    const answer = parseRedeemAnswer(called.answer.status, called.answer.body);
    if (answer.kind === "unknown") return unknown;
    if (answer.kind === "refused") {
      // Exact zero-write accounting for exactly this reason: nothing written.
      return {
        ...fail(answer.reason, 409),
        journal: settled(journal, operationId, "not_submitted"),
      };
    }
    const proven =
      isCurrent(answer.request, answer.canonical) &&
      (await provenRequest(context, rules, entry, binding, answer.canonical, {
        grant: answer.grant,
        allocation: answer.allocation,
        failedAttempts: answer.failedAttempts,
        request: answer.request,
      }));
    return proven
      ? {
          ok: true,
          journal: settled(journal, operationId, "registered"),
          redemption: view(entry, "requested"),
        }
      : { ok: true, journal, redemption: view(entry, "unconfirmed") };
  } catch {
    // Thrown after a possible dispatch: the issued journal still goes back.
    return unknown;
  }
}

/**
 * §4.3: the read-only status of exactly one of this wallet's own requests,
 * under its original operation. Never requests again. The journal is
 * written only when this launch's own entry is closed by the read.
 */
export async function redemptionStatus(
  context: FaceRequestContext,
  operationId: unknown,
): Promise<LoyaltyResult<{ redemption: LoyaltyRedemptionView }>> {
  const rules = benefitRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const entry = ownRedemptions(context).find(
    (item) => item.operationId === operationId,
  );
  if (!entry || !entry.evidenceHash || !entry.benefitId || !entry.requestHash) {
    return fail("unknown_operation", 404);
  }
  const called = await call(
    context,
    context.journal,
    rules,
    "loyalty.redemption.status",
    entry.operationId,
    entry.objectId,
    {},
  );
  if (!called.ok) return bare(called.failure);
  let journal: FaceJournal | undefined;
  const result = (status: LoyaltyRedemptionStatus) => ({
    ok: true as const,
    ...(journal ? { journal } : {}),
    redemption: view(entry, status),
  });
  if (!called.answer.reached) return result("unknown");
  const answer = parseRedemptionStatus(
    called.answer.status,
    called.answer.body,
    { operationId: entry.operationId, requestHash: entry.requestHash },
  );
  if (answer.kind === "unknown") return result("unknown");
  // Another operation's record, however exact its grant, is not this one's.
  if (answer.kind === "foreign") return result("unconfirmed");
  if (answer.kind === "not_received") {
    if (Date.now() - latestAssertion(entry) <= NOT_RECEIVED_AFTER_MS) {
      return result("unknown");
    }
    journal = closeNotReceived(called.journal, entry);
    return result("not_received");
  }
  // Exactly the grant this operation was prepared for, by its binding hash.
  if (
    bindingHash(answer.binding) !== entry.evidenceHash ||
    answer.binding.benefitId !== entry.benefitId ||
    !(await provenRequest(
      context,
      rules,
      entry,
      answer.binding,
      answer.canonical,
      answer.chain,
    ))
  ) {
    return result("unconfirmed");
  }
  const registered = settled(called.journal, entry.operationId, "registered");
  if (registered !== called.journal) journal = registered;
  // This operation's own attempt: an earlier one a definitive failure
  // ended, or the current one at its proven step.
  return result(
    answer.kind === "fulfilment_failed"
      ? "fulfilment_failed"
      : answer.chain.settlement
        ? "settled"
        : answer.chain.fulfilment
          ? "fulfilled"
          : answer.chain.confirmation
            ? answer.chain.handoverRecording
              ? "handover_recording"
              : "confirmed"
            : answer.kind === "confirmation_recording"
              ? "confirmation_recording"
              : "requested",
  );
}

/**
 * §4.4: the member's one-time reference for the CURRENT request, on the
 * member's own explicit action. Proven current; never journalled, logged or
 * kept; the same request always shows the same reference.
 */
export async function showReference(
  context: FaceRequestContext,
  requestActionId: unknown,
): Promise<
  LoyaltyResult<{ reference: { code: string; requestActionId: string } }>
> {
  const rules = benefitRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (typeof requestActionId !== "string" || !ACTION_ID.test(requestActionId)) {
    return fail("invalid_request", 400);
  }
  const membership = await readMembership(context, context.journal, rules);
  if (!membership.ok) return membership;
  const created = membership.proven.canonical;
  if (!created || membership.proven.view.status !== "active") {
    return fail("loyalty_redemption_not_current", 409);
  }
  const called = await call(
    context,
    membership.journal,
    rules,
    "loyalty.redemption.reference",
    operationIdOf("lrd"),
    created.objectId,
    { request_action_id: requestActionId },
  );
  if (!called.ok) return bare(called.failure);
  const answer = called.answer.reached
    ? parseReferenceAnswer(called.answer.status, called.answer.body)
    : ({ kind: "unknown" } as const);
  if (answer.kind === "not_current") {
    return fail("loyalty_redemption_not_current", 409);
  }
  if (answer.kind === "unknown") return unavailable();
  const proof = proofContext(context, rules);
  const benefit = answer.allocation.benefitId;
  const current =
    answer.canonical.objectId === created.objectId &&
    answer.request.actionId === requestActionId &&
    isCurrent(answer.request, answer.canonical) &&
    (await proveCanonical(answer.canonical, proof)) &&
    (await proveChain(
      {
        grant: answer.grant,
        allocation: answer.allocation,
        failedAttempts: answer.failedAttempts,
        request: answer.request,
      },
      answer.canonical,
      proof,
      benefit,
    ));
  if (!current) return fail("loyalty_redemption_not_current", 409);
  return {
    ok: true,
    reference: { code: answer.reference, requestActionId },
  };
}
