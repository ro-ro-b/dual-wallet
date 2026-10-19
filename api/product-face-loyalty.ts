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
  LOYALTY_SUBMIT_OPERATION,
  sentLoyaltyStep,
  type FaceJournalEntry,
  type JournalTransition,
} from "@/app/_domain/product-face-journal";
import type { RegistrationStatus } from "@/app/_domain/product-face";

// loyalty-join-earn-v1 (docs/proposals/loyalty-join-earn-v1.md): the wallet
// BFF side of a member's native join and earn. Every runtime call is one
// server-to-server request with a one-time, operation-bound face assertion;
// the holder is always the session's. Nothing is said about Dual that this
// request did not prove from a fresh read (§5). A submission is journalled
// before it leaves the wallet and is then only ever read back under its
// original operation: never sent again.

/** The binding's Loyalty rules where this host serves them; else none. */
export function loyaltyRules(context: FaceRequestContext): LoyaltyRules | null {
  const rules = context.binding.loyalty;
  return rules && loyaltyServedBy(context.binding) ? rules : null;
}

const operationIdOf = (prefix: "loy" | "lrd") =>
  `${prefix}-${randomBytes(12).toString("hex")}`;
const HASH = /^sha256:[0-9a-f]{64}$/;
/** §6: a `not_received` counts only once the original assertion expired. */
const NOT_RECEIVED_AFTER_MS = 120_000;

