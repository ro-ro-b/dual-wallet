import "server-only";

import type { NextRequest } from "next/server";
import { walletIssuerOrigin } from "@/api/face-assertion";
import {
  foundKey,
  MAX_FOUND,
  readOtherHeldRuntimeWrites,
  type FaceJournal,
} from "@/api/face-journal";
import {
  accountedReadOnly,
  acknowledgeRecovery,
  echoOf,
  hostRuntimeCall,
  readRecoveryList,
  readRegistrationStatus,
  readWriteStatus,
  recoveryAckRequest,
  recoveryListRequest,
  registrationStatusRequestHash,
  runtimeRequestHash,
  verifiedOutcomeProof,
  writeStatusRequest,
  type RecoveryItem,
  type RuntimeEcho,
  type UnreadableItem,
} from "@/api/face-runtime";
import {
  fail,
  mint,
  type FaceOperationFailure,
  type FaceOperationResult,
} from "@/api/product-face-operations";
import {
  publicUnitFacts,
  readPublicUnit,
  type FaceRequestContext,
} from "@/api/product-face-server";
import { sealForPurpose, unsealForPurpose } from "@/api/server-session";
import { hostJourneyEnabled } from "@/api/wallet-host";
import {
  isCaseId,
  isLinkedCaseOperation,
  isObjectId,
  isOperationId,
  type RuntimeOperation,
  sameHolder,
} from "@/app/_domain/product-face";
import {
  applyJournalTransition,
  type FaceJournalEntry,
} from "@/app/_domain/product-face-journal";
import { journeyOfJournalEntry } from "@/app/_domain/wallet-host";

// PROPOSED contract r20 (docs/proposals/runtime-write-status-r20.md), not
// deployed by any runtime: the host's durable recovery of this wallet's own
// operations whose outcome it may not have seen, without a cookie and without
// a remembered unit. Every runtime that does not answer exactly as the
// contract says is unsupported or unavailable here; nothing is then
// acknowledged, and the cookie-based retained listing keeps working.

/** Pages followed per runtime scan; more is reported as an incomplete check. */
const MAX_PAGES = 20;
/**
 * Items resolved per listing page, in the stable listing order. A listing
 * that leaves items unresolved returns a sealed continuation naming the last
 * key it resolved; the next page (the same launch asks for it) resolves the
 * items after that key, so a held or unknown prefix never starves a later
 * item and every item is reached in a bounded number of pages. Host-local
 * and deterministic: no store, no wire change, and the bound never makes a
 * complete scan incomplete or raises a journal or cookie limit.
 */
const MAX_RESOLVED = 25;
/** How long an acknowledgement ticket issued by a listing stays usable. */
const TICKET_TTL_MS = 60 * 60 * 1000;
/** How long a continuation stays usable (one launch's follow-up pages). */
const CONTINUATION_TTL_MS = 10 * 60 * 1000;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The contract's one outcome vocabulary, plus the host's own two states. */
export type RecoveredOutcome =
  | "registered"
  | "transfer_request_committed"
  | "transferred"
  | "write_applied"
  | "write_refused"
  | "outcome_unknown"
  | "not_checked";

/**
 * Who holds the unit of a proved transfer outcome NOW, for this wallet, from
 * a fresh read of Dual's public projection under the binding's registration
 * rules: this wallet, registered (`registered`); this wallet, not registered
 * (`held`); another wallet (`elsewhere`). The outcome itself stays exactly
 * as proved from the historical record; this only tells the host which of
 * its present-tense words still hold.
 */
export type RecoveredHolding = "registered" | "held" | "elsewhere";

export interface RecoveredItem {
  operationId: string;
  kind: RecoveryItem["kind"];
  operation: string;
  objectId: string;
  caseId: string | null;
  offerId: string | null;
  step: RecoveryItem["step"];
  outcome: RecoveredOutcome;
  /**
   * Set only for a proved transfer offer, cancellation or transfer step whose
   * unit was read afresh; null for every other item and whenever that read
   * was unavailable, found nothing or found a unit outside the programme
   * (the host then keeps its original line).
   */
  holding: RecoveredHolding | null;
  /** Present only when the item may be acknowledged (contract §4). */
  ticket: string | null;
}

export interface RecoveryListing {
  /** False when no runtime of this face answers r20 at all. */
  supported: boolean;
  /** True only when every scoped runtime's scan was complete, validated and followed to its end. */
  complete: boolean;
  /** Items of a journey this host disables: neither resolved nor returned. */
  withheld: number;
  /** Items beyond this page's resolution bound, returned as not checked. */
  unchecked: number;
  /** Set when items remain beyond this page: the next page starts after them. */
  continuation: string | null;
  items: RecoveredItem[];
  /**
   * Sealed discovery tickets (applyDiscovery), one per held runtime write
   * of this launch, or of another launch of this wallet, face and
   * programme (`elsewhere`), that a complete, validated scan named exactly.
   * The listing writes nothing itself: the host hands them straight back
   * and the mark is applied against the journal as it is then.
   */
  discovered: string[];
  /** One entry per runtime asked: what was checked and, if not, why. */
  checks: RuntimeCheck[];
  /** Items listed by their identity only: shown as not checked, never resolved. */
  unreadable: UnreadableItem[];
}

/** One runtime the host lists from, and how mint routes an assertion to it. */
interface ScopedRuntime {
  origin: string;
  applicationId: string;
  /** Set for the linked Warranty runtime: mint routes case operations there. */
  audienceOf?: RuntimeOperation;
}

