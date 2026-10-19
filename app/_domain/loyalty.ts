// loyalty-join-earn-v1 (docs/proposals/loyalty-join-earn-v1.md): a member
// joins a Loyalty programme from the branded wallet and earns through
// verified activity, on Studio's EXISTING issuer-owned canonical membership
// and participant-opening-pass-v1. Framework-free rules shared by the binding
// parser, the BFF and the native page (relative imports: next.config parses
// the binding without path aliases).
//
// The member signs nothing on Dual. What the wallet says is proven from
// fresh evidence only: the runtime's authenticated exact canonical read and
// its retained full-map action receipts, re-checked against the provider's
// public object, action log and state history and the holder's own pass.
// Dual's current state alone never counts, and nothing here invents points,
// eligibility or a rejection.
import { canonicalJson, isObjectId, isOperationId } from "./product-face";

export const LOYALTY_CONTRACT = "loyalty-join-earn-v1";
/** Studio's purpose id, written into every canonical map. */
export const LOYALTY_PURPOSE = "membership-loyalty-rewards";

/**
 * Host-only runtime operations: the wallet BFF mints them for its own native
 * Loyalty page; no face can ask the assertion route for one.
 */
export const loyaltyHostOperations = [
  "loyalty.programme.read",
  "loyalty.join.request",
  "loyalty.membership.read",
  "loyalty.activity.submit",
  "loyalty.activity.status",
] as const;
export type LoyaltyHostOperation = (typeof loyaltyHostOperations)[number];

export function isLoyaltyHostOperation(
  value: unknown,
): value is LoyaltyHostOperation {
  return (
    typeof value === "string" &&
    (loyaltyHostOperations as readonly string[]).includes(value)
  );
}

/** The canonical lifecycle (Studio src/domain-packs.mjs:225). */
export const LOYALTY_STATES = [
  "Member",
  "Activity pending",
  "Activity verified",
  "Benefit eligible",
  "Redemption pending",
  "Redeemed",
  "Suspended",
  "Expired",
] as const;
const HELD_STATE = "Suspended";
const ENDED_STATE = "Expired";

export const PASS_SCHEMA = "participant-opening-pass-v1";
export const PASS_PRODUCT_TYPE = "participant_opening_pass";

// ------------------------------------------------------------------ binding

export interface LoyaltyRules {
  contract: typeof LOYALTY_CONTRACT;
  /** Studio's catalog model id of the programme. */
  modelId: string;
  /** The programme id the canonical map carries (`custom.programmeId`). */
  programmeId: string;
  canonicalTemplateId: string;
  passTemplateId: string;
  /** Lowercase 0x address: the issuer account that owns and signs. */
  canonicalIssuerAccount: string;
}

const MODEL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const PROGRAMME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const RULE_KEYS = [
  "contract",
  "modelId",
  "programmeId",
  "canonicalTemplateId",
  "passTemplateId",
  "canonicalIssuerAccount",
];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * The binding's optional `loyalty` block: null when absent, undefined when
 * present but not exactly the contract (the binding is then dropped).
 */
export function parseLoyaltyRules(
  value: unknown,
): LoyaltyRules | null | undefined {
  if (value === undefined) return null;
  if (
    !record(value) ||
    !exactKeys(value, RULE_KEYS) ||
    value.contract !== LOYALTY_CONTRACT ||
    typeof value.modelId !== "string" ||
    !MODEL_ID.test(value.modelId) ||
    typeof value.programmeId !== "string" ||
    !PROGRAMME_ID.test(value.programmeId) ||
    !isObjectId(value.canonicalTemplateId) ||
    !isObjectId(value.passTemplateId) ||
    value.canonicalTemplateId === value.passTemplateId ||
    typeof value.canonicalIssuerAccount !== "string" ||
    !ADDRESS.test(value.canonicalIssuerAccount)
  ) {
    return undefined;
  }
  return {
    contract: LOYALTY_CONTRACT,
    modelId: value.modelId,
    programmeId: value.programmeId,
    canonicalTemplateId: value.canonicalTemplateId,
    passTemplateId: value.passTemplateId,
    canonicalIssuerAccount: value.canonicalIssuerAccount,
  };
}

