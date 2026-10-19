import { render, screen, within } from "@testing-library/react";
import { ObjectActions } from "@/app/_components/inventory/object-actions";
import type { InventoryObject } from "@/app/_domain/inventory";
import type { HostPresentation } from "@/app/_domain/wallet-host";
import { HostProvider } from "@/app/_providers/host-provider";

jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) =>
      Object.assign(translations(namespace), { raw: () => "" }),
  };
});
jest.mock("@/app/_hooks/use-inventory-action", () => ({
  useExecuteInventoryAction: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
}));

const item = (actions: string[]) =>
  ({ id: "object-123", name: "Arc grinder", actions }) as InventoryObject;

const host = (transfer: boolean): HostPresentation => ({
  brand: { id: "tidewell", name: "Tidewell", shortName: "Tidewell" },
  logo: { src: `/api/host/logo/${"a".repeat(64)}` },
  navigation: ["inventory"],
  home: { headline: "Headline", introduction: "Introduction" },
  journeys: {
    registration: true,
    myProducts: true,
    serviceProgress: false,
    quoteDecisions: false,
    transfer,
    tickets: false,
    loyalty: false,
  },
});

function offered(presentation: HostPresentation | null, actions: string[]) {
  const view = render(
    <HostProvider host={presentation}>
      <ObjectActions item={item(actions)} />
    </HostProvider>,
  );
  const group = screen.queryByRole("group", { name: "Available actions" });
  const names = group
    ? within(group)
        .getAllByRole("button")
        .map((button) => button.textContent)
    : [];
  view.unmount();
  return names;
}

describe("native transfer on a branded host", () => {
  it("offers no transfer control while the transfer journey is disabled", () => {
    expect(offered(host(false), ["transfer", "burn"])).toEqual(["Burn"]);
    // An object whose only action is transfer offers no action panel at all.
    expect(offered(host(false), ["transfer"])).toEqual([]);
  });

  it("offers no other custody move either (drop, pickup, claim_ownership) while transfer is disabled", () => {
    const custody = ["drop", "pickup", "claim_ownership"];
    expect(offered(host(false), [...custody, "burn"])).toEqual(["Burn"]);
    expect(offered(host(false), custody)).toEqual([]);
    // Enabled, and in the generic wallet, they are offered as before.
    expect(offered(host(true), custody)).toHaveLength(3);
    expect(offered(null, custody)).toHaveLength(3);
  });

  it("offers it when the host enables transfer", () => {
    expect(offered(host(true), ["transfer", "burn"])).toEqual([
      "Transfer",
      "Burn",
    ]);
  });

  it("offers it in the generic wallet, unchanged", () => {
    expect(offered(null, ["transfer", "burn"])).toEqual(["Transfer", "Burn"]);
  });

  it("does not run a face-requested transfer either", () => {
    render(
      <HostProvider host={host(false)}>
        <ObjectActions
          item={item(["transfer"])}
          requestedAction={{
            name: "transfer",
            input: { to: "0x1234567890abcdef1234567890abcdef12345678" },
          }}
        />
      </HostProvider>,
    );
    expect(screen.queryByRole("button", { name: /Transfer/ })).toBeNull();
  });
});
