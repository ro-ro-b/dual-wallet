// Wallet-owned model of a reviewed product application ("product face") that a
// programme publisher serves into the authenticated wallet. The shared contract
// is contracts/dual-product-face-v1.json; this module holds its pure rules.

export const PRODUCT_FACE_CONTRACT = "dual-product-face-v1";

export const registrationStatuses = [
  "not_submitted",
  "authorized",
  "pending",
  "ownership_moved_state_pending",
  "review_required",
  "already_registered",
  "registered",
  "refused",
  "recovery_required",
  "outcome_unknown",
] as const;
export type RegistrationStatus = (typeof registrationStatuses)[number];

export function isRegistrationStatus(
  value: unknown,
): value is RegistrationStatus {
  return (
    typeof value === "string" &&
    (registrationStatuses as readonly string[]).includes(value)
  );
}

export const projectionFieldNames = [
  "recordId",
  "title",
  "serialNumber",
  "model",
  "manufacturer",
  "state",
] as const;
export type ProjectionField = (typeof projectionFieldNames)[number];

export function isProjectionField(value: unknown): value is ProjectionField {
  return (
    typeof value === "string" &&
    (projectionFieldNames as readonly string[]).includes(value)
  );
}

const OBJECT_ID = /^[0-9a-f]{24}$/;
const OPERATION_ID = /^[a-z0-9-]{8,64}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_HASH = /^sha256:[0-9a-f]{64}$/;
const TASK_PATH =
  /^\/(?:[a-z0-9][a-z0-9-]{0,47}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}){0,3})?$/;
export const TASK_PATH_MAX_LENGTH = 200;

export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID.test(value);
}

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID.test(value);
}

export function isRequestHash(value: unknown): value is string {
  return typeof value === "string" && REQUEST_HASH.test(value);
}

export function isTaskPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TASK_PATH_MAX_LENGTH &&
    TASK_PATH.test(value)
  );
}

/** `/products/<slug><task>` back to the task path, or undefined when foreign. */
export function taskPathFromPathname(pathname: string, slug: string) {
  const prefix = `/products/${slug}`;
  if (pathname === prefix || pathname === `${prefix}/`) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return undefined;
  const task = pathname.slice(prefix.length);
  return isTaskPath(task) ? task : undefined;
}

export function productTaskHref(slug: string, task: string) {
  return task === "/" ? `/products/${slug}` : `/products/${slug}${task}`;
}

export interface CanonicalRegistrationRules {
  stateField: string;
  lifecycleTargetField: string;
  settledStates: string[];
  unconfirmedStates: string[];
  endedStates: string[];
}

/**
 * One leaf of the reviewed settle input (contract r5):
 * - `literal`: exactly this value;
 * - `enum`: one of these values, all reviewed target states;
 * - `unchanged`: equal to the fresh host-read object value at that path;
 * - `runtimeIssued`: a per-event value issued by the runtime (commitment id,
 *   hash, timestamp), format-checked here and hash-bound through the
 *   server-read proposal. Either a wallet-known format name or an anchored
 *   regular expression.
 */
export type SettleTemplateLeaf =
  | { literal: string | number | boolean | null }
  | { enum: string[] }
  | { unchanged: true }
  | { runtimeIssued: string };

/**
 * The holder-signed action that settles `ownership_moved_state_pending` (G6).
 * Deployment data, not code. `leaves` maps every dotted leaf path of the
 * proposal input (from its root, e.g. `data.custom.state`) to its rule; the
 * input must have exactly these leaves.
 */
export interface SettleRules {
  action: SettleActionName;
  alias?: string;
  leaves: Record<string, SettleTemplateLeaf>;
  fromStates: string[];
  targetStates: string[];
  /**
   * contract r17 completeCustomMap: `leaves` lists the GOVERNED leaves only;
   * every other key of the host's own fresh read must be in the input,
   * deep-equal to that read (matchCompleteTemplate). A template without it is
   * refused (fail closed).
   */
  preserveUnlisted: boolean;
}

