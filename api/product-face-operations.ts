import "server-only";

import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { readFaceAcceptance } from "@/api/face-acceptance";
import {
  mintFaceAssertion,
  sha256Hash,
  walletIssuerOrigin,
  faceAssertionSigner,
  type AssertionTarget,
} from "@/api/face-assertion";
import {
  currentSelection,
  MAX_OUTSTANDING_ASSERTIONS,
  readFaceHistory,
  withSelection,
  type FaceJournal,
} from "@/api/face-journal";
import {
  parseCaseQuote,
  parseSettleProposal,
  readRegistrationStatus,
  registrationStatusRequestHash,
  reserveSettle,
  runtimeRequestHash,
  transferRuntimeCall,
  trustedRuntimeRead,
  type TrustedReadRequest,
} from "@/api/face-runtime";
import {
  productRegistration,
  publicUnitFacts,
  readOwnedProduct,
  readPublicUnit,
  type FaceRequestContext,
} from "@/api/product-face-server";
import {
  applyJournalTransition,
  authorityLeft,
  journalOperationStatus,
  recoverableRegistration,
  registrationClosable,
  type FaceJournalEntry,
  type JournalTransitionError,
  withDispatchWon,
} from "@/app/_domain/product-face-journal";
import {
  canonicalJson,
  checkSettleProposal,
  isCaseId,
  isObjectId,
  isOperationId,
  isQuoteOperation,
  isQuoteVersion,
  isRecordId,
  isRequestHash,
  isHostOnlyRuntimeOperation,
  isLinkedCaseOperation,
  isRuntimeOperation,
  isRuntimeWriteOperation,
  isSettleProposalUnavailableReason,
  isUnscopedTransferOperation,
  transferOperationTargetsNothing,
  proposalHashInput,
  quoteHashInput,
  settleReserveHashInput,
  runtimeOperationNeedsCase,
  type CaseQuote,
  type ProgrammeProduct,
  type RuntimeOperation,
  type SettleFieldChange,
  type SettleProposal,
} from "@/app/_domain/product-face";

export type FaceOperationFailure = {
  ok: false;
  code: string;
  status: number;
  /** A runtime-stated reason the host shows as it is (G6b proposals). */
  reason?: string;
  /** A failure after a mint still records the mint against the cap. */
  journal?: FaceJournal;
};
export type FaceOperationResult<T> =
  ({ ok: true; journal?: FaceJournal } & T) | FaceOperationFailure;

export const fail = (code: string, status: number): FaceOperationFailure => ({
  ok: false,
  code,
  status,
});

