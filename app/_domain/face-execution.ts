import type { FaceJournalEntry } from "@/app/_domain/product-face-journal";

// A face's holder-signed step (settle, transfer) is prepared and executed
// through the wallet's ordinary /api/backend proxy, which forwards under the
// session cookie current at EACH request. These headers bind such a request
// to the face launch, operation and wallet that began it; the proxy forwards
// it only while the CURRENT session still owns that launch's journal entry
// and the entry's own reservation was won (see api/face-execution-binding).
// Requests without them are the wallet's generic executor and are unchanged.

/** Same header the face BFF routes use for the launch id. */
export const FACE_EXECUTION_LAUNCH_HEADER = "x-dual-face-launch";
export const FACE_EXECUTION_SLUG_HEADER = "x-dual-face-slug";
export const FACE_EXECUTION_OPERATION_HEADER = "x-dual-face-operation";
/** The wallet id captured when the operation began (never a credential). */
export const FACE_EXECUTION_WALLET_HEADER = "x-dual-face-wallet";

export const FACE_EXECUTION_HEADERS = [
  FACE_EXECUTION_LAUNCH_HEADER,
  FACE_EXECUTION_SLUG_HEADER,
  FACE_EXECUTION_OPERATION_HEADER,
  FACE_EXECUTION_WALLET_HEADER,
] as const;

/** The only upstream paths a face-bound request may take. */
export const FACE_EXECUTION_PATHS = ["ebus/prepare", "ebus/execute"] as const;

export interface FaceExecutionBinding {
  launchId: string;
  slug: string;
  operationId: string;
  walletId: string;
}

/**
 * A face's holder-signed step as the executor receives it: the binding, and
 * the host's live check of the identity that began it.
 */
export interface FaceExecution extends FaceExecutionBinding {
  /**
   * Throws unless the face launch is live and the CURRENT wallet session is
   * still exactly the identity that began the step.
   */
  assertLive(): void;
}

export function faceExecutionHeaders(
  binding: FaceExecutionBinding,
): Record<string, string> {
  return {
    [FACE_EXECUTION_LAUNCH_HEADER]: binding.launchId,
    [FACE_EXECUTION_SLUG_HEADER]: binding.slug,
    [FACE_EXECUTION_OPERATION_HEADER]: binding.operationId,
    [FACE_EXECUTION_WALLET_HEADER]: binding.walletId,
  };
}

// Action-level fields of an ActionsRequest that are not themselves an action.
const ACTION_MODIFIERS = new Set(["alias", "permit_secret"]);
const SETTLE_ACTIONS = new Set(["update", "set_attributes", "remote"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The single standard action a face step may send for its journal entry. */
export function faceEntryAction(entry: FaceJournalEntry) {
  if (entry.kind === "settle") {
    return SETTLE_ACTIONS.has(entry.operation) ? entry.operation : undefined;
  }
  // P4.3: the admission step's one update of its own ticket.
  if (entry.kind === "admission") {
    return entry.operation === "update" ? "update" : undefined;
  }
  if (entry.kind === "transfer") {
    return entry.operation === "transfer.request"
      ? "update"
      : entry.operation === "transfer.transfer"
        ? "transfer"
        : undefined;
  }
  return undefined;
}

/**
 * Checks a prepare or execute body (wire JSON) against the journal entry it
 * claims: exactly one action, the entry's own action, on the entry's own
 * unit. A transfer step never carries an alias; neither carries a permit
 * secret.
 */
export function faceExecutionBodyMatches(
  body: unknown,
  entry: FaceJournalEntry,
): boolean {
  const expected = faceEntryAction(entry);
  if (!expected || !record(body) || !record(body.action)) return false;
  const action = body.action;
  if (action.permit_secret !== undefined && action.permit_secret !== null) {
    return false;
  }
  if (
    entry.kind !== "settle" &&
    action.alias !== undefined &&
    action.alias !== null
  ) {
    return false;
  }
  const named = Object.keys(action).filter(
    (key) =>
      !ACTION_MODIFIERS.has(key) &&
      action[key] !== undefined &&
      action[key] !== null,
  );
  if (named.length !== 1 || named[0] !== expected) return false;
  const step = action[expected];
  return record(step) && step.id === entry.objectId;
}