// ---------------------------------------------------------------- wire types

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const REQUEST_ID = /^areq_[A-Za-z0-9_-]{20,40}$/;
export const ACTIVITY_TYPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const FINGERPRINT = /^(?:0x)?[0-9a-fA-F]{16,128}$/;
const TEXT_MAX = 500;
export const EVIDENCE_MAX = 1000;

const text = (value: unknown, max = TEXT_MAX) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const iso = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
const code = (value: unknown) =>
  typeof value === "string" && CODE.test(value) ? value : undefined;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;

export interface Accounting {
  dualWrites: 0 | 1 | "unknown";
  reason: string;
}

export function parseAccounting(value: unknown): Accounting | undefined {
  if (!record(value) || !exactKeys(value, ["dual_writes", "reason"])) return;
  const reason = code(value.reason);
  if (
    !reason ||
    (value.dual_writes !== 0 &&
      value.dual_writes !== 1 &&
      value.dual_writes !== "unknown")
  ) {
    return undefined;
  }
  return { dualWrites: value.dual_writes, reason };
}

/** An exact zero-write answer for exactly this reason. */
const zeroWrite = (accounting: Accounting | undefined, reason?: string) =>
  accounting?.dualWrites === 0 &&
  (reason === undefined || accounting.reason === reason);

export interface LoyaltyActivity {
  activityType: string;
  label: string;
  evidenceHint: string;
}

export interface LoyaltyProgramme {
  modelId: string;
  programmeId: string;
  open: boolean;
  name: string;
  headline: string;
  memberPromise: string;
  termsVersion: string;
  consentStatement: string;
  dataUse: string;
  consentFingerprint: string;
  activities: LoyaltyActivity[];
}

/** §4.1 for exactly the bound programme, or undefined. */
export function parseProgrammeRead(
  body: unknown,
  rules: LoyaltyRules,
): LoyaltyProgramme | undefined {
  if (!record(body) || body.ok !== true || !record(body.programme)) return;
  if (!zeroWrite(parseAccounting(body.accounting), "programme_read")) return;
  if (body.status !== "programme_open" && body.status !== "programme_closed") {
    return undefined;
  }
  const p = body.programme;
  const fields = {
    name: text(p.name, 200),
    headline: text(p.headline),
    memberPromise: text(p.member_promise),
    termsVersion: text(p.terms_version, 64),
    consentStatement: text(p.consent_statement),
    dataUse: text(p.data_use),
  };
  if (
    p.model_id !== rules.modelId ||
    p.programme_id !== rules.programmeId ||
    typeof p.revision_hash !== "string" ||
    !HASH.test(p.revision_hash) ||
    typeof p.consent_fingerprint !== "string" ||
    !HASH.test(p.consent_fingerprint) ||
    Object.values(fields).some((value) => value === undefined) ||
    !fields.name ||
    !fields.termsVersion ||
    !fields.consentStatement ||
    !Array.isArray(p.activities) ||
    p.activities.length > 32
  ) {
    return undefined;
  }
  const activities: LoyaltyActivity[] = [];
  for (const item of p.activities) {
    if (
      !record(item) ||
      typeof item.activity_type !== "string" ||
      !ACTIVITY_TYPE.test(item.activity_type) ||
      !text(item.label, 120) ||
      text(item.evidence_hint, 200) === undefined
    ) {
      return undefined;
    }
    activities.push({
      activityType: item.activity_type,
      label: item.label as string,
      evidenceHint: item.evidence_hint as string,
    });
  }
  return {
    modelId: rules.modelId,
    programmeId: rules.programmeId,
    open: body.status === "programme_open",
    ...(fields as Record<keyof typeof fields, string>),
    consentFingerprint: p.consent_fingerprint,
    activities,
  };
}

/** The programme's own record of the member's join (never a Dual fact). */
export interface LoyaltyJoinRecord {
  requestId: string;
  termsVersion: string;
  consentHash: string;
  requestedAt: string;
}

function parseJoinRecord(value: unknown): LoyaltyJoinRecord | undefined {
  if (!record(value)) return undefined;
  const termsVersion = text(value.terms_version, 64);
  const requestedAt = iso(value.requested_at);
  if (
    typeof value.request_id !== "string" ||
    !REQUEST_ID.test(value.request_id) ||
    !termsVersion ||
    typeof value.consent_hash !== "string" ||
    !HASH.test(value.consent_hash) ||
    !requestedAt
  ) {
    return undefined;
  }
  return {
    requestId: value.request_id,
    termsVersion,
    consentHash: value.consent_hash,
    requestedAt,
  };
}

