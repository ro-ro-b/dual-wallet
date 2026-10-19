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
  ticketText,
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