/**
 * G8 (binding.transferRequest): the holder's reviewed request_transfer update,
 * settle shaped. Deployment data from the runtime's template inspection.
 */
export interface TransferRequestRules {
  action: "update";
  leaves: Record<string, SettleTemplateLeaf>;
  /** Settled states a request may start from. */
  fromStates: string[];
  /** The pending state it writes ("Transfer pending"). */
  targetStates: string[];
  preserveUnlisted: boolean;
}

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Wallet-owned meaning of the runtime-issued format names Studio emits. */
const runtimeIssuedFormats: Record<string, (value: unknown) => boolean> = {
  sha256_hex: (value) =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
  sha256_prefixed: (value) =>
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  token: (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value),
  iso_time: (value) =>
    typeof value === "string" &&
    ISO_TIME.test(value) &&
    !Number.isNaN(Date.parse(value)),
  // Studio's proof_event.public_fields: short labelled facts such as
  // "state:Authenticity verified"; plain text only, bounded.
  public_fields: (value) =>
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 200 &&
        !/[\u0000-\u001f\u007f<>]/.test(item),
    ),
};

export function runtimeIssuedCheck(
  rule: unknown,
): ((value: unknown) => boolean) | undefined {
  if (typeof rule !== "string") return undefined;
  if (Object.prototype.hasOwnProperty.call(runtimeIssuedFormats, rule)) {
    return runtimeIssuedFormats[rule];
  }
  if (!rule.startsWith("^") || !rule.endsWith("$") || rule.length > 200) {
    return undefined;
  }
  try {
    const pattern = new RegExp(rule);
    return (value) =>
      typeof value === "string" && value.length <= 512 && pattern.test(value);
  } catch {
    return undefined;
  }
}

// Standard actions a holder settle may use. Ownership-moving or destructive
// actions — claim_ownership, transfer, burn, permit and the like — are never
// a settle, whatever a deployment configures.
export const settleActionNames = [
  "update",
  "set_attributes",
  "remote",
] as const;
export type SettleActionName = (typeof settleActionNames)[number];

export function isSettleActionName(value: unknown): value is SettleActionName {
  return (
    typeof value === "string" &&
    (settleActionNames as readonly string[]).includes(value)
  );
}

const LEAF_PATH =
  /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown) {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.length <= 500) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Validates one deployment-supplied leaf rule against the target states. */
