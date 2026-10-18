// The Today-first home's view of the holder's tickets (P4.2). Framework-free.
//
// It reads only the tickets already listed (the first Tickets page), so it
// never claims a global nearest, count or completeness: `partial` says when
// more tickets may exist. "Today" is the viewer's own calendar day in an
// explicit IANA time zone, the same zone the home displays times in. A
// missing or past start time is not shown here and claims nothing (not ended,
// not expired, not ineligible): those tickets stay in the full list.
import type { Ticket } from "@/app/_domain/tickets";

export interface TicketsToday {
  /** Starting on the viewer's calendar day, earliest first. */
  today: Ticket[];
  /** Starting on a later day, earliest first, at most COMING_UP_LIMIT. */
  comingUp: Ticket[];
  /**
   * Pending or unconfirmed tickets not already shown above, at most
   * ATTENTION_LIMIT: the canonical object's own status, never inferred.
   */
  attention: Ticket[];
  /** More tickets may exist beyond the ones read. */
  partial: boolean;
}

export const COMING_UP_LIMIT = 3;
export const ATTENTION_LIMIT = 3;

/**
 * The calendar day of an instant in a time zone, as YYYY-MM-DD. Read from
 * typed parts with Latin digits, so the result does not depend on a locale.
 */
export function calendarDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    numberingSystem: "latn",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The longest a long-lived home waits before checking the day again. */
export const DAY_CHECK_MAX_MS = 60 * 60 * 1000;

/**
 * How long until the viewer's calendar day (in `timeZone`) next ends, capped
 * at DAY_CHECK_MAX_MS so a 23- or 25-hour day around a clock change is
 * corrected within the hour; at least one second. Callers check the day again
 * when it fires rather than assuming it changed.
 */
export function untilNextDayCheck(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    numberingSystem: "latn",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  const elapsed =
    ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 +
    now.getMilliseconds();
  // One second past the boundary, so the check lands in the new day.
  const remaining = 86_400_000 - elapsed + 1000;
  return Math.min(Math.max(remaining, 1000), DAY_CHECK_MAX_MS);
}

const byStart = (a: Ticket, b: Ticket) =>
  Date.parse(a.event.startsAt!) - Date.parse(b.event.startsAt!) ||
  a.objectId.localeCompare(b.objectId);

export function ticketsToday(
  tickets: readonly Ticket[],
  { now, timeZone, partial }: { now: Date; timeZone: string; partial: boolean },
): TicketsToday {
  const todayKey = calendarDay(now, timeZone);
  const dated = tickets.filter((ticket) => ticket.event.startsAt !== null);
  const dayOf = (ticket: Ticket) =>
    calendarDay(new Date(ticket.event.startsAt!), timeZone);
  const today = dated.filter((ticket) => dayOf(ticket) === todayKey);
  const comingUp = dated
    .filter((ticket) => dayOf(ticket) > todayKey)
    .sort(byStart)
    .slice(0, COMING_UP_LIMIT);
  const shown = new Set([...today, ...comingUp].map((t) => t.objectId));
  const attention = tickets
    .filter(
      (ticket) =>
        (ticket.status === "pending" || ticket.status === "unconfirmed") &&
        !shown.has(ticket.objectId),
    )
    .slice(0, ATTENTION_LIMIT);
  return { today: today.sort(byStart), comingUp, attention, partial };
}
