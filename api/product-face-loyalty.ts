import "server-only";

import { randomBytes } from "node:crypto";
import { sha256Hash } from "@/api/face-assertion";
import { readFaceLoyaltyHistory, type FaceJournal } from "@/api/face-journal";
import { loyaltyRuntimeCall, runtimeRequestHash } from "@/api/face-runtime";
import {
  firstStateChange,
  ownPass,
  publicAction,
  publicObject,
  publicStateChange,
} from "@/api/loyalty-provider";
import {
  claimIssue,
  fail,
  journalStatus,
  mint,
  type FaceOperationFailure,
  type FaceOperationResult,
} from "@/api/product-face-operations";
import type { FaceRequestContext } from "@/api/product-face-server";
import { loyaltyServedBy } from "@/api/wallet-host";
import {
  ACTIVITY_TYPE,
  checkCanonical,
  checkPass,
  checkReceipt,
  lifecycleStatus,
  parseJoinAnswer,
  parseMembershipAnswer,
  parseProgrammeRead,
  parseStatusAnswer,
  parseSubmitAnswer,
  SUBMITTABLE_STATES,
  validEvidenceRef,
  verificationFollows,
  writtenCustomPreimage,
  type ActionReceipt,
  type CanonicalRead,
  type LoyaltyHostOperation,
  type LoyaltyJoinRecord,
  type LoyaltyMembershipView,
  type LoyaltyProgramme,
  type LoyaltyRules,
  type LoyaltySubmissionStatus,
  type LoyaltySubmissionView,
  type MembershipAnswer,
  type ProofContext,
} from "@/app/_domain/loyalty";
import {
  applyJournalTransition,
  LOYALTY_DISPATCH_WINDOW_MS,
  LOYALTY_REDEEM_OPERATION,
  LOYALTY_SUBMIT_OPERATION,
  loyaltySubmission,
  preparedLoyaltyStep,
  type FaceJournalEntry,
  type JournalTransition,
} from "@/app/_domain/product-face-journal";
import {
  isOperationId,
  type RegistrationStatus,
} from "@/app/_domain/product-face";

// loyalty-join-earn-v1 (docs/proposals/loyalty-join-earn-v1.md): the wallet
// BFF side of a member's native join and earn. Every runtime call is one
// server-to-server request with a one-time, operation-bound face assertion;
// the holder is always the session's. Nothing is said about Dual that this
// request did not prove from a fresh read (§5).
//
// A submission is two requests (§6). `prepare` journals the operation, its
// evidence hash and its exact request hash and returns that journal to the
// browser; nothing is sent. Only then does `submit` dispatch exactly that
// prepared operation, once. Its answer may be lost whole (Set-Cookie too):
// the browser still holds the prepared journal, so the original operation
// is found again and only ever read back, never sent again.
//
// Only a transition that changes a submission writes the launch journal.
// A read's or a join's mint never leaves the BFF, and a slower read's
// cookie must never overwrite a newer prepared one.

/** The binding's Loyalty rules where this host serves them; else none. */
export function loyaltyRules(context: FaceRequestContext): LoyaltyRules | null {
  const rules = context.binding.loyalty;
  return rules && loyaltyServedBy(context.binding) ? rules : null;
}

export const operationIdOf = (prefix: "loy" | "lrd") =>
  `${prefix}-${randomBytes(12).toString("hex")}`;
const HASH = /^sha256:[0-9a-f]{64}$/;
/** §6: a `not_received` counts only once the original assertion expired. */
export const NOT_RECEIVED_AFTER_MS = 120_000;

export function proofContext(
  context: FaceRequestContext,
  rules: LoyaltyRules,
): ProofContext {
  return {
    rules,
    clientId: context.state.organizationId,
    // Studio's memberReference: sha256 of the member's own Dual wallet id.
    expectedMember: sha256Hash(context.wallet.id),
    holder: context.holder,
  };
}

