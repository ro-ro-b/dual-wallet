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
const sent: Array<Record<string, unknown>> = [];
const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  sent.push(body);
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