export const JOIN_REFUSALS = [
  "join_already_requested",
  "membership_exists",
  "consent_changed",
  "consent_required",
  "programme_closed",
  "programme_not_found",
] as const;
export type JoinRefusal = (typeof JOIN_REFUSALS)[number];

export type JoinAnswer =
  { ok: true; join: LoyaltyJoinRecord } | { ok: false; reason: JoinRefusal };

/**
 * §4.2: recorded, or refused, each with exact zero-write accounting naming
 * its reason; anything else is unavailable (undefined).
 */
export function parseJoinAnswer(
  httpStatus: number,
  body: unknown,
): JoinAnswer | undefined {
  if (!record(body)) return undefined;
  const accounting = parseAccounting(body.accounting);
  if (httpStatus === 200 && body.ok === true) {
    const join = parseJoinRecord(body.join);
    return body.status === "join_requested" &&
      join &&
      zeroWrite(accounting, "join_request_recorded")
      ? { ok: true, join }
      : undefined;
  }
  const reason = (JOIN_REFUSALS as readonly string[]).includes(
    String(body.status),
  )
    ? (body.status as JoinRefusal)
    : undefined;
  return body.ok === false &&
    reason &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    zeroWrite(accounting, reason)
    ? { ok: false, reason }
    : undefined;
}

// --------------------------------------------------------------- evidence

/** A fresh authenticated exact read of the canonical membership (§3). */
export interface CanonicalRead {
  objectId: string;
  templateId: string;
  orgId: string;
  owner: string;
  nonce: number;
  stateHash: string;
  contentHash: string;
  custom: Record<string, unknown>;
  readAt: string;
}

export function parseCanonicalRead(value: unknown): CanonicalRead | undefined {
  if (!record(value) || value.read !== "authenticated_exact") return;
  const nonce = positive(value.nonce);
  const readAt = iso(value.read_at);
  if (
    !isObjectId(value.object_id) ||
    !isObjectId(value.template_id) ||
    !isObjectId(value.org_id) ||
    typeof value.owner !== "string" ||
    !ADDRESS.test(value.owner) ||
    !nonce ||
    typeof value.state_hash !== "string" ||
    !FINGERPRINT.test(value.state_hash) ||
    typeof value.content_hash !== "string" ||
    !FINGERPRINT.test(value.content_hash) ||
    !record(value.custom) ||
    !readAt
  ) {
    return undefined;
  }
  return {
    objectId: value.object_id,
    templateId: value.template_id,
    orgId: value.org_id,
    owner: value.owner,
    nonce,
    stateHash: value.state_hash,
    contentHash: value.content_hash,
    custom: value.custom,
    readAt,
  };
}

export type ReceiptSemantic =
  "create_membership" | "submit_activity" | "verify_activity";

/** One Dual action, from the runtime's retained write (§3). */
export interface ActionReceipt {
  actionId: string;
  actionName: "mint" | "update";
  semantic: ReceiptSemantic;
  objectId: string;
  account: string;
  nextNonce: number;
  readbackContentHash: string;
  writtenCustom: Record<string, unknown>;
  writtenCustomHash: string;
}

export function parseActionReceipt(
  value: unknown,
  semantic: ReceiptSemantic,
): ActionReceipt | undefined {
  if (!record(value) || value.semantic !== semantic) return undefined;
  const nextNonce = positive(value.next_nonce);
  const actionName = semantic === "create_membership" ? "mint" : "update";
  if (
    typeof value.action_id !== "string" ||
    !ACTION_ID.test(value.action_id) ||
    value.action_name !== actionName ||
    !isObjectId(value.object_id) ||
    typeof value.account !== "string" ||
    !ADDRESS.test(value.account) ||
    !nextNonce ||
    typeof value.readback_content_hash !== "string" ||
    !FINGERPRINT.test(value.readback_content_hash) ||
    !record(value.written_custom) ||
    typeof value.written_custom_hash !== "string" ||
    !HASH.test(value.written_custom_hash)
  ) {
    return undefined;
  }
  return {
    actionId: value.action_id,
    actionName,
    semantic,
    objectId: value.object_id,
    account: value.account,
    nextNonce,
    readbackContentHash: value.readback_content_hash,
    writtenCustom: value.written_custom,
    writtenCustomHash: value.written_custom_hash,
  };
}

