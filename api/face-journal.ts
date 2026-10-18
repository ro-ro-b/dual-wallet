import "server-only";

import { createHash } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { sealForPurpose, unsealForPurpose } from "@/api/server-session";
import {
  parseJournalEntry,
  pruneJournal,
  recoverableRegistration,
  sentAdmissionStep,
  sentTransferStep,
  type FaceJournalEntry,
} from "@/app/_domain/product-face-journal";
import { isObjectId } from "@/app/_domain/product-face";

const isProduction = process.env.NODE_ENV === "production";
const PURPOSE = "dual-face-journal-v2";
const CONTEXT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * A host-generated id for one face launch (one frame). Every launch keeps its
 * own journal cookie, so two tabs (or two frames) never overwrite each other.
 */
export const FACE_LAUNCH_ID = /^[A-Za-z0-9_-]{22,43}$/;
export const FACE_LAUNCH_HEADER = "x-dual-face-launch";

/** Live launch cookies kept per browser; the oldest beyond this are dropped. */
export const MAX_FACE_LAUNCHES = 4;
const LAUNCH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Outstanding (unexpired) assertions one launch may hold. A client-side
 * bound only; it is not idempotency. The runtime's one-time `jti`
 * consumption, its durable reservations and its unit-level single flight
 * decide what runs.
 */
export const MAX_OUTSTANDING_ASSERTIONS = 10;

/**
 * Durable discoveries one launch keeps of OTHER launches' held runtime
 * writes (FaceJournal.found); beyond this the oldest is forgotten, which
 * only makes that other launch's write count as held again.
 */
export const MAX_FOUND = 8;
const FOUND_KEY = /^[A-Za-z0-9_-]{43}$/;

/** Journal cookies are per launch: `<prefix><launch id>`. */
export const FACE_JOURNAL_COOKIE_PREFIX = isProduction
  ? "__Host-dual_face_launch_"
  : "dual_face_launch_";
/** The earlier session-wide journal cookie; cleared whenever it is seen. */
const LEGACY_JOURNAL_COOKIE = isProduction
  ? "__Host-dual_face_journal"
  : "dual_face_journal";

export const faceJournalCookieName = (launchId: string) =>
  `${FACE_JOURNAL_COOKIE_PREFIX}${launchId}`;

export interface FaceSelection {
  slug: string;
  objectId: string;
  contextId: string;
  at: number;
}

/**
 * One launch's journal: operation ids, hashes and phases, its current
 * selection and its outstanding mint expiries. No proposal, quote or other
 * content; no assertion, token or face-supplied text.
 */
export interface FaceJournal {
  entries: FaceJournalEntry[];
  /** At most one: the launch's current selection. */
  selections: FaceSelection[];
  /** Expiry times (ms) of assertions minted for this launch. */
  mints: number[];
  /**
   * Held runtime writes of OTHER launches of this wallet, face and
   * programme that a complete, validated recovery listing from the runtime
   * serving them named exactly (contract r20 §2), as foundKey values: their
   * records are in that runtime's durable, actor-scoped discovery, so the
   * launch budget may treat those launches as discoverable (never as
   * holding a write's only correlation). Never an outcome: nothing is
   * resolved, settled, re-sent or acknowledged by it. Absent when none.
   */
  found?: string[];
}

export interface FaceJournalOwner {
  sidHash: string;
  walletId: string;
}

export interface FaceJournalScope {
  owner: FaceJournalOwner;
  launchId: string;
  slug: string;
  programmeId: string;
}

type SealedEntry = Omit<FaceJournalEntry, "slug" | "programmeId">;

interface SealedJournal {
  v: 2;
  sid: string;
  wallet: string;
  launch: string;
  slug: string;
  programme: string;
  entries: SealedEntry[];
  selection: Omit<FaceSelection, "slug"> | null;
  mints: number[];
  found?: string[];
  at: number;
}

export const emptyFaceJournal = (): FaceJournal => ({
  entries: [],
  selections: [],
  mints: [],
});

