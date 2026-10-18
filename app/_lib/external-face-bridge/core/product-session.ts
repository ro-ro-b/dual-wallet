import type {
  CaseQuote,
  ProductAttribute,
  ProductFaceApplication,
  ProductFaceConfirmation,
  ProductHistoryEntry,
  ProgrammeProduct,
  ProgrammeUnitFacts,
  RegistrationStatus,
  RuntimeOperation,
  SessionEndReason,
  SettleFieldChange,
  SettleProposal,
  SettleProposalUnavailableReason,
} from "@/app/_domain/product-face";
import type { TransferProposal } from "@/app/_domain/product-face-transfer";
import { ProductFaceError } from "@/app/_domain/product-face";
import type { RuntimeAssertionTarget } from "@/app/_lib/external-face-bridge/core/product-context";
import { ExternalFaceBridgeError } from "@/app/_lib/external-face-bridge/core/errors";
import type { ExecutorIdentity } from "@/app/_lib/external-face-bridge/core/executor-identity";

export interface ProductFaceSelection {
  contextId: string;
  objectId: string;
  product: ProgrammeProduct;
}

export interface JournalTransitionRequest {
  transition: "begin" | "confirm" | "cancel" | "submit" | "record_action";
  operation_id: string;
  kind?: "registration" | "runtime" | "settle" | "transfer";
  operation?: string;
  object_id?: string;
  case_id?: string;
  context_id?: string;
  action_id?: string;
  proposal_id?: string;
  offer_id?: string;
  record_id?: string;
  request_hash?: string;
}

export interface JournalTransitionResponse {
  unit?: ProgrammeUnitFacts;
  quote?: CaseQuote;
  /** "won" only when the BFF itself won the runtime settle dispatch claim. */
  reservation?: "won";
}

/** Notices the host shows in its own UI, never face-supplied text. */
export type ProductFaceHostNotice =
  | {
      kind: "settle_proposal_unavailable";
      reason: SettleProposalUnavailableReason;
    }
  | {
      /** A transfer step this wallet already sent, read back by the host. */
      kind: "transfer_step";
      reason: "transferred" | "outcome_unknown";
    }
  | {
      /**
       * Nothing was sent for the face's request. `journal_full`: this
       * launch's journal has no room left for another step, and only a new
       * launch (a fresh journal) can continue. `launch_capacity`: this
       * browser keeps as many launches holding unresolved requests as it
       * may, so this launch runs read-only (it opens and reads, nothing of it
       * is kept, and a new launch would be the same) until an earlier
       * launch's request resolves or its record expires.
       */
      kind: "launch_full";
      reason: "journal_full" | "launch_capacity";
    }
  | {
      /**
       * Proposed contract r20 (PROPOSED, not deployed): outcomes of this
       * wallet's earlier operations, listed durably by the runtime and
       * resolved read-only by the host. Host-owned data only, never face
       * text; the acknowledgement tickets stay in the host hook, never here.
       * `complete: false` means not every runtime scan ran to its end, so
       * nothing is acknowledged from this listing.
       */
      kind: "recovery";
      /** Every scoped runtime scan ran to its end and every page was read. */
      complete: boolean;
      /** Items remain beyond the pages followed so far: continue checking. */
      moreToCheck: boolean;
      /** Items of a journey this host disables: neither shown nor acknowledged. */
      withheld: number;
      /** Per runtime asked: its records checked, or why not (host-owned words). */
      checks: Array<{
        runtime: "product" | "service";
        status: "checked" | "incomplete" | "unavailable" | "unsupported";
        reason: string | null;
        unreadable: number;
      }>;
      /** Items the BFF could read only by identity: shown as not checked. */
      unreadable: number;
      items: Array<{
        operationId: string;
        kind: "registration" | "settle" | "transfer" | "runtime";
        operation: string;
        step: "request" | "transfer" | null;
        outcome:
          | "registered"
          | "transfer_request_committed"
          | "transferred"
          | "write_applied"
          | "write_refused"
          | "outcome_unknown"
          | "not_checked";
        /**
         * Who holds the unit of a proved transfer outcome now (the BFF's
         * fresh read); null keeps the outcome's own line.
         */
        holding: "registered" | "held" | "elsewhere" | null;
        /** The host may acknowledge it once the person dismissed the notice. */
        acknowledgeable: boolean;
      }>;
    };

