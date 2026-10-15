import { readFileSync } from "node:fs";
import { join } from "node:path";
import messages from "@/messages/en.json";
import {
  isSettleProposalUnavailableReason,
  ProductFaceError,
  settleProposalUnavailableReasons,
  type ProductFaceConfirmation,
  type ProgrammeProduct,
  type ProgrammeUnitFacts,
} from "@/app/_domain/product-face";
import {
  ProductFaceSession,
  productFaceOperationNames,
  resolveProductFaceRequest,
  startProductFaceBridge,
  type ProductFaceHandlers,
} from "@/app/_lib/external-face-bridge";
import type { ExecutorIdentity } from "@/app/_lib/external-face-bridge/core/executor-identity";
import type { JournalTransitionRequest } from "@/app/_lib/external-face-bridge/core/product-session";
import {
  application,
  edit,
  HOLDER,
  REMOVE,
  TEMPLATE_A,
  TEMPLATE_B,
} from "@/test/product-face-fixtures";
import { translations } from "@/test/intl-mock";

// The wallet session that began an operation (account A) and another (B).
const IDENTITY_A: ExecutorIdentity = {
  walletId: "wallet-a",
  holder: HOLDER.toLowerCase(),
  authenticationMethod: "email",
  controller: null,
};
const IDENTITY_B: ExecutorIdentity = {
  walletId: "wallet-b",
  holder: "0x00000000000000000000000000000000000000b2",
  authenticationMethod: "email",
  controller: null,
};

/**
 * A stateful LOCAL FAKE of the BFF journal (one entry per operation id): a
 * submitted entry refuses a second begin (operation_already_submitted); the
 * submit answers dispatch "won" once, after `duringReserve` ran inside that
 * await (a logout, an account change, a selection change, an expiry).
 */
function journalStore(duringReserve: () => void = () => {}) {
  const entries = new Map<
    string,
    {
      phase: string;
      correlation: Record<string, unknown>;
      transitions: string[];
    }
  >();
  let submits = 0;
  const journal = jest.fn(async (request: JournalTransitionRequest) => {
    const entry = entries.get(request.operation_id);
    if (request.transition === "begin") {
      if (entry && entry.phase === "submitted") {
        throw new ProductFaceError("operation_already_submitted", 409);
      }
      entries.set(request.operation_id, {
        phase: "confirming",
        correlation: {
          kind: request.kind,
          operation: request.operation,
          object_id: request.object_id,
          proposal_id: request.proposal_id,
          offer_id: request.offer_id,
        },
        transitions: ["begin"],
      });
      return {};
    }
    if (!entry) throw new ProductFaceError("unknown_operation", 404);
    entry.transitions.push(request.transition);
    if (request.transition === "confirm") entry.phase = "confirmed";
    if (request.transition === "cancel") entry.phase = "cancelled";
    if (request.transition === "submit") {
      entry.phase = "submitted";
      submits += 1;
      duringReserve();
      return { reservation: "won" as const };
    }
    return {};
  });
  return { journal, entries, submits: () => submits };
}

// What changes while the reservation is being awaited.
type RaceRun = {
  session: ProductFaceSession;
  identity: { current: ExecutorIdentity | null };
};
const RACES: Array<[string, (run: RaceRun) => void]> = [
  [
    "logout",
    ({ session, identity }) => {
      session.ended = "logout";
      session.selection = null;
      identity.current = null;
    },
  ],
  [
    "an account change A to B (the launch ended)",
    ({ session, identity }) => {
      session.ended = "account_changed";
      session.selection = null;
      identity.current = IDENTITY_B;
    },
  ],
  [
    "an account change A to B before the launch heard of it",
    ({ identity }) => {
      identity.current = IDENTITY_B;
    },
  ],
  [
    "a selection change",
    ({ session }) => {
      session.selection = {
        contextId: `context-other-${"y".repeat(16)}`,
        objectId: UNIT_B,
        product: product(UNIT_B),
      };
      session.generation += 1;
    },
  ],
  [
    "the session expiring",
    ({ session, identity }) => {
      session.ended = "expired";
      session.selection = null;
      identity.current = null;
    },
  ],
];

