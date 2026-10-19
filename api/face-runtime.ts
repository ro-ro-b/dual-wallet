import "server-only";

import { fetchBounded } from "@/api/face-artifact";
import { sha256Hash, type AssertionTarget } from "@/api/face-assertion";
import type { ProductFaceBinding } from "@/api/product-face-binding";
import { runtimeWorkloadAuth, TRUSTED_OIDC_HEADER } from "@/api/runtime-oidc";
import {
  isTicketHostOperation,
  type TicketHostOperation,
} from "@/app/_domain/ticket-admission";
import {
  canonicalJson,
  isCaseId,
  isCurrencyCode,
  isDecimalAmount,
  isObjectId,
  isOperationId,
  isQuoteVersion,
  isRequestHash,
  isRuntimeWriteOperation,
  type CaseQuote,
  type SettleProposal,
  type TrustedRuntimeRead,
} from "@/app/_domain/product-face";

/** Bound on any runtime answer (a settle or transfer proposal included). */
export const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;
const RUNTIME_ENDPOINT = "/api/product-face/v1/operations";
const REGISTRATION_STATUS_ENDPOINT =
  "/api/product-face/v1/registrations/status";
const PROPOSAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The one transport of every call to a bound runtime: `fetchBounded` (no
 * cookies, no redirects, bounded, timed out) plus, only for a destination in
 * TIG_RUNTIME_OIDC_ORIGINS, this deployment's workload token
 * (api/runtime-oidc.ts). A configured destination without a token is not
 * called at all: `undefined`, as for an unreachable runtime, and nothing is
 * sent. The token authenticates the deployment, never the holder.
 */
async function runtimeFetch(
  url: string,
  maxBytes: number,
  init: RequestInit & { headers: Record<string, string> },
  timeoutMs: number,
): ReturnType<typeof fetchBounded> {
  const auth = await runtimeWorkloadAuth(url);
  if (!auth.ok) return undefined;
  // Only this module sets the workload header, and only from the platform.
  const headers = Object.fromEntries(
    Object.entries(init.headers).filter(
      ([name]) => name.toLowerCase() !== TRUSTED_OIDC_HEADER,
    ),
  );
  return fetchBounded(
    url,
    maxBytes,
    { ...init, headers: { ...headers, ...auth.headers } },
    timeoutMs,
  );
}

export interface TrustedReadRequest {
  operation: TrustedRuntimeRead;
  operationId: string;
  target: AssertionTarget;
  input: Record<string, unknown>;
}

/** sha256 of the canonical runtime request body, excluding the assertion. */
export function runtimeRequestHash(request: {
  operation: string;
  operationId: string;
  target: AssertionTarget;
  input: Record<string, unknown>;
}) {
  return sha256Hash(
    canonicalJson({
      operation: request.operation,
      operationId: request.operationId,
      target: request.target,
      input: request.input,
    }),
  );
}

export type TrustedReadResult =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      code: "runtime_unavailable" | "runtime_refused";
      status?: number;
      /** The runtime's refusal status when it is a plain code. */
      reason?: string;
      /** The runtime's stated reason for that refusal, when a plain code. */
      detail?: string;
    };

/**
 * Server-to-server read from the bound runtime for facts the HOST shows in its
 * own confirmations. Fixed endpoint, two allowlisted operations, bounded
 * response, timeout, no cookies and no redirects. Not a proxy: callers parse
 * a narrow projection and nothing else reaches the browser.
 */
export async function trustedRuntimeRead(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: TrustedReadRequest,
  assertion: string,
): Promise<TrustedReadResult> {
  if (
    request.operation !== "registration.settle.propose" &&
    request.operation !== "case.read"
  ) {
    return { ok: false, code: "runtime_refused" };
  }
  const response = await runtimeFetch(
    `${binding.origin}${RUNTIME_ENDPOINT}`,
    MAX_RESPONSE_BYTES,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        // Routes the call when several applications share one runtime origin.
        "x-tig-product-face-application": binding.applicationId,
      },
      body: JSON.stringify({
        operation: request.operation,
        operationId: request.operationId,
        target: request.target,
        input: request.input,
        assertion,
      }),
    },
    TIMEOUT_MS,
  );
  if (!response) return { ok: false, code: "runtime_unavailable" };
  if (response.status !== 200) {
    let reason: string | undefined;
    let detail: string | undefined;
    const plainCode = (value: unknown) =>
      typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
        ? value
        : undefined;
    try {
      const refused = JSON.parse(response.body.toString("utf8")) as {
        status?: unknown;
        reason?: unknown;
      };
      reason = plainCode(refused.status);
      detail = plainCode(refused.reason);
    } catch {
      // No readable refusal code.
    }
    return {
      ok: false,
      code: response.status >= 500 ? "runtime_unavailable" : "runtime_refused",
      status: response.status,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  try {
    const body: unknown = JSON.parse(response.body.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, code: "runtime_refused" };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, code: "runtime_refused" };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The registrations/status body the face sends, hashed whole (r6). */
export function registrationStatusRequestHash(operationId: string) {
  return sha256Hash(canonicalJson({ operationId }));
}

export type RegistrationRuntimeStatus =
  /**
   * 404 face_operation_not_found for exactly this operation: the runtime
   * holds no journal for it (it records one before any dispatch).
   */
  | { outcome: "not_found" }
  /**
   * The runtime's own journal for this operation answered this status; the
   * answer itself, for the additive r20 proof fields a caller may verify.
   */
  | { outcome: "answered"; status: string; body: Record<string, unknown> }
  /** Anything else: unreachable, refused, unreadable. Proves nothing. */
  | { outcome: "unknown" };

/**
 * The host's own read-only registration status for ONE operation, server to
 * server: the same registrations/status read (and the same registration.status
 * assertion) the face makes on Check status. Fixed endpoint, bounded response,
 * timeout, no cookies and no redirects; it reconciles and never dispatches.
 */
export async function readRegistrationStatus(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  operationId: string,
  assertion: string,
): Promise<RegistrationRuntimeStatus> {
  let response: Awaited<ReturnType<typeof fetchBounded>>;
  try {
    response = await runtimeFetch(
      `${binding.origin}${REGISTRATION_STATUS_ENDPOINT}`,
      MAX_RESPONSE_BYTES,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-tig-product-face-application": binding.applicationId,
        },
        body: JSON.stringify({ operationId, assertion }),
      },
      TIMEOUT_MS,
    );
  } catch {
    return { outcome: "unknown" };
  }
  if (!response) return { outcome: "unknown" };
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(response.body.toString("utf8"));
    if (record(parsed)) body = parsed;
  } catch {
    return { outcome: "unknown" };
  }
  if (body.operationId !== operationId) return { outcome: "unknown" };
  if (
    response.status === 404 &&
    body.status === "not_submitted" &&
    body.reason === "face_operation_not_found"
  ) {
    return { outcome: "not_found" };
  }
  if (
    (response.status === 200 || response.status === 202) &&
    typeof body.status === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(body.status)
  ) {
    return { outcome: "answered", status: body.status, body };
  }
  return { outcome: "unknown" };
}