export function parseTemplateLeaf(
  value: unknown,
  targetStates: readonly string[],
): SettleTemplateLeaf | undefined {
  if (!plainRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  switch (keys[0]) {
    case "literal":
      return scalar(value.literal)
        ? { literal: value.literal as string | number | boolean | null }
        : undefined;
    case "enum":
      return Array.isArray(value.enum) &&
        value.enum.length > 0 &&
        value.enum.every(
          (item) => typeof item === "string" && targetStates.includes(item),
        )
        ? { enum: [...(value.enum as string[])] }
        : undefined;
    case "unchanged":
      return value.unchanged === true ? { unchanged: true } : undefined;
    case "runtimeIssued":
      return runtimeIssuedCheck(value.runtimeIssued)
        ? { runtimeIssued: value.runtimeIssued as string }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Flattens a nested template (`{data: {custom: {state: {enum: [...]}}}}`)
 * into leaf paths. A node is a leaf when it is a valid leaf rule.
 */
export function flattenSettleTemplate(
  template: unknown,
  targetStates: readonly string[],
  prefix = "",
  depth = 0,
): Record<string, SettleTemplateLeaf> | undefined {
  if (!plainRecord(template) || depth > 7) return undefined;
  const entries = Object.entries(template);
  if (!entries.length) return undefined;
  const leaves: Record<string, SettleTemplateLeaf> = {};
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!LEAF_PATH.test(path)) return undefined;
    const leaf = parseTemplateLeaf(child, targetStates);
    if (leaf) {
      leaves[path] = leaf;
      continue;
    }
    const nested = flattenSettleTemplate(child, targetStates, path, depth + 1);
    if (!nested) return undefined;
    Object.assign(leaves, nested);
  }
  return leaves;
}

/** Validates a flat leaf map, optionally rooted at an input path. */
export function parseSettleLeaves(
  leaves: unknown,
  targetStates: readonly string[],
  inputPath = "",
): Record<string, SettleTemplateLeaf> | undefined {
  if (!plainRecord(leaves)) return undefined;
  const entries = Object.entries(leaves);
  if (!entries.length || entries.length > 128) return undefined;
  if (inputPath && !LEAF_PATH.test(inputPath)) return undefined;
  const result: Record<string, SettleTemplateLeaf> = {};
  for (const [key, rule] of entries) {
    const path = inputPath ? `${inputPath}.${key}` : key;
    const leaf = parseTemplateLeaf(rule, targetStates);
    if (!LEAF_PATH.test(path) || !leaf) return undefined;
    result[path] = leaf;
  }
  const paths = Object.keys(result);
  // No leaf may also be the parent of another leaf.
  if (
    paths.some((path) => paths.some((other) => other.startsWith(`${path}.`)))
  ) {
    return undefined;
  }
  return result;
}

/** Server-resolved programme binding as the wallet browser code receives it. */
export interface ProductFaceApplication {
  slug: string;
  id: string;
  version: string;
  publisher: string;
  programme: { id: string; name: string };
  origin: string;
  path: string;
  artifact: string;
  contract: typeof PRODUCT_FACE_CONTRACT;
  templateIds: string[];
  projectionFields: ProjectionField[];
  canonicalRegistration: CanonicalRegistrationRules;
  settle: SettleRules | null;
  /** G8: absent means programme.product.transfer.sign is not granted. */
  transferRequest: TransferRequestRules | null;
}

export interface ProductFaceEntry {
  slug: string;
  programmeName: string;
  publisher: string;
}

/** A programme object as the wallet reads it for its own holder. */
export interface ProgrammeProduct {
  objectId: string;
  templateId: string;
  name: string;
  imageUrl?: string;
  owner: string;
  custom: Record<string, unknown>;
  modifiedAt: Date;
}

export interface ProductAttribute {
  key: string;
  value: unknown;
}

export interface ProductHistoryEntry {
  actionId: string;
  action: string;
  status: "pending" | "completed" | "failed";
  when: Date;
}

export type CanonicalRegistration =
  | "registered"
  | "ownership_moved_state_pending"
  | "recovery_required"
  | "review_required"
  | "not_owned";

export interface RegistrationReadback {
  ownerIsYou: boolean;
  state: string | null;
  lifecycleTarget: string | null;
}

/** Canonical unit facts the host shows in its own confirmation. */
export interface ProgrammeUnitFacts {
  objectId: string;
  templateId: string;
  name: string;
  imageUrl?: string;
  /** The public projection's `custom.recordId`, or null when absent. */
  recordId: string | null;
  fields: Partial<Record<ProjectionField, string>>;
  readback: RegistrationReadback;
  registration: CanonicalRegistration;
}

export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stateValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function registrationReadback(
  owner: string,
  holder: string,
  custom: unknown,
  rules: CanonicalRegistrationRules,
): RegistrationReadback {
  return {
    ownerIsYou:
      Boolean(owner) &&
      Boolean(holder) &&
      owner.toLowerCase() === holder.toLowerCase(),
    state: stateValue(readPath(custom, rules.stateField)),
    lifecycleTarget: stateValue(readPath(custom, rules.lifecycleTargetField)),
  };
}

/**
 * Wallet-side half of the registration rule. Owner equality alone is never
 * registration: the Dual state must be settled and any lifecycle target must
 * agree with it. A pending transfer is explicitly not registered.
 */
export function evaluateCanonicalRegistration(
  readback: RegistrationReadback,
  rules: CanonicalRegistrationRules,
): CanonicalRegistration {
  if (!readback.ownerIsYou) return "not_owned";
  const { state, lifecycleTarget } = readback;
  if (state === null) return "review_required";
  if (rules.endedStates.includes(state)) return "recovery_required";
  if (rules.unconfirmedStates.includes(state)) {
    return "ownership_moved_state_pending";
  }
  if (rules.settledStates.includes(state)) {
    return lifecycleTarget === null || lifecycleTarget === state
      ? "registered"
      : "recovery_required";
  }
  return "review_required";
}

export function projectFields(
  custom: unknown,
  fields: readonly ProjectionField[],
): Partial<Record<ProjectionField, string>> {
  const result: Partial<Record<ProjectionField, string>> = {};
  for (const field of fields) {
    const value = readPath(custom, field);
    if (typeof value === "string" && value.length <= 200) {
      result[field] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[field] = String(value);
    }
  }
  return result;
}

export const runtimeOperationNames = [
  "registration.submit",
  "registration.status",
  "registration.settle.propose",
  "registration.settle.verify",
  // r8/r9: read-only reconcile of a settle reservation, and the original
  // pending registration of the selected unit. Reads; never an intent.
  "registration.settle.status",
  "registration.pending.read",
  // r8: the wallet BFF's own server-to-server reservation before any holder
  // execution; never authorized for the face.
  "registration.settle.reserve",
  "products.private.read",
  "cases.list",
  "case.read",
  "case.open",
  "case.evidence.submit",
  "case.information.provide",
  "case.quote.approve",
  "case.quote.decline",
  // contract r16 protectedTransfer (G8).
  "transfer.offer",
  "transfer.offer.read",
  "transfer.accept",
  "transfer.read",
  "transfer.cancel",
  "transfer.propose",
  "transfer.reserve",
  "transfer.verify",
  "transfer.status",
  // r19: the recipient's host reads which unit its acceptance is for.
  "transfer.acceptance.read",
] as const;
export type RuntimeOperation = (typeof runtimeOperationNames)[number];

export const runtimeWriteOperations = [
  "case.open",
  "case.evidence.submit",
  "case.information.provide",
  "case.quote.approve",
  "case.quote.decline",
  // G8: the holder creates or cancels a transfer offer for the selected
  // product (runtime store only; the wallet confirms natively first).
  "transfer.offer",
  "transfer.cancel",
] as const satisfies readonly RuntimeOperation[];
export type RuntimeWriteOperation = (typeof runtimeWriteOperations)[number];

export function isRuntimeOperation(value: unknown): value is RuntimeOperation {
  return (
    typeof value === "string" &&
    (runtimeOperationNames as readonly string[]).includes(value)
  );
}

export function isRuntimeWriteOperation(
  value: unknown,
): value is RuntimeWriteOperation {
  return (
    typeof value === "string" &&
    (runtimeWriteOperations as readonly string[]).includes(value)
  );
}

/** Operations scoped to one of the holder's own programme products. */
export const productScopedRuntimeOperations = [
  "products.private.read",
  "cases.list",
  "case.read",
  "registration.settle.propose",
  "registration.settle.verify",
  "registration.settle.status",
  "registration.pending.read",
  ...runtimeWriteOperations,
] as const satisfies readonly RuntimeOperation[];

export function isProductScopedRuntimeOperation(value: RuntimeOperation) {
  return (productScopedRuntimeOperations as readonly string[]).includes(value);
}

/** The only runtime reads the wallet BFF performs itself, for host UI. */
export const trustedRuntimeReadOperations = [
  "registration.settle.propose",
  "case.read",
] as const satisfies readonly RuntimeOperation[];
export type TrustedRuntimeRead = (typeof trustedRuntimeReadOperations)[number];

/**
 * contract r10: case operations are the linked Warranty runtime's. Their
 * assertions name it as the audience and the host's case.read goes to it.
 * cases.list reads that runtime's own cases as well.
 */
export function isLinkedCaseOperation(operation: RuntimeOperation) {
  return operation.startsWith("case.") || operation === "cases.list";
}

/** Runtime operations only the wallet BFF itself calls; never face-authorized. */
export const hostOnlyRuntimeOperations = [
  "registration.settle.propose",
  "registration.settle.reserve",
  // G8: the holder's host signs each transfer step itself (transfer.sign).
  "transfer.propose",
  "transfer.reserve",
  "transfer.verify",
  "transfer.status",
  "transfer.acceptance.read",
] as const satisfies readonly RuntimeOperation[];

/**
 * G8 operations a face may run without a selected owned product: the
 * recipient previews an offer (target {}) and accepts it for the offered unit
 * (target {object_id}, r19), and either party reads an offer's
 * progress by its unit (target {object_id}). The runtime authorises each by
 * the assertion holder alone (the offer's holder or bound recipient).
 */
export const unscopedTransferOperations = [
  "transfer.offer.read",
  "transfer.accept",
  "transfer.read",
] as const satisfies readonly RuntimeOperation[];

export function isUnscopedTransferOperation(value: RuntimeOperation) {
  return (unscopedTransferOperations as readonly string[]).includes(value);
}

/**
 * Unscoped transfer operations whose target is empty (no unit named). Since
 * the r19, transfer.accept names the offered unit ({object_id}): the
 * unit the host read itself for its acceptance and named in its confirmation.
 */
export function transferOperationTargetsNothing(value: RuntimeOperation) {
  return value === "transfer.offer.read";
}

export function isHostOnlyRuntimeOperation(value: RuntimeOperation) {
  return (hostOnlyRuntimeOperations as readonly string[]).includes(value);
}

/** sha256 of the canonical {quote_version, amount, currency} a decision binds. */
export function quoteHashInput(quote: {
  quote_version: string;
  amount: string;
  currency: string;
}) {
  return canonicalJson({
    quote_version: quote.quote_version,
    amount: quote.amount,
    currency: quote.currency,
  });
}

/** r8: the reserve request_hash input, exactly {proposal_id, settle_operation_id, object_id}. */
export function settleReserveHashInput(input: {
  proposalId: string;
  settleOperationId: string;
  objectId: string;
}) {
  return canonicalJson({
    proposal_id: input.proposalId,
    settle_operation_id: input.settleOperationId,
    object_id: input.objectId,
  });
}

export function isQuoteOperation(operation: RuntimeOperation) {
  return (
    operation === "case.quote.approve" || operation === "case.quote.decline"
  );
}

/**
 * Operations whose target names a case as well as the product. contract r10
 * linked cases: case.open opens the case Studio prepared for the holder's
 * unit, so its target is exactly {object_id, case_id}; it never creates one.
 */
export function runtimeOperationNeedsCase(operation: RuntimeOperation) {
  return (
    operation === "case.read" ||
    operation === "case.open" ||
    operation === "case.evidence.submit" ||
    operation === "case.information.provide" ||
    operation === "case.quote.approve" ||
    operation === "case.quote.decline"
  );
}

/** Deterministic JSON with sorted keys, used for request and proposal hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported_value");
}

export interface SettleFieldChange {
  field: string;
  /** `technical`: a runtime-issued commitment (hash, id, timestamp). */
  kind: "value" | "technical";
  /** Display text; null when the field is absent or null. */
  from: string | null;
  to: string | null;
}

function displayValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Every leaf path of a JSON value. Plain objects recurse; anything else, an
 * empty object included, is a leaf. */
export function inputLeaves(
  value: unknown,
  prefix = "",
  depth = 0,
): Array<[string, unknown]> {
  if (!plainRecord(value) || depth > 8 || !Object.keys(value).length) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    inputLeaves(child, prefix ? `${prefix}.${key}` : key, depth + 1),
  );
}

/** The object `custom` path a proposal leaf writes, if it writes custom data. */
export function customPathOf(field: string) {
  if (field.startsWith("data.custom."))
    return field.slice("data.custom.".length);
  if (field.startsWith("custom.")) return field.slice("custom.".length);
  return undefined;
}

/**
 * Deep-checks proposal input against the reviewed leaf rules: exactly the
 * template's leaves, nothing more or less, each passing its rule. Returns the
 * leaf values, or undefined to refuse.
 */
export function matchSettleTemplate(
  input: unknown,
  leaves: Record<string, SettleTemplateLeaf>,
  currentCustom: unknown,
): Array<[string, unknown]> | undefined {
  if (!plainRecord(input)) return undefined;
  const found = inputLeaves(input);
  const expected = Object.keys(leaves);
  if (
    found.length !== expected.length ||
    !found.every(([path]) => Object.prototype.hasOwnProperty.call(leaves, path))
  ) {
    return undefined;
  }
  for (const [path, value] of found) {
    const rule = leaves[path];
    if ("literal" in rule) {
      if (value !== rule.literal) return undefined;
    } else if ("enum" in rule) {
      if (typeof value !== "string" || !rule.enum.includes(value)) return;
    } else if ("unchanged" in rule) {
      const customPath = customPathOf(path);
      const current = customPath
        ? readPath(currentCustom, customPath)
        : undefined;
      if (current === undefined) return undefined;
      try {
        if (canonicalJson(current) !== canonicalJson(value)) return undefined;
      } catch {
        return undefined;
      }
    } else {
      const check = runtimeIssuedCheck(rule.runtimeIssued);
      if (!check || !check(value)) return undefined;
    }
  }
  return found;
}

