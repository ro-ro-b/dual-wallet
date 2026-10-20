import "server-only";

import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { sha256Hash } from "@/api/face-assertion";
import { readFaceAdmissionHistory } from "@/api/face-journal";
import {
  admissionReserveOutcome,
  runtimeRequestHash,
  ticketRuntimeCall,
  type TransferRuntimeResult,
} from "@/api/face-runtime";
import {
  fail,
  journalStatus,
  mint,
  type FaceOperationFailure,
  type FaceOperationResult,
} from "@/api/product-face-operations";
import type { FaceRequestContext } from "@/api/product-face-server";
import { readTicketWithCustom } from "@/api/product-face-tickets";
import { ticketsServedBy } from "@/api/wallet-host";
import type { FaceJournal } from "@/api/face-journal";
import { canonicalJson } from "@/app/_domain/product-face";
import {
  applyJournalTransition,
  sentAdmissionStep,
  withDispatchWon,
  type FaceJournalEntry,
  type JournalTransition,
} from "@/app/_domain/product-face-journal";
import {
  ADMISSION_REQUEST_ID,
  admissionProposalHashInput,
  checkAdmissionProposal,
  freshShowsAdmittedReadback,
  parseAdmissionPending,
  parseAdmissionProposal,
  parseAdmissionVerification,
  parseTicketPass,
  type AdmissionConfirmation,
  type AdmissionReceipt,
  type AdmissionRules,
  type AdmissionState,
  type TicketHostOperation,
  type TicketPass,
} from "@/app/_domain/ticket-admission";
import type { Ticket, TicketRules } from "@/app/_domain/tickets";

// P4.3 ticket-admission-v1 (docs/development/p4-3-admission-contract.md): the
// wallet BFF side of a holder-confirmed admission on a native ticket page.
// Every runtime call is one server-to-server request with a one-time,
// operation-bound face assertion; the holder is always the session's. The
// journal (kind "admission") records what authority left the wallet: once
// the reservation is won, nothing here ever reports the attempt as not sent.

type Rules = TicketRules & { admission: AdmissionRules };

/** The binding's admission rules where this host serves them; else none. */
export function admissionRules(context: FaceRequestContext): Rules | null {
  const tickets = context.binding.tickets;
  return tickets?.admission && ticketsServedBy(context.binding)
    ? (tickets as Rules)
    : null;
}

const operationIdOf = (prefix: "adm" | "rd") =>
  `${prefix}-${randomBytes(12).toString("hex")}`;
const mapHash = (value: unknown) => sha256Hash(canonicalJson(value));

type Fresh = { ticket: Ticket; custom: unknown };

/** The ticket and its custom map, freshly read with the session's own credential. */
async function freshTicket(
  context: FaceRequestContext,
  rules: Rules,
  objectId: string,
): Promise<{ ok: true; fresh: Fresh } | ReturnType<typeof fail>> {
  const read = await readTicketWithCustom(context, rules, objectId);
  if (read.ok) return { ok: true, fresh: read };
  if (read.code === "session_expired") return fail("session_expired", 401);
  // The canonical read refused before any proposal, signature or write.
  if (read.code === "admission_unsupported") {
    return fail("admission_unsupported", 409);
  }
  if (read.code === "ticket_record_unavailable") {
    return fail("ticket_record_unavailable", 503);
  }
  // Another holder's, client's or programme's ticket: the same not_found.
  return fail("not_found", 404);
}

type Called =
  | { ok: false; failure: FaceOperationFailure }
  | { ok: true; journal: FaceJournal; result: TransferRuntimeResult };

/** One minted, operation-bound call to the bound Tickets runtime. */
async function call(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  operation: TicketHostOperation,
  operationId: string,
  objectId: string,
  input: Record<string, unknown>,
): Promise<Called> {
  const target = { object_id: objectId };
  const minted = mint(context, request, journal, {
    operation,
    operationId,
    target,
    requestHash: runtimeRequestHash({ operation, operationId, target, input }),
  });
  if (!minted.ok) return { ok: false, failure: minted };
  const result = await ticketRuntimeCall(
    context.binding,
    { operation, operationId, target, input },
    minted.assertion,
  );
  return { ok: true, journal: minted.journal, result };
}