const UNIT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UNIT_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function product(
  objectId: string,
  overrides: Partial<ProgrammeProduct> = {},
): ProgrammeProduct {
  return {
    objectId,
    templateId: TEMPLATE_A,
    name: `Arc grinder ${objectId.slice(0, 2)}`,
    owner: HOLDER,
    custom: { serialNumber: `SN-${objectId.slice(0, 3)}`, state: "Registered" },
    modifiedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

function unit(overrides: Partial<ProgrammeUnitFacts> = {}): ProgrammeUnitFacts {
  return {
    objectId: UNIT_A,
    templateId: TEMPLATE_A,
    name: "Arc grinder",
    recordId: "rec-0001",
    fields: { serialNumber: "SN-1", model: "Arc" },
    readback: { ownerIsYou: false, state: "Issued", lifecycleTarget: null },
    registration: "not_owned",
    ...overrides,
  };
}

function handlers(overrides: Partial<ProductFaceHandlers> = {}) {
  let contexts = 0;
  const value: jest.Mocked<ProductFaceHandlers> = {
    listProducts: jest.fn(async ({ templateId }) => ({
      products:
        templateId === TEMPLATE_A
          ? [product(UNIT_A)]
          : [product(UNIT_B, { templateId: TEMPLATE_B })],
    })),
    selectProduct: jest.fn(async (objectId: string) => {
      contexts += 1;
      return {
        contextId: `context-${contexts}-${"x".repeat(16)}`,
        product: product(objectId),
      };
    }),
    readProduct: jest.fn(async (objectId: string) => product(objectId)),
    readActions: jest.fn(async () => ["update"]),
    readAttributes: jest.fn(async () => [{ key: "colour", value: "slate" }]),
    readHistory: jest.fn(async () => [
      {
        actionId: "action-1",
        action: "Register",
        status: "completed" as const,
        when: new Date("2026-10-02T00:00:00Z"),
      },
    ]),
    readUnit: jest.fn(async () => unit()),
    journal: jest.fn(async () => ({})),
    operationStatus: jest.fn(async () => ({
      status: "outcome_unknown" as const,
      objectId: UNIT_A,
      readback: { ownerIsYou: false, state: "Issued" },
    })),
    mintAssertion: jest.fn(async () => "header.claims.signature"),
    readSettleProposal: jest.fn(),
    executeSettle: jest.fn(async () => ({ actionId: "action-settle-1" })),
    readTransferProposal: jest.fn(),
    readAcceptOffer: jest.fn(async () => unit()),
    executeTransfer: jest.fn(async () => ({ actionId: "action-transfer-1" })),
    transferProgress: jest.fn(async () => ({
      status: "transfer_request_committed" as const,
      step: "request" as const,
    })),
    confirm: jest.fn(async () => true),
    navigate: jest.fn(),
    sha256: jest.fn(async () => `sha256:${"0".repeat(64)}`),
    executorIdentity: jest.fn(() => IDENTITY_A),
    ...overrides,
  } as jest.Mocked<ProductFaceHandlers>;
  return value;
}

function runtimeFor(handlerSet = handlers(), app = application) {
  const session = new ProductFaceSession(app, HOLDER, "/");
  const events = { contextChanged: jest.fn() };
  let id = 0;
  const call = (operation: string, payload: unknown = {}) =>
    resolveProductFaceRequest(
      {
        type: "dual.face.request",
        protocol: "dual.face.bridge",
        version: 1,
        request_id: `request-${(id += 1)}`,
        operation,
        payload,
      },
      { session, handlers: handlerSet, events },
    );
  return { session, events, call, handlers: handlerSet };
}

describe("product face contract consistency", () => {
  const contract = JSON.parse(
    readFileSync(
      join(process.cwd(), "contracts/dual-product-face-v1.json"),
      "utf8",
    ),
  ) as {
    operations: Record<string, unknown>;
    protectedTransfer: { hostOperation: string };
  };

  it("implements exactly the contract operations and no extra authority", () => {
    // contract r16 protectedTransfer.hostOperation names the G8 host
    // operation; r17 lists it in contract.operations as well.
    const transferSign = contract.protectedTransfer.hostOperation.split(" ")[0];
    expect(transferSign).toBe("programme.product.transfer.sign");
    expect(Object.keys(contract.operations)).toContain(transferSign);
    expect([...productFaceOperationNames()].sort()).toEqual(
      [...new Set([...Object.keys(contract.operations), transferSign])].sort(),
    );
    const names = productFaceOperationNames();
    expect(names).not.toContain("object.action.request");
    expect(names.some((name) => name.startsWith("object."))).toBe(false);
    expect(
      names.some((name) =>
        /fetch|proxy|token|cookie|execute|claim/i.test(name),
      ),
    ).toBe(false);
  });
});

describe("application-variant capabilities", () => {
  it("starts with no object and refuses product work without a selection", async () => {
    const { call } = runtimeFor();
    await expect(call("programme.context.read")).resolves.toEqual({
      application: {
        id: application.id,
        version: application.version,
        publisher: application.publisher,
      },
      programme: application.programme,
      selected: null,
      signed_in: true,
    });
    await expect(
      call("programme.product.read", { context_id: "context-x" }),
    ).rejects.toMatchObject({ code: "no_selection" });
    await expect(call("bridge.ping")).resolves.toEqual({ pong: true });
  });

  it("lists only programme products held by the wallet, with opaque cursors", async () => {
    const list = jest.fn(
      async ({ templateId }: { templateId: string; next?: string }) =>
        templateId === TEMPLATE_A
          ? {
              products: [
                product(UNIT_A),
                product("cccccccccccccccccccccccc", { owner: "0xsomeoneelse" }),
              ],
              next: "upstream-cursor",
            }
          : { products: [product(UNIT_B, { templateId: TEMPLATE_B })] },
    );
    const { call } = runtimeFor(handlers({ listProducts: list }));
    const first = (await call("programme.products.list")) as {
      products: Array<Record<string, unknown>>;
      next: string;
    };
    expect(first.products).toEqual([
      expect.objectContaining({
        object_id: UNIT_A,
        owned_by_you: true,
        fields: { serialNumber: "SN-aaa", state: "Registered" },
      }),
    ]);
    expect(first.products[0]).not.toHaveProperty("owner");
    expect(first.products[0]).not.toHaveProperty("custom");
    expect(first.next).not.toBe("upstream-cursor");
    await expect(
      call("programme.products.list", { next: "upstream-cursor" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await call("programme.products.list", { next: first.next });
    expect(list).toHaveBeenLastCalledWith({
      templateId: TEMPLATE_A,
      next: "upstream-cursor",
    });
  });

  it("refuses products not owned or not in the programme", async () => {
    const notOwned = runtimeFor(
      handlers({
        selectProduct: jest.fn(async (objectId: string) => ({
          contextId: "context-1-xxxxxxxxxxxxxxxx",
          product: product(objectId, { owner: "0xsomeoneelse" }),
        })),
      }),
    );
    await expect(
      notOwned.call("programme.product.select", { object_id: UNIT_A }),
    ).rejects.toMatchObject({ code: "not_owned" });
    const foreign = runtimeFor(
      handlers({
        selectProduct: jest.fn(async (objectId: string) => ({
          contextId: "context-1-xxxxxxxxxxxxxxxx",
          product: product(objectId, {
            templateId: "000000000000000000000000",
          }),
        })),
      }),
    );
    await expect(
      foreign.call("programme.product.select", { object_id: UNIT_A }),
    ).rejects.toMatchObject({ code: "not_in_programme" });
    const server = runtimeFor(
      handlers({
        selectProduct: jest.fn(async () => {
          throw new ProductFaceError("not_owned", 403);
        }),
      }),
    );
    await expect(
      server.call("programme.product.select", { object_id: UNIT_A }),
    ).rejects.toMatchObject({ code: "not_owned" });
  });

  it("invalidates the previous context when switching products", async () => {
    const { call, events } = runtimeFor();
    const first = (await call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    const second = (await call("programme.product.select", {
      object_id: UNIT_B,
    })) as { context_id: string };
    expect(second.context_id).not.toBe(first.context_id);
    await expect(
      call("programme.product.history.read", { context_id: first.context_id }),
    ).rejects.toMatchObject({ code: "stale_context" });
    await expect(
      call("programme.product.attributes.read", {
        context_id: second.context_id,
      }),
    ).resolves.toEqual({
      context_id: second.context_id,
      attributes: [{ key: "colour", value: "slate" }],
      next: null,
    });
    expect(events.contextChanged).toHaveBeenCalledWith(
      second.context_id,
      "selected",
    );
  });

  it("drops a delayed response whose context changed", async () => {
    let release!: (value: ProgrammeProduct) => void;
    const handlerSet = handlers();
    const { call } = runtimeFor(handlerSet);
    const first = (await call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    handlerSet.readProduct.mockImplementationOnce(
      () =>
        new Promise<ProgrammeProduct>((resolve) => {
          release = resolve;
        }),
    );
    const late = call("programme.product.read", {
      context_id: first.context_id,
    });
    await call("programme.product.select", { object_id: UNIT_B });
    release(product(UNIT_A));
    await expect(late).rejects.toMatchObject({ code: "stale_context" });
  });

  it("rejects unknown payload keys", async () => {
    const { call } = runtimeFor();
    await expect(
      call("programme.product.select", { object_id: UNIT_A, owner: HOLDER }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      call("navigation.task.update", { path: "/register", url: "https://x" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      call("programme.registration.authorize", {
        object_id: UNIT_A,
        operation_id: "register-op-0001",
        recipient: "0xattacker",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("mirrors valid task paths and refuses invalid ones", async () => {
    const { call, handlers: handlerSet } = runtimeFor();
    await expect(
      call("navigation.task.update", { path: "/register/unit-7" }),
    ).resolves.toEqual({ path: "/register/unit-7" });
    expect(handlerSet.navigate).toHaveBeenCalledWith(
      "/register/unit-7",
      "push",
    );
    await call("navigation.task.update", {
      path: "/register/unit-7",
      title: "Register",
    });
    expect(handlerSet.navigate).toHaveBeenLastCalledWith(
      "/register/unit-7",
      "replace",
    );
    for (const path of ["//evil", "/a/../b", "https://evil", "/A"]) {
      await expect(
        call("navigation.task.update", { path }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses everything after the session ended", async () => {
    const { call, session } = runtimeFor();
    session.ended = "logout";
    await expect(call("programme.context.read")).rejects.toMatchObject({
      code: "session_ended",
    });
  });
});

describe("registration", () => {
  // r6: the face's hash over its entire exact runtime registrations body.
  const REQUEST_HASH = `sha256:${"d".repeat(64)}`;
  const authorize = {
    object_id: UNIT_A,
    operation_id: "register-op-0001",
    record_id: "rec-0001",
    request_hash: REQUEST_HASH,
  };

  it.each([
    ["no record_id", { record_id: undefined }],
    ["no request_hash", { request_hash: undefined }],
    ["a malformed request_hash", { request_hash: "sha256:xyz" }],
    ["a malformed record_id", { record_id: "../x" }],
  ])("refuses an authorization with %s", async (_label, change) => {
    const handlerSet = handlers();
    const { call } = runtimeFor(handlerSet);
    const payload: Record<string, unknown> = { ...authorize, ...change };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    await expect(
      call("programme.registration.authorize", payload),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(handlerSet.readUnit).not.toHaveBeenCalled();
  });

  it("refuses a record_id that does not match the public projection", async () => {
    const handlerSet = handlers();
    const { call } = runtimeFor(handlerSet);
    await expect(
      call("programme.registration.authorize", {
        ...authorize,
        record_id: "rec-9999",
      }),
    ).rejects.toMatchObject({ code: "record_mismatch" });
    expect(handlerSet.confirm).not.toHaveBeenCalled();
    expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
  });

  it("confirms natively, journals before minting, and returns one assertion", async () => {
    const order: string[] = [];
    const handlerSet = handlers({
      journal: jest.fn(async (request) => {
        order.push(`journal:${request.transition}`);
        return request.transition === "begin" ? { unit: unit() } : {};
      }),
      confirm: jest.fn(async (request: ProductFaceConfirmation) => {
        order.push(`confirm:${request.kind}`);
        return true;
      }),
      mintAssertion: jest.fn(async (request) => {
        order.push(`mint:${request.operation}`);
        return "assertion-1";
      }),
    });
    const { call, session } = runtimeFor(handlerSet);
    await expect(
      call("programme.registration.authorize", authorize),
    ).resolves.toEqual({
      status: "authorized",
      operation_id: "register-op-0001",
      assertion: "assertion-1",
    });
    expect(order).toEqual([
      "journal:begin",
      "confirm:registration",
      "journal:confirm",
      "mint:registration.submit",
    ]);
    expect(handlerSet.confirm).toHaveBeenCalledWith({
      kind: "registration",
      unit: unit(),
    });
    expect(session.issuedOperations.has("register-op-0001")).toBe(true);
  });

  it("never requests or executes claim_ownership for registration", async () => {
    const handlerSet = handlers();
    const { call } = runtimeFor(handlerSet);
    await call("programme.registration.authorize", authorize);
    expect(handlerSet.executeSettle).not.toHaveBeenCalled();
    const everyCall = JSON.stringify(
      Object.values(handlerSet).map((fn) => (fn as jest.Mock).mock.calls),
    );
    expect(everyCall).not.toMatch(/claim_ownership|claimOwnership/);
    // The assertion request carries the face's request_hash unchanged.
    expect(handlerSet.mintAssertion).toHaveBeenCalledWith({
      operation: "registration.submit",
      operation_id: "register-op-0001",
      target: { object_id: UNIT_A },
      request_hash: REQUEST_HASH,
    });
    expect(handlerSet.journal).toHaveBeenCalledWith(
      expect.objectContaining({
        transition: "begin",
        record_id: "rec-0001",
        request_hash: REQUEST_HASH,
      }),
    );
  });

  it("cancels before minting as not submitted", async () => {
    const handlerSet = handlers({ confirm: jest.fn(async () => false) });
    const { call } = runtimeFor(handlerSet);
    await expect(
      call("programme.registration.authorize", authorize),
    ).rejects.toMatchObject({ code: "user_cancelled" });
    expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
    expect(handlerSet.journal).toHaveBeenLastCalledWith({
      transition: "cancel",
      operation_id: "register-op-0001",
    });
  });

  it("refuses units already held or outside the programme", async () => {
    const registered = runtimeFor(
      handlers({
        readUnit: jest.fn(async () =>
          unit({
            readback: {
              ownerIsYou: true,
              state: "Registered",
              lifecycleTarget: null,
            },
            registration: "registered",
          }),
        ),
      }),
    );
    await expect(
      registered.call("programme.registration.authorize", authorize),
    ).rejects.toMatchObject({ code: "already_registered_to_you" });
    const pending = runtimeFor(
      handlers({
        readUnit: jest.fn(async () =>
          unit({
            readback: {
              ownerIsYou: true,
              state: "Transfer pending",
              lifecycleTarget: "Registered",
            },
            registration: "ownership_moved_state_pending",
          }),
        ),
      }),
    );
    await expect(
      pending.call("programme.registration.authorize", authorize),
    ).rejects.toMatchObject({ code: "ownership_moved_state_pending" });
    const foreign = runtimeFor(
      handlers({
        readUnit: jest.fn(async () => {
          throw new ProductFaceError("not_in_programme", 404);
        }),
      }),
    );
    await expect(
      foreign.call("programme.registration.authorize", authorize),
    ).rejects.toMatchObject({ code: "not_in_programme" });
  });

  it("allows one pending confirmation per face", async () => {
    let answer!: (value: boolean) => void;
    const handlerSet = handlers({
      confirm: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const { call } = runtimeFor(handlerSet);
    const first = call("programme.registration.authorize", authorize);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      call("programme.registration.authorize", {
        ...authorize,
        operation_id: "register-op-0002",
      }),
    ).rejects.toMatchObject({ code: "action_in_progress" });
    answer(false);
    await expect(first).rejects.toMatchObject({ code: "user_cancelled" });
  });

  it("does not re-mint an operation that already left the wallet", async () => {
    const handlerSet = handlers({
      journal: jest.fn(async () => {
        throw new ProductFaceError("operation_already_submitted", 409);
      }),
    });
    const { call } = runtimeFor(handlerSet);
    await expect(
      call("programme.registration.authorize", authorize),
    ).rejects.toMatchObject({ code: "operation_already_submitted" });
    expect(handlerSet.confirm).not.toHaveBeenCalled();
    expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
  });

  it("reports pending only for an operation this live host issued", async () => {
    const live = runtimeFor();
    await live.call("programme.registration.authorize", authorize);
    await expect(
      live.call("programme.operation.status", {
        operation_id: "register-op-0001",
      }),
    ).resolves.toMatchObject({ status: "pending" });
    // After a reload the same readback is outcome_unknown, and status never mints.
    const reloaded = runtimeFor();
    await expect(
      reloaded.call("programme.operation.status", {
        operation_id: "register-op-0001",
      }),
    ).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(reloaded.handlers.mintAssertion).not.toHaveBeenCalled();
  });

  it("answers outcome_unknown, never a failure, for an operation this launch has no record of", async () => {
    const { call, handlers: handlerSet } = runtimeFor(
      handlers({
        operationStatus: jest.fn(async () => {
          throw new ProductFaceError("unknown_operation", 404);
        }),
      }),
    );
    await expect(
      call("programme.operation.status", { operation_id: "register-op-0009" }),
    ).resolves.toEqual({
      operation_id: "register-op-0009",
      status: "outcome_unknown",
      object_id: null,
      readback: null,
    });
    expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
  });

  it("passes a canonical not-registered status through unchanged", async () => {
    const { call } = runtimeFor(
      handlers({
        operationStatus: jest.fn(async () => ({
          status: "ownership_moved_state_pending" as const,
          objectId: UNIT_A,
          readback: { ownerIsYou: true, state: "Transfer pending" },
        })),
      }),
    );
    await expect(
      call("programme.operation.status", { operation_id: "register-op-0001" }),
    ).resolves.toEqual({
      operation_id: "register-op-0001",
      status: "ownership_moved_state_pending",
      object_id: UNIT_A,
      readback: { owner_is_you: true, state: "Transfer pending" },
    });
  });
});

describe("runtime authorization", () => {
  const hash = `sha256:${"1".repeat(64)}`;

  async function selected(handlerSet = handlers()) {
    const runtime = runtimeFor(handlerSet);
    const { context_id } = (await runtime.call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    return { ...runtime, contextId: context_id };
  }

  it("mints reads for the selected product without a dialog", async () => {
    const { call, handlers: handlerSet, contextId } = await selected();
    await expect(
      call("programme.runtime.authorize", {
        operation: "cases.list",
        operation_id: "read-op-0001",
        target: { object_id: UNIT_A },
        request_hash: hash,
      }),
    ).resolves.toEqual({ assertion: "header.claims.signature" });
    expect(handlerSet.confirm).not.toHaveBeenCalled();
    expect(handlerSet.mintAssertion).toHaveBeenCalledWith(
      expect.objectContaining({ context_id: contextId }),
    );
    await expect(
      call("programme.runtime.authorize", {
        operation: "cases.list",
        operation_id: "read-op-0002",
        target: { object_id: UNIT_B },
        request_hash: hash,
      }),
    ).rejects.toMatchObject({ code: "stale_context" });
    await expect(
      call("programme.runtime.authorize", {
        operation: "registration.submit",
        operation_id: "read-op-0003",
        target: { object_id: UNIT_A },
        request_hash: hash,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("confirms writes natively and cancels as not submitted", async () => {
    const handlerSet = handlers({ confirm: jest.fn(async () => false) });
    const { call } = await selected(handlerSet);
    await expect(
      call("programme.runtime.authorize", {
        operation: "case.open",
        operation_id: "case-op-0001",
        target: { object_id: UNIT_A, case_id: "clm-0123456789abcdef" },
        request_hash: hash,
      }),
    ).rejects.toMatchObject({ code: "user_cancelled" });
    expect(handlerSet.confirm).toHaveBeenCalledWith({
      kind: "runtime",
      operation: "case.open",
      product: { objectId: UNIT_A, name: "Arc grinder aa" },
      caseId: "clm-0123456789abcdef",
    });
    expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
  });

  // contract r10: case.open opens the case Studio prepared for the unit; the
  // face (1.0.0 caseStep) names it exactly as it read it with case.read.
  it("opens the prepared case the face names: dialog, journal begin, then the mint", async () => {
    const order: string[] = [];
    const handlerSet = handlers({
      journal: jest.fn(async (request: JournalTransitionRequest) => {
        order.push(`journal:${request.transition}`);
        return {};
      }),
      confirm: jest.fn(async () => {
        order.push("confirm");
        return true;
      }),
      mintAssertion: jest.fn(async () => {
        order.push("mint");
        return "header.claims.signature";
      }),
    });
    const { call, contextId } = await selected(handlerSet);
    const target = { object_id: UNIT_A, case_id: "clm-0123456789abcdef" };
    await expect(
      call("programme.runtime.authorize", {
        operation: "case.open",
        operation_id: "case-0123456789abcdef0123",
        target,
        request_hash: hash,
      }),
    ).resolves.toEqual({ assertion: "header.claims.signature" });
    expect(order).toEqual([
      "journal:begin",
      "confirm",
      "journal:confirm",
      "mint",
    ]);
    expect(handlerSet.journal).toHaveBeenNthCalledWith(1, {
      transition: "begin",
      kind: "runtime",
      operation: "case.open",
      operation_id: "case-0123456789abcdef0123",
      object_id: UNIT_A,
      context_id: contextId,
      case_id: "clm-0123456789abcdef",
    });
    expect(handlerSet.mintAssertion).toHaveBeenCalledWith({
      operation: "case.open",
      operation_id: "case-0123456789abcdef0123",
      target,
      request_hash: hash,
      context_id: contextId,
    });
  });

  it.each([
    ["without a case", { object_id: UNIT_A }],
    ["with a malformed case id", { object_id: UNIT_A, case_id: "clm 01" }],
    ["with a non-string case id", { object_id: UNIT_A, case_id: 7 }],
    [
      "with an extra target key",
      { object_id: UNIT_A, case_id: "clm-0123456789abcdef", amount: "1.00" },
    ],
    ["without a unit", { case_id: "clm-0123456789abcdef" }],
  ])(
    "refuses case.open %s before any dialog, journal or mint",
    async (_label, target) => {
      const { call, handlers: handlerSet } = await selected();
      await expect(
        call("programme.runtime.authorize", {
          operation: "case.open",
          operation_id: "case-op-0002",
          target,
          request_hash: hash,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(handlerSet.journal).not.toHaveBeenCalled();
      expect(handlerSet.confirm).not.toHaveBeenCalled();
      expect(handlerSet.mintAssertion).not.toHaveBeenCalled();
    },
  );

  it("refuses a quote decision whose quote differs from the host-read quote", async () => {
    const quote = {
      caseId: "case-1",
      quoteVersion: "q2",
      provider: "Morrow Service Centre",
      amount: "149.90",
      currency: "EUR",
    };
    const handlerSet = handlers({
      journal: jest.fn(async (request) =>
        request.transition === "begin" ? { quote } : {},
      ),
    });
    const { call } = await selected(handlerSet);
    const target = {
      object_id: UNIT_A,
      case_id: "case-1",
      quote_version: "q1",
      amount: "99.00",
      currency: "EUR",
    };
    await expect(
      call("programme.runtime.authorize", {
        operation: "case.quote.approve",
        operation_id: "quote-op-0001",
        target,
        request_hash: hash,
      }),
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(handlerSet.confirm).not.toHaveBeenCalled();
    await expect(
      call("programme.runtime.authorize", {
        operation: "case.quote.approve",
        operation_id: "quote-op-0002",
        target: { ...target, quote_version: "q2", amount: "149.90" },
        request_hash: hash,
      }),
    ).resolves.toEqual({ assertion: "header.claims.signature" });
    expect(handlerSet.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "runtime", quote }),
    );
  });
});

describe("holder settle (G6)", () => {
  const pendingProduct = product(UNIT_A, {
    custom: {
      state: "Transfer pending",
      serialNumber: "MH-ARC-0001",
      lifecycle: { target_state: "Registered" },
    },
  });
  // The reviewed Dual update body: {data: {custom}}.
  const settledCustom = {
    state: "Authenticity verified",
    lifecycle: { target_state: "Authenticity verified" },
    serialNumber: "MH-ARC-0001",
    action_hash: "c".repeat(64),
  };
  const proposal = {
    proposalId: "proposal-1",
    operationId: "register-op-0001",
    objectId: UNIT_A,
    action: "update",
    input: { data: { custom: settledCustom } },
    proposalHash: `sha256:${"0".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60_000),
  };

  async function settleRuntime(overrides: Partial<ProductFaceHandlers> = {}) {
    const order: string[] = [];
    const handlerSet = handlers({
      selectProduct: jest.fn(async () => ({
        contextId: "context-settle-xxxxxxxxxxxx",
        product: pendingProduct,
      })),
      readProduct: jest.fn(async () => pendingProduct),
      readSettleProposal: jest.fn(async () => ({ proposal, changes: [] })),
      journal: jest.fn(async (request) => {
        order.push(`journal:${request.transition}`);
        // The BFF answers "won" only when it won the runtime dispatch claim.
        return request.transition === "submit"
          ? { reservation: "won" as const }
          : {};
      }),
      executeSettle: jest.fn(async () => {
        order.push("execute");
        return { actionId: "action-settle-1" };
      }),
      ...overrides,
    });
    const runtime = runtimeFor(handlerSet);
    const { context_id } = (await runtime.call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    const request = {
      context_id,
      operation_id: "register-op-0001",
      settle_operation_id: "settle-op-0001",
    };
    return { ...runtime, order, request };
  }

  it("executes exactly the host-read proposal as the holder, journalled first", async () => {
    const {
      call,
      handlers: handlerSet,
      order,
      request,
    } = await settleRuntime();
    await expect(
      call("programme.product.settle.request", request),
    ).resolves.toEqual({
      status: "submitted",
      settle_operation_id: "settle-op-0001",
      action_id: "action-settle-1",
    });
    expect(order).toEqual([
      "journal:begin",
      "journal:confirm",
      "journal:submit",
      "execute",
      "journal:record_action",
    ]);
    // As the identity that began it, which the executor re-checks itself.
    expect(handlerSet.executeSettle).toHaveBeenCalledWith(
      {
        operationId: "settle-op-0001",
        objectId: UNIT_A,
        action: "update",
        input: proposal.input,
      },
      IDENTITY_A,
    );
    expect(handlerSet.confirm).toHaveBeenCalledWith({
      kind: "settle",
      product: { objectId: UNIT_A, name: pendingProduct.name },
      action: "update",
      changes: [
        {
          field: "data.custom.state",
          kind: "value",
          from: "Transfer pending",
          to: "Authenticity verified",
        },
        {
          field: "data.custom.lifecycle.target_state",
          kind: "value",
          from: "Registered",
          to: "Authenticity verified",
        },
        {
          field: "data.custom.action_hash",
          kind: "technical",
          from: null,
          to: "c".repeat(64),
        },
      ],
    });
  });

  it.each([
    [
      "no won reservation (replay, already claimed or reserved)",
      async () => ({}),
    ],
    [
      "a lost or refused reserve answer",
      async () => {
        throw new ProductFaceError("outcome_unknown", 409);
      },
    ],
    [
      "a lost BFF response",
      async () => {
        throw new ProductFaceError("temporarily_unavailable");
      },
    ],
  ])("never executes without a won reservation: %s", async (_label, submit) => {
    const order: string[] = [];
    const run = await settleRuntime({
      journal: jest.fn(async (request) => {
        order.push(`journal:${request.transition}`);
        return request.transition === "submit" ? submit() : {};
      }),
    });
    await expect(
      run.call("programme.product.settle.request", run.request),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(run.handlers.executeSettle).not.toHaveBeenCalled();
    // Once submitted for reservation it is never cancelled or re-submitted.
    expect(order).toEqual([
      "journal:begin",
      "journal:confirm",
      "journal:submit",
    ]);
  });

  it("passes on a refusal the BFF made on the fresh object before the reserve (r7)", async () => {
    const order: string[] = [];
    const run = await settleRuntime({
      journal: jest.fn(async (request) => {
        order.push(`journal:${request.transition}`);
        if (request.transition === "submit") {
          throw new ProductFaceError("proposal_rejected", 409);
        }
        return {};
      }),
    });
    await expect(
      run.call("programme.product.settle.request", run.request),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
    expect(run.handlers.executeSettle).not.toHaveBeenCalled();
    // Nothing was sent, so the confirmed entry is cancelled, not unknown.
    expect(order).toEqual([
      "journal:begin",
      "journal:confirm",
      "journal:submit",
      "journal:cancel",
    ]);
  });

  it("shows the runtime's reason when no settle proposal exists, and invents none", async () => {
    const notice = jest.fn();
    const run = await settleRuntime({
      notice,
      readSettleProposal: jest.fn(async () => {
        throw new ProductFaceError(
          "settle_proposal_unavailable",
          409,
          "issuer_auto_proposal_used",
        );
      }),
    });
    await expect(
      run.call("programme.product.settle.request", run.request),
    ).rejects.toMatchObject({ code: "settle_proposal_unavailable" });
    expect(notice).toHaveBeenCalledWith({
      kind: "settle_proposal_unavailable",
      reason: "issuer_auto_proposal_used",
    });
    expect(run.handlers.executeSettle).not.toHaveBeenCalled();
    expect(run.handlers.confirm).not.toHaveBeenCalled();
  });

  it("tells the customer the brand proposes again when its confirmation is stale or from an earlier release", async () => {
    for (const reason of [
      "face_settle_proposal_stale",
      "face_settle_proposal_release_changed",
    ]) {
      const notice = jest.fn();
      const run = await settleRuntime({
        notice,
        readSettleProposal: jest.fn(async () => {
          throw new ProductFaceError(
            "settle_proposal_unavailable",
            409,
            reason,
          );
        }),
      });
      await expect(
        run.call("programme.product.settle.request", run.request),
      ).rejects.toMatchObject({ code: "settle_proposal_unavailable" });
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledWith({
        kind: "settle_proposal_unavailable",
        reason,
      });
      expect(
        translations("products")(
          `notices.settle_proposal_unavailable.${reason}`,
          {
            publisher: "Morrow Home",
          },
        ),
      ).toMatch(
        /^Morrow Home's confirmation .+ Their team needs to send a new one; nothing was changed\.$/,
      );
      expect(run.handlers.executeSettle).not.toHaveBeenCalled();
      expect(run.handlers.confirm).not.toHaveBeenCalled();
    }
  });

  it("shows no notice for a reason the wallet does not allow", async () => {
    for (const reason of [
      "face_settle_proposal_expired",
      "face_settle_proposal_stale_v2",
      "The brand proposes it again",
      undefined,
    ]) {
      const notice = jest.fn();
      const run = await settleRuntime({
        notice,
        readSettleProposal: jest.fn(async () => {
          throw new ProductFaceError(
            "settle_proposal_unavailable",
            409,
            reason,
          );
        }),
      });
      await expect(
        run.call("programme.product.settle.request", run.request),
      ).rejects.toMatchObject({ code: "settle_proposal_unavailable" });
      expect(notice).not.toHaveBeenCalled();
    }
  });

  it("has customer copy, naming the publisher, for every allowed reason and no other", () => {
    const copy = messages.products.notices.settle_proposal_unavailable;
    expect(Object.keys(copy).sort()).toEqual(
      [...settleProposalUnavailableReasons].sort(),
    );
    for (const reason of settleProposalUnavailableReasons) {
      expect(isSettleProposalUnavailableReason(reason)).toBe(true);
      expect(copy[reason]).toContain("{publisher}");
      expect(copy[reason]).toMatch(/nothing was changed\.$/);
    }
  });

  it("ignores a face-supplied proposal", async () => {
    const { call, request, handlers: handlerSet } = await settleRuntime();
    await expect(
      call("programme.product.settle.request", {
        ...request,
        proposal: { action: "transfer", input: { to: "0xattacker" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(handlerSet.executeSettle).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a hash mismatch",
      { sha256: jest.fn(async () => `sha256:${"9".repeat(64)}`) },
    ],
    [
      "a proposal for another unit",
      {
        readSettleProposal: jest.fn(async () => ({
          proposal: { ...proposal, objectId: UNIT_B },
          changes: [],
        })),
      },
    ],
    [
      "a nested extra key",
      {
        readSettleProposal: jest.fn(async () => ({
          proposal: {
            ...proposal,
            input: {
              data: { custom: { ...settledCustom, owner: "0xattacker" } },
            },
          },
          changes: [],
        })),
      },
    ],
    [
      "an expired proposal",
      {
        readSettleProposal: jest.fn(async () => ({
          proposal: { ...proposal, expiresAt: new Date(Date.now() - 1) },
          changes: [],
        })),
      },
    ],
    [
      "an unavailable action",
      { readActions: jest.fn(async () => ["transfer"]) },
    ],
    [
      // r7: a fresh custom key the template does not list could be dropped.
      "a fresh custom key the template does not list",
      {
        readProduct: jest.fn(async () => ({
          ...pendingProduct,
          custom: { ...pendingProduct.custom, warrantyNote: "keep" },
        })),
      },
    ],
  ])("refuses %s", async (_label, overrides) => {
    const {
      call,
      request,
      handlers: handlerSet,
    } = await settleRuntime(overrides as Partial<ProductFaceHandlers>);
    await expect(
      call("programme.product.settle.request", request),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
    expect(handlerSet.executeSettle).not.toHaveBeenCalled();
  });

  it("refuses a product that is not owned or not pending", async () => {
    const notOwned = await settleRuntime();
    notOwned.handlers.readProduct.mockResolvedValueOnce({
      ...pendingProduct,
      owner: "0xsomeoneelse",
    });
    await expect(
      notOwned.call("programme.product.settle.request", notOwned.request),
    ).rejects.toMatchObject({ code: "not_owned" });
    const settled = await settleRuntime();
    settled.handlers.readProduct.mockResolvedValueOnce(product(UNIT_A));
    await expect(
      settled.call("programme.product.settle.request", settled.request),
    ).rejects.toMatchObject({ code: "settle_not_required" });
  });

  it("cancels before execution as not submitted", async () => {
    const {
      call,
      request,
      handlers: handlerSet,
      order,
    } = await settleRuntime({
      confirm: jest.fn(async () => false),
    });
    await expect(
      call("programme.product.settle.request", request),
    ).rejects.toMatchObject({ code: "user_cancelled" });
    expect(handlerSet.executeSettle).not.toHaveBeenCalled();
    expect(order).toEqual(["journal:begin", "journal:cancel"]);
  });

  it.each(RACES)(
    "%s during the awaited settle reserve: never executed, the entry stays submitted under its original correlation, a later attempt is outcome_unknown and nothing is reserved again",
    async (_label, race) => {
      const identity = { current: IDENTITY_A as ExecutorIdentity | null };
      const ref: { run?: Awaited<ReturnType<typeof settleRuntime>> } = {};
      const store = journalStore(() =>
        race({ session: ref.run!.session, identity }),
      );
      const run = await settleRuntime({
        journal: store.journal,
        executorIdentity: jest.fn(() => identity.current),
      });
      ref.run = run;
      await expect(
        run.call("programme.product.settle.request", run.request),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^(session_ended|outcome_unknown)$/),
      });
      expect(run.handlers.executeSettle).toHaveBeenCalledTimes(0);
      const entry = store.entries.get(run.request.settle_operation_id)!;
      expect(entry.phase).toBe("submitted");
      expect(entry.transitions).toEqual(["begin", "confirm", "submit"]);
      expect(entry.correlation).toEqual({
        kind: "settle",
        operation: "update",
        object_id: UNIT_A,
        proposal_id: proposal.proposalId,
        offer_id: undefined,
      });
      // Account A again, on a fresh launch: the settle only reads.
      const again = runtimeFor(run.handlers);
      identity.current = IDENTITY_A;
      const { context_id } = (await again.call("programme.product.select", {
        object_id: UNIT_A,
      })) as { context_id: string };
      await expect(
        again.call("programme.product.settle.request", {
          ...run.request,
          context_id,
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      await expect(
        again.call("programme.operation.status", {
          operation_id: run.request.operation_id,
        }),
      ).resolves.toMatchObject({ status: "outcome_unknown" });
      expect(store.submits()).toBe(1);
      expect(run.handlers.executeSettle).toHaveBeenCalledTimes(0);
    },
  );

  it("reports a lost execution as outcome_unknown and never re-executes", async () => {
    const lost = await settleRuntime({
      executeSettle: jest.fn(async () => {
        throw new Error("network lost");
      }),
    });
    await expect(
      lost.call("programme.product.settle.request", lost.request),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(lost.order).toEqual([
      "journal:begin",
      "journal:confirm",
      "journal:submit",
    ]);

    const again = await settleRuntime({
      journal: jest.fn(async (request) => {
        if (request.transition === "begin") {
          throw new ProductFaceError("operation_already_submitted", 409);
        }
        return {};
      }),
    });
    await expect(
      again.call("programme.product.settle.request", again.request),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(again.handlers.executeSettle).not.toHaveBeenCalled();
    expect(again.handlers.confirm).not.toHaveBeenCalled();
  });
});

describe("holder transfer (G8, contract r16 transfer.sign)", () => {
  const OFFER = "pto-0123456789abcdef01234567";
  const RECIPIENT = "0x00000000000000000000000000000000000000b2";
  // A Studio-minted unit: activation_hash is mint provenance, not governed.
  const ownedProduct = product(UNIT_A, {
    custom: {
      state: "Authenticity verified",
      serialNumber: "MH-ARC-0001",
      activation_hash: "b".repeat(64),
    },
  });
  // As the runtime builds it (contract r17): the fresh custom map with only
  // the governed leaves written. The test handlers hash everything to zeros.
  const requestCustom = (
    change: (custom: Record<string, unknown>) => void = () => {},
  ) => {
    const custom: Record<string, unknown> = {
      state: "Transfer pending",
      serialNumber: "MH-ARC-0001",
      activation_hash: "b".repeat(64),
      lifecycle: { target_state: "Transfer pending" },
      proof_event: {
        public_fields: [`recipientReferenceHash:sha256:${"0".repeat(64)}`],
      },
    };
    change(custom);
    return { data: { custom } };
  };
  const requestStep = {
    step: "request" as const,
    proposalId: "ptp-0123456789abcdef01234567",
    offerId: OFFER,
    objectId: UNIT_A,
    action: "update" as const,
    input: requestCustom(),
    proposalHash: `sha256:${"0".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60_000),
    recipient: RECIPIENT,
  };
  const transferStep = {
    ...requestStep,
    step: "transfer" as const,
    proposalId: "ptp-89abcdef0123456789abcdef",
    action: "transfer" as const,
    input: { to: RECIPIENT },
  };

  async function transferRuntime(overrides: Partial<ProductFaceHandlers> = {}) {
    const order: string[] = [];
    const handlerSet = handlers({
      selectProduct: jest.fn(async () => ({
        contextId: "context-transfer-xxxxxxxxxx",
        product: ownedProduct,
      })),
      readProduct: jest.fn(async () => ownedProduct),
      readTransferProposal: jest.fn(async () => requestStep),
      journal: jest.fn(async (request) => {
        order.push(`journal:${request.transition}`);
        return request.transition === "submit"
          ? { reservation: "won" as const }
          : {};
      }),
      executeTransfer: jest.fn(async () => {
        order.push("execute");
        return { actionId: "action-transfer-1" };
      }),
      transferProgress: jest.fn(async () => {
        order.push("progress");
        return {
          status: "transfer_request_committed" as const,
          step: "request" as const,
        };
      }),
      ...overrides,
    });
    const runtime = runtimeFor(handlerSet);
    const { context_id } = (await runtime.call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    const request = {
      context_id,
      offer_id: OFFER,
      step_operation_id: "xfer-step-0001",
    };
    return { ...runtime, order, request };
  }

  it("signs exactly the host-read step as the holder: journalled, confirmed natively with the bound recipient, reserved, executed on won, verified", async () => {
    const run = await transferRuntime();
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).resolves.toEqual({
      status: "transfer_request_committed",
      step: "request",
    });
    expect(run.order).toEqual([
      "journal:begin",
      "journal:confirm",
      "journal:submit",
      "execute",
      "journal:record_action",
      "progress",
    ]);
    expect(run.handlers.journal).toHaveBeenCalledWith(
      expect.objectContaining({
        transition: "begin",
        kind: "transfer",
        operation: "transfer.request",
        proposal_id: requestStep.proposalId,
        offer_id: OFFER,
      }),
    );
    expect(run.handlers.confirm).toHaveBeenCalledWith({
      kind: "transfer",
      product: { objectId: UNIT_A, name: ownedProduct.name },
      step: "request",
      recipient: RECIPIENT,
    });
    expect(run.handlers.executeTransfer).toHaveBeenCalledWith(
      {
        operationId: run.request.step_operation_id,
        objectId: UNIT_A,
        action: "update",
        input: requestStep.input,
      },
      IDENTITY_A,
    );
  });

  it("the recipient shown and signed is the host-read one; the face cannot name or change it", async () => {
    // The face names no recipient: an extra payload key is refused outright.
    const refused = await transferRuntime();
    await expect(
      refused.call("programme.product.transfer.sign", {
        ...refused.request,
        recipient: "0x00000000000000000000000000000000000000ff",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(refused.handlers.readTransferProposal).not.toHaveBeenCalled();
    // Whatever the face displays, the confirmation and the executed transfer
    // carry the runtime-bound recipient the wallet read itself.
    const run = await transferRuntime({
      readTransferProposal: jest.fn(async () => transferStep),
      transferProgress: jest.fn(async () => ({
        status: "transferred" as const,
        step: "transfer" as const,
      })),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).resolves.toEqual({ status: "transferred", step: "transfer" });
    expect(run.handlers.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ step: "transfer", recipient: RECIPIENT }),
    );
    expect(run.handlers.executeTransfer).toHaveBeenCalledWith(
      {
        operationId: run.request.step_operation_id,
        objectId: UNIT_A,
        action: "transfer",
        input: { to: RECIPIENT },
      },
      IDENTITY_A,
    );
  });

  it.each([
    [
      "a transfer to another wallet than the bound recipient",
      {
        ...transferStep,
        input: { to: "0x00000000000000000000000000000000000000cc" },
      },
    ],
    [
      "a transfer back to the holder",
      {
        ...transferStep,
        recipient: HOLDER.toLowerCase(),
        input: { to: HOLDER.toLowerCase() },
      },
    ],
    ["another unit", { ...requestStep, objectId: UNIT_B }],
    [
      "another offer",
      { ...requestStep, offerId: "pto-ffffffffffffffffffffffff" },
    ],
    [
      "an expired step",
      { ...requestStep, expiresAt: new Date(Date.now() - 1) },
    ],
    [
      "a request step that is not an update",
      { ...requestStep, action: "transfer" as const },
    ],
    [
      "a request step rewriting the serial number",
      {
        ...requestStep,
        input: requestCustom((c) => edit(c, "serialNumber", "MH-ARC-9999")),
      },
    ],
    [
      "a request step adding a leaf",
      {
        ...requestStep,
        input: requestCustom((c) => edit(c, "extra", "added")),
      },
    ],
    [
      "a request step changing a mint key",
      {
        ...requestStep,
        input: requestCustom((c) => edit(c, "activation_hash", "c".repeat(64))),
      },
    ],
    [
      "a request step dropping a mint key",
      {
        ...requestStep,
        input: requestCustom((c) => edit(c, "activation_hash", REMOVE)),
      },
    ],
    [
      "a request step writing another state",
      {
        ...requestStep,
        input: requestCustom((c) => {
          edit(c, "state", "In service");
          edit(c, "lifecycle.target_state", "In service");
        }),
      },
    ],
  ])("refuses %s before anything is journalled", async (_label, proposal) => {
    const run = await transferRuntime({
      readTransferProposal: jest.fn(async () => proposal),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
    expect(run.order).toEqual([]);
    expect(run.handlers.executeTransfer).not.toHaveBeenCalled();
  });

  it("without binding.transferRequest the operation is not granted: nothing is read, journalled or executed", async () => {
    const handlerSet = handlers({
      selectProduct: jest.fn(async () => ({
        contextId: "context-transfer-xxxxxxxxxx",
        product: ownedProduct,
      })),
      readProduct: jest.fn(async () => ownedProduct),
      readTransferProposal: jest.fn(async () => requestStep),
    });
    const ungranted = runtimeFor(handlerSet, {
      ...application,
      transferRequest: null,
    });
    const { context_id } = (await ungranted.call("programme.product.select", {
      object_id: UNIT_A,
    })) as { context_id: string };
    await expect(
      ungranted.call("programme.product.transfer.sign", {
        context_id,
        offer_id: OFFER,
        step_operation_id: "xfer-step-0001",
      }),
    ).rejects.toMatchObject({ code: "capability_not_granted" });
    expect(handlerSet.readTransferProposal).not.toHaveBeenCalled();
    expect(handlerSet.journal).not.toHaveBeenCalled();
    expect(handlerSet.executeTransfer).not.toHaveBeenCalled();
  });

  it("refuses a request step when the unit is not in one of the template's from-states", async () => {
    const pending = product(UNIT_A, {
      custom: {
        state: "Transfer pending",
        serialNumber: "MH-ARC-0001",
        activation_hash: "b".repeat(64),
      },
    });
    const run = await transferRuntime({
      selectProduct: jest.fn(async () => ({
        contextId: "context-transfer-xxxxxxxxxx",
        product: pending,
      })),
      readProduct: jest.fn(async () => pending),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
    expect(run.order).toEqual([]);
  });

  it("refuses a step whose hash is not the runtime's proposal hash", async () => {
    const run = await transferRuntime({
      sha256: jest.fn(async () => `sha256:${"9".repeat(64)}`),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
    expect(run.handlers.executeTransfer).not.toHaveBeenCalled();
  });

  it("validates the payload: offer and step operation ids, a current selection", async () => {
    const run = await transferRuntime();
    for (const payload of [
      { ...run.request, offer_id: "offer-1" },
      { ...run.request, step_operation_id: "X" },
      { context_id: run.request.context_id, offer_id: OFFER },
    ]) {
      await expect(
        run.call("programme.product.transfer.sign", payload),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(
      run.call("programme.product.transfer.sign", {
        ...run.request,
        context_id: "context-other-xxxxxxxxxxxx",
      }),
    ).rejects.toMatchObject({ code: "stale_context" });
    const none = runtimeFor(handlers());
    await expect(
      none.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "no_selection" });
  });

  it("Root's reproduction: an account change during the awaited reserve never reaches the executor", async () => {
    const run = await transferRuntime();
    const journal = run.handlers.journal;
    run.handlers.journal = jest.fn(async (request) => {
      const result = await journal(request);
      if (request.transition === "submit")
        run.session.ended = "account_changed";
      return result;
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "session_ended" });
    expect(run.handlers.executeTransfer).toHaveBeenCalledTimes(0);
  });

  describe.each([
    ["request", requestStep],
    ["transfer", transferStep],
  ])("after the %s step's reservation was won", (step, proposal) => {
    it.each(RACES)(
      "%s during the awaited reserve: never executed, the entry stays submitted under its original correlation, a later read is outcome_unknown and nothing is reserved again",
      async (_label, race) => {
        const identity = { current: IDENTITY_A as ExecutorIdentity | null };
        const ref: { run?: Awaited<ReturnType<typeof transferRuntime>> } = {};
        const store = journalStore(() =>
          race({ session: ref.run!.session, identity }),
        );
        const progress = jest.fn(async () => ({
          status: "outcome_unknown" as const,
        }));
        const run = await transferRuntime({
          readTransferProposal: jest.fn(async () => proposal),
          journal: store.journal,
          executorIdentity: jest.fn(() => identity.current),
          transferProgress:
            progress as unknown as ProductFaceHandlers["transferProgress"],
        });
        ref.run = run;
        await expect(
          run.call("programme.product.transfer.sign", run.request),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(session_ended|outcome_unknown)$/),
        });
        expect(run.handlers.executeTransfer).toHaveBeenCalledTimes(0);
        const entry = store.entries.get(run.request.step_operation_id)!;
        expect(entry.phase).toBe("submitted");
        expect(entry.transitions).toEqual(["begin", "confirm", "submit"]);
        expect(entry.correlation).toEqual({
          kind: "transfer",
          operation: `transfer.${step}`,
          object_id: UNIT_A,
          proposal_id: proposal.proposalId,
          offer_id: OFFER,
        });

        // Account A's wallet again, on a fresh launch: the same step only reads.
        const again = runtimeFor(run.handlers);
        identity.current = IDENTITY_A;
        const { context_id } = (await again.call("programme.product.select", {
          object_id: UNIT_A,
        })) as { context_id: string };
        await expect(
          again.call("programme.product.transfer.sign", {
            ...run.request,
            context_id,
          }),
        ).rejects.toMatchObject({ code: "outcome_unknown" });
        expect(progress).toHaveBeenCalledWith(run.request.step_operation_id);
        expect(store.submits()).toBe(1);
        expect(run.handlers.executeTransfer).toHaveBeenCalledTimes(0);
        expect(
          store.entries.get(run.request.step_operation_id)!.transitions,
        ).toEqual(["begin", "confirm", "submit"]);
      },
    );
  });

  it("cancelled natively: the journal entry is cancelled and nothing is reserved or executed", async () => {
    const run = await transferRuntime({ confirm: jest.fn(async () => false) });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "user_cancelled" });
    expect(run.order).toEqual(["journal:begin", "journal:cancel"]);
    expect(run.handlers.executeTransfer).not.toHaveBeenCalled();
  });

  it.each([
    ["no won reservation (replay, already claimed)", async () => ({})],
    [
      "a lost or refused reserve answer",
      async () => {
        throw new ProductFaceError("outcome_unknown", 409);
      },
    ],
    [
      "a lost BFF response",
      async () => {
        throw new ProductFaceError("temporarily_unavailable");
      },
    ],
  ])(
    "executes only on won: %s is outcome_unknown, never executed or re-submitted",
    async (_label, submit) => {
      const order: string[] = [];
      const run = await transferRuntime({
        journal: jest.fn(async (request) => {
          order.push(`journal:${request.transition}`);
          return request.transition === "submit" ? submit() : {};
        }),
      });
      await expect(
        run.call("programme.product.transfer.sign", run.request),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(run.handlers.executeTransfer).not.toHaveBeenCalled();
      expect(order).toEqual([
        "journal:begin",
        "journal:confirm",
        "journal:submit",
      ]);
    },
  );

  it("the runtime's offer decision went to a cancel: transfer_cancelled, nothing executed", async () => {
    const run = await transferRuntime({
      journal: jest.fn(async (request) => {
        if (request.transition === "submit") {
          throw new ProductFaceError("transfer_cancelled", 409);
        }
        return {};
      }),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "transfer_cancelled" });
    expect(run.handlers.executeTransfer).not.toHaveBeenCalled();
  });

  it("an unknown after submit is never executed again: asking again with the same step only reads its status", async () => {
    const run = await transferRuntime({
      executeTransfer: jest.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(run.handlers.executeTransfer).toHaveBeenCalledTimes(1);
    // Asked again: the BFF says the step already left the wallet; only its
    // status is read (here still unknown, then committed).
    const journal = jest.fn(async (request: { transition: string }) => {
      if (request.transition === "begin") {
        throw new ProductFaceError("operation_already_submitted", 409);
      }
      return {};
    });
    run.handlers.journal.mockImplementation(journal);
    run.handlers.transferProgress
      .mockResolvedValueOnce({ status: "outcome_unknown", step: "request" })
      .mockResolvedValueOnce({
        status: "transfer_request_committed",
        step: "request",
      });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(
      run.call("programme.product.transfer.sign", run.request),
    ).resolves.toEqual({
      status: "transfer_request_committed",
      step: "request",
    });
    expect(run.handlers.executeTransfer).toHaveBeenCalledTimes(1);
    expect(run.handlers.confirm).toHaveBeenCalledTimes(1);
  });

  it("the recipient's acceptance names the unit the wallet read itself, is confirmed natively and is minted only for that unit (r19); progress reads need no selection", async () => {
    const run = runtimeFor(handlers());
    await expect(
      run.call("programme.runtime.authorize", {
        operation: "transfer.accept",
        operation_id: "accept-op-0001",
        target: { object_id: UNIT_A },
        request_hash: `sha256:${"1".repeat(64)}`,
      }),
    ).resolves.toEqual({ assertion: "header.claims.signature" });
    expect(run.handlers.readAcceptOffer).toHaveBeenCalledTimes(1);
    expect(run.handlers.readAcceptOffer).toHaveBeenCalledWith();
    // The confirmation names the unit from the wallet's own read: its name and
    // projection fields, never face text or an owner address.
    expect(run.handlers.confirm).toHaveBeenCalledWith({
      kind: "transfer_accept",
      unit: unit(),
    });
    expect(run.handlers.mintAssertion).toHaveBeenCalledWith({
      operation: "transfer.accept",
      operation_id: "accept-op-0001",
      target: { object_id: UNIT_A },
      request_hash: `sha256:${"1".repeat(64)}`,
    });
    await expect(
      run.call("programme.runtime.authorize", {
        operation: "transfer.read",
        operation_id: "xread-op-0001",
        target: { object_id: UNIT_A },
        request_hash: `sha256:${"2".repeat(64)}`,
      }),
    ).resolves.toEqual({ assertion: "header.claims.signature" });
    // A declined acceptance mints nothing; a face cannot ask for host-only steps.
    const declined = runtimeFor(
      handlers({ confirm: jest.fn(async () => false) }),
    );
    await expect(
      declined.call("programme.runtime.authorize", {
        operation: "transfer.accept",
        operation_id: "accept-op-0002",
        target: { object_id: UNIT_A },
        request_hash: `sha256:${"1".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "user_cancelled" });
    expect(declined.handlers.mintAssertion).not.toHaveBeenCalled();
    for (const operation of [
      "transfer.propose",
      "transfer.reserve",
      "transfer.verify",
      "transfer.status",
      "transfer.acceptance.read",
    ]) {
      await expect(
        run.call("programme.runtime.authorize", {
          operation,
          operation_id: "host-op-00001",
          target:
            operation === "transfer.acceptance.read"
              ? {}
              : { object_id: UNIT_A },
          request_hash: `sha256:${"3".repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("an acceptance the face names for another unit, or for no unit, is refused: nothing confirmed, nothing minted (r19)", async () => {
    // The face names another unit than the one the wallet read for its acceptance.
    const other = runtimeFor(handlers());
    await expect(
      other.call("programme.runtime.authorize", {
        operation: "transfer.accept",
        operation_id: "accept-op-0003",
        target: { object_id: UNIT_B },
        request_hash: `sha256:${"1".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "stale_context" });
    expect(other.handlers.readAcceptOffer).toHaveBeenCalledTimes(1);
    expect(other.handlers.confirm).not.toHaveBeenCalled();
    expect(other.handlers.mintAssertion).not.toHaveBeenCalled();
    // No unit named (the r16 empty target), or more than the unit: refused
    // before anything is read.
    for (const target of [
      {},
      { object_id: UNIT_A, owner: "0xabc" },
      { object_id: "not-a-unit" },
    ]) {
      const refused = runtimeFor(handlers());
      await expect(
        refused.call("programme.runtime.authorize", {
          operation: "transfer.accept",
          operation_id: "accept-op-0004",
          target,
          request_hash: `sha256:${"1".repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(refused.handlers.readAcceptOffer).not.toHaveBeenCalled();
      expect(refused.handlers.confirm).not.toHaveBeenCalled();
      expect(refused.handlers.mintAssertion).not.toHaveBeenCalled();
    }
    // The wallet holds no acceptance for this launch (a pasted link, another
    // task): the read fails closed and nothing is confirmed or minted.
    const none = runtimeFor(
      handlers({
        readAcceptOffer: jest.fn(async () => {
          throw new ProductFaceError("invalid_request", 400);
        }),
      }),
    );
    await expect(
      none.call("programme.runtime.authorize", {
        operation: "transfer.accept",
        operation_id: "accept-op-0005",
        target: { object_id: UNIT_A },
        request_hash: `sha256:${"1".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(none.handlers.confirm).not.toHaveBeenCalled();
    expect(none.handlers.mintAssertion).not.toHaveBeenCalled();
    // A second acceptance while one is being confirmed is refused.
    let release!: (value: boolean) => void;
    const pending = runtimeFor(
      handlers({
        confirm: jest.fn(
          () => new Promise<boolean>((resolve) => (release = resolve)),
        ),
      }),
    );
    const first = pending.call("programme.runtime.authorize", {
      operation: "transfer.accept",
      operation_id: "accept-op-0006",
      target: { object_id: UNIT_A },
      request_hash: `sha256:${"1".repeat(64)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      pending.call("programme.runtime.authorize", {
        operation: "transfer.accept",
        operation_id: "accept-op-0007",
        target: { object_id: UNIT_A },
        request_hash: `sha256:${"1".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "action_in_progress" });
    release(false);
    await expect(first).rejects.toMatchObject({ code: "user_cancelled" });
    expect(pending.handlers.mintAssertion).not.toHaveBeenCalled();
  });
});

describe("application-variant transport", () => {
  class FakePort {
    peer!: FakePort;
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    closed = false;
    postMessage(data: unknown) {
      if (this.closed) return;
      queueMicrotask(() => this.peer.onmessage?.({ data } as MessageEvent));
    }
    start() {}
    close() {
      this.closed = true;
    }
  }
  class FakeMessageChannel {
    port1: MessagePort;
    port2: MessagePort;
    constructor() {
      const one = new FakePort();
      const two = new FakePort();
      one.peer = two;
      two.peer = one;
      this.port1 = one as unknown as MessagePort;
      this.port2 = two as unknown as MessagePort;
    }
  }
  const originalChannel = global.MessageChannel;
  const originalEncoder = global.TextEncoder;
  beforeAll(() => {
    global.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel;
    global.TextEncoder = class {
      encode(value: string) {
        return new Uint8Array(value.length);
      }
    } as typeof TextEncoder;
  });
  afterAll(() => {
    global.MessageChannel = originalChannel;
    global.TextEncoder = originalEncoder;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const frameUrl = `${application.origin}${application.path}`;
  const readyIdentity = {
    id: application.id,
    version: application.version,
    publisher: application.publisher,
    programme: application.programme.id,
    artifact: application.artifact,
    contract: "dual-product-face-v1",
  };

  function open(
    options: {
      url?: string;
      handlers?: ProductFaceHandlers;
      task?: string;
      handover?: string;
      acceptance?: string;
    } = {},
  ) {
    const postMessage = jest.fn();
    const frame = {
      contentWindow: { postMessage },
    } as unknown as HTMLIFrameElement;
    const host = startProductFaceBridge({
      frame,
      frameUrl: options.url ?? frameUrl,
      application,
      holder: HOLDER,
      task: options.task ?? "/register",
      handover: options.handover
        ? { kind: "handover", ticket: options.handover }
        : options.acceptance
          ? { kind: "accept", ticket: options.acceptance }
          : undefined,
      handlers: options.handlers ?? handlers(),
    });
    if (!host) throw new Error("bridge refused to start");
    const [bootstrap, targetOrigin, [port]] = postMessage.mock.calls[0] as [
      { channel_id: string },
      string,
      MessagePort[],
    ];
    const received: Array<Record<string, unknown>> = [];
    port.onmessage = (event) =>
      received.push(event.data as Record<string, unknown>);
    const ready = (application: Record<string, unknown> = readyIdentity) =>
      port.postMessage({
        type: "dual.face.ready",
        protocol: "dual.face.bridge",
        version: 1,
        channel_id: bootstrap.channel_id,
        application,
      });
    const request = (
      requestId: string,
      operation: string,
      payload = {},
      extra = {},
    ) =>
      port.postMessage({
        type: "dual.face.request",
        protocol: "dual.face.bridge",
        version: 1,
        request_id: requestId,
        operation,
        payload,
        ...extra,
      });
    return { host, postMessage, targetOrigin, received, ready, request };
  }

  it("refuses a frame outside the exact bound origin and pinned path", () => {
    for (const url of [
      `https://faces.example.evil${application.path}`,
      `https://faces.example:8443${application.path}`,
      `http://faces.example${application.path}`,
      "https://faces.example/face/tig.passport.morrow-home/1.0.0/",
      `https://faces.example/face/other/1.0.0/${"a".repeat(64)}/`,
    ]) {
      const postMessage = jest.fn();
      const host = startProductFaceBridge({
        frame: {
          contentWindow: { postMessage },
        } as unknown as HTMLIFrameElement,
        frameUrl: url,
        application,
        holder: HOLDER,
        task: "/",
        handlers: handlers(),
      });
      expect(host).toBeUndefined();
      expect(postMessage).not.toHaveBeenCalled();
    }
  });

  it("initializes only after an exact ready identity, with no wallet data", async () => {
    const { targetOrigin, received, ready, host } = open();
    expect(targetOrigin).toBe("https://faces.example");
    ready();
    await tick();
    expect(received[0]).toMatchObject({
      type: "dual.face.initialize",
      context: {
        object_id: null,
        variant: "application",
        public: false,
        object: null,
        application: {
          id: application.id,
          version: "1.0.0",
          publisher: "morrow-home",
        },
        programme: application.programme,
        task: { path: "/register" },
      },
    });
    const serialized = JSON.stringify(received[0]).toLowerCase();
    expect(serialized).not.toContain(HOLDER.toLowerCase());
    expect(serialized).not.toMatch(
      /token|cookie|assertion|signature|wallet_id/,
    );
    host?.close();
  });

  it("hands a face handover ticket over in the initialize context, on the register task only (r14)", async () => {
    const ticket = "t".repeat(43);
    const withTicket = open({ handover: ticket });
    expect(withTicket.received).toEqual([]);
    withTicket.ready();
    await tick();
    expect(
      (withTicket.received[0].context as Record<string, unknown>).handover,
    ).toEqual({ ticket });
    // A second ready on the same channel initializes nothing again.
    withTicket.ready();
    await tick();
    expect(
      withTicket.received.filter(
        (message) => message.type === "dual.face.initialize",
      ),
    ).toHaveLength(1);
    withTicket.host.close();

    // Another task: the ticket is not handed over (and is dropped).
    const elsewhere = open({ handover: ticket, task: "/products" });
    elsewhere.ready();
    await tick();
    expect(elsewhere.received[0].context).not.toHaveProperty("handover");
    elsewhere.host.close();

    // Without a ticket the context has no handover key at all.
    const plain = open();
    plain.ready();
    await tick();
    expect(plain.received[0].context).not.toHaveProperty("handover");
    plain.host.close();
  });

  it("hands a transfer acceptance ticket over on the accept task only, never as a handover (G8, r16)", async () => {
    const ticket = "a".repeat(43);
    const onAccept = open({ acceptance: ticket, task: "/accept" });
    onAccept.ready();
    await tick();
    const context = onAccept.received[0].context as Record<string, unknown>;
    expect(context.acceptance).toEqual({ ticket });
    expect(context).not.toHaveProperty("handover");
    onAccept.host.close();
    // On the register task (or any other) an acceptance ticket is dropped.
    for (const task of ["/register", "/products"]) {
      const elsewhere = open({ acceptance: ticket, task });
      elsewhere.ready();
      await tick();
      expect(elsewhere.received[0].context).not.toHaveProperty("acceptance");
      expect(elsewhere.received[0].context).not.toHaveProperty("handover");
      elsewhere.host.close();
    }
    // A registration handover is never handed over on the accept task.
    const handover = open({ handover: ticket, task: "/accept" });
    handover.ready();
    await tick();
    expect(handover.received[0].context).not.toHaveProperty("handover");
    expect(handover.received[0].context).not.toHaveProperty("acceptance");
    handover.host.close();
  });

  it.each([
    ["version", { version: "1.0.1" }],
    ["major-only version", { version: "1" }],
    ["publisher", { publisher: "tidewell" }],
    ["programme", { programme: "tidewell-care" }],
    ["artifact", { artifact: `sha256:${"b".repeat(64)}` }],
    ["contract", { contract: "dual-product-face-v2" }],
    ["application id", { id: "tig.passport.tidewell" }],
    ["an extra key", { scope: "admin" }],
  ])("closes the channel on a mismatched %s", async (_label, change) => {
    const { received, ready, request } = open();
    ready({ ...readyIdentity, ...change });
    await tick();
    request("request-1", "bridge.ping");
    await tick();
    expect(received).toEqual([]);
  });

  it("closes the channel when a required identity key is missing", async () => {
    const { received, ready } = open();
    const partial: Record<string, unknown> = { ...readyIdentity };
    delete partial.artifact;
    ready(partial);
    await tick();
    expect(received).toEqual([]);
  });

  it("rejects unknown envelope keys and duplicate request ids", async () => {
    const { received, ready, request, host } = open();
    ready();
    await tick();
    request("request-1", "bridge.ping", {}, { token: "x" });
    await tick();
    expect(received.at(-1)).toMatchObject({
      request_id: "request-1",
      ok: false,
      error: { code: "invalid_request" },
    });
    request("request-2", "bridge.ping");
    await tick();
    expect(received.at(-1)).toMatchObject({ ok: true, result: { pong: true } });
    request("request-2", "bridge.ping");
    await tick();
    expect(received.at(-1)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    request("request-3", "object.action.request", { name: "claim_ownership" });
    await tick();
    expect(received.at(-1)).toMatchObject({
      ok: false,
      error: { code: "capability_denied" },
    });
    host?.close();
  });

  it("ignores forged window messages from any origin", async () => {
    const handlerSet = handlers();
    const { ready, received, host } = open({ handlers: handlerSet });
    ready();
    await tick();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://faces.example",
        data: {
          type: "dual.face.request",
          protocol: "dual.face.bridge",
          version: 1,
          request_id: "forged",
          operation: "programme.registration.authorize",
          payload: { object_id: UNIT_A, operation_id: "forged-op-0001" },
        },
      }),
    );
    await tick();
    expect(handlerSet.readUnit).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    host?.close();
  });

  it("sends session.ended first and then refuses everything", async () => {
    const { ready, received, request, host } = open();
    ready();
    await tick();
    host?.end("logout");
    await tick();
    expect(received.at(-1)).toMatchObject({
      type: "dual.face.event",
      event: "session.ended",
      payload: { reason: "logout" },
    });
    const count = received.length;
    request("request-after", "programme.context.read");
    await tick();
    expect(received).toHaveLength(count);
    expect(host?.session.ended).toBe("logout");
  });

  it("announces a selection only after the response that created it", async () => {
    const { ready, received, request, host } = open();
    ready();
    await tick();
    request("request-select", "programme.product.select", {
      object_id: UNIT_A,
    });
    await tick();
    await tick();
    const response = received.findIndex(
      (message) => message.request_id === "request-select",
    );
    const event = received.findIndex(
      (message) => message.event === "programme.context.changed",
    );
    expect(response).toBeGreaterThan(0);
    expect(event).toBeGreaterThan(response);
    expect(received[event]).toMatchObject({
      payload: {
        context_id: (received[response].result as { context_id: string })
          .context_id,
        reason: "selected",
      },
    });
    host?.close();
  });

  it("restores task paths and reports operation updates as events", async () => {
    const { ready, received, host } = open();
    ready();
    await tick();
    host?.restoreTask("/register/unit-7");
    host?.operationUpdated("register-op-0001", "outcome_unknown");
    await tick();
    expect(received.slice(-2)).toEqual([
      expect.objectContaining({
        event: "navigation.task.restore",
        payload: { path: "/register/unit-7" },
      }),
      expect.objectContaining({
        event: "operation.updated",
        payload: {
          operation_id: "register-op-0001",
          status: "outcome_unknown",
        },
      }),
    ]);
    host?.close();
  });
});