/** The canonical JSON a written map's hash is computed over (§3). */
export const writtenCustomPreimage = (receipt: ActionReceipt) =>
  canonicalJson(receipt.writtenCustom);

export interface ApprovalRecord {
  status: "pending" | "approved" | "declined";
  decidedAt: string | null;
}

export type MembershipAnswer =
  | { status: "none" }
  | {
      status: "pending_approval" | "declined" | "pending_creation";
      join: LoyaltyJoinRecord;
      approval: ApprovalRecord;
    }
  | { status: "pending_pass"; canonical: CanonicalRead; opening: ActionReceipt }
  | {
      status: "active" | "held" | "ended";
      canonical: CanonicalRead;
      opening: ActionReceipt;
      pass: { objectId: string; templateId: string };
    };

const APPROVAL_OF = {
  pending_approval: ["pending", "join_pending_approval"],
  declined: ["declined", "join_declined"],
  pending_creation: ["approved", "join_approved"],
} as const;

/** §4.3, with every programme record's exact zero-write accounting. */
export function parseMembershipAnswer(
  body: unknown,
): MembershipAnswer | undefined {
  if (!record(body) || body.ok !== true) return undefined;
  if (!zeroWrite(parseAccounting(body.accounting), "membership_read")) return;
  const status = body.status;
  if (status === "none") return { status };
  if (
    status === "pending_approval" ||
    status === "declined" ||
    status === "pending_creation"
  ) {
    const join = parseJoinRecord(body.join);
    const approval = record(body.approval) ? body.approval : undefined;
    const [expected, reason] = APPROVAL_OF[status];
    const decidedAt =
      approval?.decided_at === undefined ? null : iso(approval.decided_at);
    if (
      !join ||
      !approval ||
      approval.status !== expected ||
      decidedAt === undefined ||
      (expected !== "pending" && decidedAt === null) ||
      !zeroWrite(parseAccounting(approval.accounting), reason)
    ) {
      return undefined;
    }
    return {
      status,
      join,
      approval: { status: expected, decidedAt },
    };
  }
  const canonical = parseCanonicalRead(body.canonical);
  const opening = parseActionReceipt(body.opening, "create_membership");
  if (!canonical || !opening) return undefined;
  if (status === "pending_pass") return { status, canonical, opening };
  if (status !== "active" && status !== "held" && status !== "ended") return;
  const pass = record(body.pass) ? body.pass : undefined;
  if (!pass || !isObjectId(pass.object_id) || !isObjectId(pass.template_id)) {
    return undefined;
  }
  return {
    status,
    canonical,
    opening,
    pass: { objectId: pass.object_id, templateId: pass.template_id },
  };
}

export interface SubmissionRecord {
  evidenceHash: string;
  activityType: string;
  submittedAt: string;
}

function parseSubmission(value: unknown): SubmissionRecord | undefined {
  if (!record(value)) return undefined;
  const submittedAt = iso(value.submitted_at);
  if (
    typeof value.evidence_hash !== "string" ||
    !HASH.test(value.evidence_hash) ||
    typeof value.activity_type !== "string" ||
    !ACTIVITY_TYPE.test(value.activity_type) ||
    !submittedAt
  ) {
    return undefined;
  }
  return {
    evidenceHash: value.evidence_hash,
    activityType: value.activity_type,
    submittedAt,
  };
}

export const SUBMIT_REFUSALS = [
  "loyalty_activity_evidence_duplicate",
  "loyalty_activity_type_unknown",
  "membership_not_active",
] as const;
export type SubmitRefusal = (typeof SUBMIT_REFUSALS)[number];

export type SubmitAnswer =
  | {
      kind: "submitted";
      submission: SubmissionRecord;
      canonical: CanonicalRead;
      action: ActionReceipt;
    }
  /** A zero-write refusal: nothing was written, exactly for this reason. */
  | { kind: "refused"; reason: SubmitRefusal }
  /** Anything else, a lost or unreadable reply included. */
  | { kind: "unknown" };

