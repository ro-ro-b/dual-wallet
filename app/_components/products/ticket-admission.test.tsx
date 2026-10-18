import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketAdmission } from "@/app/_components/products/ticket-admission";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
  };
});

const HOLDER = "0x1234567890abcdef1234567890abcdef12345678";
let wallet = {
  id: "wallet-1",
  account: { address: HOLDER },
  controller: { address: "0xc" },
};
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({ wallet, authenticationMethod: "email" }),
}));

const executeInventoryAction = jest.fn();
jest.mock("@/app/_services/action-executor.client", () => ({
  executeInventoryAction: (...args: unknown[]) =>
    executeInventoryAction(...args),
}));

const OBJECT = "7d00000000000000000000a1";
const REQUEST = `tad-${"1".repeat(32)}`;
const OP = "adm-0123456789abcdef01234567";
const CUSTOM = {
  state: "Admitted",
  admissionStatus: "Admitted",
  title: "Harbour Night",
};
const request = {
  requestId: REQUEST,
  eventRef: "harbour-night",
  createdAt: "2026-10-18T19:00:00.000Z",
  expiresAt: "2026-10-18T19:05:00.000Z",
};

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply[]>;
const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
  const { transition } = JSON.parse(String(init.body)) as {
    transition: string;
  };
  const reply = replies[transition]?.shift() ?? { status: 500, body: {} };
  return {
    ok: reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
  } as Response;
});
const sent = (transition: string) =>
  fetchMock.mock.calls.filter(
    ([, init]) => JSON.parse(String(init.body)).transition === transition,
  ).length;

beforeEach(() => {
  fetchMock.mockClear();
  executeInventoryAction.mockReset().mockResolvedValue({ actionId: "act-1" });
  global.fetch = fetchMock as unknown as typeof fetch;
  wallet = {
    id: "wallet-1",
    account: { address: HOLDER },
    controller: { address: "0xc" },
  };
  replies = {
    check: [
      { status: 200, body: { state: { status: "awaiting_holder", request } } },
    ],
    begin: [
      {
        status: 200,
        body: {
          custom: CUSTOM,
          confirmation: {
            operationId: OP,
            objectId: OBJECT,
            request,
            expiresAt: request.expiresAt,
            event: {
              title: "Harbour Night",
              venue: "Quay Hall",
              startsAt: "2026-10-18T18:00:00.000Z",
            },
            window: {
              startsAt: "2026-10-18T18:00:00.000Z",
              endsAt: "2026-10-18T23:00:00.000Z",
            },
            holder: HOLDER,
            effect: { from: "Valid", to: "Admitted" },
          },
        },
      },
    ],
    confirm: [{ status: 200, body: { reservation: "won" } }],
    record_action: [
      {
        status: 200,
        body: {
          outcome: {
            status: "admitted",
            admission: {
              requestId: REQUEST,
              actionId: "act-1",
              admittedAt: "2026-10-18T19:01:00.000Z",
              receiptId: "rcpt-1",
            },
          },
        },
      },
    ],
    cancel: [{ status: 200, body: {} }],
    status: [
      {
        status: 200,
        body: {
          outcome: {
            status: "admitted",
            admission: {
              requestId: REQUEST,
              actionId: "act-1",
              admittedAt: "2026-10-18T19:01:00.000Z",
              receiptId: "rcpt-1",
            },
          },
        },
      },
    ],
  };
});

const view = () =>
  render(
    <TicketAdmission
      slug="morrow-home"
      objectId={OBJECT}
      launchId={`launch-${"q".repeat(28)}`}
    />,
  );

async function openConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Check for entry request" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Review entry request" }),
  );
  return screen.findByRole("dialog", { name: "Confirm your entry" });
}

it("shows server-read facts natively, starts on Cancel, and Escape cancels with zero writes", async () => {
  const user = userEvent.setup();
  view();
  const dialog = await openConfirmation(user);
  for (const fact of [
    "Harbour Night",
    "Quay Hall",
    REQUEST,
    HOLDER,
    "This ticket's status changes from Valid to Admitted. Nothing else on the ticket changes.",
  ]) {
    expect(within(dialog).getByText(fact)).toBeTruthy();
  }
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Cancel" }),
  );
  replies.check.push({
    status: 200,
    body: { state: { status: "awaiting_holder", request } },
  });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sent("cancel")).toBe(1));
  expect(sent("confirm")).toBe(0);
  expect(executeInventoryAction).not.toHaveBeenCalled();
});

it("confirms from the keyboard, signs exactly the confirmed update once, and shows entry only from the verified outcome", async () => {
  const user = userEvent.setup();
  view();
  const dialog = await openConfirmation(user);
  await user.tab();
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Confirm entry" }),
  );
  await user.keyboard("{Enter}");
  expect(
    await screen.findByText(/Entry confirmed\. Gate request/),
  ).toBeTruthy();
  expect(executeInventoryAction).toHaveBeenCalledTimes(1);
  const [action, method, , face] = executeInventoryAction.mock.calls[0];
  expect(action).toEqual({ update: { id: OBJECT, data: { custom: CUSTOM } } });
  expect(method).toBe("email");
  expect(face).toEqual(
    expect.objectContaining({
      operationId: OP,
      slug: "morrow-home",
      walletId: "wallet-1",
    }),
  );
  expect(sent("confirm")).toBe(1);
  expect(sent("record_action")).toBe(1);
});

