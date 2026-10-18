/**
 * @jest-environment node
 */
// Two complete branded apps on ONE engine: Morrow Home (the reference brand)
// and Tidewell (the second brand), each with every journey. The two
// deployments differ only by environment: WALLET_HOST_CONFIGURATION and its
// pin (with the build's record of it and of its registry),
// NEXT_PUBLIC_APP_URL, PRODUCT_FACE_APPLICATIONS, and each host's own
// SESSION_SECRET, FACE_ASSERTION_SIGNING_KEY and FACE_ASSERTION_KEY_ID.
//
// What is real: every wallet BFF route handler the journeys use (session,
// host readback, context, handover, selection, operations and status,
// assertions, settle-proposal, transfer-proposal, transfer-progress,
// accept-offer, and the /api/backend proxy with its face execution binding)
// and the request proxy, each under the brand's own host configuration.
//
// What is fake, and labelled so (LOCAL FAKES ONLY: fictional ids, origins,
// accounts and keys; nothing leaves the test):
// - FakeDual: Dual's object reads and ebus prepare/execute, per account.
// - BrandRuntime: each brand's own Passport runtime and its own linked
//   Warranty runtime. Each checks every assertion as the Studio runtimes do,
//   against ITS host's public key and key id, issuer, audience, face,
//   programme, holder, operation, target, request hash, expiry and one-time
//   jti, so an assertion of the other brand's host is refused.
// - The face: the bridge requests and runtime bodies it makes (journal
//   transitions, assertion requests and its own runtime calls).
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ResponseError } from "@/api/web-sdk/runtime";
import { faceJournalCookieName } from "@/api/face-journal";
import type { LoginOut } from "@/api/web-sdk/models/LoginOut";
import { canonicalJson } from "@/app/_domain/product-face";
import {
  ARTIFACT_HEX,
  edit,
  TEMPLATE_A,
  TEMPLATE_B,
} from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  LINKED_WARRANTY,
  MORROW_ORGANIZATION,
  MORROW_ORIGIN,
  morrowBinding,
  morrowDocument,
  registryWithBothFullFaces,
  TIDEWELL_ORGANIZATION,
  TIDEWELL_ORIGIN,
  TIDEWELL_WARRANTY,
  tidewellFullBinding,
  tidewellFullDocument,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

const getWallet = jest.fn();
const getObjectById = jest.fn();
const getObjectByIdPublic = jest.fn();
jest.mock("@/api/web-sdk-client", () => ({
  ...jest.requireActual("@/api/web-sdk-client"),
  // LOCAL FAKE Dual reads, answered per access token (one per account).
  getWalletsApi: (token?: string) => ({
    getWallet: () => getWallet(token),
    logout: jest.fn(),
  }),
  getObjectsApi: (token?: string) => ({
    getObjectById: (request: { objectId: string }) =>
      getObjectById(token, request.objectId),
    getObjectByIdPublic: (request: { objectId: string }) =>
      getObjectByIdPublic(request.objectId),
  }),
}));
// The pinned artifact itself is verified in api/face-artifact.test.ts.
jest.mock("@/api/face-artifact", () => ({
  ...jest.requireActual("@/api/face-artifact"),
  verifyFaceArtifact: async () => ({ ok: true }),
}));
// Pass-through: records every assertion either host mints.
const minted = jest.fn();
jest.mock("@/api/face-assertion", () => {
  const actual = jest.requireActual("@/api/face-assertion");
  return {
    ...actual,
    mintFaceAssertion: (...args: unknown[]) => {
      minted(...args);
      return actual.mintFaceAssertion(...args);
    },
  };
});

import { FACE_ACCEPTANCE_COOKIE } from "@/api/face-acceptance";
import { resetIssueGuard } from "@/api/product-face-operations";
import { productFaceEntries } from "@/api/product-face-registry";
import { establishSession } from "@/api/server-session";
import { resetWalletHostCache } from "@/api/wallet-host";
import { POST as backendPOST } from "@/app/api/backend/[...path]/route";
import { POST as acceptOfferPOST } from "@/app/api/faces/[slug]/accept-offer/route";
import { POST as assertionsPOST } from "@/app/api/faces/[slug]/assertions/route";
import { GET as contextGET } from "@/app/api/faces/[slug]/context/route";
import { POST as handoverPOST } from "@/app/api/faces/[slug]/handover/route";
import { GET as recoveryGET } from "@/app/api/faces/[slug]/recovery/route";
import { POST as recoveryAckPOST } from "@/app/api/faces/[slug]/recovery/ack/route";
import { POST as recoveryDiscoveredPOST } from "@/app/api/faces/[slug]/recovery/discovered/route";
import { GET as statusGET } from "@/app/api/faces/[slug]/operations/[operationId]/route";
import {
  GET as operationsGET,
  POST as operationsPOST,
} from "@/app/api/faces/[slug]/operations/route";
import { POST as selectionPOST } from "@/app/api/faces/[slug]/selection/route";
import { POST as settleProposalPOST } from "@/app/api/faces/[slug]/settle-proposal/route";
import { POST as transferProgressPOST } from "@/app/api/faces/[slug]/transfer-progress/route";
import { POST as transferProposalPOST } from "@/app/api/faces/[slug]/transfer-proposal/route";
import { GET as readbackGET } from "@/app/api/host/configuration/route";
import { GET as sessionGET } from "@/app/api/session/route";
import { proxy } from "@/proxy";

// ------------------------------------------------------------- the brands

type Json = Record<string, unknown>;
type RuntimeKind = "passport" | "warranty";
/** The r20 recovery item kinds (contract §2). */
type RecoveryKind = "registration" | "settle" | "transfer" | "runtime";

interface Party {
  walletId: string;
  address: string;
}

interface Address {
  origin: string;
  host: string;
}

interface Brand extends Address {
  label: string;
  /** Short, for operation ids. */
  tag: string;
  brandId: string;
  document: () => HostDocument;
  organizationId: string;
  slug: string;
  applicationId: string;
  programmeId: string;
  faceOrigin: string;
  warranty: { applicationId: string; origin: string };
  templateId: string;
  issuer: string;
  holder: Party;
  recipient: Party;
  unit: { id: string; recordId: string; name: string };
  cases: [string, string];
  // This host's own secrets: never another host's, never Studio's.
  sessionSecret: string;
  kid: string;
  keys: { publicKey: KeyObject; privateKey: KeyObject };
}

const hostSecrets = (kid: string) => ({
  kid,
  sessionSecret: randomBytes(32).toString("base64"),
  keys: generateKeyPairSync("ed25519"),
});

const MORROW: Brand = {
  label: "Morrow Home",
  tag: "mh",
  brandId: "morrow-home",
  document: morrowDocument,
  origin: MORROW_ORIGIN,
  host: new URL(MORROW_ORIGIN).host,
  organizationId: MORROW_ORGANIZATION,
  slug: "morrow-home",
  applicationId: "tig.passport.morrow-home",
  programmeId: "morrow-home-arc",
  faceOrigin: "https://faces.example",
  warranty: LINKED_WARRANTY,
  templateId: TEMPLATE_A,
  issuer: "0x00000000000000000000000000000000000155a1",
  holder: {
    walletId: "wallet-morrow-holder",
    address: "0x000000000000000000000000000000000000a101",
  },
  recipient: {
    walletId: "wallet-morrow-recipient",
    address: "0x000000000000000000000000000000000000a102",
  },
  unit: {
    id: "aaaaaaaaaaaaaaaaaaaaaa01",
    recordId: "rec-morrow-0001",
    name: "Arc grinder",
  },
  cases: ["case-morrow-0001", "case-morrow-0002"],
  ...hostSecrets("wallet-face-morrow-1"),
};

const TIDEWELL: Brand = {
  label: "Tidewell",
  tag: "tw",
  brandId: "tidewell",
  document: tidewellFullDocument,
  origin: TIDEWELL_ORIGIN,
  host: new URL(TIDEWELL_ORIGIN).host,
  organizationId: TIDEWELL_ORGANIZATION,
  slug: "tidewell-care",
  applicationId: "tig.passport.tidewell",
  programmeId: "tidewell-kettle",
  faceOrigin: "https://faces.tidewell.example",
  warranty: TIDEWELL_WARRANTY,
  templateId: TEMPLATE_B,
  issuer: "0x00000000000000000000000000000000000155b2",
  holder: {
    walletId: "wallet-tidewell-holder",
    address: "0x000000000000000000000000000000000000B2C1",
  },
  recipient: {
    walletId: "wallet-tidewell-recipient",
    address: "0x000000000000000000000000000000000000b202",
  },
  unit: {
    id: "bbbbbbbbbbbbbbbbbbbbbb02",
    recordId: "rec-tidewell-0001",
    name: "Pour-over kettle",
  },
  cases: ["case-tidewell-0001", "case-tidewell-0002"],
  ...hostSecrets("wallet-face-tidewell-1"),
};

const BRANDS = [MORROW, TIDEWELL];

// FIXTURE (r20.1): the service account that signs a synthetic Dual-backed
// action. It is not any brand's holder, recipient or issuer: the contract
// assumes neither that the signer is the holder nor that the object is the
// product target.
const SERVICE_ACCOUNT = `0x${"f".repeat(40)}`;
// FIXTURE (r20.1): the controller declared for the product update of a
// Dual-backed case.open; its mint is signed directly (controller null).
const FIXTURE_CONTROLLER = `0x${"c2".repeat(20)}`;

/** FIXTURE (r20.1): one intended Dual effect of a Dual-backed write. */
interface IntendedEffect {
  kind: "mint" | "update";
  /** The fixture object (minted) or the product object (updated). */
  objectId: "fixture" | "product";
  /** The declared controller address, or null: the account signs directly. */
  controller: string | null;
}

/**
 * FIXTURE knobs (r20.1), each off by default: one named way a runtime's
 * write.status answer falls short of the receipt chain, which the wallet must
 * hold. `dualFailedEffect` alone changes the write itself: FakeDual records
 * the second action as failed, so the runtime's own corroboration fails and
 * it answers 409 write_outcome_unknown (effects_unproved), never write_applied.
 */
interface DualKnobs {
  dualShortEffects?: boolean;
  dualStaleRead?: boolean;
  dualVerifiedAfterRead?: boolean;
  dualControllerUnrecorded?: boolean;
  dualControllerMismatch?: boolean;
  dualHistoryOtherObject?: boolean;
  dualExecutionPending?: boolean;
  dualWithdrawnField?: boolean;
  dualSha256Hash?: boolean;
  dualFailedEffect?: boolean;
}

/**
 * FIXTURE (r20.1): the normal linked Warranty case.open intends TWO Dual
 * effects: the mint of the fixture object, signed directly, then the update
 * of the product object through the declared controller.
 */
const CASE_OPEN_EFFECTS: IntendedEffect[] = [
  { kind: "mint", objectId: "fixture", controller: null },
  { kind: "update", objectId: "product", controller: FIXTURE_CONTROLLER },
];

// ---------------------------------------------------------------- helpers

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sha = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** The runtime request hash: the canonical body without its assertion. */
/** Dual and the runtimes compare 0x addresses case-insensitively (EIP-55 is a display form). */
const sameAddress = (left: unknown, right: unknown) =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.toLowerCase() === right.toLowerCase();
const hashOf = (
  operation: string,
  operationId: string,
  target: Json,
  input: Json,
) => sha(canonicalJson({ operation, operationId, target, input }));
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Json;
const headerOf = (assertion: string) => decode(assertion.split(".")[0]);
const claimsOf = (assertion: string) => decode(assertion.split(".")[1]);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function jwt(claims: Json) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** The test's clock: assertions live sixty seconds, journeys take longer. */
let clock = Date.now();
const advance = () => {
  clock += 61_000;
};

// --------------------------------------------------------------- fake Dual

interface Unit {
  id: string;
  templateId: string;
  owner: string;
  custom: Json;
  name: string;
}

function walletDto(party: Party) {
  return {
    id: party.walletId,
    language: "en",
    fqdn: "wallet",
    activated: true,
    emailVerified: true,
    disabled: false,
    account: {
      address: party.address,
      type: "SMART_WALLET",
      controller: {
        address: `0x${"c".repeat(40)}`,
        type: "SECP256K1",
        custody: "custodial",
      },
      smartAccount: {},
    },
    whenCreated: new Date("2026-01-01T00:00:00Z"),
    whenModified: new Date("2026-01-01T00:00:00Z"),
  };
}

/**
 * LOCAL FAKE of the Dual API: both brands' units and accounts, the object
 * reads, and POST ebus/prepare + ebus/execute as the wallet's proxy forwards
 * them (an update replaces the custom map; a transfer moves custody), each
 * only for the unit's own holder.
 */
class FakeDual {
  readonly units = new Map<string, Unit>();
  readonly executed: Array<{
    actionId: string;
    account: string;
    objectId: string;
    name: "mint" | "update" | "transfer";
    to?: string;
    /**
     * FIXTURE ONLY (r20.1), on a synthetic Dual-backed action: the controller
     * it was signed through (null: the account signed directly), the objects
     * it affected and Dual's own status word for it.
     */
    controller?: string | null;
    affectedObjects?: string[];
    status?: "COMPLETED" | "FAILED";
  }> = [];
  /**
   * FIXTURE ONLY (r20.1): state-change history entries per object, one per
   * succeeded synthetic Dual-backed action, each belonging to the object it
   * changed. `contentHashRaw` is a FIXTURE value in provider form (`0x` +
   * 64 lower-case hex): it stands in for the provider's raw content hash and
   * claims nothing about how the provider derives it.
   */
  readonly history = new Map<
    string,
    Array<{ entryId: string; actionId: string; contentHashRaw: string }>
  >();
  readonly ebus: Array<{ path: string; account: string }> = [];
  private readonly parties = new Map<string, Party>();
  private readonly nonces = new Map<string, number>();

  constructor(brands: Brand[]) {
    for (const brand of brands) {
      this.units.set(brand.unit.id, {
        id: brand.unit.id,
        templateId: brand.templateId,
        owner: brand.issuer,
        custom: { recordId: brand.unit.recordId, state: "Issued" },
        name: brand.unit.name,
      });
      for (const party of [brand.holder, brand.recipient]) {
        this.parties.set(party.walletId, party);
      }
    }
  }

  private partyOf(token: string | undefined) {
    const sub = token ? decode(token.split(".")[1] ?? "").sub : undefined;
    return typeof sub === "string" ? this.parties.get(sub) : undefined;
  }

  wallet(token: string | undefined) {
    const party = this.partyOf(token);
    if (!party) throw new ResponseError(new Response(null, { status: 401 }));
    return walletDto(party);
  }

  /**
   * FIXTURE ONLY (r20.1): one synthetic Dual action log entry and, when it
   * succeeded, ONE state-change history entry of the object it changed, so a
   * runtime write can be recorded as a genuine Dual-backed effect. The
   * contract assumes nothing: the signer need not be the holder and the
   * object need not be the product target. Never part of Dual's business
   * semantics; only the r20.1 Dual-backed write fixture records one.
   */
  recordDualBackedAction(
    objectId: string,
    signer: string,
    controller: string | null,
    kind: "mint" | "update",
    payload: Json,
    status: "COMPLETED" | "FAILED" = "COMPLETED",
  ) {
    const actionId = `dual-action-${this.executed.length + 1}`;
    this.executed.push({
      actionId,
      account: signer,
      controller,
      objectId,
      name: kind,
      affectedObjects: [objectId],
      status,
    });
    // FIXTURE: the provider's raw content hash of this change, in provider
    // form; derived deterministically here, never a claim about the provider.
    const contentHashRaw = `0x${sha256Hex(canonicalJson(payload))}`;
    if (status === "COMPLETED") {
      const entries = this.history.get(objectId) ?? [];
      entries.push({
        entryId: `hist-${objectId.slice(0, 8)}-${entries.length + 1}`,
        actionId,
        contentHashRaw,
      });
      this.history.set(objectId, entries);
    }
    return { actionId, contentHashRaw };
  }

  object(objectId: string) {
    const unit = this.units.get(objectId);
    if (!unit) throw new ResponseError(new Response(null, { status: 404 }));
    return {
      id: unit.id,
      templateId: unit.templateId,
      owner: unit.owner,
      custom: clone(unit.custom),
      metadata: { name: unit.name },
      whenModified: new Date("2026-10-01T00:00:00Z"),
    };
  }

  /** Registered: held by `holder`, in a settled state with its lifecycle agreeing. */
  settled(objectId: string, holder: string) {
    const unit = this.units.get(objectId);
    const lifecycle = unit?.custom.lifecycle as Json | undefined;
    return (
      unit !== undefined &&
      sameAddress(unit.owner, holder) &&
      unit.custom.state === "Authenticity verified" &&
      lifecycle?.target_state === unit.custom.state
    );
  }

  async fetch(url: string, init: RequestInit) {
    const { pathname } = new URL(url);
    const authorization = new Headers(init.headers).get("authorization") ?? "";
    const party = this.partyOf(/^Bearer (\S+)$/.exec(authorization)?.[1]);
    if (!party) return json(401, { code: 16, message: "Not signed in" });
    this.ebus.push({ path: pathname, account: party.address });
    const body = JSON.parse(
      Buffer.from(init.body as ArrayBuffer).toString("utf8"),
    ) as Json;
    const nonce = this.nonces.get(party.walletId) ?? 1;
    if (pathname === "/ebus/prepare") {
      return json(200, { nonce, challenge: "AQID" });
    }
    if (pathname !== "/ebus/execute" || body.nonce !== nonce) {
      return json(400, { code: 3, message: "refused" });
    }
    const action = body.action as Json;
    const update = action.update as
      { id: string; custom?: Json; data?: { custom: Json } } | undefined;
    const transfer = action.transfer as { id: string; to: string } | undefined;
    const unit = this.units.get((update ?? transfer)?.id ?? "");
    if (!unit || !sameAddress(unit.owner, party.address)) {
      return json(403, { code: 7, message: "not the holder" });
    }
    if (update) unit.custom = clone(update.data?.custom ?? update.custom ?? {});
    else if (transfer) unit.owner = transfer.to;
    this.nonces.set(party.walletId, nonce + 1);
    const actionId = `dual-action-${this.executed.length + 1}`;
    this.executed.push({
      actionId,
      account: party.address,
      objectId: unit.id,
      name: update ? "update" : "transfer",
      ...(transfer ? { to: transfer.to } : {}),
    });
    return json(200, { action_id: actionId, steps: [] });
  }
}

// ------------------------------------------------------- fake runtimes

interface Offer {
  offerId: string;
  objectId: string;
  holder: string;
  ticket: string;
  recipient: string | null;
  /** The step each reserved step operation is. */
  steps: Map<string, "request" | "transfer">;
  reserved: Set<"request" | "transfer">;
  committed: Set<"request" | "transfer">;
}

interface CaseRecord {
  status: string;
  quote: {
    quote_version: number;
    provider: string;
    amount: string;
    currency: string;
  };
  decision: string | null;
  evidence: number;
  information: number;
}

/**
 * FIXTURE of the PROPOSED, NOT DEPLOYED contract r20
 * (docs/proposals/runtime-write-status-r20.md): a runtime's durable record of
 * one face write, keyed by its runtime and original operation id.
 */
interface Actor {
  holder: string;
  sub: string;
  iss: string;
  aud: string;
  programme: string;
  artifact: { version: string; artifactHash: string };
}

interface WriteRecord {
  kind: RuntimeKind;
  operationId: string;
  operation: string;
  target: Json;
  requestHash: string;
  holder: string;
  wallet: string;
  issuer: string;
  audience: string;
  programme: string;
  artifact: { version: string; artifactHash: string };
  applied: boolean;
  /** PROPOSED r20: outcomes the runtime cannot yet decide (held, 409). */
  unresolved: number;
  receipt: Json | null;
  /** The runtime's record time (RFC 3339, the mocked clock). */
  recordedAt: string;
  /**
   * FIXTURE (r20.1): the write's intended Dual effects, each with what the
   * runtime retained before and at dispatch (the intent commitment preimage,
   * the original verifier's receipt, the action it produced). write.status
   * RE-READS FakeDual for each effect's fresh corroboration every time.
   */
  dualBacked?: {
    intendedDualWrites: number;
    effects: RecordedEffect[];
  };
  /** FIXTURE knob: the target object cannot be read at all (409 unknown). */
  dualUnavailable?: boolean;
  answer: { status: number; body: Json };
}

/** FIXTURE (r20.1): what the runtime retained for one dispatched effect. */
interface RecordedEffect {
  index: number;
  kind: "mint" | "update";
  objectId: string;
  actionId: string;
  templateId: string;
  authority: { account: string; controller: string | null };
  /** The domain commitment the original verifier observed (= the intent). */
  intentHash: string;
  scope: { event_id: string; outbox_id: string; installation_id: string };
  /** When the original verifier qualified the effect: the write time. */
  verifiedAt: string;
  /** The provider's raw content hash the original verifier observed. */
  contentHashRaw: string;
}

/** PROPOSED r20: a non-write durable record a runtime can recover and ack. */
interface Recoverable {
  kind: "registration" | "settle" | "transfer";
  operationId: string;
  operation: string;
  objectId: string;
  proposalId: string | null;
  offerId: string | null;
  step: "request" | "transfer" | null;
  actor: Actor;
  recordedAt: string;
}

/** PROPOSED r20: one appended acknowledgement row beside a record. */
interface AckRow {
  iss: string;
  sub: string;
  holder: string;
  outcomeHash: string;
  at: string;
}

const WRITE_OPERATIONS = new Set([
  "case.open",
  "case.evidence.submit",
  "case.information.provide",
  "case.quote.approve",
  "case.quote.decline",
  "transfer.offer",
  "transfer.cancel",
]);

/**
 * LOCAL FAKE of one brand's Passport runtime and its linked Warranty runtime
 * (the same brand's state, two audiences).
 */
class BrandRuntime {
  /**
   * Off: the runtimes as deployed today (no write record, write.status
   * unknown). On: the labelled fixture of the PROPOSED r20 contract.
   */
  r20 = false;
  /** r20 fixture: rewrites a write.status answer (negative tests). */
  tamper: ((body: Json) => Json) | undefined;
  /** r20 fixture: artifacts the runtime treats as compatible (its set A). */
  compatible: Set<string> | undefined;
  readonly writes = new Map<string, WriteRecord>();
  /** r20 fixture: durable registration/settle/transfer records, by op id. */
  readonly recoverables = new Map<string, Recoverable>();
  /** r20 fixture: acknowledgement rows, keyed `${kind}:${operationId}`. */
  readonly acks = new Map<string, AckRow[]>();
  /**
   * r20.1 fixture: operations whose write intends Dual effects, in order,
   * with this runtime instance's knobs. By default a case.open is the
   * two-effect journey (CASE_OPEN_EFFECTS); every other write is server-only.
   */
  readonly dualBackedOps = new Map<
    string,
    { effects: IntendedEffect[]; knobs?: DualKnobs }
  >([["case.open", { effects: CASE_OPEN_EFFECTS }]]);
  /** r20.1 fixture: the refusal bodies write.status answered, in order. */
  readonly writeStatusRefusals: Json[] = [];
  /** r20 fixture: a recovery.list page holds at most this many items. */
  recoveryPageSize = 50;
  /** r20 fixture: force an incomplete scan (a store could not be read). */
  incompleteScan = false;
  /**
   * FIXTURE: one listed item shaped as the actual Studio runtime shapes an
   * index entry it retains although malformed (src/product-face-recovery.mjs
   * readRecoveryIndex / recoveryItemOf at 4b20253): the identity fields are
   * kept, operation, object_id and recorded_artifact are null.
   */
  malformedListedItem: { kind: RuntimeKind; operationId: string } | undefined;
  /** r20 fixture: inject one scan violation the wallet must catch. */
  recoveryViolation:
    | "repeat_id"
    | "out_of_order"
    | "cursor_cycle"
    | "change_scan_id"
    | "wrong_echo"
    | undefined;
  /** r20 fixture: live recovery scans, by opaque scan id. */
  private readonly scans = new Map<
    string,
    { asOf: number; actorKey: string; items: Json[] }
  >();
  private scanCounter = 0;
  private events = 0;
  readonly calls: Array<{
    by: "wallet" | "face";
    kind: RuntimeKind;
    operation: string;
    operationId: string;
    status: number;
  }> = [];
  /** Operations whose assertion this runtime refused. */
  readonly refused: string[] = [];
  /** Server-to-server requests that were not the wallet's fixed shape. */
  readonly violations: string[] = [];
  readonly cases: Map<string, CaseRecord>;
  private readonly jtis = new Set<string>();
  private readonly registrations = new Map<
    string,
    { objectId: string; holder: string }
  >();
  private readonly settleProposals = new Map<
    string,
    { objectId: string; holder: string }
  >();
  private readonly settleReservations = new Set<string>();
  /** The settle reservations by their own settle operation id. */
  private readonly settlesByOperation = new Map<
    string,
    { objectId: string; proposalId: string; holder: string }
  >();
  private readonly offers = new Map<string, Offer>();
  /** FIXTURE: the fixture object a Dual-backed write's action is applied to. */
  readonly dualBackedObjectId: string;

  constructor(
    readonly brand: Brand,
    private readonly dual: FakeDual,
  ) {
    this.dualBackedObjectId = sha256Hex(`${brand.brandId}-dual-backed`).slice(
      0,
      24,
    );
    const provider = `${brand.label} Service Centre`;
    this.cases = new Map([
      [
        brand.cases[0],
        {
          status: "prepared",
          quote: {
            quote_version: 2,
            provider,
            amount: "149.90",
            currency: "EUR",
          },
          decision: null,
          evidence: 0,
          information: 0,
        },
      ],
      [
        brand.cases[1],
        {
          status: "open",
          quote: {
            quote_version: 1,
            provider,
            amount: "39.00",
            currency: "EUR",
          },
          decision: null,
          evidence: 0,
          information: 0,
        },
      ],
    ]);
  }