export type Answer =
  { reached: true; status: number; body: unknown } | { reached: false };
type Called =
  | { ok: false; failure: FaceOperationFailure }
  | { ok: true; journal: FaceJournal; answer: Answer };

/** One minted, operation-bound call to the bound Loyalty runtime. */
export async function call(
  context: FaceRequestContext,
  journal: FaceJournal,
  rules: LoyaltyRules,
  operation: LoyaltyHostOperation,
  operationId: string,
  objectId: string | null,
  input: Record<string, unknown>,
  dispatch?: (journal: FaceJournal) => FaceJournal | FaceOperationFailure,
): Promise<Called> {
  const target = objectId
    ? { model_id: rules.modelId, object_id: objectId }
    : { model_id: rules.modelId };
  const minted = mint(context, context.request, journal, {
    operation,
    operationId,
    target,
    requestHash: runtimeRequestHash({ operation, operationId, target, input }),
  });
  if (!minted.ok) return { ok: false, failure: minted };
  let next = minted.journal;
  // A write is journalled after its assertion exists and before it leaves.
  if (dispatch) {
    const written = dispatch(next);
    if ("ok" in written && written.ok === false) {
      return { ok: false, failure: { ...written, journal: next } };
    }
    next = written as FaceJournal;
  }
  const answer = await loyaltyRuntimeCall(
    context.binding,
    { operation, operationId, target, input },
    minted.assertion,
  );
  return { ok: true, journal: next, answer };
}

export function applyIn(
  journal: FaceJournal,
  transition: JournalTransition,
): FaceJournal | FaceOperationFailure {
  const result = applyJournalTransition(
    journal.entries,
    transition,
    Date.now(),
  );
  return result.ok
    ? { ...journal, entries: result.entries }
    : fail(result.error, journalStatus[result.error]);
}

export const unavailable = () => fail("runtime_unavailable", 502);
/** A failure to the browser without this request's journal. */
export const bare = ({ code, status }: FaceOperationFailure) =>
  fail(code, status);

// ------------------------------------------------------------- proofs

export async function proveCanonical(
  canonical: CanonicalRead,
  proof: ProofContext,
) {
  return (
    checkCanonical(canonical, await publicObject(canonical.objectId), proof) ===
    null
  );
}

export async function proveReceipt(
  receipt: ActionReceipt,
  canonical: CanonicalRead,
  proof: ProofContext,
  evidenceHash?: string,
  benefitId?: string,
) {
  const action = await publicAction(receipt.actionId);
  const affected = action?.affected.find(
    (item) => item.id === canonical.objectId,
  );
  const change = affected
    ? await publicStateChange(canonical.objectId, affected.stateChangeId)
    : undefined;
  return (
    checkReceipt(
      receipt,
      canonical,
      proof,
      {
        writtenHashMatches:
          sha256Hash(writtenCustomPreimage(receipt)) ===
          receipt.writtenCustomHash,
        action,
        change,
      },
      evidenceHash,
      benefitId,
    ) === null
  );
}

type Proven =
  | { ok: true; view: LoyaltyMembershipView; canonical?: CanonicalRead }
  | { ok: false; code: "session_expired" };