/** A face artifact identity as a runtime records and echoes it (r20). */
export interface RuntimeArtifact {
  version: string;
  artifactHash: string;
}

/**
 * PROPOSED r20 §0 "Echoed binding", present on every r20 answer. The readers
 * below check each field's FORM only; the caller compares every value with
 * its journal entry, session, host origin, routed runtime, programme and the
 * face artifact it serves. Nothing is taken on trust from the endpoint.
 */
export interface RuntimeEcho {
  operationId: string;
  holder: string;
  wallet: string;
  issuer: string;
  applicationId: string;
  programme: string;
  assertingArtifact: RuntimeArtifact;
}

const PLAIN = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER_TEXT = /^\d+\.\d+\.\d+$/;
const ARTIFACT_HASH = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OFFER = /^pto-[0-9a-f]{24}$/;
const MAX_RECOVERY_ITEMS = 50;
const MAX_CURSOR_LENGTH = 512;

const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const plainCode = (value: unknown): value is string =>
  typeof value === "string" && PLAIN.test(value);

const timestamp = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function sameJson(left: unknown, right: unknown) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function artifactOf(value: unknown): RuntimeArtifact | undefined {
  return record(value) &&
    typeof value.version === "string" &&
    SEMVER_TEXT.test(value.version) &&
    typeof value.artifactHash === "string" &&
    ARTIFACT_HASH.test(value.artifactHash)
    ? { version: value.version, artifactHash: value.artifactHash }
    : undefined;
}

export function echoOf(body: Record<string, unknown>): RuntimeEcho | undefined {
  const assertingArtifact = artifactOf(body.asserting_artifact);
  if (
    !isOperationId(body.operation_id) ||
    !text(body.holder) ||
    !text(body.wallet) ||
    !text(body.issuer) ||
    !text(body.application_id) ||
    !text(body.programme) ||
    !assertingArtifact
  ) {
    return undefined;
  }
  return {
    operationId: body.operation_id,
    holder: body.holder,
    wallet: body.wallet,
    issuer: body.issuer,
    applicationId: body.application_id,
    programme: body.programme,
    assertingArtifact,
  };
}

/**
 * r20 accounting of a read-only answer: exactly zero business, provider and
 * Dual effects, no secret, and the runtime's own bookkeeping of one consumed
 * assertion and the expected acknowledgement rows. Missing, null or "0"
 * proves nothing.
 */
export function accountedReadOnly(
  body: Record<string, unknown>,
  acknowledgementsRecorded: 0 | 1,
) {
  return (
    body.writesExecuted === 0 &&
    body.dualWritesExecuted === 0 &&
    body.providerWritesExecuted === 0 &&
    body.unknownWriteOutcomes === 0 &&
    body.secretReturned === false &&
    record(body.bookkeeping) &&
    body.bookkeeping.assertionsConsumed === 1 &&
    body.bookkeeping.acknowledgementsRecorded === acknowledgementsRecorded
  );
}

/** The host's own r20 read: fixed endpoint, bounded, timed out, no cookies. */
async function postRuntimeOperation(
  runtime: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: {
    operation: string;
    operationId: string;
    target: AssertionTarget;
    input: Record<string, unknown>;
  },
  assertion: string,
) {
  try {
    return await runtimeFetch(
      `${runtime.origin}${RUNTIME_ENDPOINT}`,
      MAX_RESPONSE_BYTES,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-tig-product-face-application": runtime.applicationId,
        },
        body: JSON.stringify({ ...request, assertion }),
      },
      TIMEOUT_MS,
    );
  } catch {
    return undefined;
  }
}