export interface OperationStatusResponse {
  status: RegistrationStatus;
  objectId: string;
  readback: { ownerIsYou: boolean; state: string | null } | null;
}

export interface AssertionRequest {
  operation: RuntimeOperation;
  operation_id: string;
  target: RuntimeAssertionTarget;
  request_hash?: string;
  context_id?: string;
}

/**
 * Wallet services the application variant may call. Every one is a narrow,
 * named operation; there is no generic fetch, proxy, token or execute hook.
 */
export interface ProductFaceHandlers {
  listProducts(input: {
    templateId: string;
    next?: string;
  }): Promise<{ products: ProgrammeProduct[]; next?: string }>;
  selectProduct(
    objectId: string,
  ): Promise<{ contextId: string; product: ProgrammeProduct }>;
  readProduct(objectId: string): Promise<ProgrammeProduct>;
  readActions(objectId: string): Promise<string[]>;
  readAttributes(objectId: string): Promise<ProductAttribute[]>;
  readHistory(objectId: string): Promise<ProductHistoryEntry[]>;
  readUnit(objectId: string): Promise<ProgrammeUnitFacts>;
  journal(
    request: JournalTransitionRequest,
  ): Promise<JournalTransitionResponse>;
  operationStatus(operationId: string): Promise<OperationStatusResponse>;
  mintAssertion(request: AssertionRequest): Promise<string>;
  readSettleProposal(input: {
    contextId: string;
    operationId: string;
    objectId: string;
  }): Promise<{ proposal: SettleProposal; changes: SettleFieldChange[] }>;
  /**
   * The wallet session that may sign right now (null when signed out), so a
   * holder-signed operation can capture who began it.
   */
  executorIdentity(): ExecutorIdentity | null;
  /**
   * Executes as the holder. `as` is the identity captured when the operation
   * began: the executor refuses (session_ended) before any signature unless
   * the live session is still exactly that identity.
   */
  executeSettle(
    input: {
      /** The settle's journal operation (settle_operation_id). */
      operationId: string;
      objectId: string;
      action: string;
      alias?: string;
      input: Record<string, unknown>;
    },
    as: ExecutorIdentity,
  ): Promise<{ actionId: string }>;
  /** G8: the next transfer step, read by the wallet itself (trusted read). */
  readTransferProposal(input: {
    contextId: string;
    offerId: string;
    objectId: string;
  }): Promise<TransferProposal>;
  /**
   * r19: the unit this launch's acceptance is for, read by the wallet
   * itself (the runtime's transfer.acceptance.read server to server with the
   * acceptance ticket the BFF kept, then Dual's public projection in this
   * programme). The face supplies nothing for it.
   */
  readAcceptOffer(): Promise<ProgrammeUnitFacts>;
  /** G8: executes exactly a validated transfer step as the holder (`as`: see executeSettle). */
  executeTransfer(
    input: {
      /** The step's journal operation (step_operation_id). */
      operationId: string;
      objectId: string;
      action: "update" | "transfer";
      input: Record<string, unknown>;
    },
    as: ExecutorIdentity,
  ): Promise<{ actionId: string }>;
  /** G8: verify or read the status of a submitted step; never executes. */
  transferProgress(
    operationId: string,
    /** A step of this offer already sent from this wallet is read instead. */
    offerId?: string,
  ): Promise<{
    status: "transfer_request_committed" | "transferred" | "outcome_unknown";
    step: "request" | "transfer";
  }>;
  confirm(request: ProductFaceConfirmation): Promise<boolean>;
  /** Shows a host notice (for example why no settle proposal exists). */
  notice?(notice: ProductFaceHostNotice): void;
  navigate(path: string, mode: "push" | "replace"): void;
  sha256(value: string): Promise<string>;
}