/** §5 Active (and the states before it), from this request's own reads. */
async function proveMembership(
  context: FaceRequestContext,
  proof: ProofContext,
  answer: MembershipAnswer,
): Promise<Proven> {
  switch (answer.status) {
    case "none":
      return { ok: true, view: { status: "none" } };
    case "pending_approval":
    case "declined":
    case "pending_creation":
      return {
        ok: true,
        view: { status: answer.status, join: answer.join },
      };
    default:
      break;
  }
  const { canonical, opening } = answer;
  const unconfirmed: Proven = { ok: true, view: { status: "unconfirmed" } };
  if (
    !(await proveCanonical(canonical, proof)) ||
    !(await proveReceipt(opening, canonical, proof))
  ) {
    return unconfirmed;
  }
  if (answer.status === "pending_pass") {
    return { ok: true, view: { status: "pending_pass" } };
  }
  if (lifecycleStatus(canonical) !== answer.status) return unconfirmed;
  const read = await ownPass(
    context.state.accessToken,
    context.holder,
    proof.rules.passTemplateId,
    answer.pass.objectId,
  );
  if (!read.ok) {
    // A refused, failed or ambiguous read proves no absence either.
    return read.code === "session_expired"
      ? { ok: false, code: read.code }
      : unconfirmed;
  }
  // Created, and the exact read says the holder does not hold its pass (yet).
  if (!read.pass) return { ok: true, view: { status: "pending_pass" } };
  const mintChange = await firstStateChange(read.pass.id);
  const passMint =
    mintChange && mintChange.actionName === "mint"
      ? await publicAction(mintChange.actionId)
      : undefined;
  if (
    checkPass(read.pass, answer.pass, canonical, opening, proof, passMint) !==
    null
  ) {
    return unconfirmed;
  }
  return {
    ok: true,
    canonical,
    view: {
      status: answer.status,
      membership: {
        objectId: canonical.objectId,
        state: String(canonical.custom.state),
        recordedAt: canonical.readAt,
      },
    },
  };
}

// --------------------------------------------------------- transitions

export type LoyaltyResult<T> = FaceOperationResult<T>;

/** §4.1: the bound programme's member-facing content. */
export async function readProgramme(
  context: FaceRequestContext,
): Promise<LoyaltyResult<{ programme: LoyaltyProgramme }>> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const called = await call(
    context,
    context.journal,
    rules,
    "loyalty.programme.read",
    operationIdOf("lrd"),
    null,
    {},
  );
  if (!called.ok) return bare(called.failure);
  const { answer } = called;
  const programme =
    answer.reached && answer.status === 200
      ? parseProgrammeRead(answer.body, rules)
      : undefined;
  return programme ? { ok: true, programme } : unavailable();
}

const CONSENT_KEYS = ["accepted", "terms_version", "fingerprint"];

/**
 * §4.2: the member's own consent to the terms they were shown. A programme
 * record only: it writes nothing to Dual, and every answer says so.
 */
export async function requestJoin(
  context: FaceRequestContext,
  consent: unknown,
): Promise<LoyaltyResult<{ join: LoyaltyJoinRecord }>> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (
    !consent ||
    typeof consent !== "object" ||
    Array.isArray(consent) ||
    Object.keys(consent).length !== CONSENT_KEYS.length ||
    !CONSENT_KEYS.every((key) => Object.hasOwn(consent, key))
  ) {
    return fail("invalid_request", 400);
  }
  const given = consent as Record<string, unknown>;
  if (given.accepted !== true) return fail("consent_required", 400);
  if (
    typeof given.terms_version !== "string" ||
    !given.terms_version ||
    given.terms_version.length > 64 ||
    typeof given.fingerprint !== "string" ||
    !HASH.test(given.fingerprint)
  ) {
    return fail("invalid_request", 400);
  }
  const called = await call(
    context,
    context.journal,
    rules,
    "loyalty.join.request",
    operationIdOf("lrd"),
    null,
    {
      consent: {
        accepted: true,
        terms_version: given.terms_version,
        fingerprint: given.fingerprint,
      },
    },
  );
  if (!called.ok) return bare(called.failure);
  const { answer } = called;
  const parsed = answer.reached
    ? parseJoinAnswer(answer.status, answer.body)
    : undefined;
  if (!parsed) return unavailable();
  return parsed.ok ? { ok: true, join: parsed.join } : fail(parsed.reason, 409);
}

/**
 * This wallet's own Loyalty steps of one operation (an activity submission,
 * or a redemption request) for this programme, prepared or sent, here and in
 * other launches (a reload, a sign-in since).
 */