it("an account change before signing stops the step; the attempt stays unknown, never re-sent", async () => {
  executeInventoryAction.mockImplementation(
    async (_action, _method, _controller, face: { assertLive(): void }) => {
      face.assertLive();
      return { actionId: "act-1" };
    },
  );
  const user = userEvent.setup();
  const { rerender } = view();
  const dialog = await openConfirmation(user);
  // Another account signs in while the confirmation is open.
  wallet = {
    id: "wallet-2",
    account: { address: "0x00000000000000000000000000000000000000aa" },
    controller: { address: "0xd" },
  };
  rerender(
    <TicketAdmission
      slug="morrow-home"
      objectId={OBJECT}
      launchId={`launch-${"q".repeat(28)}`}
    />,
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm entry" }),
  );
  // The confirming identity is not the gate request's holder: nothing is reserved.
  expect(await screen.findByText(/Your session has ended/)).toBeTruthy();
  expect(sent("confirm")).toBe(0);
});

it("a session change between reserve and sign leaves the original operation unknown, with only a status check", async () => {
  executeInventoryAction.mockImplementation(
    async (_action, _method, _controller, face: { assertLive(): void }) => {
      wallet = {
        id: "wallet-2",
        account: { address: "0x00000000000000000000000000000000000000aa" },
        controller: { address: "0xd" },
      };
      rerenderNow();
      face.assertLive();
      return { actionId: "act-1" };
    },
  );
  const user = userEvent.setup();
  const rendered = view();
  const rerenderNow = () =>
    act(() =>
      rendered.rerender(
        <TicketAdmission
          slug="morrow-home"
          objectId={OBJECT}
          launchId={`launch-${"q".repeat(28)}`}
        />,
      ),
    );
  const dialog = await openConfirmation(user);
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm entry" }),
  );
  expect(await screen.findByText(/It will not be sent again/)).toBeTruthy();
  expect(sent("record_action")).toBe(0);
  await user.click(screen.getByRole("button", { name: "Check entry status" }));
  expect(await screen.findByText(/Entry confirmed/)).toBeTruthy();
  expect(executeInventoryAction).toHaveBeenCalledTimes(1);
});

it("a lost reservation reply is unknown, and nothing is signed", async () => {
  replies.confirm = [{ status: 409, body: { code: "outcome_unknown" } }];
  const user = userEvent.setup();
  view();
  const dialog = await openConfirmation(user);
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm entry" }),
  );
  expect(await screen.findByText(/It will not be sent again/)).toBeTruthy();
  expect(executeInventoryAction).not.toHaveBeenCalled();
});

it("a refusal before the reservation says nothing was sent and is not entry", async () => {
  replies.begin = [{ status: 409, body: { code: "proposal_rejected" } }];
  const user = userEvent.setup();
  view();
  await user.click(
    screen.getByRole("button", { name: "Check for entry request" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Review entry request" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
  expect(screen.queryByText(/Entry confirmed/)).toBeNull();
});

it.each([
  ["none", { status: "none" }, /no entry request/],
  [
    "expired",
    { status: "expired", request },
    /expired before it was confirmed/,
  ],
  [
    "unverified",
    { status: "unverified", requestId: REQUEST },
    /cannot be confirmed right now/,
  ],
])("a %s answer is its own state, never entry", async (_label, state, text) => {
  replies.check = [{ status: 200, body: { state } }];
  const user = userEvent.setup();
  view();
  await user.click(
    screen.getByRole("button", { name: "Check for entry request" }),
  );
  expect(await screen.findByText(text)).toBeTruthy();
  expect(screen.queryByText(/Entry confirmed/)).toBeNull();
});

it("shows the pass and the original issue operation, never the content hash as one", async () => {
  replies.pass = [
    {
      status: 200,
      body: {
        pass: {
          code: `DT1.tkt-1.${"d".repeat(20)}`,
          issuance: {
            recordId: "tkt-1",
            objectId: OBJECT,
            activationHash: "a".repeat(64),
            birthOperationId: `op_${"b".repeat(40)}`,
            birthIdempotencyKey: `tig:dual-operation:${"b".repeat(64)}`,
            birthActionId: "act-mint-1",
            operationReadback: "superseded",
          },
        },
      },
    },
  ];
  const user = userEvent.setup();
  view();
  await user.click(screen.getByRole("button", { name: "Show entry pass" }));
  const operation = await screen.findByText(`op_${"b".repeat(40)}`);
  expect(operation.previousElementSibling?.textContent).toBe("Issue operation");
  expect(screen.getByText("act-mint-1")).toBeTruthy();
  expect(screen.getByText(/this is the original issue operation/)).toBeTruthy();
  // The hash only under its own technical label.
  expect(
    screen
      .getByText("a".repeat(64))
      .closest("details")
      ?.querySelector("summary")?.textContent,
  ).toBe("Issuance content hash (technical)");
});
