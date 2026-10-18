import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductFaceHostNotice } from "@/app/_lib/external-face-bridge/core/product-session";
import { application, HOLDER } from "@/test/product-face-fixtures";

// Proposed contract r20 (PROPOSED, not deployed): the host's own notice for
// the outcomes the runtime listed durably for this wallet's earlier
// operations. One plain line per item in the host's words (never face text),
// the incomplete line when not every runtime scan ran to its end, and the
// Dismiss control that lets the hook acknowledge what the person has seen.
// The hook is stubbed so the notice can be shown without a live bridge.

jest.mock("next-intl", () => jest.requireActual("@/test/intl-mock").intlMock);
jest.mock("next/navigation", () => ({
  usePathname: () => "/products/morrow-home/service",
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
}));
jest.mock("@/app/_providers/session-provider", () => ({
  useSession: () => ({
    wallet: { id: "wallet-1", account: { address: HOLDER } },
    isAuthenticated: true,
    isLoading: false,
    onSessionEnd: () => () => undefined,
  }),
}));

const loadProductFaceContext = jest.fn();
jest.mock("@/app/_services/product-face.client", () => ({
  loadProductFaceContext: (...args: unknown[]) =>
    loadProductFaceContext(...args),
}));

let notice: ProductFaceHostNotice | null = null;
const dismissNotice = jest.fn();
const continueRecovery = jest.fn();
const checkRecoveryAgain = jest.fn();
jest.mock("@/app/_hooks/use-product-face-host", () => ({
  useProductFaceHost: () => ({
    state: { status: "live" },
    confirmation: null,
    answerConfirmation: jest.fn(),
    onFrameLoad: jest.fn(),
    notice,
    dismissNotice,
    continueRecovery,
    checkRecoveryAgain,
  }),
}));

import { ProductFaceHost } from "@/app/_components/products/product-face-host";

const frameUrl = `${application.origin}${application.path}`;

type RecoveryItem = Extract<
  ProductFaceHostNotice,
  { kind: "recovery" }
>["items"][number];

const item = (
  operationId: string,
  kind: RecoveryItem["kind"],
  outcome: RecoveryItem["outcome"],
  acknowledgeable = false,
): RecoveryItem => ({
  operationId,
  kind,
  operation:
    kind === "registration"
      ? "registration.submit"
      : kind === "settle"
        ? "registration.settle"
        : kind === "transfer"
          ? "transfer.transfer"
          : "case.open",
  step: kind === "transfer" ? "transfer" : null,
  outcome,
  holding: null,
  acknowledgeable,
});

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProductFaceHost slug="morrow-home" />
    </QueryClientProvider>,
  );
}

