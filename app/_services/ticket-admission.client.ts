import "client-only";

import type { FaceExecution } from "@/app/_domain/face-execution";
import { isOperationId } from "@/app/_domain/product-face";
import type { AuthenticationMethod } from "@/app/_domain/session";
import {
  PASS_CODE,
  parseAdmissionState,
  type AdmissionConfirmation,
  type AdmissionReceipt,
  type AdmissionState,
  type IssuanceProof,
  type TicketPass,
} from "@/app/_domain/ticket-admission";
import { executeInventoryAction } from "@/app/_services/action-executor.client";

// P4.3 ticket-admission-v1: the native ticket page's entry steps, through the
// wallet's own same-origin BFF only. No credential, assertion or runtime
// address ever reaches the browser; the holder's signature goes through the
// wallet's existing executor, bound to this step (contract r18).

export class AdmissionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdmissionError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

async function admissionRequest(
  where: { slug: string; launchId: string; objectId: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(
      `/api/faces/${encodeURIComponent(where.slug)}/tickets/${encodeURIComponent(where.objectId)}/admission`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-dual-face-launch": where.launchId,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    throw new AdmissionError("unavailable");
  }
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      record(parsed) &&
      typeof parsed.code === "string" &&
      CODE.test(parsed.code)
        ? parsed.code
        : "unavailable";
    throw new AdmissionError(
      response.status === 401 ? "session_expired" : code,
    );
  }
  if (!record(parsed)) throw new AdmissionError("unavailable");
  return parsed;
}

type Where = { slug: string; launchId: string; objectId: string };

export async function checkAdmission(where: Where): Promise<AdmissionState> {
  const body = await admissionRequest(where, { transition: "check" });
  const state = parseAdmissionState(body.state);
  if (!state) throw new AdmissionError("unavailable");
  return state;
}

const text = (value: unknown) =>
  typeof value === "string" && value.length <= 240 ? value : null;
const iso = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;

export async function beginAdmission(
  where: Where,
  requestId: string,
): Promise<{
  confirmation: AdmissionConfirmation;
  custom: Record<string, unknown>;
}> {
  const body = await admissionRequest(where, {
    transition: "begin",
    request_id: requestId,
  });
  const value = record(body.confirmation) ? body.confirmation : {};
  const request = parseAdmissionState({
    status: "awaiting_holder",
    request: value.request,
  });
  const event = record(value.event) ? value.event : {};
  const window = record(value.window) ? value.window : {};
  const effect = record(value.effect) ? value.effect : {};
  if (
    !isOperationId(value.operationId) ||
    value.objectId !== where.objectId ||
    request?.status !== "awaiting_holder" ||
    request.request.requestId !== requestId ||
    !iso(value.expiresAt) ||
    typeof event.title !== "string" ||
    typeof value.holder !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(value.holder) ||
    effect.to !== "Admitted" ||
    typeof effect.from !== "string" ||
    !record(body.custom)
  ) {
    throw new AdmissionError("unavailable");
  }
  return {
    confirmation: {
      operationId: value.operationId,
      objectId: where.objectId,
      request: request.request,
      expiresAt: iso(value.expiresAt)!,
      event: {
        title: event.title,
        venue: text(event.venue),
        startsAt: iso(event.startsAt),
      },
      window: { startsAt: iso(window.startsAt), endsAt: iso(window.endsAt) },
      holder: value.holder,
      effect: { from: effect.from, to: "Admitted" },
    },
    custom: body.custom,
  };
}

export async function cancelAdmission(where: Where, operationId: string) {
  await admissionRequest(where, {
    transition: "cancel",
    operation_id: operationId,
  });
}

/** Reserve at the runtime; resolves only on this request's own `won`. */
export async function confirmAdmission(where: Where, operationId: string) {
  const body = await admissionRequest(where, {
    transition: "confirm",
    operation_id: operationId,
  });
  if (body.reservation !== "won") throw new AdmissionError("outcome_unknown");
}

export type AdmissionOutcome =
  | { status: "admitted"; admission: AdmissionReceipt }
  | { status: "unknown"; operationId: string };

function outcomeOf(body: Record<string, unknown>, operationId: string) {
  const outcome = record(body.outcome) ? body.outcome : {};
  if (outcome.status === "admitted") {
    const state = parseAdmissionState(outcome);
    if (state?.status === "admitted") {
      return { status: "admitted", admission: state.admission } as const;
    }
  }
  return { status: "unknown", operationId } as const;
}

/** Record the executed action and verify: admitted, or unknown (never "not sent"). */
export async function recordAdmission(
  where: Where,
  operationId: string,
  actionId: string,
): Promise<AdmissionOutcome> {
  const body = await admissionRequest(where, {
    transition: "record_action",
    operation_id: operationId,
    action_id: actionId,
  });
  return outcomeOf(body, operationId);
}

/** Read-only status of the original operation. Never signs or sends. */
export async function admissionStatus(
  where: Where,
  operationId: string,
): Promise<AdmissionOutcome> {
  const body = await admissionRequest(where, {
    transition: "status",
    operation_id: operationId,
  });
  return outcomeOf(body, operationId);
}

function issuanceOf(value: unknown): IssuanceProof | null {
  if (!record(value)) return null;
  const ok =
    typeof value.recordId === "string" &&
    typeof value.objectId === "string" &&
    typeof value.activationHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.activationHash) &&
    typeof value.birthOperationId === "string" &&
    /^op_[0-9a-f]{40}$/.test(value.birthOperationId) &&
    typeof value.birthIdempotencyKey === "string" &&
    typeof value.birthActionId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.birthActionId) &&
    (value.operationReadback === "current" ||
      value.operationReadback === "superseded");
  return ok ? (value as unknown as IssuanceProof) : null;
}

export async function readTicketPass(where: Where): Promise<TicketPass> {
  const body = await admissionRequest(where, { transition: "pass" });
  const pass = record(body.pass) ? body.pass : {};
  if (typeof pass.code !== "string" || !PASS_CODE.test(pass.code)) {
    throw new AdmissionError("unavailable");
  }
  return { code: pass.code, issuance: issuanceOf(pass.issuance) };
}

/**
 * Signs exactly the confirmed admission update as the holder through the
 * wallet's executor. The proxy forwards it only for this step's own won
 * reservation and only with exactly the confirmed custom map.
 */
export async function executeAdmission({
  objectId,
  custom,
  authenticationMethod,
  controllerAddress,
  face,
}: {
  objectId: string;
  custom: Record<string, unknown>;
  authenticationMethod: AuthenticationMethod;
  controllerAddress?: string;
  face: FaceExecution;
}) {
  const result = await executeInventoryAction(
    { update: { id: objectId, data: { custom } } },
    authenticationMethod,
    controllerAddress,
    face,
  );
  if (!result.actionId) throw new AdmissionError("outcome_unknown");
  return result.actionId;
}
