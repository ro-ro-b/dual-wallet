// ticket-admission-v1 (P4.3, docs/development/p4-3-admission-contract.md): the
// holder confirms a gate's admission request for their own ticket in the
// wallet and signs exactly one update of it. Framework-free rules shared by
// the binding parser, the BFF and the native ticket page.
//
// The admission write of the closed ticket template is the runtime's own:
// over a fresh read of the ticket's 16-key custom map, exactly four leaves
// change (state, admissionStatus, operation_id, idempotency_key). Entry is
// confirmed only by the runtime's request-bound verification plus the
// wallet's own fresh read of exactly that map; Dual's state alone never is.
import {
  canonicalJson,
  isOperationId,
  matchCompleteTemplate,
  parseSettleLeaves,
  type SettleTemplateLeaf,
} from "./product-face";

export const ADMISSION_CONTRACT = "ticket-admission-v1";

/**
 * The runtime operations of ticket-admission-v1. Host-only: the wallet BFF
 * mints them for its own native Tickets pages; they are not face runtime
 * operations, so no face can ask the assertion route for one.
 */
export const ticketHostOperations = [
  "ticket.pass.read",
  "admission.pending.read",
  "admission.propose",
  "admission.reserve",
  "admission.verify",
  "admission.status",
] as const;
export type TicketHostOperation = (typeof ticketHostOperations)[number];

export function isTicketHostOperation(
  value: unknown,
): value is TicketHostOperation {
  return (
    typeof value === "string" &&
    (ticketHostOperations as readonly string[]).includes(value)
  );
}

/** The closed ticket template's custom keys (Studio FIXED_SCHEMA_TICKET_CUSTOM_FIELDS). */
export const ADMISSION_CUSTOM_KEYS = [
  "accessClass",
  "activation_hash",
  "admissionStatus",
  "admissionWindowEndsAt",
  "admissionWindowStartsAt",
  "app_namespace",
  "eventRef",
  "idempotency_key",
  "operation_id",
  "product_type",
  "recipient_mint_projection",
  "recordId",
  "seatRef",
  "state",
  "title",
  "venueRef",
] as const;

/** The four leaves the admission write governs, exactly as the contract states them. */
const ADMISSION_LEAVES: Record<string, SettleTemplateLeaf> = {
  "data.custom.state": { enum: ["Admitted"] },
  "data.custom.admissionStatus": { enum: ["Admitted"] },
  "data.custom.operation_id": { runtimeIssued: "^op_[0-9a-f]{40}$" },
  "data.custom.idempotency_key": {
    runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$",
  },
};
const FROM_STATES = ["Valid"];
const TARGET_STATES = ["Admitted"];
const BLOCK_KEYS = [
  "contract",
  "action",
  "inputPath",
  "leaves",
  "customKeys",
  "fromStates",
  "targetStates",
  "preserveUnlisted",
];

