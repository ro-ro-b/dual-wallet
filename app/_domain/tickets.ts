// The Tickets journey's read-only projection (P4.2). Framework-free: the
// server adapter, the BFF routes and the wallet pages share these rules.
//
// A ticket is a Dual object the current holder owns, in the host's own
// organisation, from a template the face binding names. The binding's
// `tickets` rules say which custom paths hold the event facts, the issue
// operation identity and the state, and which states mean pending, issued or
// ended. Anything the rules cannot place is "unconfirmed", never issued, and
// the ticket's own `admission` stays "unavailable": no state is read as entry.
// With ticket-admission-v1 (P4.3) the admission target state reads only as
// "admission_recorded"; entry is confirmed only by the verified admission leg.
import { sameHolder } from "@/app/_domain/product-face";
import type { AdmissionRules } from "@/app/_domain/ticket-admission";

/** Dotted custom paths the binding assigns to each ticket fact. */
export interface TicketFieldRules {
  event: string;
  startsAt: string | null;
  venue: string | null;
  entryClass: string | null;
  entryGuidance: string | null;
  /** The original issue operation that produced the ticket. */
  issueOperation: string;
  state: string;
}

export interface TicketRules {
  fields: TicketFieldRules;
  states: { pending: string[]; issued: string[]; ended: string[] };
  /**
   * P4.3 ticket-admission-v1: present only when the binding states the
   * contract exactly; absent, entry is unavailable (P4.2 unchanged).
   */
  admission?: AdmissionRules;
}

/**
 * pending: the issue is recorded but not complete. issued: the holder holds
 * a valid ticket. ended: no longer usable (the brand's own ended states).
 * unconfirmed: the object's state or issue identity is not one the binding
 * recognises, so the wallet claims nothing. admission_recorded (only for a
 * binding with ticket-admission-v1): Dual's own state is the admission target.
 * That alone is never entry, nor "unconfirmed"; entry is confirmed only by the
 * runtime's request-bound verification (app/_domain/ticket-admission.ts).
 */
export type TicketStatus =
  "pending" | "issued" | "ended" | "unconfirmed" | "admission_recorded";

export interface Ticket {
  objectId: string;
  templateId: string;
  /** The Dual organisation that issued the ticket (the host's client). */
  clientId: string;
  /** The holder the wallet checked: the signed-in account's address. */
  holder: string;
  /** Null when the object records no valid issue operation identity. */
  issueOperationId: string | null;
  status: TicketStatus;
  name: string;
  event: {
    title: string;
    startsAt: string | null;
    venue: string | null;
  };
  entryClass: string | null;
  entryGuidance: string | null;
  /**
   * Which canonical end state an `ended` ticket is in, only when the object's
   * state is exactly Studio's `Cancelled` or `Expired` (cancel_ticket,
   * expire_ticket) and the binding lists it as ended. Null for any other
   * ended state and for every ticket that has not ended. It names the state
   * Dual records, never a reason.
   */
  endedAs: "cancelled" | "expired" | null;
  /**
   * When entry opens and closes, as the issuer wrote them (never the event's
   * start). For a ticket-admission-v1 binding both come from the closed
   * ticket template's keys (`admissionWindowStartsAt`, `admissionWindowEndsAt`,
   * the admission leg's own fields); a P4.2 binding that names
   * `admissionWindowStartsAt` gives the opening only, since its rules name no
   * end. `closed` says whether a known end had passed at this read: a derived
   * fact beside the canonical state, which it never changes (a closed window
   * is not `Expired`). Null when the wallet can verify neither time.
   */
  entryWindow: {
    startsAt: string | null;
    endsAt: string | null;
    closed: boolean;
  } | null;
  /**
   * No Dual state is ever read as entry, whatever the object says; with
   * ticket-admission-v1 entry comes only from the verified admission leg.
   */
  admission: "unavailable";
  modifiedAt: string;
}

export interface TicketPage {
  tickets: Ticket[];
  /** Opaque continuation, or null when every ticket has been listed. */
  next: string | null;
}

/** The object facts the projection reads, framework- and SDK-free. */
export interface TicketSource {
  objectId: string;
  templateId: string;
  orgId: string;
  owner: string;
  name: string;
  custom: Record<string, unknown>;
  modifiedAt: Date;
}

export type TicketRefusal = "not_in_programme" | "wrong_client" | "not_owned";