/** §4.4. Never "not sent" unless the runtime says exactly that. */
export function parseSubmitAnswer(
  httpStatus: number,
  body: unknown,
): SubmitAnswer {
  if (!record(body)) return { kind: "unknown" };
  const accounting = parseAccounting(body.accounting);
  if (httpStatus === 200 && body.ok === true) {
    const submission = parseSubmission(body.submission);
    const canonical = parseCanonicalRead(body.canonical);
    const action = parseActionReceipt(body.action, "submit_activity");
    return body.status === "activity_submitted" &&
      submission &&
      canonical &&
      action &&
      accounting?.dualWrites === 1 &&
      accounting.reason === "activity_submitted"
      ? { kind: "submitted", submission, canonical, action }
      : { kind: "unknown" };
  }
  const reason = (SUBMIT_REFUSALS as readonly string[]).includes(
    String(body.status),
  )
    ? (body.status as SubmitRefusal)
    : undefined;
  return httpStatus === 409 &&
    body.ok === false &&
    reason &&
    zeroWrite(accounting, reason)
    ? { kind: "refused", reason }
    : { kind: "unknown" };
}

export type StatusAnswer =
  | {
      kind: "submitted";
      submission: SubmissionRecord;
      canonical: CanonicalRead;
      action: ActionReceipt;
    }
  | {
      kind: "verified";
      submission: SubmissionRecord;
      canonical: CanonicalRead;
      action: ActionReceipt;
      verification: ActionReceipt;
    }
  | { kind: "not_received" }
  | { kind: "unknown" };

/** §4.5 for the original operation. */
export function parseStatusAnswer(
  httpStatus: number,
  body: unknown,
): StatusAnswer {
  if (httpStatus !== 200 || !record(body) || body.ok !== true) {
    return { kind: "unknown" };
  }
  if (body.status === "not_received") {
    return zeroWrite(parseAccounting(body.accounting), "operation_not_received")
      ? { kind: "not_received" }
      : { kind: "unknown" };
  }
  const submission = parseSubmission(body.submission);
  const canonical = parseCanonicalRead(body.canonical);
  const action = parseActionReceipt(body.action, "submit_activity");
  if (!submission || !canonical || !action) return { kind: "unknown" };
  if (body.status === "submitted") {
    return { kind: "submitted", submission, canonical, action };
  }
  const verification = parseActionReceipt(body.verification, "verify_activity");
  return body.status === "verified" && verification
    ? { kind: "verified", submission, canonical, action, verification }
    : { kind: "unknown" };
}

// ------------------------------------------------------- provider facts

/** The provider's public object view (`GET /public/objects/{id}`). */
export interface PublicObjectFacts {
  id: string;
  templateId: string;
  owner: string;
  nonce: number;
  stateHash: string;
  contentHash: string;
  custom: Record<string, unknown>;
}

/** One public action-log entry (`GET /public/action-logs?id=…`). */
export interface PublicActionFacts {
  id: string;
  name: string;
  account: string;
  affected: Array<{ id: string; templateId: string; stateChangeId: string }>;
  to: string | null;
  templateId: string | null;
}

/** One public state change (`GET /public/objects/{id}/state-changes`). */
export interface PublicStateChangeFacts {
  id: string;
  actionId: string;
  actionName: string;
  objectId: string;
  nextNonce: number;
  nextContentHash: string;
  prevOwner: string;
  currentOwner: string;
}

/** The holder's own authenticated read of an object it owns (its pass). */
export interface OwnedObjectFacts {
  id: string;
  templateId: string;
  owner: string;
  orgId: string;
  custom: Record<string, unknown>;
}

export interface ProofContext {
  rules: LoyaltyRules;
  /** The host's client (organisation) id. */
  clientId: string;
  /** sha256 of the session's Dual wallet id: Studio's memberReference. */
  expectedMember: string;
  holder: string;
}

export type ProofFailure =
  | "canonical_mismatch"
  | "public_object_mismatch"
  | "receipt_mismatch"
  | "signer_mismatch"
  | "history_mismatch"
  | "pass_mismatch"
  | "submission_mismatch"
  | "verification_mismatch";

const lower = (value: string) => value.toLowerCase();
const sameJson = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);