/** This ticket's admission steps that left the wallet, here or in another launch. */
function sentSteps(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
) {
  return [
    ...context.journal.entries,
    ...readFaceAdmissionHistory(request, context.scope),
  ].filter((entry) => entry.objectId === objectId && sentAdmissionStep(entry));
}

/**
 * The holder's own authenticated read held (this session's ticket, of this
 * binding) and only the canonical record could not be established now
 * (readTicketWithCustom). Before anything was sent that is the refusal;
 * once a step was sent, that step and its original operation answer first,
 * never "nothing was sent".
 */
const canonicalRecordRefused = (failure: FaceOperationFailure) =>
  failure.code === "ticket_record_unavailable" ||
  failure.code === "admission_unsupported";

export type AdmissionResult<T> = FaceOperationResult<T>;

/**
 * "Check for entry request": the holder's own read. A sent step is followed
 * only by its original operation; otherwise the runtime's pending read,
 * where `admitted` counts only when the wallet's own fresh read shows it.
 */
export async function checkAdmission(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
): Promise<AdmissionResult<{ state: AdmissionState }>> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const read = await freshTicket(context, rules, objectId);
  if (!read.ok && !canonicalRecordRefused(read)) return read;
  const [sent] = sentSteps(context, request, objectId).sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  if (sent) {
    return {
      ok: true,
      state: { status: "unknown", operationId: sent.operationId },
    };
  }
  if (!read.ok) return read;
  const answer = await call(
    context,
    request,
    context.journal,
    "admission.pending.read",
    operationIdOf("rd"),
    objectId,
    {},
  );
  if (!answer.ok) return answer.failure;
  const journal = answer.journal;
  if (!answer.result.ok) {
    return {
      ...fail(
        answer.result.code,
        answer.result.code === "runtime_unavailable" ? 502 : 409,
      ),
      journal,
    };
  }
  const pending = parseAdmissionPending(answer.result.body, objectId);
  if (!pending) return { ...fail("runtime_refused", 409), journal };
  switch (pending.status) {
    case "none":
      return { ok: true, journal, state: { status: "none" } };
    case "awaiting_holder":
    case "expired":
      return {
        ok: true,
        journal,
        state: { status: pending.status, request: pending.request },
      };
    case "admission_unverified":
      return {
        ok: true,
        journal,
        state: { status: "unverified", requestId: pending.request.requestId },
      };
    case "admitted":
      // A saved record or an old receipt is not entry: this fresh read must
      // show exactly the committed admission map now.
      return {
        ok: true,
        journal,
        state: freshShowsAdmittedReadback(read.fresh.custom, pending.readback)
          ? { status: "admitted", admission: pending.admission }
          : { status: "unverified", requestId: pending.admission.requestId },
      };
  }
}

/**
 * Begin: the runtime's proposal for exactly this gate request, checked
 * against the wallet's own fresh read, journalled as `confirming`. Nothing
 * has left the wallet; cancel from here is zero writes.
 */
export async function beginAdmission(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
  requestId: unknown,
): Promise<
  AdmissionResult<{
    confirmation: AdmissionConfirmation;
    custom: Record<string, unknown>;
  }>
> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  if (typeof requestId !== "string" || !ADMISSION_REQUEST_ID.test(requestId)) {
    return fail("invalid_request", 400);
  }
  const read = await freshTicket(context, rules, objectId);
  if (!read.ok && !canonicalRecordRefused(read)) return read;
  // One attempt per ticket at a time: a sent step is never replaced.
  if (sentSteps(context, request, objectId).length) {
    return fail("admission_in_progress", 409);
  }
  if (!read.ok) return read;
  let journal = context.journal;
  const pendingRead = await call(
    context,
    request,
    journal,
    "admission.pending.read",
    operationIdOf("rd"),
    objectId,
    {},
  );
  if (!pendingRead.ok) return pendingRead.failure;
  journal = pendingRead.journal;
  const pending = pendingRead.result.ok
    ? parseAdmissionPending(pendingRead.result.body, objectId)
    : undefined;
  if (pending?.status === "expired") {
    return { ...fail("admission_request_expired", 409), journal };
  }
  if (
    pending?.status !== "awaiting_holder" ||
    pending.request.requestId !== requestId
  ) {
    return { ...fail("admission_request_mismatch", 409), journal };
  }
  const operationId = operationIdOf("adm");
  const proposed = await call(
    context,
    request,
    journal,
    "admission.propose",
    operationId,
    objectId,
    { request_id: requestId },
  );
  if (!proposed.ok) return { ...proposed.failure, journal };
  journal = proposed.journal;
  const proposal = proposed.result.ok
    ? parseAdmissionProposal(proposed.result.body)
    : undefined;
  if (!proposal) {
    const code =
      !proposed.result.ok && proposed.result.reason === "admission_unsupported"
        ? "admission_unsupported"
        : "proposal_rejected";
    return { ...fail(code, 409), journal };
  }
  if (
    sha256Hash(admissionProposalHashInput(proposal)) !== proposal.proposalHash
  ) {
    return { ...fail("proposal_rejected", 409), journal };
  }
  const check = checkAdmissionProposal(
    proposal,
    {
      objectId,
      requestId,
      requestExpiresAt: pending.request.expiresAt,
      now: Date.now(),
    },
    read.fresh.custom,
    rules.admission,
  );
  if (!check.ok) return { ...fail(check.reason, 409), journal };
  const custom = proposal.input.data.custom;
  const begun = applyJournalTransition(
    journal.entries,
    {
      kind: "begin",
      entry: {
        operationId,
        kind: "admission",
        operation: "update",
        slug: context.binding.slug,
        programmeId: context.binding.programmeId,
        objectId,
        proposalId: proposal.proposalId,
        admissionRequestId: requestId,
        freshHash: mapHash(read.fresh.custom),
        inputHash: mapHash(custom),
      },
    },
    Date.now(),
  );
  if (!begun.ok) {
    return { ...fail(begun.error, journalStatus[begun.error]), journal };
  }
  const fresh = read.fresh.custom as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : null;
  return {
    ok: true,
    journal: { ...journal, entries: begun.entries },
    custom,
    confirmation: {
      operationId,
      objectId,
      request: pending.request,
      expiresAt: new Date(
        Math.min(
          Date.parse(proposal.expiresAt),
          Date.parse(pending.request.expiresAt),
        ),
      ).toISOString(),
      event: {
        title: read.fresh.ticket.event.title,
        venue: read.fresh.ticket.event.venue,
        startsAt: read.fresh.ticket.event.startsAt,
      },
      window: {
        startsAt: text(fresh.admissionWindowStartsAt),
        endsAt: text(fresh.admissionWindowEndsAt),
      },
      holder: context.holder.toLowerCase(),
      effect: { from: String(fresh.state), to: "Admitted" },
    },
  };
}

/**
 * This launch's admission step for exactly this operation AND the ticket the
 * request's URL names: an operation of another ticket is not found here, so
 * nothing is read, reserved, executed or verified for it.
 */
function admissionEntry(
  context: FaceRequestContext,
  operationId: unknown,
  objectId: string,
) {
  const entry = context.journal.entries.find(
    (item) => item.operationId === operationId,
  );
  return entry?.kind === "admission" &&
    entry.slug === context.binding.slug &&
    entry.objectId === objectId
    ? entry
    : undefined;
}

function applyIn(
  journal: FaceJournal,
  transition: JournalTransition,
):
  | { ok: true; journal: FaceJournal; entry: FaceJournalEntry }
  | ReturnType<typeof fail> {
  const result = applyJournalTransition(
    journal.entries,
    transition,
    Date.now(),
  );
  return result.ok
    ? {
        ok: true,
        journal: { ...journal, entries: result.entries },
        entry: result.entry,
      }
    : fail(result.error, journalStatus[result.error]);
}

/** Cancel before anything was reserved: zero writes; refused once sent. */
export function cancelAdmission(
  context: FaceRequestContext,
  objectId: string,
  operationId: unknown,
): AdmissionResult<{ entry: FaceJournalEntry }> {
  const entry = admissionEntry(context, operationId, objectId);
  if (!entry) return fail("unknown_operation", 404);
  return applyIn(context.journal, {
    kind: "cancel",
    operationId: entry.operationId,
  });
}

