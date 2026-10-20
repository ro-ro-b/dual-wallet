import type { PublicSmartObject } from "@/api/web-sdk/models/PublicSmartObject";
import type { SmartObject } from "@/api/web-sdk/models/SmartObject";
import type { ObjectRecordFacts } from "@/app/_domain/ticket-admission";
import type { TicketSource } from "@/app/_domain/tickets";

function customRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toTicketSource(object: SmartObject): TicketSource {
  return {
    objectId: object.id.toLowerCase(),
    templateId: object.templateId.toLowerCase(),
    orgId: object.orgId,
    owner: object.owner,
    name: object.metadata?.name || object.id,
    custom: customRecord(object.custom),
    modifiedAt: object.whenModified,
  };
}

const timeOf = (value: unknown) =>
  value instanceof Date ? value.getTime() : Number.NaN;

/** One provider read's identity, fingerprints and custom map, as answered. */
export function toObjectRecordFacts(
  object: SmartObject | PublicSmartObject,
): ObjectRecordFacts {
  return {
    id: object.id.toLowerCase(),
    templateId: object.templateId,
    owner: object.owner,
    nonce: object.nonce,
    version: object.version,
    stateHash: object.stateHash,
    contentHash: object.contentHash,
    integrityHash: object.integrityHash,
    prevIntegrityHash: object.prevIntegrityHash,
    customHash: object.customHash ?? null,
    // A missing time is NaN, which equals nothing: never coherent.
    whenCreated: timeOf(object.whenCreated),
    whenModified: timeOf(object.whenModified),
    custom: object.custom,
  };
}
