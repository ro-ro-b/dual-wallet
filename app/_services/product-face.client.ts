import "client-only";

import { getEbusApi, getObjectsApi } from "@/api/web-sdk-client";
import {
  toProductAttribute,
  toProductHistoryEntry,
  toProgrammeProduct,
} from "@/app/_adapters/product-face";
import {
  isRegistrationStatus,
  ProductFaceError,
  type CaseQuote,
  type ProductAttribute,
  type ProductFaceApplication,
  type ProductHistoryEntry,
  type ProgrammeProduct,
  type ProgrammeUnitFacts,
  type RegistrationStatus,
  type SettleFieldChange,
  type SettleProposal,
} from "@/app/_domain/product-face";
import {
  parseTransferProposal,
  transferExecutorInput,
  type TransferProposal,
} from "@/app/_domain/product-face-transfer";
import type { FaceExecution } from "@/app/_domain/face-execution";
import type { AuthenticationMethod } from "@/app/_domain/session";
import { executeInventoryAction } from "@/app/_services/action-executor.client";
import {
  bridgeActionInput,
  buildInventoryAction,
  isInventoryActionName,
} from "@/app/_services/inventory-actions";

// Journal-writing BFF calls run one at a time in this tab. The journal is a
// sealed cookie, and two overlapping writes would otherwise race to replace
// each other's version of it.
let journalQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = journalQueue.then(work, work);
  journalQueue = run.catch(() => undefined);
  return run;
}

/**
 * One launch (frame) of a product face. The host generates the launch id;
 * the BFF keeps that launch's own journal and selection, so two tabs never
 * overwrite each other.
 */
export interface FaceLaunch {
  slug: string;
  launchId: string;
}

