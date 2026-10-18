// The Tickets journey's read-only projection (P4.2). Framework-free: the
// server adapter, the BFF routes and the wallet pages share these rules.
//
// A ticket is a Dual object the current holder owns, in the host's own
// organisation, from a template the face binding names. The binding's
// `tickets` rules say which custom paths hold the event facts, the issue
// operation identity and the state, and which states mean pending, issued or
// ended. Anything the rules cannot place is "unconfirmed", never issued, and
// admission is a constant "unavailable" until P4.3: no state is read as one.
import { sameHolder } from "@/app/_domain/product-face";

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
}

/**
 * pending: the issue is recorded but not complete. issued: the holder holds
 * a valid ticket. ended: no longer usable (the brand's own ended states).
 * unconfirmed: the object's state or issue identity is not one the binding
 * recognises, so the wallet claims nothing.
 */
export type TicketStatus = "pending" | "issued" | "ended" | "unconfirmed";

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
  /** Admission is not part of Tickets until P4.3, whatever the object says. */
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
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function ticketTime(value: unknown): string | null {
  return typeof value === "string" &&
    ISO_TIME.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function statusOf(
  state: unknown,
  issueOperationId: string | null,
  states: TicketRules["states"],
): TicketStatus {
  // An issued or pending claim needs the original issue operation.
  if (typeof state !== "string") return "unconfirmed";
  if (states.ended.includes(state)) return "ended";
  if (issueOperationId === null) return "unconfirmed";
  if (states.issued.includes(state)) return "issued";
  if (states.pending.includes(state)) return "pending";
  return "unconfirmed";
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
  const { fields, states } = context.rules;
  const issue = valueAt(source.custom, fields.issueOperation);
  const issueOperationId =
    typeof issue === "string" && ISSUE_OPERATION.test(issue) ? issue : null;
  const name = ticketText(source.name, 200) ?? source.objectId;
  const optional = (path: string | null) =>
    path === null ? null : valueAt(source.custom, path);
  return {
    ok: true,
    ticket: {
      objectId: source.objectId,
      templateId: source.templateId,
      clientId: source.orgId.toLowerCase(),
      holder: context.holder,
      issueOperationId,
      status: statusOf(
        valueAt(source.custom, fields.state),
        issueOperationId,
        states,
      ),
      name,
      event: {
        title:
          ticketText(valueAt(source.custom, fields.event), 120) ??
          name.slice(0, 120),
        startsAt: ticketTime(optional(fields.startsAt)),
        venue: ticketText(optional(fields.venue), 120),
      },
      entryClass: ticketText(optional(fields.entryClass), 80),
      entryGuidance: ticketText(optional(fields.entryGuidance)),
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