  audience(kind: RuntimeKind) {
    return kind === "passport"
      ? `${this.brand.applicationId}@${this.brand.faceOrigin}`
      : `${this.brand.warranty.applicationId}@${this.brand.warranty.origin}`;
  }

  /**
   * Whether an assertion is this brand host's, for this runtime: its key id
   * and signature, issuer, audience, face and programme. Consumes nothing.
   */
  recognises(kind: RuntimeKind, assertion: string) {
    const [header, payload, signature] = assertion.split(".");
    try {
      const head = decode(header);
      const claims = decode(payload);
      return (
        head.alg === "EdDSA" &&
        head.typ === "dual-face-assertion+jwt" &&
        head.kid === this.brand.kid &&
        verifySignature(
          null,
          Buffer.from(`${header}.${payload}`),
          this.brand.keys.publicKey,
          Buffer.from(signature, "base64url"),
        ) &&
        claims.iss === this.brand.origin &&
        claims.aud === this.audience(kind) &&
        claims.app_id === this.brand.applicationId &&
        claims.programme === this.brand.programmeId &&
        claims.origin === this.brand.faceOrigin
      );
    } catch {
      return false;
    }
  }

  /** As the Studio runtimes check an assertion: exactly this request, once. */
  private verify(
    kind: RuntimeKind,
    assertion: unknown,
    expected: {
      operation: string;
      operationId: string;
      target?: Json;
      requestHash: string;
    },
  ) {
    if (typeof assertion !== "string" || !this.recognises(kind, assertion)) {
      return undefined;
    }
    const claims = claimsOf(assertion);
    if (
      claims.operation !== expected.operation ||
      claims.op_id !== expected.operationId ||
      (expected.target !== undefined &&
        canonicalJson(claims.target) !== canonicalJson(expected.target)) ||
      claims.request_hash !== expected.requestHash ||
      Number(claims.exp) * 1000 <= Date.now() ||
      typeof claims.jti !== "string" ||
      this.jtis.has(claims.jti)
    ) {
      return undefined;
    }
    this.jtis.add(claims.jti);
    return claims;
  }

  /** The wallet BFF's server-to-server request (through global fetch). */
  async fetch(kind: RuntimeKind, url: string, init: RequestInit) {
    const { pathname } = new URL(url);
    const headers = new Headers(init.headers);
    const routed =
      kind === "passport"
        ? this.brand.applicationId
        : this.brand.warranty.applicationId;
    if (
      headers.get("x-tig-product-face-application") !== routed ||
      headers.get("origin") !== null ||
      headers.get("cookie") !== null
    ) {
      this.violations.push(`${kind} ${pathname}`);
    }
    const body = JSON.parse(String(init.body)) as Json;
    if (
      kind === "passport" &&
      pathname === "/api/product-face/v1/registrations/status"
    ) {
      return this.registrationStatus(body);
    }
    if (pathname !== "/api/product-face/v1/operations") {
      this.violations.push(`${kind} ${pathname}`);
      return json(404, { ok: false });
    }
    return this.handle(kind, "wallet", body);
  }

  /** The face frame's own runtime request. */
  async fromFace(kind: RuntimeKind, body: Json) {
    const response = await this.handle(kind, "face", body);
    return { status: response.status, body: (await response.json()) as Json };
  }

  private async handle(kind: RuntimeKind, by: "wallet" | "face", body: Json) {
    const operation = String(body.operation);
    const operationId = String(body.operationId);
    const target = (body.target ?? {}) as Json;
    const input = (body.input ?? {}) as Json;
    const requestHash =
      operation === "registration.settle.reserve"
        ? sha(
            canonicalJson({
              proposal_id: input.proposal_id,
              settle_operation_id: operationId,
              object_id: target.object_id,
            }),
          )
        : hashOf(operation, operationId, target, input);
    const claims = this.verify(kind, body.assertion, {
      operation,
      operationId,
      target,
      requestHash,
    });
    if (!claims) this.refused.push(operation);
    const key = `${kind}:${operationId}`;
    const recorded = this.writes.get(key);
    let answer: Response;
    if (claims && this.r20 && operation === "write.status") {
      answer = this.writeStatus(kind, target, input, claims, recorded);
    } else if (claims && this.r20 && operation === "recovery.list") {
      answer = this.recoveryList(kind, operationId, claims, input);
    } else if (claims && this.r20 && operation === "recovery.ack") {
      answer = this.recoveryAck(kind, target, input, claims);
    } else if (
      claims &&
      this.r20 &&
      operation === "registration.settle.status"
    ) {
      answer = this.settleStatus(kind, operationId, target, input, claims);
    } else if (
      claims &&
      this.r20 &&
      WRITE_OPERATIONS.has(operation) &&
      recorded
    ) {
      // r20: a recorded op id answers its recorded result only to the same
      // caller for the same request; any other reuse is refused, undisclosed.
      answer =
        recorded.holder === claims.holder &&
        recorded.wallet === claims.sub &&
        recorded.audience === claims.aud &&
        recorded.issuer === claims.iss &&
        recorded.programme === claims.programme &&
        recorded.operation === operation &&
        canonicalJson(recorded.target) ===
          canonicalJson({
            object_id: target.object_id,
            ...(target.case_id ? { case_id: target.case_id } : {}),
          }) &&
        recorded.requestHash === requestHash
          ? json(recorded.answer.status, recorded.answer.body)
          : json(409, { ok: false, status: "face_operation_conflict" });
    } else {
      answer = this.dispatch(
        kind,
        operation,
        operationId,
        target,
        input,
        claims,
      );
      if (claims && this.r20 && WRITE_OPERATIONS.has(operation)) {
        const answered = (await answer.clone().json()) as Json;
        this.events += 1;
        const applied = answer.status === 200;
        // FIXTURE (r20.1): a Dual-backed warranty write performs its intended
        // Dual actions IN ORDER, each signed by the service account (NOT the
        // holder); its mint is of a fixture object (NOT the product target).
        const backing = applied ? this.dualBackedOps.get(operation) : undefined;
        const dualBacked = backing
          ? this.dispatchDualEffects(operationId, requestHash, backing)
          : undefined;
        this.writes.set(key, {
          kind,
          operationId,
          operation,
          target: {
            object_id: target.object_id,
            ...(target.case_id ? { case_id: target.case_id } : {}),
          },
          requestHash,
          holder: String(claims.holder),
          wallet: String(claims.sub),
          issuer: String(claims.iss),
          audience: String(claims.aud),
          programme: String(claims.programme),
          artifact: {
            version: String(claims.app_version),
            artifactHash: String(claims.artifact),
          },
          applied,
          unresolved: 0,
          recordedAt: new Date(Date.now()).toISOString(),
          ...(dualBacked ? { dualBacked } : {}),
          receipt: !applied
            ? null
            : kind === "warranty"
              ? {
                  kind: "case_event",
                  case_id: target.case_id,
                  event_id: `case-event-${this.events}`,
                }
              : {
                  kind: "transfer_offer",
                  offer_id: answered.offer_id,
                  state:
                    operation === "transfer.cancel" ? "cancelled" : "offered",
                },
          answer: { status: answer.status, body: answered },
        });
      }
      // r20: durable registration/settle/transfer records for recovery.list.
      if (claims && this.r20 && kind === "passport") {
        await this.recordRecoverable(
          claims,
          operation,
          operationId,
          target,
          input,
          answer,
        );
      }
      // r20 additive: a committed transfer.status/verify answer carries the
      // §0 echo, zero accounting and its outcome_proof (legacy: as today).
      if (
        claims &&
        this.r20 &&
        (operation === "transfer.status" || operation === "transfer.verify") &&
        answer.status === 200
      ) {
        answer = await this.augmentTransfer(
          kind,
          target,
          input,
          claims,
          answer,
        );
      }
    }
    this.calls.push({
      by,
      kind,
      operation,
      operationId,
      status: answer.status,
    });
    return answer;
  }

  private applicationIdFor(kind: RuntimeKind) {
    return kind === "passport"
      ? this.brand.applicationId
      : this.brand.warranty.applicationId;
  }

  /** PROPOSED r20 §0: the echoed binding and the read-only accounting block. */
  private echoBlock(kind: RuntimeKind, claims: Json, operationId: string) {
    return {
      operation_id: operationId,
      holder: claims.holder,
      wallet: claims.sub,
      issuer: claims.iss,
      application_id: this.applicationIdFor(kind),
      programme: claims.programme,
      asserting_artifact: {
        version: String(claims.app_version),
        artifactHash: String(claims.artifact),
      },
    };
  }

  private readonly accounting = {
    writesExecuted: 0,
    dualWritesExecuted: 0,
    providerWritesExecuted: 0,
    unknownWriteOutcomes: 0,
    secretReturned: false,
  };

  private bookkeeping(acknowledgementsRecorded: 0 | 1) {
    return { assertionsConsumed: 1, acknowledgementsRecorded };
  }

  private ackRow(kind: RuntimeKind, operationId: string, iss: unknown) {
    return (this.acks.get(`${kind}:${operationId}`) ?? []).find(
      (row) => row.iss === iss,
    );
  }

  /**
   * PROPOSED r20 §0: the runtime kind's outcome_proof, derived only from the
   * immutable record and its appended outcome; a Dual-backed write names the
   * proved effect so the acknowledgement binds it.
   */
  private runtimeOutcomeProof(recorded: WriteRecord, dual: Json | null) {
    const proof: Json = {
      kind: "runtime",
      operation_id: recorded.operationId,
      operation: recorded.operation,
      object_id: recorded.target.object_id,
      case_id: recorded.target.case_id ?? null,
      receipt: recorded.receipt,
      status: recorded.applied ? "write_applied" : "write_refused",
    };
    // r20.1: the whole ordered effect list and the original request.
    if (dual) proof.dual = dual;
    return proof;
  }

  /** FIXTURE (r20.1): a refused write.status, logged for the tests to read. */
  private writeStatusRefusal(status: number, body: Json) {
    this.writeStatusRefusals.push(body);
    return json(status, body);
  }

  /** FIXTURE (r20.1): the intent commitment, recomputed from its retained preimage. */
  private intentCommitment(
    operationId: string,
    requestHash: string,
    index: number,
    kind: "mint" | "update",
    objectId: string,
  ) {
    return sha(
      canonicalJson({
        operation_id: operationId,
        request_hash: requestHash,
        effect_index: index,
        kind,
        object_id: objectId,
      }),
    );
  }

  /**
   * FIXTURE (r20.1): dispatch each intended Dual effect of one applied write,
   * in order, retaining per effect what the contract's server obligations
   * name: the pre-dispatch intent commitment over a retained preimage and
   * the original verifier's receipt of the action it produced, with the
   * provider's raw content hash as that action's history entry carries it.
   */
  private dispatchDualEffects(
    operationId: string,
    requestHash: string,
    backing: { effects: IntendedEffect[]; knobs?: DualKnobs },
  ): NonNullable<WriteRecord["dualBacked"]> {
    const verifiedAt = new Date(Date.now()).toISOString();
    const effects = backing.effects.map((intent, index): RecordedEffect => {
      const objectId =
        intent.objectId === "fixture"
          ? this.dualBackedObjectId
          : this.brand.unit.id;
      const action = this.dual.recordDualBackedAction(
        objectId,
        SERVICE_ACCOUNT,
        intent.controller,
        intent.kind,
        {
          operation_id: operationId,
          effect_index: index,
          kind: intent.kind,
          object_id: objectId,
        },
        // The knob: FakeDual records the second action as failed.
        backing.knobs?.dualFailedEffect && index === 1 ? "FAILED" : "COMPLETED",
      );
      return {
        index,
        kind: intent.kind,
        objectId,
        actionId: action.actionId,
        templateId: this.brand.templateId,
        authority: { account: SERVICE_ACCOUNT, controller: intent.controller },
        intentHash: this.intentCommitment(
          operationId,
          requestHash,
          index,
          intent.kind,
          objectId,
        ),
        scope: {
          event_id: `evt-${index}`,
          outbox_id: `outbox-${index}`,
          installation_id: `inst-${this.brand.tag}`,
        },
        verifiedAt,
        contentHashRaw: action.contentHashRaw,
      };
    });
    return { intendedDualWrites: backing.effects.length, effects };
  }

  /**
   * FIXTURE (r20.1): the dual block of a Dual-backed write and its
   * outcome_proof projection. Each effect's historical corroboration is taken
   * by RE-READING FakeDual at this read: the executed action and that
   * object's own state-change history entry. This runtime instance's knobs
   * each degrade the answer in one named way (the wallet holds it); only an
   * action FakeDual did not complete is the runtime's own refusal.
   */
  private dualChain(
    recorded: WriteRecord,
  ): { dual: Json; projection: Json } | { unproved: number } {
    const backed = recorded.dualBacked!;
    const knobs = this.dualBackedOps.get(recorded.operation)?.knobs ?? {};
    const readAt = new Date(
      Date.now() - (knobs.dualStaleRead ? 11 * 60_000 : 0),
    ).toISOString();
    const rawHash = (value: string) =>
      knobs.dualSha256Hash ? `sha256:${value.slice(2)}` : value;
    const effects: Json[] = [];
    for (const effect of backed.effects) {
      const second = effect.index === 1;
      const action = this.dual.executed.find(
        (entry) => entry.actionId === effect.actionId,
      );
      // The knob: effect 1's entry is the fixture object's, not its own.
      const historyObjectId =
        knobs.dualHistoryOtherObject && second
          ? this.dualBackedObjectId
          : effect.objectId;
      const entries = this.dual.history.get(historyObjectId) ?? [];
      const entry =
        historyObjectId === effect.objectId
          ? entries.find((item) => item.actionId === effect.actionId)
          : entries.at(-1);
      if (!action || action.status !== "COMPLETED" || !entry) {
        return { unproved: effects.length };
      }
      effects.push({
        index: effect.index,
        action_id: effect.actionId,
        action_kind: effect.kind,
        object_id: effect.objectId,
        bound_to: {
          operation_id: recorded.operationId,
          request_hash: recorded.requestHash,
          effect_index: effect.index,
        },
        intent_commitment: {
          version: "v1",
          scheme: `dual_${recorded.operation.replace(/\./g, "_")}_v1`,
          hash: this.intentCommitment(
            recorded.operationId,
            recorded.requestHash,
            effect.index,
            effect.kind,
            effect.objectId,
          ),
          preimage_retained: true,
          scope: effect.scope,
        },
        original_receipt: {
          verifier: "runtime_original_verifier",
          verified_at: knobs.dualVerifiedAfterRead
            ? new Date(Date.parse(readAt) + 120_000).toISOString()
            : effect.verifiedAt,
          action_kind: effect.kind,
          action_id: effect.actionId,
          object_id: effect.objectId,
          network: "dual_main",
          api_scope: "api_v3",
          template_id: effect.templateId,
          authority:
            knobs.dualControllerUnrecorded && second
              ? { account: effect.authority.account }
              : effect.authority,
          domain_commitment: effect.intentHash,
          projection: "full_declared",
          content_hash_format: "provider_raw_hex_v1",
          content_hash_raw: rawHash(effect.contentHashRaw),
          content_hash_source: "raw_original_content",
        },
        historical_corroboration: {
          read_at: readAt,
          resolver: "dual_action_log",
          action_id: action.actionId,
          action_kind: action.name,
          object_id: action.objectId,
          network: "dual_main",
          api_scope: "api_v3",
          template_id: effect.templateId,
          execution: knobs.dualExecutionPending ? "pending" : "succeeded",
          status_raw: knobs.dualExecutionPending ? "PENDING" : action.status,
          authority: {
            account: action.account,
            controller:
              knobs.dualControllerMismatch && second
                ? null
                : (action.controller ?? null),
          },
          affected_objects: action.affectedObjects ?? [action.objectId],
          history_entry_id: entry.entryId,
          history_entry_object_id: historyObjectId,
          content_hash_format: "provider_raw_hex_v1",
          content_hash_raw: rawHash(entry.contentHashRaw),
          content_hash_match: entry.contentHashRaw === effect.contentHashRaw,
        },
        effect_verdict: "verified",
      });
    }
    const answered = knobs.dualShortEffects ? effects.slice(0, 1) : effects;
    return {
      dual: {
        backed: true,
        proof_kind: "original_verified_effect_receipt_v1",
        intended_dual_writes: backed.intendedDualWrites,
        effects: answered,
        ...(knobs.dualWithdrawnField ? { payload_match: true } : {}),
      },
      projection: {
        proof_kind: "original_verified_effect_receipt_v1",
        request: {
          operation_id: recorded.operationId,
          request_hash: recorded.requestHash,
        },
        effects: answered.map((item) => ({
          index: item.index,
          action_id: item.action_id,
          object_id: item.object_id,
          intent_commitment_hash: (item.intent_commitment as Json).hash,
          content_hash_raw: (item.original_receipt as Json).content_hash_raw,
        })),
      },
    };
  }

  /** r20 fixture: the verified record of one write, to its own caller only. */
  private writeStatus(
    kind: RuntimeKind,
    target: Json,
    input: Json,
    claims: Json,
    recorded: WriteRecord | undefined,
  ) {
    // §0: authenticate, then exact-match holder/sub/iss/aud/programme AND the
    // record's target AND its operation against input.original_operation.
    if (
      !recorded ||
      recorded.kind !== kind ||
      recorded.holder !== claims.holder ||
      recorded.wallet !== claims.sub ||
      recorded.audience !== claims.aud ||
      recorded.issuer !== claims.iss ||
      recorded.programme !== claims.programme ||
      canonicalJson(recorded.target) !== canonicalJson(target) ||
      recorded.operation !== input.original_operation
    ) {
      return this.writeStatusRefusal(404, {
        ok: false,
        status: "face_operation_not_found",
      });
    }
    const accepted = this.compatible ?? new Set([String(claims.artifact)]);
    if (
      !accepted.has(recorded.artifact.artifactHash) ||
      !accepted.has(String(claims.artifact))
    ) {
      return this.writeStatusRefusal(409, {
        ok: false,
        status: "face_operation_artifact_retired",
      });
    }
    // An outcome the runtime cannot yet decide (a provider or Dual write in
    // flight) is 409 write_outcome_unknown, never a guess.
    if (recorded.unresolved > 0) {
      return this.writeStatusRefusal(409, {
        ok: false,
        status: "write_outcome_unknown",
      });
    }
    // §1 dual: the server's binding of the write's ACTUAL effect to its
    // record, in one of two truthful branches.
    let dual: Json;
    let dualProjection: Json | null = null;
    if (recorded.dualBacked) {
      // §1a: one receipt chain per intended effect, each corroborated by
      // re-reading FakeDual now; a chain the runtime itself cannot corroborate
      // is 409 effects_unproved with the count proved, never write_applied.
      const chain = this.dualChain(recorded);
      if ("unproved" in chain) {
        return this.writeStatusRefusal(409, {
          ok: false,
          status: "write_outcome_unknown",
          reason: "effects_unproved",
          proved_effects: chain.unproved,
        });
      }
      dual = chain.dual;
      dualProjection = chain.projection;
    } else {
      // A server-only effect: a FRESH Dual read of the original target object.
      if (recorded.dualUnavailable) {
        return this.writeStatusRefusal(409, {
          ok: false,
          status: "write_outcome_unknown",
          reason: "target_readback_unavailable",
        });
      }
      const present = this.dual.units.has(String(recorded.target.object_id));
      dual = {
        backed: false,
        intended_dual_writes: 0,
        reason: "server_only_effect",
        target_readback: present ? "verified" : "absent",
      };
    }
    const outcomeProof = this.runtimeOutcomeProof(recorded, dualProjection);
    const body: Json = {
      ok: true,
      status: recorded.applied ? "write_applied" : "write_refused",
      contract: "r20",
      ...this.echoBlock(kind, claims, String(claims.op_id)),
      operation: recorded.operation,
      target: recorded.target,
      request_hash: recorded.requestHash,
      recorded_artifact: recorded.artifact,
      artifact_compatible: true,
      readback: "verified",
      receipt: recorded.receipt,
      dual,
      outcome_proof: outcomeProof,
      outcome_hash: sha(canonicalJson(outcomeProof)),
      acknowledged:
        this.ackRow(kind, recorded.operationId, claims.iss) !== undefined,
      ...this.accounting,
      bookkeeping: this.bookkeeping(0),
    };
    return json(200, this.tamper ? this.tamper(body) : body);
  }

  // ------------------------------------------- r20 recovery (fixture)

  private actorOf(claims: Json): Actor {
    return {
      holder: String(claims.holder),
      sub: String(claims.sub),
      iss: String(claims.iss),
      aud: String(claims.aud),
      programme: String(claims.programme),
      artifact: {
        version: String(claims.app_version),
        artifactHash: String(claims.artifact),
      },
    };
  }

  private sameActor(left: Actor, right: Actor) {
    return (
      left.holder === right.holder &&
      left.sub === right.sub &&
      left.iss === right.iss &&
      left.aud === right.aud &&
      left.programme === right.programme
    );
  }

  /**
   * FIXTURE SEEDING (PROPOSED r20): one write record bound to a captured
   * actor identity, so a listing can be driven past its resolution bound
   * without the confirmations each real write needs. Clearly a fixture; it
   * records nothing in Dual.
   */
  seedWriteRecord(
    actor: Actor,
    options: {
      operationId: string;
      operation?: string;
      objectId?: string;
      caseId?: string;
      recordedAt: string;
      recordedArtifact?: { version: string; artifactHash: string };
      applied?: boolean;
      unresolved?: number;
      dualUnavailable?: boolean;
    },
  ) {
    const operation = options.operation ?? "case.evidence.submit";
    const kind: RuntimeKind = operation.startsWith("case.")
      ? "warranty"
      : "passport";
    this.events += 1;
    this.writes.set(`${kind}:${options.operationId}`, {
      kind,
      operationId: options.operationId,
      operation,
      target: {
        object_id: options.objectId ?? this.brand.unit.id,
        ...(options.caseId ? { case_id: options.caseId } : {}),
      },
      requestHash: sha(`seed:${options.operationId}`),
      holder: actor.holder,
      wallet: actor.sub,
      issuer: actor.iss,
      audience: actor.aud,
      programme: actor.programme,
      artifact: options.recordedArtifact ?? actor.artifact,
      applied: options.applied ?? true,
      unresolved: options.unresolved ?? 0,
      recordedAt: options.recordedAt,
      ...(options.dualUnavailable ? { dualUnavailable: true } : {}),
      receipt: {
        kind: "case_event",
        case_id: options.caseId ?? this.brand.cases[0],
        event_id: `case-event-seed-${this.events}`,
      },
      answer: { status: 200, body: { ok: true } },
    });
  }

  private async recordRecoverable(
    claims: Json,
    operation: string,
    operationId: string,
    target: Json,
    input: Json,
    answer: Response,
  ) {
    if (answer.status !== 200 && answer.status !== 202) return;
    let body: Json;
    try {
      body = (await answer.clone().json()) as Json;
    } catch {
      return;
    }
    if (body.ok !== true) return;
    const actor = this.actorOf(claims);
    const recordedAt = new Date(Date.now()).toISOString();
    const base = {
      objectId: String(target.object_id ?? ""),
      caseId: null,
      actor,
      recordedAt,
      proposalId: null as string | null,
      offerId: null as string | null,
      step: null as "request" | "transfer" | null,
    };
    if (
      operation === "registration.submit" ||
      operation === "transfer.accept"
    ) {
      this.recoverables.set(operationId, {
        ...base,
        kind: "registration",
        operationId,
        operation: "registration.submit",
      });
    } else if (operation === "registration.settle.reserve") {
      this.recoverables.set(operationId, {
        ...base,
        kind: "settle",
        operationId,
        operation: "registration.settle",
        proposalId: String(input.proposal_id),
      });
    } else if (operation === "transfer.reserve") {
      const reservation = (body.reservation ?? {}) as Json;
      const step = reservation.step;
      if (step === "request" || step === "transfer") {
        this.recoverables.set(operationId, {
          ...base,
          kind: "transfer",
          operationId,
          operation:
            step === "transfer" ? "transfer.transfer" : "transfer.request",
          offerId: String(input.offer_id),
          step,
        });
      }
    }
  }

  /** The holder's Dual action for a settle or transfer step, if it ran. */
  private holderAction(
    objectId: string,
    holder: string,
    kind: "update" | "transfer",
    to?: string,
  ) {
    return this.dual.executed.find(
      (action) =>
        sameAddress(action.account, holder) &&
        action.objectId === objectId &&
        action.name === kind &&
        (kind === "transfer" ? action.to === to : true),
    );
  }

  private recoverableState(rec: Recoverable): {
    state: "unresolved" | "completed";
    actionId: string | null;
  } {
    if (rec.kind === "registration") {
      return {
        state: this.dual.settled(rec.objectId, rec.actor.holder)
          ? "completed"
          : "unresolved",
        actionId: null,
      };
    }
    if (rec.kind === "settle") {
      // Proved from the historical settle action, not current ownership: a
      // later onward transfer never invalidates a committed settle (§0).
      const action = this.holderAction(
        rec.objectId,
        rec.actor.holder,
        "update",
      );
      return {
        state: action ? "completed" : "unresolved",
        actionId: action?.actionId ?? null,
      };
    }
    // transfer
    const offer = rec.offerId ? this.offers.get(rec.offerId) : undefined;
    const action = offer
      ? this.holderAction(
          rec.objectId,
          rec.actor.holder,
          rec.step === "transfer" ? "transfer" : "update",
          offer.recipient ?? undefined,
        )
      : undefined;
    const committed = Boolean(
      offer && rec.step && offer.committed.has(rec.step),
    );
    return {
      state: committed ? "completed" : "unresolved",
      actionId: action?.actionId ?? null,
    };
  }