function leafPasses(
  rule: SettleTemplateLeaf,
  path: string,
  value: unknown,
  currentCustom: unknown,
) {
  if ("literal" in rule) return value === rule.literal;
  if ("enum" in rule) {
    return typeof value === "string" && rule.enum.includes(value);
  }
  if ("unchanged" in rule) {
    const customPath = customPathOf(path);
    const current = customPath
      ? readPath(currentCustom, customPath)
      : undefined;
    return current !== undefined && sameValue(current, value);
  }
  const check = runtimeIssuedCheck(rule.runtimeIssued);
  return Boolean(check && check(value));
}

/**
 * contract r17 completeCustomMap (`preserveUnlisted`): the input carries the
 * COMPLETE custom map, so nothing the unit holds can be dropped whether Dual
 * merges or replaces `data.custom`. Refuses (undefined) unless:
 * - every governed leaf of the template is present and passes its rule;
 * - every other input leaf is a custom leaf, not inside a governed leaf, and
 *   deep-equal to the host's own fresh value at that path (an input key the
 *   fresh object does not have is refused);
 * - every fresh custom leaf the template does not govern is in the input.
 * Returns the governed leaf values.
 */
export function matchCompleteTemplate(
  input: unknown,
  leaves: Record<string, SettleTemplateLeaf>,
  currentCustom: unknown,
): Array<[string, unknown]> | undefined {
  if (!plainRecord(input)) return undefined;
  if (
    currentCustom !== undefined &&
    currentCustom !== null &&
    !plainRecord(currentCustom)
  ) {
    return undefined;
  }
  const found = new Map(inputLeaves(input));
  const governedPaths = Object.keys(leaves);
  const governedCustom = governedPaths.flatMap((path) => {
    const customPath = customPathOf(path);
    return customPath ? [customPath] : [];
  });
  const governed: Array<[string, unknown]> = [];
  for (const path of governedPaths) {
    if (!found.has(path)) return undefined;
    const value = found.get(path);
    if (!leafPasses(leaves[path], path, value, currentCustom)) return undefined;
    governed.push([path, value]);
  }
  for (const [path, value] of found) {
    if (Object.prototype.hasOwnProperty.call(leaves, path)) continue;
    const customPath = customPathOf(path);
    if (
      !customPath ||
      governedCustom.some((item) => customPath.startsWith(`${item}.`))
    ) {
      return undefined;
    }
    const current = readPath(currentCustom, customPath);
    if (current === undefined || !sameValue(current, value)) return undefined;
  }
  if (plainRecord(currentCustom) && Object.keys(currentCustom).length) {
    const prefix = governedPaths[0]?.startsWith("custom.")
      ? "custom."
      : "data.custom.";
    for (const [path] of inputLeaves(currentCustom)) {
      if (
        governedCustom.some(
          (item) => path === item || path.startsWith(`${item}.`),
        )
      ) {
        continue;
      }
      // Present as a leaf, or inside a deeper subtree the input carries
      // whole (beyond the leaf depth), already compared deep-equal above.
      const parts = path.split(".");
      const covered = parts.some((_, index) =>
        found.has(`${prefix}${parts.slice(0, index + 1).join(".")}`),
      );
      if (!covered) return undefined;
    }
  }
  return governed;
}