function scopedRuntimes(context: FaceRequestContext): ScopedRuntime[] {
  const own: ScopedRuntime = {
    origin: context.binding.origin,
    applicationId: context.binding.applicationId,
  };
  const linked = context.binding.linkedRuntimes
    .filter((runtime) => runtime.purpose === "claims-warranty")
    .map((runtime): ScopedRuntime => ({
      origin: runtime.origin,
      applicationId: runtime.applicationId,
      audienceOf: "case.read",
    }));
  return [own, ...linked];
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The §0 echoed binding of one answer against the session, this host, the
 * runtime the request was routed to, the face binding and the request sent.
 * Nothing is taken from the endpoint having answered.
 */
/**
 * The echoed fields that do not name this read: empty when the answer is
 * bound to this actor, host, runtime and binding. The holder is an address
 * (sameHolder); every other field is exact.
 */
function echoMismatches(
  context: FaceRequestContext,
  request: NextRequest,
  runtime: ScopedRuntime,
  operationId: string,
  echo: RuntimeEcho,
): string[] {
  const mismatches: string[] = [];
  if (echo.operationId !== operationId) mismatches.push("operation_id");
  if (!sameHolder(echo.holder, context.holder)) mismatches.push("holder");
  if (echo.wallet !== context.wallet.id) mismatches.push("wallet");
  if (echo.issuer !== walletIssuerOrigin(request)) mismatches.push("issuer");
  if (echo.applicationId !== runtime.applicationId) {
    mismatches.push("application_id");
  }
  if (echo.programme !== context.binding.programmeId) {
    mismatches.push("programme");
  }
  if (
    echo.assertingArtifact.version !== context.binding.version ||
    echo.assertingArtifact.artifactHash !== context.binding.artifactHash
  ) {
    mismatches.push("asserting_artifact");
  }
  return mismatches;
}

function echoMatches(
  context: FaceRequestContext,
  request: NextRequest,
  runtime: ScopedRuntime,
  operationId: string,
  echo: RuntimeEcho,
) {
  return (
    echoMismatches(context, request, runtime, operationId, echo).length === 0
  );
}

/**
 * The additive r20 fields of an existing resolver's committed answer
 * (contract §0): the echo and the business counters at zero, checked by the
 * same validators the r20 readers use. Without them the answer is pre-r20
 * for that operation and proves nothing here.
 */
function committedAnswerEcho(body: Record<string, unknown>) {
  if (body.contract !== "r20" || !accountedReadOnly(body, 0)) return undefined;
  return echoOf(body);
}

/** Why one runtime's scan is not a complete check (host-owned words). */
export type ScanIncompleteReason =
  /** The runtime itself declared a page incomplete (a store it could not read to its end). */
  | "runtime_incomplete"
  /** A page's echo named another actor, host, runtime or binding (the fields in `detail`). */
  | "echo_mismatch"
  /** A page carried an `as_of` or `recorded_at` that is not a time, or a record after `as_of`. */
  | "time_invalid"
  /** A later page changed the scan's snapshot (`scan_id` or `as_of`). */
  | "snapshot_changed"
  /** A page's `next` cursor was seen before in this scan. */
  | "cursor_cycle"
  /** Items were not strictly increasing in (recorded_at, operation_id). */
  | "out_of_order"
  /** More pages than the host follows in one check. */
  | "pages_exceeded"
  /** A page after the first could not be minted or read. */
  | "read_failed"
  /** The runtime listed an item this wallet cannot read in full. */
  | "item_unreadable";

type Scan =
  /** An older runtime: 400 face_request_invalid on the first page. */
  | { status: "unsupported" }
  /** Nothing listed: the first page could not be minted (`unsigned`) or read. */
  | { status: "unavailable"; reason: "unreachable" | "invalid" | "unsigned" }
  | {
      status: "listed";
      items: RecoveryItem[];
      unreadable: UnreadableItem[];
      complete: boolean;
      reason: ScanIncompleteReason | null;
      /** For echo_mismatch: the echoed fields that did not match. */
      detail: string[] | null;
    };

const incomplete = (
  items: RecoveryItem[],
  unreadable: UnreadableItem[],
  reason: ScanIncompleteReason,
  detail: string[] | null = null,
): Scan => ({
  status: "listed",
  items,
  unreadable,
  complete: false,
  reason,
  detail,
});

/** Strict order of a scan: (recorded_at, operation_id) ascending. */
function follows(previous: RecoveryItem | undefined, item: RecoveryItem) {
  if (!previous) return true;
  const before = Date.parse(previous.recordedAt);
  const now = Date.parse(item.recordedAt);
  if (before < now) return true;
  return before === now && previous.operationId < item.operationId;
}

/**
 * One runtime's scan: the pages of one snapshot followed to the end, each
 * page's binding, snapshot and order validated (contract §2). The host's own
 * reads: their assertions never reach a face, so none is kept against the
 * launch's outstanding cap.
 */
async function scanRuntime(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  runtime: ScopedRuntime,
): Promise<Scan> {
  const items: RecoveryItem[] = [];
  const unreadable: UnreadableItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let snapshot: { scanId: string; asOf: number } | undefined;
  let complete = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = recoveryListRequest(`recovery-${hex(10)}`, cursor);
    const minted = mint(context, request, journal, {
      operation: "recovery.list",
      operationId: read.operationId,
      target: {},
      requestHash: runtimeRequestHash(read),
      ...(runtime.audienceOf ? { audienceOf: runtime.audienceOf } : {}),
    });
    if (!minted.ok) {
      return page === 0
        ? { status: "unavailable", reason: "unsigned" }
        : incomplete(items, unreadable, "read_failed");
    }
    const result = await readRecoveryList(runtime, read, minted.assertion);
    if (result.outcome === "unsupported") {
      // Only a first page says the runtime has no r20; later it is a failure.
      return page === 0
        ? { status: "unsupported" }
        : incomplete(items, unreadable, "read_failed");
    }
    if (result.outcome !== "listed") {
      // A first page that cannot be read lists nothing: the host falls back
      // to today's cookie-based retained steps rather than showing an empty
      // incomplete check as if the runtime had answered.
      return page === 0
        ? { status: "unavailable", reason: result.reason }
        : incomplete(items, unreadable, "read_failed");
    }
    const { page: listed } = result;
    const asOf = Date.parse(listed.asOf);
    const mismatch = echoMismatches(
      context,
      request,
      runtime,
      read.operationId,
      listed,
    );
    if (mismatch.length > 0) {
      return incomplete(items, unreadable, "echo_mismatch", mismatch);
    }
    if (Number.isNaN(asOf)) {
      return incomplete(items, unreadable, "time_invalid");
    }
    if (
      snapshot !== undefined &&
      (listed.scanId !== snapshot.scanId || asOf !== snapshot.asOf)
    ) {
      return incomplete(items, unreadable, "snapshot_changed");
    }
    if (listed.next !== null && cursors.has(listed.next)) {
      return incomplete(items, unreadable, "cursor_cycle");
    }
    snapshot ??= { scanId: listed.scanId, asOf };
    for (const item of listed.items) {
      const recordedAt = Date.parse(item.recordedAt);
      if (Number.isNaN(recordedAt) || recordedAt > asOf) {
        return incomplete(items, unreadable, "time_invalid");
      }
      if (!follows(items.at(-1), item)) {
        return incomplete(items, unreadable, "out_of_order");
      }
      items.push(item);
    }
    unreadable.push(...listed.unreadable);
    complete = complete && listed.complete;
    if (listed.next === null) {
      // An item this wallet could not read is a violation of the page's
      // form (contract §2): the check is incomplete, and what it did list
      // is shown but nothing of it is acknowledged.
      if (unreadable.length > 0) {
        return incomplete(items, unreadable, "item_unreadable");
      }
      return {
        status: "listed",
        items,
        unreadable,
        complete,
        reason: complete ? null : "runtime_incomplete",
        detail: null,
      };
    }
    cursors.add(listed.next);
    cursor = listed.next;
  }
  // The scan goes on beyond what the host follows: not a complete check.
  return incomplete(items, unreadable, "pages_exceeded");
}