  private recoveryItem(item: {
    kind: RecoveryKind;
    operationId: string;
    operation: string;
    objectId: string;
    caseId: string | null;
    offerId: string | null;
    proposalId: string | null;
    step: "request" | "transfer" | null;
    actionId: string | null;
    state: "unresolved" | "completed" | "refused";
    recordedAt: string;
    artifact: { version: string; artifactHash: string };
  }): Json {
    const compatible = this.compatible
      ? this.compatible.has(item.artifact.artifactHash)
      : true;
    return {
      kind: item.kind,
      operation_id: item.operationId,
      operation: item.operation,
      object_id: item.objectId,
      case_id: item.caseId,
      offer_id: item.offerId,
      proposal_id: item.proposalId,
      step: item.step,
      action_id: item.actionId,
      state: item.state,
      recorded_at: item.recordedAt,
      recorded_artifact: item.artifact,
      artifact_compatible: compatible,
    };
  }

  /** This actor's recovery items at this runtime, in the contract's order. */
  private buildRecoveryItems(kind: RuntimeKind, actor: Actor): Json[] {
    const items: Json[] = [];
    for (const rec of this.writes.values()) {
      if (
        rec.kind !== kind ||
        rec.holder !== actor.holder ||
        rec.wallet !== actor.sub ||
        rec.issuer !== actor.iss ||
        rec.audience !== actor.aud ||
        rec.programme !== actor.programme ||
        this.ackRow(kind, rec.operationId, actor.iss)
      ) {
        continue;
      }
      const state =
        rec.unresolved > 0
          ? "unresolved"
          : rec.applied
            ? "completed"
            : "refused";
      items.push(
        this.recoveryItem({
          kind: "runtime",
          operationId: rec.operationId,
          operation: rec.operation,
          objectId: String(rec.target.object_id),
          caseId: (rec.target.case_id as string) ?? null,
          offerId: null,
          proposalId: null,
          step: null,
          actionId: null,
          state,
          recordedAt: rec.recordedAt,
          artifact: rec.artifact,
        }),
      );
    }
    if (kind === "passport") {
      for (const rec of this.recoverables.values()) {
        if (
          !this.sameActor(rec.actor, actor) ||
          this.ackRow(kind, rec.operationId, actor.iss)
        ) {
          continue;
        }
        const { state, actionId } = this.recoverableState(rec);
        items.push(
          this.recoveryItem({
            kind: rec.kind,
            operationId: rec.operationId,
            operation: rec.operation,
            objectId: rec.objectId,
            caseId: null,
            offerId: rec.offerId,
            proposalId: rec.proposalId,
            step: rec.step,
            actionId,
            state,
            recordedAt: rec.recordedAt,
            artifact: rec.actor.artifact,
          }),
        );
      }
    }
    if (this.malformedListedItem?.kind === kind) {
      items.push({
        kind: "runtime",
        operation_id: this.malformedListedItem.operationId,
        operation: null,
        object_id: null,
        case_id: null,
        offer_id: null,
        proposal_id: null,
        step: null,
        action_id: null,
        state: "unresolved",
        recorded_at: new Date(Date.now() - 60_000).toISOString(),
        recorded_artifact: null,
        artifact_compatible: false,
      });
    }
    items.sort((left, right) => {
      const byTime =
        Date.parse(left.recorded_at as string) -
        Date.parse(right.recorded_at as string);
      if (byTime !== 0) return byTime;
      const a = left.operation_id as string;
      const b = right.operation_id as string;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return items;
  }

  private makeCursor(scanId: string, offset: number) {
    return Buffer.from(JSON.stringify({ s: scanId, o: offset })).toString(
      "base64url",
    );
  }

  private parseCursor(value: string) {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      ) as Json;
      return typeof parsed.s === "string" && typeof parsed.o === "number"
        ? { scanId: parsed.s, offset: parsed.o }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private recoveryPage(
    kind: RuntimeKind,
    claims: Json,
    opId: string,
    fields: {
      scanId: string;
      asOf: number;
      items: Json[];
      next: string | null;
      complete: boolean;
      echo?: Json;
    },
  ) {
    return json(200, {
      ok: true,
      status: "recovery_listed",
      contract: "r20",
      ...(fields.echo ?? this.echoBlock(kind, claims, opId)),
      scan_id: fields.scanId,
      as_of: new Date(fields.asOf).toISOString(),
      items: fields.items,
      next: fields.next,
      complete: fields.complete,
      ...this.accounting,
      bookkeeping: this.bookkeeping(0),
    });
  }

  private recoveryList(
    kind: RuntimeKind,
    operationId: string,
    claims: Json,
    input: Json,
  ) {
    const actor = this.actorOf(claims);
    const actorKey = [
      actor.holder,
      actor.sub,
      actor.iss,
      actor.aud,
      actor.programme,
    ].join("|");
    if (this.recoveryViolation) {
      return this.recoveryViolationPage(
        kind,
        operationId,
        claims,
        actor,
        input,
      );
    }
    const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
    let scanId: string;
    let asOf: number;
    let all: Json[];
    let offset: number;
    if (!cursor) {
      this.scanCounter += 1;
      scanId = `scan-${this.brand.tag}-${this.scanCounter}`;
      asOf = Date.now();
      all = this.buildRecoveryItems(kind, actor).filter(
        (item) => Date.parse(item.recorded_at as string) <= asOf,
      );
      this.scans.set(scanId, { asOf, actorKey, items: all });
      offset = 0;
    } else {
      const parsed = this.parseCursor(cursor);
      const scan = parsed ? this.scans.get(parsed.scanId) : undefined;
      if (!parsed || !scan || scan.actorKey !== actorKey) {
        return json(409, { ok: false, status: "recovery_cursor_invalid" });
      }
      scanId = parsed.scanId;
      asOf = scan.asOf;
      all = scan.items;
      offset = parsed.offset;
    }
    const pageItems = all.slice(offset, offset + this.recoveryPageSize);
    const nextOffset = offset + pageItems.length;
    const next =
      nextOffset < all.length ? this.makeCursor(scanId, nextOffset) : null;
    return this.recoveryPage(kind, claims, operationId, {
      scanId,
      asOf,
      items: pageItems,
      next,
      complete: !this.incompleteScan,
    });
  }

  /** FIXTURE: a scripted two-page scan carrying one violation the wallet catches. */
  private recoveryViolationPage(
    kind: RuntimeKind,
    opId: string,
    claims: Json,
    actor: Actor,
    input: Json,
  ) {
    const all = this.buildRecoveryItems(kind, actor);
    // A runtime with nothing to list cannot carry the violation: answer a
    // clean empty complete page, so only the runtime that holds this actor's
    // items injects it.
    if (all.length === 0) {
      return this.recoveryPage(kind, claims, opId, {
        scanId: `scan-${this.brand.tag}-viol`,
        asOf: Date.now(),
        items: [],
        next: null,
        complete: true,
      });
    }
    const first = all[0];
    const second = all[1] ?? all[0];
    const asOf = Date.now();
    const scanId = `scan-${this.brand.tag}-viol`;
    const nextCursor = "recovery-violation-next";
    const page1 = input.cursor === nextCursor;
    const emit = (fields: {
      items: Json[];
      next: string | null;
      scanId?: string;
      echo?: Json;
    }) =>
      this.recoveryPage(kind, claims, opId, {
        scanId: fields.scanId ?? scanId,
        asOf,
        items: fields.items,
        next: fields.next,
        complete: true,
        echo: fields.echo,
      });
    switch (this.recoveryViolation) {
      case "wrong_echo":
        return emit({
          items: [first],
          next: null,
          echo: {
            ...this.echoBlock(kind, claims, opId),
            holder: `0x${"e".repeat(40)}`,
          },
        });
      case "change_scan_id":
        return page1
          ? emit({ items: [second], next: null, scanId: `${scanId}-other` })
          : emit({ items: [first], next: nextCursor });
      case "cursor_cycle":
        return page1
          ? emit({ items: [second], next: nextCursor })
          : emit({ items: [first], next: nextCursor });
      case "repeat_id":
        return page1
          ? emit({ items: [first], next: null })
          : emit({ items: [first], next: nextCursor });
      case "out_of_order":
        return page1
          ? emit({ items: [first], next: null })
          : emit({ items: [second], next: nextCursor });
    }
    return emit({ items: all, next: null });
  }

  private registrationProof(
    objectId: string,
    operationId: string,
    actionId: string | null,
  ): Json {
    return {
      kind: "registration",
      operation_id: operationId,
      object_id: objectId,
      action_id: actionId,
      status: "registered",
    };
  }

  private settleProof(
    settleOpId: string,
    proposalId: string,
    objectId: string,
    actionId: string,
  ): Json {
    return {
      kind: "settle",
      operation_id: settleOpId,
      proposal_id: proposalId,
      object_id: objectId,
      action_id: actionId,
      status: "registered",
    };
  }

  private transferProof(
    stepOpId: string,
    offerId: string,
    objectId: string,
    step: "request" | "transfer",
    actionId: string,
    status: string,
  ): Json {
    return {
      kind: "transfer",
      operation_id: stepOpId,
      offer_id: offerId,
      object_id: objectId,
      step,
      action_id: actionId,
      status,
    };
  }

  /** r20: a host-only read-only settle reconcile; never a dispatch. */
  private settleStatus(
    kind: RuntimeKind,
    operationId: string,
    target: Json,
    input: Json,
    claims: Json,
  ) {
    // As the Studio runtime reads it (src/product-face-runtime.mjs
    // settleStatus): the settle's own operation id, the unit, NO input.
    if (
      Object.keys(target).join(",") !== "object_id" ||
      Object.keys(input).length > 0
    ) {
      return json(400, { ok: false, status: "face_request_invalid" });
    }
    const objectId = String(target.object_id ?? "");
    const settleOp = operationId;
    const holder = String(claims.holder);
    const reserved = this.settlesByOperation.get(settleOp);
    if (
      !reserved ||
      reserved.objectId !== objectId ||
      !sameAddress(reserved.holder, holder)
    ) {
      return json(404, { ok: false, status: "settle_reservation_not_found" });
    }
    const proposalId = reserved.proposalId;
    // Proved from the historical settle action, never current ownership (§0).
    const action = this.holderAction(objectId, holder, "update");
    if (!action) {
      return json(202, { ok: false, status: "outcome_unknown" });
    }
    const proof = this.settleProof(
      settleOp,
      proposalId,
      objectId,
      action.actionId,
    );
    return json(200, {
      ok: true,
      status: "registered",
      contract: "r20",
      ...this.echoBlock(kind, claims, operationId),
      object_id: objectId,
      proposal_id: proposalId,
      outcome_proof: proof,
      outcome_hash: sha(canonicalJson(proof)),
      ...this.accounting,
      bookkeeping: this.bookkeeping(0),
    });
  }

  /** r20 additive fields on a committed transfer.status/verify answer. */
  private async augmentTransfer(
    kind: RuntimeKind,
    target: Json,
    input: Json,
    claims: Json,
    answer: Response,
  ) {
    const body = (await answer.clone().json()) as Json;
    const offerId = String(input.offer_id ?? "");
    const stepOp = String(input.step_operation_id ?? "");
    const offer = this.offers.get(offerId);
    const step = offer?.steps.get(stepOp);
    if (!offer || (step !== "request" && step !== "transfer")) return answer;
    const action = this.holderAction(
      offer.objectId,
      offer.holder,
      step === "transfer" ? "transfer" : "update",
      offer.recipient ?? undefined,
    );
    if (!action) return answer;
    const proof = this.transferProof(
      stepOp,
      offerId,
      offer.objectId,
      step,
      action.actionId,
      String(body.status),
    );
    return json(200, {
      ...body,
      contract: "r20",
      ...this.echoBlock(kind, claims, String(claims.op_id)),
      outcome_proof: proof,
      outcome_hash: sha(canonicalJson(proof)),
      ...this.accounting,
      bookkeeping: this.bookkeeping(0),
    });
  }

  /** The current outcome proof + hash of a record, or why it cannot be acked. */
  private recordProof(
    kind: RuntimeKind,
    opId: string,
    target: Json,
    input: Json,
    claims: Json,
  ): "not_found" | "unresolved" | { hash: string } {
    const actor = this.actorOf(claims);
    const originalOperation = String(input.original_operation ?? "");
    const objectId = String(target.object_id ?? "");
    const write = this.writes.get(`${kind}:${opId}`);
    if (write) {
      if (
        write.holder !== actor.holder ||
        write.wallet !== actor.sub ||
        write.issuer !== actor.iss ||
        write.audience !== actor.aud ||
        write.programme !== actor.programme ||
        canonicalJson(write.target) !== canonicalJson(target) ||
        write.operation !== originalOperation
      ) {
        return "not_found";
      }
      if (write.unresolved > 0) return "unresolved";
      let dual: Json | null = null;
      if (write.dualBacked) {
        // r20.1: the ack binds the same chain write.status answered; an
        // effect the runtime cannot corroborate now is not acknowledgeable.
        const chain = this.dualChain(write);
        if ("unproved" in chain) return "unresolved";
        dual = chain.projection;
      }
      const proof = this.runtimeOutcomeProof(write, dual);
      return { hash: sha(canonicalJson(proof)) };
    }
    if (kind !== "passport") return "not_found";
    const rec = this.recoverables.get(opId);
    if (
      !rec ||
      !this.sameActor(rec.actor, actor) ||
      rec.objectId !== objectId ||
      rec.operation !== originalOperation
    ) {
      return "not_found";
    }
    const { state, actionId } = this.recoverableState(rec);
    if (state !== "completed") return "unresolved";
    let proof: Json;
    if (rec.kind === "registration") {
      proof = this.registrationProof(rec.objectId, rec.operationId, null);
    } else if (rec.kind === "settle") {
      proof = this.settleProof(
        rec.operationId,
        rec.proposalId ?? "",
        rec.objectId,
        actionId ?? "",
      );
    } else {
      const offer = rec.offerId ? this.offers.get(rec.offerId) : undefined;
      const status =
        rec.step === "transfer" ? "transferred" : "transfer_request_committed";
      proof = this.transferProof(
        rec.operationId,
        rec.offerId ?? "",
        rec.objectId,
        rec.step ?? "request",
        actionId ?? "",
        status,
      );
      void offer;
    }
    return { hash: sha(canonicalJson(proof)) };
  }

  /** r20: the idempotent acknowledgement row, bound to the proved outcome. */
  private recoveryAck(
    kind: RuntimeKind,
    target: Json,
    input: Json,
    claims: Json,
  ) {
    const opId = String(claims.op_id);
    const resolved = this.recordProof(kind, opId, target, input, claims);
    if (resolved === "not_found") {
      return json(404, { ok: false, status: "face_operation_not_found" });
    }
    if (resolved === "unresolved") {
      return json(409, { ok: false, status: "recovery_unresolved" });
    }
    if (resolved.hash !== String(input.outcome_hash)) {
      return json(409, { ok: false, status: "recovery_outcome_mismatch" });
    }
    const ackKey = `${kind}:${opId}`;
    const rows = this.acks.get(ackKey) ?? [];
    const existing = rows.find((row) => row.iss === claims.iss);
    const first = !existing;
    const at = existing?.at ?? new Date(Date.now()).toISOString();
    if (first) {
      rows.push({
        iss: String(claims.iss),
        sub: String(claims.sub),
        holder: String(claims.holder),
        outcomeHash: resolved.hash,
        at,
      });
      this.acks.set(ackKey, rows);
    }
    return json(200, {
      ok: true,
      status: "recovery_acknowledged",
      contract: "r20",
      ...this.echoBlock(kind, claims, opId),
      outcome_hash: resolved.hash,
      first,
      acknowledged_at: at,
      ...this.accounting,
      bookkeeping: this.bookkeeping(first ? 1 : 0),
    });
  }

  private dispatch(
    kind: RuntimeKind,
    operation: string,
    operationId: string,
    target: Json,
    input: Json,
    claims: Json | undefined,
  ) {
    return !claims
      ? json(403, { ok: false, status: "face_assertion_mismatch" })
      : kind === "passport"
        ? this.passport(
            operation,
            operationId,
            target,
            input,
            String(claims.holder),
          )
        : this.warrantyCase(operation, target, String(claims.holder));
  }

  private registrationStatus(body: Json) {
    const operationId = String(body.operationId);
    const registration = this.registrations.get(operationId);
    const claims = this.verify("passport", body.assertion, {
      operation: "registration.status",
      operationId,
      target: registration ? { object_id: registration.objectId } : undefined,
      requestHash: sha(canonicalJson({ operationId })),
    });
    let answer: Response;
    if (!claims) {
      this.refused.push("registration.status");
      answer = json(403, { ok: false, status: "face_assertion_mismatch" });
    } else if (!registration) {
      answer = json(404, {
        ok: false,
        status: "not_submitted",
        reason: "face_operation_not_found",
        operationId,
        objectId: null,
      });
    } else {
      const status = this.dual.settled(
        registration.objectId,
        registration.holder,
      )
        ? "registered"
        : "ownership_moved_state_pending";
      answer = json(200, {
        ok: status === "registered",
        status,
        operationId,
        objectId: registration.objectId,
      });
    }
    this.calls.push({
      by: "wallet",
      kind: "passport",
      operation: "registration.status",
      operationId,
      status: answer.status,
    });
    return answer;
  }

  private offerOf(ticket: unknown) {
    return [...this.offers.values()].find((offer) => offer.ticket === ticket);
  }

  private passport(
    operation: string,
    operationId: string,
    target: Json,
    input: Json,
    holder: string,
  ): Response {
    const objectId = String(target.object_id ?? "");
    const unit = this.dual.units.get(objectId);
    const owned = sameAddress(unit?.owner, holder);
    switch (operation) {
      case "registration.submit": {
        if (
          !unit ||
          unit.owner !== this.brand.issuer ||
          unit.custom.recordId !== input.record_id
        ) {
          return json(409, { ok: false, status: "registration_refused" });
        }
        // The issuer hands custody over; the holder's wallet settles it.
        unit.owner = holder;
        unit.custom = {
          ...unit.custom,
          state: "Transfer pending",
          lifecycle: { target_state: "Transfer pending" },
        };
        this.registrations.set(operationId, { objectId, holder });
        return json(202, {
          ok: true,
          status: "ownership_moved_state_pending",
          operationId,
          objectId,
        });
      }
      case "registration.settle.propose": {
        const registration = this.registrations.get(operationId);
        if (
          !unit ||
          !owned ||
          registration?.objectId !== objectId ||
          registration.holder !== holder
        ) {
          return json(404, {
            ok: false,
            status: "face_operation_not_found",
            reason: "face_operation_not_found",
          });
        }
        if (unit.custom.state !== "Transfer pending") {
          return json(409, { ok: false, status: "settle_not_required" });
        }
        // A deep copy of the fresh unit with only the governed leaves written.
        // (The settle template is the face's nested `custom` one.)
        const proposed = {
          custom: {
            ...clone(unit.custom),
            state: "Authenticity verified",
            lifecycle: { target_state: "Authenticity verified" },
          },
        };
        const proposalId = `psp-${this.brand.tag}-${this.settleProposals.size + 1}`;
        this.settleProposals.set(proposalId, { objectId, holder });
        return json(200, {
          ok: true,
          status: "settle_proposed",
          proposal_id: proposalId,
          operation_id: operationId,
          object_id: objectId,
          action: "update",
          input: proposed,
          proposal_hash: sha(
            canonicalJson({
              object_id: objectId,
              action: "update",
              input: proposed,
            }),
          ),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      case "registration.settle.reserve": {
        const proposalId = String(input.proposal_id);
        const proposal = this.settleProposals.get(proposalId);
        if (proposal?.objectId !== objectId || proposal.holder !== holder) {
          return json(409, { ok: false, status: "settle_proposal_unknown" });
        }
        const key = `${objectId}:${proposalId}`;
        if (this.settleReservations.has(key)) {
          return json(409, {
            ok: false,
            status: "already_claimed",
            dispatch: "already_claimed",
          });
        }
        this.settleReservations.add(key);
        this.settlesByOperation.set(operationId, {
          objectId,
          proposalId,
          holder,
        });
        return json(200, {
          ok: true,
          status: "granted",
          dispatch: "won",
          reservation: {
            settle_operation_id: operationId,
            object_id: objectId,
            proposal_id: proposalId,
          },
        });
      }
      case "registration.settle.verify":
        return this.dual.settled(objectId, holder)
          ? json(200, { ok: true, status: "registered", objectId })
          : json(202, { ok: false, status: "outcome_unknown" });
      case "products.private.read":
        return owned
          ? json(200, {
              ok: true,
              product: {
                object_id: objectId,
                purchase: { date: "2026-09-30", channel: this.brand.label },
              },
            })
          : json(403, { ok: false, status: "not_holder" });
      case "transfer.offer": {
        if (!owned) return json(403, { ok: false, status: "not_holder" });
        const offerId = `pto-${randomBytes(12).toString("hex")}`;
        const ticket = randomBytes(32).toString("base64url");
        this.offers.set(offerId, {
          offerId,
          objectId,
          holder,
          ticket,
          recipient: null,
          steps: new Map(),
          reserved: new Set(),
          committed: new Set(),
        });
        return json(200, {
          ok: true,
          status: "transfer_offered",
          offer_id: offerId,
          acceptance_ticket: ticket,
        });
      }
      case "transfer.acceptance.read": {
        const offer = this.offerOf(input.acceptance_ticket);
        return offer && !offer.recipient
          ? json(200, {
              ok: true,
              status: "transfer_acceptance",
              object_id: offer.objectId,
              secretReturned: false,
            })
          : json(409, { ok: false, status: "transfer_offer_not_found" });
      }
      case "transfer.accept": {
        const offer = this.offerOf(input.acceptance_ticket);
        if (
          !offer ||
          offer.recipient ||
          offer.objectId !== objectId ||
          offer.holder === holder
        ) {
          return json(409, { ok: false, status: "transfer_offer_not_found" });
        }
        offer.recipient = holder;
        // The recipient's own registration, settled on its wallet once
        // custody moved.
        this.registrations.set(operationId, { objectId, holder });
        return json(200, {
          ok: true,
          status: "transfer_accepted",
          offer_id: offer.offerId,
        });
      }
      case "transfer.propose": {
        const offer = this.offers.get(String(input.offer_id));
        if (!unit || offer?.holder !== holder || offer.objectId !== objectId) {
          return json(404, { ok: false, status: "transfer_offer_not_found" });
        }
        if (!offer.recipient) {
          return json(409, { ok: false, status: "transfer_not_accepted" });
        }
        const step = offer.committed.has("request") ? "transfer" : "request";
        const proposed =
          step === "transfer"
            ? { to: offer.recipient }
            : {
                data: {
                  custom: {
                    ...clone(unit.custom),
                    state: "Transfer pending",
                    lifecycle: { target_state: "Transfer pending" },
                    proof_event: {
                      public_fields: [
                        `recipientReferenceHash:${sha(offer.recipient)}`,
                      ],
                    },
                  },
                },
              };
        const action = step === "transfer" ? "transfer" : "update";
        return json(200, {
          ok: true,
          status: "transfer_step_proposed",
          step,
          proposal_id: `ptp-${randomBytes(12).toString("hex")}`,
          offer_id: offer.offerId,
          object_id: objectId,
          action,
          input: proposed,
          proposal_hash: sha(
            canonicalJson({ object_id: objectId, action, input: proposed }),
          ),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          recipient: offer.recipient,
        });
      }
      case "transfer.reserve": {
        const offer = this.offers.get(String(input.offer_id));
        if (offer?.holder !== holder) {
          return json(409, {
            ok: false,
            status: "transfer_offer_not_found",
            dispatch: "refused",
            executionPermitted: false,
          });
        }
        const step = offer.committed.has("request") ? "transfer" : "request";
        if (offer.reserved.has(step)) {
          return json(409, {
            ok: false,
            status: "already_claimed",
            dispatch: "already_claimed",
            executionPermitted: false,
          });
        }
        offer.reserved.add(step);
        offer.steps.set(operationId, step);
        return json(200, {
          ok: true,
          status: "granted",
          dispatch: "won",
          executionPermitted: true,
          reservation: {
            step,
            state: "granted",
            step_operation_id: operationId,
            proposal_id: input.proposal_id,
          },
        });
      }
      case "transfer.verify":
      case "transfer.status": {
        const offer = this.offers.get(String(input.offer_id));
        const step = offer?.steps.get(String(input.step_operation_id));
        if (!offer || !step || offer.holder !== holder) {
          return json(404, { ok: false, status: "transfer_step_not_found" });
        }
        // Committed only on the holder's own executed action for this step.
        const done = this.dual.executed.some(
          (action) =>
            sameAddress(action.account, offer.holder) &&
            action.objectId === offer.objectId &&
            (operation === "transfer.status" ||
              action.actionId === input.action_id) &&
            (step === "transfer"
              ? action.name === "transfer" && action.to === offer.recipient
              : action.name === "update"),
        );
        if (!done) {
          return json(202, {
            ok: false,
            status: "outcome_unknown",
            reason: "transfer_action_not_found",
          });
        }
        offer.committed.add(step);
        return json(200, {
          ok: true,
          status:
            step === "transfer" ? "transferred" : "transfer_request_committed",
          step,
        });
      }
      default:
        return json(400, { ok: false, status: "face_request_invalid" });
    }
  }

  private warrantyCase(operation: string, target: Json, holder: string) {
    // As the passport side: an operation this runtime does not know is
    // refused before any holder check (a legacy runtime asked for r20).
    if (
      !["cases.list", "case.read"].includes(operation) &&
      !WRITE_OPERATIONS.has(operation)
    ) {
      return json(400, { ok: false, status: "face_request_invalid" });
    }
    const unit = this.dual.units.get(String(target.object_id ?? ""));
    if (!sameAddress(unit?.owner, holder)) {
      return json(403, { ok: false, status: "not_holder" });
    }
    if (operation === "cases.list") {
      return json(200, {
        ok: true,
        cases: [...this.cases].map(([caseId, item]) => ({
          case_id: caseId,
          status: item.status,
        })),
      });
    }
    const caseId = String(target.case_id ?? "");
    const item = this.cases.get(caseId);
    if (!item) return json(404, { ok: false, status: "case_not_found" });
    switch (operation) {
      case "case.read":
        return json(200, {
          ok: true,
          case: { case_id: caseId, status: item.status, quote: item.quote },
        });
      case "case.open":
        if (item.status !== "prepared") {
          return json(409, { ok: false, status: "case_not_prepared" });
        }
        item.status = "open";
        return json(200, { ok: true, status: "case_opened", case_id: caseId });
      case "case.evidence.submit":
        item.evidence += 1;
        return json(200, { ok: true, status: "evidence_received" });
      case "case.information.provide":
        item.information += 1;
        return json(200, { ok: true, status: "information_received" });
      case "case.quote.approve":
      case "case.quote.decline": {
        if (
          item.decision ||
          target.quote_version !== item.quote.quote_version ||
          target.amount !== item.quote.amount ||
          target.currency !== item.quote.currency
        ) {
          return json(409, { ok: false, status: "quote_changed" });
        }
        item.decision =
          operation === "case.quote.approve" ? "approved" : "declined";
        return json(200, { ok: true, status: `quote_${item.decision}` });
      }
      default:
        return json(400, { ok: false, status: "face_request_invalid" });
    }
  }
}

// ------------------------------------------------------------------ world

interface World {
  dual: FakeDual;
  runtimes: Map<Brand, BrandRuntime>;
}
let world: World;
const runtimeOf = (brand: Brand) => world.runtimes.get(brand)!;

function newWorld() {
  const dual = new FakeDual(BRANDS);
  world = {
    dual,
    runtimes: new Map(
      BRANDS.map((brand) => [brand, new BrandRuntime(brand, dual)]),
    ),
  };
  global.fetch = jest.fn(
    async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const { origin } = new URL(url);
      if (origin === "https://api.dual.network")
        return world.dual.fetch(url, init);
      for (const runtime of world.runtimes.values()) {
        if (origin === runtime.brand.faceOrigin) {
          return runtime.fetch("passport", url, init);
        }
        if (origin === runtime.brand.warranty.origin) {
          return runtime.fetch("warranty", url, init);
        }
      }
      throw new TypeError(`fetch failed: ${url}`);
    },
  ) as unknown as typeof fetch;
}

/**
 * One host deployment: the engine built with this configuration and registry
 * (the build records both), and this host's own secrets. `build` stands in
 * an earlier build's record, as a deployment that was not rebuilt has.
 */
function deploy(
  brand: Brand,
  {
    document = brand.document(),
    registry = registryWithBothFullFaces(),
    build,
  }: {
    document?: HostDocument;
    registry?: string;
    build?: { configuration: string };
  } = {},
) {
  const environment = hostEnvironment(document, {
    PRODUCT_FACE_APPLICATIONS: registry,
  });
  applyHostEnvironment({
    ...environment,
    WALLET_HOST_BUILD_CONFIGURATION_SHA256:
      build?.configuration ?? environment.WALLET_HOST_CONFIGURATION_SHA256,
    WALLET_HOST_BUILD_FACE_APPLICATIONS_SHA256: sha256Hex(registry),
  });
  process.env.SESSION_SECRET = brand.sessionSecret;
  process.env.FACE_ASSERTION_SIGNING_KEY = brand.keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  process.env.FACE_ASSERTION_KEY_ID = brand.kid;
  resetWalletHostCache();
  return environment;
}

const readback = async () => (await readbackGET()).json();

/** The deployed host resolves exactly its own organisation, origin and faces. */
async function expectOwnHost(brand: Brand) {
  expect(await readback()).toMatchObject({
    brandId: brand.brandId,
    organizationId: brand.organizationId,
    origin: brand.origin,
    faces: [brand.slug],
    status: "active",
  });
  expect(productFaceEntries().map((entry) => entry.slug)).toEqual([brand.slug]);
}

// ---------------------------------------------------------------- browser

const SESSION_COOKIE = "smarttoken_viewer";

type Route<P> = (
  request: NextRequest,
  context: { params: Promise<P> },
) => Response | Promise<Response>;

interface Delivery {
  /** The address the request is sent to (by default the browser's own host). */
  at?: Address;
  /** Apply the response's cookies to this browser's jar (default true). */
  keep?: boolean;
}

/** One person's browser on one brand's host: its cookie jar and one face launch. */
class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    readonly brand: Brand,
    readonly party: Party,
    readonly launchId: string,
    jar?: Map<string, string>,
  ) {
    if (jar) {
      for (const [name, value] of jar) this.cookies.set(name, value);
      return;
    }
    const response = NextResponse.json({});
    expect(
      establishSession(
        response,
        {
          accessToken: jwt({
            org_id: brand.organizationId,
            sub: party.walletId,
            exp: Math.floor(clock / 1000) + 3600,
          }),
          refreshToken: jwt({ exp: Math.floor(clock / 1000) + 7200 }),
        } as unknown as LoginOut,
        {
          organizationId: brand.organizationId,
          subdomain: "*",
          host: brand.host,
        },
        "email",
      ),
    ).toBe(true);
    this.take(response);
  }

  /** The same browser and session, the face launched again (a new journal). */
  relaunch(launchId: string) {
    return new Browser(this.brand, this.party, launchId, this.cookies);
  }

  take(response: Response) {
    for (const cookie of (response as NextResponse).cookies.getAll()) {
      // Host-only: no cookie names a domain another host could share.
      expect([cookie.name, cookie.domain]).toEqual([cookie.name, undefined]);
      if (cookie.value) this.cookies.set(cookie.name, cookie.value);
      else this.cookies.delete(cookie.name);
    }
  }

  async send<P>(
    route: Route<P>,
    path: string,
    {
      method = "POST",
      body,
      params,
      headers = {},
      at = this.brand,
      keep = true,
    }: Delivery & {
      method?: "GET" | "POST";
      body?: unknown;
      params?: P;
      headers?: Record<string, string>;
    } = {},
  ) {
    const response = await route(
      new NextRequest(`${at.origin}${path}`, {
        method,
        headers: {
          host: at.host,
          origin: at.origin,
          cookie: Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; "),
          "x-dual-face-launch": this.launchId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve(params as P) },
    );
    if (keep) this.take(response);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  private route(path: string) {
    return `/api/faces/${this.brand.slug}${path}`;
  }

  private get params() {
    return { slug: this.brand.slug };
  }

  operations(body: Json) {
    return this.send(operationsPOST, this.route("/operations"), {
      body,
      params: this.params,
    });
  }

  list(delivery: Delivery = {}) {
    return this.send(operationsGET, this.route("/operations"), {
      method: "GET",
      params: this.params,
      ...delivery,
    });
  }

  status(operationId: string, delivery: Delivery = {}) {
    return this.send(statusGET, this.route(`/operations/${operationId}`), {
      method: "GET",
      params: { slug: this.brand.slug, operationId },
      ...delivery,
    });
  }

  mint(body: Json) {
    return this.send(assertionsPOST, this.route("/assertions"), {
      body,
      params: this.params,
    });
  }

  async select(objectId: string) {
    const selected = await this.send(selectionPOST, this.route("/selection"), {
      body: { object_id: objectId },
      params: this.params,
    });
    expect(selected.status).toBe(200);
    return String(selected.body.context_id);
  }

  settleProposal(body: Json) {
    return this.send(settleProposalPOST, this.route("/settle-proposal"), {
      body,
      params: this.params,
    });
  }

  transferProposal(body: Json) {
    return this.send(transferProposalPOST, this.route("/transfer-proposal"), {
      body,
      params: this.params,
    });
  }

  transferProgress(body: Json) {
    return this.send(transferProgressPOST, this.route("/transfer-progress"), {
      body,
      params: this.params,
    });
  }

  handover(ticket: string) {
    return this.send(handoverPOST, this.route("/handover"), {
      body: { ticket, kind: "accept" },
      params: this.params,
    });
  }

  context(task: string) {
    return this.send(
      contextGET,
      this.route(`/context?task=${encodeURIComponent(task)}`),
      { method: "GET", params: this.params },
    );
  }

  acceptOffer(delivery: Delivery = {}) {
    return this.send(acceptOfferPOST, this.route("/accept-offer"), {
      body: {},
      params: this.params,
      ...delivery,
    });
  }

  /** GET /recovery (proposed r20), with an optional sealed continuation. */
  recovery(continuation?: string, delivery: Delivery = {}) {
    const query = continuation
      ? `?continuation=${encodeURIComponent(continuation)}`
      : "";
    return this.send(recoveryGET, this.route(`/recovery${query}`), {
      method: "GET",
      params: this.params,
      ...delivery,
    });
  }

  /** POST /recovery/discovered (proposed r20): hand discovery tickets back. */
  recoveryDiscovered(body: Json, delivery: Delivery = {}) {
    return this.send(
      recoveryDiscoveredPOST,
      this.route("/recovery/discovered"),
      { body, params: this.params, ...delivery },
    );
  }

  /** POST /recovery/ack (proposed r20): acknowledge one proved outcome. */
  recoveryAck(body: Json, delivery: Delivery = {}) {
    return this.send(recoveryAckPOST, this.route("/recovery/ack"), {
      body,
      params: this.params,
      ...delivery,
    });
  }

  /** The executor's prepare or execute through /api/backend, face-bound (r18). */
  backend(
    path: ["ebus", "prepare" | "execute"],
    body: Json,
    operationId: string,
    delivery: Delivery = {},
  ) {
    return this.send(backendPOST, `/api/backend/${path.join("/")}`, {
      body,
      params: { path },
      headers: {
        "x-dual-face-slug": this.brand.slug,
        "x-dual-face-operation": operationId,
        "x-dual-face-wallet": this.party.walletId,
      },
      ...delivery,
    });
  }
}

const launchOf = (brand: Brand, who: string) =>
  `launch-${brand.tag}-${who}-`.padEnd(32, "0");

// ---------------------------------------------------------------- the face

/**
 * The face asks its host for one assertion, then makes its own runtime call
 * with it; the assertion is checked to be this host's, for this brand.
 */
async function faceCall(
  browser: Browser,
  kind: RuntimeKind,
  request: {
    operation: string;
    operationId: string;
    target: Json;
    input?: Json;
    contextId?: string;
  },
) {
  const { brand } = browser;
  const input = request.input ?? {};
  const authorised = await browser.mint({
    operation: request.operation,
    operation_id: request.operationId,
    target: request.target,
    request_hash: hashOf(
      request.operation,
      request.operationId,
      request.target,
      input,
    ),
    ...(request.contextId ? { context_id: request.contextId } : {}),
  });
  expect([request.operation, authorised.status]).toEqual([
    request.operation,
    200,
  ]);
  const assertion = String(authorised.body.assertion);
  expect(headerOf(assertion).kid).toBe(brand.kid);
  expect(claimsOf(assertion)).toMatchObject({
    iss: brand.origin,
    aud: runtimeOf(brand).audience(kind),
    app_id: brand.applicationId,
    programme: brand.programmeId,
    // The wallet mints the holder in lowercase, whatever case the API wrote.
    holder: browser.party.address.toLowerCase(),
    operation: request.operation,
    op_id: request.operationId,
  });
  const answer = await runtimeOf(brand).fromFace(kind, {
    operation: request.operation,
    operationId: request.operationId,
    target: request.target,
    input,
    assertion,
  });
  return { assertion, answer };
}

/** Journal begin and the wallet's own confirmation of one runtime write. */
async function confirmedWrite(
  browser: Browser,
  contextId: string,
  operation: string,
  operationId: string,
  caseId?: string,
) {
  const step = { operation_id: operationId, context_id: contextId };
  const begun = await browser.operations({
    transition: "begin",
    kind: "runtime",
    operation,
    object_id: browser.brand.unit.id,
    ...(caseId ? { case_id: caseId } : {}),
    ...step,
  });
  expect([operation, begun.status]).toEqual([operation, 200]);
  expect(
    (await browser.operations({ transition: "confirm", ...step })).status,
  ).toBe(200);
  return begun.body;
}

/** The holder's registration: journalled, confirmed, its one assertion, submitted. */
async function issueRegistration(holder: Browser) {
  const { brand } = holder;
  const operationId = `register-${brand.tag}-0001`;
  const target = { object_id: brand.unit.id };
  const input = { record_id: brand.unit.recordId };
  expect(
    await holder.operations({
      transition: "begin",
      kind: "registration",
      operation: "registration.submit",
      operation_id: operationId,
      object_id: brand.unit.id,
      record_id: brand.unit.recordId,
      request_hash: hashOf("registration.submit", operationId, target, input),
    }),
  ).toMatchObject({
    status: 200,
    body: { operation: { phase: "confirming" } },
  });
  expect(
    await holder.operations({
      transition: "confirm",
      operation_id: operationId,
    }),
  ).toMatchObject({ status: 200, body: { operation: { phase: "confirmed" } } });
  const submitted = await faceCall(holder, "passport", {
    operation: "registration.submit",
    operationId,
    target,
    input,
  });
  expect(submitted.answer).toMatchObject({
    status: 202,
    body: { status: "ownership_moved_state_pending" },
  });
  return { operationId, assertion: submitted.assertion };
}

/** The wallet's own settle proposal, journalled and confirmed, reserved: won. */
async function settleWon(
  browser: Browser,
  registrationOperation: string,
  settleOperation: string,
) {
  const { unit } = browser.brand;
  const contextId = await browser.select(unit.id);
  const read = await browser.settleProposal({
    context_id: contextId,
    operation_id: registrationOperation,
    object_id: unit.id,
  });
  expect(read).toMatchObject({
    status: 200,
    body: {
      proposal: {
        operation_id: registrationOperation,
        object_id: unit.id,
        action: "update",
      },
    },
  });
  const step = { operation_id: settleOperation, context_id: contextId };
  expect(
    (
      await browser.operations({
        transition: "begin",
        kind: "settle",
        operation: "update",
        object_id: unit.id,
        proposal_id: read.body.proposal.proposal_id,
        ...step,
      })
    ).status,
  ).toBe(200);
  expect(
    (await browser.operations({ transition: "confirm", ...step })).status,
  ).toBe(200);
  expect(
    await browser.operations({ transition: "submit", ...step }),
  ).toMatchObject({
    status: 200,
    body: { reservation: "won", operation: { phase: "submitted" } },
  });
  return {
    contextId,
    action: { update: { id: unit.id, ...read.body.proposal.input } } as Json,
  };
}

/** One G8 step read by the wallet itself, journalled, confirmed, reserved: won. */
async function transferStepWon(
  holder: Browser,
  contextId: string,
  offerId: string,
  operationId: string,
  expected: "request" | "transfer",
) {
  const { unit } = holder.brand;
  const read = await holder.transferProposal({
    context_id: contextId,
    object_id: unit.id,
    offer_id: offerId,
  });
  expect(read).toMatchObject({
    status: 200,
    body: {
      proposal: {
        step: expected,
        offer_id: offerId,
        object_id: unit.id,
        recipient: holder.brand.recipient.address,
      },
    },
  });
  const step = { operation_id: operationId, context_id: contextId };
  expect(
    (
      await holder.operations({
        transition: "begin",
        kind: "transfer",
        operation:
          expected === "request" ? "transfer.request" : "transfer.transfer",
        object_id: unit.id,
        proposal_id: read.body.proposal.proposal_id,
        offer_id: offerId,
        ...step,
      })
    ).status,
  ).toBe(200);
  expect(
    (await holder.operations({ transition: "confirm", ...step })).status,
  ).toBe(200);
  expect(
    await holder.operations({ transition: "submit", ...step }),
  ).toMatchObject({ status: 200, body: { reservation: "won" } });
  const action = expected === "request" ? "update" : "transfer";
  return { [action]: { id: unit.id, ...read.body.proposal.input } } as Json;
}

/** The holder's won step, prepared and executed through /api/backend, recorded. */
async function executeStep(
  browser: Browser,
  operationId: string,
  action: Json,
  delivery: Delivery = {},
) {
  const prepared = await browser.backend(
    ["ebus", "prepare"],
    { action },
    operationId,
    delivery,
  );
  expect(prepared).toMatchObject({ status: 200, body: { challenge: "AQID" } });
  const executed = await browser.backend(
    ["ebus", "execute"],
    {
      action,
      nonce: prepared.body.nonce,
      auth: { type: "webauthn", challenge: "AQID", credentialId: "c-1" },
    },
    operationId,
    delivery,
  );
  expect(executed.status).toBe(200);
  const actionId = String(executed.body.action_id);
  expect(
    (
      await browser.operations({
        transition: "record_action",
        operation_id: operationId,
        action_id: actionId,
      })
    ).status,
  ).toBe(200);
  return actionId;
}

/** The holder offers; the recipient opens the link on the same host and accepts. */
async function offerAccepted(
  holder: Browser,
  recipient: Browser,
  contextId: string,
) {
  const { brand } = holder;
  const product = { object_id: brand.unit.id };
  const offerOperation = `offer-${brand.tag}-0001`;
  await confirmedWrite(holder, contextId, "transfer.offer", offerOperation);
  const offered = await faceCall(holder, "passport", {
    operation: "transfer.offer",
    operationId: offerOperation,
    target: product,
    contextId,
  });
  expect(offered.answer).toMatchObject({
    status: 200,
    body: { status: "transfer_offered" },
  });
  const offerId = String(offered.answer.body.offer_id);
  const ticket = String(offered.answer.body.acceptance_ticket);
  expect(await recipient.handover(ticket)).toMatchObject({
    status: 200,
    body: { next: `/products/${brand.slug}/accept` },
  });
  expect(await recipient.context("/accept")).toMatchObject({
    status: 200,
    body: { acceptance: { ticket } },
  });
  expect(await recipient.acceptOffer()).toMatchObject({
    status: 200,
    body: { unit: { objectId: brand.unit.id, name: brand.unit.name } },
  });
  const acceptOperation = `accept-${brand.tag}-0001`;
  const accepted = await faceCall(recipient, "passport", {
    operation: "transfer.accept",
    operationId: acceptOperation,
    target: product,
    input: { acceptance_ticket: ticket },
  });
  expect(accepted.answer).toMatchObject({
    status: 200,
    body: { status: "transfer_accepted", offer_id: offerId },
  });
  return {
    offerId,
    acceptOperation,
    offerAssertion: offered.assertion,
    acceptAssertion: accepted.assertion,
  };
}

// ------------------------------------------------------------- isolation

interface Evidence {
  /** Operation ids this browser's journal holds on its own host. */
  operations: string[];
  /** Assertions its host minted, and the runtime each was for. */
  assertions: Array<[RuntimeKind, string]>;
}

/**
 * Everything one brand's host handed this browser, presented to the OTHER
 * brand's host (deployed with its own environment and secrets): nothing of
 * it is served there, nothing is minted there, and the other brand's
 * runtimes refuse its assertions.
 */
async function nothingCrossesTo(
  other: Brand,
  from: Browser,
  evidence: Evidence,
) {
  const { brand } = from;
  const mints = minted.mock.calls.length;
  const calls = runtimeOf(other).calls.length;
  deploy(other);
  try {
    await expectOwnHost(other);
    const elsewhere = { at: other, keep: false };
    // The session cookie: another key, organisation and host.
    expect(
      (
        await from.send(sessionGET, "/api/session", {
          method: "GET",
          ...elsewhere,
        })
      ).status,
    ).toBe(401);
    // This brand's face slug and programme are not the other host's, though
    // its registry holds them.
    expect(
      await from.send(selectionPOST, `/api/faces/${brand.slug}/selection`, {
        body: { object_id: brand.unit.id },
        params: { slug: brand.slug },
        ...elsewhere,
      }),
    ).toMatchObject({ status: 404, body: { code: "unknown_application" } });
    // On the other host's own face this session is no session.
    expect(
      await from.send(assertionsPOST, `/api/faces/${other.slug}/assertions`, {
        body: {
          operation: "products.private.read",
          operation_id: `private-${brand.tag}-0009`,
          target: { object_id: other.unit.id },
          request_hash: sha("x"),
          context_id: "c".repeat(24),
        },
        params: { slug: other.slug },
        ...elsewhere,
      }),
    ).toMatchObject({ status: 401, body: { code: "session_expired" } });
    // Its launch journal and acceptance cookies, carried under the same
    // launch id by the other host's own signed-in owner, read as nothing.
    const owner = new Browser(other, other.holder, from.launchId);
    for (const [name, value] of from.cookies) {
      if (name !== SESSION_COOKIE) owner.cookies.set(name, value);
    }
    expect(await owner.list({ keep: false })).toEqual({
      status: 200,
      body: { operations: [], retained: [] },
    });
    for (const operationId of evidence.operations) {
      expect(await owner.status(operationId, { keep: false })).toMatchObject({
        status: 404,
        body: { code: "unknown_operation" },
      });
    }
    if (from.cookies.has(FACE_ACCEPTANCE_COOKIE)) {
      expect(await owner.acceptOffer({ keep: false })).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
    }
    // The other host's request proxy answers this brand's address with 421.
    const misdirected = await proxy(
      new NextRequest(`${brand.origin}/api/faces/${brand.slug}/operations`, {
        headers: { host: brand.host },
      }),
    );
    expect(misdirected.status).toBe(421);
    // Nothing was minted there, and the other brand's runtimes were not asked.
    expect(minted.mock.calls.length).toBe(mints);
    expect(runtimeOf(other).calls.length).toBe(calls);
  } finally {
    deploy(brand);
  }
  // Every assertion this host minted names this host, its face and programme,
  // and verifies only under its own key: the other brand's runtimes refuse it.
  for (const [kind, assertion] of evidence.assertions) {
    expect(headerOf(assertion).kid).toBe(brand.kid);
    expect(claimsOf(assertion)).toMatchObject({
      iss: brand.origin,
      app_id: brand.applicationId,
      programme: brand.programmeId,
      origin: brand.faceOrigin,
    });
    expect(runtimeOf(brand).recognises(kind, assertion)).toBe(true);
    expect(runtimeOf(other).recognises(kind, assertion)).toBe(false);
  }
}

// ------------------------------------------------------------------ setup

const originalFetch = global.fetch;
const originalSessionSecret = process.env.SESSION_SECRET;
let now: jest.SpyInstance;
beforeEach(() => {
  clock = Date.now();
  now = jest.spyOn(Date, "now").mockImplementation(() => clock);
  resetIssueGuard();
  minted.mockReset();
  newWorld();
  getWallet
    .mockReset()
    .mockImplementation(async (token?: string) => world.dual.wallet(token));
  getObjectById
    .mockReset()
    .mockImplementation(async (_token: string | undefined, objectId: string) =>
      world.dual.object(objectId),
    );
  getObjectByIdPublic
    .mockReset()
    .mockImplementation(async (objectId: string) =>
      world.dual.object(objectId),
    );
});
afterEach(() => {
  now.mockRestore();
  global.fetch = originalFetch;
  clearHostEnvironment();
  resetWalletHostCache();
  process.env.SESSION_SECRET = originalSessionSecret;
  delete process.env.FACE_ASSERTION_KEY_ID;
  delete process.env.FACE_ASSERTION_SIGNING_KEY;
});

// ------------------------------------------------------------------ tests

describe("two complete branded apps on one engine", () => {
  it.each([
    [MORROW.label, "the deployed runtimes", MORROW, TIDEWELL, false],
    [TIDEWELL.label, "the deployed runtimes", TIDEWELL, MORROW, false],
    [MORROW.label, "the PROPOSED r20 runtime fixture", MORROW, TIDEWELL, true],
    [
      TIDEWELL.label,
      "the PROPOSED r20 runtime fixture",
      TIDEWELL,
      MORROW,
      true,
    ],
  ] as Array<[string, string, Brand, Brand, boolean]>)(
    "%s with %s: registration, private details, Warranty & Service, transfer and the recipient's registration, all on its own host; nothing crosses to the other brand's",
    async (_label, _mode, brand, other, r20) => {
      runtimeOf(brand).r20 = r20;
      const { unit } = brand;
      const product = { object_id: unit.id };
      deploy(brand);
      await expectOwnHost(brand);
      const holder = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "holder"),
      );
      const evidence: Evidence = { operations: [], assertions: [] };

      // Passport registration: issued, submitted by the face, settled on the
      // wallet through the face-bound executor, registered.
      const registration = await issueRegistration(holder);
      evidence.operations.push(registration.operationId);
      evidence.assertions.push(["passport", registration.assertion]);
      expect(await holder.status(registration.operationId)).toMatchObject({
        status: 200,
        body: {
          status: "ownership_moved_state_pending",
          readback: { owner_is_you: true, state: "Transfer pending" },
        },
      });
      const settleOperation = `settle-${brand.tag}-0001`;
      const settle = await settleWon(
        holder,
        registration.operationId,
        settleOperation,
      );
      const contextId = settle.contextId;
      await executeStep(holder, settleOperation, settle.action);
      evidence.operations.push(settleOperation);
      expect(await holder.status(settleOperation)).toMatchObject({
        status: 200,
        body: { kind: "settle", status: "registered" },
      });
      expect(await holder.status(registration.operationId)).toMatchObject({
        status: 200,
        body: { kind: "registration", status: "registered" },
      });
      const verified = await faceCall(holder, "passport", {
        operation: "registration.settle.verify",
        operationId: `verify-${brand.tag}-0001`,
        target: product,
        input: { settle_operation_id: settleOperation },
        contextId,
      });
      expect(verified.answer).toMatchObject({
        status: 200,
        body: { status: "registered" },
      });
      await nothingCrossesTo(other, holder, evidence);

      // My products: the private details.
      advance();
      const details = await faceCall(holder, "passport", {
        operation: "products.private.read",
        operationId: `private-${brand.tag}-0001`,
        target: product,
        contextId,
      });
      expect(details.answer).toMatchObject({
        status: 200,
        body: { product: { object_id: unit.id } },
      });

      // Warranty & Service on this brand's own linked Warranty runtime: the
      // list and read, the case writes (each journalled and confirmed first)
      // and both quote decisions on the quote the wallet read itself.
      advance();
      const [first, second] = brand.cases;
      const listed = await faceCall(holder, "warranty", {
        operation: "cases.list",
        operationId: `cases-${brand.tag}-0001`,
        target: product,
        contextId,
      });
      expect(listed.answer).toMatchObject({
        status: 200,
        body: {
          cases: [
            { case_id: first, status: "prepared" },
            { case_id: second, status: "open" },
          ],
        },
      });
      const read = await faceCall(holder, "warranty", {
        operation: "case.read",
        operationId: `case-read-${brand.tag}-0001`,
        target: { ...product, case_id: first },
        contextId,
      });
      expect(read.answer).toMatchObject({
        status: 200,
        body: { case: { case_id: first, status: "prepared" } },
      });
      evidence.assertions.push(["warranty", read.assertion]);
      const writes: Array<[string, Json]> = [
        ["case.open", {}],
        ["case.evidence.submit", { evidence_ref: `upload-${brand.tag}-0001` }],
        ["case.information.provide", { answer: "Bought in September." }],
      ];
      for (const [index, [operation, input]] of writes.entries()) {
        const operationId = `case-write-${brand.tag}-000${index + 1}`;
        await confirmedWrite(holder, contextId, operation, operationId, first);
        const written = await faceCall(holder, "warranty", {
          operation,
          operationId,
          target: { ...product, case_id: first },
          input,
          contextId,
        });
        expect([operation, written.answer.status]).toEqual([operation, 200]);
      }
      const decisions: Array<[string, string, number]> = [
        ["case.quote.approve", first, 2],
        ["case.quote.decline", second, 1],
      ];
      for (const [index, [operation, caseId, version]] of decisions.entries()) {
        const operationId = `quote-${brand.tag}-000${index + 1}`;
        const begun = await confirmedWrite(
          holder,
          contextId,
          operation,
          operationId,
          caseId,
        );
        expect(begun.quote).toMatchObject({
          case_id: caseId,
          quote_version: version,
          provider: `${brand.label} Service Centre`,
        });
        const decided = await faceCall(holder, "warranty", {
          operation,
          operationId,
          target: {
            ...product,
            case_id: caseId,
            quote_version: begun.quote.quote_version,
            amount: begun.quote.amount,
            currency: begun.quote.currency,
          },
          contextId,
        });
        expect([operation, decided.answer.status]).toEqual([operation, 200]);
      }
      expect(
        [...runtimeOf(brand).cases.values()].map((item) => [
          item.status,
          item.evidence,
          item.information,
          item.decision,
        ]),
      ).toEqual([
        ["open", 1, 1, "approved"],
        ["open", 0, 0, "declined"],
      ]);

      // Transfer: the offer, the recipient's acceptance on the same host, the
      // request step and the custody step, each read by the wallet itself,
      // reserved and executed once.
      // This launch's journal now holds its bound (JOURNAL_MAX_ENTRIES): one
      // settled step and five Warranty & Service writes whose authority left
      // the wallet, which are kept and never make room unproven.
      advance();
      expect(
        (await holder.list()).body.operations.map(
          (item: { kind: string; phase: string }) => [item.kind, item.phase],
        ),
      ).toEqual([
        ["settle", "settled"],
        ...Array(5).fill(["runtime", "assertion_issued"]),
      ]);
      // The deployed runtimes record no write outcome: one more step can
      // begin (the settled one makes room); the next is refused journal_full.
      // The wallet asks the runtime for the two oldest held writes'
      // outcomes (write.status, proposed r20); the deployed runtime does not
      // know that read, so nothing is proven, nothing is evicted and no write
      // is sent again. The host offers "Restart the application", and the
      // transfer continues in a new launch. Under the r20 fixture the same
      // launch continues: a begin that finds no room reads the oldest held
      // writes, and only an exact verified record of one frees its slot.
      const room = (operationId: string) =>
        holder.operations({
          transition: "begin",
          kind: "runtime",
          operation: "case.open",
          object_id: unit.id,
          case_id: first,
          operation_id: operationId,
          context_id: contextId,
        });
      const writesSent = () =>
        runtimeOf(brand)
          .calls.filter(
            (call) =>
              call.by === "face" && WRITE_OPERATIONS.has(call.operation),
          )
          .map((call) => call.operationId);
      const sentBefore = writesSent();
      if (!r20) {
        expect((await room(`case-write-${brand.tag}-0004`)).status).toBe(200);
        const mintsBeforeFull = minted.mock.calls.length;
        const callsBeforeFull = runtimeOf(brand).calls.length;
        expect(await room(`case-write-${brand.tag}-0005`)).toMatchObject({
          status: 409,
          body: { code: "journal_full" },
        });
        expect(
          minted.mock.calls
            .slice(mintsBeforeFull)
            .map(([input]) => (input as { operation: string }).operation),
        ).toEqual(["write.status", "write.status"]);
        expect(
          runtimeOf(brand)
            .calls.slice(callsBeforeFull)
            .map((call) => [call.by, call.operation, call.status]),
        ).toEqual([
          ["wallet", "write.status", 400],
          ["wallet", "write.status", 400],
        ]);
        expect(
          (await holder.list()).body.operations.filter(
            (item: { phase: string }) => item.phase === "assertion_issued",
          ),
        ).toHaveLength(5);
      }
      const seller = r20 ? holder : holder.relaunch(launchOf(brand, "seller"));
      const saleContext = await seller.select(unit.id);
      const recipient = new Browser(
        brand,
        brand.recipient,
        launchOf(brand, "recipient"),
      );
      const offer = await offerAccepted(seller, recipient, saleContext);
      evidence.assertions.push(["passport", offer.offerAssertion]);
      const requestOperation = `xfer-request-${brand.tag}-0001`;
      await executeStep(
        seller,
        requestOperation,
        await transferStepWon(
          seller,
          saleContext,
          offer.offerId,
          requestOperation,
          "request",
        ),
      );
      expect(
        await seller.transferProgress({ operation_id: requestOperation }),
      ).toMatchObject({
        status: 200,
        body: { status: "transfer_request_committed", step: "request" },
      });
      const custodyOperation = `xfer-custody-${brand.tag}-0001`;
      await executeStep(
        seller,
        custodyOperation,
        await transferStepWon(
          seller,
          saleContext,
          offer.offerId,
          custodyOperation,
          "transfer",
        ),
      );
      expect(
        await seller.transferProgress({ operation_id: custodyOperation }),
      ).toMatchObject({
        status: 200,
        body: { status: "transferred", step: "transfer" },
      });
      evidence.operations.push(requestOperation, custodyOperation);
      expect(world.dual.units.get(unit.id)).toMatchObject({
        owner: brand.recipient.address,
        custom: { state: "Transfer pending" },
      });
      if (r20) {
        // One launch carried the whole journey. Every face write was sent
        // exactly once (none by the wallet, none twice); slots were freed
        // only by the runtime's verified write.status answers, and every
        // write still unproven is held in this launch's journal.
        const sent = writesSent();
        expect(new Set(sent).size).toBe(sent.length);
        expect(sent.slice(0, sentBefore.length)).toEqual(sentBefore);
        expect(sent).toContain(`offer-${brand.tag}-0001`);
        const reads = runtimeOf(brand).calls.filter(
          (call) => call.operation === "write.status",
        );
        expect(reads.length).toBeGreaterThan(0);
        expect(
          reads.every((call) => call.by === "wallet" && call.status === 200),
        ).toBe(true);
        const journal = (await seller.list()).body.operations as Array<{
          operation_id: string;
          kind: string;
          phase: string;
        }>;
        expect(journal).toHaveLength(6);
        // A settled step is a finished entry: it may already have made room.
        const steps = journal.filter((item) => item.kind === "transfer");
        expect(steps.every((item) => item.phase === "settled")).toBe(true);
        expect(steps.map((item) => item.operation_id)).toContain(
          custodyOperation,
        );
        for (const item of journal.filter(
          (entry) => entry.kind === "runtime",
        )) {
          // Each runtime write left in the journal is either still held
          // or was settled by a verified read of exactly that write.
          expect(
            item.phase === "assertion_issued" ||
              (item.phase === "settled" &&
                reads.some((call) => call.operationId === item.operation_id)),
          ).toBe(true);
        }
      }

      // The recipient settles on its own wallet: registered.
      advance();
      const recipientSettle = `settle-${brand.tag}-0002`;
      const settled = await settleWon(
        recipient,
        offer.acceptOperation,
        recipientSettle,
      );
      await executeStep(recipient, recipientSettle, settled.action);
      expect(await recipient.status(recipientSettle)).toMatchObject({
        status: 200,
        body: { kind: "settle", status: "registered" },
      });
      const confirmed = await faceCall(recipient, "passport", {
        operation: "registration.settle.verify",
        operationId: `verify-${brand.tag}-0002`,
        target: product,
        input: { settle_operation_id: recipientSettle },
        contextId: settled.contextId,
      });
      expect(confirmed.answer).toMatchObject({
        status: 200,
        body: { status: "registered" },
      });
      expect(world.dual.units.get(unit.id)).toMatchObject({
        owner: brand.recipient.address,
        custom: { state: "Authenticity verified" },
      });

      // Throughout, nothing of this host crosses to the other brand's.
      await nothingCrossesTo(other, seller, evidence);
      await nothingCrossesTo(other, recipient, {
        operations: [recipientSettle],
        assertions: [
          ["passport", offer.acceptAssertion],
          ["passport", confirmed.assertion],
        ],
      });
      // Each step ran once (under the r20.1 fixture the case.open also made
      // its two intended Dual actions, the service account's, never the
      // holder's); this brand's runtimes refused nothing of its own host,
      // and the other brand's runtimes and unit were never touched.
      expect(world.dual.executed.map((action) => action.name)).toEqual(
        r20
          ? ["update", "mint", "update", "update", "transfer", "update"]
          : ["update", "update", "transfer", "update"],
      );
      expect(
        world.dual.executed
          .filter((action) => action.account === SERVICE_ACCOUNT)
          .map((action) => action.name),
      ).toEqual(r20 ? ["mint", "update"] : []);
      expect(runtimeOf(brand).refused).toEqual([]);
      expect(runtimeOf(brand).violations).toEqual([]);
      expect(runtimeOf(other).calls).toEqual([]);
      expect(world.dual.units.get(other.unit.id)).toMatchObject({
        owner: other.issuer,
        custom: { state: "Issued" },
      });
    },
  );
});

// ------------------------------------------------- update and rollback

/**
 * N+1: what Studio may emit for the same host (walletHostUpgradeCompatibility:
 * the same schema, brand, organisation and origin, and a higher
 * configVersion); here new copy, navigation order and brand colour.
 */
function nextRelease(brand: Brand) {
  const document = brand.document();
  const [major, minor] = String(document.release.configVersion)
    .split(".")
    .map(Number);
  edit(document, "release.configVersion", `${major}.${minor + 1}.0`);
  edit(
    document,
    "home.introduction",
    "Register, service and pass on what you own, all in one place.",
  );
  edit(
    document,
    "navigation",
    [...(document.navigation as string[])].reverse(),
  );
  edit(document, "identity.colours.brand", "#2a6f50");
  return document;
}

/** Under configuration N: registered by the face, its settle won and not yet executed. */
async function settlePending(holder: Browser) {
  const registration = await issueRegistration(holder);
  const settleOperation = `settle-${holder.brand.tag}-0001`;
  const settle = await settleWon(
    holder,
    registration.operationId,
    settleOperation,
  );
  return { registration: registration.operationId, settleOperation, settle };
}

const runtimeCalls = (brand: Brand, operation: string) =>
  runtimeOf(brand).calls.filter((call) => call.operation === operation).length;

describe("one engine, a host's configuration updated and rolled back", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: what was sealed under N continues under N+1 and again under N; nothing is re-signed or re-sent",
    async (_label, brand) => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const release = deploy(brand);
      const holder = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "holder"),
      );
      const { registration, settleOperation, settle } =
        await settlePending(holder);
      const sealed = new Map(holder.cookies);
      const next = nextRelease(brand);

      // N+1 served by the N build (not rebuilt): build_mismatch, 503 on every
      // face route and the face-bound executor; nothing is minted or sent.
      const mints = minted.mock.calls.length;
      deploy(brand, {
        document: next,
        build: { configuration: release.WALLET_HOST_CONFIGURATION_SHA256! },
      });
      expect(await readback()).toMatchObject({
        status: "invalid",
        configurationSha256:
          hostEnvironment(next).WALLET_HOST_CONFIGURATION_SHA256,
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("(build_mismatch)"),
      );
      expect(await holder.list({ keep: false })).toMatchObject({
        status: 503,
        body: { code: "host_unavailable" },
      });
      expect(
        await holder.backend(
          ["ebus", "prepare"],
          { action: settle.action },
          settleOperation,
          { keep: false },
        ),
      ).toMatchObject({ status: 503, body: { code: "host_unavailable" } });
      expect(minted.mock.calls.length).toBe(mints);
      expect(world.dual.ebus).toEqual([]);

      // N+1, built: an engine-compatible update with the same secrets.
      const updated = deploy(brand, { document: next });
      expect(updated.WALLET_HOST_CONFIGURATION_SHA256).not.toBe(
        release.WALLET_HOST_CONFIGURATION_SHA256,
      );
      expect(await readback()).toMatchObject({
        brandId: brand.brandId,
        organizationId: brand.organizationId,
        origin: brand.origin,
        configurationSha256: updated.WALLET_HOST_CONFIGURATION_SHA256,
        configVersion: next.release.configVersion,
        status: "active",
      });
      // The session and the launch journal sealed under N are this host's.
      expect(holder.cookies).toEqual(sealed);
      expect(await holder.list()).toMatchObject({
        status: 200,
        body: {
          operations: [
            { operation_id: registration, phase: "assertion_issued" },
            { operation_id: settleOperation, phase: "submitted" },
          ],
        },
      });
      // The settle won under N executes under N+1, once, and registers.
      await executeStep(holder, settleOperation, settle.action);
      expect(await holder.status(settleOperation)).toMatchObject({
        status: 200,
        body: { status: "registered" },
      });
      expect(await holder.status(registration)).toMatchObject({
        status: 200,
        body: { status: "registered", phase: "settled" },
      });
      // Under N+1: the offer, the recipient's acceptance and the request
      // step, won and not yet executed.
      advance();
      const recipient = new Browser(
        brand,
        brand.recipient,
        launchOf(brand, "recipient"),
      );
      const offer = await offerAccepted(holder, recipient, settle.contextId);
      const requestOperation = `xfer-request-${brand.tag}-0001`;
      const request = await transferStepWon(
        holder,
        settle.contextId,
        offer.offerId,
        requestOperation,
        "request",
      );
      const sealedNext = new Map(holder.cookies);

      // Rollback N+1 → N: the previous approved configuration, the same
      // secrets. What N+1 sealed is served by N: the request step executes
      // once and commits.
      const rolledBack = deploy(brand);
      expect(rolledBack.WALLET_HOST_CONFIGURATION_SHA256).toBe(
        release.WALLET_HOST_CONFIGURATION_SHA256,
      );
      expect(await readback()).toMatchObject({
        configurationSha256: release.WALLET_HOST_CONFIGURATION_SHA256,
        configVersion: brand.document().release.configVersion,
        status: "active",
      });
      expect(holder.cookies).toEqual(sealedNext);
      await executeStep(holder, requestOperation, request);
      expect(
        await holder.transferProgress({ operation_id: requestOperation }),
      ).toMatchObject({
        status: 200,
        body: { status: "transfer_request_committed", step: "request" },
      });
      // Settled entries answer from the journal: no runtime call.
      const calls = runtimeOf(brand).calls.length;
      expect(
        await holder.transferProgress({ operation_id: requestOperation }),
      ).toMatchObject({
        status: 200,
        body: { status: "transfer_request_committed" },
      });
      expect(await holder.list()).toMatchObject({
        status: 200,
        body: {
          operations: expect.arrayContaining([
            expect.objectContaining({
              operation_id: registration,
              phase: "settled",
            }),
            expect.objectContaining({
              operation_id: settleOperation,
              phase: "settled",
            }),
            expect.objectContaining({
              operation_id: requestOperation,
              phase: "settled",
            }),
          ]),
        },
      });
      expect(runtimeOf(brand).calls.length).toBe(calls);

      // Nothing was re-signed or re-sent across the update and the rollback:
      // one registration assertion and submission, one reserve per step, one
      // Dual execution per step.
      expect(
        minted.mock.calls.filter(
          ([input]) =>
            (input as { operation: string }).operation ===
            "registration.submit",
        ),
      ).toHaveLength(1);
      expect(runtimeCalls(brand, "registration.submit")).toBe(1);
      expect(runtimeCalls(brand, "registration.settle.reserve")).toBe(1);
      expect(runtimeCalls(brand, "transfer.reserve")).toBe(1);
      expect(world.dual.executed.map((action) => action.name)).toEqual([
        "update",
        "update",
      ]);
      expect(
        world.dual.ebus.filter((call) => call.path === "/ebus/execute"),
      ).toHaveLength(2);
      expect(runtimeOf(brand).refused).toEqual([]);
      consoleError.mockRestore();
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: another organisation, origin or face programme never serves what was sealed under N",
    async (_label, brand) => {
      deploy(brand);
      const holder = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "holder"),
      );
      const { registration, settleOperation, settle } =
        await settlePending(holder);
      const sealed = new Map(holder.cookies);
      const mints = minted.mock.calls.length;
      const calls = runtimeOf(brand).calls.length;

      const organisation = nextRelease(brand);
      edit(organisation, "entrance.organizationId", "c3c3c3c3c3c3c3c3c3c3c3c3");
      const origin = brand.origin.replace("://wallet.", "://wallet-next.");
      const moved = nextRelease(brand);
      edit(moved, "entrance.origin", origin);
      // The face slug now names another programme (Studio refuses that
      // publication as programme_changed; here it is deployed regardless).
      const programme = JSON.stringify(
        [morrowBinding(), tidewellFullBinding()].map((binding) =>
          binding.slug === brand.slug
            ? { ...binding, programmeId: `${brand.programmeId}-next` }
            : binding,
        ),
      );
      const changes: Array<
        [
          string,
          { document: HostDocument; registry?: string; at: Address },
          "session" | "journal",
        ]
      > = [
        [
          "another organisation",
          { document: organisation, at: brand },
          "session",
        ],
        [
          "another origin",
          { document: moved, at: { origin, host: new URL(origin).host } },
          "session",
        ],
        [
          "another face programme",
          { document: nextRelease(brand), registry: programme, at: brand },
          "journal",
        ],
      ];
      for (const [label, change, refusal] of changes) {
        // Each is built and served as a host of its own...
        deploy(brand, { document: change.document, registry: change.registry });
        expect([label, (await readback()).status]).toEqual([label, "active"]);
        // ...that serves none of what N sealed. The browser's jar is left as
        // it was (keep: false) to show the refusals consume nothing.
        const delivery = { at: change.at, keep: false };
        const answers = [
          await holder.list(delivery),
          await holder.status(registration, delivery),
          await holder.backend(
            ["ebus", "execute"],
            { action: settle.action, nonce: 1 },
            settleOperation,
            delivery,
          ),
        ];
        if (refusal === "session") {
          expect(
            answers.map(({ status, body }) => [label, status, body.code]),
          ).toEqual([
            [label, 401, "session_expired"],
            [label, 401, "session_expired"],
            [label, 401, "session_expired"],
          ]);
        } else {
          expect(
            answers.map(({ status, body }) => [label, status, body]),
          ).toEqual([
            [label, 200, { operations: [], retained: [] }],
            [
              label,
              404,
              expect.objectContaining({ code: "unknown_operation" }),
            ],
            // The journal is sealed per programme, so N's settle is not
            // this programme's: a branded host's journey gate finds no
            // step to classify and refuses it before the execution
            // binding (or anything upstream) is reached.
            [
              label,
              403,
              expect.objectContaining({ code: "capability_not_granted" }),
            ],
          ]);
        }
        if (label === "another origin") {
          // While the entrance is moved, the address N served is no longer
          // an entrance (421), never the moved host's.
          const misdirected = await proxy(
            new NextRequest(
              `${brand.origin}/api/faces/${brand.slug}/operations`,
              { headers: { host: brand.host } },
            ),
          );
          expect([label, misdirected.status]).toEqual([label, 421]);
        }
      }
      // Nothing was minted, read from a runtime or sent to Dual for them.
      expect(minted.mock.calls.length).toBe(mints);
      expect(runtimeOf(brand).calls.length).toBe(calls);
      expect(world.dual.ebus).toEqual([]);

      // N again: the sealed state is intact and continues.
      deploy(brand);
      expect(holder.cookies).toEqual(sealed);
      await executeStep(holder, settleOperation, settle.action);
      expect(await holder.status(registration)).toMatchObject({
        status: 200,
        body: { status: "registered" },
      });
    },
  );
});

