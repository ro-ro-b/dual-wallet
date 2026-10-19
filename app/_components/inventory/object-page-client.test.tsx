import { render, screen } from "@testing-library/react";
import { ObjectPageClient } from "@/app/_components/inventory/object-page-client";
import type { HostPresentation } from "@/app/_domain/wallet-host";
import { HostProvider } from "@/app/_providers/host-provider";

// The object page's Share control copies a public object link. The engine
// serves no public object route (the viewer does, on its own domain), so a
// branded host offers no such link under its own domain.
jest.mock("next-intl", () => {
  const { translations } = jest.requireActual("@/test/intl-mock");
  return {
    useTranslations: (namespace: string) =>
      Object.assign(translations(namespace), { raw: () => "" }),
  };
});
jest.mock("@/app/_hooks/data", () => ({
  useInventoryObject: () => ({
    isError: false,
    data: { id: "object-123", name: "Arc grinder", actions: [] },
  }),
}));
jest.mock("@/app/_hooks/use-error-message", () => ({
  useErrorMessage: () => () => "",
}));
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({ isAuthenticated: true }),
}));
jest.mock("@/app/_components/inventory/object-detail", () => ({
  ObjectDetail: ({ action }: { action?: React.ReactNode }) => (
    <div data-testid="object-detail">{action}</div>
  ),
  useObjectActionSlot: () => ({}),
}));
jest.mock("@/app/_components/inventory/share-object-button", () => ({
  ShareObjectButton: () => <button type="button">Share</button>,
}));

const host: HostPresentation = {
  brand: { id: "tidewell", name: "Tidewell", shortName: "Tidewell" },
  logo: { src: `/api/host/logo/${"a".repeat(64)}` },
  navigation: ["inventory"],
  home: { headline: "Headline", introduction: "Introduction" },
  journeys: {
    registration: true,
    myProducts: true,
    serviceProgress: true,
    quoteDecisions: true,
    transfer: true,
    tickets: false,
    loyalty: false,
  },
};

describe("the object page's Share control", () => {
  it("is offered on the generic wallet", () => {
    render(
      <HostProvider host={null}>
        <ObjectPageClient objectId="object-123" />
      </HostProvider>,
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("is not offered on a branded host", () => {
    render(
      <HostProvider host={host}>
        <ObjectPageClient objectId="object-123" />
      </HostProvider>,
    );
    expect(screen.getByTestId("object-detail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