/**
 * What the host tells the person about each runtime it asked (host-owned
 * words, never face text): whether its records were checked and, when not,
 * why, so an incomplete check names the runtime and the cause.
 */
export interface RuntimeCheck {
  /** The face's own runtime (product records) or the linked Warranty runtime (service records). */
  runtime: "product" | "service";
  status: "checked" | "incomplete" | "unavailable" | "unsupported";
  reason: ScanIncompleteReason | "unreachable" | "invalid" | "unsigned" | null;
  /** For echo_mismatch: the echoed fields that did not match this read. */
  detail: string[] | null;
  /** Items listed by this runtime that this wallet could not read in full. */
  unreadable: number;
}

function checkOf(runtime: ScopedRuntime, scan: Scan): RuntimeCheck {
  const kind = runtime.audienceOf ? "service" : "product";
  switch (scan.status) {
    case "listed":
      return {
        runtime: kind,
        status: scan.complete ? "checked" : "incomplete",
        reason: scan.reason,
        detail: scan.detail,
        unreadable: scan.unreadable.length,
      };
    case "unavailable":
      return {
        runtime: kind,
        status: "unavailable",
        reason: scan.reason,
        detail: null,
        unreadable: 0,
      };
    case "unsupported":
      return {
        runtime: kind,
        status: "unsupported",
        reason: null,
        detail: null,
        unreadable: 0,
      };
  }
}

interface Proof {
  hash: string;
  originalOperation: string;
  target: { object_id: string; case_id?: string };
}

type Resolution = { outcome: RecoveredOutcome; proof?: Proof };

const UNKNOWN: Resolution = { outcome: "outcome_unknown" };

/**
 * The proof's identities against the listed original (contract §0): the
 * unit, and per kind the offer and step, the proposal, and the action, which
 * must equal the listed one when the listing carried it and otherwise be a
 * well-formed action id (a reconcile may find the action only now).
 */
function proofNamesItem(proof: Record<string, unknown>, item: RecoveryItem) {
  const actionMatches =
    item.actionId !== null
      ? proof.action_id === item.actionId
      : typeof proof.action_id === "string" && ACTION_ID.test(proof.action_id);
  if (proof.object_id !== item.objectId) return false;
  if (item.kind === "registration") {
    // A registration's action id may be absent on both sides.
    return item.actionId === null
      ? proof.action_id === null || actionMatches
      : actionMatches;
  }
  if (item.kind === "settle") {
    return proof.proposal_id === item.proposalId && actionMatches;
  }
  return (
    proof.offer_id === item.offerId && proof.step === item.step && actionMatches
  );
}

/**
 * The outcome of one listed item through the existing resolver of its kind,
 * each proving it from the historical canonical record and returning the
 * contract's outcome_proof. Read-only: nothing is reserved, re-sent or
 * executed, and this launch's journal is never written for it.
 */