export interface AdmissionRules {
  contract: typeof ADMISSION_CONTRACT;
  action: "update";
  /** Root-relative dotted leaf paths (`data.custom.state`, ...). */
  leaves: Record<string, SettleTemplateLeaf>;
  customKeys: readonly string[];
  fromStates: string[];
  targetStates: string[];
  preserveUnlisted: true;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const sameJson = (left: unknown, right: unknown) => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

/**
 * The optional `tickets.admission` block. Absent: null (P4.2, no entry). It
 * must state the contract EXACTLY: any other value is invalid (undefined),
 * so a binding never widens what the holder may sign.
 */
export function parseAdmissionRules(
  value: unknown,
): AdmissionRules | null | undefined {
  if (value === undefined) return null;
  if (!record(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== BLOCK_KEYS.length ||
    !BLOCK_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return undefined;
  }
  if (
    value.contract !== ADMISSION_CONTRACT ||
    value.action !== "update" ||
    value.inputPath !== "data.custom" ||
    value.preserveUnlisted !== true ||
    !sameJson(value.fromStates, FROM_STATES) ||
    !sameJson(value.targetStates, TARGET_STATES) ||
    !Array.isArray(value.customKeys) ||
    !sameJson([...value.customKeys].sort(), [...ADMISSION_CUSTOM_KEYS])
  ) {
    return undefined;
  }
  const leaves = parseSettleLeaves(value.leaves, TARGET_STATES, "data.custom");
  if (!leaves || !sameJson(leaves, ADMISSION_LEAVES)) return undefined;
  return {
    contract: ADMISSION_CONTRACT,
    action: "update",
    leaves,
    customKeys: ADMISSION_CUSTOM_KEYS,
    fromStates: FROM_STATES,
    targetStates: TARGET_STATES,
    preserveUnlisted: true,
  };
}

// ---------------------------------------------------------------- runtime

export const ADMISSION_REQUEST_ID = /^tad-[0-9a-f]{32}$/;
const PROPOSAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const EVENT_REF = /^[^\u0000-\u001f\u007f<>]{1,160}$/;
export const PASS_CODE = /^DT1\.[A-Za-z0-9][A-Za-z0-9._-]{2,79}\.[a-f0-9]{20}$/;

const time = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;

export interface AdmissionRequest {
  requestId: string;
  eventRef: string;
  createdAt: string;
  expiresAt: string;
}

export interface AdmissionReceipt {
  requestId: string;
  actionId: string;
  admittedAt: string;
  receiptId: string;
}

/** The admission map a fresh Dual read must show for entry to count. */
export interface AdmissionReadback {
  operationId: string;
  idempotencyKey: string;
}

export type AdmissionPending =
  | { status: "none" }
  | {
      status: "awaiting_holder" | "expired" | "admission_unverified";
      request: AdmissionRequest;
    }
  | {
      status: "admitted";
      admission: AdmissionReceipt;
      readback: AdmissionReadback;
    };

function parseRequest(value: unknown): AdmissionRequest | undefined {
  if (!record(value)) return undefined;
  const createdAt = time(value.created_at);
  const expiresAt = time(value.expires_at);
  if (
    typeof value.request_id !== "string" ||
    !ADMISSION_REQUEST_ID.test(value.request_id) ||
    typeof value.event_ref !== "string" ||
    !EVENT_REF.test(value.event_ref) ||
    !createdAt ||
    !expiresAt
  ) {
    return undefined;
  }
  return {
    requestId: value.request_id,
    eventRef: value.event_ref,
    createdAt,
    expiresAt,
  };
}

function parseReceipt(value: unknown): AdmissionReceipt | undefined {
  if (!record(value)) return undefined;
  const admittedAt = time(value.admitted_at);
  if (
    typeof value.request_id !== "string" ||
    !ADMISSION_REQUEST_ID.test(value.request_id) ||
    typeof value.action_id !== "string" ||
    !ACTION_ID.test(value.action_id) ||
    typeof value.receipt_id !== "string" ||
    !RECEIPT_ID.test(value.receipt_id) ||
    !admittedAt
  ) {
    return undefined;
  }
  return {
    requestId: value.request_id,
    actionId: value.action_id,
    admittedAt,
    receiptId: value.receipt_id,
  };
}

const OPERATION = /^op_[0-9a-f]{40}$/;
const IDEMPOTENCY = /^tig:dual-operation:[0-9a-f]{64}$/;

/** The runtime's fresh admission readback: exactly the committed map's identifiers. */
function parseReadback(value: unknown): AdmissionReadback | undefined {
  if (
    !record(value) ||
    value.state !== "Admitted" ||
    value.admission_status !== "Admitted" ||
    typeof value.operation_id !== "string" ||
    !OPERATION.test(value.operation_id) ||
    typeof value.idempotency_key !== "string" ||
    !IDEMPOTENCY.test(value.idempotency_key)
  ) {
    return undefined;
  }
  return {
    operationId: value.operation_id,
    idempotencyKey: value.idempotency_key,
  };
}

/** admission.pending.read (§5.2), for exactly `objectId`. */
export function parseAdmissionPending(
  body: Record<string, unknown>,
  objectId: string,
): AdmissionPending | undefined {
  if (body.ok !== true || body.object_id !== objectId) return undefined;
  if (body.status === "none") return { status: "none" };
  if (
    body.status === "awaiting_holder" ||
    body.status === "expired" ||
    body.status === "admission_unverified"
  ) {
    const request = parseRequest(body.request);
    return request ? { status: body.status, request } : undefined;
  }
  if (body.status === "admitted") {
    const admission = parseReceipt(body.admission);
    const readback = record(body.admission)
      ? parseReadback(body.admission.readback)
      : undefined;
    return admission && readback
      ? { status: "admitted", admission, readback }
      : undefined;
  }
  return undefined;
}

/**
 * A fresh or reopened device: the runtime's `admitted` counts only when the
 * wallet's OWN fresh read shows that admission map now (§5.2, §6). A later
 * update, a holder's own self-update or drift leaves it unverified.
 */
export function freshShowsAdmittedReadback(
  freshCustom: unknown,
  readback: AdmissionReadback,
) {
  return (
    record(freshCustom) &&
    freshCustom.state === "Admitted" &&
    freshCustom.admissionStatus === "Admitted" &&
    freshCustom.operation_id === readback.operationId &&
    freshCustom.idempotency_key === readback.idempotencyKey
  );
}

// ------------------------------------------------------------- issuance

/** ticket-issuance-proof-v1 (§5.1): the ORIGINAL birth, every check verified. */
export interface IssuanceProof {
  recordId: string;
  objectId: string;
  /** The immutable issuance content identity; never an operation id. */
  activationHash: string;
  birthOperationId: string;
  birthIdempotencyKey: string;
  birthActionId: string;
  /** `superseded`: a later update replaced operation_id on the object. */
  operationReadback: "current" | "superseded";
}

const RECORD = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const ACTIVATION = /^[0-9a-f]{64}$/;

function parseIssuance(value: unknown, objectId: string) {
  if (!record(value) || value.schema_version !== "ticket-issuance-proof-v1") {
    return undefined;
  }
  const evidence = record(value.evidence) ? value.evidence : {};
  if (
    typeof value.record_id !== "string" ||
    !RECORD.test(value.record_id) ||
    value.object_id !== objectId ||
    typeof value.activation_hash !== "string" ||
    !ACTIVATION.test(value.activation_hash) ||
    typeof value.birth_operation_id !== "string" ||
    !OPERATION.test(value.birth_operation_id) ||
    typeof value.birth_idempotency_key !== "string" ||
    !IDEMPOTENCY.test(value.birth_idempotency_key) ||
    typeof value.birth_action_id !== "string" ||
    !ACTION_ID.test(value.birth_action_id) ||
    evidence.birth_action !== "verified" ||
    evidence.activation_hash !== "verified" ||
    evidence.operation_commitment !== "verified" ||
    (evidence.operation_readback !== "current" &&
      evidence.operation_readback !== "superseded")
  ) {
    return undefined;
  }
  return {
    recordId: value.record_id,
    objectId,
    activationHash: value.activation_hash,
    birthOperationId: value.birth_operation_id,
    birthIdempotencyKey: value.birth_idempotency_key,
    birthActionId: value.birth_action_id,
    operationReadback: evidence.operation_readback,
  } satisfies IssuanceProof;
}

export interface TicketPass {
  code: string;
  /** Absent unless every issuance check holds: then no issue operation is shown. */
  issuance: IssuanceProof | null;
}

/**
 * ticket.pass.read (§5.1). The issuance proof must match this object and the
 * wallet's own fresh read: `activation_hash` as on Dual now, and a
 * `current` operation readback only while the object still names the birth
 * operation.
 */
export function parseTicketPass(
  body: Record<string, unknown>,
  objectId: string,
  freshCustom: unknown,
): TicketPass | undefined {
  if (
    body.ok !== true ||
    body.status !== "ticket_pass_ready" ||
    body.object_id !== objectId ||
    !record(body.pass) ||
    body.pass.schema_version !== "tig-ticket-pass-code-v1" ||
    typeof body.pass.code !== "string" ||
    !PASS_CODE.test(body.pass.code)
  ) {
    return undefined;
  }
  const proof = parseIssuance(body.issuance, objectId);
  const fresh = record(freshCustom) ? freshCustom : {};
  const consistent =
    proof &&
    fresh.activation_hash === proof.activationHash &&
    fresh.recordId === proof.recordId &&
    (proof.operationReadback === "current"
      ? fresh.operation_id === proof.birthOperationId &&
        fresh.idempotency_key === proof.birthIdempotencyKey
      : fresh.operation_id !== proof.birthOperationId);
  return { code: body.pass.code, issuance: consistent ? proof : null };
}

export interface AdmissionProposal {
  proposalId: string;
  requestId: string;
  objectId: string;
  action: "update";
  /** `{ data: { custom } }`: the complete custom map the holder signs. */
  input: { data: { custom: Record<string, unknown> } };
  proposalHash: string;
  expiresAt: string;
}

/** admission.propose (§5.3). The hash is checked by the caller (server). */
export function parseAdmissionProposal(
  body: Record<string, unknown>,
): AdmissionProposal | undefined {
  if (
    body.ok !== true ||
    body.status !== "proposed" ||
    !record(body.proposal)
  ) {
    return undefined;
  }
  const value = body.proposal;
  const expiresAt = time(value.expires_at);
  const input = value.input;
  if (
    typeof value.proposal_id !== "string" ||
    !PROPOSAL_ID.test(value.proposal_id) ||
    typeof value.request_id !== "string" ||
    !ADMISSION_REQUEST_ID.test(value.request_id) ||
    typeof value.object_id !== "string" ||
    !OBJECT_ID.test(value.object_id) ||
    value.action !== "update" ||
    typeof value.proposal_hash !== "string" ||
    !HASH.test(value.proposal_hash) ||
    !expiresAt ||
    !record(input) ||
    Object.keys(input).join(",") !== "data" ||
    !record(input.data) ||
    Object.keys(input.data).join(",") !== "custom" ||
    !record(input.data.custom)
  ) {
    return undefined;
  }
  return {
    proposalId: value.proposal_id,
    requestId: value.request_id,
    objectId: value.object_id,
    action: "update",
    input: { data: { custom: input.data.custom } },
    proposalHash: value.proposal_hash,
    expiresAt,
  };
}

/** Canonical JSON the runtime hashes for a proposal (§5.3). */
export function admissionProposalHashInput(proposal: AdmissionProposal) {
  return canonicalJson({
    object_id: proposal.objectId,
    action: proposal.action,
    input: proposal.input,
  });
}

export type AdmissionProposalCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "proposal_rejected"
        | "admission_unsupported"
        | "admission_request_expired";
    };

/**
 * The proposal is untrusted until it is this ticket's, for this request,
 * unexpired, and EXACTLY the contract's write over the wallet's own fresh
 * read: the 16 closed-template keys, `Valid` now, four governed leaves, and
 * every other key deep-equal to the fresh read (r17 completeCustomMap).
 */
export function checkAdmissionProposal(
  proposal: AdmissionProposal,
  expected: {
    objectId: string;
    requestId: string;
    requestExpiresAt: string;
    now: number;
  },
  freshCustom: unknown,
  rules: AdmissionRules,
): AdmissionProposalCheck {
  if (
    !record(freshCustom) ||
    !sameJson(Object.keys(freshCustom).sort(), [...rules.customKeys])
  ) {
    return { ok: false, reason: "admission_unsupported" };
  }
  if (
    !rules.fromStates.includes(String(freshCustom.state)) ||
    freshCustom.admissionStatus !== freshCustom.state
  ) {
    return { ok: false, reason: "proposal_rejected" };
  }
  const expiry = Math.min(
    Date.parse(proposal.expiresAt),
    Date.parse(expected.requestExpiresAt),
  );
  if (!(expiry > expected.now)) {
    return { ok: false, reason: "admission_request_expired" };
  }
  if (
    proposal.objectId !== expected.objectId ||
    proposal.requestId !== expected.requestId ||
    proposal.action !== rules.action ||
    Date.parse(proposal.expiresAt) > Date.parse(expected.requestExpiresAt)
  ) {
    return { ok: false, reason: "proposal_rejected" };
  }
  const written = proposal.input.data.custom;
  if (!sameJson(Object.keys(written).sort(), [...rules.customKeys])) {
    return { ok: false, reason: "proposal_rejected" };
  }
  const governed = matchCompleteTemplate(
    proposal.input,
    rules.leaves,
    freshCustom,
  );
  if (!governed || governed.length !== Object.keys(rules.leaves).length) {
    return { ok: false, reason: "proposal_rejected" };
  }
  return { ok: true };
}

export type AdmissionVerification =
  | { status: "admitted"; admission: AdmissionReceipt }
  | { status: "outcome_unknown" }
  | { status: "mismatch" };

/**
 * admission.verify / admission.status (§5.5/§5.6). Admitted only for exactly
 * this request, object and the action the wallet executed (when known), with
 * the runtime's readback naming the proposal's own identifiers.
 */
export function parseAdmissionVerification(
  response: { status: number; body?: Record<string, unknown> },
  expected: {
    objectId: string;
    requestId: string;
    actionId?: string;
    custom: Record<string, unknown>;
  },
): AdmissionVerification {
  const body = response.body ?? {};
  if (response.status === 202 || body.status === "outcome_unknown") {
    return { status: "outcome_unknown" };
  }
  if (
    response.status !== 200 ||
    body.ok !== true ||
    body.status !== "admitted"
  ) {
    return { status: "mismatch" };
  }
  const value = record(body.admission) ? body.admission : {};
  const admission = parseReceipt(value);
  const readback = record(value.readback) ? value.readback : {};
  if (
    !admission ||
    value.object_id !== expected.objectId ||
    admission.requestId !== expected.requestId ||
    (expected.actionId !== undefined &&
      admission.actionId !== expected.actionId) ||
    readback.state !== "Admitted" ||
    readback.admission_status !== "Admitted" ||
    readback.operation_id !== expected.custom.operation_id ||
    readback.idempotency_key !== expected.custom.idempotency_key
  ) {
    return { status: "mismatch" };
  }
  return { status: "admitted", admission };
}

/** The wallet's own fresh read shows exactly the map the holder signed. */
export function freshShowsAdmission(
  freshCustom: unknown,
  signed: Record<string, unknown>,
) {
  return record(freshCustom) && sameJson(freshCustom, signed);
}

// ---------------------------------------------------------------- view

/** What the native confirmation shows: server-read facts only. */
export interface AdmissionConfirmation {
  operationId: string;
  objectId: string;
  request: AdmissionRequest;
  /** min(proposal expiry, request expiry). */
  expiresAt: string;
  event: { title: string; venue: string | null; startsAt: string | null };
  window: { startsAt: string | null; endsAt: string | null };
  /** The signed-in holder the gate request names (lowercase address). */
  holder: string;
  /** The intended effect: these leaves only. */
  effect: { from: string; to: "Admitted" };
}

/**
 * What the wallet knows about this ticket's entry. `unknown` keeps the
 * original operation: only its read-only status may be asked.
 */
export type AdmissionState =
  | { status: "none" }
  | { status: "expired"; request: AdmissionRequest }
  | { status: "awaiting_holder"; request: AdmissionRequest }
  /** The runtime says admitted, but no fresh exact proof holds now. */
  | { status: "unverified"; requestId: string }
  | { status: "admitted"; admission: AdmissionReceipt }
  /** Sent (reservation won): only its original operation's status may be read. */
  | { status: "unknown"; operationId: string };

/**
 * Whether the ticket may have changed by this state: an entry was verified,
 * recorded without proof, or sent with its outcome unknown. Earlier reads of
 * the ticket (its status, its pass proof) are then read again, never kept.
 */
export function admissionMayHaveWritten(state: AdmissionState): boolean {
  return (
    state.status === "admitted" ||
    state.status === "unverified" ||
    state.status === "unknown"
  );
}

export function parseAdmissionState(
  value: unknown,
): AdmissionState | undefined {
  if (!record(value)) return undefined;
  if (value.status === "none") return { status: "none" };
  if (
    value.status === "unverified" &&
    typeof value.requestId === "string" &&
    ADMISSION_REQUEST_ID.test(value.requestId)
  ) {
    return { status: "unverified", requestId: value.requestId };
  }
  if (value.status === "expired" || value.status === "awaiting_holder") {
    const request = record(value.request)
      ? {
          request_id: value.request.requestId,
          event_ref: value.request.eventRef,
          created_at: value.request.createdAt,
          expires_at: value.request.expiresAt,
        }
      : undefined;
    const parsed = parseRequest(request);
    return parsed ? { status: value.status, request: parsed } : undefined;
  }
  if (value.status === "admitted" && record(value.admission)) {
    const admission = parseReceipt({
      request_id: value.admission.requestId,
      action_id: value.admission.actionId,
      admitted_at: value.admission.admittedAt,
      receipt_id: value.admission.receiptId,
    });
    return admission ? { status: "admitted", admission } : undefined;
  }
  if (value.status === "unknown" && isOperationId(value.operationId)) {
    return { status: "unknown", operationId: value.operationId };
  }
  return undefined;
}
