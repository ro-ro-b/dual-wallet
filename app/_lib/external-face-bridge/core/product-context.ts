import {
  projectFields,
  type ProductFaceApplication,
  type ProgrammeProduct,
  type ProjectionField,
} from "@/app/_domain/product-face";

/** Minimized product as the face may see it. No owner, custom data or hash. */
export interface ProductProjection {
  object_id: string;
  template_id: string;
  name: string;
  image_url: string | null;
  fields: Partial<Record<ProjectionField, string>>;
  owned_by_you: boolean;
  when_modified: string;
}

export interface RuntimeAssertionTarget {
  object_id?: string;
  case_id?: string;
  quote_version?: number;
  amount?: string;
  currency?: string;
}

export function toProductProjection(
  product: ProgrammeProduct,
  application: ProductFaceApplication,
  holder: string,
): ProductProjection {
  return {
    object_id: product.objectId,
    template_id: product.templateId,
    name: product.name,
    image_url: product.imageUrl ?? null,
    fields: projectFields(product.custom, application.projectionFields),
    owned_by_you: product.owner.toLowerCase() === holder.toLowerCase(),
    when_modified: product.modifiedAt.toISOString(),
  };
}

/**
 * The application-variant initialize context. It carries no object, wallet
 * ID, wallet address, token, cookie, assertion or raw DTO; the only
 * capability it may carry is a face runtime's own one-time handover (or G8
 * transfer acceptance) ticket.
 */
export function productFaceInitializeContext(
  application: ProductFaceApplication,
  task: string,
  capabilities: string[],
  /** contract r14: a one-time handover ticket, on the register task only. */
  handoverTicket?: string,
  /** G8 (r16): a one-time transfer acceptance ticket, on the accept task only. */
  acceptanceTicket?: string,
) {
  return {
    object_id: null,
    variant: "application" as const,
    public: false,
    locale: document.documentElement.lang || "en",
    theme: document.documentElement.dataset.theme || "light",
    object: null,
    config: null,
    actions: [],
    capabilities,
    application: {
      id: application.id,
      version: application.version,
      publisher: application.publisher,
    },
    programme: {
      id: application.programme.id,
      name: application.programme.name,
    },
    task: { path: task },
    ...(handoverTicket ? { handover: { ticket: handoverTicket } } : {}),
    ...(acceptanceTicket ? { acceptance: { ticket: acceptanceTicket } } : {}),
  };
}