function parseSelection(
  value: unknown,
  slug: string,
): FaceSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    !isObjectId(item.objectId) ||
    typeof item.contextId !== "string" ||
    !CONTEXT_ID.test(item.contextId) ||
    typeof item.at !== "number" ||
    !Number.isSafeInteger(item.at)
  ) {
    return undefined;
  }
  return {
    slug,
    objectId: item.objectId,
    contextId: item.contextId,
    at: item.at,
  };
}

const sealPurpose = (launchId: string) => `${PURPOSE}:${launchId}`;

/** The identity of one runtime write, as a held journal entry names it. */
export interface RuntimeWriteIdentity {
  operationId: string;
  operation: string;
  objectId: string;
  caseId?: string | null;
}

/**
 * One held runtime write's discovery key: its exact identity (operation id,
 * operation, unit and case) for one wallet, face and programme. Sealed in
 * the discovering launch's own cookie; no operation content.
 */
export function foundKey(
  walletId: string,
  slug: string,
  programmeId: string,
  write: RuntimeWriteIdentity,
) {
  return createHash("sha256")
    .update(
      [
        "dual-face-found-v1",
        walletId,
        slug,
        programmeId,
        write.operationId,
        write.operation,
        write.objectId,
        write.caseId ?? "",
      ].join("\n"),
    )
    .digest("base64url");
}

function parseFound(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter(
    (key): key is string => typeof key === "string" && FOUND_KEY.test(key),
  );
  return [...new Set(keys)].slice(-MAX_FOUND);
}

function unsealLaunch(
  launchId: string,
  value: string,
): Partial<SealedJournal> | undefined {
  if (!value || value.length > 4096) return undefined;
  const opened = unsealForPurpose(sealPurpose(launchId), value);
  return opened && typeof opened === "object" && !Array.isArray(opened)
    ? (opened as Partial<SealedJournal>)
    : undefined;
}

/**
 * Another launch's cookie, opened with its own launch id (the additional
 * data names it): a v2 journal sealed for exactly that launch, or undefined.
 */
function openLaunch(launchId: string, value: string) {
  if (!FACE_LAUNCH_ID.test(launchId)) return undefined;
  const opened = unsealLaunch(launchId, value);
  return opened?.v === 2 && opened.launch === launchId ? opened : undefined;
}

/** A sealed journal's entries, re-validated for its own face and programme. */
function sealedEntries(
  sealed: Partial<SealedJournal>,
  slug: string,
  programmeId: string,
  now: number,
) {
  if (!Array.isArray(sealed.entries)) return [];
  return pruneJournal(
    sealed.entries
      .map((entry) =>
        parseJournalEntry({ ...(entry as object), slug, programmeId }),
      )
      .filter((entry): entry is FaceJournalEntry => entry !== undefined),
    now,
  );
}

/**
 * Reads the journal of this launch, bound to this session, wallet and face.
 * A journal sealed for another session, wallet, face or launch — after
 * logout, expiry or an account change — reads as empty and is replaced on the
 * next write. (Only readFaceHistory looks at another launch's journal, for
 * one registration or one submitted transfer step of the same wallet,
 * read-only.)
 */
export function readFaceJournal(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
): FaceJournal {
  const cookie = request.cookies.get(
    faceJournalCookieName(scope.launchId),
  )?.value;
  const sealed = cookie ? unsealLaunch(scope.launchId, cookie) : undefined;
  if (
    !sealed ||
    sealed.v !== 2 ||
    sealed.sid !== scope.owner.sidHash ||
    sealed.wallet !== scope.owner.walletId ||
    sealed.launch !== scope.launchId ||
    sealed.slug !== scope.slug ||
    sealed.programme !== scope.programmeId ||
    !Array.isArray(sealed.entries)
  ) {
    return emptyFaceJournal();
  }
  const selection = parseSelection(sealed.selection, scope.slug);
  const found = parseFound(sealed.found);
  return {
    entries: sealedEntries(sealed, scope.slug, scope.programmeId, now),
    selections: selection ? [selection] : [],
    mints: Array.isArray(sealed.mints)
      ? sealed.mints.filter(
          (expiry): expiry is number =>
            typeof expiry === "number" && expiry > now,
        )
      : [],
    ...(found.length > 0 ? { found } : {}),
  };
}

