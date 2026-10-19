import "server-only";

import { getEbusApi, getObjectsApi } from "@/api/web-sdk-client";
import { ResponseError } from "@/api/web-sdk/runtime";
import type {
  OwnedObjectFacts,
  PublicActionFacts,
  PublicObjectFacts,
  PublicStateChangeFacts,
} from "@/app/_domain/loyalty";

// loyalty-join-earn-v1 §5: the wallet's OWN provider reads. The public object,
// action log and state history take no credential (the provider's published
// views); only the holder's own pass is read with the session's credential.
// Each answer is projected to exactly the facts a proof compares; anything
// missing or ambiguous is `undefined` (unproven), never a guess.

const lowerAddress = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : undefined;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `GET /public/objects/{id}`: owner, template, fingerprints, public custom. */
export async function publicObject(
  objectId: string,
): Promise<PublicObjectFacts | undefined> {
  try {
    const object = await getObjectsApi().getObjectByIdPublic(
      { objectId },
      { cache: "no-store" },
    );
    const owner = lowerAddress(object.owner);
    if (!owner || object.id !== objectId) return undefined;
    return {
      id: object.id,
      templateId: object.templateId,
      owner,
      nonce: object.nonce,
      stateHash: object.stateHash,
      contentHash: object.contentHash,
      custom: record(object.custom) ? object.custom : {},
    };
  } catch {
    return undefined;
  }
}

/** `GET /public/action-logs?id=<id>&limit=1`: exactly that one action. */
export async function publicAction(
  actionId: string,
): Promise<PublicActionFacts | undefined> {
  try {
    const result = await getEbusApi().listActionLogsPublic(
      { id: actionId, limit: 1 },
      { cache: "no-store" },
    );
    if (result.actionLogs.length !== 1) return undefined;
    const [log] = result.actionLogs;
    const account = lowerAddress(log.account);
    if (log.id !== actionId || !account) return undefined;
    return {
      id: log.id,
      name: log.name,
      account,
      affected: log.affectedObjects.map((item) => ({
        id: item.id,
        templateId: item.templateId,
        stateChangeId: item.stateChangeId,
      })),
      to: lowerAddress(log.params?.to) ?? null,
      templateId: log.params?.templateId ?? null,
    };
  } catch {
    return undefined;
  }
}

function stateChangeFacts(change: {
  id: string;
  actionId: string;
  actionName: string;
  objectId: string;
  nextNonce: number;
  nextContentHash: string;
  prevOwner: string;
  currentOwner: string;
}): PublicStateChangeFacts {
  return {
    id: change.id,
    actionId: change.actionId,
    actionName: change.actionName,
    objectId: change.objectId,
    nextNonce: change.nextNonce,
    nextContentHash: change.nextContentHash,
    prevOwner: change.prevOwner,
    currentOwner: change.currentOwner,
  };
}

/** One named public state change of one object. */
export async function publicStateChange(
  objectId: string,
  stateChangeId: string,
): Promise<PublicStateChangeFacts | undefined> {
  try {
    const result = await getObjectsApi().listStateChangesPublic(
      { objectId, id: stateChangeId, limit: 1 },
      { cache: "no-store" },
    );
    if (result.stateChanges.length !== 1) return undefined;
    const [change] = result.stateChanges;
    return change.id === stateChangeId && change.objectId === objectId
      ? stateChangeFacts(change)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An object's first public state change (its mint), oldest first. */
export async function firstStateChange(
  objectId: string,
): Promise<PublicStateChangeFacts | undefined> {
  try {
    const result = await getObjectsApi().listStateChangesPublic(
      { objectId, limit: 1, order: "asc" },
      { cache: "no-store" },
    );
    const [change] = result.stateChanges;
    return change && change.objectId === objectId
      ? stateChangeFacts(change)
      : undefined;
  } catch {
    return undefined;
  }
}

export type OwnPassRead =
  /** An exact answer: the holder holds exactly this pass, or none such. */
  | { ok: true; pass: OwnedObjectFacts | undefined }
  | { ok: false; code: "session_expired" | "unavailable" };

/**
 * The holder's own pass, by the session's own credential: exactly the
 * runtime-named object id, together with owner = holder and the bound pass
 * template, so no inventory page can hide it. Only an exact empty answer
 * (or the id not found) says the holder does not hold it yet; a refused,
 * failed, malformed or ambiguous read says nothing about absence.
 */
export async function ownPass(
  accessToken: string,
  holder: string,
  passTemplateId: string,
  passObjectId: string,
): Promise<OwnPassRead> {
  let objects: unknown;
  try {
    const result = await getObjectsApi(accessToken).listObjects(
      {
        id: passObjectId,
        owner: holder,
        templateId: passTemplateId,
        limit: 2,
      },
      { cache: "no-store" },
    );
    objects = (result as { objects?: unknown } | undefined)?.objects;
  } catch (error) {
    if (error instanceof ResponseError && error.response.status === 401) {
      return { ok: false, code: "session_expired" };
    }
    if (error instanceof ResponseError && error.response.status === 404) {
      return { ok: true, pass: undefined };
    }
    return { ok: false, code: "unavailable" };
  }
  if (!Array.isArray(objects) || objects.length > 1) {
    return { ok: false, code: "unavailable" };
  }
  if (!objects.length) return { ok: true, pass: undefined };
  const [object] = objects as Array<Record<string, unknown>>;
  const owner = record(object) ? lowerAddress(object.owner) : undefined;
  // Exactly the object asked for, or the read proves nothing.
  if (
    !record(object) ||
    object.id !== passObjectId ||
    object.templateId !== passTemplateId ||
    !owner ||
    owner !== holder.toLowerCase()
  ) {
    return { ok: false, code: "unavailable" };
  }
  return {
    ok: true,
    pass: {
      id: object.id,
      templateId: object.templateId,
      owner,
      orgId: typeof object.orgId === "string" ? object.orgId : "",
      custom: record(object.custom) ? object.custom : {},
    },
  };
}