/**
 * contract r7 (complete custom map): api-v3 does not state whether an Update
 * merges or replaces nested `data.custom`, so a settle may only run when
 * every key of the FRESH object's custom map is one of the template's listed
 * leaves; then no key can be dropped under replace semantics. Returns the
 * fresh custom leaf paths the template does not list (empty when complete),
 * or undefined when the fresh custom is not a map at all.
 */
export function unlistedCustomKeys(
  currentCustom: unknown,
  leaves: Record<string, SettleTemplateLeaf>,
): string[] | undefined {
  if (currentCustom === undefined || currentCustom === null) return [];
  if (!plainRecord(currentCustom)) return undefined;
  if (!Object.keys(currentCustom).length) return [];
  const listed = Object.keys(leaves).flatMap((field) => {
    const customPath = customPathOf(field);
    return customPath ? [customPath] : [];
  });
  return inputLeaves(currentCustom)
    .map(([path]) => path)
    .filter(
      (path) =>
        !listed.some((leaf) => path === leaf || path.startsWith(`${leaf}.`)),
    );
}

/** A proposal the wallet obtained itself from the bound runtime. */
export interface SettleProposal {
  proposalId: string;
  operationId: string;
  objectId: string;
  action: string;
  input: Record<string, unknown>;
  proposalHash: string;
  expiresAt: Date;
}

