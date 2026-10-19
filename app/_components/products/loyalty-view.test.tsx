import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoyaltyView } from "@/app/_components/products/loyalty-view";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) => translations(namespace),
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
  };
});
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({ wallet: { id: "wallet-1" } }),
}));

const HASH = `sha256:${"a".repeat(64)}`;
const programme = {
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  open: true,
  name: "Harbour Makers Circle",
  headline: "Make and learn",
  memberPromise: "Verified workshops count.",
  termsVersion: "HMC-2026-1",
  consentStatement: "I agree that my verified workshops are recorded.",
  dataUse: "Used only for this programme.",
  consentFingerprint: HASH,
  activities: [
    { activityType: "workshop", label: "Workshop", evidenceHint: "Sign-in" },
  ],
};
let membership: Record<string, unknown>;
/** The submit step's answer is lost (a network failure after prepare). */
let loseSubmit = false;
const OPERATION = `loy-${"a1".repeat(12)}`;
const sent: Array<Record<string, unknown>> = [];
const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  sent.push(body);
  if (body.transition === "submit" && loseSubmit) {
    throw new TypeError("Failed to fetch");
  }
  if (body.transition === "prepare" || body.transition === "submit") {
    const reply =
      body.transition === "prepare"
        ? { prepared: { operationId: OPERATION, activityType: "workshop" } }
        : {
            submission: {
              operationId: OPERATION,
              activityType: "workshop",
              status: "submitted",
            },
          };
    return { ok: true, status: 200, json: async () => reply } as Response;
  }
  const reply =
    body.transition === "programme"
      ? { programme }
      : body.transition === "membership"
        ? { membership, submissions: [] }
        : body.transition === "join"
          ? {
              join: {
                requestId: `areq_${"j".repeat(24)}`,
                termsVersion: "HMC-2026-1",
                consentHash: HASH,
                requestedAt: "2026-10-19T09:00:00.000Z",
              },
            }
          : {};
  return {
    ok: true,
    status: 200,
    json: async () => reply,
  } as Response;
});

beforeEach(() => {
  sent.length = 0;
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  membership = { status: "none" };
  loseSubmit = false;
});

const view = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LoyaltyView slug="morrow-home" programmeName="Harbour Nights" />
    </QueryClientProvider>,
  );

it("joins only on the member's own consent, to exactly the terms shown", async () => {
  const user = userEvent.setup();
  view();
  const join = await screen.findByRole("button", {
    name: "Join the programme",
  });
  await user.click(join);
  expect(await screen.findByText("Agree to the terms to join.")).toBeTruthy();
  expect(sent.some((body) => body.transition === "join")).toBe(false);
  await user.click(
    screen.getByRole("checkbox", { name: /I agree to these terms/ }),
  );
  await user.click(join);
  await waitFor(() =>
    expect(sent.find((body) => body.transition === "join")).toEqual({
      transition: "join",
      consent: {
        accepted: true,
        terms_version: "HMC-2026-1",
        fingerprint: HASH,
      },
    }),
  );
});

it.each([
  [{ status: "pending_pass" }, /its pass isn't in your wallet yet/],
  [{ status: "unconfirmed" }, /can't be confirmed right now/],
  [
    {
      status: "held",
      membership: {
        objectId: "6c00000000000000000000c1",
        state: "Suspended",
        recordedAt: "2026-10-19T09:00:00.000Z",
      },
    },
    /on hold/,
  ],
])("shows %j honestly, with no activity form", async (value, text) => {
  membership = value;
  view();
  expect(await screen.findByText(text)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Submit activity" })).toBeNull();
  expect(screen.queryByText(/points|tier/i)).toBeNull();
});

it("offers the activity form only to a proven active member", async () => {
  membership = {
    status: "active",
    membership: {
      objectId: "6c00000000000000000000c1",
      state: "Member",
      recordedAt: "2026-10-19T09:00:00.000Z",
    },
  };
  view();
  expect(await screen.findByText("You're a member.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Submit activity" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: /What you did/ })).toBeTruthy();
});

const activeMembership = {
  status: "active",
  membership: {
    objectId: "6c00000000000000000000c1",
    state: "Member",
    recordedAt: "2026-10-19T09:00:00.000Z",
  },
};

it("a double click prepares once and sends that one operation once", async () => {
  membership = activeMembership;
  const user = userEvent.setup();
  view();
  await user.type(
    await screen.findByRole("textbox", { name: /What you did/ }),
    "Workshop sign-in 0042",
  );
  await user.dblClick(screen.getByRole("button", { name: "Submit activity" }));
  expect(
    await screen.findByText(
      "Submitted. Waiting for the programme to verify it.",
    ),
  ).toBeTruthy();
  const steps = sent.filter((body) =>
    ["prepare", "submit"].includes(String(body.transition)),
  );
  expect(steps).toEqual([
    {
      transition: "prepare",
      activity_type: "workshop",
      evidence_ref: "Workshop sign-in 0042",
    },
    {
      transition: "submit",
      operation_id: OPERATION,
      activity_type: "workshop",
      evidence_ref: "Workshop sign-in 0042",
    },
  ]);
});

it("a submit answer lost after prepare is shown as possibly sent under its operation, never 'nothing recorded'", async () => {
  membership = activeMembership;
  loseSubmit = true;
  const user = userEvent.setup();
  view();
  await user.type(
    await screen.findByRole("textbox", { name: /What you did/ }),
    "Workshop sign-in 0042",
  );
  await user.click(screen.getByRole("button", { name: "Submit activity" }));
  expect(
    await screen.findByText(
      "This may have been sent, but its outcome isn't confirmed yet. It won't be sent again.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Nothing new was recorded/)).toBeNull();
  expect(sent.filter((body) => body.transition === "submit")).toHaveLength(1);
});