/**
 * Registration (and submitted transfer step) history, read-only and for
 * exactly one operation: the entries
 * for `operationId` in this browser's OTHER launch journals that were sealed
 * for this same wallet, face and programme, by any session of that wallet
 * (a reload, another tab, or a sign-in since). The seal is authenticated
 * (AES-256-GCM, the launch id as additional data), so the wallet id in it is
 * the one the server wrote; another wallet's journals give nothing.
 *
 * This never rebinds: nothing found here joins this launch's journal, is
 * re-sealed or rewritten. The caller may only reconcile it read-only; it is
 * never a basis to mint, submit, settle or dispatch.
 */
export function readFaceHistory(
  request: NextRequest,
  scope: FaceJournalScope,
  operationId: string,
  now = Date.now(),
): FaceJournalEntry[] {
  return historyEntries(request, scope, now).filter(
    (entry) => entry.operationId === operationId,
  );
}

/**
 * The transfer steps this same wallet submitted from its OTHER launch
 * journals for this face and programme (a reload, another tab, a sign-in
 * since), under the same seal and wallet checks as readFaceHistory. A
 * sender whose step moved custody can no longer select or list that product,
 * so this is how the host finds the step again: read-only, never rebound,
 * re-sealed or rewritten, and never a basis to reserve, submit or execute.
 */
/**
 * P4.3: admission steps in this browser's OTHER launch journals of this same
 * wallet, face and programme (a reopened ticket page is a new launch). Read
 * only to follow their original operation read-only; never rewritten.
 */
export function readFaceAdmissionHistory(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
): FaceJournalEntry[] {
  return historyEntries(request, scope, now).filter(
    (entry) => entry.kind === "admission",
  );
}

export function readFaceTransferHistory(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
): FaceJournalEntry[] {
  return historyEntries(request, scope, now).filter(
    (entry) => entry.kind === "transfer",
  );
}

/**
 * The held runtime writes (an assertion issued, the runtime's record not
 * yet seen: heldRuntimeWrite) in this browser's OTHER launch journals of
 * this same wallet, face and programme, under the same seal and wallet
 * checks as readFaceHistory. Read only to name them to a recovery listing
 * of this launch (FaceJournal.found); never rebound, re-sealed, rewritten,
 * resolved or sent.
 */
export function readOtherHeldRuntimeWrites(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
): FaceJournalEntry[] {
  return historyEntries(request, scope, now).filter(heldRuntimeWrite);
}

function historyEntries(
  request: NextRequest,
  scope: FaceJournalScope,
  now: number,
): FaceJournalEntry[] {
  return launchCookies(request)
    .filter(([launchId]) => launchId !== scope.launchId)
    .flatMap(([launchId, value]) => {
      const sealed = openLaunch(launchId, value);
      if (
        !sealed ||
        sealed.wallet !== scope.owner.walletId ||
        sealed.slug !== scope.slug ||
        sealed.programme !== scope.programmeId
      ) {
        return [];
      }
      return sealedEntries(sealed, scope.slug, scope.programmeId, now);
    });
}

/**
 * Unresolved evidence that authority left the wallet and the wallet does not
 * know the outcome: (a) a registration whose one assertion was issued and is
 * not settled (recoverableRegistration), (b) a transfer step that was sent
 * and is not settled (sentTransferStep), or (c) a runtime write (Warranty &
 * Service writes, a transfer offer or its cancellation) whose assertion was
 * issued, whose outcome the wallet never learns. The launch cookie holding
 * it is the wallet's only record of it.
 */
function unresolvedEvidence(entry: FaceJournalEntry, found: Found = none) {
  return signedEvidence(entry) || (heldRuntimeWrite(entry) && !found(entry));
}

/**
 * Whether a launch of this wallet recorded a durable discovery of this held
 * runtime write (FaceJournal.found): it then counts as discoverable.
 */
type Found = (entry: FaceJournalEntry) => boolean;
const none: Found = () => false;

/**
 * (a) and (b): the wallet's only record that a holder-signed Dual action may
 * have been issued or sent. Never dropped by the budget: a cookie-based
 * recovery reads it back, and nothing else can.
 */