async function resolveItem(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  runtime: ScopedRuntime,
  item: RecoveryItem,
): Promise<Resolution> {
  const target = {
    object_id: item.objectId,
    ...(item.caseId ? { case_id: item.caseId } : {}),
  };
  if (item.kind === "runtime") {
    const read = writeStatusRequest(item.operationId, target, item.operation);
    const minted = mint(context, request, journal, {
      operation: "write.status",
      operationId: item.operationId,
      target: read.target,
      requestHash: runtimeRequestHash(read),
      audienceOf: item.operation as RuntimeOperation,
    });
    if (!minted.ok) return UNKNOWN;
    const result = await readWriteStatus(runtime, read, minted.assertion);
    if (result.outcome === "held") return UNKNOWN;
    const { record: recorded } = result;
    // Applied or refused, the answer is this write's only with its binding.
    if (
      !echoMatches(context, request, runtime, item.operationId, recorded) ||
      recorded.operation !== item.operation ||
      recorded.objectId !== item.objectId ||
      recorded.caseId !== item.caseId
    ) {
      return UNKNOWN;
    }
    if (result.outcome === "refused") return { outcome: "write_refused" };
    // A server-only effect is proved only with its fresh Dual target
    // readback ("absent" is held, a decision for Root: contract §5); a
    // Dual-backed one only with its minimal bound proof (the client checks).
    if (
      recorded.dual.backed === false &&
      recorded.dual.targetReadback !== "verified"
    ) {
      return UNKNOWN;
    }
    return {
      outcome: "write_applied",
      proof: {
        hash: recorded.outcomeHash,
        originalOperation: item.operation,
        target,
      },
    };
  }
  const expected: RecoveredOutcome =
    item.kind === "transfer"
      ? item.step === "request"
        ? "transfer_request_committed"
        : "transferred"
      : "registered";
  let body: Record<string, unknown> | undefined;
  let requestOperationId: string;
  if (item.kind === "registration") {
    requestOperationId = item.operationId;
    const minted = mint(context, request, journal, {
      operation: "registration.status",
      operationId: item.operationId,
      target: { object_id: item.objectId },
      requestHash: registrationStatusRequestHash(item.operationId),
    });
    if (!minted.ok) return UNKNOWN;
    const status = await readRegistrationStatus(
      runtime,
      item.operationId,
      minted.assertion,
    );
    if (status.outcome !== "answered" || status.status !== expected) {
      return UNKNOWN;
    }
    body = status.body;
  } else {
    // A settle or transfer step: the runtime's own read-only reconcile
    // through the Dual action logs (transfer.status, never transfer.verify:
    // the host holds no action id of its own for a recovered step). The
    // settle read is the one the face itself makes (contract r13): the
    // settle's OWN operation id, the unit, and no input; the runtime refuses
    // anything else. Its answer's proof names the proposal, checked below.
    const read =
      item.kind === "settle"
        ? {
            operation: "registration.settle.status" as const,
            operationId: item.operationId,
            target: { object_id: item.objectId },
            input: {},
          }
        : {
            operation: "transfer.status" as const,
            operationId: `status-${hex(10)}`,
            target: { object_id: item.objectId },
            input: {
              offer_id: item.offerId,
              step_operation_id: item.operationId,
            },
          };
    requestOperationId = read.operationId;
    const minted = mint(context, request, journal, {
      operation: read.operation,
      operationId: read.operationId,
      target: read.target,
      requestHash: runtimeRequestHash(read),
    });
    if (!minted.ok) return UNKNOWN;
    const result = await hostRuntimeCall(runtime, read, minted.assertion);
    if (!result.ok || result.status !== 200) return UNKNOWN;
    if (result.body.status !== expected) return UNKNOWN;
    body = result.body;
  }
  if (!body) return UNKNOWN;
  const echo = committedAnswerEcho(body);
  if (
    !echo ||
    !echoMatches(context, request, runtime, requestOperationId, echo)
  ) {
    return UNKNOWN;
  }
  const proof = verifiedOutcomeProof(body, {
    kind: item.kind,
    operationId: item.operationId,
    status: expected,
  });
  if (!proof || !proofNamesItem(proof.proof, item)) return UNKNOWN;
  return {
    outcome: expected,
    proof: {
      hash: proof.hash,
      originalOperation: item.operation,
      target: { object_id: item.objectId },
    },
  };
}

/**
 * The proved outcomes whose host line says who holds the unit now: a
 * transfer offer ("still yours until the handover is done"), its
 * cancellation ("stays yours"), a committed request step ("the handover has
 * not been done yet") and a completed transfer step ("now belongs to the
 * recipient"). Registrations, settles and case writes claim nothing of it.
 */
function claimsHolding(item: RecoveryItem, outcome: RecoveredOutcome) {
  if (item.kind === "transfer") {
    return (
      outcome === "transfer_request_committed" || outcome === "transferred"
    );
  }
  return (
    item.kind === "runtime" &&
    outcome === "write_applied" &&
    (item.operation === "transfer.offer" ||
      item.operation === "transfer.cancel")
  );
}

/**
 * The unit's current holding for this wallet, from a fresh, uncached read of
 * Dual's public projection. Read-only; any failure, an absent unit, a unit
 * outside the programme or one without an owner is null, never a guess.
 */
async function currentHolding(
  context: FaceRequestContext,
  objectId: string,
): Promise<RecoveredHolding | null> {
  try {
    const unit = await readPublicUnit(objectId);
    if (!unit?.owner) return null;
    const facts = publicUnitFacts(context, unit);
    if (!context.binding.templateIds.includes(facts.templateId)) return null;
    if (!facts.readback.ownerIsYou) return "elsewhere";
    return facts.registration === "registered" ? "registered" : "held";
  } catch {
    return null;
  }
}

/** The contract's stable order key: (recorded_at, operation_id) ascending. */
interface ItemKey {
  recorded_at: string;
  operation_id: string;
}

const keyOf = (item: RecoveryItem): ItemKey => ({
  recorded_at: item.recordedAt,
  operation_id: item.operationId,
});

function compareKeys(left: ItemKey, right: ItemKey) {
  const byTime = Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
  if (byTime !== 0) return byTime;
  return left.operation_id < right.operation_id
    ? -1
    : left.operation_id > right.operation_id
      ? 1
      : 0;
}

