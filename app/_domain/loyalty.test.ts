import {
  checkCanonical,
  checkReceipt,
  isLoyaltyHostOperation,
  parseAccounting,
  parseActionReceipt,
  parseJoinAnswer,
  parseLoyaltyRules,
  parseMembershipAnswer,
  parseStatusAnswer,
  parseSubmitAnswer,
  validEvidenceRef,
  verificationFollows,
  type ActionReceipt,
  type CanonicalRead,
  type ProofContext,
} from "@/app/_domain/loyalty";

const RULES = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const HASH = `sha256:${"a".repeat(64)}`;
const zero = (reason: string) => ({ dual_writes: 0, reason });

describe("the binding's loyalty block", () => {
  it("is absent by default and exact when present", () => {
    expect(parseLoyaltyRules(undefined)).toBeNull();
    expect(parseLoyaltyRules(RULES)).toEqual(RULES);
  });

  it.each([
    ["another contract", { ...RULES, contract: "loyalty-v2" }],
    ["an extra key", { ...RULES, points: true }],
    ["a missing key", { ...RULES, passTemplateId: undefined }],
    [
      "the same template twice",
      { ...RULES, passTemplateId: RULES.canonicalTemplateId },
    ],
    [
      "a mixed-case issuer",
      {
        ...RULES,
        canonicalIssuerAccount: RULES.canonicalIssuerAccount
          .toUpperCase()
          .replace("0X", "0x"),
      },
    ],
    ["a bad model id", { ...RULES, modelId: "Harbour Makers" }],
  ])("drops the binding for %s", (_label, value) => {
    expect(parseLoyaltyRules(value)).toBeUndefined();
  });

  it("names only the host's own five operations", () => {
    expect(isLoyaltyHostOperation("loyalty.activity.submit")).toBe(true);
    expect(isLoyaltyHostOperation("registration.submit")).toBe(false);
  });
});