function jsonRecord(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return record(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** r20 outcome_hash: sha256 of the canonical JSON of an outcome_proof. */
export function outcomeHashOf(proof: Record<string, unknown>) {
  return sha256Hash(canonicalJson(proof));
}

export type RecoveryItemKind =
  "registration" | "settle" | "transfer" | "runtime";

const recoveryItemKinds = [
  "registration",
  "settle",
  "transfer",
  "runtime",
] as const satisfies readonly RecoveryItemKind[];

/**
 * PROPOSED r20 §0: the outcome_proof a committed answer carries, as the
 * additive field of transfer.verify, transfer.status, registration.status and
 * registration.settle.status, and as write.status's own. Only a record whose
 * canonical hash is the answer's outcome_hash and whose kind, operation id
 * and status are the expected ones; anything else is pre-r20 for that
 * operation and proves nothing more than today.
 */
export function verifiedOutcomeProof(
  body: Record<string, unknown>,
  expected: { kind: RecoveryItemKind; operationId: string; status: string },
): { proof: Record<string, unknown>; hash: string } | undefined {
  const proof = body.outcome_proof;
  if (
    !record(proof) ||
    !isRequestHash(body.outcome_hash) ||
    proof.kind !== expected.kind ||
    proof.operation_id !== expected.operationId ||
    proof.status !== expected.status
  ) {
    return undefined;
  }
  let hash: string;
  try {
    hash = outcomeHashOf(proof);
  } catch {
    return undefined;
  }
  return hash === body.outcome_hash ? { proof, hash } : undefined;
}

/** The request one write.status read sends, so its hash is the runtime's. */
export function writeStatusRequest(
  operationId: string,
  target: { object_id: string; case_id?: string },
  originalOperation: string,
) {
  return {
    operation: "write.status" as const,
    operationId,
    target: {
      object_id: target.object_id,
      ...(target.case_id ? { case_id: target.case_id } : {}),
    },
    input: { original_operation: originalOperation },
  };
}

export type WriteReceipt =
  | { kind: "case_event"; caseId: string; eventId: string }
  | { kind: "transfer_offer"; offerId: string; state: string };

/**
 * A Dual-backed write's minimal bound proof (contract §1): the historical
 * action the server verified afresh through its Dual action-log resolver,
 * bound by the server to the original operation and request. The signer is
 * not assumed to be the holder, nor the object the product target.
 */
/**
 * Contract r20.1 (`original_verified_effect_receipt_v1`): one verified effect
 * of a Dual-backed write, as the server answered it. Three distinct parts:
 * the pre-dispatch intent commitment, the protected original verifier's
 * receipt, and the fresh historical corroboration from the state-change
 * history entry of that effect's own object. The signer is not assumed to
 * be the holder, nor the object the product target.
 */
export interface VerifiedEffect {
  index: number;
  actionId: string;
  actionKind: string;
  objectId: string;
  intentCommitmentHash: string;
  /** The provider's raw content hash (0x + 64 hex), normalized. */
  contentHashRaw: string;
  authority: { account: string; controller: string | null };
  historyEntryId: string;
  verifiedAt: string;
  readAt: string;
}

export const EFFECT_RECEIPT_PROOF_KIND = "original_verified_effect_receipt_v1";

/** The runtime's durable record of one write, exactly as it answered it. */
export interface RecordedWrite extends RuntimeEcho {
  operation: string;
  objectId: string;
  caseId: string | null;
  requestHash: string;
  /** The face artifact the original write's assertion carried. */
  recordedArtifact: RuntimeArtifact;
  /** The committed effect's identifiers; null on a refused write. */
  receipt: WriteReceipt | null;
  /**
   * The server's binding of the write's actual effect to its immutable
   * original record (contract §1), in one of two branches. For a server-only
   * effect "absent" (the target object was deleted since) is returned and the
   * caller HOLDS it: it is not the required readback, a decision for Root.
   */
  dual:
    | { backed: false; targetReadback: "verified" | "absent" }
    | {
        backed: true;
        proofKind: typeof EFFECT_RECEIPT_PROOF_KIND;
        intendedDualWrites: number;
        effects: VerifiedEffect[];
      };
  outcomeProof: Record<string, unknown>;
  outcomeHash: string;
  acknowledged: boolean;
}

export type WriteStatusResult =
  /**
   * 200 write_applied under contract r20: the runtime's own readback of its
   * canonical store shows the original write's effect, with zero unresolved
   * outcomes, a proof hashing to the answer's outcome_hash, and every field
   * well formed.
   */
  | { outcome: "applied"; record: RecordedWrite }
  /**
   * 200 write_refused under contract r20: a definitive zero-write refusal,
   * the same record with no receipt. Held by the caller (it frees no slot)
   * and shown as refused only once the caller checked its binding.
   */
  | { outcome: "refused"; record: RecordedWrite }
  /**
   * Anything else: not found, unknown, another caller, a runtime without
   * r20, an incompatible artifact, malformed, oversized, unreachable or
   * timed out. Proves nothing; the entry stays held, nothing is re-sent. A
   * 409 write_outcome_unknown is among these: it carries no §0 echo, so it
   * is not a bound answer about any record (the durable discovery of a held
   * write is its echo-bound recovery.list page, api/product-face-recovery.ts).
   */
  | { outcome: "held" };

function receiptOf(value: unknown): WriteReceipt | undefined {
  if (!record(value)) return undefined;
  if (
    value.kind === "case_event" &&
    isCaseId(value.case_id) &&
    typeof value.event_id === "string" &&
    RECEIPT_ID.test(value.event_id)
  ) {
    return {
      kind: "case_event",
      caseId: value.case_id,
      eventId: value.event_id,
    };
  }
  if (
    value.kind === "transfer_offer" &&
    typeof value.offer_id === "string" &&
    OFFER.test(value.offer_id) &&
    typeof value.state === "string" &&
    PLAIN.test(value.state)
  ) {
    return {
      kind: "transfer_offer",
      offerId: value.offer_id,
      state: value.state,
    };
  }
  return undefined;
}

/** A recorded case id, none (null), or malformed (undefined). */
function optionalCaseId(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return isCaseId(value) ? value : undefined;
}

// r20 §0: the runtime kind's outcome_proof has exactly these fields.
const RUNTIME_PROOF_FIELDS = [
  "case_id",
  "kind",
  "object_id",
  "operation",
  "operation_id",
  "receipt",
  "status",
].join(",");

/**
 * The write_applied proof, bound to the answer it came in: exactly the
 * runtime kind's fields, each equal to the answer's own, and the receipt
 * deep-equal to the answer's receipt.
 */
function runtimeOutcomeOf(
  body: Record<string, unknown>,
  recorded: {
    operationId: string;
    operation: string;
    objectId: string;
    caseId: string | null;
    status: "write_applied" | "write_refused";
    dual: RecordedWrite["dual"];
  },
) {
  const verified = verifiedOutcomeProof(body, {
    kind: "runtime",
    operationId: recorded.operationId,
    status: recorded.status,
  });
  if (!verified) return undefined;
  const { proof } = verified;
  // A Dual-backed write's proof also names the proved effect, so the
  // acknowledgement binds it; a server-only write's never does.
  const fields = recorded.dual.backed
    ? [...RUNTIME_PROOF_FIELDS.split(","), "dual"].sort().join(",")
    : RUNTIME_PROOF_FIELDS;
  if (
    Object.keys(proof).sort().join(",") !== fields ||
    proof.operation !== recorded.operation ||
    proof.object_id !== recorded.objectId ||
    proof.case_id !== recorded.caseId ||
    !sameJson(proof.receipt, body.receipt) ||
    (recorded.dual.backed &&
      !sameJson(normalizedEffectProjection(proof.dual), {
        proof_kind: EFFECT_RECEIPT_PROOF_KIND,
        request: {
          operation_id: recorded.operationId,
          request_hash: body.request_hash,
        },
        effects: recorded.dual.effects.map((effect) => ({
          index: effect.index,
          action_id: effect.actionId,
          object_id: effect.objectId,
          intent_commitment_hash: effect.intentCommitmentHash,
          content_hash_raw: effect.contentHashRaw,
        })),
      }))
  ) {
    return undefined;
  }
  return verified;
}

/** How far the runtime's verified_at may lie from this host's clock. */
const PROOF_FRESHNESS_MS = 10 * 60 * 1000;

/**
 * Contract §1 dual block, either branch, or undefined. A server-only effect
 * needs zero intended Dual writes, a plain reason and the fresh target
 * readback; a Dual action needs the server's minimal bound proof: a fresh
 * historical action-log verification whose expected and observed payload
 * hashes match, bound to this very operation and request.
 */
function dualOf(
  dual: Record<string, unknown>,
  body: Record<string, unknown>,
  now: number,
): RecordedWrite["dual"] | undefined {
  if (dual.backed === false) {
    return dual.intended_dual_writes === 0 &&
      plainCode(dual.reason) &&
      (dual.target_readback === "verified" || dual.target_readback === "absent")
      ? { backed: false, targetReadback: dual.target_readback }
      : undefined;
  }
  if (dual.backed !== true) return undefined;
  // r20.1 withdraws the executed-input proof: any of its fields, or the
  // singular proof, makes the answer malformed, never a relabelled proof.
  if (
    "proof" in dual ||
    "expected_payload_hash" in dual ||
    "observed_payload_hash" in dual ||
    "payload_match" in dual ||
    dual.proof_kind !== EFFECT_RECEIPT_PROOF_KIND ||
    !Number.isInteger(dual.intended_dual_writes) ||
    (dual.intended_dual_writes as number) < 1 ||
    !Array.isArray(dual.effects) ||
    dual.effects.length !== dual.intended_dual_writes
  ) {
    return undefined;
  }
  const effects: VerifiedEffect[] = [];
  const actionIds = new Set<string>();
  for (const [index, value] of dual.effects.entries()) {
    const effect = effectOf(value, index, body, now);
    if (!effect || actionIds.has(effect.actionId)) return undefined;
    actionIds.add(effect.actionId);
    effects.push(effect);
  }
  return {
    backed: true,
    proofKind: EFFECT_RECEIPT_PROOF_KIND,
    intendedDualWrites: dual.intended_dual_writes as number,
    effects,
  };
}

const PROVIDER_RAW_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * The outcome_proof's effect projection with its provider raw hashes
 * normalized (contract §1a: equality is of the normalized strings), so a
 * server emitting upper-case hex in both places is compared as it should be.
 */
function normalizedEffectProjection(value: unknown) {
  if (!record(value) || !Array.isArray(value.effects)) return value;
  return {
    ...value,
    effects: value.effects.map((effect: unknown) =>
      record(effect) && typeof effect.content_hash_raw === "string"
        ? { ...effect, content_hash_raw: effect.content_hash_raw.toLowerCase() }
        : effect,
    ),
  };
}

/** A provider raw content hash (`provider_raw_hex_v1`), normalized, or undefined. */
function providerRawHash(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return PROVIDER_RAW_HASH.test(normalized) ? normalized : undefined;
}

/** An address, normalized, or undefined. */
function addressOf(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return ADDRESS.test(normalized) ? normalized : undefined;
}

/** A declared controller: an address, or exactly null (direct signing). */
function controllerOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  return addressOf(value);
}

/**
 * One effect of the r20.1 chain (contract §1a consumer validation): the
 * effect bound to this operation, request and its index; the intent
 * commitment recomputed from a retained preimage; the original receipt with
 * exact authority and the RAW provider content hash; and the fresh
 * corroboration from the state-change history entry of this very object,
 * terminally succeeded, with the same authority and the same raw hash.
 */
function effectOf(
  value: unknown,
  index: number,
  body: Record<string, unknown>,
  now: number,
): VerifiedEffect | undefined {
  if (!record(value)) return undefined;
  const bound = value.bound_to;
  const intent = value.intent_commitment;
  const receipt = value.original_receipt;
  const fresh = value.historical_corroboration;
  if (
    value.index !== index ||
    typeof value.action_id !== "string" ||
    !RECEIPT_ID.test(value.action_id) ||
    !plainCode(value.action_kind) ||
    !isObjectId(value.object_id) ||
    value.effect_verdict !== "verified" ||
    !record(bound) ||
    bound.operation_id !== body.operation_id ||
    bound.request_hash !== body.request_hash ||
    bound.effect_index !== index ||
    !record(intent) ||
    !record(receipt) ||
    !record(fresh)
  ) {
    return undefined;
  }
  const scope = intent.scope;
  if (
    !plainCode(intent.version) ||
    !plainCode(intent.scheme) ||
    !isRequestHash(intent.hash) ||
    intent.preimage_retained !== true ||
    !record(scope) ||
    !text(scope.event_id) ||
    !text(scope.outbox_id) ||
    !text(scope.installation_id)
  ) {
    return undefined;
  }
  const receiptAuthority = receipt.authority;
  const freshAuthority = fresh.authority;
  if (!record(receiptAuthority) || !record(freshAuthority)) return undefined;
  const account = addressOf(receiptAuthority.account);
  const controller = controllerOf(receiptAuthority.controller);
  const receiptHash = providerRawHash(receipt.content_hash_raw);
  const freshHash = providerRawHash(fresh.content_hash_raw);
  if (
    !plainCode(receipt.verifier) ||
    !timestamp(receipt.verified_at) ||
    receipt.action_kind !== value.action_kind ||
    receipt.action_id !== value.action_id ||
    receipt.object_id !== value.object_id ||
    !plainCode(receipt.network) ||
    !plainCode(receipt.api_scope) ||
    !isObjectId(receipt.template_id) ||
    !account ||
    // The controller must be declared: an address, or exactly null. An
    // absent or unrecorded controller is not a qualifying receipt.
    !("controller" in receiptAuthority) ||
    controller === undefined ||
    receipt.domain_commitment !== intent.hash ||
    receipt.projection !== "full_declared" ||
    receipt.content_hash_format !== "provider_raw_hex_v1" ||
    receipt.content_hash_source !== "raw_original_content" ||
    !receiptHash ||
    !timestamp(fresh.read_at) ||
    fresh.resolver !== "dual_action_log" ||
    fresh.action_id !== value.action_id ||
    fresh.action_kind !== value.action_kind ||
    fresh.object_id !== value.object_id ||
    fresh.network !== receipt.network ||
    fresh.api_scope !== receipt.api_scope ||
    fresh.template_id !== receipt.template_id ||
    !text(fresh.history_entry_id) ||
    // Exact object: the corroborating history entry is this effect's own
    // object's, not merely another affected object's.
    fresh.history_entry_object_id !== value.object_id ||
    fresh.execution !== "succeeded" ||
    typeof fresh.status_raw !== "string" ||
    addressOf(freshAuthority.account) !== account ||
    !("controller" in freshAuthority) ||
    controllerOf(freshAuthority.controller) !== controller ||
    !Array.isArray(fresh.affected_objects) ||
    fresh.affected_objects.length === 0 ||
    !fresh.affected_objects.every(isObjectId) ||
    !fresh.affected_objects.includes(value.object_id) ||
    fresh.content_hash_format !== "provider_raw_hex_v1" ||
    !freshHash ||
    freshHash !== receiptHash ||
    fresh.content_hash_match !== true ||
    Date.parse(receipt.verified_at) > Date.parse(fresh.read_at) ||
    Math.abs(Date.parse(fresh.read_at) - now) > PROOF_FRESHNESS_MS
  ) {
    return undefined;
  }
  return {
    index,
    actionId: value.action_id,
    actionKind: value.action_kind,
    objectId: value.object_id,
    intentCommitmentHash: intent.hash,
    contentHashRaw: receiptHash,
    authority: { account, controller },
    historyEntryId: fresh.history_entry_id,
    verifiedAt: receipt.verified_at,
    readAt: fresh.read_at,
  };
}

/**
 * PROPOSED r20 (docs/proposals/runtime-write-status-r20.md), NOT deployed by
 * any runtime: the host's own read of ONE runtime write's verified outcome, by
 * its original operation id, from the runtime that served that write. Fixed
 * endpoint, bounded response, timeout, no cookies and no redirects; it reads
 * and never dispatches. Only an exact r20 write_applied answer with a
 * verified readback, zero unresolved outcomes, a receipt, the runtime's
 * artifact-compatibility proof and a matching outcome_hash is returned; the
 * caller still compares every binding with its journal entry, session, host
 * and face binding, and holds dual.targetReadback "absent".
 */
export async function readWriteStatus(
  runtime: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: ReturnType<typeof writeStatusRequest>,
  assertion: string,
): Promise<WriteStatusResult> {
  const held = { outcome: "held" } as const;
  const response = await postRuntimeOperation(runtime, request, assertion);
  if (!response || response.status !== 200) return held;
  const body = jsonRecord(response.body);
  if (!body) return held;
  const echo = echoOf(body);
  const status =
    body.status === "write_applied" || body.status === "write_refused"
      ? body.status
      : undefined;
  if (
    body.ok !== true ||
    !status ||
    body.contract !== "r20" ||
    body.readback !== "verified" ||
    body.artifact_compatible !== true ||
    !accountedReadOnly(body, 0) ||
    !echo ||
    !record(body.target) ||
    !record(body.dual)
  ) {
    return held;
  }
  const { target } = body;
  const caseId = optionalCaseId(target.case_id);
  const recordedArtifact = artifactOf(body.recorded_artifact);
  // A refused write has no receipt; an applied one exactly one.
  const receipt =
    status === "write_refused"
      ? body.receipt === null
        ? null
        : undefined
      : receiptOf(body.receipt);
  const dual = dualOf(body.dual, body, Date.now());
  if (
    !text(body.operation, 64) ||
    !isObjectId(target.object_id) ||
    caseId === undefined ||
    !isRequestHash(body.request_hash) ||
    !recordedArtifact ||
    receipt === undefined ||
    !dual ||
    typeof body.acknowledged !== "boolean"
  ) {
    return held;
  }
  const outcome = runtimeOutcomeOf(body, {
    operationId: echo.operationId,
    operation: body.operation,
    objectId: target.object_id,
    caseId,
    status,
    dual,
  });
  if (!outcome) return held;
  return {
    outcome: status === "write_applied" ? "applied" : "refused",
    record: {
      ...echo,
      operation: body.operation,
      objectId: target.object_id,
      caseId,
      requestHash: body.request_hash,
      recordedArtifact,
      receipt,
      dual,
      outcomeProof: outcome.proof,
      outcomeHash: outcome.hash,
      acknowledged: body.acknowledged,
    },
  };
}

/** The request one recovery.list page read sends (a fresh listing op_id). */
export function recoveryListRequest(operationId: string, cursor?: string) {
  return {
    operation: "recovery.list" as const,
    operationId,
    target: {},
    input: cursor ? { cursor } : {},
  };
}

export interface RecoveryItem {
  kind: RecoveryItemKind;
  operationId: string;
  operation: string;
  objectId: string;
  caseId: string | null;
  offerId: string | null;
  proposalId: string | null;
  step: "request" | "transfer" | null;
  actionId: string | null;
  state: "unresolved" | "completed" | "refused";
  recordedAt: string;
  recordedArtifact: RuntimeArtifact;
  artifactCompatible: boolean;
}

/**
 * A listed item this wallet cannot read in full (a record the runtime
 * retains however malformed, contract §2), kept by its identity alone so it
 * is shown as not checked and never resolved or acknowledged.
 */
export interface UnreadableItem {
  operationId: string;
  kind: RecoveryItemKind;
  state: RecoveryItem["state"];
  recordedAt: string;
}

/** One page of one scan; `complete` is the runtime's word for THIS page. */
export interface RecoveryPage extends RuntimeEcho {
  scanId: string;
  asOf: string;
  items: RecoveryItem[];
  unreadable: UnreadableItem[];
  next: string | null;
  complete: boolean;
}

export type RecoveryListResult =
  | { outcome: "listed"; page: RecoveryPage }
  /** An older runtime (400 face_request_invalid, or a 200 without r20). */
  | { outcome: "unsupported" }
  /**
   * Anything else: unreachable or timed out (`unreachable`), or a 5xx, a
   * cursor refusal, a malformed or oversized answer (`invalid`). The whole
   * recovery check is incomplete; nothing is acknowledged.
   */
  | { outcome: "unavailable"; reason: "unreachable" | "invalid" };

const recoveryItemStates = ["unresolved", "completed", "refused"] as const;
const recoverySteps = ["request", "transfer"] as const;

const isRecoveryItemKind = (value: unknown): value is RecoveryItemKind =>
  typeof value === "string" &&
  (recoveryItemKinds as readonly string[]).includes(value);
const isRecoveryItemState = (value: unknown): value is RecoveryItem["state"] =>
  typeof value === "string" &&
  (recoveryItemStates as readonly string[]).includes(value);
const isRecoveryStep = (value: unknown): value is "request" | "transfer" =>
  typeof value === "string" &&
  (recoverySteps as readonly string[]).includes(value);
const isTokenId = (value: unknown): value is string =>
  typeof value === "string" && PROPOSAL_ID.test(value);
const isOfferId = (value: unknown): value is string =>
  typeof value === "string" && OFFER.test(value);

function nullOr<T>(
  value: unknown,
  check: (value: unknown) => value is T,
): value is T | null {
  return value === null || check(value);
}

/** A listed item's identity alone: id, kind, state and recorded time. */
function unreadableItemOf(value: unknown): UnreadableItem | undefined {
  if (
    !record(value) ||
    !isOperationId(value.operation_id) ||
    !isRecoveryItemKind(value.kind) ||
    !isRecoveryItemState(value.state) ||
    !timestamp(value.recorded_at)
  ) {
    return undefined;
  }
  return {
    operationId: value.operation_id,
    kind: value.kind,
    state: value.state,
    recordedAt: value.recorded_at,
  };
}

/** One listed item: well formed, and carrying exactly its kind's fields. */
function recoveryItemOf(value: unknown): RecoveryItem | undefined {
  if (!record(value)) return undefined;
  const recordedArtifact = artifactOf(value.recorded_artifact);
  if (
    !isRecoveryItemKind(value.kind) ||
    !isOperationId(value.operation_id) ||
    !text(value.operation, 64) ||
    !isObjectId(value.object_id) ||
    !nullOr(value.case_id, isCaseId) ||
    !nullOr(value.offer_id, isOfferId) ||
    !nullOr(value.proposal_id, isTokenId) ||
    !nullOr(value.action_id, isTokenId) ||
    !nullOr(value.step, isRecoveryStep) ||
    !isRecoveryItemState(value.state) ||
    !timestamp(value.recorded_at) ||
    !recordedArtifact ||
    typeof value.artifact_compatible !== "boolean"
  ) {
    return undefined;
  }
  const item: RecoveryItem = {
    kind: value.kind,
    operationId: value.operation_id,
    operation: value.operation,
    objectId: value.object_id,
    caseId: value.case_id,
    offerId: value.offer_id,
    proposalId: value.proposal_id,
    step: value.step,
    actionId: value.action_id,
    state: value.state,
    recordedAt: value.recorded_at,
    recordedArtifact,
    artifactCompatible: value.artifact_compatible,
  };
  const ownsCase = item.caseId !== null;
  const ownsOffer = item.offerId !== null;
  const ownsProposal = item.proposalId !== null;
  const ownsStep = item.step !== null;
  switch (item.kind) {
    case "registration":
      return item.operation === "registration.submit" &&
        !ownsCase &&
        !ownsOffer &&
        !ownsProposal &&
        !ownsStep
        ? item
        : undefined;
    case "settle":
      return item.operation === "registration.settle" &&
        ownsProposal &&
        !ownsCase &&
        !ownsOffer &&
        !ownsStep
        ? item
        : undefined;
    case "transfer":
      return ((item.operation === "transfer.request" &&
        item.step === "request") ||
        (item.operation === "transfer.transfer" && item.step === "transfer")) &&
        ownsOffer &&
        !ownsCase
        ? item
        : undefined;
    case "runtime":
      return isRuntimeWriteOperation(item.operation) &&
        !ownsOffer &&
        !ownsProposal &&
        !ownsStep
        ? item
        : undefined;
  }
}

/**
 * PROPOSED r20 (docs/proposals/runtime-write-status-r20.md), NOT deployed by
 * any runtime: one page of the host's own durable discovery of this actor's
 * unacknowledged operations at one runtime. Fixed endpoint, bounded response,
 * timeout, no cookies and no redirects; it lists and never dispatches. Item
 * outcomes are not in the listing: the caller resolves each through its
 * kind's resolver and validates the echoed binding, the scan and duplicate
 * ids itself.
 */
export async function readRecoveryList(
  runtime: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: ReturnType<typeof recoveryListRequest>,
  assertion: string,
): Promise<RecoveryListResult> {
  const unavailable = (reason: "unreachable" | "invalid") =>
    ({ outcome: "unavailable", reason }) as const;
  const unsupported = { outcome: "unsupported" } as const;
  const response = await postRuntimeOperation(runtime, request, assertion);
  if (!response) return unavailable("unreachable");
  const body = jsonRecord(response.body);
  if (response.status === 400 && body?.status === "face_request_invalid") {
    return unsupported;
  }
  if (response.status !== 200 || !body) return unavailable("invalid");
  if (body.contract !== "r20") return unsupported;
  const echo = echoOf(body);
  if (
    body.ok !== true ||
    body.status !== "recovery_listed" ||
    !echo ||
    !text(body.scan_id) ||
    !timestamp(body.as_of) ||
    !nullOr(body.next, (value): value is string =>
      text(value, MAX_CURSOR_LENGTH),
    ) ||
    typeof body.complete !== "boolean" ||
    !accountedReadOnly(body, 0) ||
    !Array.isArray(body.items) ||
    body.items.length > MAX_RECOVERY_ITEMS
  ) {
    return unavailable("invalid");
  }
  const items: RecoveryItem[] = [];
  const unreadable: UnreadableItem[] = [];
  for (const entry of body.items) {
    const item = recoveryItemOf(entry);
    if (item) {
      items.push(item);
      continue;
    }
    // An item the runtime lists but this wallet cannot read in full (a
    // record retained however malformed) is kept by its identity, so the
    // caller shows it as not checked and resolves nothing for it. An item
    // without even an identity makes the page unreadable, never shorter.
    const stub = unreadableItemOf(entry);
    if (!stub) return unavailable("invalid");
    unreadable.push(stub);
  }
  return {
    outcome: "listed",
    page: {
      ...echo,
      scanId: body.scan_id,
      asOf: body.as_of,
      items,
      unreadable,
      next: body.next,
      complete: body.complete,
    },
  };
}

/** The request one recovery.ack sends: the ORIGINAL id, target and operation. */
export function recoveryAckRequest(
  operationId: string,
  target: { object_id: string; case_id?: string },
  originalOperation: string,
  outcomeHash: string,
) {
  return {
    operation: "recovery.ack" as const,
    operationId,
    target: {
      object_id: target.object_id,
      ...(target.case_id ? { case_id: target.case_id } : {}),
    },
    input: { original_operation: originalOperation, outcome_hash: outcomeHash },
  };
}

export type RecoveryAckResult =
  /** The runtime recorded (first) or had already recorded this delivery. */
  | { outcome: "acknowledged"; first: boolean; echo: RuntimeEcho }
  /** Anything else; the item stays listed and is acknowledged on no later basis. */
  | { outcome: "held" };

/**
 * PROPOSED r20 (docs/proposals/runtime-write-status-r20.md), NOT deployed by
 * any runtime: the host's idempotent record at one runtime that it delivered
 * one proved outcome to its actor, bound to that outcome's hash. Fixed
 * endpoint, bounded response, timeout, no cookies and no redirects; it never
 * touches the business record. The caller validates the echoed binding.
 */
export async function acknowledgeRecovery(
  runtime: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: ReturnType<typeof recoveryAckRequest>,
  assertion: string,
): Promise<RecoveryAckResult> {
  const held = { outcome: "held" } as const;
  const response = await postRuntimeOperation(runtime, request, assertion);
  if (!response || response.status !== 200) return held;
  const body = jsonRecord(response.body);
  if (!body) return held;
  const echo = echoOf(body);
  if (
    body.ok !== true ||
    body.status !== "recovery_acknowledged" ||
    body.contract !== "r20" ||
    !echo ||
    // The runtime acknowledged exactly the outcome this host proved.
    body.outcome_hash !== request.input.outcome_hash ||
    typeof body.first !== "boolean" ||
    !accountedReadOnly(body, body.first ? 1 : 0)
  ) {
    return held;
  }
  return { outcome: "acknowledged", first: body.first, echo };
}

export type SettleReserveResult =
  /** This request alone created the runtime's durable dispatch claim. */
  | { outcome: "won" }
  /**
   * Anything else: an idempotent replay or already_claimed, already_reserved,
   * a refusal, an error, a timeout or a lost response. Never execute; only
   * the read-only registration.settle.status may follow.
   */
  | {
      outcome: "not_won";
      status: string | null;
      reason: string | null;
      reached: boolean;
    };

/**
 * contract r8/r11: before ANY holder execution, the wallet BFF reserves the
 * settle at the bound runtime, server to server. The holder action may run
 * only on a response this request received itself that answers
 * dispatch:"won" for exactly this proposal, operation and unit — the single
 * call that atomically created the reservation. The wallet's cookie and
 * process state are not part of that decision.
 */
export async function reserveSettle(
  binding: ProductFaceBinding,
  request: { settleOperationId: string; objectId: string; proposalId: string },
  assertion: string,
): Promise<SettleReserveResult> {
  const lost = {
    outcome: "not_won" as const,
    status: null,
    reason: null,
    reached: false,
  };
  let response: Awaited<ReturnType<typeof fetchBounded>>;
  try {
    response = await runtimeFetch(
      `${binding.origin}${RUNTIME_ENDPOINT}`,
      MAX_RESPONSE_BYTES,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-tig-product-face-application": binding.applicationId,
        },
        body: JSON.stringify({
          operation: "registration.settle.reserve",
          operationId: request.settleOperationId,
          target: { object_id: request.objectId },
          input: { proposal_id: request.proposalId },
          assertion,
        }),
      },
      TIMEOUT_MS,
    );
  } catch {
    return lost;
  }
  if (!response) return lost;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(response.body.toString("utf8"));
    if (record(parsed)) body = parsed;
  } catch {
    // An unreadable answer is not a win.
  }
  const code = (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
      ? value
      : null;
  const reservation = record(body.reservation) ? body.reservation : {};
  const won =
    response.status === 200 &&
    body.ok === true &&
    body.status === "granted" &&
    body.dispatch === "won" &&
    body.idempotent !== true &&
    reservation.settle_operation_id === request.settleOperationId &&
    reservation.object_id === request.objectId &&
    reservation.proposal_id === request.proposalId;
  if (won) return { outcome: "won" };
  return {
    outcome: "not_won",
    status:
      code(body.dispatch) === "already_claimed"
        ? "already_claimed"
        : code(body.status),
    reason: code(body.reason),
    reached: true,
  };
}