/** §5, canonical read C against the bound programme, member and provider. */
export function checkCanonical(
  canonical: CanonicalRead,
  publicObject: PublicObjectFacts | undefined,
  context: ProofContext,
): ProofFailure | null {
  const { rules } = context;
  const custom = canonical.custom;
  if (
    canonical.orgId !== context.clientId.toLowerCase() ||
    canonical.templateId !== rules.canonicalTemplateId ||
    lower(canonical.owner) !== rules.canonicalIssuerAccount ||
    custom.programmeId !== rules.programmeId ||
    custom.memberReference !== context.expectedMember ||
    custom.generic_semantic_purpose !== LOYALTY_PURPOSE ||
    // The application record reference: Studio's own id, never the
    // provider's object id (that does not exist before the mint).
    typeof custom.recordId !== "string" ||
    !custom.recordId ||
    custom.recordId.length > 140 ||
    custom.recordId === canonical.objectId ||
    !(LOYALTY_STATES as readonly unknown[]).includes(custom.state)
  ) {
    return "canonical_mismatch";
  }
  if (
    !publicObject ||
    publicObject.id !== canonical.objectId ||
    publicObject.templateId !== canonical.templateId ||
    lower(publicObject.owner) !== rules.canonicalIssuerAccount ||
    publicObject.nonce !== canonical.nonce ||
    publicObject.stateHash !== canonical.stateHash ||
    publicObject.contentHash !== canonical.contentHash ||
    Object.entries(publicObject.custom).some(
      ([key, value]) =>
        !Object.hasOwn(custom, key) || !sameJson(custom[key], value),
    )
  ) {
    return "public_object_mismatch";
  }
  return null;
}

const STATE_OF: Record<ReceiptSemantic, string> = {
  create_membership: "Member",
  submit_activity: "Activity pending",
  verify_activity: "Activity verified",
};

/**
 * §5 (1)-(4): one action receipt on C, its retained full map (hash checked
 * by the caller as `writtenHashMatches`), its signer from the public action
 * log and its place in the public state history.
 */
export function checkReceipt(
  receipt: ActionReceipt,
  canonical: CanonicalRead,
  context: ProofContext,
  provider: {
    writtenHashMatches: boolean;
    action: PublicActionFacts | undefined;
    change: PublicStateChangeFacts | undefined;
  },
  evidenceHash?: string,
): ProofFailure | null {
  const { rules } = context;
  const written = receipt.writtenCustom;
  const lifecycle = record(written.lifecycle) ? written.lifecycle : {};
  const proofEvent = record(written.proof_event) ? written.proof_event : {};
  const publicFields = Array.isArray(proofEvent.public_fields)
    ? proofEvent.public_fields
    : [];
  if (
    !provider.writtenHashMatches ||
    receipt.objectId !== canonical.objectId ||
    lower(receipt.account) !== rules.canonicalIssuerAccount ||
    receipt.nextNonce > canonical.nonce ||
    written.generic_semantic_purpose !== LOYALTY_PURPOSE ||
    // Like with like: the receipt's record reference against the fresh
    // canonical record reference; its object id is checked above.
    written.recordId !== canonical.custom.recordId ||
    written.programmeId !== rules.programmeId ||
    written.memberReference !== context.expectedMember ||
    written.state !== STATE_OF[receipt.semantic] ||
    (receipt.semantic !== "create_membership" &&
      (typeof lifecycle.action_id !== "string" ||
        !lifecycle.action_id.startsWith(
          `${LOYALTY_PURPOSE}_${receipt.semantic}_`,
        ))) ||
    (receipt.semantic === "submit_activity" &&
      (!evidenceHash ||
        !publicFields.includes(`activityEvidenceHash:${evidenceHash}`)))
  ) {
    return "receipt_mismatch";
  }
  const action = provider.action;
  const affected = action?.affected.find(
    (item) => item.id === canonical.objectId,
  );
  if (
    !action ||
    action.id !== receipt.actionId ||
    action.name !== receipt.actionName ||
    lower(action.account) !== rules.canonicalIssuerAccount ||
    !affected
  ) {
    return "signer_mismatch";
  }
  const change = provider.change;
  if (
    !change ||
    change.id !== affected.stateChangeId ||
    change.actionId !== receipt.actionId ||
    change.objectId !== canonical.objectId ||
    change.nextNonce !== receipt.nextNonce ||
    change.nextContentHash !== receipt.readbackContentHash ||
    lower(change.currentOwner) !== rules.canonicalIssuerAccount ||
    (receipt.actionName === "update" &&
      lower(change.prevOwner) !== rules.canonicalIssuerAccount)
  ) {
    return "history_mismatch";
  }
  return null;
}