function signedEvidence(entry: FaceJournalEntry) {
  return (
    (recoverableRegistration(entry) && entry.phase !== "settled") ||
    sentTransferStep(entry) ||
    // P4.3: an admission step that left the wallet, outcome not yet read.
    sentAdmissionStep(entry)
  );
}

/**
 * (c): a runtime write whose assertion was issued and whose record the exact
 * runtime has NOT confirmed it holds: this cookie is its only known
 * correlation, so it is never dropped (no unknown eviction), on a legacy
 * runtime for as long as the cookie lives.
 */
function heldRuntimeWrite(entry: FaceJournalEntry) {
  return (
    entry.kind === "runtime" &&
    entry.phase === "assertion_issued" &&
    entry.discoverable !== true
  );
}

/**
 * A runtime write the exact runtime confirmed it holds durably
 * (`discoverable`, contract r20, marked in its own launch or recorded found
 * by another launch of the same wallet): recoverable from the runtime's own
 * record for this actor, so its cookie is expendable. Kept ahead of
 * finished and empty launches, dropped before nothing else.
 */
function discoverableRuntimeWrite(
  entry: FaceJournalEntry,
  found: Found = none,
) {
  return (
    entry.kind === "runtime" &&
    entry.phase === "assertion_issued" &&
    (entry.discoverable === true || found(entry))
  );
}

/** Rank of a launch holding evidence that is never dropped. */
const SIGNED_RANK = 3;
/** Rank of a launch holding only discoverable runtime writes: dropped last. */
const RUNTIME_WRITE_RANK = 2;

/** A sealed journal's entries, re-validated for the face it was sealed for. */
function ownEntries(sealed: Partial<SealedJournal>, now: number) {
  return typeof sealed.slug === "string" && typeof sealed.programme === "string"
    ? sealedEntries(sealed, sealed.slug, sealed.programme, now)
    : [];
}

/**
 * Whether an earlier session's sealed journal is still worth keeping for the
 * same wallet: it holds a registration whose one assertion was issued (open,
 * or settled since: a result page still reads it back), or any unresolved
 * evidence (unresolvedEvidence). After a sign-in since, it is the only record
 * such an operation is read back from (readFaceHistory,
 * readFaceTransferHistory).
 */
function holdsUnresolvedHistory(
  sealed: Partial<SealedJournal>,
  now: number,
  found: Found = none,
) {
  return ownEntries(sealed, now).some(
    (entry) =>
      recoverableRegistration(entry) || unresolvedEvidence(entry, found),
  );
}

/**
 * How much a kept launch's sealed journal is worth keeping, within the same
 * MAX_FACE_LAUNCHES budget: unresolved evidence that authority left the
 * wallet (3: unresolvedEvidence, that is (a), (b) and an unconfirmed (c)),
 * never dropped (launchWouldDropUnresolved); then a launch holding only
 * discoverable runtime writes (2), dropped last; then any other unfinished
 * work (1); then an empty or finished launch (0). Every face-host mount
 * persists a new, usually empty, launch; recency alone would let those evict
 * the evidence a result page or a progress read is still reading.
 */
function retentionRank(
  sealed: Partial<SealedJournal>,
  now: number,
  found: Found = none,
) {
  const entries = ownEntries(sealed, now);
  if (entries.some((entry) => unresolvedEvidence(entry, found))) {
    return SIGNED_RANK;
  }
  if (entries.some((entry) => discoverableRuntimeWrite(entry, found))) {
    return RUNTIME_WRITE_RANK;
  }
  return entries.some(
    (entry) => entry.phase !== "settled" && entry.phase !== "cancelled",
  )
    ? 1
    : 0;
}

interface LaunchRetention {
  launchId: string;
  /** Last write (ms); -1 when not kept (unreadable, another wallet's, ...). */
  at: number;
  rank: number;
  order: number;
}