export interface TransferRuntimeRequest {
  operation:
    | "transfer.propose"
    | "transfer.reserve"
    | "transfer.verify"
    | "transfer.status"
    // r19: the recipient's host reads which unit its acceptance is for.
    | "transfer.acceptance.read";
  operationId: string;
  target: AssertionTarget;
  input: Record<string, unknown>;
}

export type TransferRuntimeResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | {
      ok: false;
      code: "runtime_unavailable" | "runtime_refused";
      status?: number;
      /** The runtime's plain refusal codes (status, reason). */
      reason?: string;
      detail?: string;
      /** The runtime's answer, when readable (never shown to the face). */
      body?: Record<string, unknown>;
    };

/**
 * G8 (contract r16 transfer.sign): one of the holder's host's own
 * server-to-server transfer calls to the bound runtime, or the recipient's
 * host reading which unit its acceptance is for (transfer.acceptance.read,
 * r19). Fixed endpoint, five allowlisted operations, bounded
 * response, timeout, no cookies and no redirects. A 202 (an outcome not yet
 * known) is an answer, not a failure.
 */
export async function transferRuntimeCall(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: TransferRuntimeRequest,
  assertion: string,
): Promise<TransferRuntimeResult> {
  if (
    ![
      "transfer.propose",
      "transfer.reserve",
      "transfer.verify",
      "transfer.status",
      "transfer.acceptance.read",
    ].includes(request.operation)
  ) {
    return { ok: false, code: "runtime_refused" };
  }
  return runtimeOperationCall(binding, request, assertion);
}

