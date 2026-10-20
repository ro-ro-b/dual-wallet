import {
  ADMISSION_CUSTOM_KEYS,
  parseAdmissionRules,
} from "@/app/_domain/ticket-admission";
import {
  decodeTicketCursor,
  encodeTicketCursor,
  evaluateTicket,
  parseTicket,
  parseTicketPage,
  ticketInstant,
  ticketText,
  ticketWallClock,
  type TicketRules,
  type TicketSource,
} from "@/app/_domain/tickets";

const RULES: TicketRules = {
  fields: {
    event: "event.title",
    startsAt: null,
    venue: null,
    entryClass: null,
    entryGuidance: null,
    issueOperation: "issue.op",
    state: "state",
  },
  states: { pending: ["Issuing"], issued: ["Issued"], ended: ["Cancelled"] },
};
const HOLDER = "0xAbC0000000000000000000000000000000000001";
const CLIENT = "a".repeat(24);
const TEMPLATE = "b".repeat(24);
const context = {
  holder: HOLDER,
  clientId: CLIENT,
  templateIds: [TEMPLATE],
  rules: RULES,
};
const source = (overrides: Partial<TicketSource> = {}): TicketSource => ({
  objectId: "c".repeat(24),
  templateId: TEMPLATE,
  orgId: CLIENT,
  owner: HOLDER.toLowerCase(),
  name: "Entry",
  custom: {
    event: { title: "Show" },
    issue: { op: "op-0001" },
    state: "Issued",
  },
  modifiedAt: new Date("2026-10-01T00:00:00Z"),
  ...overrides,
});

describe("evaluateTicket", () => {
  it("refuses wrong programme, client and holder, in that order", () => {
    expect(
      evaluateTicket(source({ templateId: "d".repeat(24) }), context),
    ).toEqual({
      ok: false,
      refusal: "not_in_programme",
    });
    expect(evaluateTicket(source({ orgId: "e".repeat(24) }), context)).toEqual({
      ok: false,
      refusal: "wrong_client",
    });
    expect(evaluateTicket(source({ owner: "0xother" }), context)).toEqual({
      ok: false,
      refusal: "not_owned",
    });
  });

  it.each([
    ["Issued", "op-0001", "issued"],
    ["Issuing", "op-0001", "pending"],
    ["Cancelled", "op-0001", "ended"],
    // Ended is honest even when the issue identity is missing.
    ["Cancelled", undefined, "ended"],
    ["Issued", undefined, "unconfirmed"],
    ["Issuing", "bad id!", "unconfirmed"],
    ["Admitted", "op-0001", "unconfirmed"],
    [undefined, "op-0001", "unconfirmed"],
  ])("state %s with issue %s is %s", (state, issue, status) => {
    const evaluated = evaluateTicket(
      source({
        custom: {
          event: { title: "Show" },
          issue: issue === undefined ? {} : { op: issue },
          ...(state === undefined ? {} : { state }),
        },
      }),
      context,
    );
    expect(evaluated.ok && evaluated.ticket.status).toBe(status);
    expect(evaluated.ok && evaluated.ticket.admission).toBe("unavailable");
  });

  describe("with ticket-admission-v1 (P4.3)", () => {
    const admission = parseAdmissionRules({
      contract: "ticket-admission-v1",
      action: "update",
      inputPath: "data.custom",
      leaves: {
        state: { enum: ["Admitted"] },
        admissionStatus: { enum: ["Admitted"] },
        operation_id: { runtimeIssued: "^op_[0-9a-f]{40}$" },
        idempotency_key: {
          runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$",
        },
      },
      customKeys: [...ADMISSION_CUSTOM_KEYS],
      fromStates: ["Valid"],
      targetStates: ["Admitted"],
      preserveUnlisted: true,
    });
    const rules: TicketRules = {
      ...RULES,
      states: { pending: [], issued: ["Valid"], ended: ["Cancelled"] },
      admission: admission!,
    };
    const status = (state: string, issue?: string) => {
      const evaluated = evaluateTicket(
        source({
          custom: {
            event: { title: "Show" },
            issue: issue === undefined ? {} : { op: issue },
            state,
          },
        }),
        { ...context, rules },
      );
      return evaluated.ok ? evaluated.ticket : null;
    };

    it("reads the admission target as recorded, never as entry or issued", () => {
      expect(admission).toBeTruthy();
      expect(status("Admitted", "op-0001")).toMatchObject({
        status: "admission_recorded",
        // Dual's own state is never entry, with or without the contract.
        admission: "unavailable",
      });
      expect(status("Valid", "op-0001")?.status).toBe("issued");
      expect(status("Cancelled", "op-0001")?.status).toBe("ended");
    });

    it("still needs the issue identity, and states outside the rules stay unconfirmed", () => {
      expect(status("Admitted")?.status).toBe("unconfirmed");
      expect(status("Checked-in", "op-0001")?.status).toBe("unconfirmed");
    });

    it("a legacy binding (no admission block) keeps Admitted unconfirmed", () => {
      const legacy = evaluateTicket(
        source({
          custom: {
            event: { title: "Show" },
            issue: { op: "op-0001" },
            state: "Admitted",
          },
        }),
        {
          ...context,
          rules: { ...rules, admission: undefined },
        },
      );
      expect(legacy.ok && legacy.ticket.status).toBe("unconfirmed");
    });

    it("round-trips through the wire parser", () => {
      const ticket = status("Admitted", "op-0001");
      expect(parseTicket(JSON.parse(JSON.stringify(ticket)))).toEqual(ticket);
    });
  });

  it("reads only own properties, not the prototype chain", () => {
    const evaluated = evaluateTicket(
      source({ custom: Object.create({ state: "Issued" }) }),
      context,
    );
    expect(evaluated.ok && evaluated.ticket.status).toBe("unconfirmed");
  });
});