export type TicketEvaluation =
  { ok: true; ticket: Ticket } | { ok: false; refusal: TicketRefusal };

const ISSUE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_TEXT = 500;
// An instant exactly as the issuer wrote it: a full date, hours and minutes
// (Studio's canonical form, 2026-10-20T17:30+11:00), optional seconds and
// fraction, and an explicit offset. Nothing is coerced: no local time, no
// missing offset, and every part must be in range (see parseTicketTime). The
// instant is computed from these parts, never by a platform date parser.
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

// The closed ticket template's entry window. By contract these are when entry
// opens and closes, never the event's start: a binding that names one of them
// as `startsAt` gets no event start, and the time is shown as the window.
const ENTRY_WINDOW_KEYS: readonly string[] = [
  "admissionWindowStartsAt",
  "admissionWindowEndsAt",
];

function valueAt(custom: Record<string, unknown>, path: string): unknown {
  let current: unknown = custom;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Untrusted brand text shown as plain text: bounded, trimmed, no control
 * characters and no markup characters; anything else is absent.
 */
export function ticketText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  if (/[\u0000-\u001f\u007f<>]/.test(text)) return null;
  return text;
}

/** A ticket time's wall clock in its own stated offset, never the viewer's. */
export interface TicketWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** "Z", or the offset exactly as written ("+11:00"). */
  offset: string;
}

interface ParsedTicketTime extends TicketWallClock {
  second: number;
  millisecond: number;
  /** The offset east of UTC, in minutes. */
  offsetMinutes: number;
}

/**
 * A ticket time's parts, or null when the value is not one: the strict form
 * above with every part in range (a real calendar day, 00:00 to 23:59, an
 * offset within +/-14:00).
 */
function parseTicketTime(value: unknown): ParsedTicketTime | null {
  if (typeof value !== "string") return null;
  const match = ISO_TIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0").slice(0, 3));
  const offsetHours = match[9] ? Number(match[10]) : 0;
  const offsetPart = match[9] ? Number(match[11]) : 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetPart > 59 ||
    offsetHours * 60 + offsetPart > 14 * 60
  ) {
    return null;
  }
  const sign = match[9] === "-" ? -1 : 1;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    offset: match[8],
    offsetMinutes: sign * (offsetHours * 60 + offsetPart),
  };
}

/** The wall clock of a ticket time, in its own stated offset, or null. */
export function ticketWallClock(value: unknown): TicketWallClock | null {
  const parsed = parseTicketTime(value);
  if (!parsed) return null;
  const { year, month, day, hour, minute, offset } = parsed;
  return { year, month, day, hour, minute, offset };
}

/** The instant a ticket time names (ms since the epoch), or null. */
export function ticketInstant(value: unknown): number | null {
  const parsed = parseTicketTime(value);
  if (!parsed) return null;
  const { year, month, day, hour, minute, second, millisecond } = parsed;
  return (
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) -
    parsed.offsetMinutes * 60_000
  );
}

function ticketTime(value: unknown): string | null {
  return parseTicketTime(value) ? (value as string) : null;
}

function statusOf(
  state: unknown,
  issueOperationId: string | null,
  rules: TicketRules,
): TicketStatus {
  const { states } = rules;
  // An issued or pending claim needs the original issue operation.
  if (typeof state !== "string") return "unconfirmed";
  if (states.ended.includes(state)) return "ended";
  if (issueOperationId === null) return "unconfirmed";
  if (states.issued.includes(state)) return "issued";
  if (states.pending.includes(state)) return "pending";
  if (rules.admission?.targetStates.includes(state)) {
    return "admission_recorded";
  }
  return "unconfirmed";
}

/** Studio's two canonical ticket end states the wallet names. */
const ENDED_AS: Readonly<Record<string, "cancelled" | "expired">> = {
  Cancelled: "cancelled",
  Expired: "expired",
};

function endedAsOf(state: unknown, status: TicketStatus) {
  return status === "ended" &&
    typeof state === "string" &&
    Object.hasOwn(ENDED_AS, state)
    ? ENDED_AS[state]
    : null;
}

