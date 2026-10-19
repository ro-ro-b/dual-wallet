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

const PASS_PAGE = 25;
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
  | { ok: true; pass: OwnedObjectFacts | undefined }
  | { ok: false; code: "session_expired" };

/**
 * The holder's own pass, by the session's own credential: listed by owner
 * and the bound pass template, then exactly the runtime-named object.
 */
export async function ownPass(
  accessToken: string,
  holder: string,
  passTemplateId: string,
  passObjectId: string,
): Promise<OwnPassRead> {
  try {
    const result = await getObjectsApi(accessToken).listObjects(
      { owner: holder, templateId: passTemplateId, limit: PASS_PAGE },
      { cache: "no-store" },
    );
    const object = result.objects.find((item) => item.id === passObjectId);
    const owner = object ? lowerAddress(object.owner) : undefined;
    return {
      ok: true,
      pass:
        object && owner
          ? {
              id: object.id,
              templateId: object.templateId,
              owner,
              orgId: object.orgId,
              custom: record(object.custom) ? object.custom : {},
            }
          : undefined,
    };
  } catch (error) {
    if (error instanceof ResponseError && error.response.status === 401) {
      return { ok: false, code: "session_expired" };
    }
    return { ok: true, pass: undefined };
  }
}