describe("ticketText", () => {
  it.each([
    [" padded ", "padded"],
    ["", null],
    ["a<b", null],
    ["tab\tinside", null],
    ["x".repeat(501), null],
    [42, null],
  ])("%j -> %j", (input, expected) => {
    expect(ticketText(input)).toBe(expected);
  });
});

describe("the ticket cursor", () => {
  it("round-trips and refuses anything it did not produce", () => {
    const cursor = { templateIndex: 1, next: "up/stream+==" };
    expect(decodeTicketCursor(encodeTicketCursor(cursor), 2)).toEqual(cursor);
    expect(
      decodeTicketCursor(encodeTicketCursor({ templateIndex: 0 }), 2),
    ).toEqual({
      templateIndex: 0,
    });
    // A template index the programme does not have.
    expect(decodeTicketCursor(encodeTicketCursor(cursor), 1)).toBeUndefined();
    for (const bad of [
      "",
      "***",
      "bm90",
      btoa("[1]"),
      btoa('["a",null]'),
      btoa("[-1,null]"),
    ]) {
      expect(decodeTicketCursor(bad, 2)).toBeUndefined();
    }
  });
});

describe("the browser's read of a ticket", () => {
  const evaluated = evaluateTicket(source(), context);
  const wire = JSON.parse(
    JSON.stringify(evaluated.ok ? evaluated.ticket : null),
  );

  it("accepts exactly what the server projects", () => {
    expect(parseTicket(wire)).toEqual(wire);
    expect(
      parseTicketPage({ tickets: [wire], next: null })?.tickets,
    ).toHaveLength(1);
  });

  it.each([
    ["admission claimed", { admission: "admitted" }],
    ["unknown status", { status: "valid" }],
    ["bad object id", { objectId: "nope" }],
    [
      "markup in the title",
      { event: { title: "<b>x</b>", startsAt: null, venue: null } },
    ],
    ["bad time", { event: { title: "x", startsAt: "soon", venue: null } }],
    ["no client", { clientId: undefined }],
  ])("refuses %s", (_name, change) => {
    expect(parseTicket({ ...wire, ...change })).toBeUndefined();
    expect(
      parseTicketPage({ tickets: [{ ...wire, ...change }], next: null }),
    ).toBeUndefined();
  });

  it("refuses a page with a bad continuation", () => {
    expect(parseTicketPage({ tickets: [], next: "a b" })).toBeUndefined();
    expect(parseTicketPage({ tickets: "x", next: null })).toBeUndefined();
  });
});