export function ownLoyaltySteps(
  context: FaceRequestContext,
  operation: typeof LOYALTY_SUBMIT_OPERATION | typeof LOYALTY_REDEEM_OPERATION,
) {
  const seen = new Set<string>();
  return [
    ...context.journal.entries,
    ...readFaceLoyaltyHistory(context.request, context.scope),
  ].filter((entry) => {
    if (
      !loyaltySubmission(entry) ||
      entry.operation !== operation ||
      // A refused or never-received submission wrote nothing: not listed.
      entry.status === "not_submitted" ||
      entry.slug !== context.binding.slug ||
      seen.has(entry.operationId)
    ) {
      return false;
    }
    seen.add(entry.operationId);
    return true;
  });
}

const ownSubmissions = (context: FaceRequestContext) =>
  ownLoyaltySteps(context, LOYALTY_SUBMIT_OPERATION);

/** Possibly sent and its outcome not proven: prepared, or issued and open. */
export const unresolved = (entry: FaceJournalEntry) =>
  preparedLoyaltyStep(entry) || entry.phase === "assertion_issued";

/** The one exact runtime request a Loyalty write is, bound at prepare. */
export function loyaltyWriteRequest(
  rules: LoyaltyRules,
  operation: typeof LOYALTY_SUBMIT_OPERATION | typeof LOYALTY_REDEEM_OPERATION,
  operationId: string,
  objectId: string,
  input: Record<string, unknown>,
) {
  const target = { model_id: rules.modelId, object_id: objectId };
  return {
    input,
    requestHash: runtimeRequestHash({ operation, operationId, target, input }),
  };
}

const submitRequest = (
  rules: LoyaltyRules,
  operationId: string,
  objectId: string,
  activityType: string,
  evidenceRef: string,
) =>
  loyaltyWriteRequest(rules, LOYALTY_SUBMIT_OPERATION, operationId, objectId, {
    activity_type: activityType,
    evidence_ref: evidenceRef,
  });

/**
 * §6: dispatch exactly one prepared Loyalty write of THIS launch, once,
 * within its window: never past it (its latest possible assertion stays
 * bounded), never while another unresolved step of the same value exists,
 * never twice on this instance. Its issue is journalled before it leaves.
 */
export async function dispatchPrepared(
  context: FaceRequestContext,
  rules: LoyaltyRules,
  entry: FaceJournalEntry,
  operation: typeof LOYALTY_SUBMIT_OPERATION | typeof LOYALTY_REDEEM_OPERATION,
  write: { input: Record<string, unknown>; requestHash: string },
  sameValue: (item: FaceJournalEntry) => boolean,
  inProgress: "submission_in_progress" | "redemption_in_progress",
): Promise<
  | { ok: false; failure: FaceOperationFailure }
  | { ok: true; journal: FaceJournal; answer: Answer }
> {
  if (Date.now() - entry.createdAt > LOYALTY_DISPATCH_WINDOW_MS) {
    return { ok: false, failure: fail("submission_window_closed", 409) };
  }
  if (
    ownLoyaltySteps(context, operation).some(
      (item) =>
        item.operationId !== entry.operationId &&
        unresolved(item) &&
        sameValue(item),
    ) ||
    // The same-instance double-submit damper (not idempotency, §6).
    !claimIssue(
      `${context.owner.sidHash}:${context.scope.launchId}:${entry.operationId}`,
      Date.now(),
    )
  ) {
    return { ok: false, failure: fail(inProgress, 409) };
  }
  const called = await call(
    context,
    context.journal,
    rules,
    operation,
    entry.operationId,
    entry.objectId,
    write.input,
    (minted) =>
      applyIn(minted, {
        kind: "issue",
        operationId: entry.operationId,
        objectId: entry.objectId,
        requestHash: write.requestHash,
      }),
  );
  // Nothing was dispatched by this request.
  if (!called.ok) return { ok: false, failure: bare(called.failure) };
  return { ok: true, journal: called.journal, answer: called.answer };
}

