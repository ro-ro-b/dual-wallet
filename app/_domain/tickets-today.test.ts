import type { Ticket } from "@/app/_domain/tickets";
import {
  calendarDay,
  COMING_UP_LIMIT,
  DAY_CHECK_MAX_MS,
  ticketsToday,
  untilNextDayCheck,
} from "@/app/_domain/tickets-today";

let serial = 0;
function ticket(
  overrides: Partial<Ticket> & { startsAt?: string | null } = {},
) {
  const { startsAt = null, ...rest } = overrides;
  serial += 1;
  return {
    objectId: serial.toString(16).padStart(24, "0"),
    templateId: "b".repeat(24),
    clientId: "c".repeat(24),
    holder: "0x1234567890abcdef1234567890abcdef12345678",
    issueOperationId: "issue-op-0001",
    status: "issued",
    name: "Entry",
    event: { title: `Event ${serial}`, startsAt, venue: null },
    entryClass: null,
    entryGuidance: null,
    endedAs: null,
    entryWindow: null,
    admission: "unavailable",
    modifiedAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  } satisfies Ticket;
}

// 10:00 on 18 October 2026 in UTC; 21:00 the same day in Sydney (UTC+11).
const NOW = new Date("2026-10-18T10:00:00Z");

describe("calendarDay", () => {
  it("is the day in the given zone, not the machine's", () => {
    const instant = new Date("2026-10-18T13:30:00Z");
    expect(calendarDay(instant, "UTC")).toBe("2026-10-18");
    expect(calendarDay(instant, "Australia/Sydney")).toBe("2026-10-19");
    expect(calendarDay(instant, "America/Los_Angeles")).toBe("2026-10-18");
  });
});

describe("ticketsToday", () => {
  it("puts the same ticket in Today or Coming up by the viewer's own day", () => {
    // 00:30 on the 19th in Sydney; 13:30 on the 18th in UTC.
    const late = ticket({ startsAt: "2026-10-18T13:30:00Z" });
    const utc = ticketsToday([late], {
      now: NOW,
      timeZone: "UTC",
      partial: false,
    });
    expect(utc.today.map((t) => t.objectId)).toEqual([late.objectId]);
    expect(utc.comingUp).toEqual([]);
    const sydney = ticketsToday([late], {
      now: NOW,
      timeZone: "Australia/Sydney",
      partial: false,
    });
    expect(sydney.today).toEqual([]);
    expect(sydney.comingUp.map((t) => t.objectId)).toEqual([late.objectId]);
  });

  it("counts an event earlier today as today, and claims nothing for past or undated ones", () => {
    const earlierToday = ticket({ startsAt: "2026-10-18T01:00:00Z" });
    const yesterday = ticket({ startsAt: "2026-10-17T20:00:00Z" });
    const undated = ticket();
    const view = ticketsToday([earlierToday, yesterday, undated], {
      now: NOW,
      timeZone: "UTC",
      partial: false,
    });
    expect(view.today.map((t) => t.objectId)).toEqual([earlierToday.objectId]);
    // Past and undated tickets are not called ended, expired or ineligible:
    // they are simply not part of Today or Coming up.
    expect(view.comingUp).toEqual([]);
    expect(view.attention).toEqual([]);
  });

  it("dates a ticket by its event start, else by when its entry window opens", () => {
    const window = (startsAt: string | null) => ({
      startsAt,
      endsAt: null,
      closed: false,
    });
    // 22:30 at +11:00 is 11:30 UTC: today in Sydney.
    const opening = ticket({ entryWindow: window("2026-10-18T22:30+11:00") });
    // The event's own start wins over its window.
    const both = ticket({
      startsAt: "2026-10-20T08:00:00Z",
      entryWindow: window("2026-10-18T22:30+11:00"),
    });
    const undated = ticket({ entryWindow: window(null) });
    const view = ticketsToday([undated, both, opening], {
      now: NOW,
      timeZone: "Australia/Sydney",
      partial: false,
    });
    expect(view.today).toEqual([opening]);
    expect(view.comingUp).toEqual([both]);
    expect([...view.today, ...view.comingUp]).not.toContain(undated);
  });

  it("lists Coming up earliest first, bounded, from the tickets read only", () => {
    const days = ["2026-10-25", "2026-10-20", "2026-11-02", "2026-10-21"];
    const tickets = days.map((day) => ticket({ startsAt: `${day}T09:00:00Z` }));
    const view = ticketsToday(tickets, {
      now: NOW,
      timeZone: "UTC",
      partial: true,
    });
    expect(view.comingUp).toHaveLength(COMING_UP_LIMIT);
    expect(view.comingUp.map((t) => t.event.startsAt)).toEqual([
      "2026-10-20T09:00:00Z",
      "2026-10-21T09:00:00Z",
      "2026-10-25T09:00:00Z",
    ]);
    expect(view.partial).toBe(true);
  });

  it("needs attention only for a pending or unconfirmed ticket's own status, without repeating one shown above", () => {
    const pendingToday = ticket({
      status: "pending",
      startsAt: "2026-10-18T18:00:00Z",
    });
    const unconfirmed = ticket({
      status: "unconfirmed",
      issueOperationId: null,
    });
    const ended = ticket({ status: "ended" });
    const issued = ticket();
    const view = ticketsToday([pendingToday, unconfirmed, ended, issued], {
      now: NOW,
      timeZone: "UTC",
      partial: false,
    });
    expect(view.today.map((t) => t.objectId)).toEqual([pendingToday.objectId]);
    expect(view.attention.map((t) => t.objectId)).toEqual([
      unconfirmed.objectId,
    ]);
  });
});

describe("untilNextDayCheck", () => {
  it("waits until just past the viewer's own midnight, in their zone", () => {
    // 23:59:30 on 18 October in Sydney (AEDT, UTC+11).
    const late = new Date("2026-10-18T12:59:30Z");
    expect(untilNextDayCheck(late, "Australia/Sydney")).toBe(31_000);
    // The same instant is mid-afternoon in UTC: capped, checked again later.
    expect(untilNextDayCheck(late, "UTC")).toBe(DAY_CHECK_MAX_MS);
  });

  it("lands in the new day", () => {
    const late = new Date("2026-10-18T12:59:30Z");
    const fired = new Date(
      late.getTime() + untilNextDayCheck(late, "Australia/Sydney"),
    );
    expect(calendarDay(fired, "Australia/Sydney")).toBe("2026-10-19");
  });
});