describe("why a verified ticket can't be used", () => {
  // Studio's own rules for its closed ticket template (P4.2), with and
  // without ticket-admission-v1. FICTIONAL values throughout.
  const admission = parseAdmissionRules({
    contract: "ticket-admission-v1",
    action: "update",
    inputPath: "data.custom",
    leaves: {
      state: { enum: ["Admitted"] },
      admissionStatus: { enum: ["Admitted"] },
      operation_id: { runtimeIssued: "^op_[0-9a-f]{40}$" },
      idempotency_key: { runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$" },
    },
    customKeys: [...ADMISSION_CUSTOM_KEYS],
    fromStates: ["Valid"],
    targetStates: ["Admitted"],
    preserveUnlisted: true,
  })!;
  const studio: TicketRules = {
    fields: {
      event: "title",
      startsAt: "admissionWindowStartsAt",
      venue: "venueRef",
      entryClass: "accessClass",
      entryGuidance: null,
      issueOperation: "operation_id",
      state: "state",
    },
    states: { pending: [], issued: ["Valid"], ended: ["Cancelled", "Expired"] },
  };
  const withAdmission: TicketRules = { ...studio, admission };
  const NOW = Date.parse("2026-10-19T12:00:00Z");
  const closedTemplate = (state: string, endsAt = "2026-10-19T11:00:00Z") =>
    Object.fromEntries(
      ADMISSION_CUSTOM_KEYS.map((key) => [key, ""]).concat([
        ["title", "Night Market"],
        ["state", state],
        ["admissionStatus", state],
        ["operation_id", `op_${"b".repeat(40)}`],
        ["admissionWindowStartsAt", "2026-10-19T08:00:00Z"],
        ["admissionWindowEndsAt", endsAt],
      ]),
    );
  const read = (
    custom: Record<string, unknown>,
    rules = withAdmission,
    overrides: Partial<TicketSource> = {},
  ) => {
    const evaluated = evaluateTicket(source({ custom, ...overrides }), {
      ...context,
      rules,
      now: NOW,
    });
    return evaluated.ok ? evaluated.ticket : evaluated.refusal;
  };

  it("says cancelled or expired only for exactly that canonical state", () => {
    for (const rules of [studio, withAdmission]) {
      expect(read(closedTemplate("Cancelled"), rules)).toMatchObject({
        status: "ended",
        endedAs: "cancelled",
      });
      expect(read(closedTemplate("Expired"), rules)).toMatchObject({
        status: "ended",
        endedAs: "expired",
      });
    }
    // Another ended state the binding lists ends the ticket, with no reason.
    expect(
      read(closedTemplate("Void"), {
        ...studio,
        states: { ...studio.states, ended: ["Void"] },
      }),
    ).toMatchObject({ status: "ended", endedAs: null });
    // Not the exact state, or not one the binding lists: never guessed.
    for (const state of ["cancelled", "EXPIRED", "Suspended", "Listed", ""]) {
      expect(read(closedTemplate(state))).toMatchObject({
        status: "unconfirmed",
        endedAs: null,
      });
    }
    expect(
      read(closedTemplate("Cancelled"), {
        ...studio,
        states: { ...studio.states, ended: ["Expired"] },
      }),
    ).toMatchObject({ status: "unconfirmed", endedAs: null });
  });

  it("refuses another holder's, client's or programme's ticket before any wording", () => {
    const cancelled = closedTemplate("Cancelled");
    expect(
      read(cancelled, withAdmission, { owner: "0x" + "9".repeat(40) }),
    ).toBe("not_owned");
    expect(read(cancelled, withAdmission, { orgId: "d".repeat(24) })).toBe(
      "wrong_client",
    );
    expect(read(cancelled, withAdmission, { templateId: "e".repeat(24) })).toBe(
      "not_in_programme",
    );
  });

  it("a still-Valid ticket past its verified entry window stays issued; the closed window is a separate, derived fact", () => {
    const closed = read(closedTemplate("Valid"));
    expect(closed).toMatchObject({
      status: "issued",
      endedAs: null,
      entryWindow: { endsAt: "2026-10-19T11:00:00Z", closed: true },
      // Dual's state is never read as entry.
      admission: "unavailable",
    });
    expect(read(closedTemplate("Valid", "2026-10-19T13:00:00Z"))).toMatchObject(
      {
        status: "issued",
        entryWindow: { endsAt: "2026-10-19T13:00:00Z", closed: false },
      },
    );
  });

  it("knows no window end without the admission contract's closed template and a valid end time", () => {
    // Studio's map names admissionWindowStartsAt as its start: that is when
    // entry opens, never the event's start. P4.2 rules name no window end, so
    // nothing about closing is derived from it.
    const opening = {
      startsAt: "2026-10-19T08:00:00Z",
      endsAt: null,
      closed: false,
    };
    expect(read(closedTemplate("Valid"), studio)).toMatchObject({
      status: "issued",
      event: { startsAt: null },
      entryWindow: opening,
    });
    // Not exactly the closed template: no verified end.
    expect(read({ ...closedTemplate("Valid"), extra: "x" })).toMatchObject({
      entryWindow: opening,
    });
    const missing: Record<string, unknown> = closedTemplate("Valid");
    delete missing.admissionWindowEndsAt;
    expect(read(missing)).toMatchObject({ entryWindow: opening });
    expect(read(closedTemplate("Valid", "after the show"))).toMatchObject({
      entryWindow: opening,
    });
    // Neither time readable: no window at all.
    expect(
      read({
        ...closedTemplate("Valid", "after the show"),
        admissionWindowStartsAt: "doors",
      }),
    ).toMatchObject({ event: { startsAt: null }, entryWindow: null });
    // A window that closes before it opens is not shown.
    expect(read(closedTemplate("Valid", "2026-10-19T07:59:00Z"))).toMatchObject(
      {
        entryWindow: null,
      },
    );
  });

  it("round-trips through the browser's parser, which refuses an inconsistent or malformed claim", () => {
    for (const ticket of [
      read(closedTemplate("Cancelled")),
      read(closedTemplate("Expired")),
      read(closedTemplate("Valid")),
    ]) {
      expect(parseTicket(JSON.parse(JSON.stringify(ticket)))).toEqual(ticket);
    }
    const valid = JSON.parse(JSON.stringify(read(closedTemplate("Valid"))));
    for (const change of [
      { endedAs: "cancelled" },
      { endedAs: "refunded" },
      { entryWindow: { endsAt: "soon", closed: true } },
      { entryWindow: { endsAt: "2026-10-19T11:00:00Z", closed: "yes" } },
      {
        entryWindow: {
          endsAt: "2026-10-19T11:00:00Z",
          closed: true,
          reason: "x",
        },
      },
      { entryWindow: { startsAt: null, endsAt: null, closed: false } },
      { entryWindow: { startsAt: "doors", endsAt: null, closed: false } },
      // A closed window needs its end.
      {
        entryWindow: {
          startsAt: "2026-10-19T08:00:00Z",
          endsAt: null,
          closed: true,
        },
      },
      {
        entryWindow: {
          startsAt: "2026-10-19T08:00",
          endsAt: null,
          closed: false,
        },
      },
    ]) {
      expect(parseTicket({ ...valid, ...change })).toBeUndefined();
    }
    // An older server's window, with its end only, still reads.
    expect(
      parseTicket({
        ...valid,
        entryWindow: { endsAt: "2026-10-19T11:00:00Z", closed: true },
      })?.entryWindow,
    ).toEqual({ startsAt: null, endsAt: "2026-10-19T11:00:00Z", closed: true });
    // An older server's ticket, without the new keys, still reads.
    const { endedAs, entryWindow, ...older } = valid;
    void endedAs;
    void entryWindow;
    expect(parseTicket(older)).toMatchObject({
      endedAs: null,
      entryWindow: null,
    });
  });
});

describe("the issued ticket's own schedule", () => {
  // The P4 client ticket's canonical shape (FICTIONAL ids): Studio's closed
  // ticket template, minute-precision times with their offset, and Studio's
  // field map, whose `startsAt` is the entry window's opening.
  const admission = parseAdmissionRules({
    contract: "ticket-admission-v1",
    action: "update",
    inputPath: "data.custom",
    leaves: {
      state: { enum: ["Admitted"] },
      admissionStatus: { enum: ["Admitted"] },
      operation_id: { runtimeIssued: "^op_[0-9a-f]{40}$" },
      idempotency_key: { runtimeIssued: "^tig:dual-operation:[0-9a-f]{64}$" },
    },
    customKeys: [...ADMISSION_CUSTOM_KEYS],
    fromStates: ["Valid"],
    targetStates: ["Admitted"],
    preserveUnlisted: true,
  })!;
  const studio: TicketRules = {
    fields: {
      event: "title",
      startsAt: "admissionWindowStartsAt",
      venue: "venueRef",
      entryClass: "accessClass",
      entryGuidance: null,
      issueOperation: "operation_id",
      state: "state",
    },
    states: { pending: [], issued: ["Valid"], ended: ["Cancelled", "Expired"] },
    admission,
  };
  const issued = Object.fromEntries(
    ADMISSION_CUSTOM_KEYS.map((key) => [key, ""]).concat([
      ["title", "P4 acceptance event"],
      ["state", "Valid"],
      ["admissionStatus", "Valid"],
      ["eventRef", "P4-20261020"],
      ["venueRef", "p4-acceptance-venue"],
      ["accessClass", "general"],
      ["operation_id", `op_${"b".repeat(40)}`],
      ["admissionWindowStartsAt", "2026-10-20T17:30+11:00"],
      ["admissionWindowEndsAt", "2026-10-20T20:30+11:00"],
    ]),
  );
  const at = (now: string, custom = issued, rules = studio) => {
    const evaluated = evaluateTicket(source({ custom }), {
      ...context,
      rules,
      now: Date.parse(now),
    });
    if (!evaluated.ok) throw new Error(evaluated.refusal);
    return evaluated.ticket;
  };

  it("shows the canonical entry window as written and states no event start it does not have", () => {
    const ticket = at("2026-10-19T12:00:00Z");
    expect(ticket).toMatchObject({
      status: "issued",
      event: {
        title: "P4 acceptance event",
        startsAt: null,
        venue: "p4-acceptance-venue",
      },
      entryClass: "general",
      entryWindow: {
        startsAt: "2026-10-20T17:30+11:00",
        endsAt: "2026-10-20T20:30+11:00",
        closed: false,
      },
    });
    expect(parseTicket(JSON.parse(JSON.stringify(ticket)))).toEqual(ticket);
  });

  it("closes the window at its own offset's instant, not a machine-local one", () => {
    // 20:30 at +11:00 is 09:30 UTC.
    expect(at("2026-10-20T09:29:59Z").entryWindow?.closed).toBe(false);
    expect(at("2026-10-20T09:30:00Z").entryWindow?.closed).toBe(true);
    expect(at("2026-10-20T09:30:00+00:00").entryWindow?.closed).toBe(true);
  });

  it("reads a ticket time strictly: minute or second precision with an explicit offset, every part in range", () => {
    expect(ticketWallClock("2026-10-20T17:30+11:00")).toEqual({
      year: 2026,
      month: 10,
      day: 20,
      hour: 17,
      minute: 30,
      offset: "+11:00",
    });
    expect(ticketWallClock("2026-10-20T17:30:45.5-03:30")).toEqual({
      year: 2026,
      month: 10,
      day: 20,
      hour: 17,
      minute: 30,
      offset: "-03:30",
    });
    expect(ticketWallClock("2028-02-29T00:00Z")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      hour: 0,
      minute: 0,
      offset: "Z",
    });
    for (const value of [
      "2026-10-20T17:30", // no offset: a machine-local time
      "2026-10-20 17:30+11:00",
      "2026-10-20T17+11:00",
      "2026-10-20T17:30+1100",
      "20261020T1730+1100",
      "2026-02-29T17:30+11:00",
      "2026-04-31T17:30+11:00",
      "2026-13-01T17:30+11:00",
      "2026-10-20T24:00+11:00",
      "2026-10-20T17:60+11:00",
      "2026-10-20T17:30:60+11:00",
      "2026-10-20T17:30+14:30",
      "2026-10-20T17:30+11:60",
      " 2026-10-20T17:30+11:00",
      "2026-10-20",
      "",
      1792390200000,
      null,
    ]) {
      expect(ticketWallClock(value)).toBeNull();
    }
  });

  it("computes a ticket time's instant from its own parts and offset, without a platform date parser", () => {
    expect(ticketInstant("2026-10-20T17:30+11:00")).toBe(
      Date.UTC(2026, 9, 20, 6, 30),
    );
    expect(ticketInstant("2026-10-20T20:30+11:00")).toBe(
      Date.UTC(2026, 9, 20, 9, 30),
    );
    expect(ticketInstant("2026-10-19T23:30-07:00")).toBe(
      Date.UTC(2026, 9, 20, 6, 30),
    );
    expect(ticketInstant("2026-10-20T06:30:15.25Z")).toBe(
      Date.UTC(2026, 9, 20, 6, 30, 15, 250),
    );
    expect(ticketInstant("2026-10-20T17:30")).toBeNull();
    expect(ticketInstant(null)).toBeNull();
  });

  it("is honest about a missing or malformed window: each missing side is unstated, never guessed", () => {
    const without = (changes: Record<string, unknown>) => ({
      ...issued,
      ...changes,
    });
    expect(
      at(
        "2026-10-19T12:00:00Z",
        without({ admissionWindowEndsAt: "2026-10-20T20:30" }),
      ).entryWindow,
    ).toEqual({
      startsAt: "2026-10-20T17:30+11:00",
      endsAt: null,
      closed: false,
    });
    expect(
      at("2026-10-19T12:00:00Z", without({ admissionWindowStartsAt: "" }))
        .entryWindow,
    ).toEqual({
      startsAt: null,
      endsAt: "2026-10-20T20:30+11:00",
      closed: false,
    });
    expect(
      at(
        "2026-10-19T12:00:00Z",
        without({
          admissionWindowStartsAt: "soon",
          admissionWindowEndsAt: "later",
        }),
      ).entryWindow,
    ).toBeNull();
    // A binding naming the window's end as its start gets no event start either.
    expect(
      at("2026-10-19T12:00:00Z", issued, {
        ...studio,
        fields: { ...studio.fields, startsAt: "admissionWindowEndsAt" },
      }).event.startsAt,
    ).toBeNull();
  });

  it("keeps an explicit event start exactly as before, in either precision, with no window invented", () => {
    const explicit: TicketRules = {
      ...RULES,
      fields: { ...RULES.fields, startsAt: "event.starts_at" },
    };
    for (const startsAt of ["2026-11-20T19:30:00Z", "2026-11-20T19:30+11:00"]) {
      const ticket = at(
        "2026-10-19T12:00:00Z",
        {
          event: { title: "Show", starts_at: startsAt },
          issue: { op: "op-0001" },
          state: "Issued",
        },
        explicit,
      );
      expect(ticket.event.startsAt).toBe(startsAt);
      expect(ticket.entryWindow).toBeNull();
    }
    const malformed = at(
      "2026-10-19T12:00:00Z",
      {
        event: { title: "Show", starts_at: "8pm" },
        issue: { op: "op-0001" },
        state: "Issued",
      },
      explicit,
    );
    expect(malformed.event.startsAt).toBeNull();
  });
});