/**
 * Confirm: re-check the session's ticket (the same fresh map), the gate
 * request (still awaiting, unexpired), then reserve at the runtime. The
 * entry is submitted whatever the reserve answer; only this request's own
 * `won` lets the holder's executor run.
 */
export async function confirmAdmission(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
  operationId: unknown,
): Promise<AdmissionResult<{ reservation: "won" }>> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const entry = admissionEntry(context, operationId, objectId);
  if (!entry) return fail("unknown_operation", 404);
  if (entry.phase !== "confirming") return fail("operation_conflict", 409);
  const read = await freshTicket(context, rules, entry.objectId);
  if (!read.ok) return read;
  if (mapHash(read.fresh.custom) !== entry.freshHash) {
    return fail("proposal_rejected", 409);
  }
  let journal = context.journal;
  const pendingRead = await call(
    context,
    request,
    journal,
    "admission.pending.read",
    operationIdOf("rd"),
    entry.objectId,
    {},
  );
  if (!pendingRead.ok) return pendingRead.failure;
  journal = pendingRead.journal;
  const pending = pendingRead.result.ok
    ? parseAdmissionPending(pendingRead.result.body, entry.objectId)
    : undefined;
  if (
    pending?.status !== "awaiting_holder" ||
    pending.request.requestId !== entry.admissionRequestId ||
    !(Date.parse(pending.request.expiresAt) > Date.now())
  ) {
    return {
      ...fail(
        pending?.status === "expired"
          ? "admission_request_expired"
          : "admission_request_mismatch",
        409,
      ),
      journal,
    };
  }
  const confirmed = applyIn(journal, {
    kind: "confirm",
    operationId: entry.operationId,
    objectId: entry.objectId,
  });
  if (!confirmed.ok) return { ...confirmed, journal };
  const submitted = applyIn(confirmed.journal, {
    kind: "submit",
    operationId: entry.operationId,
    objectId: entry.objectId,
  });
  if (!submitted.ok) return { ...submitted, journal };
  const input = {
    proposal_id: entry.proposalId,
    request_id: entry.admissionRequestId,
  };
  const reserved = await call(
    context,
    request,
    submitted.journal,
    "admission.reserve",
    entry.operationId,
    entry.objectId,
    input,
  );
  // Nothing was sent (no assertion): the entry stays confirming, cancellable.
  if (!reserved.ok) return { ...reserved.failure, journal };
  const outcome = admissionReserveOutcome(reserved.result, {
    operationId: entry.operationId,
    objectId: entry.objectId,
    proposalId: entry.proposalId!,
    requestId: entry.admissionRequestId!,
  });
  if (outcome.outcome !== "won") {
    // Possibly reserved: only the original operation's read-only status follows.
    return {
      ...fail("outcome_unknown", 409),
      journal: reserved.journal,
    };
  }
  return {
    ok: true,
    reservation: "won",
    journal: {
      ...reserved.journal,
      entries: withDispatchWon(reserved.journal.entries, entry.operationId),
    },
  };
}

type Verified =
  | { status: "admitted"; admission: AdmissionReceipt }
  | { status: "unknown"; operationId: string };

/** The runtime's answer plus the wallet's own fresh read of exactly the signed map. */
async function verified(
  context: FaceRequestContext,
  rules: Rules,
  entry: FaceJournalEntry,
  result: Awaited<ReturnType<typeof ticketRuntimeCall>>,
): Promise<Verified> {
  const unknown = {
    status: "unknown" as const,
    operationId: entry.operationId,
  };
  const read = await freshTicket(context, rules, entry.objectId);
  if (!read.ok || !freshShowsAdmissionHash(read.fresh.custom, entry))
    return unknown;
  const verification = parseAdmissionVerification(
    result.ok ? result : { status: result.status ?? 0, body: result.body },
    {
      objectId: entry.objectId,
      requestId: entry.admissionRequestId!,
      ...(entry.actionId ? { actionId: entry.actionId } : {}),
      custom: read.fresh.custom as Record<string, unknown>,
    },
  );
  return verification.status === "admitted"
    ? { status: "admitted", admission: verification.admission }
    : unknown;
}