/**
 * §5 Active: the holder's own pass for exactly this canonical opening, and
 * the pass's own mint by the issuer to this holder from the pass template.
 */
export function checkPass(
  pass: OwnedObjectFacts | undefined,
  expected: { objectId: string; templateId: string },
  canonical: CanonicalRead,
  opening: ActionReceipt,
  context: ProofContext,
  passMint: PublicActionFacts | undefined,
): ProofFailure | null {
  const { rules } = context;
  const custom = pass?.custom ?? {};
  if (
    !pass ||
    pass.id !== expected.objectId ||
    expected.templateId !== rules.passTemplateId ||
    pass.templateId !== rules.passTemplateId ||
    lower(pass.owner) !== lower(context.holder) ||
    custom.schema !== PASS_SCHEMA ||
    custom.product_type !== PASS_PRODUCT_TYPE ||
    custom.canonical_object_id !== canonical.objectId ||
    custom.canonical_template_id !== rules.canonicalTemplateId ||
    typeof custom.canonical_issuer_account !== "string" ||
    lower(custom.canonical_issuer_account) !== rules.canonicalIssuerAccount ||
    custom.organization_id !== context.clientId.toLowerCase() ||
    custom.opening_action_id !== opening.actionId ||
    custom.openingState !== "Member"
  ) {
    return "pass_mismatch";
  }
  if (
    !passMint ||
    passMint.name !== "mint" ||
    lower(passMint.account) !== rules.canonicalIssuerAccount ||
    passMint.to === null ||
    lower(passMint.to) !== lower(context.holder) ||
    passMint.templateId !== rules.passTemplateId ||
    !passMint.affected.some((item) => item.id === pass.id)
  ) {
    return "pass_mismatch";
  }
  return null;
}

/**
 * §5 Counted: the verification is the very next change to the canonical
 * object after exactly this submission (no other action in between).
 */
export function verificationFollows(
  submission: ActionReceipt,
  verification: ActionReceipt,
) {
  return (
    verification.objectId === submission.objectId &&
    verification.actionId !== submission.actionId &&
    verification.nextNonce === submission.nextNonce + 1
  );
}

/** Held or ended from the canonical state, else the given status. */
export function lifecycleStatus(canonical: CanonicalRead) {
  if (canonical.custom.state === HELD_STATE) return "held" as const;
  if (canonical.custom.state === ENDED_STATE) return "ended" as const;
  return "active" as const;
}

// ------------------------------------------------------------- views

/** What the native page may show about the membership. */
export type LoyaltyMembershipView =
  | { status: "none" }
  | {
      status: "pending_approval" | "declined" | "pending_creation";
      join: LoyaltyJoinRecord;
    }
  | { status: "pending_pass" }
  | {
      status: "active" | "held" | "ended";
      membership: { objectId: string; state: string; recordedAt: string };
    }
  /** Evidence present but not proven: never shown as membership. */
  | { status: "unconfirmed" };

export type LoyaltySubmissionStatus =
  /** Proven written now; verification not (yet) proven. */
  | "submitted"
  /** Proven verified, as the very next change after this submission. */
  | "counted"
  /** Sent; its outcome is not proven. Read back only, never resent. */
  | "unknown"
  /** The runtime never accepted it and, its assertion expired, never can. */
  | "not_received"
  /** The runtime answered but the evidence did not prove it. */
  | "unconfirmed";

export interface LoyaltySubmissionView {
  operationId: string;
  activityType: string;
  status: LoyaltySubmissionStatus;
}

export function isLoyaltySubmissionView(
  value: unknown,
): value is LoyaltySubmissionView {
  return (
    record(value) &&
    isOperationId(value.operationId) &&
    typeof value.activityType === "string" &&
    ACTIVITY_TYPE.test(value.activityType) &&
    ["submitted", "counted", "unknown", "not_received", "unconfirmed"].includes(
      String(value.status),
    )
  );
}

/** Evidence text the member may submit: plain, trimmed, bounded. */
export function validEvidenceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= EVIDENCE_MAX &&
    value === value.trim() &&
    // No control characters (the runtime hashes exactly these bytes).
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