// ------------------------------------------- runtime write outcomes (r20)

// The wallet's consumer of the PROPOSED, NOT DEPLOYED runtime contract r20
// (docs/proposals/runtime-write-status-r20.md), against the labelled fixture
// above: a held Warranty & Service write frees its journal slot only from the
// runtime's verified record of exactly that write. Nothing else does, and no
// write is ever sent again by the wallet.

async function heldWrite(
  holder: Browser,
  contextId: string,
  n: number,
  {
    dispatch,
    operation = "case.evidence.submit",
    caseIndex = 0,
  }: {
    dispatch: boolean;
    operation?: string;
    caseIndex?: number;
  },
) {
  const { brand } = holder;
  const operationId = `case-write-${brand.tag}-${String(n).padStart(4, "0")}`;
  const caseId = brand.cases[caseIndex];
  const target = { object_id: brand.unit.id, case_id: caseId };
  const input =
    operation === "case.evidence.submit"
      ? { evidence_ref: `upload-${brand.tag}-${n}` }
      : {};
  await confirmedWrite(holder, contextId, operation, operationId, caseId);
  if (dispatch) {
    // The face sends it; its answer is lost to the wallet either way.
    const sent = await faceCall(holder, "warranty", {
      operation,
      operationId,
      target,
      input,
      contextId,
    });
    return { operationId, answer: sent.answer };
  }
  // Interrupted before dispatch: the assertion was issued, never used.
  const minted = await holder.mint({
    operation,
    operation_id: operationId,
    target,
    request_hash: hashOf(operation, operationId, target, input),
    context_id: contextId,
  });
  expect(minted.status).toBe(200);
  return { operationId, answer: undefined };
}