async function faceRequest<T>(
  face: FaceLaunch,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${base(face.slug)}${path}`, {
      ...rest,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "x-dual-face-launch": face.launchId,
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new ProductFaceError("temporarily_unavailable");
  }
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    reason?: unknown;
  } & T;
  if (!response.ok) {
    throw new ProductFaceError(
      typeof body.code === "string"
        ? body.code
        : response.status === 401
          ? "session_expired"
          : "temporarily_unavailable",
      response.status,
      typeof body.reason === "string" ? body.reason : undefined,
    );
  }
  return body;
}

function base(slug: string) {
  return `/api/faces/${encodeURIComponent(slug)}`;
}

// contract r14: a handover ticket the context read handed over, held in
// memory for its launch only until the host's initialize takes it. It is
// never part of the query cache, a URL or any storage.
// G8: a transfer acceptance ticket is held the same way, with its kind.
export interface FaceHandoverTicket {
  kind: "handover" | "accept";
  ticket: string;
}
const handoverTickets = new Map<string, FaceHandoverTicket>();

/** Takes (and forgets) the handover ticket handed over for this launch. */
export function takeFaceHandoverTicket(launchId: string) {
  const ticket = handoverTickets.get(launchId);
  handoverTickets.delete(launchId);
  return ticket;
}

/**
 * Forgets every launch's handover ticket still held in memory. Called when
 * the session ends or changes account (logout, expiry, account change): a
 * ticket handed over for one session is never kept for another.
 */
export function forgetFaceHandoverTickets() {
  handoverTickets.clear();
}

export async function loadProductFaceContext(
  face: FaceLaunch,
  task: string = "/",
) {
  const { handover, acceptance, ...context } = await faceRequest<{
    application: ProductFaceApplication;
    frameUrl: string;
    handover?: { ticket?: unknown };
    acceptance?: { ticket?: unknown };
  }>(face, `/context?task=${encodeURIComponent(task)}`);
  if (typeof handover?.ticket === "string") {
    handoverTickets.set(face.launchId, {
      kind: "handover",
      ticket: handover.ticket,
    });
  } else if (typeof acceptance?.ticket === "string") {
    handoverTickets.set(face.launchId, {
      kind: "accept",
      ticket: acceptance.ticket,
    });
  }
  return context;
}

/**
 * The wallet's face handover entry (contract r14): hands the runtime's
 * one-time ticket to the BFF, which keeps it in the sealed pre-auth cookie.
 * Answers where to go next (the register task).
 */
export async function submitFaceHandover(
  slug: string,
  ticket: string,
  kind: "handover" | "accept" = "handover",
) {
  let response: Response;
  try {
    response = await fetch(`${base(slug)}/handover`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(kind === "accept" ? { ticket, kind } : { ticket }),
    });
  } catch {
    throw new ProductFaceError("temporarily_unavailable");
  }
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    next?: unknown;
  };
  if (!response.ok || typeof body.next !== "string") {
    throw new ProductFaceError(
      typeof body.code === "string" ? body.code : "temporarily_unavailable",
      response.status,
    );
  }
  return body.next;
}

/** Drops any pending face handover (an account change, contract r14). */
export async function clearFaceHandover() {
  try {
    await fetch("/api/session/face-handover", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    // Best effort: the cookie also expires within ten minutes.
  }
}

export async function readProgrammeUnit(face: FaceLaunch, objectId: string) {
  const { unit } = await faceRequest<{ unit: ProgrammeUnitFacts }>(
    face,
    `/units/${encodeURIComponent(objectId)}`,
  );
  return unit;
}

interface WireProduct {
  object_id: string;
  template_id: string;
  name: string;
  image_url: string | null;
  owner: string;
  custom: Record<string, unknown>;
  when_modified: string;
}

export function selectProgrammeProduct(face: FaceLaunch, objectId: string) {
  return serialized(async () => {
    const result = await faceRequest<{
      context_id: string;
      product: WireProduct;
    }>(face, "/selection", {
      method: "POST",
      json: { object_id: objectId },
    });
    return {
      contextId: result.context_id,
      product: {
        objectId: result.product.object_id,
        templateId: result.product.template_id,
        name: result.product.name,
        imageUrl: result.product.image_url ?? undefined,
        owner: result.product.owner,
        custom: result.product.custom,
        modifiedAt: new Date(result.product.when_modified),
      } satisfies ProgrammeProduct,
    };
  });
}

interface WireOperation {
  operation_id: string;
  kind: "registration" | "runtime" | "settle" | "transfer";
  operation: string;
  object_id: string;
  case_id: string | null;
  phase: string;
  status: string | null;
  action_id: string | null;
}

export function writeFaceJournal(
  face: FaceLaunch,
  body: Record<string, unknown>,
) {
  return serialized(async () => {
    const result = await faceRequest<{
      operation: WireOperation;
      unit: ProgrammeUnitFacts | null;
      quote: {
        case_id: string;
        quote_version: number;
        provider: string;
        amount: string;
        currency: string;
      } | null;
      reservation?: string | null;
    }>(face, "/operations", { method: "POST", json: body });
    return {
      unit: result.unit ?? undefined,
      // "won" only when the BFF itself won the runtime's settle dispatch
      // claim for this request; the holder executes a settle on nothing else.
      reservation: result.reservation === "won" ? ("won" as const) : undefined,
      quote: result.quote
        ? ({
            caseId: result.quote.case_id,
            quoteVersion: result.quote.quote_version,
            provider: result.quote.provider,
            amount: result.quote.amount,
            currency: result.quote.currency,
          } satisfies CaseQuote)
        : undefined,
    };
  });
}

export async function listFaceOperations(face: FaceLaunch) {
  const { operations } = await faceRequest<{ operations: WireOperation[] }>(
    face,
    "/operations",
  );
  return operations;
}

export async function readFaceOperationStatus(
  face: FaceLaunch,
  operationId: string,
) {
  const result = await faceRequest<{
    status: string;
    object_id: string;
    readback: { owner_is_you: boolean; state: string | null } | null;
  }>(face, `/operations/${encodeURIComponent(operationId)}`);
  if (!isRegistrationStatus(result.status)) {
    throw new ProductFaceError("temporarily_unavailable");
  }
  return {
    status: result.status as RegistrationStatus,
    objectId: result.object_id,
    readback: result.readback
      ? {
          ownerIsYou: result.readback.owner_is_you,
          state: result.readback.state,
        }
      : null,
  };
}

export function mintFaceAssertion(face: FaceLaunch, body: object) {
  return serialized(async () => {
    const { assertion } = await faceRequest<{ assertion: string }>(
      face,
      "/assertions",
      { method: "POST", json: body },
    );
    return assertion;
  });
}

export function readSettleProposal(
  face: FaceLaunch,
  input: { contextId: string; operationId: string; objectId: string },
) {
  return serialized(async () => {
    const result = await faceRequest<{
      proposal: {
        proposal_id: string;
        operation_id: string;
        object_id: string;
        action: string;
        input: Record<string, unknown>;
        proposal_hash: string;
        expires_at: string;
      };
      changes: SettleFieldChange[];
    }>(face, "/settle-proposal", {
      method: "POST",
      json: {
        context_id: input.contextId,
        operation_id: input.operationId,
        object_id: input.objectId,
      },
    });
    return {
      proposal: {
        proposalId: result.proposal.proposal_id,
        operationId: result.proposal.operation_id,
        objectId: result.proposal.object_id,
        action: result.proposal.action,
        input: result.proposal.input,
        proposalHash: result.proposal.proposal_hash,
        expiresAt: new Date(result.proposal.expires_at),
      } satisfies SettleProposal,
      changes: result.changes,
    };
  });
}

async function sdkCall<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const status =
      error && typeof error === "object" && "response" in error
        ? Number((error as { response: { status?: unknown } }).response.status)
        : 0;
    throw new ProductFaceError(
      status === 401
        ? "session_expired"
        : status === 403 || status === 404
          ? "not_found"
          : "temporarily_unavailable",
      status,
    );
  }
}

export function listProgrammeProducts({
  owner,
  templateId,
  next,
}: {
  owner: string;
  templateId: string;
  next?: string;
}) {
  return sdkCall(async () => {
    const result = await getObjectsApi().listObjects({
      owner,
      templateId,
      limit: 25,
      next,
      order: "desc",
      sortBy: "when_modified",
    });
    return {
      products: result.objects.map(toProgrammeProduct),
      next: result.next || undefined,
    };
  });
}

export function readProgrammeProduct(objectId: string) {
  return sdkCall(async () =>
    toProgrammeProduct(await getObjectsApi().getObjectById({ objectId })),
  );
}

/** Fresh action availability for one object, like an inventory action. */
export function readProgrammeProductActions(objectId: string) {
  return sdkCall(async () => {
    const result = await getObjectsApi().listObjects({
      id: objectId,
      limit: 1,
      actions: true,
    });
    const object = result.items?.[0]?.object ?? result.objects[0];
    if (!object || object.id.toLowerCase() !== objectId) return [];
    return (
      result.actions?.find((entry) => entry.templateId === object.templateId)
        ?.actions ?? []
    );
  });
}

export function readProgrammeProductAttributes(
  objectId: string,
): Promise<ProductAttribute[]> {
  return sdkCall(async () => {
    const result = await getObjectsApi().listObjectAttributes({ objectId });
    return result.attributes.map(toProductAttribute);
  });
}

export function readProgrammeProductHistory(
  objectId: string,
): Promise<ProductHistoryEntry[]> {
  return sdkCall(async () => {
    const result = await getEbusApi().listActionLogs({
      objectId,
      limit: 25,
      order: "desc",
      sortBy: "when_created",
    });
    return result.actionLogs.map(toProductHistoryEntry);
  });
}

/**
 * A reviewed `update` proposal carries the Dual update body `{data: {custom}}`
 * for the unit; the executor's form takes `custom`. Nothing else is mapped.
 */
function settleFormInput(action: string, input: Record<string, unknown>) {
  if (action !== "update" || !("data" in input)) return input;
  const data = input.data;
  if (
    Object.keys(input).length !== 1 ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).join(",") !== "custom"
  ) {
    throw new ProductFaceError("proposal_rejected");
  }
  return { custom: (data as Record<string, unknown>).custom };
}

/**
 * Executes exactly the validated settle proposal as the holder through the
 * wallet's existing executor (email execute, or passkey/EOA prepare + sign +
 * execute). `claim_ownership` can never reach this path.
 */
export async function executeSettleAction({
  objectId,
  action,
  alias,
  input,
  authenticationMethod,
  controllerAddress,
  face,
}: {
  objectId: string;
  action: string;
  alias?: string;
  input: Record<string, unknown>;
  authenticationMethod: AuthenticationMethod;
  controllerAddress?: string;
  /** The launch binding and live check (contract r18). */
  face: FaceExecution;
}) {
  if (
    !isInventoryActionName(action) ||
    action === "claim_ownership" ||
    !["update", "set_attributes", "remote"].includes(action)
  ) {
    throw new ProductFaceError("proposal_rejected");
  }
  const request = buildInventoryAction(
    action,
    objectId,
    bridgeActionInput(action, settleFormInput(action, input)),
  );
  const result = await executeInventoryAction(
    alias ? { ...request, alias } : request,
    authenticationMethod,
    controllerAddress,
    face,
  );
  return { actionId: result.actionId };
}

/** G8: the next transfer step the BFF read itself from the bound runtime. */
export function readTransferProposal(
  face: FaceLaunch,
  input: { contextId: string; offerId: string; objectId: string },
) {
  return serialized(async () => {
    const { proposal } = await faceRequest<{
      proposal: Record<string, unknown>;
    }>(face, "/transfer-proposal", {
      method: "POST",
      json: {
        context_id: input.contextId,
        offer_id: input.offerId,
        object_id: input.objectId,
      },
    });
    const parsed = parseTransferProposal({
      ...proposal,
      status: "transfer_step_proposed",
    });
    if (!parsed) throw new ProductFaceError("proposal_rejected");
    return parsed satisfies TransferProposal;
  });
}

/**
 * r19, the recipient's host: the unit this launch's acceptance is
 * for, read by the BFF itself (the runtime's transfer.acceptance.read with the
 * ticket it kept, then Dual's public projection). The wallet's own
 * transfer.accept confirmation names it, and the acceptance is bound to it.
 */
export function readAcceptOffer(face: FaceLaunch) {
  return serialized(async () => {
    const { unit } = await faceRequest<{ unit: ProgrammeUnitFacts }>(
      face,
      "/accept-offer",
      { method: "POST", json: {} },
    );
    return unit;
  });
}

/** G8: verify or read the status of one submitted step (read-only). */
export function readTransferProgress(face: FaceLaunch, operationId: string) {
  return serialized(async () => {
    const result = await faceRequest<{ status: unknown; step: unknown }>(
      face,
      "/transfer-progress",
      { method: "POST", json: { operation_id: operationId } },
    );
    const status = result.status;
    const step = result.step;
    if (
      (status !== "transfer_request_committed" &&
        status !== "transferred" &&
        status !== "outcome_unknown") ||
      (step !== "request" && step !== "transfer")
    ) {
      throw new ProductFaceError("temporarily_unavailable");
    }
    return { status, step } as {
      status: "transfer_request_committed" | "transferred" | "outcome_unknown";
      step: "request" | "transfer";
    };
  });
}

/**
 * G8: executes exactly a validated transfer step as the holder through the
 * wallet's existing executor: the request step's `update` of the unit's
 * custom data, or the Dual `transfer` to the runtime-bound recipient.
 * `claim_ownership` and issuer authority can never reach this path.
 */
export async function executeTransferAction({
  objectId,
  action,
  input,
  authenticationMethod,
  controllerAddress,
  face,
}: {
  objectId: string;
  action: "update" | "transfer";
  input: Record<string, unknown>;
  authenticationMethod: AuthenticationMethod;
  controllerAddress?: string;
  /** The launch binding and live check (contract r18). */
  face: FaceExecution;
}) {
  const form = transferExecutorInput({ action, input });
  if ((action !== "update" && action !== "transfer") || !form) {
    throw new ProductFaceError("proposal_rejected");
  }
  const request = buildInventoryAction(
    action,
    objectId,
    bridgeActionInput(action, form),
  );
  const result = await executeInventoryAction(
    request,
    authenticationMethod,
    controllerAddress,
    face,
  );
  return { actionId: result.actionId };
}

export async function sha256Hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