interface Continuation {
  v: 1;
  /** The last key this launch resolved; the next page starts after it. */
  after: ItemKey;
  exp: number;
}

/** A continuation is this session's, wallet's, face's and launch's only. */
const continuationPurpose = (context: FaceRequestContext) =>
  [
    "dual-face-recovery-continue",
    context.owner.sidHash,
    context.wallet.id,
    context.binding.slug,
    context.binding.programmeId,
    context.scope.launchId,
  ].join(":");

function parseContinuation(
  context: FaceRequestContext,
  value: string,
): ItemKey | undefined {
  if (value.length > 2048) return undefined;
  const opened = unsealForPurpose(continuationPurpose(context), value);
  if (!record(opened) || opened.v !== 1 || !record(opened.after)) {
    return undefined;
  }
  const { after } = opened;
  if (
    typeof opened.exp !== "number" ||
    opened.exp <= Date.now() ||
    typeof after.recorded_at !== "string" ||
    Number.isNaN(Date.parse(after.recorded_at)) ||
    !isOperationId(after.operation_id)
  ) {
    return undefined;
  }
  return { recorded_at: after.recorded_at, operation_id: after.operation_id };
}

interface Ticket {
  v: 1;
  op: string;
  kind: RecoveryItem["kind"];
  original_operation: string;
  target: { object_id: string; case_id?: string };
  outcome_hash: string;
  /** The runtime the outcome was proved at: its application AND origin. */
  runtime: { application_id: string; origin: string };
  /** The face artifact the host served when it proved the outcome. */
  artifact: { version: string; artifact_hash: string };
  exp: number;
}

/** A ticket is this session's, this wallet's and this face launch's only. */
const ticketPurpose = (context: FaceRequestContext) =>
  [
    "dual-face-recovery-ack",
    context.owner.sidHash,
    context.wallet.id,
    context.binding.slug,
    context.binding.programmeId,
    context.scope.launchId,
  ].join(":");

const itemJourney = (item: Pick<RecoveryItem, "kind" | "operation">) =>
  journeyOfJournalEntry({ kind: item.kind, operation: item.operation });

/**
 * Whether the runtime that listed an item is the one that serves it: case
 * writes belong to the linked Warranty runtime, everything else (a
 * registration, settle or transfer step, a transfer offer or cancellation)
 * to the face's own. An item listed elsewhere is malformed: resolving it
 * would mint for one runtime and ask another, so it is reported as not
 * checked instead of as an unknown outcome.
 */
function belongsTo(runtime: ScopedRuntime, item: RecoveryItem) {
  const linked = runtime.audienceOf !== undefined;
  return item.kind === "runtime"
    ? isLinkedCaseOperation(item.operation as RuntimeOperation) === linked
    : !linked;
}

/** How many runtimes listed each operation id (a scan never repeats one). */
function listedCounts(listed: { item: RecoveryItem }[]) {
  const seen = new Map<string, number>();
  for (const { item } of listed) {
    seen.set(item.operationId, (seen.get(item.operationId) ?? 0) + 1);
  }
  return seen;
}

/**
 * Durable discovery, actually observed (contract §2): a complete scan
 * (every page validated and echo-bound, the runtime declaring every store
 * read to its end) of this actor's records, from the runtime that serves
 * the operation, naming exactly one held runtime write (same id, operation,
 * object and case, listed by one runtime only): one of this launch's
 * (`own`), or one another launch of this wallet, face and programme still
 * holds (a page left, a reload, a sign-in since; readOtherHeldRuntimeWrites).
 * Only that other launch could mark its own write, and it is gone, so its
 * cookie would otherwise pin the launch budget (launch_capacity) for its
 * whole lifetime. Nothing else is discovered: a scan the wallet found
 * violated, or one the runtime calls incomplete, discovers nothing even for
 * the items it did name. Pure: reads the scans, the journal and the request.
 */
function discoveredHeldWrites(
  context: FaceRequestContext,
  request: NextRequest,
  journal: FaceJournal,
  scans: { runtime: ScopedRuntime; scan: Scan }[],
) {
  const listed = scans.flatMap(({ runtime, scan }) =>
    scan.status === "listed"
      ? scan.items.map((item) => ({ runtime, item }))
      : [],
  );
  const seen = listedCounts(listed);
  const trusted = new Set(
    scans
      .filter(({ scan }) => scan.status === "listed" && scan.complete)
      .map(({ runtime }) => runtime),
  );
  const elsewhere = readOtherHeldRuntimeWrites(request, context.scope);
  return listed.flatMap(({ runtime, item }) => {
    if (
      !trusted.has(runtime) ||
      item.kind !== "runtime" ||
      !belongsTo(runtime, item) ||
      seen.get(item.operationId) !== 1
    ) {
      return [];
    }
    const own = heldRuntimeWriteNamed(context, journal, item);
    if (!own && !elsewhere.some((entry) => namesItem(entry, item))) return [];
    return [{ runtime, item, own }];
  });
}

/**
 * A new launch the budget would otherwise open read-only (launchCapacity):
 * the durable discoveries (FaceJournal.found) of the held runtime writes
 * other launches of this wallet, face and programme hold, from one
 * complete, validated scan of each scoped runtime, so that this launch can
 * keep its own cookie when every launch it would drop is then discoverable.
 * Without such a held write elsewhere nothing is read. Read-only: nothing is
 * resolved, acknowledged, re-sent or written to any runtime.
 */
