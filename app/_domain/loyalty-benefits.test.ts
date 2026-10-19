import { parseLoyaltyRules } from "@/app/_domain/loyalty";
import {
  availabilityOf,
  bindingPreimage,
  parseRedeemAnswer,
  parseRedemptionStatus,
  parseReferenceAnswer,
} from "@/app/_domain/loyalty-benefits";

// loyalty-benefit-redeem-v1, the wire's exact parsers (FICTIONAL values).

const RULES = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const zero = (reason: string) => ({ dual_writes: 0, reason });

describe("the binding's benefits key", () => {
  it("is optional, and exact when present", () => {
    expect(parseLoyaltyRules(RULES)).toEqual(RULES);
    expect(
      parseLoyaltyRules({ ...RULES, benefits: "loyalty-benefit-redeem-v1" }),
    ).toEqual({ ...RULES, benefits: "loyalty-benefit-redeem-v1" });
    expect(
      parseLoyaltyRules({ ...RULES, benefits: "loyalty-benefits-v2" }),
    ).toBeUndefined();
    expect(parseLoyaltyRules({ ...RULES, benefits: true })).toBeUndefined();
  });
});

describe("answers", () => {
  it("a refusal counts only as the exact listed zero-write reason; a replay never does", () => {
    expect(
      parseRedeemAnswer(409, {
        ok: false,
        status: "loyalty_reward_expired",
        accounting: zero("loyalty_reward_expired"),
      }),
    ).toEqual({ kind: "refused", reason: "loyalty_reward_expired" });
    // A restored reward's request with no unit to hand over: kept, nothing written.
    expect(
      parseRedeemAnswer(409, {
        ok: false,
        status: "loyalty_benefit_stock_exhausted",
        accounting: zero("loyalty_benefit_stock_exhausted"),
      }),
    ).toEqual({ kind: "refused", reason: "loyalty_benefit_stock_exhausted" });
    for (const body of [
      // The runtime already holds this operation: never "not sent".
      {
        ok: false,
        status: "operation_already_received",
        accounting: zero("operation_already_received"),
      },
      // A listed refusal without its exact accounting.
      { ok: false, status: "loyalty_reward_expired" },
      {
        ok: false,
        status: "loyalty_reward_expired",
        accounting: zero("loyalty_reward_changed"),
      },
    ]) {
      expect(parseRedeemAnswer(409, body)).toEqual({ kind: "unknown" });
    }
  });

  it("not received counts only with its exact zero-write accounting", () => {
    const expected = {
      operationId: "loy-0123456789abcdef01234567",
      requestHash: `sha256:${"b".repeat(64)}`,
    };
    const notReceived = {
      ok: true,
      status: "not_received",
      operation_id: expected.operationId,
      accounting: zero("operation_not_received"),
    };
    expect(parseRedemptionStatus(200, notReceived, expected)).toEqual({
      kind: "not_received",
    });
    // About another operation, or naming none: never this one's.
    for (const body of [
      { ...notReceived, operation_id: "loy-fedcba9876543210fedcba98" },
      { ...notReceived, operation_id: undefined },
      { ok: true, status: "not_received", operation_id: expected.operationId },
    ]) {
      expect(parseRedemptionStatus(200, body, expected)).toEqual({
        kind: "unknown",
      });
    }
  });

  it("a reference is exactly Studio's 8-letter form, and a not-current answer carries none", () => {
    expect(
      parseReferenceAnswer(409, {
        ok: false,
        status: "loyalty_redemption_not_current",
        accounting: zero("loyalty_redemption_not_current"),
      }),
    ).toEqual({ kind: "not_current" });
    // Without its chain, even a well-formed reference is not shown.
    expect(
      parseReferenceAnswer(200, {
        ok: true,
        status: "reference_shown",
        reference: "K7QX-2MPD",
        accounting: zero("reference_shown"),
      }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("labels", () => {
  it("availability is shown only as the programme's fully proven record", () => {
    expect(
      availabilityOf({ stock: 1, remaining: 1, status: "available" }),
    ).toBe("available");
    expect(
      availabilityOf({ stock: 1, remaining: 0, status: "exhausted" }),
    ).toBe("unavailable");
    expect(
      availabilityOf({ stock: 1, remaining: 0, status: "reserved_pending" }),
    ).toBe("unavailable");
    for (const status of [
      "proof_unverified",
      "proof_partially_checked",
    ] as const) {
      expect(availabilityOf({ stock: 1, remaining: null, status })).toBe(
        "unconfirmed",
      );
    }
  });

  it("the binding hash covers exactly the four ids, in canonical order", () => {
    expect(
      bindingPreimage({
        revisionHash: `sha256:${"a".repeat(64)}`,
        benefitId: "studio-hour",
        grantActionId: "act-0007",
        allocationId: `alc_${"0".repeat(32)}`,
      }),
    ).toBe(
      `{"allocation_id":"alc_${"0".repeat(32)}","benefit_id":"studio-hour","grant_action_id":"act-0007","revision_hash":"sha256:${"a".repeat(64)}"}`,
    );
  });
});