/**
 * A host-only read-only reconcile the recovery listing resolves a recovered
 * settle or transfer step with (proposed r20 §2): never a reservation,
 * verification or execution. Same fixed endpoint and bounds as above.
 */
export async function hostRuntimeCall(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: {
    operation: "registration.settle.status" | "transfer.status";
    operationId: string;
    target: AssertionTarget;
    input: Record<string, unknown>;
  },
  assertion: string,
): Promise<TransferRuntimeResult> {
  if (
    request.operation !== "registration.settle.status" &&
    request.operation !== "transfer.status"
  ) {
    return { ok: false, code: "runtime_refused" };
  }
  return runtimeOperationCall(binding, request, assertion);
}

async function runtimeOperationCall(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: {
    operation: string;
    operationId: string;
    target: AssertionTarget;
    input: Record<string, unknown>;
  },
  assertion: string,
): Promise<TransferRuntimeResult> {
  let response: Awaited<ReturnType<typeof fetchBounded>>;
  try {
    response = await runtimeFetch(
      `${binding.origin}${RUNTIME_ENDPOINT}`,
      MAX_RESPONSE_BYTES,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-tig-product-face-application": binding.applicationId,
        },
        body: JSON.stringify({
          operation: request.operation,
          operationId: request.operationId,
          target: request.target,
          input: request.input,
          assertion,
        }),
      },
      TIMEOUT_MS,
    );
  } catch {
    return { ok: false, code: "runtime_unavailable" };
  }
  if (!response) return { ok: false, code: "runtime_unavailable" };
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(response.body.toString("utf8"));
    if (record(parsed)) body = parsed;
  } catch {
    body = undefined;
  }
  const plainCode = (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
      ? value
      : undefined;
  if ((response.status === 200 || response.status === 202) && body) {
    return { ok: true, status: response.status, body };
  }
  const reason = plainCode(body?.status);
  const detail = plainCode(body?.reason);
  return {
    ok: false,
    code: response.status >= 500 ? "runtime_unavailable" : "runtime_refused",
    status: response.status,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
    ...(body ? { body } : {}),
  };
}