/**
 * The entry window, or null. The admission contract fixes where it is kept:
 * the closed ticket template's keys, its `admissionWindowStartsAt` and
 * `admissionWindowEndsAt`, all present. This is a read: an issuer's own keys
 * beside them (Dual's object may carry the issue's provenance) do not change
 * what those keys mean, so they do not hide the window. Every write still
 * needs exactly the closed template (checkAdmissionProposal). A P4.2 binding
 * that names `admissionWindowStartsAt` as its start gives the opening only
 * (its rules name no end). A window that ends before it opens is not shown.
 */
function entryWindowOf(
  custom: Record<string, unknown>,
  rules: TicketRules,
  now: number,
): Ticket["entryWindow"] {
  const keys = rules.admission?.customKeys ?? [];
  const closedTemplate =
    keys.length > 0 && keys.every((key) => Object.hasOwn(custom, key));
  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (closedTemplate) {
    startsAt = ticketTime(custom.admissionWindowStartsAt);
    endsAt = ticketTime(custom.admissionWindowEndsAt);
  } else if (rules.fields.startsAt === "admissionWindowStartsAt") {
    startsAt = ticketTime(valueAt(custom, "admissionWindowStartsAt"));
  }
  if (startsAt === null && endsAt === null) return null;
  const opens = ticketInstant(startsAt);
  const closes = ticketInstant(endsAt);
  if (opens !== null && closes !== null && closes <= opens) return null;
  return { startsAt, endsAt, closed: closes !== null && closes <= now };
}

/**
 * The read-only ticket for one object, or the reason the wallet refuses it.
 * The checks are the ones a holder-only view needs: the template belongs to
 * the programme, the object was issued by this host's organisation, and the
 * current account owns it.
 */
export function evaluateTicket(
  source: TicketSource,
  context: {
    holder: string;
    clientId: string;
    templateIds: readonly string[];
    rules: TicketRules;
    /** The time of this read, for the derived entry window only. */
    now?: number;
  },
): TicketEvaluation {
  if (!context.templateIds.includes(source.templateId)) {
    return { ok: false, refusal: "not_in_programme" };
  }
  if (source.orgId.toLowerCase() !== context.clientId.toLowerCase()) {
    return { ok: false, refusal: "wrong_client" };
  }
  if (!sameHolder(source.owner, context.holder)) {
    return { ok: false, refusal: "not_owned" };
  }
  const { fields } = context.rules;
  const issue = valueAt(source.custom, fields.issueOperation);
  const issueOperationId =
    typeof issue === "string" && ISSUE_OPERATION.test(issue) ? issue : null;
  const name = ticketText(source.name, 200) ?? source.objectId;
  const optional = (path: string | null) =>
    path === null ? null : valueAt(source.custom, path);
  const state = valueAt(source.custom, fields.state);
  const status = statusOf(state, issueOperationId, context.rules);
  return {
    ok: true,
    ticket: {
      objectId: source.objectId,
      templateId: source.templateId,
      clientId: source.orgId.toLowerCase(),
      holder: context.holder,
      issueOperationId,
      status,
      name,
      event: {
        title:
          ticketText(valueAt(source.custom, fields.event), 120) ??
          name.slice(0, 120),
        startsAt:
          fields.startsAt !== null &&
          ENTRY_WINDOW_KEYS.includes(fields.startsAt)
            ? null
            : ticketTime(optional(fields.startsAt)),
        venue: ticketText(optional(fields.venue), 120),
      },
      entryClass: ticketText(optional(fields.entryClass), 80),
      entryGuidance: ticketText(optional(fields.entryGuidance)),
      endedAs: endedAsOf(state, status),
      entryWindow: entryWindowOf(
        source.custom,
        context.rules,
        context.now ?? Date.now(),
      ),
      admission: "unavailable",
      modifiedAt: source.modifiedAt.toISOString(),
    },
  };
}

