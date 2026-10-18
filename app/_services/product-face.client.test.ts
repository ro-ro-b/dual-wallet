import { getEbusApi } from "@/api/web-sdk-client";
import { signActionWithPasskey } from "@/app/_adapters/webauthn.client";
import {
  executeSettleAction,
  forgetFaceHandoverTickets,
  listFaceRecovery,
  loadProductFaceContext,
  readProgrammeProductHistory,
  takeFaceHandoverTicket,
} from "@/app/_services/product-face.client";

jest.mock("@/api/web-sdk-client", () => ({
  getEbusApi: jest.fn(),
  getObjectsApi: jest.fn(),
  normalizeApiError: jest.fn(async () => ({ message: "failed", status: 400 })),
}));
jest.mock("@/app/_adapters/webauthn.client", () => ({
  base64urlToBytes: jest.fn(() => Uint8Array.from([1, 2, 3])),
  signActionWithPasskey: jest.fn(),
}));

const mockedApi = jest.mocked(getEbusApi);
const OBJECT = "aaaaaaaaaaaaaaaaaaaaaaaa";
const input = {
  custom: {
    state: "Authenticity verified",
    lifecycle: { target_state: "Authenticity verified" },
  },
};
// The launch binding a face step carries (contract r18); always live here.
const face = {
  launchId: "launch-aaaaaaaaaaaaaaaaaaaa",
  slug: "morrow-home",
  operationId: "settle-0123456789abcdef",
  walletId: "wallet-1",
  assertLive: jest.fn(),
};
const bound = expect.any(Function);
const expectedAction = {
  update: { id: OBJECT, data: { custom: input.custom }, secret: undefined },
};

function api() {
  const executeAction = jest
    .fn()
    .mockResolvedValue({ actionId: "action-settle-1", steps: [] });
  const prepareAction = jest
    .fn()
    .mockResolvedValue({ nonce: 4, challenge: "AQID" });
  mockedApi.mockReturnValue({
    executeAction,
    prepareAction,
  } as unknown as ReturnType<typeof getEbusApi>);
  return { executeAction, prepareAction };
}

describe("holder settle execution", () => {
  beforeEach(() => jest.clearAllMocks());

  it("executes the exact proposal through the email path with the wallet's current action number", async () => {
    const { executeAction, prepareAction } = api();
    await expect(
      executeSettleAction({
        objectId: OBJECT,
        action: "update",
        input,
        authenticationMethod: "email",
        face,
      }),
    ).resolves.toEqual({ actionId: "action-settle-1" });
    // The same exact body is prepared (bound) and then executed, unsigned.
    expect(prepareAction).toHaveBeenCalledWith(
      { prepareExecuteRequest: { action: expectedAction } },
      bound,
    );
    expect(executeAction).toHaveBeenCalledWith(
      { executeRequest: { action: expectedAction, nonce: 4 } },
      bound,
    );
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("prepares and signs as the holder for passkey sessions", async () => {
    const { executeAction, prepareAction } = api();
    jest.mocked(signActionWithPasskey).mockResolvedValue({
      credentialId: "credential-1",
      clientDataJson: "client",
      authenticatorData: "auth",
      signature: "sig",
    } as never);
    await executeSettleAction({
      objectId: OBJECT,
      action: "update",
      alias: "verify_authenticity",
      input,
      authenticationMethod: "passkey",
      face,
    });
    expect(prepareAction).toHaveBeenCalledWith(
      {
        prepareExecuteRequest: {
          action: { ...expectedAction, alias: "verify_authenticity" },
        },
      },
      bound,
    );
    expect(signActionWithPasskey).toHaveBeenCalledWith("AQID");
    expect(executeAction).toHaveBeenCalledWith(
      { executeRequest: expect.objectContaining({ nonce: 4 }) },
      bound,
    );
  });

  it("signs with the connected EOA for EOA sessions", async () => {
    const { executeAction } = api();
    const request = jest.fn().mockResolvedValue("0xsignature");
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: { request },
    });
    await executeSettleAction({
      objectId: OBJECT,
      action: "update",
      input,
      authenticationMethod: "eoa",
      controllerAddress: "0xcontroller",
      face,
    });
    expect(request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: ["0x010203", "0xcontroller"],
    });
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("maps the reviewed Dual update body onto the same executor input", async () => {
    const { executeAction } = api();
    await executeSettleAction({
      objectId: OBJECT,
      action: "update",
      input: { data: { custom: input.custom } },
      authenticationMethod: "email",
      face,
    });
    expect(executeAction).toHaveBeenCalledWith(
      { executeRequest: { action: expectedAction, nonce: 4 } },
      bound,
    );
    await expect(
      executeSettleAction({
        objectId: OBJECT,
        action: "update",
        input: { data: { custom: input.custom, secret: "x" } },
        authenticationMethod: "email",
        face,
      }),
    ).rejects.toMatchObject({ code: "proposal_rejected" });
  });

  it.each(["claim_ownership", "transfer", "burn", "permit"])(
    "never executes %s as a settle",
    async (action) => {
      const { executeAction, prepareAction } = api();
      await expect(
        executeSettleAction({
          objectId: OBJECT,
          action,
          input: {},
          authenticationMethod: "email",
          face,
        }),
      ).rejects.toMatchObject({ code: "proposal_rejected" });
      expect(executeAction).not.toHaveBeenCalled();
      expect(prepareAction).not.toHaveBeenCalled();
    },
  );
});

describe("launch-local handover tickets (contract r14)", () => {
  const TICKET = "k".repeat(43);
  const contextAnswer = () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        application: {},
        frameUrl: "https://faces.example/face/",
        handover: { ticket: TICKET },
      }),
    }) as unknown as Response;

  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(async () => contextAnswer()) as typeof fetch;
  });
  afterEach(() => {
    forgetFaceHandoverTickets();
    global.fetch = originalFetch;
  });

  it("are held for their launch only, taken once, and kept out of the context", async () => {
    const context = await loadProductFaceContext(
      { slug: "morrow-home", launchId: "launch-a" },
      "/register",
    );
    expect(context).not.toHaveProperty("handover");
    expect(takeFaceHandoverTicket("launch-b")).toBeUndefined();
    expect(takeFaceHandoverTicket("launch-a")).toEqual({
      kind: "handover",
      ticket: TICKET,
    });
    expect(takeFaceHandoverTicket("launch-a")).toBeUndefined();
  });

  it("are forgotten when the session ends or changes account", async () => {
    await loadProductFaceContext(
      { slug: "morrow-home", launchId: "launch-c" },
      "/register",
    );
    forgetFaceHandoverTickets();
    expect(takeFaceHandoverTicket("launch-c")).toBeUndefined();
  });
});

