/**
 * @jest-environment node
 */
// The product layout and task page: a native-only face's entrance, help and
// end routes are wallet pages with no frame; every face of the generic
// wallet, and of a host with a framed journey, keeps its frame and its empty
// task page exactly as before.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resetWalletHostCache } from "@/api/wallet-host";
import ProductFaceLayout from "@/app/(authorized)/products/[slug]/layout";
import ProductTaskPage from "@/app/(authorized)/products/[slug]/[[...task]]/page";
import { bindingInput, edit } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  hostEnvironment,
  morrowBinding,
  morrowDocument,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

jest.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    jest.requireActual("@/test/intl-mock").translations(namespace),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as string}</a>
  ),
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
jest.mock("@/app/_components/products/product-face-slot", () => ({
  ProductFaceSlot: ({ slug }: { slug: string }) => (
    <div data-face-frame={slug} />
  ),
}));

const TICKETS = {
  fields: {
    event: "event.title",
    issueOperation: "issue.operation_id",
    state: "ticket.state",
  },
  states: { pending: [], issued: ["Issued"], ended: ["Cancelled"] },
};
const LOYALTY = {
  contract: "loyalty-join-earn-v1",
  modelId: "harbour-makers",
  programmeId: "HARBOUR-MAKERS",
  canonicalTemplateId: "6c0000000000000000000001",
  passTemplateId: "6c0000000000000000000002",
  canonicalIssuerAccount: "0x00000000000000000000000000000000000000e1",
};
const face = (slug: string, extra: Record<string, unknown>) =>
  bindingInput({
    slug,
    applicationId: `tig.fictional.${slug}`,
    programmeName: `${slug} (fictional)`,
    path: `/face/tig.fictional.${slug}/1.0.0/${"a".repeat(64)}/`,
    ...extra,
  });
const REGISTRY = JSON.stringify([
  { ...morrowBinding(), tickets: TICKETS },
  face("harbour-nights", { tickets: TICKETS }),
  face("harbour-both", { tickets: TICKETS, loyalty: LOYALTY }),
]);

function serve(document?: HostDocument) {
  resetWalletHostCache();
  if (!document) {
    clearHostEnvironment();
    process.env.PRODUCT_FACE_APPLICATIONS = REGISTRY;
    return;
  }
  applyHostEnvironment(
    hostEnvironment(document, { PRODUCT_FACE_APPLICATIONS: REGISTRY }),
  );
}

function nativeHost() {
  const document = morrowDocument();
  edit(document, "journeys", {
    registration: false,
    myProducts: false,
    serviceProgress: false,
    quoteDecisions: false,
    transfer: false,
    tickets: true,
    loyalty: true,
  });
  edit(document, "home.primaryJourney", "tickets");
  edit(document, "navigation", ["inventory", "settings"]);
  edit(document, "faces", ["harbour-nights", "harbour-both"]);
  return document;
}

async function page(slug: string, task?: string[]) {
  try {
    const element = (await ProductTaskPage({
      params: Promise.resolve({ slug, task }),
    })) as ReactElement<Record<string, unknown>> | null;
    if (!element) return null;
    // The page returns one async server component: resolve it first.
    const render = element.type as (
      props: Record<string, unknown>,
    ) => Promise<ReactElement>;
    return renderToStaticMarkup(await render(element.props));
  } catch (error) {
    return (error as Error).message;
  }
}

async function layout(slug: string) {
  const element = await ProductFaceLayout({
    params: Promise.resolve({ slug }),
    children: <main />,
  });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  clearHostEnvironment();
  delete process.env.PRODUCT_FACE_APPLICATIONS;
  resetWalletHostCache();
});

describe("a native-only face", () => {
  beforeEach(() => serve(nativeHost()));

  it("has no frame on any of its pages", async () => {
    expect(await layout("harbour-nights")).toBe("<main></main>");
    expect(await layout("harbour-both")).toBe("<main></main>");
  });

  it("enters its one native journey, and sends a deeper path back to the entrance", async () => {
    expect(await page("harbour-nights")).toBe(
      "REDIRECT /products/harbour-nights/tickets",
    );
    expect(await page("harbour-nights", ["home"])).toBe(
      "REDIRECT /products/harbour-nights/tickets",
    );
    expect(await page("harbour-nights", ["support", "more"])).toBe(
      "REDIRECT /products/harbour-nights",
    );
    // A disabled journey's task is still not found.
    expect(await page("harbour-nights", ["register"])).toBe("NOT_FOUND");
  });

  it("serving both journeys, its entrance is a choice of them", async () => {
    const html = await page("harbour-both");
    expect(html).toContain("<h1>harbour-both (fictional)</h1>");
    expect(html).toContain("Choose where to go.");
    expect(html).toContain(
      '<a href="/products/harbour-both/tickets">Open your tickets</a>',
    );
    expect(html).toContain(
      '<a href="/products/harbour-both/loyalty">Open your membership</a>',
    );
    expect(html).toContain('<a href="/">Back to Morrow Home home</a>');
  });

  it("help and the end state are native pages naming where things are kept", async () => {
    const help = await page("harbour-nights", ["support"]);
    expect(help).toContain("<h1>Help</h1>");
    expect(help).toContain(
      "Register, look after and pass on your Morrow Home tools.",
    );
    expect(help).toContain(
      "Your harbour-nights (fictional) tickets are kept in this wallet, not on this page.",
    );
    expect(help).toContain(
      '<a href="/products/harbour-nights/tickets">Open your tickets</a>',
    );
    expect(help).not.toContain("/loyalty");
    const ended = await page("harbour-nights", ["ended"]);
    expect(ended).toContain("<h1>This page has closed</h1>");
    expect(ended).toContain(
      "Nothing from harbour-nights (fictional) is open on this page.",
    );
    expect(ended).toContain('<a href="/">Back to Morrow Home home</a>');
  });
});

describe("every other face keeps its frame and its empty task page", () => {
  it.each([
    ["the generic wallet", undefined],
    ["a P3 host", morrowDocument()],
    [
      "a P3 host with Tickets on",
      (() => {
        const document = morrowDocument();
        edit(document, "journeys.tickets", true);
        return document;
      })(),
    ],
  ])("%s", async (_name, document) => {
    serve(document);
    expect(await layout("morrow-home")).toBe(
      '<div data-face-frame="morrow-home"></div><main></main>',
    );
    for (const task of [undefined, ["home"], ["support"], ["ended"]]) {
      expect(await page("morrow-home", task)).toBeNull();
    }
  });
});
