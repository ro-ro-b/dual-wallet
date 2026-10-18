import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  ProductFaceError,
  type SessionEndReason,
} from "@/app/_domain/product-face";
import type { ProductFaceHandlers } from "@/app/_lib/external-face-bridge";
import { application, HOLDER } from "@/test/product-face-fixtures";

// The host's own executors (defence in depth): a holder-signed settle or
// transfer step is executed only while this launch is live and the CURRENT
// wallet session is exactly the identity the operation began with. These
// tests drive the real hook; the bridge and the wallet services are local
// fakes, and nothing is signed or sent.

jest.mock("next/navigation", () => ({
  usePathname: () => "/products/morrow-home/products",
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
}));

type FakeSession = {
  wallet: {
    id: string;
    account: { address: string };
    controller: { address: string };
  } | null;
  authenticationMethod: "email" | "passkey" | "eoa" | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  refresh: jest.Mock;
  logout: jest.Mock;
  onSessionEnd: (listener: (reason: SessionEndReason) => void) => () => void;
};
const accountA = {
  id: "wallet-a",
  account: { address: HOLDER },
  controller: { address: "0x00000000000000000000000000000000000000c1" },
};
const accountB = {
  id: "wallet-b",
  account: { address: "0x00000000000000000000000000000000000000b2" },
  controller: { address: "0x00000000000000000000000000000000000000c2" },
};
let session: FakeSession;
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => session,
}));

const executeSettleAction = jest.fn(async () => ({
  actionId: "action-settle",
}));
const executeTransferAction = jest.fn(async () => ({
  actionId: "action-transfer",
}));
const listRetainedTransferSteps = jest.fn(async (): Promise<unknown[]> => []);
const readTransferProgress = jest.fn();
const listFaceOperations = jest.fn(async (): Promise<unknown[]> => []);
const readFaceOperationStatus = jest.fn();
const writeFaceJournal = jest.fn();
// Proposed contract r20 (not deployed): by default no runtime supports the
// durable recovery listing, so today's retained-step read runs unchanged.
const unsupportedRecovery = {
  supported: false,
  complete: false,
  withheld: 0,
  items: [],
};
const listFaceRecovery = jest.fn(
  async (): Promise<unknown> => unsupportedRecovery,
);
const acknowledgeFaceRecovery = jest.fn(async () => ({
  acknowledged: true as const,
  first: true,
}));
jest.mock("@/app/_services/product-face.client", () => ({
  executeSettleAction: (...args: unknown[]) =>
    executeSettleAction(...(args as [])),
  executeTransferAction: (...args: unknown[]) =>
    executeTransferAction(...(args as [])),
  takeFaceHandoverTicket: () => undefined,
  listFaceOperations: (...args: unknown[]) =>
    listFaceOperations(...(args as [])),
  readFaceOperationStatus: (...args: unknown[]) =>
    readFaceOperationStatus(...(args as [])),
  listRetainedTransferSteps: (...args: unknown[]) =>
    listRetainedTransferSteps(...(args as [])),
  readTransferProgress: (...args: unknown[]) =>
    readTransferProgress(...(args as [])),
  writeFaceJournal: (...args: unknown[]) => writeFaceJournal(...(args as [])),
  listFaceRecovery: (...args: unknown[]) => listFaceRecovery(...(args as [])),
  acknowledgeFaceRecovery: (...args: unknown[]) =>
    acknowledgeFaceRecovery(...(args as [])),
  confirmFaceDiscovery: (...args: unknown[]) =>
    confirmFaceDiscovery(...(args as [])),
}));
const confirmFaceDiscovery = jest.fn(async () => ({ marked: 1 }));

let captured: ProductFaceHandlers | undefined;
let initialized: ((host: unknown) => void) | undefined;
const fakeHost = {
  session: { ended: null as SessionEndReason | null },
  end: jest.fn(),
  close: jest.fn(),
  restoreTask: jest.fn(),
  operationUpdated: jest.fn(),
};
jest.mock("@/app/_lib/external-face-bridge", () => ({
  startProductFaceBridge: (options: {
    handlers: ProductFaceHandlers;
    onInitialized?: (host: unknown) => void;
  }) => {
    captured = options.handlers;
    initialized = options.onInitialized;
    // Each start is its own host (a frame reload replaces it); they share the
    // session, so ending it ends every one.
    return { ...fakeHost };
  },
}));

import { useProductFaceHost } from "@/app/_hooks/use-product-face-host";

function launch() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useProductFaceHost({
        slug: "morrow-home",
        launchId: LAUNCH,
        application,
        frameUrl: `${application.origin}${application.path}`,
        onEnded: jest.fn(),
      }),
    { wrapper },
  );
  act(() => hook.result.current.onFrameLoad(document.createElement("iframe")));
  if (!captured) throw new Error("the bridge was not started");
  return { hook, handlers: captured };
}

const transferStep = {
  operationId: "xfer-0123456789abcdef",
  objectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  action: "transfer" as const,
  input: { to: "0x00000000000000000000000000000000000000b2" },
};
const settleStep = {
  operationId: "settle-0123456789abcdef",
  objectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  action: "update",
  input: { data: { custom: { state: "Authenticity verified" } } },
};
const LAUNCH = `launch-${"h".repeat(28)}`;

/** The face binding the host handed to the executor on its last call. */
function boundFace(mock: jest.Mock) {
  const call = mock.mock.calls.at(-1) as unknown as [
    { face: { assertLive(): void } & Record<string, unknown> },
  ];
  return call[0].face;
}