// The face's History reads the product's own public history through the
// host (api/product-history.ts): the client keeps each action's id and
// status exactly, and any answer that is not that shape is unavailable.
describe("product history through the host", () => {
  const MUG = "6ad42c64f62f7c23306b2a6b";
  const launch = { slug: "tidewell", launchId: "launch-aaaaaaaaaaaaaaaaaaaa" };
  const realFetch = global.fetch;
  const answer = (status: number, body: unknown) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("asks the host for the selected unit's history under the launch and keeps each action's id and status", async () => {
    const fetchSpy = answer(200, {
      entries: [
        {
          action_id: "6ad485b5",
          action: "update",
          status: "pending",
          when: "2026-10-18T08:39:00.000Z",
        },
        {
          action_id: "6ad484562b60345f345efbc7",
          action: "update",
          status: "completed",
          when: "2026-10-18T07:19:00.000Z",
        },
        {
          action_id: "6ad48000",
          action: "mint",
          status: "unknown",
          when: "2026-10-18T04:01:00.000Z",
        },
      ],
    });
    const entries = await readProgrammeProductHistory(
      launch as unknown as Parameters<typeof readProgrammeProductHistory>[0],
      MUG,
    );
    expect(
      entries.map(({ actionId, action, status }) => [actionId, action, status]),
    ).toEqual([
      ["6ad485b5", "update", "pending"],
      ["6ad484562b60345f345efbc7", "update", "completed"],
      ["6ad48000", "mint", "unknown"],
    ]);
    expect(entries[2].when).toEqual(new Date("2026-10-18T04:01:00.000Z"));
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/tidewell/units/${MUG}/history`);
    expect((init as RequestInit).headers).toMatchObject({
      "x-dual-face-launch": "launch-aaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("an answer that is not exactly the history shape is unavailable, never shown in part", async () => {
    for (const body of [
      {},
      {
        entries: [
          {
            action_id: "a",
            action: "update",
            status: "settled",
            when: "2026-10-18T04:01:00.000Z",
          },
        ],
      },
      {
        entries: [
          {
            action_id: "a",
            action: "update",
            status: "completed",
            when: "not a date",
          },
        ],
      },
      {
        entries: [
          {
            action: "update",
            status: "completed",
            when: "2026-10-18T04:01:00.000Z",
          },
        ],
      },
    ]) {
      answer(200, body);
      await expect(
        readProgrammeProductHistory(
          launch as unknown as Parameters<
            typeof readProgrammeProductHistory
          >[0],
          MUG,
        ),
      ).rejects.toMatchObject({ code: "temporarily_unavailable" });
    }
  });

  it("the host's refusal keeps its own code", async () => {
    answer(502, { code: "history_unavailable" });
    await expect(
      readProgrammeProductHistory(
        launch as unknown as Parameters<typeof readProgrammeProductHistory>[0],
        MUG,
      ),
    ).rejects.toMatchObject({ code: "history_unavailable", status: 502 });
  });
});

describe("the recovery listing's holding read (proposed r20)", () => {
  const launch = { slug: "tidewell", launchId: "launch-aaaaaaaaaaaaaaaaaaaa" };
  const realFetch = global.fetch;
  const listed = (holding?: unknown) => ({
    supported: true,
    complete: true,
    withheld: 0,
    continuation: null,
    items: [
      {
        operation_id: "xfer-f0a31dc6781e57f040c2",
        kind: "transfer",
        operation: "transfer.transfer",
        object_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
        case_id: null,
        offer_id: "pto-bbbbbbbbbbbbbbbbbbbbbbbb",
        step: "transfer",
        outcome: "transferred",
        ...(holding === undefined ? {} : { holding }),
        ticket: "ack-ticket",
      },
    ],
  });
  const answer = (body: unknown) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as Response) as unknown as typeof fetch;
  };
  const list = () =>
    listFaceRecovery(
      launch as unknown as Parameters<typeof listFaceRecovery>[0],
    );
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("keeps the BFF's fresh holding, and reads an answer without one as unread", async () => {
    for (const holding of ["registered", "held", "elsewhere", null]) {
      answer(listed(holding));
      expect((await list()).items[0].holding).toBe(holding);
    }
    answer(listed());
    expect((await list()).items[0]).toMatchObject({
      outcome: "transferred",
      holding: null,
    });
  });

  it("refuses a holding outside the vocabulary whole, as any other malformed answer", async () => {
    for (const holding of ["yours", 1, {}]) {
      answer(listed(holding));
      await expect(list()).rejects.toMatchObject({
        code: "temporarily_unavailable",
      });
    }
  });
});