export async function readMembership(
  context: FaceRequestContext,
  journal: FaceJournal,
  rules: LoyaltyRules,
): Promise<
  | { ok: true; journal: FaceJournal; proven: Extract<Proven, { ok: true }> }
  | FaceOperationFailure
> {
  const called = await call(
    context,
    journal,
    rules,
    "loyalty.membership.read",
    operationIdOf("lrd"),
    null,
    {},
  );
  if (!called.ok) return bare(called.failure);
  const parsed =
    called.answer.reached && called.answer.status === 200
      ? parseMembershipAnswer(called.answer.body)
      : undefined;
  if (!parsed) return unavailable();
  const proven = await proveMembership(
    context,
    proofContext(context, rules),
    parsed,
  );
  if (!proven.ok) return fail("session_expired", 401);
  return { ok: true, journal: called.journal, proven };
}

/** §4.3: the membership as proven now, and this wallet's own submissions. */
export async function readMembershipView(context: FaceRequestContext): Promise<
  LoyaltyResult<{
    membership: LoyaltyMembershipView;
    submissions: Array<{ operationId: string; activityType: string }>;
    benefits: boolean;
  }>
> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const read = await readMembership(context, context.journal, rules);
  if (!read.ok) return read;
  return {
    ok: true,
    membership: read.proven.view,
    // Whether this binding states loyalty-benefit-redeem-v1.
    benefits: Boolean(rules.benefits),
    // Listed only: each status is proven by its own status read.
    submissions: ownSubmissions(context).map((entry) => ({
      operationId: entry.operationId,
      activityType: entry.activityType as string,
    })),
  };
}

const submissionView = (
  entry: { operationId: string; activityType?: string },
  status: LoyaltySubmissionStatus,
): LoyaltySubmissionView => ({
  operationId: entry.operationId,
  activityType: entry.activityType as string,
  status,
});

export function settled(
  journal: FaceJournal,
  operationId: string,
  status: RegistrationStatus,
) {
  const own = journal.entries.find(
    (entry) => entry.operationId === operationId,
  );
  if (!own || own.phase === "settled") return journal;
  const next = applyIn(journal, { kind: "settle", operationId, status });
  return "entries" in next ? next : journal;
}

function validActivity(activityType: unknown, evidenceRef: unknown) {
  return (
    typeof activityType === "string" &&
    ACTIVITY_TYPE.test(activityType) &&
    validEvidenceRef(evidenceRef)
  );
}

/**
 * §4.4, step one: the member's confirmed submission, for the holder's proven
 * active membership, journalled with its exact request hash and returned to
 * the browser. Nothing is sent: this journal is what lets a lost submit
 * answer be found again. One unresolved attempt per evidence.
 */
export async function prepareActivity(
  context: FaceRequestContext,
  activityType: unknown,
  evidenceRef: unknown,
): Promise<
  LoyaltyResult<{ prepared: { operationId: string; activityType: string } }>
> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (!validActivity(activityType, evidenceRef)) {
    return fail("invalid_request", 400);
  }
  const type = activityType as string;
  const evidence = evidenceRef as string;
  const evidenceHash = sha256Hash(evidence);
  if (
    ownSubmissions(context).some(
      (entry) => unresolved(entry) && entry.evidenceHash === evidenceHash,
    )
  ) {
    return fail("submission_in_progress", 409);
  }
  // Fresh proof that this holder's membership is active, now.
  const membership = await readMembership(context, context.journal, rules);
  if (!membership.ok) return bare(membership);
  const canonical = membership.proven.canonical;
  if (membership.proven.view.status !== "active" || !canonical) {
    return fail("membership_not_active", 409);
  }
  // Never from a state where it would strand an unspent reward or a pending
  // settlement, or that the lifecycle refuses (benefit-redeem §2 (3), §6).
  if (!SUBMITTABLE_STATES.includes(String(canonical.custom.state))) {
    return fail("loyalty_activity_not_permitted", 409);
  }
  const operationId = operationIdOf("loy");
  const { requestHash } = submitRequest(
    rules,
    operationId,
    canonical.objectId,
    type,
    evidence,
  );
  let journal: FaceJournal | FaceOperationFailure = applyIn(
    membership.journal,
    {
      kind: "begin",
      entry: {
        operationId,
        kind: "loyalty",
        operation: LOYALTY_SUBMIT_OPERATION,
        slug: context.binding.slug,
        programmeId: context.binding.programmeId,
        objectId: canonical.objectId,
        evidenceHash,
        activityType: type,
        requestHash,
      },
    },
  );
  if ("entries" in journal) {
    journal = applyIn(journal, {
      kind: "confirm",
      operationId,
      objectId: canonical.objectId,
    });
  }
  if (!("entries" in journal)) return bare(journal);
  return {
    ok: true,
    journal,
    prepared: { operationId, activityType: type },
  };
}

/**
 * §4.4, step two: dispatch exactly the prepared operation of THIS launch,
 * once, within its window. Whatever happens after it may have left (a lost
 * or unprovable reply, a thrown error), the answer is `unknown` with the
 * issued journal; it is never sent again.
 */
export async function submitActivity(
  context: FaceRequestContext,
  operationId: unknown,
  activityType: unknown,
  evidenceRef: unknown,
): Promise<LoyaltyResult<{ submission: LoyaltySubmissionView }>> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (
    !isOperationId(operationId) ||
    !validActivity(activityType, evidenceRef)
  ) {
    return fail("invalid_request", 400);
  }
  const type = activityType as string;
  const evidence = evidenceRef as string;
  const evidenceHash = sha256Hash(evidence);
  const entry = context.journal.entries.find(
    (item) => item.operationId === operationId,
  );
  if (
    !entry ||
    entry.kind !== "loyalty" ||
    entry.slug !== context.binding.slug
  ) {
    return fail("unknown_operation", 404);
  }
  // Issued, settled or lapsed: authority already left, or never will.
  if (!preparedLoyaltyStep(entry)) {
    return fail("operation_already_submitted", 409);
  }
  const { input, requestHash } = submitRequest(
    rules,
    operationId,
    entry.objectId,
    type,
    evidence,
  );
  // Exactly the request the member confirmed: same evidence, type, target.
  if (
    entry.evidenceHash !== evidenceHash ||
    entry.activityType !== type ||
    entry.requestHash !== requestHash
  ) {
    return fail("operation_conflict", 409);
  }
  const called = await dispatchPrepared(
    context,
    rules,
    entry,
    LOYALTY_SUBMIT_OPERATION,
    { input, requestHash },
    (item) => item.evidenceHash === evidenceHash,
    "submission_in_progress",
  );
  if (!called.ok) return called.failure;
  const journal = called.journal;
  const view = submissionView({ operationId, activityType: type }, "unknown");
  const unknown = { ok: true as const, journal, submission: view };
  try {
    if (!called.answer.reached) return unknown;
    const answer = parseSubmitAnswer(called.answer.status, called.answer.body);
    // Anything but an exact listed refusal (a runtime that already holds
    // this operation answers operation_already_received) stays unknown.
    if (answer.kind === "unknown") return unknown;
    if (answer.kind === "refused") {
      // Exact zero-write accounting for exactly this reason: nothing written.
      return {
        ...fail(answer.reason, 409),
        journal: settled(journal, operationId, "not_submitted"),
      };
    }
    const proof = proofContext(context, rules);
    const proven =
      answer.submission.evidenceHash === evidenceHash &&
      answer.submission.activityType === type &&
      answer.canonical.objectId === entry.objectId &&
      (await proveCanonical(answer.canonical, proof)) &&
      (await proveReceipt(
        answer.action,
        answer.canonical,
        proof,
        evidenceHash,
      ));
    return proven
      ? {
          ok: true,
          journal: settled(journal, operationId, "registered"),
          submission: { ...view, status: "submitted" },
        }
      : { ok: true, journal, submission: { ...view, status: "unconfirmed" } };
  } catch {
    // Thrown after a possible dispatch: the issued journal still goes back.
    return unknown;
  }
}