describe("the host executors sign only as the identity that began the operation", () => {
  beforeEach(() => {
    captured = undefined;
    fakeHost.session.ended = null;
    executeSettleAction.mockClear();
    executeTransferAction.mockClear();
    session = {
      wallet: accountA,
      authenticationMethod: "email",
      isAuthenticated: true,
      isLoading: false,
      refresh: jest.fn(),
      logout: jest.fn(),
      onSessionEnd: () => () => undefined,
    };
  });

  it("executes as the captured identity while it is still the live session", async () => {
    const { handlers } = launch();
    const began = handlers.executorIdentity()!;
    expect(began).toEqual({
      walletId: "wallet-a",
      holder: HOLDER.toLowerCase(),
      authenticationMethod: "email",
      controller: "0x00000000000000000000000000000000000000c1",
    });
    await expect(
      handlers.executeTransfer(transferStep, began),
    ).resolves.toEqual({ actionId: "action-transfer" });
    await expect(handlers.executeSettle(settleStep, began)).resolves.toEqual({
      actionId: "action-settle",
    });
    const { operationId: stepId, ...transferInput } = transferStep;
    expect(executeTransferAction).toHaveBeenCalledWith({
      ...transferInput,
      authenticationMethod: "email",
      controllerAddress: "0x00000000000000000000000000000000000000c1",
      face: expect.objectContaining({
        launchId: LAUNCH,
        slug: "morrow-home",
        operationId: stepId,
        walletId: "wallet-a",
      }),
    });
    const { operationId: settleId, ...settleInput } = settleStep;
    expect(executeSettleAction).toHaveBeenCalledWith({
      ...settleInput,
      authenticationMethod: "email",
      controllerAddress: "0x00000000000000000000000000000000000000c1",
      face: expect.objectContaining({
        launchId: LAUNCH,
        slug: "morrow-home",
        operationId: settleId,
        walletId: "wallet-a",
      }),
    });
    // Still the same live identity: the executor's own checks pass.
    expect(() => boundFace(executeTransferAction).assertLive()).not.toThrow();
    expect(() => boundFace(executeSettleAction).assertLive()).not.toThrow();
  });

  // contract r18: the identity is re-checked INSIDE the executor at each
  // async boundary (after prepare, while signing, before execute). The bound
  // face's live check therefore refuses as soon as anything changed after
  // the executor began, not only before it was called.
  it.each([
    [
      "an account change A to B",
      () => {
        session = { ...session, wallet: accountB };
      },
    ],
    [
      "a logout",
      () => {
        session = {
          ...session,
          wallet: null,
          authenticationMethod: null,
          isAuthenticated: false,
        };
      },
    ],
    [
      "an ended launch",
      () => {
        fakeHost.session.ended = "account_changed";
      },
    ],
  ])(
    "the bound live check refuses after %s once the executor began",
    async (_label, change) => {
      const { hook, handlers } = launch();
      const began = handlers.executorIdentity()!;
      await handlers.executeTransfer(transferStep, began);
      await handlers.executeSettle(settleStep, began);
      const transferFace = boundFace(executeTransferAction);
      const settleFace = boundFace(executeSettleAction);
      act(() => change());
      hook.rerender();
      expect(() => transferFace.assertLive()).toThrow(
        expect.objectContaining({ code: "session_ended" }),
      );
      expect(() => settleFace.assertLive()).toThrow(
        expect.objectContaining({ code: "session_ended" }),
      );
    },
  );

  it("the bound live check refuses once the launch is torn down", async () => {
    const { hook, handlers } = launch();
    const began = handlers.executorIdentity()!;
    await handlers.executeTransfer(transferStep, began);
    const transferFace = boundFace(executeTransferAction);
    hook.unmount();
    expect(() => transferFace.assertLive()).toThrow(
      expect.objectContaining({ code: "session_ended" }),
    );
  });

  it.each([
    [
      "an account change A to B",
      () => {
        session = { ...session, wallet: accountB };
      },
    ],
    [
      "a logout",
      () => {
        session = {
          ...session,
          wallet: null,
          authenticationMethod: null,
          isAuthenticated: false,
        };
      },
    ],
    [
      "another sign-in method",
      () => {
        session = { ...session, authenticationMethod: "passkey" };
      },
    ],
    [
      "another controller",
      () => {
        session = {
          ...session,
          wallet: {
            ...accountA,
            controller: {
              address: "0x00000000000000000000000000000000000000c9",
            },
          },
        };
      },
    ],
    [
      "an ended launch",
      () => {
        fakeHost.session.ended = "account_changed";
      },
    ],
  ])("refuses before anything is signed after %s", async (_label, change) => {
    const { hook, handlers } = launch();
    const began = handlers.executorIdentity()!;
    act(() => change());
    hook.rerender();
    await expect(
      handlers.executeTransfer(transferStep, began),
    ).rejects.toMatchObject({ code: "session_ended" });
    await expect(
      handlers.executeSettle(settleStep, began),
    ).rejects.toMatchObject({ code: "session_ended" });
    expect(executeTransferAction).not.toHaveBeenCalled();
    expect(executeSettleAction).not.toHaveBeenCalled();
  });

  it("refuses for a launch that was torn down or replaced", async () => {
    const first = launch();
    const began = first.handlers.executorIdentity()!;
    first.hook.unmount();
    await expect(
      first.handlers.executeTransfer(transferStep, began),
    ).rejects.toMatchObject({ code: "session_ended" });
    expect(executeTransferAction).not.toHaveBeenCalled();
  });
});

