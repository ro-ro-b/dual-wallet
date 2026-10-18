import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isFaceSlug } from "@/api/face-journal";
import { unambiguousObject } from "@/api/strict-json-body";
import {
  faceContextError,
  faceError,
  resolveFaceRequest,
  type FaceRequestContext,
} from "@/api/product-face-server";
import {
  FACE_EXECUTION_HEADERS,
  FACE_EXECUTION_OPERATION_HEADER,
  FACE_EXECUTION_PATHS,
  FACE_EXECUTION_SLUG_HEADER,
  FACE_EXECUTION_WALLET_HEADER,
  faceExecutionBodyMatches,
} from "@/app/_domain/face-execution";
import { canonicalJson, isOperationId } from "@/app/_domain/product-face";
import {
  signedStepKind,
  type FaceJournalEntry,
} from "@/app/_domain/product-face-journal";
import { sha256Hash } from "@/api/face-assertion";

/** The admission update's `data.custom`, exactly the bound map, and nothing more. */
function admissionBodyMatches(body: unknown, entry: FaceJournalEntry) {
  const update = (body as { action?: { update?: unknown } }).action?.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return false;
  }
  const { id, data, ...rest } = update as Record<string, unknown>;
  if (
    id !== entry.objectId ||
    Object.values(rest).some((value) => value !== undefined && value !== null)
  ) {
    return false;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const { custom, ...others } = data as Record<string, unknown>;
  if (Object.keys(others).length || !custom || typeof custom !== "object") {
    return false;
  }
  try {
    return sha256Hash(canonicalJson(custom)) === entry.inputHash;
  } catch {
    return false;
  }
}

export type FaceExecutionDecision =
  | { bound: false }
  | { bound: true; context: FaceRequestContext }
  | { bound: true; refused: NextResponse };

/**
 * The server-side binding of a face's holder-signed step to the session that
 * began it (contract r18). The wallet's /api/backend proxy forwards each
 * request under the session cookie current at THAT request; without this, an
 * account switch between prepare, signing and execute would send the step
 * under another session. A request carrying any face execution header is
 * forwarded only when ALL of these hold for the CURRENT session:
 *
 * - it is POST ebus/prepare or ebus/execute, with a valid slug, launch,
 *   operation id and the captured wallet id;
 * - the current wallet is that captured wallet;
 * - this launch's journal, which is sealed to the session and wallet that
 *   wrote it and reads as empty under any other, holds that operation as a
 *   settle or transfer step that is submitted, whose own reservation was won
 *   (dispatch:"won") and that has no recorded action yet;
 * - the body is exactly that step's action on that step's unit, read from
 *   the very bytes the route forwards as one unambiguous JSON object (valid
 *   UTF-8, no member name repeated at any depth however it is spelled, save
 *   that a designated free-form map such as `action.update.data.custom`
 *   compares its own keys exactly, as the map they are); any other body is
 *   refused before the session is even resolved.
 *
 * Anything else is refused before any upstream request; the journal entry is
 * not touched, so its original correlation stays submitted and its status
 * stays read-only (outcome_unknown) for the face. A request without face
 * headers is the generic executor and is not affected.
 */
export async function bindFaceExecution(
  request: NextRequest,
  path: string[],
  body: ArrayBuffer | undefined,
): Promise<FaceExecutionDecision> {
  if (!FACE_EXECUTION_HEADERS.some((name) => request.headers.has(name))) {
    return { bound: false };
  }
  const refuse = (code: string, status: number) => ({
    bound: true as const,
    refused: faceError(code, status),
  });
  if (
    request.method !== "POST" ||
    !(FACE_EXECUTION_PATHS as readonly string[]).includes(path.join("/"))
  ) {
    return refuse("face_execution_path_invalid", 400);
  }
  const slug = request.headers.get(FACE_EXECUTION_SLUG_HEADER) ?? "";
  const operationId = request.headers.get(FACE_EXECUTION_OPERATION_HEADER);
  const walletId = request.headers.get(FACE_EXECUTION_WALLET_HEADER);
  if (!isFaceSlug(slug) || !isOperationId(operationId) || !walletId) {
    return refuse("face_execution_invalid", 400);
  }
  // The body every decoder reads the same way, or nothing: a duplicate,
  // escaped or case-folded member, invalid UTF-8 or anything but one object
  // could check as one action here and reach Dual as another. Distinct keys
  // of a designated free-form map (EXACT_KEY_MAPS) are not such a member.
  // Refused here, nothing has been dispatched: no upstream request, and the
  // journal entry and its reservation are untouched.
  const parsed = unambiguousObject(body ?? new ArrayBuffer(0));
  if (!parsed) return refuse("face_execution_mismatch", 400);
  // The current session, its wallet and this launch's journal (the launch id
  // header is checked there); a logged-out or expired session is refused.
  const context = await resolveFaceRequest(request, slug, {
    mutation: true,
    route: "execution",
  });
  if (context instanceof NextResponse) {
    return { bound: true, refused: context };
  }
  // From here a refusal carries the session this request resolved, which
  // may have been renewed: its refresh token must not be presented twice.
  const refuseIn = (code: string, status: number) => ({
    bound: true as const,
    refused: faceContextError(context, code, status),
  });
  if (context.wallet.id !== walletId) {
    return refuseIn("face_execution_unbound", 409);
  }
  const entry = context.journal.entries.find(
    (item) => item.operationId === operationId,
  );
  if (!entry || !signedStepKind(entry.kind)) {
    return refuseIn("face_execution_unbound", 409);
  }
  if (
    entry.phase !== "submitted" ||
    entry.dispatch !== "won" ||
    entry.actionId !== undefined
  ) {
    return refuseIn("face_execution_not_pending", 409);
  }
  if (!faceExecutionBodyMatches(parsed, entry)) {
    return refuseIn("face_execution_mismatch", 400);
  }
  // P4.3: an admission step signs exactly the custom map it was confirmed
  // for (its journal's inputHash), never another update of the same ticket.
  if (entry.kind === "admission" && !admissionBodyMatches(parsed, entry)) {
    return refuseIn("face_execution_mismatch", 400);
  }
  return { bound: true, context };
}
