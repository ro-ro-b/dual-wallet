import {
  applyJournalTransition,
  parseJournalEntry,
  sentAdmissionStep,
  withDispatchWon,
} from "@/app/_domain/product-face-journal";
import { faceEntryAction } from "@/app/_domain/face-execution";
import {
  ADMISSION_CUSTOM_KEYS,
  checkAdmissionProposal,
  freshShowsAdmittedReadback,
  parseAdmissionPending,
  parseAdmissionRules,
  parseTicketPass,
  type AdmissionProposal,
} from "@/app/_domain/ticket-admission";

const BLOCK = {
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
};
const OBJECT = "7d00000000000000000000a1";
const REQUEST = `tad-${"1".repeat(32)}`;

const issued = (): Record<string, unknown> =>
  Object.fromEntries(
    ADMISSION_CUSTOM_KEYS.map((key) => [
      key,
      key === "recipient_mint_projection" ? true : `v-${key}`,
    ]),
  );
const fresh = () => ({
  ...issued(),
  state: "Valid",
  admissionStatus: "Valid",
  operation_id: `op_${"b".repeat(40)}`,
  idempotency_key: `tig:dual-operation:${"b".repeat(64)}`,
});
const proposal = (custom: Record<string, unknown>): AdmissionProposal => ({
  proposalId: "adp-1",
  requestId: REQUEST,
  objectId: OBJECT,
  action: "update",
  input: { data: { custom } },
  proposalHash: `sha256:${"0".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const admitted = () => ({
  ...fresh(),
  state: "Admitted",
  admissionStatus: "Admitted",
  operation_id: `op_${"c".repeat(40)}`,
  idempotency_key: `tig:dual-operation:${"c".repeat(64)}`,
});
const expected = () => ({
  objectId: OBJECT,
  requestId: REQUEST,
  requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  now: Date.now(),
});

describe("the tickets.admission binding block", () => {
  it("is absent by default and exact when present", () => {
    expect(parseAdmissionRules(undefined)).toBeNull();
    expect(parseAdmissionRules(BLOCK)).toEqual(
      expect.objectContaining({ contract: "ticket-admission-v1" }),
    );
  });

  it.each([
    ["another contract", { ...BLOCK, contract: "ticket-admission-v2" }],
    ["another action", { ...BLOCK, action: "transfer" }],
    [
      "a wider leaf",
      {
        ...BLOCK,
        leaves: { ...BLOCK.leaves, eventRef: { runtimeIssued: "^.*$" } },
      },
    ],
    [
      "a looser target",
      {
        ...BLOCK,
        leaves: { ...BLOCK.leaves, state: { enum: ["Admitted", "Valid"] } },
      },
    ],
    [
      "a missing schema key",
      { ...BLOCK, customKeys: BLOCK.customKeys.slice(1) },
    ],
    ["no complete map", { ...BLOCK, preserveUnlisted: false }],
    ["an extra key", { ...BLOCK, extra: true }],
    ["another start state", { ...BLOCK, fromStates: ["Valid", "Listed"] }],
  ])("refuses %s (the binding fails closed)", (_label, block) => {
    expect(parseAdmissionRules(block)).toBeUndefined();
  });
});

describe("an admission proposal", () => {
  const rules = parseAdmissionRules(BLOCK)!;
  it("passes only as the four governed leaves over the fresh read", () => {
    expect(
      checkAdmissionProposal(proposal(admitted()), expected(), fresh(), rules),
    ).toEqual({ ok: true });
  });
  it.each([
    ["changes an identity leaf", () => ({ ...admitted(), eventRef: "other" })],
    [
      "drops a key",
      () => {
        const map: Record<string, unknown> = admitted();
        delete map.title;
        return map;
      },
    ],
    ["adds a key", () => ({ ...admitted(), extra: "x" })],
    ["writes another state", () => ({ ...admitted(), state: "Cancelled" })],
    [
      "keeps the old operation id format wrong",
      () => ({ ...admitted(), operation_id: "op_xyz" }),
    ],
  ])("is rejected when it %s", (_label, map) => {
    expect(
      checkAdmissionProposal(proposal(map()), expected(), fresh(), rules),
    ).toEqual({ ok: false, reason: "proposal_rejected" });
  });
  it("is unsupported on another template shape, and refused when expired or for another request", () => {
    const fifteen: Record<string, unknown> = fresh();
    delete fifteen.seatRef;
    expect(
      checkAdmissionProposal(proposal(admitted()), expected(), fifteen, rules),
    ).toEqual({ ok: false, reason: "admission_unsupported" });
    expect(
      checkAdmissionProposal(
        proposal(admitted()),
        {
          ...expected(),
          requestExpiresAt: new Date(Date.now() - 1).toISOString(),
        },
        fresh(),
        rules,
      ),
    ).toEqual({ ok: false, reason: "admission_request_expired" });
    expect(
      checkAdmissionProposal(
        proposal(admitted()),
        { ...expected(), requestId: `tad-${"2".repeat(32)}` },
        fresh(),
        rules,
      ),
    ).toEqual({ ok: false, reason: "proposal_rejected" });
    expect(
      checkAdmissionProposal(
        proposal(admitted()),
        expected(),
        { ...fresh(), state: "Admitted", admissionStatus: "Admitted" },
        rules,
      ),
    ).toEqual({ ok: false, reason: "proposal_rejected" });
  });
});

describe("the runtime's admitted answer", () => {
  const readback = {
    state: "Admitted",
    admission_status: "Admitted",
    operation_id: `op_${"c".repeat(40)}`,
    idempotency_key: `tig:dual-operation:${"c".repeat(64)}`,
  };
  const body = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    object_id: OBJECT,
    status: "admitted",
    admission: {
      request_id: REQUEST,
      action_id: "act-1",
      admitted_at: new Date().toISOString(),
      receipt_id: "r-1",
      readback,
      ...extra,
    },
  });
  it("needs its fresh readback, and the wallet's own read must show it now", () => {
    const pending = parseAdmissionPending(body(), OBJECT);
    expect(pending?.status).toBe("admitted");
    if (pending?.status !== "admitted") throw new Error("unexpected");
    expect(freshShowsAdmittedReadback(admitted(), pending.readback)).toBe(true);
    // A holder's own self-update with other identifiers, or later drift.
    expect(
      freshShowsAdmittedReadback(
        { ...admitted(), operation_id: `op_${"9".repeat(40)}` },
        pending.readback,
      ),
    ).toBe(false);
    expect(
      freshShowsAdmittedReadback(
        { ...admitted(), state: "Valid" },
        pending.readback,
      ),
    ).toBe(false);
  });
  it("is not admitted without a readback, for another object, or as admission_unverified", () => {
    expect(
      parseAdmissionPending(
        { ...body(), admission: { ...body().admission, readback: undefined } },
        OBJECT,
      ),
    ).toBeUndefined();
    expect(
      parseAdmissionPending(body(), "7d00000000000000000000ff"),
    ).toBeUndefined();
    expect(
      parseAdmissionPending(
        {
          ok: true,
          object_id: OBJECT,
          status: "admission_unverified",
          request: {
            request_id: REQUEST,
            event_ref: "e",
            created_at: new Date().toISOString(),
            expires_at: new Date().toISOString(),
          },
        },
        OBJECT,
      )?.status,
    ).toBe("admission_unverified");
  });
});

describe("the issuance proof", () => {
  const BIRTH = `op_${"b".repeat(40)}`;
  const pass = (readback: string) => ({
    ok: true,
    status: "ticket_pass_ready",
    object_id: OBJECT,
    pass: {
      schema_version: "tig-ticket-pass-code-v1",
      code: `DT1.v-recordId.${"d".repeat(20)}`,
    },
    issuance: {
      schema_version: "ticket-issuance-proof-v1",
      record_id: "v-recordId",
      object_id: OBJECT,
      activation_hash: "a".repeat(64),
      birth_operation_id: BIRTH,
      birth_idempotency_key: `tig:dual-operation:${"b".repeat(64)}`,
      birth_action_id: "act-mint-1",
      evidence: {
        birth_action: "verified",
        activation_hash: "verified",
        operation_commitment: "verified",
        operation_readback: readback,
      },
    },
  });
  const object = (custom: Record<string, unknown>) => ({
    ...custom,
    recordId: "v-recordId",
    activation_hash: "a".repeat(64),
  });
  it("keeps the original birth operation identical before and after admission", () => {
    const before = parseTicketPass(pass("current"), OBJECT, object(fresh()));
    const after = parseTicketPass(
      pass("superseded"),
      OBJECT,
      object(admitted()),
    );
    expect(before?.issuance?.birthOperationId).toBe(BIRTH);
    expect(after?.issuance?.birthOperationId).toBe(BIRTH);
    expect(after?.issuance?.birthActionId).toBe(
      before?.issuance?.birthActionId,
    );
  });
  it("is dropped when it contradicts the fresh object or an evidence check is not verified", () => {
    expect(
      parseTicketPass(pass("current"), OBJECT, object(admitted()))?.issuance,
    ).toBeNull();
    expect(
      parseTicketPass(pass("superseded"), OBJECT, object(fresh()))?.issuance,
    ).toBeNull();
    const unverified = pass("current");
    unverified.issuance.evidence.operation_commitment = "unverified";
    expect(
      parseTicketPass(unverified, OBJECT, object(fresh()))?.issuance,
    ).toBeNull();
    expect(
      parseTicketPass(pass("current"), OBJECT, {
        ...object(fresh()),
        activation_hash: "9".repeat(64),
      })?.issuance,
    ).toBeNull();
  });
});

describe("the admission journal entry", () => {
  const now = Date.now();
  const entry = {
    operationId: "adm-0123456789abcdef01234567",
    kind: "admission" as const,
    operation: "update",
    slug: "morrow-home",
    programmeId: "morrow-home-arc",
    objectId: OBJECT,
    proposalId: "adp-1",
    admissionRequestId: REQUEST,
    freshHash: `sha256:${"1".repeat(64)}`,
    inputHash: `sha256:${"2".repeat(64)}`,
  };
  it("needs its request, proposal and both map hashes", () => {
    const base = {
      ...entry,
      phase: "confirming",
      createdAt: now,
      updatedAt: now,
    };
    expect(parseJournalEntry(base)).toEqual(base);
    for (const missing of [
      "proposalId",
      "admissionRequestId",
      "freshHash",
      "inputHash",
    ] as const) {
      const value: Record<string, unknown> = { ...base };
      delete value[missing];
      expect(parseJournalEntry(value)).toBeUndefined();
    }
    expect(
      parseJournalEntry({ ...base, operation: "transfer" }),
    ).toBeUndefined();
    // No other kind may carry admission fields.
    expect(parseJournalEntry({ ...base, kind: "settle" })).toBeUndefined();
  });
  it("is submitted once, won once, executes only its update, and is then only read back", () => {
    let entries = applyJournalTransition([], { kind: "begin", entry }, now);
    if (!entries.ok) throw new Error("begin");
    const confirmed = applyJournalTransition(
      entries.entries,
      { kind: "confirm", operationId: entry.operationId, objectId: OBJECT },
      now,
    );
    if (!confirmed.ok) throw new Error("confirm");
    const submitted = applyJournalTransition(
      confirmed.entries,
      { kind: "submit", operationId: entry.operationId, objectId: OBJECT },
      now,
    );
    if (!submitted.ok) throw new Error("submit");
    const won = withDispatchWon(submitted.entries, entry.operationId);
    expect(won[0]).toEqual(
      expect.objectContaining({ phase: "submitted", dispatch: "won" }),
    );
    expect(faceEntryAction(won[0])).toBe("update");
    expect(sentAdmissionStep(won[0])).toBe(true);
    expect(
      applyJournalTransition(
        won,
        { kind: "cancel", operationId: entry.operationId },
        now,
      ),
    ).toEqual({ ok: false, error: "operation_already_submitted" });
    expect(
      applyJournalTransition(
        won,
        { kind: "issue", operationId: entry.operationId, objectId: OBJECT },
        now,
      ),
    ).toEqual({ ok: false, error: "operation_already_submitted" });
    entries = applyJournalTransition(won, { kind: "begin", entry }, now);
    expect(entries).toEqual({
      ok: false,
      error: "operation_already_submitted",
    });
  });
});