export type SettleProposalCheck =
  | { ok: true; changes: SettleFieldChange[] }
  | { ok: false; reason: "proposal_rejected" };

/**
 * The proposal is untrusted until it is bound to this unit and original
 * operation, unexpired, the reviewed action, and template-exact, with the
 * canonical state and lifecycle target it writes agreeing. The host derives
 * the changes it shows from the proposal and the fresh object, never from
 * face-supplied text. The hash is checked separately by the caller.
 */
export function checkSettleProposal(
  proposal: SettleProposal,
  expected: { operationId: string; objectId: string; now: number },
  currentCustom: unknown,
  settle: SettleRules,
  canonical: CanonicalRegistrationRules,
): SettleProposalCheck {
  if (
    proposal.operationId !== expected.operationId ||
    proposal.objectId !== expected.objectId ||
    proposal.expiresAt.getTime() <= expected.now ||
    proposal.action !== settle.action ||
    !isSettleActionName(proposal.action) ||
    // r17: only a complete-map template; an older one is refused.
    settle.preserveUnlisted !== true
  ) {
    return { ok: false, reason: "proposal_rejected" };
  }
  // r7 + r17: the complete custom map; no fresh key can be dropped.
  const leaves = matchCompleteTemplate(
    proposal.input,
    settle.leaves,
    currentCustom,
  );
  if (!leaves) return { ok: false, reason: "proposal_rejected" };
  const written = new Map(
    leaves.flatMap(([field, value]) => {
      const customPath = customPathOf(field);
      return customPath ? [[customPath, value] as const] : [];
    }),
  );
  const state = written.get(canonical.stateField);
  const target = written.get(canonical.lifecycleTargetField);
  if (
    (state !== undefined &&
      (typeof state !== "string" || !settle.targetStates.includes(state))) ||
    (state !== undefined && target !== undefined && state !== target)
  ) {
    return { ok: false, reason: "proposal_rejected" };
  }
  const changes: SettleFieldChange[] = [];
  for (const [field, value] of leaves) {
    const customPath = customPathOf(field);
    const current = customPath
      ? readPath(currentCustom, customPath)
      : undefined;
    // Values that stay the same (verified-unchanged ones included) are not
    // a change to show.
    if (sameValue(current ?? null, value)) continue;
    changes.push({
      field,
      kind: "runtimeIssued" in settle.leaves[field] ? "technical" : "value",
      from: displayValue(current),
      to: displayValue(value),
    });
  }
  return { ok: true, changes };
}

