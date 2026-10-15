import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { sealForPurpose, unsealForPurpose } from "@/api/server-session";
import {
  parseJournalEntry,
  pruneJournal,
  recoverableRegistration,
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
 * one registration of the same wallet, read-only.)
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
  return {
    entries: sealedEntries(sealed, scope.slug, scope.programmeId, now),
    selections: selection ? [selection] : [],
    mints: Array.isArray(sealed.mints)
      ? sealed.mints.filter(
          (expiry): expiry is number =>
            typeof expiry === "number" && expiry > now,
        )
      : [],
  };
}

/**
 * Registration history, read-only and for exactly one operation: the entries
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
      return sealedEntries(sealed, scope.slug, scope.programmeId, now).filter(
        (entry) => entry.operationId === operationId,
      );
    });
}

/** Whether a sealed journal still holds a recoverable registration. */
function holdsRegistrationHistory(sealed: Partial<SealedJournal>, now: number) {
  return (
    typeof sealed.slug === "string" &&
    typeof sealed.programme === "string" &&
    sealedEntries(sealed, sealed.slug, sealed.programme, now).some(
      recoverableRegistration,
    )
  );
}

/**
 * How much a kept launch's sealed journal is worth keeping, within the same
 * MAX_FACE_LAUNCHES budget: unresolved evidence that a registration's one
 * assertion left the wallet first (2), then any other unfinished work (1),
 * then an empty or finished launch (0). Every face-host mount persists a new,
 * usually empty, launch; recency alone would let those evict the evidence a
 * result page is still reading.
 */
function retentionRank(sealed: Partial<SealedJournal>, now: number) {
  if (typeof sealed.slug !== "string" || typeof sealed.programme !== "string")
    return 0;
  const entries = sealedEntries(sealed, sealed.slug, sealed.programme, now);
  const unfinished = (entry: FaceJournalEntry) =>
    entry.phase !== "settled" && entry.phase !== "cancelled";
  if (
    entries.some((entry) => recoverableRegistration(entry) && unfinished(entry))
  )
    return 2;
  return entries.some(unfinished) ? 1 : 0;
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
) {
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
    at: now,
  };
  response.cookies.set(
    faceJournalCookieName(scope.launchId),
    sealForPurpose(sealPurpose(scope.launchId), sealed),
    cookieOptions(LAUNCH_TTL_SECONDS),
  );
  // Keep at most MAX_FACE_LAUNCHES launches: this session's, and this
  // wallet's earlier sessions' that still hold a registration whose one
  // assertion was issued (their sealed evidence, kept as it is, never
  // re-sealed). Anything else (unreadable, another wallet's, an earlier
  // session's without such history) is dropped; within the budget the
  // least worth keeping goes first (retentionRank), the oldest within a rank.
  // Two launches last written in the same millisecond are ordered by the
  // request: a browser sends its cookies oldest-created first (RFC 6265
  // 5.4; an update keeps its place), so the later one is the newer.
  const others = launchCookies(request)
    .filter(([launchId]) => launchId !== scope.launchId)
    .map(([launchId, value], order) => {
      const opened = openLaunch(launchId, value);
      const kept =
        opened?.wallet === scope.owner.walletId &&
        (opened.sid === scope.owner.sidHash ||
          holdsRegistrationHistory(opened, now));
      return {
        launchId,
        at: kept && typeof opened.at === "number" ? opened.at : -1,
        rank: kept ? retentionRank(opened, now) : -1,
        order,
      };
    })
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        right.at - left.at ||
        right.order - left.order,
    );
  others.forEach((other, index) => {
    if (other.at < 0 || index >= MAX_FACE_LAUNCHES - 1) {
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