export async function discoverPinnedLaunches(
  context: FaceRequestContext,
  request: NextRequest,
): Promise<string[]> {
  if (readOtherHeldRuntimeWrites(request, context.scope).length === 0) {
    return [];
  }
  const journal = context.journal;
  const scans = await Promise.all(
    scopedRuntimes(context).map(async (runtime) => ({
      runtime,
      scan: await scanRuntime(context, request, journal, runtime),
    })),
  );
  const keys = discoveredHeldWrites(context, request, journal, scans)
    .filter(({ own }) => !own)
    .map(({ item }) =>
      foundKey(
        context.owner.walletId,
        context.binding.slug,
        context.binding.programmeId,
        item,
      ),
    );
  return [...new Set([...(journal.found ?? []), ...keys])].slice(-MAX_FOUND);
}

/**
 * GET /api/faces/[slug]/recovery: this wallet's unresolved and unacknowledged
 * operations from the face's runtime and its linked runtime, each resolved
 * through its kind's resolver, with an acknowledgement ticket only for a
 * proved outcome of an enabled journey found by a complete check.
 */
export async function listRecovery(
  context: FaceRequestContext,
  request: NextRequest,
  continuation?: string,
): Promise<RecoveryListing | FaceOperationFailure> {
  const journal = context.journal;
  const scans = await Promise.all(
    scopedRuntimes(context).map(async (runtime) => ({
      runtime,
      scan: await scanRuntime(context, request, journal, runtime),
    })),
  );
  // Supported only when some runtime answered a page; a first page that
  // could not be read is not an answer, so the host keeps today's behaviour.
  const supported = scans.some(({ scan }) => scan.status === "listed");
  const checks = scans.map(({ runtime, scan }) => checkOf(runtime, scan));
  if (!supported) {
    return {
      supported: false,
      complete: true,
      withheld: 0,
      unchecked: 0,
      continuation: null,
      items: [],
      discovered: [],
      checks,
      unreadable: [],
    };
  }
  // A runtime without r20 beside one with it, or one that could not be
  // read: the check cannot be complete.
  const complete = scans.every(
    ({ scan }) => scan.status === "listed" && scan.complete,
  );
  const listed = scans.flatMap(({ runtime, scan }) =>
    scan.status === "listed"
      ? scan.items.map((item) => ({ runtime, item }))
      : [],
  );
  // An id listed by two runtimes (a scan itself never repeats one) is
  // conflicting: nothing is resolved or acknowledged for it.
  const seen = listedCounts(listed);
  const discovered = discoveredHeldWrites(context, request, journal, scans).map(
    ({ runtime, item, own }) =>
      sealForPurpose(discoveryPurpose(context), {
        v: 1,
        op: item.operationId,
        operation: item.operation,
        object_id: item.objectId,
        case_id: item.caseId,
        ...(own ? {} : { elsewhere: true as const }),
        runtime: {
          application_id: runtime.applicationId,
          origin: runtime.origin,
        },
        artifact: {
          version: context.binding.version,
          artifact_hash: context.binding.artifactHash,
        },
        exp: Date.now() + DISCOVERY_TTL_MS,
      } satisfies DiscoveryTicket),
  );
  let withheld = 0;
  const misrouted = new Set<string>();
  const eligible = listed
    .filter(({ runtime, item }) => {
      const journey = itemJourney(item);
      if (!journey || !hostJourneyEnabled(journey)) {
        withheld += 1;
        return false;
      }
      if (!belongsTo(runtime, item)) misrouted.add(item.operationId);
      return true;
    })
    // The contract's stable total order, across both runtimes.
    .sort((left, right) => compareKeys(keyOf(left.item), keyOf(right.item)));
  // This page: the items after the continuation's key, in order; the first
  // MAX_RESOLVED of them are resolved, the rest returned as not checked.
  const after = continuation
    ? parseContinuation(context, continuation)
    : undefined;
  // An expired, foreign or forged continuation is refused as such, so the
  // host restarts from the beginning instead of taking it for an incomplete
  // scan (nothing proved so far is lost).
  if (continuation && !after) return fail("continuation_invalid", 409);
  const page = after
    ? eligible.filter(({ item }) => compareKeys(keyOf(item), after) > 0)
    : eligible;
  const chosen = new Set<string>();
  let lastKey: ItemKey | undefined;
  for (const { item } of page) {
    if (chosen.size >= MAX_RESOLVED) break;
    // The same id from two runtimes is conflicting, and an item listed by a
    // runtime that does not serve it is malformed: neither is resolved, but
    // both advance the page so they are never reached again.
    if (
      (seen.get(item.operationId) ?? 0) === 1 &&
      !misrouted.has(item.operationId)
    ) {
      chosen.add(item.operationId);
    }
    lastKey = keyOf(item);
  }
  let unchecked = 0;
  const now = Date.now();
  const items: RecoveredItem[] = [];
  const conflicting = new Set<string>();
  // One fresh read per unit per page, made only for the items that need it.
  const holdings = new Map<string, Promise<RecoveredHolding | null>>();
  const holdingOf = (objectId: string) => {
    let read = holdings.get(objectId);
    if (!read) {
      read = currentHolding(context, objectId);
      holdings.set(objectId, read);
    }
    return read;
  };
  for (const { runtime, item } of page) {
    const base = {
      operationId: item.operationId,
      kind: item.kind,
      operation: item.operation,
      objectId: item.objectId,
      caseId: item.caseId,
      offerId: item.offerId,
      step: item.step,
    };
    if (!chosen.has(item.operationId)) {
      if ((seen.get(item.operationId) ?? 0) > 1) {
        if (conflicting.has(item.operationId)) continue;
        conflicting.add(item.operationId);
      } else if (!misrouted.has(item.operationId)) {
        unchecked += 1;
      }
      items.push({
        ...base,
        outcome: "not_checked",
        holding: null,
        ticket: null,
      });
      continue;
    }
    const { outcome, proof } = await resolveItem(
      context,
      request,
      journal,
      runtime,
      item,
    );
    // A ticket only for a proved outcome, and only when every scoped scan
    // was complete: an incomplete check acknowledges nothing.
    const ticket: Ticket | undefined =
      proof && complete
        ? {
            v: 1,
            op: item.operationId,
            kind: item.kind,
            original_operation: proof.originalOperation,
            target: proof.target,
            outcome_hash: proof.hash,
            runtime: {
              application_id: runtime.applicationId,
              origin: runtime.origin,
            },
            artifact: {
              version: context.binding.version,
              artifact_hash: context.binding.artifactHash,
            },
            exp: now + TICKET_TTL_MS,
          }
        : undefined;
    // A proved transfer outcome is historical: who holds the unit now is
    // read afresh, so the host never tells a completed or since-reversed
    // handover in the present tense. The outcome, its proof and its ticket
    // stay exactly as proved.
    const holding =
      proof && claimsHolding(item, outcome)
        ? await holdingOf(item.objectId)
        : null;
    items.push({
      ...base,
      outcome,
      holding,
      ticket: ticket ? sealForPurpose(ticketPurpose(context), ticket) : null,
    });
  }
  return {
    supported: true,
    complete,
    withheld,
    unchecked,
    continuation:
      unchecked > 0 && lastKey
        ? sealForPurpose(continuationPurpose(context), {
            v: 1,
            after: lastKey,
            exp: now + CONTINUATION_TTL_MS,
          } satisfies Continuation)
        : null,
    items,
    discovered,
    checks,
    unreadable: scans.flatMap(({ scan }) =>
      scan.status === "listed" ? scan.unreadable : [],
    ),
  };
}