/** Narrow projection of a registration.settle.propose result. */
export function parseSettleProposal(
  body: Record<string, unknown>,
): SettleProposal | undefined {
  const value = record(body.proposal) ? body.proposal : body;
  const expiresAt =
    typeof value.expires_at === "string" ? new Date(value.expires_at) : null;
  if (
    typeof value.proposal_id !== "string" ||
    !PROPOSAL_ID.test(value.proposal_id) ||
    !isOperationId(value.operation_id) ||
    !isObjectId(value.object_id) ||
    typeof value.action !== "string" ||
    !record(value.input) ||
    !isRequestHash(value.proposal_hash) ||
    !expiresAt ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return undefined;
  }
  return {
    proposalId: value.proposal_id,
    operationId: value.operation_id,
    objectId: value.object_id,
    action: value.action,
    input: value.input,
    proposalHash: value.proposal_hash,
    expiresAt,
  };
}

/** Narrow projection of the quote in a case.read result. */
export function parseCaseQuote(
  body: Record<string, unknown>,
  caseId: string,
): CaseQuote | undefined {
  const container = record(body.case) ? body.case : body;
  const quote = record(container.quote) ? container.quote : undefined;
  const readCaseId =
    typeof container.case_id === "string" ? container.case_id : caseId;
  if (
    !quote ||
    !isCaseId(readCaseId) ||
    readCaseId !== caseId ||
    !isQuoteVersion(quote.quote_version) ||
    typeof quote.provider !== "string" ||
    !quote.provider.trim() ||
    quote.provider.length > 120 ||
    !isDecimalAmount(quote.amount) ||
    !isCurrencyCode(quote.currency)
  ) {
    return undefined;
  }
  return {
    caseId,
    quoteVersion: quote.quote_version,
    provider: quote.provider,
    amount: quote.amount,
    currency: quote.currency,
  };
}