/** Ticket page cursor: which template and which upstream page to read next. */
export interface TicketCursor {
  templateIndex: number;
  next?: string;
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export function encodeTicketCursor(cursor: TicketCursor) {
  return btoa(JSON.stringify([cursor.templateIndex, cursor.next ?? null]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Strict: anything that is not exactly what encode produces is undefined. */
export function decodeTicketCursor(
  value: string,
  templateCount: number,
): TicketCursor | undefined {
  if (!CURSOR.test(value)) return undefined;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(padded));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [index, next] = parsed as [unknown, unknown];
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= templateCount ||
      (next !== null &&
        (typeof next !== "string" || !next || next.length > 300))
    ) {
      return undefined;
    }
    return next === null
      ? { templateIndex: index }
      : { templateIndex: index, next };
  } catch {
    return undefined;
  }
}

const STATUSES: readonly TicketStatus[] = [
  "pending",
  "issued",
  "ended",
  "unconfirmed",
  "admission_recorded",
];
const OBJECT_ID = /^[0-9a-f]{24}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const nullableText = (value: unknown, max: number) =>
  value === null ? null : ticketText(value, max);

/**
 * The browser's strict read of one ticket from the BFF. Anything that is not
 * exactly the projection above is undefined, so a changed or malformed body
 * is unavailable rather than shown.
 */
export function parseTicket(value: unknown): Ticket | undefined {
  if (!record(value) || !record(value.event)) return undefined;
  const { event } = value;
  const title = ticketText(event.title, 120);
  const name = ticketText(value.name, 200);
  const startsAt = event.startsAt === null ? null : ticketTime(event.startsAt);
  const venue = nullableText(event.venue, 120);
  const entryClass = nullableText(value.entryClass, 80);
  const entryGuidance = nullableText(value.entryGuidance, MAX_TEXT);
  const issue = value.issueOperationId;
  // Added later: an older server's ticket has neither key, read as null.
  const endedAs = value.endedAs ?? null;
  const window = value.entryWindow ?? null;
  const windowTime = (time: unknown) =>
    time === null ? null : (ticketTime(time) ?? undefined);
  // An older server's window carried only its end ({ endsAt, closed }).
  const windowKeys = record(window) ? Object.keys(window).sort().join() : "";
  const legacyWindow = windowKeys === "closed,endsAt";
  const windowStartsAt = !record(window)
    ? undefined
    : legacyWindow
      ? null
      : windowTime(window.startsAt);
  const windowEndsAt = record(window) ? windowTime(window.endsAt) : undefined;
  const entryWindow =
    window === null
      ? null
      : record(window) &&
          (legacyWindow || windowKeys === "closed,endsAt,startsAt") &&
          windowStartsAt !== undefined &&
          windowEndsAt !== undefined &&
          (windowStartsAt !== null || windowEndsAt !== null) &&
          typeof window.closed === "boolean" &&
          (window.closed === false || windowEndsAt !== null)
        ? {
            startsAt: windowStartsAt,
            endsAt: windowEndsAt,
            closed: window.closed,
          }
        : undefined;
  if (
    typeof value.objectId !== "string" ||
    !OBJECT_ID.test(value.objectId) ||
    typeof value.templateId !== "string" ||
    !OBJECT_ID.test(value.templateId) ||
    typeof value.clientId !== "string" ||
    !OBJECT_ID.test(value.clientId) ||
    typeof value.holder !== "string" ||
    !value.holder ||
    !(
      issue === null ||
      (typeof issue === "string" && ISSUE_OPERATION.test(issue))
    ) ||
    !STATUSES.includes(value.status as TicketStatus) ||
    !(
      endedAs === null ||
      ((endedAs === "cancelled" || endedAs === "expired") &&
        value.status === "ended")
    ) ||
    entryWindow === undefined ||
    value.admission !== "unavailable" ||
    typeof value.modifiedAt !== "string" ||
    !Number.isFinite(Date.parse(value.modifiedAt)) ||
    !title ||
    !name ||
    (event.startsAt !== null && startsAt === null) ||
    (event.venue !== null && venue === null) ||
    (value.entryClass !== null && entryClass === null) ||
    (value.entryGuidance !== null && entryGuidance === null)
  ) {
    return undefined;
  }
  return {
    objectId: value.objectId,
    templateId: value.templateId,
    clientId: value.clientId,
    holder: value.holder,
    issueOperationId: issue,
    status: value.status as TicketStatus,
    name,
    event: { title, startsAt, venue },
    entryClass,
    entryGuidance,
    endedAs,
    entryWindow,
    admission: "unavailable",
    modifiedAt: value.modifiedAt,
  };
}

export function parseTicketPage(value: unknown): TicketPage | undefined {
  if (!record(value) || !Array.isArray(value.tickets)) return undefined;
  const tickets = value.tickets.map(parseTicket);
  const next = value.next;
  if (
    tickets.some((ticket) => ticket === undefined) ||
    !(next === null || (typeof next === "string" && CURSOR.test(next)))
  ) {
    return undefined;
  }
  return { tickets: tickets as Ticket[], next };
}