/** A listing item that names exactly one of this launch's held runtime writes. */
function heldRuntimeWriteNamed(
  context: FaceRequestContext,
  journal: FaceJournal,
  item: RecoveryItem,
) {
  return journal.entries.some(
    (entry) =>
      entry.slug === context.binding.slug &&
      entry.kind === "runtime" &&
      entry.phase === "assertion_issued" &&
      entry.discoverable !== true &&
      namesItem(entry, item),
  );
}

/** The listed item's exact identity: operation id, operation, unit and case. */
function namesItem(
  entry: FaceJournalEntry,
  item: Pick<RecoveryItem, "operationId" | "operation" | "objectId" | "caseId">,
) {
  return (
    entry.operationId === item.operationId &&
    entry.operation === item.operation &&
    entry.objectId === item.objectId &&
    (entry.caseId ?? null) === item.caseId
  );
}

/**
 * What a complete listing proved about one held runtime write of this
 * launch, sealed for this session, wallet, face, programme and launch: the
 * record's exact identity and the runtime that listed it. Short-lived: the
 * host hands it back at once (POST .../recovery/discovered).
 */
interface DiscoveryTicket {
  v: 1;
  op: string;
  operation: string;
  object_id: string;
  case_id: string | null;
  /** Another launch's held write (readOtherHeldRuntimeWrites), not this one's. */
  elsewhere?: true;
  runtime: { application_id: string; origin: string };
  artifact: { version: string; artifact_hash: string };
  exp: number;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERY_TICKETS = 25;

const discoveryPurpose = (context: FaceRequestContext) =>
  [
    "dual-face-recovery-discovered",
    context.owner.sidHash,
    context.wallet.id,
    context.binding.slug,
    context.binding.programmeId,
    context.scope.launchId,
  ].join(":");

function parseDiscoveryTicket(
  context: FaceRequestContext,
  value: unknown,
): DiscoveryTicket | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const opened = unsealForPurpose(discoveryPurpose(context), value);
  if (!record(opened)) return undefined;
  const ticket = opened as Partial<DiscoveryTicket>;
  const runtime = ticket.runtime as
    Partial<DiscoveryTicket["runtime"]> | undefined;
  const artifact = ticket.artifact as
    Partial<DiscoveryTicket["artifact"]> | undefined;
  if (
    ticket.v !== 1 ||
    !isOperationId(ticket.op) ||
    typeof ticket.operation !== "string" ||
    !isObjectId(ticket.object_id) ||
    (ticket.case_id !== null && !isCaseId(ticket.case_id)) ||
    (ticket.elsewhere !== undefined && ticket.elsewhere !== true) ||
    !record(runtime) ||
    typeof runtime.application_id !== "string" ||
    typeof runtime.origin !== "string" ||
    !record(artifact) ||
    typeof artifact.version !== "string" ||
    typeof artifact.artifact_hash !== "string" ||
    typeof ticket.exp !== "number" ||
    ticket.exp <= Date.now()
  ) {
    return undefined;
  }
  return ticket as DiscoveryTicket;
}

/**
 * POST /api/faces/[slug]/recovery/discovered: marks the held runtime writes
 * named by the discovery tickets a complete listing issued in this same
 * launch, against this launch's journal as it is NOW (the listing never
 * writes the journal it read at its start, so a write journaled while the
 * scan ran is never overwritten). Each ticket is checked again: sealed for
 * this session, wallet, face, programme and launch; its runtime still bound
 * and its artifact still served; and the journal entry's exact identity
 * (the `discover` transition refuses any other). An `elsewhere` ticket is
 * recorded found in this launch's journal (FaceJournal.found) only while
 * another launch of this wallet, face and programme still holds exactly
 * that write; that launch's cookie is never rewritten. Nothing is sent
 * anywhere.
 */