/** Host-side state of one product-face channel. */
export class ProductFaceSession {
  selection: ProductFaceSelection | null = null;
  /** Increments on every selection change; late results compare it. */
  generation = 0;
  pendingConfirmation = false;
  ended: SessionEndReason | null = null;
  task: string;
  /** Operations whose assertion this live host instance issued. */
  readonly issuedOperations = new Set<string>();
  readonly cursors = new Map<
    string,
    { templateIndex: number; next?: string }
  >();

  constructor(
    readonly application: ProductFaceApplication,
    readonly holder: string,
    task: string,
  ) {
    this.task = task;
  }

  /** Throws unless the session is live; used after every await. */
  assertLive() {
    if (this.ended) {
      throw new ExternalFaceBridgeError(
        "session_ended",
        "The wallet session for this face has ended.",
      );
    }
  }

  ownsProduct(product: ProgrammeProduct) {
    return (
      product.owner.toLowerCase() === this.holder.toLowerCase() &&
      this.application.templateIds.includes(product.templateId)
    );
  }
}

const faceErrorMessages: Record<string, string> = {
  not_owned: "The product is not held by this wallet.",
  not_in_programme: "The product is not part of this programme.",
  not_found: "The product could not be found.",
  stale_context: "The product context has changed.",
  no_selection: "No product is selected.",
  user_cancelled: "The request was cancelled in the wallet.",
  operation_already_submitted: "This operation was already submitted.",
  already_registered_to_you: "This product is already registered to you.",
  ownership_moved_state_pending:
    "Ownership has moved to you but registration is not yet confirmed.",
  action_in_progress: "Another request is awaiting confirmation.",
  assertion_unprovisioned: "The wallet cannot authorise this application yet.",
  assertion_limit:
    "Too many authorisations are outstanding. Try again shortly.",
  settle_not_required: "This product does not need to be settled.",
  proposal_rejected: "The proposed change was refused by the wallet.",
  settle_proposal_unavailable:
    "The brand has no confirmation for this product right now.",
  outcome_unknown: "The outcome is not yet known.",
  transfer_not_accepted: "The recipient has not accepted the transfer yet.",
  transfer_cancelled:
    "The transfer was cancelled or has expired; nothing was signed.",
  capability_not_granted:
    "This programme has not enabled this operation in the wallet.",
  quote_changed: "The quote has changed.",
  unknown_operation: "The wallet has no record of this operation.",
  invalid_request: "The request is invalid.",
  record_mismatch: "The record does not match this product.",
  session_ended: "The wallet session for this face has ended.",
  artifact_mismatch: "The application could not be verified.",
};

/** Maps a wallet service failure to a contract error code for the face. */
export function toBridgeError(error: unknown) {
  if (error instanceof ExternalFaceBridgeError) return error;
  if (error instanceof ProductFaceError) {
    const code =
      error.code === "face_assertion_unprovisioned"
        ? "assertion_unprovisioned"
        : error.code;
    const message = faceErrorMessages[code];
    if (message) return new ExternalFaceBridgeError(code, message);
    // Nothing was sent, and retrying in this launch cannot change that: a
    // full journal needs a new launch, a read-only launch an earlier
    // launch's evidence to resolve. Not retryable.
    if (code === "journal_full" || code === "launch_capacity") {
      return new ExternalFaceBridgeError(
        "temporarily_unavailable",
        "The wallet could not complete this request.",
        false,
      );
    }
    if (error.status === 401) {
      return new ExternalFaceBridgeError(
        "session_ended",
        faceErrorMessages.session_ended,
      );
    }
  }
  return new ExternalFaceBridgeError(
    "temporarily_unavailable",
    "The wallet could not complete this request.",
    true,
  );
}

export function faceError(code: keyof typeof faceErrorMessages) {
  return new ExternalFaceBridgeError(code, faceErrorMessages[code]);
}