async function r20Holder(brand: Brand) {
  deploy(brand);
  runtimeOf(brand).r20 = true;
  const holder = new Browser(brand, brand.holder, launchOf(brand, "holder"));
  await issueRegistration(holder);
  const contextId = await holder.select(brand.unit.id);
  return { holder, contextId };
}

const faceWrites = (brand: Brand, operationId: string) =>
  runtimeOf(brand).calls.filter(
    (call) => call.by === "face" && call.operationId === operationId,
  ).length;
const statusReads = (brand: Brand, operationId: string) =>
  runtimeOf(brand)
    .calls.filter(
      (call) =>
        call.operation === "write.status" && call.operationId === operationId,
    )
    .map((call) => [call.by, call.status]);

describe("a runtime write's slot, freed only by its verified outcome (PROPOSED r20 fixture)", () => {
  // Root's compatibility decision: no unknown eviction. A launch cookie that
  // is a held write's only known correlation is never dropped by the launch
  // budget; a new launch beyond it is read-only. The cookie becomes
  // expendable only once the exact runtime confirms it holds the record.
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: four launches of writes interrupted before dispatch make a fifth read-only; one becomes expendable only when the runtime's actor-scoped listing names exactly that record (a 409 proves nothing), and nothing is sent again",
    async (_label, brand) => {
      const runtime = runtimeOf(brand);
      const { holder, contextId } = await r20Holder(brand);
      // One applied write, read once, lends the fixture this holder's exact
      // warranty actor for the seeded record below; it settles the entry.
      const applied = await heldWrite(holder, contextId, 21, {
        dispatch: true,
      });
      expect(await holder.status(applied.operationId)).toMatchObject({
        status: 200,
        body: { phase: "settled" },
      });
      const captured = runtime.writes.get(`warranty:${applied.operationId}`)!;
      const actor: Actor = {
        holder: captured.holder,
        sub: captured.wallet,
        iss: captured.issuer,
        aud: captured.audience,
        programme: captured.programme,
        artifact: captured.artifact,
      };
      // Four launches, each holding one write interrupted before dispatch:
      // no runtime has a record of any, so each cookie is its write's only
      // known correlation. Each launch is opened from the previous one's
      // browser state (the same browser, cookies accumulating).
      const launches: Browser[] = [holder];
      const held = [
        (await heldWrite(holder, contextId, 22, { dispatch: false }))
          .operationId,
      ];
      for (const n of [23, 24, 25]) {
        const launch = launches.at(-1)!.relaunch(launchOf(brand, `held${n}`));
        const selected = await launch.select(brand.unit.id);
        held.push(
          (await heldWrite(launch, selected, n, { dispatch: false }))
            .operationId,
        );
        launches.push(launch);
      }
      const names = launches.map((launch) =>
        faceJournalCookieName(launch.launchId),
      );
      // A fifth launch: read-only. Its context opens, a selection (the
      // first thing that would journal) is refused launch_capacity, no
      // cookie of it is written and none of the four is dropped.
      const fifth = launches.at(-1)!.relaunch(launchOf(brand, "fifth"));
      expect((await fifth.context("/")).status).toBe(200);
      expect(
        await fifth.send(selectionPOST, `/api/faces/${brand.slug}/selection`, {
          body: { object_id: brand.unit.id },
          params: { slug: brand.slug },
        }),
      ).toMatchObject({ status: 409, body: { code: "launch_capacity" } });
      for (const name of names) expect(fifth.cookies.has(name)).toBe(true);
      expect(fifth.cookies.has(faceJournalCookieName(fifth.launchId))).toBe(
        false,
      );
      expect(await fifth.status(held[1])).toMatchObject({ status: 404 });
      // FIXTURE: the runtime now holds a record under the second launch's
      // operation id whose outcome it cannot yet decide, but for ANOTHER
      // case. The second launch's own status read of its exact write finds
      // no such record (404): held, read once, never sent by the wallet.
      const recordedAt = new Date(Date.now()).toISOString();
      runtime.seedWriteRecord(actor, {
        operationId: held[1],
        operation: "case.evidence.submit",
        caseId: brand.cases[1],
        recordedAt,
        unresolved: 1,
      });
      const second = fifth.relaunch(launches[1].launchId);
      expect(await second.status(held[1])).toMatchObject({
        status: 200,
        body: { kind: "runtime", phase: "assertion_issued" },
      });
      expect(statusReads(brand, held[1])).toEqual([["wallet", 404]]);
      expect(faceWrites(brand, held[1])).toBe(0);
      const select = (launch: Browser) =>
        launch.send(selectionPOST, `/api/faces/${brand.slug}/selection`, {
          body: { object_id: brand.unit.id },
          params: { slug: brand.slug },
        });
      expect(await select(second.relaunch(fifth.launchId))).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      // The runtime's durable discovery names the id, but as a record of
      // another case: not this write's record, so the scan issues no ticket.
      const mismatched = await second.recovery();
      expect(mismatched).toMatchObject({
        status: 200,
        body: { supported: true, discovered: [] },
      });
      expect(
        (mismatched.body.items as Json[]).map((item) => item.operation_id),
      ).toContain(held[1]);
      expect(await select(second.relaunch(fifth.launchId))).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      // The record exactly as issued (FIXTURE: seeded again under the same
      // id, replacing the other). The second launch's own status read now
      // learns a 409 write_outcome_unknown: unbound (no echo), it proves
      // nothing, so the cookie stays undroppable.
      runtime.seedWriteRecord(actor, {
        operationId: held[1],
        operation: "case.evidence.submit",
        caseId: brand.cases[0],
        recordedAt,
        unresolved: 1,
      });
      expect(await second.status(held[1])).toMatchObject({
        status: 200,
        body: { kind: "runtime", phase: "assertion_issued" },
      });
      expect(statusReads(brand, held[1]).at(-1)).toEqual(["wallet", 409]);
      expect(await select(second.relaunch(fifth.launchId))).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      // FIXTURE: the runtime calls its scan incomplete (a store it could not
      // read to the end). Its page names the write exactly, yet an incomplete
      // discovery guarantees nothing: the cookie stays undroppable.
      runtime.incompleteScan = true;
      expect(await second.recovery()).toMatchObject({
        status: 200,
        body: { supported: true, complete: false, discovered: [] },
      });
      runtime.incompleteScan = false;
      // FIXTURE: a scan the wallet itself finds violated (a page echoing
      // another actor) names the write too; no ticket either.
      runtime.recoveryViolation = "wrong_echo";
      expect(await second.recovery()).toMatchObject({
        status: 200,
        body: { supported: true, complete: false, discovered: [] },
      });
      runtime.recoveryViolation = undefined;
      expect(await select(second.relaunch(fifth.launchId))).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      // The second launch's own complete scan of the runtime's actor-scoped
      // listing names its write exactly: one discovery ticket. The listing
      // itself writes nothing (the cookie is byte-for-byte what it was).
      const sealedBefore = second.cookies.get(names[1]);
      const listed = await second.recovery();
      expect(listed.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation_id: held[1],
            outcome: "outcome_unknown",
          }),
        ]),
      );
      expect(listed.body.discovered).toHaveLength(1);
      expect(second.cookies.get(names[1])).toBe(sealedBefore);
      expect(await select(second.relaunch(fifth.launchId))).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      // The ticket is this launch's: another launch handing it back marks
      // nothing (a read-only one is refused before that; a kept one finds
      // it sealed for the launch that listed, not itself).
      const third = second.relaunch(launches[2].launchId);
      expect(
        await third.recoveryDiscovered({ discovered: listed.body.discovered }),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      // Handed back by the listing launch: marked against its journal as it
      // is now. Only now is that one cookie expendable: the fifth launch
      // takes its place, exactly that cookie goes, the other three stay, and
      // nothing was sent again.
      expect(
        await second.recoveryDiscovered({
          discovered: listed.body.discovered,
        }),
      ).toMatchObject({ status: 200, body: { marked: 1 } });
      expect(second.cookies.get(names[1])).not.toBe(sealedBefore);
      const again = second.relaunch(fifth.launchId);
      expect(await select(again)).toMatchObject({ status: 200 });
      expect(again.cookies.has(names[1])).toBe(false);
      for (const name of [names[0], names[2], names[3]]) {
        expect(again.cookies.has(name)).toBe(true);
      }
      expect(again.cookies.has(faceJournalCookieName(again.launchId))).toBe(
        true,
      );
      expect(faceWrites(brand, held[1])).toBe(0);
      expect(runtime.writes.has(`warranty:${held[0]}`)).toBe(false);
    },
  );

  // A customer's Claims journey: each visit to the service page is a new
  // launch, and each sends one case write whose answer only the face sees.
  // The runtime holds every one durably, but only the launch that issued a
  // write could mark it discoverable, and that page is gone: four visits
  // pinned the budget, so the fifth opened read-only, its product selection
  // was refused launch_capacity, and the face reported the product as not
  // available. The next launch now asks the runtime first.
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: after four visits that each sent one case write, the next visit's context finds them in the runtime's complete listing, keeps its own cookie, makes room with only the oldest such launch, opens the product, and sends nothing again",
    async (_label, brand) => {
      const runtime = runtimeOf(brand);
      const { holder, contextId } = await r20Holder(brand);
      const launches: Browser[] = [holder];
      const sent = [
        (await heldWrite(holder, contextId, 41, { dispatch: true }))
          .operationId,
      ];
      for (const n of [42, 43, 44]) {
        const launch = launches.at(-1)!.relaunch(launchOf(brand, `visit${n}`));
        const selected = await launch.select(brand.unit.id);
        sent.push(
          (await heldWrite(launch, selected, n, { dispatch: true }))
            .operationId,
        );
        launches.push(launch);
      }
      const names = launches.map((launch) =>
        faceJournalCookieName(launch.launchId),
      );
      const select = (launch: Browser) =>
        launch.send(selectionPOST, `/api/faces/${brand.slug}/selection`, {
          body: { object_id: brand.unit.id },
          params: { slug: brand.slug },
        });
      // FIXTURE: while the runtime calls its scan incomplete, nothing is
      // discovered: the next visit stays read-only exactly as before, and
      // no cookie is written or dropped.
      runtime.incompleteScan = true;
      const pinned = launches.at(-1)!.relaunch(launchOf(brand, "visit45"));
      expect((await pinned.context("/")).status).toBe(200);
      expect(await select(pinned)).toMatchObject({
        status: 409,
        body: { code: "launch_capacity" },
      });
      expect(pinned.cookies.has(faceJournalCookieName(pinned.launchId))).toBe(
        false,
      );
      for (const name of names) expect(pinned.cookies.has(name)).toBe(true);
      runtime.incompleteScan = false;
      // The complete listing names the three writes the other launches
      // hold: the visit's context records them found and keeps its cookie.
      // Only the oldest launch whose writes are all found goes; the launch
      // holding the unsettled registration (signed evidence) and the two
      // newer ones stay.
      const visit = pinned.relaunch(pinned.launchId);
      expect((await visit.context("/")).status).toBe(200);
      expect(visit.cookies.has(faceJournalCookieName(visit.launchId))).toBe(
        true,
      );
      expect(visit.cookies.has(names[1])).toBe(false);
      for (const name of [names[0], names[2], names[3]]) {
        expect(visit.cookies.has(name)).toBe(true);
      }
      expect(await select(visit)).toMatchObject({ status: 200 });
      // Read-only throughout: one face dispatch per write, none by the
      // wallet, and no status read was needed.
      for (const operationId of sent) {
        expect(faceWrites(brand, operationId)).toBe(1);
        expect(statusReads(brand, operationId)).toEqual([]);
      }
      // The dropped launch's write is still the runtime's own record: the
      // visit's recovery listing still names it.
      const listed = await visit.recovery();
      expect(
        (listed.body.items as Json[]).map((item) => item.operation_id),
      ).toEqual(expect.arrayContaining(sent));
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a visit's ordinary recovery listing also hands back the writes other launches hold, recorded found in its own cookie only, so the budget never pins; another launch's ticket, or one for another case, records nothing",
    async (_label, brand) => {
      const runtime = runtimeOf(brand);
      const { holder, contextId } = await r20Holder(brand);
      const launches: Browser[] = [holder];
      const sent = [
        (await heldWrite(holder, contextId, 51, { dispatch: true }))
          .operationId,
      ];
      for (const n of [52, 53, 54]) {
        const launch = launches.at(-1)!.relaunch(launchOf(brand, `visit${n}`));
        const selected = await launch.select(brand.unit.id);
        sent.push(
          (await heldWrite(launch, selected, n, { dispatch: true }))
            .operationId,
        );
        launches.push(launch);
      }
      const names = launches.map((launch) =>
        faceJournalCookieName(launch.launchId),
      );
      const latest = launches[3];
      const others = [names[0], names[1], names[2]].map((name) =>
        latest.cookies.get(name),
      );
      // The latest visit's listing: its own write and the three the other
      // launches hold, one ticket each.
      const listed = await latest.recovery();
      expect(listed).toMatchObject({ status: 200, body: { supported: true } });
      expect(listed.body.discovered).toHaveLength(4);
      // Handed back by another launch: sealed for the listing launch, so
      // nothing is recorded.
      expect(
        await launches[2].recoveryDiscovered({
          discovered: listed.body.discovered,
        }),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      // Handed back by the listing launch: its own write marked, the three
      // others recorded found in its own cookie; their cookies are never
      // rewritten.
      expect(
        await latest.recoveryDiscovered({
          discovered: listed.body.discovered,
        }),
      ).toMatchObject({ status: 200, body: { marked: 4 } });
      expect(
        [names[0], names[1], names[2]].map((name) => latest.cookies.get(name)),
      ).toEqual(others);
      // A fifth visit now gets its cookie without any listing (FIXTURE: the
      // runtime's scan is incomplete, so the context discovers nothing
      // itself): the oldest launch holding only found writes makes room.
      runtime.incompleteScan = true;
      const fifth = latest.relaunch(launchOf(brand, "visit55"));
      expect((await fifth.context("/")).status).toBe(200);
      expect(fifth.cookies.has(faceJournalCookieName(fifth.launchId))).toBe(
        true,
      );
      expect(fifth.cookies.has(names[1])).toBe(false);
      for (const name of [names[0], names[2], names[3]]) {
        expect(fifth.cookies.has(name)).toBe(true);
      }
      runtime.incompleteScan = false;
      for (const operationId of sent) {
        expect(faceWrites(brand, operationId)).toBe(1);
      }
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: interrupted before or after dispatch, refused, or reused: only the applied write settles, and nothing is sent again",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);

      // Before dispatch: the runtime has no record; held, nothing sent.
      const before = await heldWrite(holder, contextId, 1, { dispatch: false });
      expect(await holder.status(before.operationId)).toMatchObject({
        status: 200,
        body: { kind: "runtime", phase: "assertion_issued" },
      });
      expect(statusReads(brand, before.operationId)).toEqual([["wallet", 404]]);
      expect(faceWrites(brand, before.operationId)).toBe(0);

      // After dispatch, its answer lost: the runtime's verified record
      // settles it, read once, and it was sent once.
      const after = await heldWrite(holder, contextId, 2, { dispatch: true });
      expect(after.answer).toMatchObject({ status: 200 });
      expect(await holder.status(after.operationId)).toMatchObject({
        status: 200,
        body: { kind: "runtime", phase: "settled" },
      });
      expect(await holder.status(after.operationId)).toMatchObject({
        status: 200,
        body: { phase: "settled" },
      });
      expect(statusReads(brand, after.operationId)).toEqual([["wallet", 200]]);
      expect(faceWrites(brand, after.operationId)).toBe(1);

      // Refused by the runtime (unapplied): its record says so; held.
      const refused = await heldWrite(holder, contextId, 3, {
        dispatch: true,
        operation: "case.open",
        caseIndex: 1,
      });
      expect(refused.answer).toMatchObject({ status: 409 });
      expect(await holder.status(refused.operationId)).toMatchObject({
        status: 200,
        body: { phase: "assertion_issued" },
      });
      expect(statusReads(brand, refused.operationId)).toEqual([
        ["wallet", 200],
      ]);

      // Reuse of an issued operation id: the wallet mints nothing for it.
      const reused = await holder.mint({
        operation: "case.evidence.submit",
        operation_id: after.operationId,
        target: { object_id: brand.unit.id, case_id: brand.cases[0] },
        request_hash: hashOf(
          "case.evidence.submit",
          after.operationId,
          { object_id: brand.unit.id, case_id: brand.cases[0] },
          { evidence_ref: "another" },
        ),
        context_id: contextId,
      });
      expect(reused.status).toBe(409);
      expect(faceWrites(brand, after.operationId)).toBe(1);
      expect(runtimeOf(brand).cases.get(brand.cases[0])!.evidence).toBe(1);
    },
  );

  type Tamper = [string, (runtime: BrandRuntime, body: Json) => Json];
  const field =
    (name: string, value: unknown): Tamper[1] =>
    (_runtime, body) => ({ ...body, [name]: value });
  const tampers: Tamper[] = [
    ["write_refused", field("status", "write_refused")],
    ["no r20 contract", field("contract", undefined)],
    ["a readback not verified", field("readback", "accepted")],
    ["an unresolved outcome", field("unknownWriteOutcomes", 1)],
    ...(
      ["writesExecuted", "dualWritesExecuted", "unknownWriteOutcomes"] as const
    ).flatMap((name): Tamper[] => [
      [`${name} 1`, field(name, 1)],
      [`${name} missing`, field(name, undefined)],
      [`${name} null`, field(name, null)],
      [`${name} "0"`, field(name, "0")],
      [`${name} -0.5`, field(name, -0.5)],
    ]),
    ["secretReturned true", field("secretReturned", true)],
    ["secretReturned missing", field("secretReturned", undefined)],
    ["no artifact compatibility proof", field("artifact_compatible", false)],
    ["another operation id", field("operation_id", "case-write-zz-9999")],
    ["another operation", field("operation", "case.information.provide")],
    [
      "another unit",
      (_runtime, body) => ({
        ...body,
        target: { ...(body.target as Json), object_id: "c".repeat(24) },
      }),
    ],
    [
      "another case",
      (runtime, body) => ({
        ...body,
        target: {
          ...(body.target as Json),
          case_id: runtime.brand.cases[1],
        },
      }),
    ],
    ["another request", field("request_hash", `sha256:${"d".repeat(64)}`)],
    ["another holder", field("holder", "0x" + "e".repeat(40))],
    ["another wallet", field("wallet", "wallet-foreign")],
    ["another host", field("issuer", "https://wallet.foreign.example")],
    ["another application", field("application_id", "tig.claims.foreign")],
    ["another programme", field("programme", "foreign-programme")],
    [
      "another asserting artifact",
      field("asserting_artifact", {
        version: "9.9.9",
        artifactHash: `sha256:${"f".repeat(64)}`,
      }),
    ],
    [
      "a transfer receipt for a case write",
      field("receipt", {
        kind: "transfer_offer",
        offer_id: `pto-${"0".repeat(24)}`,
        state: "offered",
      }),
    ],
    [
      "another case's receipt",
      (runtime, body) => ({
        ...body,
        receipt: {
          kind: "case_event",
          case_id: runtime.brand.cases[1],
          event_id: "case-event-1",
        },
      }),
    ],
    ["no receipt", field("receipt", null)],
  ];

  it.each(
    BRANDS.flatMap((brand) =>
      tampers.map(([label, tamper]) => [brand.label, label, brand, tamper]),
    ) as Array<[string, string, Brand, Tamper[1]]>,
  )(
    "%s: an applied write whose answer names %s stays held",
    async (_brand, _label, brand, tamper) => {
      const { holder, contextId } = await r20Holder(brand);
      const runtime = runtimeOf(brand);
      runtime.tamper = (body) => tamper(runtime, body);
      const write = await heldWrite(holder, contextId, 1, { dispatch: true });
      expect(await holder.status(write.operationId)).toMatchObject({
        status: 200,
        body: { phase: "assertion_issued" },
      });
      expect(statusReads(brand, write.operationId)).toEqual([["wallet", 200]]);
      expect(faceWrites(brand, write.operationId)).toBe(1);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: another holder's record, an incompatible artifact or a runtime without r20 never settles it",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      const runtime = runtimeOf(brand);
      const write = await heldWrite(holder, contextId, 1, { dispatch: true });
      const record = runtime.writes.get(`warranty:${write.operationId}`)!;
      const states: Array<[string, () => void, number]> = [
        [
          "another holder's record",
          () =>
            runtime.writes.set(`warranty:${write.operationId}`, {
              ...record,
              holder: brand.recipient.address,
            }),
          404,
        ],
        [
          "an artifact outside the runtime's compatible set",
          () => {
            runtime.writes.set(`warranty:${write.operationId}`, record);
            runtime.compatible = new Set([`sha256:${"0".repeat(64)}`]);
          },
          409,
        ],
        [
          "a runtime without r20",
          () => {
            runtime.compatible = undefined;
            runtime.r20 = false;
          },
          400,
        ],
      ];
      for (const [label, arrange, answered] of states) {
        arrange();
        expect([
          label,
          (await holder.status(write.operationId)).body.phase,
        ]).toEqual([label, "assertion_issued"]);
        expect(statusReads(brand, write.operationId).at(-1)).toEqual([
          "wallet",
          answered,
        ]);
      }
      expect(faceWrites(brand, write.operationId)).toBe(1);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a full journal makes room only from a write proven applied; without one it stays full",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      // The registration and five held writes: only the second was applied.
      const writes = [];
      for (const n of [1, 2, 3, 4, 5]) {
        writes.push(
          (await heldWrite(holder, contextId, n, { dispatch: n === 2 }))
            .operationId,
        );
      }
      const listed = async () =>
        (
          (await holder.list()).body.operations as Array<{
            operation_id: string;
            phase: string;
          }>
        ).map((item) => [item.operation_id, item.phase]);
      expect(await listed()).toHaveLength(6);
      const begin = (n: number) =>
        holder.operations({
          transition: "begin",
          kind: "runtime",
          operation: "case.evidence.submit",
          object_id: brand.unit.id,
          case_id: brand.cases[0],
          operation_id: `case-write-${brand.tag}-000${n}`,
          context_id: contextId,
        });
      // The two oldest held writes are read: the first is unknown (held),
      // the second proven applied, settled and so the room made.
      expect((await begin(6)).status).toBe(200);
      expect(statusReads(brand, writes[0])).toEqual([["wallet", 404]]);
      expect(statusReads(brand, writes[1])).toEqual([["wallet", 200]]);
      const journal = await listed();
      expect(journal).toHaveLength(6);
      expect(journal).toContainEqual([writes[0], "assertion_issued"]);
      expect(journal.map(([id]) => id)).not.toContain(writes[1]);
      // Nothing left is proven: the next begin is refused, nothing evicted.
      const mints = minted.mock.calls.length;
      expect(await begin(7)).toMatchObject({
        status: 409,
        body: { code: "journal_full" },
      });
      expect(
        minted.mock.calls
          .slice(mints)
          .map(([input]) => (input as { operation: string }).operation),
      ).toEqual(["write.status", "write.status"]);
      expect(await listed()).toEqual(journal);
      for (const operationId of writes) {
        expect(faceWrites(brand, operationId)).toBe(
          operationId === writes[1] ? 1 : 0,
        );
      }
    },
  );
});