describe("accounting", () => {
  it("is exact: zero, one or unknown writes, with a reason code", () => {
    expect(parseAccounting(zero("join_request_recorded"))).toEqual({
      dualWrites: 0,
      reason: "join_request_recorded",
    });
    expect(parseAccounting({ dual_writes: 2, reason: "x" })).toBeUndefined();
    expect(parseAccounting({ dual_writes: 0 })).toBeUndefined();
    expect(
      parseAccounting({ dual_writes: 0, reason: "x", extra: 1 }),
    ).toBeUndefined();
  });

  it("join counts only with exact zero-write accounting for its reason", () => {
    const join = {
      request_id: `areq_${"j".repeat(24)}`,
      terms_version: "HMC-2026-1",
      consent_hash: HASH,
      requested_at: "2026-10-19T09:00:00.000Z",
    };
    expect(
      parseJoinAnswer(200, {
        ok: true,
        status: "join_requested",
        join,
        accounting: zero("join_request_recorded"),
      }),
    ).toEqual({
      ok: true,
      join: expect.objectContaining({ termsVersion: "HMC-2026-1" }),
    });
    expect(
      parseJoinAnswer(200, {
        ok: true,
        status: "join_requested",
        join,
        accounting: { dual_writes: 1, reason: "join_request_recorded" },
      }),
    ).toBeUndefined();
    expect(
      parseJoinAnswer(409, {
        ok: false,
        status: "consent_changed",
        accounting: zero("join_already_requested"),
      }),
    ).toBeUndefined();
    expect(
      parseJoinAnswer(409, {
        ok: false,
        status: "consent_changed",
        accounting: zero("consent_changed"),
      }),
    ).toEqual({ ok: false, reason: "consent_changed" });
  });

  it("an approval record needs its own exact zero-write accounting", () => {
    const join = {
      request_id: `areq_${"j".repeat(24)}`,
      terms_version: "HMC-2026-1",
      consent_hash: HASH,
      requested_at: "2026-10-19T09:00:00.000Z",
    };
    const answer = (approval: Record<string, unknown>) =>
      parseMembershipAnswer({
        ok: true,
        status: "pending_creation",
        join,
        approval,
        accounting: zero("membership_read"),
      });
    expect(
      answer({
        status: "approved",
        decided_at: "2026-10-19T10:00:00.000Z",
        accounting: zero("join_approved"),
      }),
    ).toEqual(expect.objectContaining({ status: "pending_creation" }));
    expect(
      answer({ status: "approved", accounting: zero("join_approved") }),
    ).toBeUndefined();
    expect(
      answer({
        status: "approved",
        decided_at: "2026-10-19T10:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("a submission refusal is zero-write only when it says so; anything else is unknown", () => {
    expect(
      parseSubmitAnswer(409, {
        ok: false,
        status: "loyalty_activity_evidence_duplicate",
        accounting: zero("loyalty_activity_evidence_duplicate"),
      }),
    ).toEqual({
      kind: "refused",
      reason: "loyalty_activity_evidence_duplicate",
    });
    expect(
      parseSubmitAnswer(409, {
        ok: false,
        status: "loyalty_activity_evidence_duplicate",
      }),
    ).toEqual({ kind: "unknown" });
    expect(parseSubmitAnswer(502, {})).toEqual({ kind: "unknown" });
    expect(
      parseStatusAnswer(200, { ok: true, status: "not_received" }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("the proofs", () => {
  const context: ProofContext = {
    rules: parseLoyaltyRules(RULES)!,
    clientId: "6b0000000000000000000001",
    expectedMember: `sha256:${"m".repeat(0)}${"1".repeat(64)}`,
    holder: "0x1234567890abcdef1234567890abcdef12345678",
  };
  const custom = {
    generic_semantic_purpose: "membership-loyalty-rewards",
    recordId: "mbr-1",
    programmeId: "HARBOUR-MAKERS",
    memberReference: context.expectedMember,
    state: "Activity pending",
  };
  const canonical: CanonicalRead = {
    objectId: "6c00000000000000000000c1",
    templateId: RULES.canonicalTemplateId,
    orgId: context.clientId,
    owner: RULES.canonicalIssuerAccount,
    nonce: 3,
    stateHash: "0xaaaaaaaaaaaaaaaaaaaa",
    contentHash: "0xbbbbbbbbbbbbbbbbbbbb",
    custom,
    readAt: "2026-10-19T11:00:00.000Z",
  };
  const publicObject = {
    id: canonical.objectId,
    templateId: canonical.templateId,
    owner: canonical.owner,
    nonce: 3,
    stateHash: canonical.stateHash,
    contentHash: canonical.contentHash,
    custom: { state: "Activity pending", programmeId: "HARBOUR-MAKERS" },
  };

  it("canonical: client, template, issuer owner, programme, member and the public view", () => {
    expect(checkCanonical(canonical, publicObject, context)).toBeNull();
    expect(
      checkCanonical(
        { ...canonical, orgId: "6b00000000000000000000ff" },
        publicObject,
        context,
      ),
    ).toBe("canonical_mismatch");
    expect(
      checkCanonical(canonical, { ...publicObject, nonce: 4 }, context),
    ).toBe("public_object_mismatch");
    // A public subset that disagrees with the full map proves nothing.
    expect(
      checkCanonical(
        canonical,
        { ...publicObject, custom: { state: "Activity verified" } },
        context,
      ),
    ).toBe("public_object_mismatch");
    expect(checkCanonical(canonical, undefined, context)).toBe(
      "public_object_mismatch",
    );
  });

  const receipt = (overrides: Partial<ActionReceipt> = {}): ActionReceipt => ({
    ...parseActionReceipt(
      {
        action_id: "act-0002",
        action_name: "update",
        semantic: "submit_activity",
        object_id: canonical.objectId,
        account: RULES.canonicalIssuerAccount,
        next_nonce: 2,
        readback_content_hash: "0xcccccccccccccccccccc",
        written_custom: {
          ...custom,
          lifecycle: {
            action_id: "membership-loyalty-rewards_submit_activity_evt-1",
          },
          proof_event: { public_fields: [`activityEvidenceHash:${HASH}`] },
        },
        written_custom_hash: HASH,
      },
      "submit_activity",
    )!,
    ...overrides,
  });
  const provider = {
    writtenHashMatches: true,
    action: {
      id: "act-0002",
      name: "update",
      account: RULES.canonicalIssuerAccount,
      affected: [
        {
          id: canonical.objectId,
          templateId: RULES.canonicalTemplateId,
          stateChangeId: "sc-2",
        },
      ],
      to: null,
      templateId: null,
    },
    change: {
      id: "sc-2",
      actionId: "act-0002",
      actionName: "update",
      objectId: canonical.objectId,
      nextNonce: 2,
      nextContentHash: "0xcccccccccccccccccccc",
      prevOwner: RULES.canonicalIssuerAccount,
      currentOwner: RULES.canonicalIssuerAccount,
    },
  };

  it("a receipt: its own map, the evidence, the public signer and history", () => {
    expect(
      checkReceipt(receipt(), canonical, context, provider, HASH),
    ).toBeNull();
    expect(
      checkReceipt(
        receipt(),
        canonical,
        context,
        provider,
        `sha256:${"b".repeat(64)}`,
      ),
    ).toBe("receipt_mismatch");
    expect(
      checkReceipt(
        receipt(),
        canonical,
        context,
        { ...provider, writtenHashMatches: false },
        HASH,
      ),
    ).toBe("receipt_mismatch");
    expect(
      checkReceipt(
        receipt(),
        canonical,
        context,
        {
          ...provider,
          action: {
            ...provider.action,
            account: "0x00000000000000000000000000000000000000f9",
          },
        },
        HASH,
      ),
    ).toBe("signer_mismatch");
    expect(
      checkReceipt(
        receipt(),
        canonical,
        context,
        { ...provider, change: { ...provider.change, nextNonce: 1 } },
        HASH,
      ),
    ).toBe("history_mismatch");
  });

  it("compares the record reference only with itself, never with the object id", () => {
    // A receipt whose record reference is the object id: another identity.
    const collapsed = receipt();
    collapsed.writtenCustom = {
      ...collapsed.writtenCustom,
      recordId: canonical.objectId,
    };
    expect(checkReceipt(collapsed, canonical, context, provider, HASH)).toBe(
      "receipt_mismatch",
    );
    expect(
      checkCanonical(
        { ...canonical, custom: { ...custom, recordId: canonical.objectId } },
        publicObject,
        context,
      ),
    ).toBe("canonical_mismatch");
  });

  it("a receipt at the canonical's own nonce is exactly its fresh map; an earlier one is historical", () => {
    const written = receipt().writtenCustom;
    const current = { ...canonical, custom: written };
    const atNonce = receipt({
      nextNonce: 3,
      readbackContentHash: canonical.contentHash,
    });
    const tied = {
      ...provider,
      change: {
        ...provider.change,
        nextNonce: 3,
        nextContentHash: canonical.contentHash,
      },
    };
    expect(checkReceipt(atNonce, current, context, tied, HASH)).toBeNull();
    // The same genuine action, signer, history, nonce and recomputed map
    // hash, while the fresh map at that nonce still says Member.
    expect(
      checkReceipt(
        atNonce,
        { ...current, custom: { ...written, state: "Member" } },
        context,
        tied,
        HASH,
      ),
    ).toBe("receipt_mismatch");
    // Not the content hash C was read with.
    expect(
      checkReceipt(
        { ...atNonce, readbackContentHash: "0xdddddddddddddddddddd" },
        current,
        context,
        {
          ...tied,
          change: { ...tied.change, nextContentHash: "0xdddddddddddddddddddd" },
        },
        HASH,
      ),
    ).toBe("receipt_mismatch");
    // Historical (C moved on since): its retained map is the runtime's
    // record, tied by action, signer, nonce and content hash only.
    expect(
      checkReceipt(
        receipt(),
        { ...current, custom: { ...written, state: "Activity verified" } },
        context,
        provider,
        HASH,
      ),
    ).toBeNull();
  });

  it("a verification counts only as the very next change after the submission", () => {
    const verification = receipt({
      actionId: "act-0003",
      semantic: "verify_activity",
      nextNonce: 3,
    });
    expect(verificationFollows(receipt(), verification)).toBe(true);
    expect(
      verificationFollows(receipt(), { ...verification, nextNonce: 4 }),
    ).toBe(false);
    expect(verificationFollows(receipt(), receipt())).toBe(false);
  });

  it("evidence is plain, trimmed and bounded", () => {
    expect(validEvidenceRef("Workshop sign-in 0042")).toBe(true);
    expect(validEvidenceRef(" padded")).toBe(false);
    expect(validEvidenceRef("")).toBe(false);
    expect(validEvidenceRef("x".repeat(1001))).toBe(false);
    expect(validEvidenceRef("tab\there")).toBe(false);
  });
});