export const journalStatus: Record<JournalTransitionError, number> = {
  operation_already_submitted: 409,
  operation_conflict: 409,
  unknown_operation: 404,
  journal_full: 409,
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

const CONTEXT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// A same-instance double-submit damper for one launch's operation. It is NOT
// idempotency and decides nothing across tabs or instances: the runtime's
// one-time jti, its settle dispatch claim, its unit-level registration single
// flight and its per-version quote decisions do.
const issuing = new Map<string, number>();
function claimIssue(key: string, now: number) {
  for (const [candidate, until] of issuing) {
    if (until <= now) issuing.delete(candidate);
  }
  if (issuing.has(key)) return false;
  issuing.set(key, now + 10 * 60_000);
  return true;
}

export function resetIssueGuard() {
  issuing.clear();
}

export function selectionMatches(
  context: FaceRequestContext,
  journal: FaceJournal,
  contextId: unknown,
  objectId: string,
) {
  const selection = currentSelection(journal, context.binding.slug);
  return (
    typeof contextId === "string" &&
    Boolean(selection) &&
    selection!.contextId === contextId &&
    selection!.objectId === objectId
  );
}

// ---------------------------------------------------------------- selection

export async function selectProduct(
  context: FaceRequestContext,
  body: Record<string, unknown>,
): Promise<
  FaceOperationResult<{
    contextId: string | null;
    product?: ProgrammeProduct;
  }>
> {
  if (!onlyKeys(body, ["object_id"])) return fail("invalid_request", 400);
  if (body.object_id === null) {
    return {
      ok: true,
      contextId: null,
      journal: withSelection(context.journal, {
        slug: context.binding.slug,
        cleared: true,
      }),
    };
  }
  if (!isObjectId(body.object_id)) return fail("invalid_request", 400);
  const owned = await readOwnedProduct(context, body.object_id);
  if (!owned.ok) {
    return fail(
      owned.code,
      owned.code === "session_expired"
        ? 401
        : owned.code === "not_owned"
          ? 403
          : 404,
    );
  }
  const contextId = randomBytes(18).toString("base64url");
  return {
    ok: true,
    contextId,
    product: owned.product,
    journal: withSelection(context.journal, {
      slug: context.binding.slug,
      objectId: owned.product.objectId,
      contextId,
      at: Date.now(),
    }),
  };
}

// ------------------------------------------------------------------ minting

interface MintRequest {
  operation: RuntimeOperation;
  operationId: string;
  target: AssertionTarget;
  requestHash: string;
}

/** The Warranty runtime connected to this programme, if any (r10). */
function linkedCaseRuntime(context: FaceRequestContext) {
  return context.binding.linkedRuntimes.find(
    (runtime) => runtime.purpose === "claims-warranty",
  );
}

/** Mints one assertion and records its expiry against the outstanding cap. */
export function mint(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  input: MintRequest,
):
  | { ok: true; assertion: string; expiresAt: number; journal: FaceJournal }
  | FaceOperationFailure {
  if (!faceAssertionSigner()) return fail("face_assertion_unprovisioned", 503);
  const issuer = walletIssuerOrigin(request);
  if (!issuer) return fail("invalid_origin", 403);
  // contract r10: a case operation's audience is the linked Warranty runtime;
  // without one, nothing is minted for it.
  const linked = isLinkedCaseOperation(input.operation)
    ? linkedCaseRuntime(context)
    : undefined;
  if (isLinkedCaseOperation(input.operation) && !linked) {
    return fail("case_runtime_not_linked", 409);
  }
  const now = Date.now();
  const outstanding = journal.mints.filter((expiry) => expiry > now);
  if (outstanding.length >= MAX_OUTSTANDING_ASSERTIONS) {
    return fail("assertion_limit", 429);
  }
  const minted = mintFaceAssertion({
    issuer,
    binding: context.binding,
    walletId: context.wallet.id,
    holder: context.holder,
    operation: input.operation,
    operationId: input.operationId,
    target: input.target,
    requestHash: input.requestHash,
    sidHash: context.owner.sidHash,
    ...(linked
      ? {
          audience: {
            applicationId: linked.applicationId,
            origin: linked.origin,
          },
        }
      : {}),
    now,
  });
  if (!minted) return fail("face_assertion_unprovisioned", 503);
  return {
    ok: true,
    assertion: minted.assertion,
    expiresAt: minted.expiresAt,
    journal: { ...journal, mints: [...outstanding, minted.expiresAt] },
  };
}

function parseTarget(
  value: unknown,
  operation: RuntimeOperation,
): AssertionTarget | undefined {
  if (!record(value)) return undefined;
  const quote = isQuoteOperation(operation);
  const keys = quote
    ? ["object_id", "case_id", "quote_version", "amount", "currency"]
    : ["object_id", "case_id"];
  if (!onlyKeys(value, keys) || !isObjectId(value.object_id)) return undefined;
  const needsCase = runtimeOperationNeedsCase(operation);
  if (needsCase ? !isCaseId(value.case_id) : value.case_id !== undefined) {
    return undefined;
  }
  if (quote) {
    if (
      !isQuoteVersion(value.quote_version) ||
      typeof value.amount !== "string" ||
      typeof value.currency !== "string"
    ) {
      return undefined;
    }
    return {
      object_id: value.object_id,
      case_id: value.case_id as string,
      quote_version: value.quote_version,
      amount: value.amount,
      currency: value.currency,
    };
  }
  return {
    object_id: value.object_id,
    ...(needsCase ? { case_id: value.case_id as string } : {}),
  };
}

/**
 * POST /api/faces/[slug]/assertions. Every path re-checks, server-side, the
 * session, the wallet, the journal and the current selection before minting;
 * after logout, account change or product switch nothing is minted for the
 * old context.
 */
export async function authorizeAssertion(
  context: FaceRequestContext,
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<
  FaceOperationResult<{
    assertion: string;
    expiresAt: number;
    operationId: string;
  }>
> {
  if (
    !onlyKeys(body, [
      "operation",
      "operation_id",
      "target",
      "request_hash",
      "context_id",
    ]) ||
    !isRuntimeOperation(body.operation) ||
    !isOperationId(body.operation_id)
  ) {
    return fail("invalid_request", 400);
  }
  const operation = body.operation;
  // The settle proposal and reservation are the host's own server-to-server
  // calls; they are never authorized for the face.
  if (isHostOnlyRuntimeOperation(operation)) {
    return fail("invalid_request", 400);
  }
  const operationId = body.operation_id;
  // G8: the recipient's preview/accept (target {}) and either party's
  // progress read (target {object_id}) need no selected owned product; the
  // runtime authorises each by the assertion holder alone. No journal: they
  // move nothing (accepting binds the recipient's own wallet, and only the
  // holder's signed steps move ownership).
  if (isUnscopedTransferOperation(operation)) {
    if (!isRequestHash(body.request_hash) || body.context_id !== undefined) {
      return fail("invalid_request", 400);
    }
    const unscopedTarget = transferOperationTargetsNothing(operation)
      ? record(body.target) && Object.keys(body.target).length === 0
        ? {}
        : undefined
      : parseTarget(body.target, operation);
    if (!unscopedTarget) return fail("invalid_request", 400);
    // r19: an acceptance is minted only for exactly the unit this
    // launch's kept acceptance was read for (accept-offer), never another.
    if (operation === "transfer.accept") {
      const kept = readFaceAcceptance(request, {
        slug: context.binding.slug,
        launchId: context.scope.launchId,
        owner: context.owner,
      });
      if (!kept?.objectId) return fail("invalid_request", 400);
      if (unscopedTarget.object_id !== kept.objectId) {
        return fail("stale_context", 409);
      }
    }
    const minted = mint(context, request, context.journal, {
      operation,
      operationId,
      target: unscopedTarget,
      requestHash: body.request_hash,
    });
    if (!minted.ok) return minted;
    return {
      ok: true,
      assertion: minted.assertion,
      expiresAt: minted.expiresAt,
      operationId,
      journal: minted.journal,
    };
  }
  const target = parseTarget(body.target, operation);
  if (!target?.object_id) return fail("invalid_request", 400);
  const objectId = target.object_id;
  let journal = context.journal;
  const entry = journal.entries.find(
    (item) => item.operationId === operationId,
  );

  if (operation === "registration.submit") {
    if (!isRequestHash(body.request_hash) || body.context_id !== undefined) {
      return fail("invalid_request", 400);
    }
    if (
      !entry ||
      entry.kind !== "registration" ||
      entry.slug !== context.binding.slug ||
      entry.objectId !== objectId
    ) {
      return fail("unknown_operation", 404);
    }
    // r6: the assertion binds the face's entire exact request. The hash the
    // user confirmed is carried unchanged; any other hash is refused.
    if (!entry.requestHash || entry.requestHash !== body.request_hash) {
      return fail("operation_conflict", 409);
    }
    if (authorityLeft(entry.phase)) {
      return fail("operation_already_submitted", 409);
    }
    if (!faceAssertionSigner())
      return fail("face_assertion_unprovisioned", 503);
    const transition = applyJournalTransition(
      journal.entries,
      { kind: "issue", operationId, objectId },
      Date.now(),
    );
    if (!transition.ok) {
      return fail(transition.error, journalStatus[transition.error]);
    }
    if (
      !claimIssue(
        `${context.owner.sidHash}:${context.scope.launchId}:${operationId}`,
        Date.now(),
      )
    ) {
      return fail("operation_already_submitted", 409);
    }
    journal = { ...journal, entries: transition.entries };
    const minted = mint(context, request, journal, {
      operation,
      operationId,
      target: { object_id: objectId },
      requestHash: entry.requestHash,
    });
    if (!minted.ok) return minted;
    return {
      ok: true,
      assertion: minted.assertion,
      expiresAt: minted.expiresAt,
      operationId,
      journal: minted.journal,
    };
  }

  if (!isRequestHash(body.request_hash)) return fail("invalid_request", 400);
  const requestHash = body.request_hash;

  if (operation === "registration.status") {
    if (body.context_id !== undefined) return fail("invalid_request", 400);
    // Not this launch's: exactly the one registration this wallet's own sealed
    // history issued under this id (reconcileOperation's rule), so the face's
    // read-only runtime status read follows the host's recovered status. Only
    // this read: its exact request hash, its own unit; never added to this
    // journal, re-sealed, submitted or settled.
    const recovered = entry
      ? undefined
      : recoveredRegistration(context, request, operationId);
    const statusEntry = entry ?? recovered;
    if (
      !statusEntry ||
      statusEntry.kind !== "registration" ||
      statusEntry.slug !== context.binding.slug ||
      statusEntry.objectId !== objectId ||
      !authorityLeft(statusEntry.phase)
    ) {
      return fail("unknown_operation", 404);
    }
    if (
      recovered &&
      requestHash !== registrationStatusRequestHash(operationId)
    ) {
      return fail("operation_conflict", 409);
    }
  } else {
    // Product-scoped: the server-side selection must still be this product.
    if (!selectionMatches(context, journal, body.context_id, objectId)) {
      return fail("stale_context", 409);
    }
    const owned = await readOwnedProduct(context, objectId);
    if (!owned.ok) {
      return fail(owned.code, owned.code === "session_expired" ? 401 : 403);
    }
    if (operation === "registration.settle.verify") {
      const settled = journal.entries.some(
        (item) =>
          item.kind === "settle" &&
          item.slug === context.binding.slug &&
          item.objectId === objectId &&
          (item.phase === "submitted" || item.phase === "settled"),
      );
      if (!settled) return fail("settle_not_submitted", 409);
    }
    if (isRuntimeWriteOperation(operation)) {
      if (
        !entry ||
        entry.kind !== "runtime" ||
        entry.operation !== operation ||
        entry.slug !== context.binding.slug
      ) {
        return fail("unknown_operation", 404);
      }
      if (authorityLeft(entry.phase)) {
        return fail("operation_already_submitted", 409);
      }
      // The journal keeps only the confirmed quote's hash; the requested
      // target must hash to exactly it.
      const requestedQuoteHash =
        target.quote_version !== undefined
          ? sha256Hash(
              quoteHashInput({
                quote_version: target.quote_version,
                amount: target.amount ?? "",
                currency: target.currency ?? "",
              }),
            )
          : undefined;
      if (
        target.object_id !== entry.objectId ||
        (target.case_id ?? undefined) !== (entry.caseId ?? undefined) ||
        requestedQuoteHash !== entry.quoteHash
      ) {
        return fail(
          isQuoteOperation(operation) ? "quote_changed" : "operation_conflict",
          409,
        );
      }
      if (!faceAssertionSigner()) {
        return fail("face_assertion_unprovisioned", 503);
      }
      const transition = applyJournalTransition(
        journal.entries,
        { kind: "issue", operationId, objectId, caseId: entry.caseId },
        Date.now(),
      );
      if (!transition.ok) {
        return fail(transition.error, journalStatus[transition.error]);
      }
      if (
        !claimIssue(
          `${context.owner.sidHash}:${context.scope.launchId}:${operationId}`,
          Date.now(),
        )
      ) {
        return fail("operation_already_submitted", 409);
      }
      journal = { ...journal, entries: transition.entries };
    }
  }

  const minted = mint(context, request, journal, {
    operation,
    operationId,
    target,
    requestHash,
  });
  if (!minted.ok) return minted;
  return {
    ok: true,
    assertion: minted.assertion,
    expiresAt: minted.expiresAt,
    operationId,
    journal: minted.journal,
  };
}

// ---------------------------------------------------------- trusted reads

async function trustedRead(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  read: TrustedReadRequest,
) {
  const minted = mint(context, request, journal, {
    operation: read.operation,
    operationId: read.operationId,
    target: read.target,
    requestHash: runtimeRequestHash(read),
  });
  if (!minted.ok) return minted;
  // r10: case.read goes to the linked Warranty runtime, not the face's own.
  const linked = isLinkedCaseOperation(read.operation)
    ? linkedCaseRuntime(context)
    : undefined;
  const result = await trustedRuntimeRead(
    linked
      ? { origin: linked.origin, applicationId: linked.applicationId }
      : context.binding,
    read,
    minted.assertion,
  );
  if (!result.ok) {
    // Only a few runtime refusals become a contract code for the face; the
    // rest stay a generic refusal.
    // G6b: no proposal exists right now, and the runtime says why; the host
    // shows that reason as it is and never invents a proposal.
    const unavailable =
      read.operation === "registration.settle.propose" &&
      result.reason === "settle_proposal_unavailable";
    const code =
      read.operation === "case.read"
        ? result.status === 409
          ? "quote_changed"
          : result.code
        : unavailable
          ? "settle_proposal_unavailable"
          : result.reason === "settle_not_required"
            ? "settle_not_required"
            : result.code === "runtime_refused"
              ? "proposal_rejected"
              : result.code;
    return {
      ...fail(code, result.code === "runtime_unavailable" ? 503 : 409),
      ...(unavailable && isSettleProposalUnavailableReason(result.detail)
        ? { reason: result.detail }
        : {}),
      journal: minted.journal,
    };
  }
  return { ok: true as const, body: result.body, journal: minted.journal };
}

/**
 * The host obtains the settle proposal itself from the bound runtime; a
 * face-supplied proposal is never accepted. It must be bound to this unit and
 * original operation, unexpired, template-exact and hash-consistent.
 */
export async function readSettleProposal(
  context: FaceRequestContext,
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<
  FaceOperationResult<{
    proposal: SettleProposal;
    changes: SettleFieldChange[];
  }>
> {
  if (
    !onlyKeys(body, ["context_id", "operation_id", "object_id"]) ||
    !isOperationId(body.operation_id) ||
    !isObjectId(body.object_id) ||
    typeof body.context_id !== "string" ||
    !CONTEXT_ID.test(body.context_id)
  ) {
    return fail("invalid_request", 400);
  }
  const settle = context.binding.settle;
  if (!settle) return fail("proposal_rejected", 409);
  if (
    !selectionMatches(context, context.journal, body.context_id, body.object_id)
  ) {
    return fail("stale_context", 409);
  }
  const owned = await readOwnedProduct(context, body.object_id);
  if (!owned.ok) {
    return fail(owned.code, owned.code === "session_expired" ? 401 : 403);
  }
  const { readback } = productRegistration(context, owned.product);
  if (
    !readback.state ||
    !settle.fromStates.includes(readback.state) ||
    !context.binding.canonicalRegistration.unconfirmedStates.includes(
      readback.state,
    )
  ) {
    return fail("settle_not_required", 409);
  }
  const read = await trustedRead(context, request, context.journal, {
    operation: "registration.settle.propose",
    operationId: body.operation_id,
    target: { object_id: body.object_id },
    input: {},
  });
  if (!read.ok) return read;
  const proposal = parseSettleProposal(read.body);

  if (!proposal)
    return { ...fail("proposal_rejected", 422), journal: read.journal };
  const check = checkSettleProposal(
    proposal,
    {
      operationId: body.operation_id,
      objectId: body.object_id,
      now: Date.now(),
    },
    owned.product.custom,
    settle,
    context.binding.canonicalRegistration,
  );
  if (
    !check.ok ||
    sha256Hash(proposalHashInput(proposal)) !== proposal.proposalHash
  ) {
    return { ...fail("proposal_rejected", 422), journal: read.journal };
  }
  // The runtime vouched that this registration operation is this unit's: a
  // launch that resumed it (another tab, a reload) can then reconcile its
  // status read-only. Nothing is minted or submitted for it from here.
  const observed = applyJournalTransition(
    read.journal.entries,
    {
      kind: "observe",
      operationId: proposal.operationId,
      objectId: proposal.objectId,
      slug: context.binding.slug,
      programmeId: context.binding.programmeId,
    },
    Date.now(),
  );
  return {
    ok: true,
    proposal,
    changes: check.changes,
    journal: observed.ok
      ? { ...read.journal, entries: observed.entries }
      : read.journal,
  };
}

// ---------------------------------------------------------------- journal

type JournalBody = Record<string, unknown>;

/**
 * POST /api/faces/[slug]/operations: moves one journal entry forward. The
 * journal is persisted outside the iframe before any assertion is minted or
 * any settle action is executed.
 */
export async function transitionOperation(
  context: FaceRequestContext,
  request: NextRequest,
  body: JournalBody,
): Promise<
  FaceOperationResult<{
    entry: FaceJournalEntry;
    unit?: ReturnType<typeof publicUnitFacts>;
    quote?: CaseQuote;
  }>
> {
  const transition = body.transition;
  if (
    !onlyKeys(body, [
      "transition",
      "operation_id",
      "kind",
      "operation",
      "object_id",
      "case_id",
      "context_id",
      "action_id",
      "proposal_id",
      "offer_id",
      "record_id",
      "request_hash",
    ]) ||
    !isOperationId(body.operation_id)
  ) {
    return fail("invalid_request", 400);
  }
  const operationId = body.operation_id;
  const now = Date.now();
  let journal = context.journal;
  const existing = journal.entries.find(
    (entry) => entry.operationId === operationId,
  );
  if (existing && existing.slug !== context.binding.slug) {
    return fail("operation_conflict", 409);
  }
  const apply = (
    next: Parameters<typeof applyJournalTransition>[1],
    extra: {
      unit?: ReturnType<typeof publicUnitFacts>;
      quote?: CaseQuote;
    } = {},
  ) => {
    const result = applyJournalTransition(journal.entries, next, now);
    if (!result.ok) return fail(result.error, journalStatus[result.error]);
    return {
      ok: true as const,
      entry: result.entry,
      journal: { ...journal, entries: result.entries },
      ...extra,
    };
  };

  switch (transition) {
    case "begin":
      break;
    case "cancel":
      return apply({ kind: "cancel", operationId });
    case "confirm": {
      if (!existing) return fail("unknown_operation", 404);
      const recheck = await recheckOperation(context, existing, body);
      if (recheck) return recheck;
      return apply({
        kind: "confirm",
        operationId,
        objectId: existing.objectId,
      });
    }
    case "submit": {
      if (!existing) return fail("unknown_operation", 404);
      const recheck = await recheckOperation(context, existing, body);
      if (recheck) return recheck;
      if (existing.kind === "settle") {
        return submitSettle(context, request, existing, now);
      }
      if (existing.kind === "transfer") {
        return submitTransfer(context, request, existing, now);
      }
      return apply({
        kind: "submit",
        operationId,
        objectId: existing.objectId,
      });
    }
    case "record_action":
      if (
        typeof body.action_id !== "string" ||
        !ACTION_ID.test(body.action_id)
      ) {
        return fail("invalid_request", 400);
      }
      return apply({
        kind: "record_action",
        operationId,
        actionId: body.action_id,
      });
    default:
      return fail("invalid_request", 400);
  }

  // begin
  if (!isObjectId(body.object_id)) return fail("invalid_request", 400);
  const objectId = body.object_id;
  // An operation id a launch of this wallet already issued a registration
  // under is never begun again here: its outcome is only ever reconciled
  // read-only, and nothing new is confirmed, minted or submitted under it.
  if (
    !existing &&
    readFaceHistory(request, context.scope, operationId, now).some(
      recoverableRegistration,
    )
  ) {
    return fail("operation_already_submitted", 409);
  }
  const base = {
    operationId,
    slug: context.binding.slug,
    programmeId: context.binding.programmeId,
    objectId,
  };

  if (body.kind === "registration") {
    if (
      body.operation !== "registration.submit" ||
      body.case_id !== undefined ||
      body.context_id !== undefined ||
      !isRecordId(body.record_id) ||
      !isRequestHash(body.request_hash)
    ) {
      return fail("invalid_request", 400);
    }
    const unit = await readPublicUnit(objectId);
    if (!unit) return fail("not_found", 404);
    const facts = publicUnitFacts(context, unit);
    if (!context.binding.templateIds.includes(facts.templateId)) {
      return fail("not_in_programme", 404);
    }
    if (facts.recordId !== body.record_id) {
      return fail("record_mismatch", 409);
    }
    if (facts.readback.ownerIsYou) {
      return fail(
        facts.registration === "registered"
          ? "already_registered_to_you"
          : "ownership_moved_state_pending",
        409,
      );
    }
    return apply(
      {
        kind: "begin",
        entry: {
          ...base,
          kind: "registration",
          operation: "registration.submit",
          recordId: body.record_id,
          requestHash: body.request_hash,
        },
      },
      { unit: facts },
    );
  }

  if (!selectionMatches(context, journal, body.context_id, objectId)) {
    return fail("stale_context", 409);
  }
  const owned = await readOwnedProduct(context, objectId);
  if (!owned.ok) {
    return fail(owned.code, owned.code === "session_expired" ? 401 : 403);
  }

  if (body.kind === "runtime") {
    if (!isRuntimeWriteOperation(body.operation)) {
      return fail("invalid_request", 400);
    }
    const operation = body.operation;
    const needsCase = runtimeOperationNeedsCase(operation);
    if (needsCase ? !isCaseId(body.case_id) : body.case_id !== undefined) {
      return fail("invalid_request", 400);
    }
    const caseId = needsCase ? (body.case_id as string) : undefined;
    let quote: CaseQuote | undefined;
    if (isQuoteOperation(operation)) {
      // The quote shown in the host confirmation and bound into the write
      // assertion comes from the runtime, read by the wallet itself.
      const read = await trustedRead(context, request, journal, {
        operation: "case.read",
        operationId,
        target: { object_id: objectId, case_id: caseId },
        input: {},
      });
      if (!read.ok) return read;
      journal = read.journal;
      quote = parseCaseQuote(read.body, caseId!);
      if (!quote) return { ...fail("quote_unavailable", 502), journal };
    }
    return apply(
      {
        kind: "begin",
        entry: {
          ...base,
          kind: "runtime",
          operation,
          ...(caseId ? { caseId } : {}),
          ...(quote
            ? {
                quoteHash: sha256Hash(
                  quoteHashInput({
                    quote_version: quote.quoteVersion,
                    amount: quote.amount,
                    currency: quote.currency,
                  }),
                ),
              }
            : {}),
        },
      },
      { quote },
    );
  }

  if (body.kind === "settle") {
    const settle = context.binding.settle;
    if (
      !settle ||
      body.operation !== settle.action ||
      body.case_id !== undefined ||
      typeof body.proposal_id !== "string" ||
      !ACTION_ID.test(body.proposal_id)
    ) {
      return fail("invalid_request", 400);
    }
    const { readback } = productRegistration(context, owned.product);
    if (!readback.state || !settle.fromStates.includes(readback.state)) {
      return fail("settle_not_required", 409);
    }
    // r11/r13: a settle of this unit that already left the wallet (reserved,
    // or its reserve answer lost) stays outcome_unknown with its original
    // correlation; it is never replaced from here, whatever the time or an
    // empty history says. Only the runtime's reservation is authoritative;
    // this keeps one launch from even asking.
    const outstanding = journal.entries.find(
      (item) =>
        item.kind === "settle" &&
        item.objectId === body.object_id &&
        item.operationId !== operationId &&
        item.phase === "submitted",
    );
    if (outstanding) {
      return fail("operation_conflict", 409);
    }
    // r17: a complete-map template only; the unit's fresh custom map is
    // bound now and re-checked before anything is sent.
    const freshHash = customMapHash(owned.product.custom);
    if (settle.preserveUnlisted !== true || !freshHash) {
      return fail("proposal_rejected", 409);
    }
    return apply({
      kind: "begin",
      entry: {
        ...base,
        kind: "settle",
        operation: settle.action,
        proposalId: body.proposal_id,
        freshHash,
      },
    });
  }

  if (body.kind === "transfer") {
    // G8: one holder-signed step of the holder's offer for the selected owned
    // product, with the proposal the wallet read itself (transfer-proposal).
    if (
      (body.operation !== "transfer.request" &&
        body.operation !== "transfer.transfer") ||
      body.case_id !== undefined ||
      typeof body.proposal_id !== "string" ||
      !TRANSFER_PROPOSAL_ID.test(body.proposal_id) ||
      typeof body.offer_id !== "string" ||
      !TRANSFER_OFFER_ID.test(body.offer_id)
    ) {
      return fail("invalid_request", 400);
    }
    // A step of this unit that already left the wallet stays outcome_unknown
    // under its own operation; it is never replaced from here.
    const outstanding = journal.entries.find(
      (item) =>
        item.kind === "transfer" &&
        item.objectId === objectId &&
        item.operationId !== operationId &&
        item.phase === "submitted",
    );
    if (outstanding) return fail("operation_conflict", 409);
    // The request step updates the unit's custom map: only under the exact
    // binding.transferRequest template, bound to this fresh read (r17).
    let freshHash: string | undefined;
    if (body.operation === "transfer.request") {
      const rules = context.binding.transferRequest;
      if (!rules) return fail("capability_not_granted", 403);
      freshHash = customMapHash(owned.product.custom);
      if (rules.preserveUnlisted !== true || !freshHash) {
        return fail("proposal_rejected", 409);
      }
    }
    return apply({
      kind: "begin",
      entry: {
        ...base,
        kind: "transfer",
        operation: body.operation,
        proposalId: body.proposal_id,
        offerId: body.offer_id,
        ...(freshHash ? { freshHash } : {}),
      },
    });
  }

  return fail("invalid_request", 400);
}

const TRANSFER_PROPOSAL_ID = /^ptp-[0-9a-f]{24}$/;
const TRANSFER_OFFER_ID = /^pto-[0-9a-f]{24}$/;

/**
 * contract r16 transfer.sign, with the r8/r11 reservation rules: a confirmed
 * transfer step is reserved at the runtime, server to server, before ANY
 * holder execution. The entry is persisted as submitted whatever the answer;
 * the holder executes only when this request itself received
 * dispatch:"won" with executionPermitted for exactly this step operation and
 * proposal. The runtime's definite refusal because the offer was cancelled or
 * expired first (its offer state machine decided) is "transfer_cancelled";
 * anything else (a replay, already claimed, a lost answer, an error) is
 * outcome_unknown: never executed, never re-reserved, read-only after that.
 */
async function submitTransfer(
  context: FaceRequestContext,
  request: NextRequest,
  entry: FaceJournalEntry,
  now: number,
): Promise<
  FaceOperationResult<{ entry: FaceJournalEntry; reservation?: "won" }>
> {
  if (!entry.proposalId || !entry.offerId) {
    return fail("operation_conflict", 409);
  }
  const submitted = applyJournalTransition(
    context.journal.entries,
    {
      kind: "submit",
      operationId: entry.operationId,
      objectId: entry.objectId,
    },
    now,
  );
  if (!submitted.ok) {
    return fail(submitted.error, journalStatus[submitted.error]);
  }
  const reserve = {
    operation: "transfer.reserve" as const,
    operationId: entry.operationId,
    target: { object_id: entry.objectId },
    input: { offer_id: entry.offerId, proposal_id: entry.proposalId },
  };
  const minted = mint(
    context,
    request,
    { ...context.journal, entries: submitted.entries },
    {
      operation: reserve.operation,
      operationId: reserve.operationId,
      target: reserve.target,
      requestHash: runtimeRequestHash(reserve),
    },
  );
  // Nothing was sent: the entry stays confirmed and may still be cancelled.
  if (!minted.ok) return minted;
  const result = await transferRuntimeCall(
    context.binding,
    reserve,
    minted.assertion,
  );
  const answer = result.ok ? result.body : (result.body ?? {});
  const reservation = record(answer.reservation) ? answer.reservation : {};
  const won =
    result.ok &&
    result.status === 200 &&
    answer.ok === true &&
    answer.status === "granted" &&
    answer.dispatch === "won" &&
    answer.executionPermitted === true &&
    reservation.step_operation_id === entry.operationId &&
    reservation.proposal_id === entry.proposalId;
  if (won) {
    // Only this launch's own "won" makes the step executable, and only
    // through the session that holds this journal (face-execution-binding).
    return {
      ok: true,
      entry: { ...submitted.entry, dispatch: "won" },
      reservation: "won",
      journal: {
        ...minted.journal,
        entries: withDispatchWon(minted.journal.entries, entry.operationId),
      },
    };
  }
  const refused =
    !result.ok &&
    answer.executionPermitted === false &&
    answer.dispatch === "refused" &&
    (answer.status === "transfer_offer_cancelled" ||
      answer.status === "transfer_offer_expired");
  return {
    ...fail(refused ? "transfer_cancelled" : "outcome_unknown", 409),
    journal: minted.journal,
  };
}

/**
 * contract r8/r11: a confirmed settle is reserved at the runtime, server to
 * server, before ANY holder execution. The entry is persisted as submitted
 * whatever the answer (from here only read-only reconciliation follows), and
 * the host executes the holder action only when this request itself received
 * dispatch:"won". An idempotent replay, already_claimed, already_reserved,
 * any refusal or error, a timeout or a lost response is outcome_unknown for
 * the face: never executed, never re-reserved, read-only
 * registration.settle.status only.
 */
async function submitSettle(
  context: FaceRequestContext,
  request: NextRequest,
  entry: FaceJournalEntry,
  now: number,
): Promise<
  FaceOperationResult<{ entry: FaceJournalEntry; reservation?: "won" }>
> {
  if (!entry.proposalId) return fail("operation_conflict", 409);
  const submitted = applyJournalTransition(
    context.journal.entries,
    {
      kind: "submit",
      operationId: entry.operationId,
      objectId: entry.objectId,
    },
    now,
  );
  if (!submitted.ok) {
    return fail(submitted.error, journalStatus[submitted.error]);
  }
  const reservationRequest = {
    settleOperationId: entry.operationId,
    objectId: entry.objectId,
    proposalId: entry.proposalId,
  };
  const minted = mint(
    context,
    request,
    { ...context.journal, entries: submitted.entries },
    {
      operation: "registration.settle.reserve",
      operationId: entry.operationId,
      target: { object_id: entry.objectId },
      requestHash: sha256Hash(settleReserveHashInput(reservationRequest)),
    },
  );
  // Nothing was sent: the entry stays confirmed and may still be cancelled.
  if (!minted.ok) return minted;
  const reserved = await reserveSettle(
    context.binding,
    reservationRequest,
    minted.assertion,
  );
  if (reserved.outcome !== "won") {
    return {
      ...fail("outcome_unknown", 409),
      journal: minted.journal,
    };
  }
  return {
    ok: true,
    entry: { ...submitted.entry, dispatch: "won" },
    reservation: "won",
    journal: {
      ...minted.journal,
      entries: withDispatchWon(minted.journal.entries, entry.operationId),
    },
  };
}

/** Confirmation and submission re-check the facts that justified them. */
async function recheckOperation(
  context: FaceRequestContext,
  entry: FaceJournalEntry,
  body: JournalBody,
): Promise<FaceOperationFailure | undefined> {
  if (entry.kind === "registration") {
    const unit = await readPublicUnit(entry.objectId);
    if (!unit) return fail("not_found", 404);
    const facts = publicUnitFacts(context, unit);
    if (!context.binding.templateIds.includes(facts.templateId)) {
      return fail("not_in_programme", 404);
    }
    if (facts.readback.ownerIsYou) {
      return fail("already_registered_to_you", 409);
    }
    return undefined;
  }
  if (
    !selectionMatches(context, context.journal, body.context_id, entry.objectId)
  ) {
    return fail("stale_context", 409);
  }
  const owned = await readOwnedProduct(context, entry.objectId);
  if (!owned.ok) {
    return fail(owned.code, owned.code === "session_expired" ? 401 : 403);
  }
  if (entry.kind === "settle") {
    const settle = context.binding.settle;
    const { readback } = productRegistration(context, owned.product);
    if (
      !settle ||
      !readback.state ||
      !settle.fromStates.includes(readback.state)
    ) {
      return fail("settle_not_required", 409);
    }
    // r7 + r17, re-checked on the fresh object at confirm and before the
    // reserve: the complete-map proposal was checked against the unit as it
    // was at begin; a unit that changed since (a key added, a value moved)
    // could lose data or be signed blind. Nothing has been sent yet.
    if (
      settle.preserveUnlisted !== true ||
      !entry.freshHash ||
      customMapHash(owned.product.custom) !== entry.freshHash
    ) {
      return fail("proposal_rejected", 409);
    }
  }
  if (entry.kind === "transfer" && entry.operation === "transfer.request") {
    const rules = context.binding.transferRequest;
    if (!rules) return fail("capability_not_granted", 403);
    const { readback } = productRegistration(context, owned.product);
    if (
      rules.preserveUnlisted !== true ||
      !readback.state ||
      !rules.fromStates.includes(readback.state) ||
      !entry.freshHash ||
      customMapHash(owned.product.custom) !== entry.freshHash
    ) {
      return fail("proposal_rejected", 409);
    }
  }
  return undefined;
}

/** sha256 of the canonical JSON of a unit's custom map, or undefined. */
function customMapHash(custom: unknown) {
  try {
    return sha256Hash(canonicalJson(custom ?? {}));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ status

/**
 * The one registration this wallet's other launch journals hold under exactly
 * this operation id whose launch issued its one assertion; nothing when no
 * launch issued it, or more than one did (it is never guessed which).
 *
 * Other launches may carry the same id without having issued it: one that
 * resumed this registration (Finish registration in a reload or another tab
 * records it as observed, from the runtime's settle proposal), or one that
 * began it and never issued. Those can only name this same registration of
 * this same unit; any entry under the id that names another unit, or is not
 * a registration, is a conflict, and nothing is recovered.
 */
function recoveredRegistration(
  context: FaceRequestContext,
  request: NextRequest,
  operationId: string,
) {
  const history = readFaceHistory(request, context.scope, operationId);
  const issued = history.filter(recoverableRegistration);
  if (issued.length !== 1) return undefined;
  const [entry] = issued;
  const consistent = history.every(
    (other) =>
      other === entry ||
      (other.kind === "registration" &&
        other.operation === entry.operation &&
        other.objectId === entry.objectId),
  );
  return consistent ? entry : undefined;
}

/**
 * Read-only reconciliation from the journal and the wallet's own canonical
 * readback. It never retries, re-mints a submission or re-executes.
 *
 * Dual's readback names the unit's state, not the operation that produced
 * it. For a registration this launch issued, once the readback shows the unit
 * moved to this wallet (or the operation could be closed), the host asks the
 * runtime for that ONE operation (the face's own registrations/status read).
 * The readback is the operation's only when the runtime holds its journal,
 * and registered only when the runtime says it registered; otherwise it is
 * unknown, and closed (not_submitted) when the runtime holds no journal past
 * the point it could still be accepted (registrationClosable).
 */
export async function reconcileOperation(
  context: FaceRequestContext,
  request: NextRequest,
  operationId: string,
) {
  const own = context.journal.entries.find(
    (item) =>
      item.operationId === operationId && item.slug === context.binding.slug,
  );
  // Not this launch's: exactly this operation from this wallet's own sealed
  // history (a reload, another tab, a sign-in since), when it is the one
  // registration a launch issued under that id. Derived read-only each time:
  // never added to this journal, re-sealed or rewritten, and nothing is
  // minted, submitted or settled for it here.
  const entry = own ?? recoveredRegistration(context, request, operationId);
  if (!entry) return fail("unknown_operation", 404);
  const recovered = !own;
  let readback: { ownerIsYou: boolean; state: string | null } | undefined;
  let evaluation:
    ReturnType<typeof publicUnitFacts>["registration"] | undefined;
  if (
    authorityLeft(entry.phase) &&
    entry.kind !== "runtime" &&
    entry.kind !== "transfer"
  ) {
    const unit = await readPublicUnit(entry.objectId);
    if (unit) {
      const facts = publicUnitFacts(context, unit);
      readback = {
        ownerIsYou: facts.readback.ownerIsYou,
        state: facts.readback.state,
      };
      evaluation = facts.registration;
    }
  }
  let status = journalOperationStatus(entry, evaluation);
  let journal: FaceJournal | undefined;
  const now = Date.now();
  const closable = registrationClosable(entry, now);
  if (
    entry.kind === "registration" &&
    entry.phase === "assertion_issued" &&
    (status !== "outcome_unknown" || closable)
  ) {
    // The host's own server-to-server read: its assertion never reaches the
    // face, so it is not kept against the launch's outstanding cap, and this
    // read-only route writes the journal only when it settles or closes.
    const minted = mint(context, request, context.journal, {
      operation: "registration.status",
      operationId,
      target: { object_id: entry.objectId },
      requestHash: registrationStatusRequestHash(operationId),
    });
    const runtime = minted.ok
      ? await readRegistrationStatus(
          context.binding,
          operationId,
          minted.assertion,
        )
      : ({ outcome: "unknown" } as const);
    const confirmed =
      runtime.outcome === "answered" &&
      (runtime.status === "registered" ||
        runtime.status === "already_registered");
    if (runtime.outcome === "not_found" && closable) {
      const closed = applyJournalTransition(
        recovered ? [entry] : context.journal.entries,
        { kind: "close", operationId, reason: "runtime_never_accepted" },
        now,
      );
      if (closed.ok) {
        // A recovered operation's closure is the same proof, reported and
        // not kept: its own sealed evidence stays exactly as it was.
        journal = recovered
          ? undefined
          : { ...context.journal, entries: closed.entries };
        return {
          ok: true as const,
          entry: closed.entry,
          status: journalOperationStatus(closed.entry, evaluation),
          readback,
          journal,
        };
      }
    }
    // The unit's state is this operation's only if the runtime journalled
    // it, and registered only when the runtime says it registered.
    if (runtime.outcome !== "answered") status = "outcome_unknown";
    else if (status === "registered" && !confirmed) status = "outcome_unknown";
  }
  if (status === "registered" && entry.phase !== "settled" && !recovered) {
    const settled = applyJournalTransition(
      context.journal.entries,
      { kind: "settle", operationId, status },
      now,
    );
    if (settled.ok) {
      journal = { ...context.journal, entries: settled.entries };
    }
  }
  return {
    ok: true as const,
    entry,
    status,
    readback,
    journal,
  };
}