// Root's next journey: the sender signs in again and the face relaunches. The
// sender can no longer list or select the moved product, so the face cannot
// ask; the host finds the step its wallet already sent (the BFF's launch
// listing from this wallet's own sealed history) and reads its ORIGINAL
// correlation once, read-only, reporting only the runtime's answer.
describe("a transfer step this wallet sent from another launch", () => {
  beforeEach(() => {
    captured = undefined;
    initialized = undefined;
    fakeHost.session.ended = null;
    session = {
      wallet: accountA,
      authenticationMethod: "email",
      isAuthenticated: true,
      isLoading: false,
      refresh: jest.fn(),
      logout: jest.fn(),
      onSessionEnd: () => () => undefined,
    };
    listRetainedTransferSteps.mockReset();
    readTransferProgress.mockReset();
    executeTransferAction.mockClear();
  });

  it.each([
    ["transferred", { kind: "transfer_step", reason: "transferred" }],
    ["outcome_unknown", { kind: "transfer_step", reason: "outcome_unknown" }],
  ] as const)(
    "is read back on launch by its original id (%s), and nothing is signed or executed",
    async (status, notice) => {
      listRetainedTransferSteps.mockResolvedValue([
        {
          operation_id: "xfer-f0a31dc6781e57f040c2",
          kind: "transfer",
          operation: "transfer.transfer",
          object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
          case_id: null,
          phase: "submitted",
          status: null,
          action_id: "6ad178a32880577b1a494932",
        },
      ]);
      readTransferProgress.mockResolvedValue({ status, step: "transfer" });
      const { hook } = launch();
      await act(async () => {
        initialized?.(fakeHost);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(readTransferProgress).toHaveBeenCalledTimes(1);
      expect(readTransferProgress.mock.calls[0][1]).toBe(
        "xfer-f0a31dc6781e57f040c2",
      );
      expect(readTransferProgress.mock.calls[0]).toHaveLength(2);
      expect(hook.result.current.notice).toEqual(notice);
      expect(executeTransferAction).not.toHaveBeenCalled();
    },
  );

  // The resume awaits the listing, then each read: either may still be in
  // flight when this launch stops being the live one. A late answer must
  // never dispatch a read or land a notice in whatever host is current.
  describe("a late answer never reaches a launch that is no longer live", () => {
    const retained = (operationId: string) => ({
      operation_id: operationId,
      kind: "transfer",
      operation: "transfer.transfer",
      object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      case_id: null,
      phase: "submitted",
      status: null,
      action_id: "6ad178a32880577b1a494932",
    });
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    type Launched = ReturnType<typeof launch>;
    const changes: Array<
      [string, (launched: Launched, endSession: () => void) => void]
    > = [
      ["the launch is torn down", ({ hook }) => hook.unmount()],
      [
        "the frame reloads and a new host replaces it",
        ({ hook }) =>
          act(() =>
            hook.result.current.onFrameLoad(document.createElement("iframe")),
          ),
      ],
      [
        "the account changes",
        (_launched, endSession) => act(() => endSession()),
      ],
    ];
    let endSession: () => void;
    beforeEach(() => {
      endSession = () => {
        throw new Error("no session-end listener");
      };
      session.onSessionEnd = (listener) => {
        endSession = () => listener("account_changed");
        return () => undefined;
      };
    });

    it.each(changes)(
      "%s while the listing is pending: nothing is read and no notice is shown",
      async (_label, change) => {
        const listing = deferred<unknown[]>();
        listRetainedTransferSteps.mockImplementation(() => listing.promise);
        readTransferProgress.mockResolvedValue({
          status: "transferred",
          step: "transfer",
        });
        const launched = launch();
        const resume = initialized!;
        await act(async () => {
          resume(fakeHost);
          await tick();
        });
        expect(listRetainedTransferSteps).toHaveBeenCalledTimes(1);
        change(launched, endSession);
        await act(async () => {
          listing.resolve([retained("xfer-f0a31dc6781e57f040c2")]);
          await tick();
        });
        expect(readTransferProgress).not.toHaveBeenCalled();
        expect(launched.hook.result.current.notice).toBeNull();
        expect(executeTransferAction).not.toHaveBeenCalled();
      },
    );

    it.each(changes)(
      "%s while a read is pending: its answer is dropped and no further read is dispatched",
      async (_label, change) => {
        listRetainedTransferSteps.mockResolvedValue([
          retained("xfer-f0a31dc6781e57f040c2"),
          retained("xfer-0b1c2d3e4f5a6b7c8d9e"),
        ]);
        const read = deferred<{ status: string; step: string }>();
        readTransferProgress.mockImplementation(() => read.promise);
        const launched = launch();
        const resume = initialized!;
        await act(async () => {
          resume(fakeHost);
          await tick();
        });
        expect(readTransferProgress).toHaveBeenCalledTimes(1);
        change(launched, endSession);
        await act(async () => {
          read.resolve({ status: "transferred", step: "transfer" });
          await tick();
        });
        expect(readTransferProgress).toHaveBeenCalledTimes(1);
        expect(launched.hook.result.current.notice).toBeNull();
        expect(executeTransferAction).not.toHaveBeenCalled();
      },
    );

    it("while the launch stays live, the same late answers are read and shown", async () => {
      const listing = deferred<unknown[]>();
      listRetainedTransferSteps.mockImplementation(() => listing.promise);
      const read = deferred<{ status: string; step: string }>();
      readTransferProgress.mockImplementation(() => read.promise);
      const launched = launch();
      const resume = initialized!;
      await act(async () => {
        resume(fakeHost);
        await tick();
      });
      await act(async () => {
        listing.resolve([retained("xfer-f0a31dc6781e57f040c2")]);
        await tick();
      });
      expect(readTransferProgress).toHaveBeenCalledTimes(1);
      await act(async () => {
        read.resolve({ status: "transferred", step: "transfer" });
        await tick();
      });
      expect(launched.hook.result.current.notice).toEqual({
        kind: "transfer_step",
        reason: "transferred",
      });
    });
  });

  it("reports nothing when no retained step is listed or its read fails", async () => {
    listRetainedTransferSteps.mockResolvedValue([]);
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readTransferProgress).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBeNull();
  });
});

// The same launch-time resume reconciles this launch's own journalled
// registrations (listFaceOperations, then each status read) and reports each
// answer to the face. A late answer must never read on, or report into, a
// launch that is no longer the live one.
describe("a journalled registration's late status never reaches a launch that is no longer live", () => {
  const journalled = (operationId: string) => ({
    operation_id: operationId,
    kind: "registration",
    operation: "registration.submit",
    object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    case_id: null,
    phase: "assertion_issued",
    status: null,
    action_id: null,
  });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  type Launched = ReturnType<typeof launch>;
  let endSession: () => void;
  const changes: Array<
    [string, (launched: Launched, endSession: () => void) => void]
  > = [
    ["the launch is torn down", ({ hook }) => hook.unmount()],
    [
      "the frame reloads and a new host replaces it",
      ({ hook }) =>
        act(() =>
          hook.result.current.onFrameLoad(document.createElement("iframe")),
        ),
    ],
    ["the account changes", (_launched, end) => act(() => end())],
  ];
  beforeEach(() => {
    captured = undefined;
    initialized = undefined;
    fakeHost.session.ended = null;
    fakeHost.operationUpdated.mockReset();
    endSession = () => {
      throw new Error("no session-end listener");
    };
    session = {
      wallet: accountA,
      authenticationMethod: "email",
      isAuthenticated: true,
      isLoading: false,
      refresh: jest.fn(),
      logout: jest.fn(),
      onSessionEnd: (listener) => {
        endSession = () => listener("account_changed");
        return () => undefined;
      },
    };
    listRetainedTransferSteps.mockReset().mockResolvedValue([]);
    readTransferProgress.mockReset();
    listFaceOperations.mockReset();
    readFaceOperationStatus.mockReset();
  });
  afterAll(() => {
    listFaceOperations.mockReset().mockResolvedValue([]);
  });

  it.each(changes)(
    "%s while the listing is pending: no status is read and nothing is reported",
    async (_label, change) => {
      const listing = deferred<unknown[]>();
      listFaceOperations.mockImplementation(() => listing.promise);
      readFaceOperationStatus.mockResolvedValue({
        status: "registered",
        objectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        readback: null,
      });
      const launched = launch();
      const resume = initialized!;
      await act(async () => {
        resume(fakeHost);
        await tick();
      });
      change(launched, endSession);
      await act(async () => {
        listing.resolve([journalled("register-op-0001")]);
        await tick();
      });
      expect(readFaceOperationStatus).not.toHaveBeenCalled();
      expect(fakeHost.operationUpdated).not.toHaveBeenCalled();
    },
  );

  it.each(changes)(
    "%s while a status read is pending: its answer is dropped and no further read is dispatched",
    async (_label, change) => {
      listFaceOperations.mockResolvedValue([
        journalled("register-op-0001"),
        journalled("register-op-0002"),
      ]);
      const read = deferred<unknown>();
      readFaceOperationStatus.mockImplementation(() => read.promise);
      const launched = launch();
      const resume = initialized!;
      await act(async () => {
        resume(fakeHost);
        await tick();
      });
      expect(readFaceOperationStatus).toHaveBeenCalledTimes(1);
      change(launched, endSession);
      await act(async () => {
        read.resolve({
          status: "registered",
          objectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
          readback: null,
        });
        await tick();
      });
      expect(readFaceOperationStatus).toHaveBeenCalledTimes(1);
      expect(fakeHost.operationUpdated).not.toHaveBeenCalled();
    },
  );

  it("while the launch stays live, each status is read and reported", async () => {
    listFaceOperations.mockResolvedValue([
      journalled("register-op-0001"),
      journalled("register-op-0002"),
    ]);
    readFaceOperationStatus.mockResolvedValue({
      status: "registered",
      objectId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      readback: null,
    });
    launch();
    const resume = initialized!;
    await act(async () => {
      resume(fakeHost);
      await tick();
    });
    expect(readFaceOperationStatus).toHaveBeenCalledTimes(2);
    expect(fakeHost.operationUpdated.mock.calls).toEqual([
      ["register-op-0001", "registered"],
      ["register-op-0002", "registered"],
    ]);
  });
});

// A launch journal holds JOURNAL_MAX_ENTRIES; steps whose authority left the
// wallet are kept, never evicted. When none can make room, this launch can
// begin nothing more: the face hears the refusal, and the host offers a new
// launch (its own journal) in its own UI.
describe("a launch whose journal has no room left", () => {
  const begin = {
    transition: "begin",
    kind: "runtime",
    operation: "case.open",
    operation_id: "case-0123456789abcdef",
    object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  } as unknown as Parameters<ProductFaceHandlers["journal"]>[0];

  beforeEach(() => {
    captured = undefined;
    fakeHost.session.ended = null;
    writeFaceJournal.mockReset();
    session = {
      wallet: accountA,
      authenticationMethod: "email",
      isAuthenticated: true,
      isLoading: false,
      refresh: jest.fn(),
      logout: jest.fn(),
      onSessionEnd: () => () => undefined,
    };
  });

  it("refuses the face's begin and offers a new launch", async () => {
    writeFaceJournal.mockRejectedValue(
      new ProductFaceError("journal_full", 409),
    );
    const { hook, handlers } = launch();
    await act(async () => {
      await expect(handlers.journal(begin)).rejects.toMatchObject({
        code: "journal_full",
      });
    });
    expect(hook.result.current.notice).toEqual({
      kind: "launch_full",
      reason: "journal_full",
    });
    expect(session.refresh).not.toHaveBeenCalled();
  });

  it("tells of a read-only launch on launch_capacity, offering no new launch (it would be the same)", async () => {
    writeFaceJournal.mockRejectedValue(
      new ProductFaceError("launch_capacity", 409),
    );
    const { hook, handlers } = launch();
    await act(async () => {
      await expect(handlers.journal(begin)).rejects.toMatchObject({
        code: "launch_capacity",
      });
    });
    expect(hook.result.current.notice).toEqual({
      kind: "launch_full",
      reason: "launch_capacity",
    });
  });

  it("offers nothing for any other refusal", async () => {
    writeFaceJournal.mockRejectedValue(
      new ProductFaceError("operation_conflict", 409),
    );
    const { hook, handlers } = launch();
    await act(async () => {
      await expect(handlers.journal(begin)).rejects.toMatchObject({
        code: "operation_conflict",
      });
    });
    expect(hook.result.current.notice).toBeNull();
  });

  it("offers nothing once the launch is no longer live", async () => {
    let refuse: (error: unknown) => void = () => undefined;
    writeFaceJournal.mockReturnValue(
      new Promise((_, reject) => {
        refuse = reject;
      }),
    );
    const { hook, handlers } = launch();
    const pending = handlers.journal(begin);
    fakeHost.session.ended = "logout";
    await act(async () => {
      refuse(new ProductFaceError("journal_full", 409));
      await expect(pending).rejects.toMatchObject({ code: "journal_full" });
    });
    expect(hook.result.current.notice).toBeNull();
  });
});

// Proposed contract r20 (PROPOSED, not deployed; no runtime answers it
// today): the BFF lists this wallet's earlier operations from the runtimes'
// own durable stores, resolves each read-only and tickets only the items the
// host may acknowledge (proved, complete check, enabled journey). The host
// shows the outcomes in its own UI, skips the cookie-based retained read the
// listing supersedes, and acknowledges exactly the ticketed items once the
// person dismissed the notice, once, while the launch is still live. Nothing
// is ever re-sent. These tests drive the real hook against a local fixture;
// that is not delivery and not interoperability.
describe("the runtime's durable recovery listing (proposed contract r20)", () => {
  const face = { slug: "morrow-home", launchId: LAUNCH };
  const transferred = {
    operation_id: "xfer-f0a31dc6781e57f040c2",
    kind: "transfer",
    operation: "transfer.transfer",
    object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    case_id: null,
    offer_id: "pto-bbbbbbbbbbbbbbbbbbbbbbbb",
    step: "transfer",
    outcome: "transferred",
    holding: "elsewhere",
    ticket: "ack-ticket-f0a31dc6",
  };
  const heldWrite = {
    operation_id: "case-0123456789abcdef",
    kind: "runtime",
    operation: "case.open",
    object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    case_id: "case-77",
    offer_id: null,
    step: null,
    outcome: "outcome_unknown",
    holding: null,
    ticket: null,
  };
  const retainedStep = {
    operation_id: "xfer-0b1c2d3e4f5a6b7c8d9e",
    kind: "transfer",
    operation: "transfer.transfer",
    object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    case_id: null,
    phase: "submitted",
    status: null,
    action_id: "6ad178a32880577b1a494932",
  };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  type Launched = ReturnType<typeof launch>;
  let endSession: () => void;
  const changes: Array<
    [string, (launched: Launched, endSession: () => void) => void]
  > = [
    ["the launch is torn down", ({ hook }) => hook.unmount()],
    [
      "the frame reloads and a new host replaces it",
      ({ hook }) =>
        act(() =>
          hook.result.current.onFrameLoad(document.createElement("iframe")),
        ),
    ],
    ["the account changes", (_launched, end) => act(() => end())],
  ];

  beforeEach(() => {
    captured = undefined;
    initialized = undefined;
    fakeHost.session.ended = null;
    endSession = () => {
      throw new Error("no session-end listener");
    };
    session = {
      wallet: accountA,
      authenticationMethod: "email",
      isAuthenticated: true,
      isLoading: false,
      refresh: jest.fn(),
      logout: jest.fn(),
      onSessionEnd: (listener) => {
        endSession = () => listener("account_changed");
        return () => undefined;
      },
    };
    listFaceRecovery.mockReset();
    acknowledgeFaceRecovery.mockReset();
    acknowledgeFaceRecovery.mockResolvedValue({
      acknowledged: true,
      first: true,
    });
    listRetainedTransferSteps.mockReset().mockResolvedValue([]);
    readTransferProgress.mockReset();
    executeTransferAction.mockClear();
    executeSettleAction.mockClear();
  });
  afterAll(() => {
    listFaceRecovery.mockReset().mockResolvedValue(unsupportedRecovery);
  });

  it("carries each runtime's check and the unreadable count into the notice, and Check again re-lists from the start", async () => {
    const checks = [
      { runtime: "product", status: "checked", reason: null, unreadable: 0 },
      {
        runtime: "service",
        status: "incomplete",
        reason: "item_unreadable",
        unreadable: 1,
      },
    ];
    listFaceRecovery.mockResolvedValueOnce({
      supported: true,
      complete: false,
      withheld: 0,
      continuation: null,
      items: [heldWrite],
      checks,
      unreadable: 1,
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      complete: false,
      moreToCheck: false,
      checks,
      unreadable: 1,
    });
    // Check again: a fresh listing from the start replaces the check's word.
    listFaceRecovery.mockResolvedValueOnce({
      supported: true,
      complete: true,
      withheld: 0,
      continuation: null,
      items: [heldWrite],
      checks: checks.map((check) => ({
        ...check,
        status: "checked",
        reason: null,
        unreadable: 0,
      })),
      unreadable: 0,
    });
    await act(async () => {
      hook.result.current.checkRecoveryAgain();
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(2);
    expect(listFaceRecovery).toHaveBeenNthCalledWith(2, face);
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      complete: true,
      unreadable: 0,
      checks: [
        { runtime: "product", status: "checked" },
        { runtime: "service", status: "checked" },
      ],
    });
  });

  it("carries the BFF's fresh holding read of each item into the notice, and still acknowledges the proved outcome once dismissed", async () => {
    // The original owner's earlier transfer, with the product back in this
    // wallet and registered: the outcome and its ticket are as proved.
    listFaceRecovery.mockResolvedValueOnce({
      supported: true,
      complete: true,
      withheld: 0,
      continuation: null,
      items: [{ ...transferred, holding: "registered" }, heldWrite],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      items: [
        {
          operationId: transferred.operation_id,
          outcome: "transferred",
          holding: "registered",
          acknowledgeable: true,
        },
        { operationId: heldWrite.operation_id, holding: null },
      ],
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(acknowledgeFaceRecovery).toHaveBeenCalledWith(face, {
      operation_id: transferred.operation_id,
      ticket: transferred.ticket,
    });
  });

  it("hands a page's discovery tickets straight back, once, while the launch is live", async () => {
    confirmFaceDiscovery.mockClear();
    listFaceRecovery
      .mockResolvedValueOnce({
        supported: true,
        complete: true,
        withheld: 0,
        continuation: "continue-after-held-prefix",
        items: [heldWrite],
        discovered: ["discovery-ticket-1"],
      })
      .mockResolvedValueOnce({
        supported: true,
        complete: true,
        withheld: 0,
        continuation: null,
        items: [transferred],
      });
    launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(confirmFaceDiscovery).toHaveBeenCalledTimes(1);
    expect(confirmFaceDiscovery).toHaveBeenCalledWith(face, [
      "discovery-ticket-1",
    ]);
  });

  it("follows the listing's continuation pages deterministically, later pages replacing unchecked items", async () => {
    const unchecked = {
      ...transferred,
      outcome: "not_checked",
      ticket: null,
    };
    listFaceRecovery
      .mockResolvedValueOnce({
        supported: true,
        complete: true,
        withheld: 0,
        continuation: "continue-after-held-prefix",
        items: [heldWrite, unchecked],
      })
      .mockResolvedValueOnce({
        supported: true,
        complete: true,
        withheld: 0,
        continuation: null,
        items: [transferred],
      });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(2);
    expect(listFaceRecovery).toHaveBeenNthCalledWith(1, face);
    expect(listFaceRecovery).toHaveBeenNthCalledWith(
      2,
      face,
      "continue-after-held-prefix",
    );
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        { operationId: "case-0123456789abcdef", outcome: "outcome_unknown" },
        {
          operationId: "xfer-f0a31dc6781e57f040c2",
          outcome: "transferred",
          acknowledgeable: true,
        },
      ],
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(acknowledgeFaceRecovery).toHaveBeenCalledWith(face, {
      operation_id: "xfer-f0a31dc6781e57f040c2",
      ticket: "ack-ticket-f0a31dc6",
    });
  });

  it("keeps the continuation when the page bound is reached: proved items stay acknowledgeable, and Continue checking resolves the rest", async () => {
    // A queue of 225 items: nine pages of 25, the first 200 a held prefix,
    // the one valid completion on the ninth page. The caps stay as they are.
    const heldItem = (page: number, index: number) => ({
      ...heldWrite,
      operation_id: `case-${String(page).padStart(2, "0")}${String(index).padStart(4, "0")}aaaaaaaaaa`,
    });
    listFaceRecovery.mockImplementation(async (...args: unknown[]) => {
      const continuation = args[1] as string | undefined;
      const page = continuation
        ? Number(continuation.slice("page-".length)) + 1
        : 1;
      if (page === 9) {
        return {
          supported: true,
          complete: true,
          withheld: 0,
          continuation: null,
          items: [transferred],
        };
      }
      return {
        supported: true,
        complete: true,
        withheld: 0,
        continuation: `page-${page}`,
        items: Array.from({ length: 25 }, (_, index) => heldItem(page, index)),
      };
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    // Eight pages followed: 200 held items, scans complete, more to check.
    expect(listFaceRecovery).toHaveBeenCalledTimes(8);
    expect(listFaceRecovery).toHaveBeenNthCalledWith(8, face, "page-7");
    const shown = hook.result.current.notice;
    expect(shown).toMatchObject({
      kind: "recovery",
      complete: true,
      moreToCheck: true,
      withheld: 0,
    });
    expect(shown?.kind === "recovery" ? shown.items : []).toHaveLength(200);
    expect(
      (shown?.kind === "recovery" ? shown.items : []).every(
        (item) => item.outcome === "outcome_unknown" && !item.acknowledgeable,
      ),
    ).toBe(true);
    // Continue checking: the ninth page, from the kept continuation.
    await act(async () => {
      hook.result.current.continueRecovery();
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(9);
    expect(listFaceRecovery).toHaveBeenNthCalledWith(9, face, "page-8");
    const continued = hook.result.current.notice;
    expect(continued).toMatchObject({
      kind: "recovery",
      complete: true,
      moreToCheck: false,
      withheld: 0,
    });
    const items = continued?.kind === "recovery" ? continued.items : [];
    expect(items).toHaveLength(201);
    expect(items.at(-1)).toMatchObject({
      operationId: "xfer-f0a31dc6781e57f040c2",
      outcome: "transferred",
      acknowledgeable: true,
    });
    // Nothing left to continue: a further request is a no-op.
    await act(async () => {
      hook.result.current.continueRecovery();
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(9);
    // Seeing it acknowledges exactly the proved item, once.
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(acknowledgeFaceRecovery).toHaveBeenCalledWith(face, {
      operation_id: "xfer-f0a31dc6781e57f040c2",
      ticket: "ack-ticket-f0a31dc6",
    });
    expect(listRetainedTransferSteps).not.toHaveBeenCalled();
  });

  it("a page that cannot be read makes the check incomplete until it is re-read; a genuinely incomplete scan stays incomplete", async () => {
    listFaceRecovery
      .mockResolvedValueOnce({
        supported: true,
        complete: true,
        withheld: 0,
        continuation: "page-two",
        items: [transferred],
      })
      .mockRejectedValueOnce(new Error("lost"));
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(2);
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      complete: false,
      moreToCheck: true,
      withheld: 0,
      items: [{ outcome: "transferred", acknowledgeable: false }],
    });
    // Re-read from the kept continuation: the page now answers, complete.
    listFaceRecovery.mockResolvedValueOnce({
      supported: true,
      complete: true,
      withheld: 0,
      continuation: null,
      items: [heldWrite],
    });
    await act(async () => {
      hook.result.current.continueRecovery();
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenNthCalledWith(3, face, "page-two");
    expect(hook.result.current.notice).toMatchObject({
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        { outcome: "transferred", acknowledgeable: true },
        { outcome: "outcome_unknown", acknowledgeable: false },
      ],
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    acknowledgeFaceRecovery.mockClear();

    // A runtime scan the BFF reports incomplete: nothing is acknowledgeable,
    // however many pages, and dismissing acknowledges nothing.
    listFaceRecovery.mockReset().mockResolvedValue({
      supported: true,
      complete: false,
      withheld: 0,
      continuation: null,
      items: [transferred],
    });
    const second = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(second.hook.result.current.notice).toMatchObject({
      complete: false,
      moreToCheck: false,
      withheld: 0,
      items: [{ outcome: "transferred", acknowledgeable: false }],
    });
    act(() => second.hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
  });

  it("shows a proved and a held item, acknowledges only the ticketed one on dismiss, once, and skips the retained read", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [transferred, heldWrite],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(listFaceRecovery).toHaveBeenCalledTimes(1);
    expect(listFaceRecovery).toHaveBeenCalledWith(face);
    expect(hook.result.current.notice).toEqual({
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        {
          operationId: "xfer-f0a31dc6781e57f040c2",
          kind: "transfer",
          operation: "transfer.transfer",
          step: "transfer",
          outcome: "transferred",
          holding: "elsewhere",
          acknowledgeable: true,
        },
        {
          operationId: "case-0123456789abcdef",
          kind: "runtime",
          operation: "case.open",
          step: null,
          outcome: "outcome_unknown",
          holding: null,
          acknowledgeable: false,
        },
      ],
    });
    // The ticket never reaches the notice.
    expect(JSON.stringify(hook.result.current.notice)).not.toContain(
      "ack-ticket",
    );
    // The runtime listing supersedes the cookie-based retained read.
    expect(listRetainedTransferSteps).not.toHaveBeenCalled();
    expect(readTransferProgress).not.toHaveBeenCalled();
    // Seeing it is the last condition: nothing is acknowledged before.
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    act(() => hook.result.current.dismissNotice());
    expect(hook.result.current.notice).toBeNull();
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(acknowledgeFaceRecovery).toHaveBeenCalledWith(face, {
      operation_id: "xfer-f0a31dc6781e57f040c2",
      ticket: "ack-ticket-f0a31dc6",
    });
    // Never twice.
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(executeTransferAction).not.toHaveBeenCalled();
    expect(executeSettleAction).not.toHaveBeenCalled();
  });

  it("a failed acknowledgement changes nothing and is not retried", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [transferred],
    });
    acknowledgeFaceRecovery.mockRejectedValue(
      new ProductFaceError("outcome_unknown", 409),
    );
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    await act(async () => {
      hook.result.current.dismissNotice();
      await tick();
    });
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
    expect(hook.result.current.notice).toBeNull();
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).toHaveBeenCalledTimes(1);
  });

  // An incomplete check acknowledges nothing, even an item that was proved
  // and that the BFF ticketed anyway.
  it("an incomplete check is shown as such and acknowledges nothing", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: false,
      withheld: 1,
      items: [transferred, heldWrite],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toMatchObject({
      kind: "recovery",
      complete: false,
      moreToCheck: false,
      withheld: 1,
      items: [
        { operationId: transferred.operation_id, acknowledgeable: false },
        { operationId: heldWrite.operation_id, acknowledgeable: false },
      ],
    });
    expect(listRetainedTransferSteps).not.toHaveBeenCalled();
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBeNull();
  });

  // Held, unknown, refused and unchecked items are never acknowledged, even
  // if a ticket arrives for one.
  it.each(["write_refused", "outcome_unknown", "not_checked"] as const)(
    "a ticketed %s item is shown but never acknowledged",
    async (outcome) => {
      listFaceRecovery.mockResolvedValue({
        supported: true,
        complete: true,
        withheld: 0,
        items: [{ ...heldWrite, outcome, ticket: "ack-ticket-held" }],
      });
      const { hook } = launch();
      await act(async () => {
        initialized?.(fakeHost);
        await tick();
      });
      expect(hook.result.current.notice).toMatchObject({
        kind: "recovery",
        items: [{ outcome, acknowledgeable: false }],
      });
      act(() => hook.result.current.dismissNotice());
      expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    },
  );

  it("an incomplete check with nothing listed is still reported", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: false,
      withheld: 0,
      items: [],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toEqual({
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: false,
      moreToCheck: false,
      withheld: 0,
      items: [],
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
  });

  it("a complete check with nothing listed shows nothing and reads nothing more", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toBeNull();
    expect(listRetainedTransferSteps).not.toHaveBeenCalled();
  });

  it("a runtime without r20 fails closed: today's retained read runs unchanged and nothing is acknowledged", async () => {
    listFaceRecovery.mockResolvedValue(unsupportedRecovery);
    listRetainedTransferSteps.mockResolvedValue([retainedStep]);
    readTransferProgress.mockResolvedValue({
      status: "transferred",
      step: "transfer",
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(listRetainedTransferSteps).toHaveBeenCalledTimes(1);
    expect(listRetainedTransferSteps).toHaveBeenCalledWith(face);
    expect(readTransferProgress).toHaveBeenCalledTimes(1);
    expect(readTransferProgress.mock.calls[0]).toEqual([
      face,
      "xfer-0b1c2d3e4f5a6b7c8d9e",
    ]);
    expect(hook.result.current.notice).toEqual({
      kind: "transfer_step",
      reason: "transferred",
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    expect(executeTransferAction).not.toHaveBeenCalled();
  });

  it("a listing the BFF could not read fails closed the same way", async () => {
    listFaceRecovery.mockRejectedValue(
      new ProductFaceError("temporarily_unavailable", 503),
    );
    listRetainedTransferSteps.mockResolvedValue([retainedStep]);
    readTransferProgress.mockResolvedValue({
      status: "outcome_unknown",
      step: "transfer",
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(listRetainedTransferSteps).toHaveBeenCalledTimes(1);
    expect(hook.result.current.notice).toEqual({
      kind: "transfer_step",
      reason: "outcome_unknown",
    });
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
  });

  // The listing may still be in flight when this launch stops being the live
  // one. A late answer must never land a notice, keep a ticket or dispatch
  // the retained read in whatever host is current.
  it.each(changes)(
    "%s while the listing is pending: no notice, no acknowledgement, no further read",
    async (_label, change) => {
      const listing = deferred<unknown>();
      listFaceRecovery.mockImplementation(() => listing.promise);
      const launched = launch();
      const resume = initialized!;
      await act(async () => {
        resume(fakeHost);
        await tick();
      });
      expect(listFaceRecovery).toHaveBeenCalledTimes(1);
      change(launched, endSession);
      // The replacing host's own listing (a frame reload) stays pending too.
      listFaceRecovery.mockImplementation(() => new Promise(() => undefined));
      await act(async () => {
        listing.resolve({
          supported: true,
          complete: true,
          withheld: 0,
          items: [transferred],
        });
        await tick();
      });
      expect(launched.hook.result.current.notice).toBeNull();
      expect(listRetainedTransferSteps).not.toHaveBeenCalled();
      act(() => launched.hook.result.current.dismissNotice());
      expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    },
  );

  it.each(changes)(
    "%s while an unsupported listing is pending: the retained read is not dispatched either",
    async (_label, change) => {
      const listing = deferred<unknown>();
      listFaceRecovery.mockImplementation(() => listing.promise);
      listRetainedTransferSteps.mockResolvedValue([retainedStep]);
      const launched = launch();
      const resume = initialized!;
      await act(async () => {
        resume(fakeHost);
        await tick();
      });
      change(launched, endSession);
      listFaceRecovery.mockImplementation(() => new Promise(() => undefined));
      await act(async () => {
        listing.resolve(unsupportedRecovery);
        await tick();
      });
      expect(listRetainedTransferSteps).not.toHaveBeenCalled();
      expect(readTransferProgress).not.toHaveBeenCalled();
      expect(launched.hook.result.current.notice).toBeNull();
    },
  );

  it("a dismissal after the launch ended acknowledges nothing", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [transferred],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toMatchObject({ kind: "recovery" });
    fakeHost.session.ended = "logout";
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBeNull();
  });

  it("a dismissal after the account changed acknowledges nothing", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [transferred],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    act(() => endSession());
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
  });

  it("a frame reload drops the replaced host's tickets before its own listing answers", async () => {
    listFaceRecovery.mockResolvedValue({
      supported: true,
      complete: true,
      withheld: 0,
      items: [transferred],
    });
    const { hook } = launch();
    await act(async () => {
      initialized?.(fakeHost);
      await tick();
    });
    expect(hook.result.current.notice).toMatchObject({ kind: "recovery" });
    listFaceRecovery.mockImplementation(() => new Promise(() => undefined));
    act(() =>
      hook.result.current.onFrameLoad(document.createElement("iframe")),
    );
    act(() => hook.result.current.dismissNotice());
    expect(acknowledgeFaceRecovery).not.toHaveBeenCalled();
  });
});