/**
 * The other launches in the request, ordered most worth keeping first, as
 * writeFaceJournal keeps them: this session's, and this wallet's earlier
 * sessions' that still hold unresolved history (holdsUnresolvedHistory).
 * Anything else (unreadable, another wallet's, an earlier session's without
 * such history) is marked not kept (at -1). Within the budget the least worth
 * keeping goes first (retentionRank), the oldest within a rank.
 * Two launches last written in the same millisecond are ordered by the
 * request: a browser sends its cookies oldest-created first (RFC 6265 5.4;
 * an update keeps its place), so the later one is the newer.
 */
function otherLaunches(
  request: NextRequest,
  scope: FaceJournalScope,
  now: number,
  found: readonly string[] = [],
): LaunchRetention[] {
  const discovered = foundMarkers(request, scope, found);
  return launchCookies(request)
    .filter(([launchId]) => launchId !== scope.launchId)
    .map(([launchId, value], order) => {
      const opened = openLaunch(launchId, value);
      const wallet = opened?.wallet;
      const isFound: Found = (entry) =>
        typeof wallet === "string" &&
        discovered.has(foundKey(wallet, entry.slug, entry.programmeId, entry));
      const kept =
        opened?.wallet === scope.owner.walletId &&
        (opened.sid === scope.owner.sidHash ||
          holdsUnresolvedHistory(opened, now, isFound));
      return {
        launchId,
        at: kept && typeof opened.at === "number" ? opened.at : -1,
        rank: kept ? retentionRank(opened, now, isFound) : -1,
        order,
      };
    })
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        right.at - left.at ||
        right.order - left.order,
    );
}

/**
 * Every durable discovery this wallet's launches recorded (their own sealed
 * FaceJournal.found, this launch's included), plus `extra`: the journal
 * this launch is about to write.
 */
function foundMarkers(
  request: NextRequest,
  scope: FaceJournalScope,
  extra: readonly string[],
) {
  const found = new Set(parseFound(extra));
  for (const [launchId, value] of launchCookies(request)) {
    const opened = openLaunch(launchId, value);
    if (opened?.wallet !== scope.owner.walletId) continue;
    for (const key of parseFound(opened.found)) found.add(key);
  }
  return found;
}

/** Whether the budget would drop this launch (not counting unresolved ones). */
const overBudget = (other: LaunchRetention, index: number) =>
  other.at < 0 || index >= MAX_FACE_LAUNCHES - 1;

/** This wallet's launch holding evidence that is never dropped. */
const holdsUnresolved = (other: LaunchRetention) =>
  other.at >= 0 && other.rank === SIGNED_RANK;

/**
 * What a launch may do with its journal (contract: no unknown eviction, and
 * read-only access when write capacity is blocked). A launch that already
 * has a cookie keeps it. A new launch gets one only if the budget can make
 * room without dropping a launch holding never-dropped evidence; otherwise
 * it runs read-only: it opens and reads, nothing of it is persisted, and
 * every request that would have to journal is refused launch_capacity.
 * `found`: the durable discoveries the journal about to be written records
 * (FaceJournal.found), counted with those already sealed.
 */
export function launchCapacity(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
  found: readonly string[] = [],
): "full" | "read_only" {
  if (request.cookies.has(faceJournalCookieName(scope.launchId))) return "full";
  return launchWouldDropUnresolved(request, scope, now, found)
    ? "read_only"
    : "full";
}

/**
 * Whether writing this launch's journal would need to drop another launch of
 * this wallet that holds unresolved evidence (unresolvedEvidence) to stay
 * within MAX_FACE_LAUNCHES. It reproduces writeFaceJournal's keep, sort and
 * drop decision for this request. The face routes refuse such a request
 * (launch_capacity) before any work: nothing is read, minted, journaled or
 * sent. An existing launch's own cookie is not among the others, so normally
 * only a new launch is refused. A held runtime write that a launch of this
 * wallet recorded found (FaceJournal.found) counts as discoverable. Pure: it
 * reads the request (and `found`) only.
 */
export function launchWouldDropUnresolved(
  request: NextRequest,
  scope: FaceJournalScope,
  now = Date.now(),
  found: readonly string[] = [],
) {
  return otherLaunches(request, scope, now, found).some(
    (other, index) => overBudget(other, index) && holdsUnresolved(other),
  );
}

function cookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict" as const,
    path: "/",
    ...(maxAge === undefined ? { expires: new Date(0) } : { maxAge }),
  };
}

/** Launch journal cookies in the request: [launch id, sealed value]. */
function launchCookies(request: NextRequest) {
  return request.cookies
    .getAll()
    .filter((cookie) => cookie.name.startsWith(FACE_JOURNAL_COOKIE_PREFIX))
    .map(
      (cookie) =>
        [
          cookie.name.slice(FACE_JOURNAL_COOKIE_PREFIX.length),
          cookie.value,
        ] as const,
    );
}

export function writeFaceJournal(
  response: NextResponse,
  request: NextRequest,
  scope: FaceJournalScope,
  journal: FaceJournal,
  now = Date.now(),
): { persisted: boolean } {
  // A read-only launch (launchCapacity): nothing of it is persisted and no
  // other launch is touched, so no never-dropped evidence can be lost. The
  // durable discoveries this journal records count (FaceJournal.found): a
  // new launch whose listing found the held writes pinning the budget gets
  // its cookie, and only such a now-discoverable launch makes room.
  const found = parseFound(journal.found);
  if (launchCapacity(request, scope, now, found) === "read_only") {
    return { persisted: false };
  }
  const selection = journal.selections.find((item) => item.slug === scope.slug);
  const sealed: SealedJournal = {
    v: 2,
    sid: scope.owner.sidHash,
    wallet: scope.owner.walletId,
    launch: scope.launchId,
    slug: scope.slug,
    programme: scope.programmeId,
    // The face and programme are the launch's own; entries do not repeat them.
    entries: journal.entries.map((entry) => {
      const rest: Partial<FaceJournalEntry> = { ...entry };
      delete rest.slug;
      delete rest.programmeId;
      return rest as SealedEntry;
    }),
    selection: selection
      ? {
          objectId: selection.objectId,
          contextId: selection.contextId,
          at: selection.at,
        }
      : null,
    mints: journal.mints,
    ...(found.length > 0 ? { found } : {}),
    at: now,
  };
  response.cookies.set(
    faceJournalCookieName(scope.launchId),
    sealForPurpose(sealPurpose(scope.launchId), sealed),
    cookieOptions(LAUNCH_TTL_SECONDS),
  );
  // Keep at most MAX_FACE_LAUNCHES launches (otherLaunches decides which are
  // kept and in what order). A kept cookie is never named in this response:
  // not re-sealed, rewritten or given a new expiry; its own 24 hours still
  // apply. A launch of this wallet holding unresolved evidence is never
  // dropped, even over budget: the face routes refuse a request that would
  // need that before any work (launchWouldDropUnresolved, launch_capacity),
  // so skipping it here is defence in depth and not reached in practice.
  // Unreadable and other wallets' cookies are still dropped.
  otherLaunches(request, scope, now, found).forEach((other, index) => {
    if (overBudget(other, index) && !holdsUnresolved(other)) {
      response.cookies.set(
        `${FACE_JOURNAL_COOKIE_PREFIX}${other.launchId}`,
        "",
        cookieOptions(),
      );
    }
  });
  if (request.cookies.get(LEGACY_JOURNAL_COOKIE)) {
    response.cookies.set(LEGACY_JOURNAL_COOKIE, "", cookieOptions());
  }
  return { persisted: true };
}

/** Clears every launch journal (and the earlier session-wide one). */
export function clearFaceJournal(response: NextResponse, request: NextRequest) {
  for (const [launchId] of launchCookies(request)) {
    response.cookies.set(
      `${FACE_JOURNAL_COOKIE_PREFIX}${launchId}`,
      "",
      cookieOptions(),
    );
  }
  response.cookies.set(LEGACY_JOURNAL_COOKIE, "", cookieOptions());
}

export function currentSelection(journal: FaceJournal, slug: string) {
  return journal.selections.find((selection) => selection.slug === slug);
}

export function withSelection(
  journal: FaceJournal,
  selection: FaceSelection | { slug: string; cleared: true },
): FaceJournal {
  return {
    ...journal,
    selections: "cleared" in selection ? [] : [selection],
  };
}

export function isFaceSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}