function sameValue(left: unknown, right: unknown) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/** Canonical JSON the runtime hashes for a proposal. */
export function proposalHashInput(proposal: {
  objectId: string;
  action: string;
  input: Record<string, unknown>;
}) {
  return canonicalJson({
    object_id: proposal.objectId,
    action: proposal.action,
    input: proposal.input,
  });
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const QUOTE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isDecimalAmount(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && CURRENCY.test(value);
}

export function isQuoteVersion(value: unknown): value is string {
  return typeof value === "string" && QUOTE_VERSION.test(value);
}

/** Authoritative quote facts the host read from the runtime itself. */
export interface CaseQuote {
  caseId: string;
  quoteVersion: string;
  provider: string;
  /** Exact decimal string; never converted through a float. */
  amount: string;
  currency: string;
}

/** A typed, user-safe product-face failure; `code` is a contract error. */
export class ProductFaceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    /** A runtime-stated reason (for example why no settle proposal exists). */
    public readonly reason?: string,
  ) {
    super(code);
    this.name = "ProductFaceError";
  }
}

/**
 * G6b: why the brand has no settle proposal for the holder right now. The
 * host shows this honestly; it never invents a proposal.
 */
export const settleProposalUnavailableReasons = [
  "issuer_preauthorisation_absent",
  "issuer_preauthorisation_expired",
  "issuer_auto_proposal_used",
  // contract r12: no explicit, signed settle policy for this unit.
  "issuer_settle_policy_absent",
  // The brand's open confirmation no longer binds this unit as it is now: it
  // was prepared for an earlier revision of the product's record, or under
  // an earlier app release or template. The brand proposes it again.
  "face_settle_proposal_stale",
  "face_settle_proposal_release_changed",
] as const;
export type SettleProposalUnavailableReason =
  (typeof settleProposalUnavailableReasons)[number];

export function isSettleProposalUnavailableReason(
  value: unknown,
): value is SettleProposalUnavailableReason {
  return (
    typeof value === "string" &&
    (settleProposalUnavailableReasons as readonly string[]).includes(value)
  );
}

export type SessionEndReason = "logout" | "expired" | "account_changed";

/** What the host's own confirmation dialog shows. Never face-supplied text. */
export type ProductFaceConfirmation =
  | { kind: "registration"; unit: ProgrammeUnitFacts }
  | {
      kind: "runtime";
      operation: RuntimeWriteOperation;
      product: { objectId: string; name: string };
      caseId?: string;
      quote?: CaseQuote;
    }
  | {
      kind: "settle";
      product: { objectId: string; name: string };
      action: SettleActionName;
      changes: SettleFieldChange[];
    }
  | {
      /** G8: one holder-signed transfer step; ownership moves. */
      kind: "transfer";
      product: { objectId: string; name: string };
      step: "request" | "transfer";
      /** The runtime-bound recipient, read by the wallet itself. */
      recipient: string;
    }
  | {
      /**
       * G8: accept an offered product into this wallet. The unit is the one
       * the wallet itself read for the acceptance it opened (r19),
       * from Dual's public projection: never face text, an owner address, a
       * case or a document.
       */
      kind: "transfer_accept";
      unit: ProgrammeUnitFacts;
    };

/**
 * A fresh, random launch id (24 bytes, base64url) for one frame of a product
 * face. The BFF keeps each launch's own journal and selection.
 */
export function newFaceLaunchId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