export function applyDiscovery(
  context: FaceRequestContext,
  body: Record<string, unknown>,
): FaceOperationResult<{ marked: number }> {
  if (
    Object.keys(body).join(",") !== "discovered" ||
    !Array.isArray(body.discovered) ||
    body.discovered.length > MAX_DISCOVERY_TICKETS
  ) {
    return fail("invalid_request", 400);
  }
  const tickets = body.discovered.map((value) =>
    parseDiscoveryTicket(context, value),
  );
  if (tickets.some((ticket) => ticket === undefined)) {
    return fail("invalid_request", 400);
  }
  let journal = context.journal;
  let marked = 0;
  const now = Date.now();
  for (const ticket of tickets as DiscoveryTicket[]) {
    const runtime = scopedRuntimes(context).find(
      (candidate) =>
        candidate.applicationId === ticket.runtime.application_id &&
        candidate.origin === ticket.runtime.origin,
    );
    if (
      !runtime ||
      ticket.artifact.version !== context.binding.version ||
      ticket.artifact.artifact_hash !== context.binding.artifactHash
    ) {
      return fail("invalid_request", 400);
    }
    if (ticket.elsewhere) {
      const identity = {
        operationId: ticket.op,
        operation: ticket.operation,
        objectId: ticket.object_id,
        caseId: ticket.case_id,
      };
      const held = readOtherHeldRuntimeWrites(
        context.request,
        context.scope,
        now,
      ).some((entry) => namesItem(entry, identity));
      const key = foundKey(
        context.owner.walletId,
        context.binding.slug,
        context.binding.programmeId,
        identity,
      );
      const found = journal.found ?? [];
      if (!held || found.includes(key)) continue;
      journal = { ...journal, found: [...found, key].slice(-MAX_FOUND) };
      marked += 1;
      continue;
    }
    const own = journal.entries.find(
      (entry) =>
        entry.operationId === ticket.op && entry.slug === context.binding.slug,
    );
    if (!own || own.discoverable) continue;
    const result = applyJournalTransition(
      journal.entries,
      {
        kind: "discover",
        operationId: ticket.op,
        operation: ticket.operation,
        objectId: ticket.object_id,
        caseId: ticket.case_id,
      },
      now,
    );
    if (result.ok && result.entries !== journal.entries) {
      journal = { ...journal, entries: result.entries };
      marked += 1;
    }
  }
  return { ok: true, marked, ...(marked > 0 ? { journal } : {}) };
}

function parseTicket(
  context: FaceRequestContext,
  value: unknown,
  operationId: string,
): Ticket | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const opened = unsealForPurpose(ticketPurpose(context), value);
  if (!record(opened)) return undefined;
  const ticket = opened as Partial<Ticket>;
  const runtime = ticket.runtime as Partial<Ticket["runtime"]> | undefined;
  const artifact = ticket.artifact as Partial<Ticket["artifact"]> | undefined;
  if (
    ticket.v !== 1 ||
    ticket.op !== operationId ||
    !isOperationId(ticket.op) ||
    typeof ticket.kind !== "string" ||
    typeof ticket.original_operation !== "string" ||
    !record(ticket.target) ||
    !isObjectId(ticket.target.object_id) ||
    (ticket.target.case_id !== undefined && !isCaseId(ticket.target.case_id)) ||
    typeof ticket.outcome_hash !== "string" ||
    !record(runtime) ||
    typeof runtime.application_id !== "string" ||
    typeof runtime.origin !== "string" ||
    !record(artifact) ||
    typeof artifact.version !== "string" ||
    typeof artifact.artifact_hash !== "string" ||
    typeof ticket.exp !== "number" ||
    ticket.exp <= Date.now()
  ) {
    return undefined;
  }
  return ticket as Ticket;
}

/**
 * POST /api/faces/[slug]/recovery/ack: records at the runtime, idempotently,
 * that this host delivered one proved outcome. The ticket a complete listing
 * issued in this same launch names the outcome's hash, the runtime it was
 * proved at and the face artifact served then; the journey, the runtime
 * binding and the artifact are checked again now. Nothing of the business
 * record is modified.
 */
export async function acknowledgeRecoveredOutcome(
  context: FaceRequestContext,
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<FaceOperationResult<{ first: boolean }>> {
  if (
    Object.keys(body).sort().join(",") !== "operation_id,ticket" ||
    !isOperationId(body.operation_id)
  ) {
    return fail("invalid_request", 400);
  }
  const ticket = parseTicket(context, body.ticket, body.operation_id);
  if (!ticket) return fail("invalid_request", 400);
  const journey = itemJourney({
    kind: ticket.kind,
    operation: ticket.original_operation,
  });
  if (!journey || !hostJourneyEnabled(journey)) {
    return fail("capability_not_granted", 403);
  }
  // The same runtime (application and origin) must still be bound and the
  // same face artifact still served; otherwise the ticket is no longer valid.
  const runtime = scopedRuntimes(context).find(
    (candidate) =>
      candidate.applicationId === ticket.runtime.application_id &&
      candidate.origin === ticket.runtime.origin,
  );
  if (
    !runtime ||
    ticket.artifact.version !== context.binding.version ||
    ticket.artifact.artifact_hash !== context.binding.artifactHash
  ) {
    return fail("invalid_request", 400);
  }
  const ack = recoveryAckRequest(
    ticket.op,
    ticket.target,
    ticket.original_operation,
    ticket.outcome_hash,
  );
  const minted = mint(context, request, context.journal, {
    operation: "recovery.ack",
    operationId: ack.operationId,
    target: ack.target,
    requestHash: runtimeRequestHash(ack),
    ...(runtime.audienceOf ? { audienceOf: runtime.audienceOf } : {}),
  });
  if (!minted.ok) return minted;
  const result = await acknowledgeRecovery(runtime, ack, minted.assertion);
  if (
    result.outcome !== "acknowledged" ||
    !echoMatches(context, request, runtime, ticket.op, result.echo)
  ) {
    return fail("outcome_unknown", 409);
  }
  return { ok: true, first: result.first };
}