// ----------------------------------------- recovery journeys (PROPOSED r20)

// The wallet's durable recovery consumer against the labelled r20 fixture: a
// listing from the face's runtime and its linked runtime, resolved read-only
// through each kind's resolver, acknowledged once, and failing closed for
// every wrong actor, programme, artifact or runtime without r20. Nothing is
// ever re-sent to a face, and no business write happens for any recovery call.

type RecoveredWire = {
  operation_id: string;
  kind: string;
  operation: string;
  object_id: string;
  case_id: string | null;
  offer_id: string | null;
  step: string | null;
  outcome: string;
  holding: string | null;
  ticket: string | null;
};
const recoveredItems = (body: Json) => (body.items ?? []) as RecoveredWire[];
const itemOf = (body: Json, operationId: string) =>
  recoveredItems(body).find((item) => item.operation_id === operationId);

/** The fake's runtime calls a face made (`by:"face"`). */
const faceSends = (brand: Brand) =>
  runtimeOf(brand).calls.filter((call) => call.by === "face").length;
/** A snapshot of all business effects, to prove recovery makes none. */
const businessOf = () => ({
  executed: world.dual.executed.map((action) => action.actionId).join(","),
  ebus: world.dual.ebus.length,
});

/**
 * The won-but-unseen custody world: the holder registers, settles, offers;
 * the recipient accepts on the same host; the holder executes the request
 * step (committed) and the custody step through the real executor, but the
 * wallet never learns the custody outcome (no transfer-progress read for it).
 * Custody then moved to the recipient in Dual.
 */
async function custodyRecoveryWorld(brand: Brand) {
  deploy(brand);
  runtimeOf(brand).r20 = true;
  const holder = new Browser(brand, brand.holder, launchOf(brand, "holder"));
  const registration = await issueRegistration(holder);
  const settleOperation = `settle-${brand.tag}-0001`;
  const settle = await settleWon(
    holder,
    registration.operationId,
    settleOperation,
  );
  await executeStep(holder, settleOperation, settle.action);
  const recipient = new Browser(
    brand,
    brand.recipient,
    launchOf(brand, "recipient"),
  );
  const offer = await offerAccepted(holder, recipient, settle.contextId);
  // The request step: executed and its outcome read, so it commits and the
  // custody step can be proposed.
  const requestOperation = `xfer-request-${brand.tag}-0001`;
  await executeStep(
    holder,
    requestOperation,
    await transferStepWon(
      holder,
      settle.contextId,
      offer.offerId,
      requestOperation,
      "request",
    ),
  );
  expect(
    (await holder.transferProgress({ operation_id: requestOperation })).status,
  ).toBe(200);
  // The custody step: executed through the real executor, its outcome NEVER
  // read by the wallet (no transferProgress). Custody moves in Dual.
  const custodyOperation = `xfer-custody-${brand.tag}-0001`;
  await executeStep(
    holder,
    custodyOperation,
    await transferStepWon(
      holder,
      settle.contextId,
      offer.offerId,
      custodyOperation,
      "transfer",
    ),
  );
  expect(world.dual.units.get(brand.unit.id)).toMatchObject({
    owner: brand.recipient.address,
  });
  return {
    holder,
    recipient,
    contextId: settle.contextId,
    registration: registration.operationId,
    settleOperation,
    offer,
    requestOperation,
    custodyOperation,
    session: holder.cookies.get(SESSION_COOKIE)!,
  };
}

/** A browser with only the session cookie: the launch journals are lost. */
const afterLostCookies = (
  brand: Brand,
  party: Party,
  session: string,
  who: string,
) =>
  new Browser(
    brand,
    party,
    launchOf(brand, who),
    new Map([[SESSION_COOKIE, session]]),
  );