/**
 * The latest moment an assertion for this submission could have been
 * minted: its recorded issue, else (prepared, its submit answer perhaps
 * lost) the end of its dispatch window. Never the prepare time alone.
 */
export const latestAssertion = (entry: FaceJournalEntry) =>
  entry.issuedAt ?? entry.createdAt + LOYALTY_DISPATCH_WINDOW_MS;

/** This launch's own entry, closed as never received; else unchanged. */
export function closeNotReceived(
  journal: FaceJournal,
  entry: FaceJournalEntry,
) {
  if (!journal.entries.some((item) => item.operationId === entry.operationId)) {
    return undefined;
  }
  if (preparedLoyaltyStep(entry)) {
    const next = applyIn(journal, {
      kind: "lapse",
      operationId: entry.operationId,
    });
    return "entries" in next ? next : undefined;
  }
  const next = settled(journal, entry.operationId, "not_submitted");
  return next === journal ? undefined : next;
}

/**
 * §4.5: the read-only status of exactly one of this wallet's own
 * submissions (prepared or sent), under its original operation. Never
 * resubmits. The journal is written only when this launch's own entry is
 * closed by the read.
 */
export async function submissionStatus(
  context: FaceRequestContext,
  operationId: unknown,
): Promise<LoyaltyResult<{ submission: LoyaltySubmissionView }>> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const entry = ownSubmissions(context).find(
    (item) => item.operationId === operationId,
  ) as FaceJournalEntry | undefined;
  if (!entry || !entry.evidenceHash) return fail("unknown_operation", 404);
  const proof = proofContext(context, rules);
  const called = await call(
    context,
    context.journal,
    rules,
    "loyalty.activity.status",
    entry.operationId,
    entry.objectId,
    {},
  );
  if (!called.ok) return bare(called.failure);
  let journal: FaceJournal | undefined;
  const view = (status: LoyaltySubmissionStatus) => ({
    ok: true as const,
    ...(journal ? { journal } : {}),
    submission: submissionView(entry, status),
  });
  if (!called.answer.reached) return view("unknown");
  const answer = parseStatusAnswer(called.answer.status, called.answer.body);
  if (answer.kind === "unknown") return view("unknown");
  if (answer.kind === "not_received") {
    // Believed only once every assertion it could have had has expired.
    if (Date.now() - latestAssertion(entry) <= NOT_RECEIVED_AFTER_MS) {
      return view("unknown");
    }
    journal = closeNotReceived(called.journal, entry);
    return view("not_received");
  }
  const submissionProven =
    answer.submission.evidenceHash === entry.evidenceHash &&
    answer.submission.activityType === entry.activityType &&
    answer.canonical.objectId === entry.objectId &&
    answer.action.objectId === entry.objectId &&
    (await proveCanonical(answer.canonical, proof)) &&
    (await proveReceipt(
      answer.action,
      answer.canonical,
      proof,
      entry.evidenceHash,
    ));
  if (!submissionProven) return view("unconfirmed");
  const registered = settled(called.journal, entry.operationId, "registered");
  if (registered !== called.journal) journal = registered;
  if (answer.kind === "submitted") return view("submitted");
  const counted =
    verificationFollows(answer.action, answer.verification) &&
    (await proveReceipt(answer.verification, answer.canonical, proof));
  // An unproven verification is not counted; the submission still stands.
  return view(counted ? "counted" : "submitted");
}