function proofContext(
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

type Answer =
  { reached: true; status: number; body: unknown } | { reached: false };
type Called =
  | { ok: false; failure: FaceOperationFailure }
  | { ok: true; journal: FaceJournal; answer: Answer };

/** One minted, operation-bound call to the bound Loyalty runtime. */
async function call(
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

function applyIn(
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

const unavailable = (journal: FaceJournal) => ({
  ...fail("runtime_unavailable", 502),
  journal,
});

// ------------------------------------------------------------- proofs

async function proveCanonical(canonical: CanonicalRead, proof: ProofContext) {
  return (
    checkCanonical(canonical, await publicObject(canonical.objectId), proof) ===
    null
  );
}

async function proveReceipt(
  receipt: ActionReceipt,
  canonical: CanonicalRead,
  proof: ProofContext,
  evidenceHash?: string,
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
  if (!read.ok) return read;
  // Created, but the holder's own wallet does not hold its pass (yet).
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
  if (!called.ok) return called.failure;
  const { journal, answer } = called;
  const programme =
    answer.reached && answer.status === 200
      ? parseProgrammeRead(answer.body, rules)
      : undefined;
  return programme ? { ok: true, journal, programme } : unavailable(journal);
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
  if (!called.ok) return called.failure;
  const { journal, answer } = called;
  const parsed = answer.reached
    ? parseJoinAnswer(answer.status, answer.body)
    : undefined;
  if (!parsed) return unavailable(journal);
  return parsed.ok
    ? { ok: true, journal, join: parsed.join }
    : { ...fail(parsed.reason, 409), journal };
}

/** This wallet's own submissions for this programme, here and in other launches. */
function ownSubmissions(context: FaceRequestContext) {
  const seen = new Set<string>();
  return [
    ...context.journal.entries,
    ...readFaceLoyaltyHistory(context.request, context.scope),
  ].filter((entry) => {
    if (
      !sentLoyaltyStep(entry) ||
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

async function readMembership(
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
  if (!called.ok) return called.failure;
  const parsed =
    called.answer.reached && called.answer.status === 200
      ? parseMembershipAnswer(called.answer.body)
      : undefined;
  if (!parsed) return unavailable(called.journal);
  const proven = await proveMembership(
    context,
    proofContext(context, rules),
    parsed,
  );
  if (!proven.ok)
    return { ...fail("session_expired", 401), journal: called.journal };
  return { ok: true, journal: called.journal, proven };
}

/** §4.3: the membership as proven now, and this wallet's own submissions. */
export async function readMembershipView(context: FaceRequestContext): Promise<
  LoyaltyResult<{
    membership: LoyaltyMembershipView;
    submissions: Array<{ operationId: string; activityType: string }>;
  }>
> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const read = await readMembership(context, context.journal, rules);
  if (!read.ok) return read;
  return {
    ok: true,
    journal: read.journal,
    membership: read.proven.view,
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

function settled(
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

/**
 * §4.4: one activity submission for the holder's proven active membership,
 * journalled before it leaves; a lost or unprovable reply stays unknown.
 */
export async function submitActivity(
  context: FaceRequestContext,
  activityType: unknown,
  evidenceRef: unknown,
): Promise<LoyaltyResult<{ submission: LoyaltySubmissionView }>> {
  const rules = loyaltyRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (
    typeof activityType !== "string" ||
    !ACTIVITY_TYPE.test(activityType) ||
    !validEvidenceRef(evidenceRef)
  ) {
    return fail("invalid_request", 400);
  }
  const evidenceHash = sha256Hash(evidenceRef);
  // One unresolved attempt per evidence: never a second send of the same.
  if (
    ownSubmissions(context).some(
      (entry) =>
        entry.phase === "assertion_issued" &&
        entry.evidenceHash === evidenceHash,
    )
  ) {
    return fail("submission_in_progress", 409);
  }
  // Fresh proof that this holder's membership is active, now.
  const membership = await readMembership(context, context.journal, rules);
  if (!membership.ok) return membership;
  let journal = membership.journal;
  const canonical = membership.proven.canonical;
  if (membership.proven.view.status !== "active" || !canonical) {
    return { ...fail("membership_not_active", 409), journal };
  }
  const proof = proofContext(context, rules);
  const operationId = operationIdOf("loy");
  const input = { activity_type: activityType, evidence_ref: evidenceRef };
  const target = { model_id: rules.modelId, object_id: canonical.objectId };
  const requestHash = runtimeRequestHash({
    operation: LOYALTY_SUBMIT_OPERATION,
    operationId,
    target,
    input,
  });
  const called = await call(
    context,
    journal,
    rules,
    "loyalty.activity.submit",
    operationId,
    canonical.objectId,
    input,
    (minted) => {
      let next: FaceJournal | FaceOperationFailure = applyIn(minted, {
        kind: "begin",
        entry: {
          operationId,
          kind: "loyalty",
          operation: LOYALTY_SUBMIT_OPERATION,
          slug: context.binding.slug,
          programmeId: context.binding.programmeId,
          objectId: canonical.objectId,
          evidenceHash,
          activityType,
        },
      });
      for (const transition of [
        { kind: "confirm", operationId, objectId: canonical.objectId },
        {
          kind: "issue",
          operationId,
          objectId: canonical.objectId,
          requestHash,
        },
      ] as JournalTransition[]) {
        if (!("entries" in next)) return next;
        next = applyIn(next, transition);
      }
      return next;
    },
  );
  if (!called.ok)
    return { ...called.failure, journal: called.failure.journal ?? journal };
  journal = called.journal;
  const entry = { operationId, activityType };
  if (!called.answer.reached) {
    return { ok: true, journal, submission: submissionView(entry, "unknown") };
  }
  const answer = parseSubmitAnswer(called.answer.status, called.answer.body);
  if (answer.kind === "refused") {
    // Exact zero-write accounting for exactly this reason: nothing was written.
    return {
      ...fail(answer.reason, 409),
      journal: settled(journal, operationId, "not_submitted"),
    };
  }
  if (answer.kind === "unknown") {
    return { ok: true, journal, submission: submissionView(entry, "unknown") };
  }
  const proven =
    answer.submission.evidenceHash === evidenceHash &&
    answer.submission.activityType === activityType &&
    answer.canonical.objectId === canonical.objectId &&
    (await proveCanonical(answer.canonical, proof)) &&
    (await proveReceipt(answer.action, answer.canonical, proof, evidenceHash));
  return proven
    ? {
        ok: true,
        journal: settled(journal, operationId, "registered"),
        submission: submissionView(entry, "submitted"),
      }
    : {
        ok: true,
        journal,
        submission: submissionView(entry, "unconfirmed"),
      };
}

/**
 * §4.5: the read-only status of exactly one of this wallet's own
 * submissions, under its original operation. Never resubmits.
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
  if (!called.ok) return called.failure;
  let journal = called.journal;
  const view = (status: LoyaltySubmissionStatus) => ({
    ok: true as const,
    journal,
    submission: submissionView(entry, status),
  });
  if (!called.answer.reached) return view("unknown");
  const answer = parseStatusAnswer(called.answer.status, called.answer.body);
  if (answer.kind === "unknown") return view("unknown");
  if (answer.kind === "not_received") {
    const expired =
      entry.issuedAt !== undefined &&
      Date.now() - entry.issuedAt > NOT_RECEIVED_AFTER_MS;
    if (!expired) return view("unknown");
    journal = settled(journal, entry.operationId, "not_submitted");
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
  journal = settled(journal, entry.operationId, "registered");
  if (answer.kind === "submitted") return view("submitted");
  const counted =
    verificationFollows(answer.action, answer.verification) &&
    (await proveReceipt(answer.verification, answer.canonical, proof));
  // An unproven verification is not counted; the submission still stands.
  return view(counted ? "counted" : "submitted");
}