describe("the recovery notice (proposed contract r20)", () => {
  beforeEach(() => {
    loadProductFaceContext.mockReset();
    loadProductFaceContext.mockResolvedValue({ application, frameUrl });
    dismissNotice.mockReset();
    continueRecovery.mockReset();
    notice = null;
  });

  it("offers Continue checking while items remain, and says so, without calling it incomplete", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: true,
      withheld: 0,
      items: [item("case-3", "runtime", "outcome_unknown")],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText("There are more earlier requests to check.").tagName,
    ).toBe("P");
    expect(
      screen.queryByText(
        "Not every earlier request could be checked this time. Nothing was sent again.",
      ),
    ).toBeNull();
    const button = screen.getByRole("button", { name: "Continue checking" });
    expect(continueRecovery).not.toHaveBeenCalled();
    act(() => button.click());
    expect(continueRecovery).toHaveBeenCalledTimes(1);
    expect(dismissNotice).not.toHaveBeenCalled();
  });

  it("says when earlier requests were withheld as a feature this wallet does not offer", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 2,
      items: [],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        "Some earlier requests belong to a feature this wallet does not offer, so they are not shown here.",
      ).tagName,
    ).toBe("P");
    expect(
      screen.queryByRole("button", { name: "Continue checking" }),
    ).toBeNull();
  });

  it("offers no Continue checking when nothing remains", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: false,
      moreToCheck: false,
      withheld: 0,
      items: [item("case-3", "runtime", "outcome_unknown")],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.queryByRole("button", { name: "Continue checking" }),
    ).toBeNull();
    expect(
      screen.getByText(
        "Not every earlier request could be checked this time. Nothing was sent again.",
      ),
    ).toBeTruthy();
  });

  it("tells a recovered transfer offer and its cancellation as what they were, never as a service request", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        {
          ...item("offer-1", "runtime", "write_applied", true),
          operation: "transfer.offer",
        },
        {
          ...item("cancel-1", "runtime", "write_applied", true),
          operation: "transfer.cancel",
        },
      ],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        "Your offer to pass on a product, made earlier, was recorded. The product is still yours until the handover is done.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your cancellation of an offer to pass on a product, made earlier, was recorded. The product stays yours.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("A service request you sent earlier was received."),
    ).toBeNull();
  });

  it("tells a recovered transfer by who holds the product now: never still yours, not handed over or the recipient's once the product is back and registered", async () => {
    // The B->A return: the original owner's own earlier offer, request and
    // transfer step are proved from the historical record; the BFF's fresh
    // read says the product is registered to this wallet again.
    const offer = {
      ...item("offer-1", "runtime", "write_applied", true),
      operation: "transfer.offer",
      holding: "registered" as const,
    };
    const request = {
      ...item("xfer-1", "transfer", "transfer_request_committed", true),
      operation: "transfer.request",
      step: "request" as const,
      holding: "registered" as const,
    };
    const custody = {
      ...item("xfer-2", "transfer", "transferred", true),
      holding: "registered" as const,
    };
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        item("reg-1", "registration", "registered", true),
        offer,
        request,
        custody,
      ],
    };
    const { unmount } = renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    const status = () =>
      document.querySelector(".product-face-notice")?.textContent ?? "";
    expect(status()).toContain(
      "Your offer to pass on a product, made earlier, was recorded. The product is registered to you now.",
    );
    expect(status()).toContain(
      "Your transfer request, made earlier, was recorded. The product is registered to you now.",
    );
    expect(status()).toContain(
      "Your transfer, made earlier, is complete. The product has since come back to your wallet and is registered to you.",
    );
    expect(status()).toContain(
      "Your registration of this product is complete.",
    );
    expect(status()).not.toMatch(
      /still yours until|has not been done yet|now belongs to the recipient|no longer shown to you/,
    );

    // The former owner of a completed transfer: the product is elsewhere, so
    // the offer and the request are no longer pending and the transfer step
    // keeps its own line.
    notice = {
      ...notice,
      items: [
        { ...offer, holding: "elsewhere" },
        { ...request, holding: "elsewhere" },
        {
          ...item("cancel-1", "runtime", "write_applied", true),
          operation: "transfer.cancel",
          holding: "elsewhere",
        },
        { ...custody, holding: "elsewhere" },
      ],
    };
    unmount();
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(status()).toContain(
      "Your offer to pass on a product, made earlier, was recorded. The product is no longer in your wallet.",
    );
    expect(status()).toContain(
      "Your transfer request, made earlier, was recorded. The product is no longer in your wallet.",
    );
    expect(status()).toContain(
      "Your cancellation of an offer to pass on a product, made earlier, was recorded. The product is no longer in your wallet.",
    );
    expect(status()).toContain(
      "Your transfer is complete: the product now belongs to the recipient's wallet. Its private details and service requests are no longer shown to you.",
    );
    expect(status()).not.toMatch(
      /still yours|has not been done yet|stays yours/,
    );
  });

  it("keeps a recovered transfer's own line while the product is back but not registered for an offer or request (still uncertain), or when the holding was not read", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        {
          ...item("offer-1", "runtime", "write_applied", true),
          operation: "transfer.offer",
          holding: "held",
        },
        {
          ...item("xfer-1", "transfer", "transfer_request_committed", true),
          operation: "transfer.request",
          step: "request",
          holding: "held",
        },
        { ...item("xfer-2", "transfer", "transferred", true), holding: "held" },
        // Unread: the fresh read failed or found nothing.
        { ...item("xfer-3", "transfer", "transferred", true), holding: null },
        {
          ...item("cancel-1", "runtime", "write_applied", true),
          operation: "transfer.cancel",
          holding: "registered",
        },
      ],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    const lines = [
      "Your offer to pass on a product, made earlier, was recorded. The product is still yours until the handover is done.",
      "Your transfer request was recorded. The handover itself has not been done yet.",
      "Your transfer, made earlier, is complete. The product has since come back to your wallet.",
      "Your transfer is complete: the product now belongs to the recipient's wallet. Its private details and service requests are no longer shown to you.",
      "Your cancellation of an offer to pass on a product, made earlier, was recorded. The product stays yours.",
    ];
    for (const line of lines) {
      expect(screen.getByText(line).tagName).toBe("P");
    }
  });

  it("renders one plain line per listed outcome, in the host's own words", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [
        item("reg-1", "registration", "registered", true),
        item("settle-1", "settle", "registered", true),
        item("xfer-1", "transfer", "transfer_request_committed", true),
        item("xfer-2", "transfer", "transferred", true),
        item("case-1", "runtime", "write_applied", true),
        item("case-2", "runtime", "write_refused"),
        item("case-3", "runtime", "outcome_unknown"),
        item("xfer-3", "transfer", "not_checked"),
      ],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    const lines = [
      "Your registration of this product is complete.",
      "morrow-home's confirmation of this product is complete.",
      "Your transfer request was recorded. The handover itself has not been done yet.",
      "Your transfer is complete: the product now belongs to the recipient's wallet. Its private details and service requests are no longer shown to you.",
      "A service request you sent earlier was received.",
      "A request you sent earlier was not accepted. Nothing was changed.",
      "A request you sent earlier is still being confirmed. It will not be sent again.",
      "One earlier request could not be checked this time.",
    ];
    for (const line of lines) {
      expect(screen.getByText(line).tagName).toBe("P");
    }
    const status = screen.getByText(lines[0]).closest(".product-face-notice");
    expect(status?.querySelectorAll("p")).toHaveLength(lines.length);
    // Nothing of the item beyond its outcome is shown: no ids, no operation
    // names, nothing re-sent.
    expect(status?.textContent).not.toMatch(/reg-1|xfer-|case-|\.submit/);
    expect(
      screen.queryByText(/Not every earlier request could be checked/),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restart the application" }),
    ).toBeNull();
  });

  it("says when not every earlier request could be checked, and that nothing was sent again", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: false,
      moreToCheck: false,
      withheld: 0,
      items: [item("xfer-2", "transfer", "transferred")],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        "Your transfer is complete: the product now belongs to the recipient's wallet. Its private details and service requests are no longer shown to you.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Not every earlier request could be checked this time. Nothing was sent again.",
      ).tagName,
    ).toBe("P");
  });

  it("names each runtime it asked and why one could not be checked, counts the records it could not read, and offers Check again", async () => {
    notice = {
      kind: "recovery",
      complete: false,
      moreToCheck: false,
      withheld: 0,
      checks: [
        { runtime: "product", status: "checked", reason: null, unreadable: 0 },
        {
          runtime: "service",
          status: "incomplete",
          reason: "item_unreadable",
          unreadable: 2,
        },
      ],
      unreadable: 2,
      items: [item("case-0123456789abcdef", "runtime", "outcome_unknown")],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(/Your product records with .+ were checked\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Not all of your service records with .+ could be checked this time\. Some of its records are in a form this wallet cannot read\./,
      ),
    ).toBeTruthy();
    // The test's intl mock does not format ICU plurals; the catalog does.
    expect(
      screen.getByText(/could not be read by this wallet and .*not checked/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Not every earlier request could be checked this time/),
    ).toBeTruthy();
    const again = screen.getByRole("button", { name: "Check again" });
    expect(
      screen.queryByRole("button", { name: "Continue checking" }),
    ).toBeNull();
    act(() => again.click());
    expect(checkRecoveryAgain).toHaveBeenCalledTimes(1);
  });

  it("says a runtime did not answer, and offers no Check again while items remain to continue", async () => {
    notice = {
      kind: "recovery",
      complete: false,
      moreToCheck: true,
      withheld: 0,
      checks: [
        {
          runtime: "product",
          status: "unavailable",
          reason: "unreachable",
          unreadable: 0,
        },
        { runtime: "service", status: "checked", reason: null, unreadable: 0 },
      ],
      unreadable: 0,
      items: [],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        /Your product records with .+ could not be checked this time\. The application did not answer\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue checking" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("reports an incomplete check even when nothing was listed", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: false,
      moreToCheck: false,
      withheld: 0,
      items: [],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        "Not every earlier request could be checked this time. Nothing was sent again.",
      ),
    ).toBeTruthy();
  });

  it("Dismiss hands the notice back to the hook, which decides what to acknowledge", async () => {
    notice = {
      kind: "recovery",
      checks: [],
      unreadable: 0,
      complete: true,
      moreToCheck: false,
      withheld: 0,
      items: [item("xfer-2", "transfer", "transferred", true)],
    };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.click());
    expect(dismissNotice).toHaveBeenCalledTimes(1);
  });

  it("keeps the other notices as they are", async () => {
    notice = { kind: "transfer_step", reason: "transferred" };
    renderHost();
    await screen.findByTitle("Morrow Home Arc product application");
    expect(
      screen.getByText(
        /Its private details and service requests are no longer/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
