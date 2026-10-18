import type { SmartObject } from "@/api/web-sdk/models/SmartObject";
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