describe("recovery: won-but-unseen custody completion (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: the custody step is recovered and acknowledged once, then no longer listed; former-owner reads still refuse",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const runtime = runtimeOf(brand);
      const sendsBefore = faceSends(brand);
      const business = businessOf();

      const fresh = afterLostCookies(
        brand,
        brand.holder,
        world0.session,
        "recover",
      );
      const listed = await fresh.recovery();
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ supported: true, complete: true });
      const custody = recoveredItems(listed.body).find(
        (item) => item.kind === "transfer" && item.step === "transfer",
      );
      expect(custody).toMatchObject({
        operation_id: world0.custodyOperation,
        outcome: "transferred",
      });
      expect(typeof custody!.ticket).toBe("string");

      // Acknowledge once; a replay records nothing more.
      const ack = await fresh.recoveryAck({
        operation_id: world0.custodyOperation,
        ticket: custody!.ticket,
      });
      expect(ack).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });
      const replay = await fresh.recoveryAck({
        operation_id: world0.custodyOperation,
        ticket: custody!.ticket,
      });
      expect(replay).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: false },
      });

      // A second listing no longer carries the acknowledged custody step.
      const again = await fresh.recovery();
      expect(
        recoveredItems(again.body).some(
          (item) => item.operation_id === world0.custodyOperation,
        ),
      ).toBe(false);

      // Former-owner reads still refuse: the unit left the holder, so the
      // wallet refuses the private read at mint and a fresh selection fails.
      const denied = await world0.holder.mint({
        operation: "products.private.read",
        operation_id: `private-${brand.tag}-0001`,
        target: { object_id: brand.unit.id },
        request_hash: hashOf(
          "products.private.read",
          `private-${brand.tag}-0001`,
          { object_id: brand.unit.id },
          {},
        ),
        context_id: world0.contextId,
      });
      // The wallet refuses the former owner before the runtime: its own
      // ownership gate fails (not_owned, 403), so no not_holder assertion is
      // even minted.
      expect(denied.status).toBe(403);
      expect(
        (
          await fresh.send(
            selectionPOST,
            `/api/faces/${brand.slug}/selection`,
            {
              body: { object_id: brand.unit.id },
              params: { slug: brand.slug },
            },
          )
        ).status,
      ).toBe(403);

      // No face re-send and no business write happened for any recovery call.
      expect(faceSends(brand)).toBe(sendsBefore);
      expect(businessOf()).toEqual(business);
      expect(
        runtime.calls.every(
          (call) =>
            call.operation !== "write.status" ||
            (call.by === "wallet" && [200, 404].includes(call.status)),
        ),
      ).toBe(true);
    },
  );
});

describe("recovery: logout, sign-in again and account switch (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a new session of the same wallet recovers its own items; another wallet recovers none of them, and neither acknowledges the other's",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const sendsBefore = faceSends(brand);
      const business = businessOf();

      // A new session of the SAME wallet (logout then sign-in) with no launch
      // cookies lists this wallet's completed-but-unacknowledged items.
      const holderAgain = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "holder-2"),
      );
      const listed = await holderAgain.recovery();
      expect(listed.body).toMatchObject({ supported: true, complete: true });
      const custody = itemOf(listed.body, world0.custodyOperation);
      expect(custody).toMatchObject({ outcome: "transferred" });
      expect(itemOf(listed.body, world0.settleOperation)).toMatchObject({
        outcome: "registered",
      });

      // A DIFFERENT wallet lists nothing of the holder's.
      const recipient = new Browser(
        brand,
        brand.recipient,
        launchOf(brand, "recipient-2"),
      );
      const recipientList = await recipient.recovery();
      expect(recipientList.body).toMatchObject({ supported: true });
      for (const operationId of [
        world0.registration,
        world0.settleOperation,
        world0.custodyOperation,
      ]) {
        expect(itemOf(recipientList.body, operationId)).toBeUndefined();
      }

      // Account switch: the recipient cannot acknowledge a holder ticket (it
      // is sealed to the holder's session and launch), and the holder can.
      const recipientAck = await recipient.recoveryAck({
        operation_id: world0.custodyOperation,
        ticket: custody!.ticket,
      });
      expect(recipientAck.status).toBe(400);
      const ack = await holderAgain.recoveryAck({
        operation_id: world0.custodyOperation,
        ticket: custody!.ticket,
      });
      expect(ack).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });

      expect(faceSends(brand)).toBe(sendsBefore);
      expect(businessOf()).toEqual(business);
    },
  );
});

// FIXTURE (r20.1): each knob degrades the runtime's write.status answer in
// one named way the wallet must hold (the runtime still answers 200); only
// the failed second action is the runtime's own refusal (409).
const DUAL_KNOB_ROWS: Array<[string, DualKnobs, number]> = [
  ["one effect answered for two intended", { dualShortEffects: true }, 200],
  ["a corroboration read eleven minutes ago", { dualStaleRead: true }, 200],
  ["a receipt verified after the read", { dualVerifiedAfterRead: true }, 200],
  [
    "a receipt without a recorded controller",
    { dualControllerUnrecorded: true },
    200,
  ],
  [
    "a controller declared but observed null",
    { dualControllerMismatch: true },
    200,
  ],
  ["a history entry of another object", { dualHistoryOtherObject: true }, 200],
  ["an execution still pending", { dualExecutionPending: true }, 200],
  ["the withdrawn payload_match field", { dualWithdrawnField: true }, 200],
  ["a sha256-prefixed content hash", { dualSha256Hash: true }, 200],
  ["a second Dual action that failed", { dualFailedEffect: true }, 409],
];

describe("recovery: the two-effect case.open is proved by its receipt chain, anything less is held (r20.1 fixture)", () => {
  /** The holder's real case.open on the prepared case, sent by the face. */
  async function openedCase(holder: Browser, contextId: string, n: number) {
    const executedBefore = world.dual.executed.length;
    const opened = await heldWrite(holder, contextId, n, {
      dispatch: true,
      operation: "case.open",
      caseIndex: 0,
    });
    return { ...opened, actions: world.dual.executed.slice(executedBefore) };
  }
  const actionRows = (actions: FakeDual["executed"]) =>
    actions.map((action) => [
      action.name,
      action.objectId,
      action.account,
      action.controller,
      action.status,
    ]);
  /** FakeDual's two actions of a case.open: the mint, then the update. */
  const twoEffects = (brand: Brand) => [
    [
      "mint",
      runtimeOf(brand).dualBackedObjectId,
      SERVICE_ACCOUNT,
      null,
      "COMPLETED",
    ],
    ["update", brand.unit.id, SERVICE_ACCOUNT, FIXTURE_CONTROLLER, "COMPLETED"],
  ];
  const historyOf = () =>
    JSON.stringify([...world.dual.history.entries()].sort());

  /**
   * The held shape of one case.open: listed outcome_unknown without a
   * ticket after exactly one write.status read answered `answered`, no ack
   * row, Dual's actions and history unchanged, and the write sent once.
   */
  async function expectHeld(
    brand: Brand,
    holder: Browser,
    operationId: string,
    answered: number,
  ) {
    const sendsBefore = faceSends(brand);
    const business = businessOf();
    const history = historyOf();
    const listed = await holder.recovery();
    expect(listed.body).toMatchObject({ supported: true, complete: true });
    expect(itemOf(listed.body, operationId)).toMatchObject({
      outcome: "outcome_unknown",
      ticket: null,
    });
    expect(statusReads(brand, operationId)).toEqual([["wallet", answered]]);
    expect(runtimeOf(brand).acks.get(`warranty:${operationId}`)).toBe(
      undefined,
    );
    expect(faceSends(brand)).toBe(sendsBefore);
    expect(faceWrites(brand, operationId)).toBe(1);
    expect(businessOf()).toEqual(business);
    expect(historyOf()).toBe(history);
  }

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: the holder's case.open mints then updates as the service account; its receipt chain lists it write_applied, acknowledged once, while the refused, unresolved and unavailable writes stay held",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      const runtime = runtimeOf(brand);

      const opened = await openedCase(holder, contextId, 1);
      expect(opened.answer).toMatchObject({
        status: 200,
        body: { status: "case_opened", case_id: brand.cases[0] },
      });
      // Exactly two Dual actions, in order, signed by the service account
      // (never the holder): the fixture object minted directly, then the
      // product object updated through the declared controller. Each left
      // ONE history entry, belonging to its own object.
      expect(actionRows(opened.actions)).toEqual(twoEffects(brand));
      expect(
        opened.actions.every(
          (action) => action.account !== brand.holder.address,
        ),
      ).toBe(true);
      expect(
        world.dual.history
          .get(runtime.dualBackedObjectId)!
          .map((entry) => entry.actionId),
      ).toEqual([opened.actions[0].actionId]);
      expect(
        world.dual.history.get(brand.unit.id)!.map((entry) => entry.actionId),
      ).toEqual([opened.actions[1].actionId]);
      expect(
        world.dual.history
          .get(brand.unit.id)!
          .every((entry) => /^0x[0-9a-f]{64}$/.test(entry.contentHashRaw)),
      ).toBe(true);

      // A definitive zero-write refusal (case.open on an already-open case):
      // no Dual action at all.
      const executed = world.dual.executed.length;
      const refused = await heldWrite(holder, contextId, 2, {
        dispatch: true,
        operation: "case.open",
        caseIndex: 1,
      });
      expect(refused.answer).toMatchObject({ status: 409 });
      expect(world.dual.executed).toHaveLength(executed);

      // A server-only write beside it, proved by its fresh target readback.
      const evidence = await heldWrite(holder, contextId, 3, {
        dispatch: true,
        operation: "case.evidence.submit",
        caseIndex: 0,
      });
      expect(evidence.answer).toMatchObject({ status: 200 });

      // Two server-only held variants, seeded on this holder's warranty actor:
      // one with an unresolved outcome, one whose target cannot be read.
      const captured = runtime.writes.get(`warranty:${opened.operationId}`)!;
      const actor: Actor = {
        holder: captured.holder,
        sub: captured.wallet,
        iss: captured.issuer,
        aud: captured.audience,
        programme: captured.programme,
        artifact: captured.artifact,
      };
      const unresolvedOp = `case-write-${brand.tag}-0004`;
      const unavailableOp = `case-write-${brand.tag}-0005`;
      runtime.seedWriteRecord(actor, {
        operationId: unresolvedOp,
        operation: "case.evidence.submit",
        caseId: brand.cases[0],
        recordedAt: new Date(Date.now()).toISOString(),
        unresolved: 1,
      });
      runtime.seedWriteRecord(actor, {
        operationId: unavailableOp,
        operation: "case.information.provide",
        caseId: brand.cases[0],
        recordedAt: new Date(Date.now()).toISOString(),
        dualUnavailable: true,
      });

      const sendsBefore = faceSends(brand);
      const business = businessOf();
      const history = historyOf();
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({ supported: true, complete: true });

      // The two-effect write is proved by its receipt chain and ticketed...
      const openedItem = itemOf(listed.body, opened.operationId);
      expect(openedItem).toMatchObject({
        outcome: "write_applied",
        operation: "case.open",
        case_id: brand.cases[0],
      });
      expect(typeof openedItem!.ticket).toBe("string");
      // ...as is the server-only write by its target readback.
      const evidenceItem = itemOf(listed.body, evidence.operationId);
      expect(evidenceItem).toMatchObject({ outcome: "write_applied" });
      expect(typeof evidenceItem!.ticket).toBe("string");
      // Every unproved outcome is held: no ticket.
      for (const operationId of [unresolvedOp, unavailableOp]) {
        expect(itemOf(listed.body, operationId)).toMatchObject({
          outcome: "outcome_unknown",
          ticket: null,
        });
      }
      // The refusal is shown as write_refused (after its binding checks) and
      // frees nothing: no ticket.
      expect(itemOf(listed.body, refused.operationId)).toMatchObject({
        outcome: "write_refused",
        ticket: null,
      });

      // Acknowledged once; a replay records nothing more; then unlisted.
      const ack = await holder.recoveryAck({
        operation_id: opened.operationId,
        ticket: openedItem!.ticket,
      });
      expect(ack).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });
      expect(
        await holder.recoveryAck({
          operation_id: opened.operationId,
          ticket: openedItem!.ticket,
        }),
      ).toMatchObject({ status: 200, body: { first: false } });
      expect(runtime.acks.get(`warranty:${opened.operationId}`)).toHaveLength(
        1,
      );
      expect(
        await holder.recoveryAck({
          operation_id: evidence.operationId,
          ticket: evidenceItem!.ticket,
        }),
      ).toMatchObject({ status: 200, body: { first: true } });
      const again = await holder.recovery();
      expect(itemOf(again.body, opened.operationId)).toBeUndefined();

      // Every write.status read was the wallet's and read-only; no recovery
      // call re-sent a write or touched Dual's actions, history or bus.
      expect(
        statusReads(brand, opened.operationId).every(
          ([by, status]) => by === "wallet" && status === 200,
        ),
      ).toBe(true);
      expect(faceWrites(brand, opened.operationId)).toBe(1);
      expect(faceSends(brand)).toBe(sendsBefore);
      expect(businessOf()).toEqual(business);
      expect(historyOf()).toBe(history);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a full journal makes room from the case.open proven by its receipt chain, read once by write.status, nothing re-sent",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      // The registration and five held writes: only the second was sent,
      // the two-effect case.open.
      const writes: string[] = [];
      for (const n of [1, 2, 3, 4, 5]) {
        if (n === 2) {
          const opened = await openedCase(holder, contextId, n);
          expect(opened.answer).toMatchObject({ status: 200 });
          expect(actionRows(opened.actions)).toEqual(twoEffects(brand));
          writes.push(opened.operationId);
        } else {
          writes.push(
            (await heldWrite(holder, contextId, n, { dispatch: false }))
              .operationId,
          );
        }
      }
      const listed = async () =>
        (
          (await holder.list()).body.operations as Array<{
            operation_id: string;
            phase: string;
          }>
        ).map((item) => [item.operation_id, item.phase]);
      expect(await listed()).toHaveLength(6);
      const business = businessOf();
      const history = historyOf();
      const begin = (n: number) =>
        holder.operations({
          transition: "begin",
          kind: "runtime",
          operation: "case.evidence.submit",
          object_id: brand.unit.id,
          case_id: brand.cases[0],
          operation_id: `case-write-${brand.tag}-000${n}`,
          context_id: contextId,
        });
      // The two oldest held writes are read: the first is unknown (held),
      // the second proven applied by its two-effect chain, so the room made.
      expect((await begin(6)).status).toBe(200);
      expect(statusReads(brand, writes[0])).toEqual([["wallet", 404]]);
      expect(statusReads(brand, writes[1])).toEqual([["wallet", 200]]);
      const journal = await listed();
      expect(journal).toHaveLength(6);
      expect(journal).toContainEqual([writes[0], "assertion_issued"]);
      expect(journal.map(([id]) => id)).not.toContain(writes[1]);
      // Nothing left is proven: the next begin is refused, nothing evicted.
      expect(await begin(7)).toMatchObject({
        status: 409,
        body: { code: "journal_full" },
      });
      expect(await listed()).toEqual(journal);
      // The reads changed nothing in Dual, and each write was sent at most once.
      expect(businessOf()).toEqual(business);
      expect(historyOf()).toBe(history);
      for (const operationId of writes) {
        expect(faceWrites(brand, operationId)).toBe(
          operationId === writes[1] ? 1 : 0,
        );
      }
    },
  );

  it.each(
    BRANDS.flatMap((brand) =>
      DUAL_KNOB_ROWS.map(([label, knobs, answered]) => [
        brand.label,
        label,
        brand,
        knobs,
        answered,
      ]),
    ) as Array<[string, string, Brand, DualKnobs, number]>,
  )(
    "%s: a case.open whose chain carries %s stays held: no ticket, no ack row, Dual unchanged, sent once",
    async (_brand, _label, brand, knobs, answered) => {
      const { holder, contextId } = await r20Holder(brand);
      const runtime = runtimeOf(brand);
      runtime.dualBackedOps.set("case.open", {
        effects: CASE_OPEN_EFFECTS,
        knobs,
      });
      const opened = await openedCase(holder, contextId, 1);
      expect(opened.answer).toMatchObject({ status: 200 });
      expect(opened.actions).toHaveLength(2);
      if (knobs.dualFailedEffect) {
        // FakeDual recorded the update as failed: no history entry of it.
        expect(actionRows(opened.actions)[1]).toEqual([
          "update",
          brand.unit.id,
          SERVICE_ACCOUNT,
          FIXTURE_CONTROLLER,
          "FAILED",
        ]);
        expect(world.dual.history.get(brand.unit.id)).toBeUndefined();
      } else {
        expect(actionRows(opened.actions)).toEqual(twoEffects(brand));
      }

      await expectHeld(brand, holder, opened.operationId, answered);
      if (knobs.dualFailedEffect) {
        // The runtime's own refusal: one effect proved, never write_applied.
        expect(runtime.writeStatusRefusals.at(-1)).toEqual({
          ok: false,
          status: "write_outcome_unknown",
          reason: "effects_unproved",
          proved_effects: 1,
        });
      } else {
        expect(runtime.writeStatusRefusals).toEqual([]);
      }
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a case.open whose artifact the runtime retired after the write is refused (409 artifact retired) and stays held",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      const runtime = runtimeOf(brand);
      const opened = await openedCase(holder, contextId, 1);
      expect(actionRows(opened.actions)).toEqual(twoEffects(brand));
      runtime.compatible = new Set([`sha256:${"0".repeat(64)}`]);
      await expectHeld(brand, holder, opened.operationId, 409);
      expect(runtime.writeStatusRefusals).toEqual([
        { ok: false, status: "face_operation_artifact_retired" },
      ]);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a proved server-only write whose target object was deleted reads absent and stays held",
    async (_label, brand) => {
      const { holder, contextId } = await r20Holder(brand);
      const write = await heldWrite(holder, contextId, 1, {
        dispatch: true,
        operation: "case.evidence.submit",
        caseIndex: 0,
      });
      expect(write.answer).toMatchObject({ status: 200 });
      // The unit is deleted from Dual after the write: the readback is absent,
      // which the wallet holds (a decision for Root, contract §5).
      world.dual.units.delete(brand.unit.id);
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({ supported: true });
      expect(itemOf(listed.body, write.operationId)).toMatchObject({
        outcome: "outcome_unknown",
        ticket: null,
      });
    },
  );
});

// A retired (incompatible) artifact hash, well formed but outside set A.
const RETIRED_ARTIFACT = {
  version: "0.9.0",
  artifactHash: `sha256:${"a9".repeat(32)}`,
};

/**
 * A holder who already owns a settled unit (no registration record), so a
 * listing holds only the write records a test seeds plus one real write.
 */
async function seededHeldWorld(brand: Brand) {
  deploy(brand);
  const runtime = runtimeOf(brand);
  runtime.r20 = true;
  const unit = world.dual.units.get(brand.unit.id)!;
  unit.owner = brand.holder.address;
  unit.custom = {
    recordId: brand.unit.recordId,
    state: "Authenticity verified",
    lifecycle: { target_state: "Authenticity verified" },
  };
  const holder = new Browser(brand, brand.holder, launchOf(brand, "holder"));
  const contextId = await holder.select(brand.unit.id);
  return { holder, contextId, runtime };
}

const outcomeItems = (body: Json) =>
  recoveredItems(body).filter((item) => item.outcome !== "not_checked");
const notCheckedItems = (body: Json) =>
  recoveredItems(body).filter((item) => item.outcome === "not_checked");
const statusReadCount = (brand: Brand) =>
  runtimeOf(brand).calls.filter((call) => call.operation === "write.status")
    .length;

describe("recovery: the bounded page and its continuation (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (f1): a >25 held-completed prefix does not starve a later valid completion reached on page 2",
    async (_label, brand) => {
      const { holder, contextId, runtime } = await seededHeldWorld(brand);
      // One genuinely applied real write, last in order.
      const real = await heldWrite(holder, contextId, 100, {
        dispatch: true,
        operation: "case.evidence.submit",
        caseIndex: 0,
      });
      expect(real.answer).toMatchObject({ status: 200 });
      const captured = runtime.writes.get(`warranty:${real.operationId}`)!;
      const actor: Actor = {
        holder: captured.holder,
        sub: captured.wallet,
        iss: captured.issuer,
        aud: captured.audience,
        programme: captured.programme,
        artifact: captured.artifact,
      };
      // Only the real write's artifact is in set A; the 27 seeded completed
      // writes carry a retired artifact, so write.status answers 409 for each.
      runtime.compatible = new Set([captured.artifact.artifactHash]);
      const now = Date.now();
      const seeded: string[] = [];
      for (let i = 0; i < 27; i += 1) {
        const operationId = `seed-${brand.tag}-${String(i).padStart(4, "0")}`;
        seeded.push(operationId);
        runtime.seedWriteRecord(actor, {
          operationId,
          operation: "case.evidence.submit",
          caseId: brand.cases[0],
          recordedAt: new Date(now - (30 - i) * 60_000).toISOString(),
          recordedArtifact: RETIRED_ARTIFACT,
        });
      }

      const sendsBefore = faceSends(brand);
      const readsBefore = statusReadCount(brand);

      // Page 1: 25 resolved (all held → outcome_unknown, ticket null), the
      // remaining 2 held and the real write returned as not checked.
      const page1 = await holder.recovery();
      expect(page1.body).toMatchObject({
        supported: true,
        complete: true,
        unchecked: 3,
      });
      expect(typeof page1.body.continuation).toBe("string");
      expect(outcomeItems(page1.body)).toHaveLength(25);
      expect(
        outcomeItems(page1.body).every(
          (item) => item.outcome === "outcome_unknown" && item.ticket === null,
        ),
      ).toBe(true);
      expect(notCheckedItems(page1.body)).toHaveLength(3);
      const page1Resolved = outcomeItems(page1.body).map(
        (item) => item.operation_id,
      );

      // Page 2: the 2 held resolve to outcome_unknown and the real write to
      // write_applied with a ticket; the page does not repeat the first 25.
      const page2 = await holder.recovery(String(page1.body.continuation));
      expect(page2.body).toMatchObject({ complete: true, continuation: null });
      expect(
        recoveredItems(page2.body).some((item) =>
          page1Resolved.includes(item.operation_id),
        ),
      ).toBe(false);
      const realItem = itemOf(page2.body, real.operationId);
      expect(realItem).toMatchObject({ outcome: "write_applied" });
      expect(typeof realItem!.ticket).toBe("string");
      expect(
        recoveredItems(page2.body)
          .filter((item) => item.operation_id !== real.operationId)
          .every((item) => item.outcome === "outcome_unknown"),
      ).toBe(true);

      // Exactly 25 + 3 write.status reads, and nothing re-sent to a face.
      expect(statusReadCount(brand) - readsBefore).toBe(28);
      expect(faceSends(brand)).toBe(sendsBefore);

      const ack = await holder.recoveryAck({
        operation_id: real.operationId,
        ticket: realItem!.ticket,
      });
      expect(ack).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });
      void seeded;
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (f2): an unresolved row under a non-acknowledgeable completed prefix is reached and acknowledged on page 2",
    async (_label, brand) => {
      const { holder, contextId, runtime } = await seededHeldWorld(brand);
      const real = await heldWrite(holder, contextId, 100, {
        dispatch: true,
        operation: "case.evidence.submit",
        caseIndex: 0,
      });
      const captured = runtime.writes.get(`warranty:${real.operationId}`)!;
      const actor: Actor = {
        holder: captured.holder,
        sub: captured.wallet,
        iss: captured.issuer,
        aud: captured.audience,
        programme: captured.programme,
        artifact: captured.artifact,
      };
      // The real write's record is only a vehicle to capture the actor; mark
      // it already acknowledged so the listing holds just the seeded rows.
      runtime.acks.set(`warranty:${real.operationId}`, [
        {
          iss: actor.iss,
          sub: actor.sub,
          holder: actor.holder,
          outcomeHash: "sha256:x",
          at: new Date(Date.now()).toISOString(),
        },
      ]);
      runtime.compatible = new Set([captured.artifact.artifactHash]);
      const now = Date.now();
      // 26 completed-but-held records (retired artifact) recorded first.
      for (let i = 0; i < 26; i += 1) {
        runtime.seedWriteRecord(actor, {
          operationId: `seed-${brand.tag}-${String(i).padStart(4, "0")}`,
          operation: "case.evidence.submit",
          caseId: brand.cases[0],
          recordedAt: new Date(now - (30 - i) * 60_000).toISOString(),
          recordedArtifact: RETIRED_ARTIFACT,
        });
      }
      // One record listed unresolved now (409), compatible, recorded last.
      const unresolvedOp = `seed-${brand.tag}-unresolved`;
      runtime.seedWriteRecord(actor, {
        operationId: unresolvedOp,
        operation: "case.evidence.submit",
        caseId: brand.cases[0],
        recordedAt: new Date(now).toISOString(),
        unresolved: 1,
      });

      const readsBefore = statusReadCount(brand);
      const sendsBefore = faceSends(brand);
      const page1 = await holder.recovery();
      expect(page1.body).toMatchObject({ complete: true, unchecked: 2 });
      expect(outcomeItems(page1.body)).toHaveLength(25);
      expect(typeof page1.body.continuation).toBe("string");

      // The provider outcome settles between the pages: a new scan may show it.
      runtime.writes.get(`warranty:${unresolvedOp}`)!.unresolved = 0;

      const page2 = await holder.recovery(String(page1.body.continuation));
      const resolved = itemOf(page2.body, unresolvedOp);
      expect(resolved).toMatchObject({ outcome: "write_applied" });
      expect(typeof resolved!.ticket).toBe("string");
      // No page resolved more than 25.
      expect(outcomeItems(page1.body).length).toBeLessThanOrEqual(25);
      expect(outcomeItems(page2.body).length).toBeLessThanOrEqual(25);

      const ack = await holder.recoveryAck({
        operation_id: unresolvedOp,
        ticket: resolved!.ticket,
      });
      expect(ack).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });
      expect(faceSends(brand)).toBe(sendsBefore);
      void readsBefore;
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (f3): a continuation is this launch's and session's only, and is idempotent within its TTL",
    async (_label, brand) => {
      const { holder, contextId, runtime } = await seededHeldWorld(brand);
      const real = await heldWrite(holder, contextId, 100, {
        dispatch: true,
        operation: "case.evidence.submit",
        caseIndex: 0,
      });
      const captured = runtime.writes.get(`warranty:${real.operationId}`)!;
      const actor: Actor = {
        holder: captured.holder,
        sub: captured.wallet,
        iss: captured.issuer,
        aud: captured.audience,
        programme: captured.programme,
        artifact: captured.artifact,
      };
      runtime.compatible = new Set([captured.artifact.artifactHash]);
      const now = Date.now();
      for (let i = 0; i < 27; i += 1) {
        runtime.seedWriteRecord(actor, {
          operationId: `seed-${brand.tag}-${String(i).padStart(4, "0")}`,
          operation: "case.evidence.submit",
          caseId: brand.cases[0],
          recordedAt: new Date(now - (30 - i) * 60_000).toISOString(),
          recordedArtifact: RETIRED_ARTIFACT,
        });
      }
      const page1 = await holder.recovery();
      const continuation = String(page1.body.continuation);
      expect(continuation).not.toBe("null");
      const sendsBefore = faceSends(brand);

      // Another launch of the same wallet cannot use the continuation.
      const otherLaunch = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "other-launch"),
      );
      const foreignLaunch = await otherLaunch.recovery(continuation);
      expect(foreignLaunch).toMatchObject({
        status: 409,
        body: { code: "continuation_invalid" },
      });

      // A different session (new sign-in) cannot use it either.
      const newSession = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "new-session"),
      );
      const foreignSession = await newSession.recovery(continuation);
      expect(foreignSession).toMatchObject({
        status: 409,
        body: { code: "continuation_invalid" },
      });

      // Reused twice within the TTL, the same page comes back (idempotent).
      const again1 = await holder.recovery(continuation);
      const again2 = await holder.recovery(continuation);
      expect(
        recoveredItems(again1.body).map((item) => item.operation_id),
      ).toEqual(recoveredItems(again2.body).map((item) => item.operation_id));
      // The foreign reads resolved nothing; the holder's own re-reads sent no
      // write to a face.
      expect(faceSends(brand)).toBe(sendsBefore);
    },
  );
});