/** The fresh map is exactly the one this step was confirmed for (its hash). */
function freshShowsAdmissionHash(custom: unknown, entry: FaceJournalEntry) {
  return Boolean(entry.inputHash) && mapHash(custom) === entry.inputHash;
}

/**
 * After the holder's execute: record its action id, then verify. Anything
 * short of an exact, request-bound runtime verification plus the wallet's own
 * readback of the signed map stays `unknown` under the original operation.
 */
export async function recordAndVerifyAdmission(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
  operationId: unknown,
  actionId: unknown,
): Promise<AdmissionResult<{ outcome: Verified }>> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const entry = admissionEntry(context, operationId, objectId);
  if (!entry) return fail("unknown_operation", 404);
  if (
    typeof actionId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(actionId)
  ) {
    return fail("invalid_request", 400);
  }
  const recorded = applyIn(context.journal, {
    kind: "record_action",
    operationId: entry.operationId,
    actionId,
  });
  if (!recorded.ok) return recorded;
  const input = {
    action_id: actionId,
    proposal_id: entry.proposalId,
    request_id: entry.admissionRequestId,
  };
  const answer = await call(
    context,
    request,
    recorded.journal,
    "admission.verify",
    entry.operationId,
    entry.objectId,
    input,
  );
  if (!answer.ok) {
    return {
      ok: true,
      journal: recorded.journal,
      outcome: { status: "unknown", operationId: entry.operationId },
    };
  }
  const outcome = await verified(context, rules, recorded.entry, answer.result);
  return settleIfAdmitted(answer.journal, entry, outcome);
}

function settleIfAdmitted(
  journal: FaceJournal,
  entry: FaceJournalEntry,
  outcome: Verified,
): AdmissionResult<{ outcome: Verified }> {
  if (outcome.status !== "admitted") return { ok: true, journal, outcome };
  const own = journal.entries.some(
    (item) => item.operationId === entry.operationId,
  );
  if (!own) return { ok: true, journal, outcome };
  const settled = applyIn(journal, {
    kind: "settle",
    operationId: entry.operationId,
    status: "registered",
  });
  return { ok: true, journal: settled.ok ? settled.journal : journal, outcome };
}

/**
 * Read-only status of a sent step under its original operation (this launch,
 * or another launch after a reopen). Never signs, reserves or sends again.
 */
export async function admissionStatus(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
  operationId: unknown,
): Promise<AdmissionResult<{ outcome: Verified }>> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  // Only this programme's and this URL's ticket: another ticket's operation
  // is not found here.
  const entry = [
    ...context.journal.entries,
    ...readFaceAdmissionHistory(request, context.scope),
  ].find(
    (item) =>
      item.operationId === operationId &&
      item.slug === context.binding.slug &&
      item.objectId === objectId &&
      sentAdmissionStep(item),
  );
  if (!entry) return fail("unknown_operation", 404);
  const input = {
    proposal_id: entry.proposalId,
    request_id: entry.admissionRequestId,
  };
  const answer = await call(
    context,
    request,
    context.journal,
    "admission.status",
    entry.operationId,
    entry.objectId,
    input,
  );
  if (!answer.ok) return answer.failure;
  const outcome = await verified(context, rules, entry, answer.result);
  return settleIfAdmitted(answer.journal, entry, outcome);
}

/** The runtime's holder-bound pass and its verified original issuance proof. */
export async function readPass(
  context: FaceRequestContext,
  request: NextRequest,
  objectId: string,
): Promise<AdmissionResult<{ pass: TicketPass }>> {
  const rules = admissionRules(context);
  if (!rules) return fail("capability_not_granted", 403);
  const read = await freshTicket(context, rules, objectId);
  if (!read.ok) return read;
  const answer = await call(
    context,
    request,
    context.journal,
    "ticket.pass.read",
    operationIdOf("rd"),
    objectId,
    {},
  );
  if (!answer.ok) return answer.failure;
  const journal = answer.journal;
  const pass = answer.result.ok
    ? parseTicketPass(answer.result.body, objectId, read.fresh.custom)
    : undefined;
  return pass
    ? { ok: true, journal, pass }
    : { ...fail("pass_unavailable", answer.result.ok ? 409 : 404), journal };
}
