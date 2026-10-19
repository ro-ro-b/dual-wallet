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
/** loyalty-benefit-redeem-v1 on the binding, and the BFF's proven view. */
let benefitsOn = false;
let benefitsView: Record<string, unknown> | null = null;
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
  if (body.transition === "benefits") {
    const reply = {
      benefits: benefitsView,
      unconfirmed: false,
      redemptions: [],
    };
    return { ok: true, status: 200, json: async () => reply } as Response;
  }
  if (body.transition === "reference") {
    const reply = {
      reference: { code: "K7QX-2MPD", requestActionId: body.request_action_id },
    };
    return { ok: true, status: 200, json: async () => reply } as Response;
  }
  if (
    body.transition === "redeem_prepare" ||
    body.transition === "redeem_submit"
  ) {
    const reply =
      body.transition === "redeem_prepare"
        ? {
            prepared: {
              operationId: OPERATION,
              benefitId: "studio-hour",
              binding: {
                benefit_id: "studio-hour",
                grant_action_id: "act-0007",
                allocation_id: `alc_${"0".repeat(32)}`,
                revision_hash: HASH,
              },
            },
          }
        : {
            redemption: {
              operationId: OPERATION,
              benefitId: "studio-hour",
              status: "requested",
            },
          };
    return { ok: true, status: 200, json: async () => reply } as Response;
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
        ? { membership, submissions: [], benefits: benefitsOn }
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
  benefitsOn = false;
  benefitsView = null;
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

const reward = (status: string, extra: Record<string, unknown> = {}) => ({
  state: status === "granted" ? "Benefit eligible" : "Redemption pending",
  held: false,
  progress: [
    {
      ruleId: "two-workshops",
      label: "Two verified workshops",
      requiredVerified: 2,
      verified: 2,
      pendingVerification: 0,
      benefitIds: ["studio-hour"],
    },
  ],
  benefits: [
    {
      benefitId: "studio-hour",
      title: "A studio hour",
      description: "One hour in the open studio.",
      terms: "Book at the desk.",
      partnerName: "Harbour Workshop",
      validDays: 30,
      status,
      availability: "available",
    },
  ],
  reward: {
    benefitId: "studio-hour",
    status,
    validUntil: "2026-11-18T09:00:00.000Z",
    grantActionId: "act-0007",
    requestActionId: status === "requested" ? "act-0008" : null,
    failedHandovers: status === "restored" ? 1 : 0,
  },
  actions: {
    submitActivity: false,
    requestRedemption: status === "granted" || status === "restored",
    showReference: status === "requested",
  },
  next: status === "requested" ? "partner" : null,
  ...extra,
});

it("a granted reward offers its one request, and no activity that would strand it", async () => {
  membership = {
    ...activeMembership,
    membership: { ...activeMembership.membership, state: "Benefit eligible" },
  };
  benefitsOn = true;
  benefitsView = reward("granted");
  const user = userEvent.setup();
  view();
  expect(
    await screen.findByText(
      "You have a reward to redeem. Request it before recording more activities.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Submit activity" })).toBeNull();
  await user.dblClick(
    await screen.findByRole("button", { name: "Request redemption" }),
  );
  await waitFor(() =>
    expect(
      sent.filter((body) => body.transition === "redeem_submit"),
    ).toHaveLength(1),
  );
  expect(
    sent.filter((body) => body.transition === "redeem_prepare"),
  ).toHaveLength(1);
  expect(await screen.findByText("Requested.")).toBeTruthy();
});

it("shows the one-time reference only on the member's action, and only in the page", async () => {
  membership = {
    ...activeMembership,
    membership: { ...activeMembership.membership, state: "Redemption pending" },
  };
  benefitsOn = true;
  benefitsView = reward("requested");
  const user = userEvent.setup();
  view();
  expect(
    await screen.findByText(
      "Next: the partner confirms your reference and records the handover.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("K7QX-2MPD")).toBeNull();
  expect(sent.some((body) => body.transition === "reference")).toBe(false);
  await user.click(
    screen.getByRole("button", { name: "Show my one-time reference" }),
  );
  expect(await screen.findByText("K7QX-2MPD")).toBeTruthy();
  expect(
    screen.getByText(/Show this to Harbour Workshop in person. It works once./),
  ).toBeTruthy();
  // Never kept anywhere but this component's state.
  expect(JSON.stringify({ ...window.localStorage })).not.toContain("K7QX");
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("K7QX");
  expect(window.location.href).not.toContain("K7QX");
  await user.click(screen.getByRole("button", { name: "Hide reference" }));
  expect(screen.queryByText("K7QX-2MPD")).toBeNull();
});

it("after a handover that didn't happen, the same reward is offered again until its original validity", async () => {
  membership = {
    ...activeMembership,
    membership: { ...activeMembership.membership, state: "Fulfilment failed" },
  };
  benefitsOn = true;
  benefitsView = reward("restored");
  const user = userEvent.setup();
  view();
  expect(
    await screen.findAllByText(
      "The partner couldn't hand this over, so your reward is kept for you. Request it again when you're ready.",
    ),
  ).not.toHaveLength(0);
  expect(
    screen.getByText(
      "Earlier handovers that didn't happen: 1. Your reward was kept each time.",
    ),
  ).toBeTruthy();
  // The grant's own validity, never extended.
  expect(
    screen.getByText(/Valid until 2026-11-18T09:00:00\.000Z/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Your reward is kept for you after a handover that didn't happen. Request it again before recording more activities.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Submit activity" })).toBeNull();
  await user.click(
    await screen.findByRole("button", { name: "Request redemption" }),
  );
  await waitFor(() =>
    expect(
      sent.filter((body) => body.transition === "redeem_submit"),
    ).toHaveLength(1),
  );
});

it("a restored reward with none available to hand over is kept, never offered, and says so", async () => {
  membership = {
    ...activeMembership,
    membership: { ...activeMembership.membership, state: "Fulfilment failed" },
  };
  benefitsOn = true;
  const restored = reward("restored");
  benefitsView = {
    ...restored,
    benefits: restored.benefits.map((item) => ({
      ...item,
      availability: "unavailable",
    })),
    actions: { ...restored.actions, requestRedemption: false },
  };
  view();
  expect(
    await screen.findByText(
      "None is available to hand over right now (programme record). Your reward stays yours until it expires.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Request redemption" }),
  ).toBeNull();
});

it("a proven handover is said as handed over, with settlement next; never before it", async () => {
  membership = {
    ...activeMembership,
    membership: { ...activeMembership.membership, state: "Fulfilled" },
  };
  benefitsOn = true;
  benefitsView = reward("fulfilled", { next: "settlement" });
  view();
  expect(
    await screen.findAllByText(
      "Handed over: the partner recorded that you received it.",
    ),
  ).not.toHaveLength(0);
  expect(
    screen.getByText("Next: the programme records the partner settlement."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Your benefit was handed over. The programme records the settlement before you can record more activities.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Request redemption" }),
  ).toBeNull();
});