/**
 * P4.3 ticket-admission-v1 (docs/development/p4-3-admission-contract.md §5):
 * one call to the bound Tickets runtime on the fixed endpoint, for exactly
 * the host's own six ticket operations, with one operation-bound assertion.
 * Bounded, no cookies, no redirects; the caller parses a narrow projection.
 */
export async function ticketRuntimeCall(
  binding: Pick<ProductFaceBinding, "origin" | "applicationId">,
  request: {
    operation: TicketHostOperation;
    operationId: string;
    target: { object_id: string };
    input: Record<string, unknown>;
  },
  assertion: string,
): Promise<TransferRuntimeResult> {
  if (!isTicketHostOperation(request.operation)) {
    return { ok: false, code: "runtime_refused" };
  }
  return runtimeOperationCall(binding, request, assertion);
}

export type AdmissionReserveResult =
  /** This request alone created the runtime's one claim for the request. */
  | { outcome: "won" }
  /** Anything else, a replay included: never execute; status only. */
  | { outcome: "not_won"; reached: boolean; status: string | null };

/**
 * admission.reserve (§5.4): won only on this request's own 200 granted
 * dispatch:"won" for exactly this operation, ticket, proposal and request.
 */
export function admissionReserveOutcome(
  result: TransferRuntimeResult,
  expected: {
    operationId: string;
    objectId: string;
    proposalId: string;
    requestId: string;
  },
): AdmissionReserveResult {
  if (!result.ok) {
    return {
      outcome: "not_won",
      reached: result.code !== "runtime_unavailable",
      status: result.reason ?? null,
    };
  }
  const body = result.body;
  const reservation = record(body.reservation) ? body.reservation : {};
  const won =
    result.status === 200 &&
    body.ok === true &&
    body.status === "granted" &&
    body.dispatch === "won" &&
    body.idempotent !== true &&
    reservation.admission_operation_id === expected.operationId &&
    reservation.object_id === expected.objectId &&
    reservation.proposal_id === expected.proposalId &&
    reservation.request_id === expected.requestId;
  return won
    ? { outcome: "won" }
    : {
        outcome: "not_won",
        reached: true,
        status: typeof body.status === "string" ? body.status : null,
      };
}