/** The holder's warranty-runtime actor, as the wallet mints it for recovery. */
const warrantyActor = (brand: Brand): Actor => ({
  // As the runtime stores it: the assertion's lowercase holder.
  holder: brand.holder.address.toLowerCase(),
  sub: brand.holder.walletId,
  iss: brand.origin,
  aud: `${brand.warranty.applicationId}@${brand.warranty.origin}`,
  programme: brand.programmeId,
  artifact: { version: "1.0.0", artifactHash: `sha256:${ARTIFACT_HEX}` },
});

/** N completed, compatible warranty write records on this actor, oldest first. */
function seedCompleted(runtime: BrandRuntime, actor: Actor, count: number) {
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const operationId = `seed-${runtime.brand.tag}-${String(i).padStart(4, "0")}`;
    ids.push(operationId);
    runtime.seedWriteRecord(actor, {
      operationId,
      operation: "case.evidence.submit",
      caseId: runtime.brand.cases[0],
      recordedAt: new Date(now - (60 - i) * 60_000).toISOString(),
    });
  }
  return ids;
}

describe("recovery: an incomplete scan acknowledges nothing (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a store that could not be read leaves every proved outcome without a ticket",
    async (_label, brand) => {
      const { holder, runtime } = await seededHeldWorld(brand);
      seedCompleted(runtime, warrantyActor(brand), 3);
      runtime.incompleteScan = true;
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({
        supported: true,
        complete: false,
      });
      expect(recoveredItems(listed.body).length).toBeGreaterThan(0);
      expect(
        recoveredItems(listed.body).every((item) => item.ticket === null),
      ).toBe(true);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: an item the wallet can read only by identity (a record the runtime retains however malformed) makes that runtime's check incomplete for that reason; the readable items are still listed, nothing carries a ticket, and every check names its runtime and cause",
    async (_label, brand) => {
      const { holder, runtime } = await seededHeldWorld(brand);
      seedCompleted(runtime, warrantyActor(brand), 2);
      runtime.malformedListedItem = {
        kind: "warranty",
        operationId: "case-legacy-0001",
      };
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({
        supported: true,
        complete: false,
        unreadable: [
          {
            operation_id: "case-legacy-0001",
            kind: "runtime",
            state: "unresolved",
          },
        ],
        checks: [
          {
            runtime: "product",
            status: "checked",
            reason: null,
            unreadable: 0,
          },
          {
            runtime: "service",
            status: "incomplete",
            reason: "item_unreadable",
            unreadable: 1,
          },
        ],
      });
      expect(recoveredItems(listed.body).length).toBeGreaterThan(0);
      expect(
        recoveredItems(listed.body).every((item) => item.ticket === null),
      ).toBe(true);
      expect(
        recoveredItems(listed.body).some(
          (item) => item.operation_id === "case-legacy-0001",
        ),
      ).toBe(false);
      // The runtime's own word that a store could not be read to its end is
      // named as such.
      runtime.malformedListedItem = undefined;
      runtime.incompleteScan = true;
      const incomplete = await holder.recovery();
      expect(incomplete.body.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtime: "service",
            status: "incomplete",
            reason: "runtime_incomplete",
            unreadable: 0,
          }),
        ]),
      );
      runtime.incompleteScan = false;
      // Checked again: both runtimes complete, nothing unreadable.
      const complete = await holder.recovery();
      expect(complete.body).toMatchObject({
        supported: true,
        complete: true,
        unreadable: [],
        checks: [
          {
            runtime: "product",
            status: "checked",
            reason: null,
            unreadable: 0,
          },
          {
            runtime: "service",
            status: "checked",
            reason: null,
            unreadable: 0,
          },
        ],
      });
    },
  );

  const violations = [
    "repeat_id",
    "out_of_order",
    "cursor_cycle",
    "change_scan_id",
    "wrong_echo",
  ] as const;
  it.each(
    BRANDS.flatMap((brand) =>
      violations.map((violation) => [brand.label, violation, brand]),
    ) as Array<[string, (typeof violations)[number], Brand]>,
  )(
    "%s: a scan with %s is incomplete and nothing it lists carries a ticket",
    async (_label, violation, brand) => {
      const { holder, runtime } = await seededHeldWorld(brand);
      seedCompleted(runtime, warrantyActor(brand), 2);
      runtime.recoveryPageSize = 1;
      runtime.recoveryViolation = violation;
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({ supported: true, complete: false });
      expect(
        recoveredItems(listed.body).every((item) => item.ticket === null),
      ).toBe(true);
    },
  );

  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: a small page size is followed to the end, so a complete scan still lists every item",
    async (_label, brand) => {
      const { holder, runtime } = await seededHeldWorld(brand);
      const ids = seedCompleted(runtime, warrantyActor(brand), 5);
      runtime.recoveryPageSize = 2;
      const listed = await holder.recovery();
      expect(listed.body).toMatchObject({ supported: true, complete: true });
      for (const operationId of ids) {
        expect(itemOf(listed.body, operationId)).toMatchObject({
          outcome: "write_applied",
        });
        expect(typeof itemOf(listed.body, operationId)!.ticket).toBe("string");
      }

      // A ticket from this complete listing cannot be acknowledged from a
      // different launch: it is sealed to the launch that issued it.
      const ticket = itemOf(listed.body, ids[0])!.ticket!;
      const otherLaunch = new Browser(
        brand,
        brand.holder,
        launchOf(brand, "other-launch-e"),
      );
      const refused = await otherLaunch.recoveryAck({
        operation_id: ids[0],
        ticket,
      });
      expect(refused.status).toBe(400);
    },
  );
});

// ------------------------------- recovery: actor, host, ticket, preservation

/** The brand's binding with its linked Warranty runtime at another origin. */
const registryWithWarrantyMoved = (brand: Brand) =>
  JSON.stringify(
    ([morrowBinding(), tidewellFullBinding()] as Json[]).map((binding) =>
      binding.slug === brand.slug
        ? {
            ...binding,
            linkedRuntimes: (binding.linkedRuntimes as Json[]).map(
              (runtime) => ({
                ...runtime,
                origin: String(runtime.origin).replace(
                  "://warranty",
                  "://warranty-next",
                ),
              }),
            ),
          }
        : binding,
    ),
  );

/** The brand's binding serving another face artifact (version and hash). */
const registryWithArtifactChanged = (brand: Brand) =>
  JSON.stringify(
    [morrowBinding(), tidewellFullBinding()].map((binding) =>
      binding.slug === brand.slug
        ? {
            ...binding,
            version: "1.0.1",
            artifactHash: `sha256:${"b".repeat(64)}`,
            path: `/face/${String(binding.applicationId)}/1.0.1/${"b".repeat(64)}/`,
          }
        : binding,
    ),
  );

/** The brand's binding naming another programme (as a changed publication). */
const registryWithProgrammeChanged = (brand: Brand) =>
  JSON.stringify(
    [morrowBinding(), tidewellFullBinding()].map((binding) =>
      binding.slug === brand.slug
        ? { ...binding, programmeId: `${brand.programmeId}-next` }
        : binding,
    ),
  );

/** The brand's host document with journeys disabled (a compatible update). */
function documentWithout(brand: Brand, ...journeys: string[]) {
  const document = brand.document();
  for (const journey of journeys) edit(document, `journeys.${journey}`, false);
  return document;
}

describe("recovery: another actor, host, programme or artifact gets nothing (PROPOSED r20 fixture)", () => {
  it.each([
    [MORROW.label, MORROW, TIDEWELL],
    [TIDEWELL.label, TIDEWELL, MORROW],
  ] as Array<[string, Brand, Brand]>)(
    "%s (c): the other brand's host, a changed programme and an incompatible artifact recover nothing of this holder's",
    async (_label, brand, other) => {
      const world0 = await custodyRecoveryWorld(brand);
      const runtime = runtimeOf(brand);
      const sendsBefore = faceSends(brand);
      const business = businessOf();
      const fresh = afterLostCookies(
        brand,
        brand.holder,
        world0.session,
        "recover-c",
      );
      const listed = await fresh.recovery();
      const custody = itemOf(listed.body, world0.custodyOperation)!;
      expect(custody).toMatchObject({ outcome: "transferred" });

      // The other brand's host serves no face of this slug: refused before
      // the session is even looked at, for the listing and the ticket alike.
      deploy(other);
      const delivery = { at: other, keep: false };
      expect(await fresh.recovery(undefined, delivery)).toMatchObject({
        status: 404,
        body: { code: "unknown_application" },
      });
      expect(
        await fresh.recoveryAck(
          { operation_id: world0.custodyOperation, ticket: custody.ticket },
          delivery,
        ),
      ).toMatchObject({ status: 404, body: { code: "unknown_application" } });

      // The face slug naming another programme: the host's assertions now
      // name a programme the runtimes do not serve, so they refuse the first
      // page; nothing is listed, the host keeps today's behaviour, and nothing
      // is acknowledgeable (the records stay sealed to their own programme).
      deploy(brand, { registry: registryWithProgrammeChanged(brand) });
      const moved = await fresh.recovery();
      expect(moved.body).toMatchObject({ supported: false, items: [] });
      for (const operationId of [
        world0.registration,
        world0.settleOperation,
        world0.requestOperation,
        world0.custodyOperation,
      ]) {
        expect(itemOf(moved.body, operationId)).toBeUndefined();
      }
      expect(
        await fresh.recoveryAck({
          operation_id: world0.custodyOperation,
          ticket: custody.ticket,
        }),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });

      // Back on its own host: a Warranty & Service write whose artifact the
      // runtime no longer counts as compatible answers 409 to write.status,
      // so the item is unknown and carries no ticket; nothing is re-sent.
      deploy(brand);
      const contextId = await world0.recipient.select(brand.unit.id);
      const write = await heldWrite(world0.recipient, contextId, 7, {
        dispatch: true,
        caseIndex: 1,
      });
      expect(write.answer).toMatchObject({ status: 200 });
      runtime.compatible = new Set([`sha256:${"0".repeat(64)}`]);
      const recipientFresh = afterLostCookies(
        brand,
        brand.recipient,
        world0.recipient.cookies.get(SESSION_COOKIE)!,
        "recover-c-recipient",
      );
      const incompatible = await recipientFresh.recovery();
      expect(itemOf(incompatible.body, write.operationId)).toMatchObject({
        outcome: "outcome_unknown",
        ticket: null,
      });
      runtime.compatible = undefined;
      const compatible = await recipientFresh.recovery();
      expect(itemOf(compatible.body, write.operationId)).toMatchObject({
        outcome: "write_applied",
      });
      expect(typeof itemOf(compatible.body, write.operationId)!.ticket).toBe(
        "string",
      );

      expect(faceSends(brand)).toBe(sendsBefore + 1);
      expect(businessOf()).toEqual(business);
    },
  );
});

describe("recovery: a journey this host disables is withheld and never acknowledged (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (h): transfer disabled withholds the transfer steps and refuses their ticket; service progress disabled withholds the case write",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const sendsBefore = faceSends(brand);
      const business = businessOf();
      const fresh = afterLostCookies(
        brand,
        brand.holder,
        world0.session,
        "recover-h",
      );
      const enabled = await fresh.recovery();
      const custody = itemOf(enabled.body, world0.custodyOperation)!;
      expect(typeof custody.ticket).toBe("string");

      // A compatible host update that disables the transfer journey: the
      // steps stay listed at the runtime but this host neither resolves nor
      // acknowledges them, and a ticket from before is refused.
      deploy(brand, { document: documentWithout(brand, "transfer") });
      const withheld = await fresh.recovery();
      expect(withheld.body).toMatchObject({ supported: true, complete: true });
      expect(
        recoveredItems(withheld.body).some((item) => item.kind === "transfer"),
      ).toBe(false);
      expect(Number(withheld.body.withheld)).toBeGreaterThanOrEqual(1);
      expect(
        await fresh.recoveryAck({
          operation_id: world0.custodyOperation,
          ticket: custody.ticket,
        }),
      ).toMatchObject({
        status: 403,
        body: { code: "capability_not_granted" },
      });
      // Re-enabled: the same ticket (same session, launch, runtime and
      // artifact) acknowledges once.
      deploy(brand);
      expect(
        await fresh.recoveryAck({
          operation_id: world0.custodyOperation,
          ticket: custody.ticket,
        }),
      ).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });

      // A Warranty & Service write of the new holder, then service progress
      // disabled: withheld, not listed, not acknowledged.
      const contextId = await world0.recipient.select(brand.unit.id);
      const write = await heldWrite(world0.recipient, contextId, 8, {
        dispatch: true,
        caseIndex: 1,
      });
      const recipientFresh = afterLostCookies(
        brand,
        brand.recipient,
        world0.recipient.cookies.get(SESSION_COOKIE)!,
        "recover-h-recipient",
      );
      const listedWrite = itemOf(
        (await recipientFresh.recovery()).body,
        write.operationId,
      )!;
      expect(listedWrite).toMatchObject({ outcome: "write_applied" });
      // Quote decisions belong to service progress: both go together.
      deploy(brand, {
        document: documentWithout(brand, "serviceProgress", "quoteDecisions"),
      });
      const serviceOff = await recipientFresh.recovery();
      expect([serviceOff.status, serviceOff.body.code]).toEqual([
        200,
        undefined,
      ]);
      expect(itemOf(serviceOff.body, write.operationId)).toBeUndefined();
      expect(Number(serviceOff.body.withheld)).toBeGreaterThanOrEqual(1);
      expect(
        await recipientFresh.recoveryAck({
          operation_id: write.operationId,
          ticket: listedWrite.ticket,
        }),
      ).toMatchObject({ status: 403 });
      expect(runtimeOf(brand).acks.get(`warranty:${write.operationId}`)).toBe(
        undefined,
      );
      expect(faceSends(brand)).toBe(sendsBefore + 1);
      expect(businessOf()).toEqual(business);
    },
  );
});

describe("recovery: an acknowledgement ticket binds its runtime, artifact, launch and session (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (j): a moved linked origin, a changed face artifact, another launch or another session make the ticket invalid",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const sendsBefore = faceSends(brand);
      const business = businessOf();
      // A Warranty write of the new holder: its ticket names the warranty
      // runtime's application AND origin.
      const contextId = await world0.recipient.select(brand.unit.id);
      const write = await heldWrite(world0.recipient, contextId, 9, {
        dispatch: true,
        caseIndex: 1,
      });
      const recipientSession = world0.recipient.cookies.get(SESSION_COOKIE)!;
      const recipientFresh = afterLostCookies(
        brand,
        brand.recipient,
        recipientSession,
        "recover-j",
      );
      const listed = await recipientFresh.recovery();
      const writeItem = itemOf(listed.body, write.operationId)!;
      expect(typeof writeItem.ticket).toBe("string");
      const ack = (browser: Browser, operationId: string, ticket: unknown) =>
        browser.recoveryAck({ operation_id: operationId, ticket });

      // The linked Warranty runtime moved to another origin: refused before
      // anything is minted or sent.
      const mints = minted.mock.calls.length;
      deploy(brand, { registry: registryWithWarrantyMoved(brand) });
      expect(
        await ack(recipientFresh, write.operationId, writeItem.ticket),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      // Another face artifact served: the same.
      deploy(brand, { registry: registryWithArtifactChanged(brand) });
      expect(
        await ack(recipientFresh, write.operationId, writeItem.ticket),
      ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      expect(minted.mock.calls.length).toBe(mints);
      deploy(brand);

      // Another launch of the same session, and another session of the same
      // wallet: the ticket is this launch's and this session's only.
      const otherLaunch = afterLostCookies(
        brand,
        brand.recipient,
        recipientSession,
        "recover-j-other-launch",
      );
      expect(
        await ack(otherLaunch, write.operationId, writeItem.ticket),
      ).toMatchObject({ status: 400 });
      const otherSession = new Browser(
        brand,
        brand.recipient,
        launchOf(brand, "recover-j"),
      );
      expect(
        await ack(otherSession, write.operationId, writeItem.ticket),
      ).toMatchObject({ status: 400 });
      // A ticket for another operation id, and a forged one: refused.
      expect(
        await ack(
          recipientFresh,
          `case-write-${brand.tag}-0099`,
          writeItem.ticket,
        ),
      ).toMatchObject({ status: 400 });
      expect(
        await ack(recipientFresh, write.operationId, "not-a-ticket"),
      ).toMatchObject({ status: 400 });
      expect(runtimeOf(brand).acks.get(`warranty:${write.operationId}`)).toBe(
        undefined,
      );
      // The ticket itself still works where it was issued.
      expect(
        await ack(recipientFresh, write.operationId, writeItem.ticket),
      ).toMatchObject({
        status: 200,
        body: { acknowledged: true, first: true },
      });
      expect(faceSends(brand)).toBe(sendsBefore + 1);
      expect(businessOf()).toEqual(business);
    },
  );
});

describe("recovery: nothing is re-sent and every original record is preserved (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (g): after listing, acknowledging and replaying, each record is byte-identical and each face write was sent once",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const runtime = runtimeOf(brand);
      const contextId = await world0.recipient.select(brand.unit.id);
      const write = await heldWrite(world0.recipient, contextId, 10, {
        dispatch: true,
        caseIndex: 1,
      });
      const snapshot = () =>
        JSON.stringify({
          writes: [...runtime.writes.entries()],
          recoverables: [...runtime.recoverables.entries()],
          executed: world.dual.executed,
        });
      const before = snapshot();
      const business = businessOf();
      const sendsBefore = faceSends(brand);

      for (const [party, who] of [
        [brand.holder, "recover-g-holder"],
        [brand.recipient, "recover-g-recipient"],
      ] as const) {
        const session = (
          party === brand.holder ? world0.holder : world0.recipient
        ).cookies.get(SESSION_COOKIE)!;
        const fresh = afterLostCookies(brand, party, session, who);
        const listed = await fresh.recovery();
        expect(listed.body).toMatchObject({ supported: true, complete: true });
        for (const item of recoveredItems(listed.body)) {
          if (!item.ticket) continue;
          const first = await fresh.recoveryAck({
            operation_id: item.operation_id,
            ticket: item.ticket,
          });
          expect(first).toMatchObject({ status: 200, body: { first: true } });
          const replay = await fresh.recoveryAck({
            operation_id: item.operation_id,
            ticket: item.ticket,
          });
          expect(replay).toMatchObject({ status: 200, body: { first: false } });
        }
        // Everything acknowledged is gone from the next listing.
        const again = await fresh.recovery();
        expect(
          recoveredItems(again.body).filter((item) => item.ticket !== null),
        ).toEqual([]);
      }
      // The records, their receipts and Dual's history are as they were;
      // acknowledgements live beside them, one row per record.
      expect(snapshot()).toBe(before);
      expect(businessOf()).toEqual(business);
      for (const rows of runtime.acks.values()) expect(rows).toHaveLength(1);
      expect(faceSends(brand)).toBe(sendsBefore);
      // Each face write was sent exactly once in the whole journey.
      const sentWrites = runtime.calls
        .filter(
          (call) => call.by === "face" && WRITE_OPERATIONS.has(call.operation),
        )
        .map((call) => call.operationId);
      expect(new Set(sentWrites).size).toBe(sentWrites.length);
      expect(sentWrites).toContain(write.operationId);
    },
  );
});

describe("recovery: a transfer is told by who holds the unit now (PROPOSED r20 fixture)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s: the former owner's offer, request and transfer step read elsewhere, then registered once the unit is back and registered, held before that, and unread when the fresh read fails; outcomes, tickets and records unchanged",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const runtime = runtimeOf(brand);
      const snapshot = () =>
        JSON.stringify({
          writes: [...runtime.writes.entries()],
          recoverables: [...runtime.recoverables.entries()],
          acks: [...runtime.acks.entries()],
          executed: world.dual.executed,
        });
      const before = snapshot();
      const business = businessOf();
      const sendsBefore = faceSends(brand);
      const fresh = afterLostCookies(
        brand,
        brand.holder,
        world0.session,
        "holding",
      );
      const listing = async () => {
        const listed = await fresh.recovery();
        expect(listed.status).toBe(200);
        expect(listed.body).toMatchObject({ supported: true, complete: true });
        const body = listed.body;
        return {
          offer: recoveredItems(body).find(
            (item) => item.operation === "transfer.offer",
          ),
          request: itemOf(body, world0.requestOperation),
          custody: itemOf(body, world0.custodyOperation),
          registration: itemOf(body, world0.registration),
          settle: itemOf(body, world0.settleOperation),
        };
      };
      const expectHolding = (
        items: Awaited<ReturnType<typeof listing>>,
        holding: string | null,
      ) => {
        expect(items.offer).toMatchObject({
          outcome: "write_applied",
          holding,
        });
        expect(items.request).toMatchObject({
          outcome: "transfer_request_committed",
          holding,
        });
        expect(items.custody).toMatchObject({
          outcome: "transferred",
          holding,
        });
        // The proved outcome keeps its ticket whatever holds now.
        for (const item of [items.offer, items.request, items.custody]) {
          expect(typeof item!.ticket).toBe("string");
        }
        // A registration or settle says nothing of who holds the unit now.
        expect(items.registration).toMatchObject({ holding: null });
        expect(items.settle).toMatchObject({
          outcome: "registered",
          holding: null,
        });
      };

      // The holder's own transfer completed: the recipient holds the unit.
      expectHolding(await listing(), "elsewhere");

      // FIXTURE: the unit back in the holder's wallet with its record still
      // saying Transfer pending, then registered again. This stands in for
      // the recipient's return and the holder's registration of it, which
      // this listing does not depend on (only Dual's current projection).
      const unit = world.dual.units.get(brand.unit.id)!;
      unit.owner = brand.holder.address;
      expect(unit.custom).toMatchObject({ state: "Transfer pending" });
      expectHolding(await listing(), "held");
      unit.custom = {
        ...unit.custom,
        state: "Authenticity verified",
        lifecycle: { target_state: "Authenticity verified" },
      };
      expectHolding(await listing(), "registered");

      // The fresh read unavailable: nothing is guessed, the check is still
      // complete and every proved outcome keeps its own line and ticket.
      getObjectByIdPublic.mockImplementation(async () => {
        throw new ResponseError(new Response(null, { status: 503 }));
      });
      expectHolding(await listing(), null);

      // Read-only throughout: no record, receipt, acknowledgement or Dual
      // action changed, and nothing was sent again.
      expect(snapshot()).toBe(before);
      expect(businessOf()).toEqual(business);
      expect(faceSends(brand)).toBe(sendsBefore);
    },
  );
});

describe("recovery: a runtime without r20 fails closed (PROPOSED r20 fixture off)", () => {
  it.each(
    BRANDS.map((brand) => [brand.label, brand]) as Array<[string, Brand]>,
  )(
    "%s (i): the listing says unsupported, nothing is acknowledged, and today's retained path still answers",
    async (_label, brand) => {
      const world0 = await custodyRecoveryWorld(brand);
      const runtime = runtimeOf(brand);
      const fresh = afterLostCookies(
        brand,
        brand.holder,
        world0.session,
        "recover-i",
      );
      const ticketed = itemOf(
        (await fresh.recovery()).body,
        world0.custodyOperation,
      )!;
      runtime.r20 = false;
      const calls = runtime.calls.length;
      expect(await fresh.recovery()).toMatchObject({
        status: 200,
        body: { supported: false, items: [] },
      });
      // Legacy runtimes answered the two listing reads with their refusal;
      // nothing else was asked and nothing was acknowledged.
      expect(
        runtime.calls
          .slice(calls)
          .map((call) => [call.by, call.operation, call.status]),
      ).toEqual([
        ["wallet", "recovery.list", 400],
        ["wallet", "recovery.list", 400],
      ]);
      expect(
        await fresh.recoveryAck({
          operation_id: world0.custodyOperation,
          ticket: ticketed.ticket,
        }),
      ).toMatchObject({ status: 409, body: { code: "outcome_unknown" } });
      expect(runtime.acks.size).toBe(0);
      // The cookie-based retained listing is what this launch still has.
      expect(await fresh.list()).toMatchObject({
        status: 200,
        body: { operations: [], retained: [] },
      });
      expect(await world0.holder.list()).toMatchObject({ status: 200 });
    },
  );
});
