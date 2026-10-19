/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hostNoticeHtml } from "@/api/host-notice";
import { HostNoticeDocument } from "@/app/_components/host/host-notice";
import {
  productFaceBinding,
  productFaceEntries,
} from "@/api/product-face-registry";
import {
  hostFaceEnabled,
  hostHome,
  hostJourneyEnabled,
  hostLanding,
  hostLogo,
  hostMetadata,
  hostPageAllowed,
  hostPresentation,
  hostStyle,
  resetWalletHostCache,
  walletHost,
} from "@/api/wallet-host";
import { GET as readbackGET } from "@/app/api/host/configuration/route";
import { GET as logoGET } from "@/app/api/host/logo/[sha256]/route";
import { GET as displayGET } from "@/app/api/public/objects/[objectId]/display/[variant]/route";
import packageJson from "@/package.json";
import { hostFontFamilies } from "@/app/_domain/wallet-host";
import { edit } from "@/test/product-face-fixtures";
import {
  applyHostEnvironment,
  clearHostEnvironment,
  MORROW_ORGANIZATION,
  registryWithBothFaces,
  sealHost,
  hostEnvironment,
  MORROW_LOGO_BASE64,
  MORROW_ORIGIN,
  morrowDocument,
  TIDEWELL_LOGO_BASE64,
  tidewellDocument,
} from "@/test/wallet-host-fixtures";

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const MORROW_LOGO = Buffer.from(MORROW_LOGO_BASE64, "base64");
const TIDEWELL_LOGO = Buffer.from(TIDEWELL_LOGO_BASE64, "base64");

let consoleError: jest.SpyInstance;
beforeEach(() => {
  resetWalletHostCache();
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  clearHostEnvironment();
  consoleError.mockRestore();
});

const logo = (hash: string) =>
  logoGET(new Request(`https://wallet.example/api/host/logo/${hash}`), {
    params: Promise.resolve({ sha256: hash }),
  });

describe("without a host configuration (the generic wallet)", () => {
  it("is absent and changes nothing", async () => {
    applyHostEnvironment({ NEXT_PUBLIC_APP_URL: "http://demo.localhost:3000" });
    expect(walletHost()).toEqual({ status: "absent" });
    expect(hostPresentation()).toBeNull();
    expect(hostStyle()).toBeUndefined();
    expect(hostMetadata()).toBeUndefined();
    expect((await logo(sha256(MORROW_LOGO))).status).toBe(404);
  });
});

describe("two brand hosts from one build", () => {
  it("present different names, logos, navigation and home copy", () => {
    applyHostEnvironment(hostEnvironment(morrowDocument()));
    const morrow = hostPresentation();
    resetWalletHostCache();
    applyHostEnvironment(hostEnvironment(tidewellDocument()));
    const tidewell = hostPresentation();

    expect(morrow).toEqual({
      brand: { id: "morrow-home", name: "Morrow Home", shortName: "Morrow" },
      logo: { src: `/api/host/logo/${sha256(MORROW_LOGO)}` },
      navigation: ["inventory", "products", "activity", "settings"],
      home: {
        headline: "Your Morrow Home tools, registered and cared for.",
        introduction:
          "Register a new tool, follow a service and pass it on when you sell it.",
      },
      journeys: {
        registration: true,
        myProducts: true,
        serviceProgress: true,
        quoteDecisions: true,
        transfer: true,
        tickets: false,
        loyalty: false,
      },
    });
    expect(tidewell).toEqual({
      brand: { id: "tidewell", name: "Tidewell", shortName: "Tidewell" },
      logo: { src: `/api/host/logo/${sha256(TIDEWELL_LOGO)}` },
      navigation: ["products", "settings"],
      home: {
        headline: "Every Tidewell kettle you own, in one place.",
        introduction: "See your registered kettles and register a new one.",
      },
      journeys: {
        registration: true,
        myProducts: true,
        serviceProgress: false,
        quoteDecisions: false,
        transfer: false,
        tickets: false,
        loyalty: false,
      },
    });
  });

  it("render different tokens and families, and nothing else", () => {
    applyHostEnvironment(hostEnvironment(morrowDocument()));
    const morrow = hostStyle()!;
    resetWalletHostCache();
    applyHostEnvironment(hostEnvironment(tidewellDocument()));
    const tidewell = hostStyle()!;

    expect(morrow).toContain("--brand:#2f7d5b;");
    expect(morrow).toContain("--action-primary:#1d5c41;");
    expect(morrow).toContain(`font-family:${hostFontFamilies.satoshi}`);
    expect(tidewell).toContain("--brand:#3b5bdb;");
    expect(tidewell).toContain("--surface:#fffdf8;");
    expect(tidewell).toContain(
      `font-family:${hostFontFamilies["system-serif"]}`,
    );
    for (const style of [morrow, tidewell]) {
      // Tokens and one family only: no url(), import, markup or extra rule.
      expect(style).not.toMatch(/url\(|@import|<|expression/i);
      expect(style.match(/\{/g)).toHaveLength(2);
    }
  });

  it("name the document after the brand, with the pinned logo as its icon", () => {
    applyHostEnvironment(hostEnvironment(tidewellDocument()));
    const src = `/api/host/logo/${sha256(TIDEWELL_LOGO)}`;
    expect(hostMetadata()).toEqual({
      metadataBase: new URL("https://wallet.tidewell.example"),
      title: { default: "Tidewell", template: "%s · Tidewell" },
      description: "Your Tidewell kettles and their registrations.",
      applicationName: "Tidewell",
      appleWebApp: { title: "Tidewell" },
      icons: {
        icon: [{ url: src, type: "image/webp" }],
        shortcut: [src],
        apple: [src],
      },
      openGraph: {
        title: "Tidewell",
        description: "Your Tidewell kettles and their registrations.",
        siteName: "Tidewell",
        images: [{ url: src }],
      },
      twitter: { card: "summary", images: [src] },
      robots: { index: false, follow: false },
    });
  });

  it("serve exactly each host's pinned logo bytes, immutable by hash", async () => {
    for (const [document, bytes, type] of [
      [morrowDocument(), MORROW_LOGO, "image/png"],
      [tidewellDocument(), TIDEWELL_LOGO, "image/webp"],
    ] as const) {
      resetWalletHostCache();
      applyHostEnvironment(hostEnvironment(document));
      const response = await logo(sha256(bytes));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(response.headers.get("etag")).toBe(`"${sha256(bytes)}"`);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    // Another host's logo hash, or any other value, is not this host's.
    expect((await logo(sha256(MORROW_LOGO))).status).toBe(404);
    expect((await logo("../favicon.svg")).status).toBe(404);
    expect(hostLogo(sha256(MORROW_LOGO))).toBeUndefined();
  });

  it("serve no logo and no identity while the configuration is invalid", async () => {
    applyHostEnvironment({
      ...hostEnvironment(morrowDocument()),
      WALLET_HOST_CONFIGURATION_SHA256: "0".repeat(64),
    });
    expect(walletHost()).toMatchObject({
      status: "invalid",
      problem: "pin_mismatch",
    });
    const response = await logo(sha256(MORROW_LOGO));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(hostPresentation()).toBeNull();
    expect(hostStyle()).toBeUndefined();
    expect(hostMetadata()).toBeUndefined();
    // The operator log names the problem, never the configuration.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain("pin_mismatch");
    expect(String(consoleError.mock.calls[0][0])).not.toContain("Morrow");
  });

  it("keeps the entrance origin as the metadata base", () => {
    applyHostEnvironment(hostEnvironment(morrowDocument()));
    expect(hostMetadata()?.metadataBase).toEqual(new URL(MORROW_ORIGIN));
  });
});

const UNIT = "aaaaaaaaaaaaaaaaaaaaaaaa";

describe("journeys, pages and faces", () => {
  it("the generic wallet serves every journey, page and face", () => {
    applyHostEnvironment({
      PRODUCT_FACE_APPLICATIONS: registryWithBothFaces(),
    });
    for (const journey of [
      "registration",
      "myProducts",
      "serviceProgress",
      "quoteDecisions",
      "transfer",
    ] as const) {
      expect(hostJourneyEnabled(journey)).toBe(true);
    }
    expect(hostFaceEnabled("tidewell-care")).toBe(true);
    for (const path of [
      "/products",
      "/products/tidewell-care/register",
      "/products/morrow-home/claims",
      `/products/morrow-home/products/${UNIT}/transfer`,
    ]) {
      expect(hostPageAllowed(path)).toBe(true);
    }
    expect(hostLanding()).toBe("/inventory");
    expect(hostHome()).toBeUndefined();
    expect(productFaceEntries().map((entry) => entry.slug)).toEqual([
      "morrow-home",
      "tidewell-care",
    ]);
  });

  it("a branded host serves only its faces and enabled journeys' pages", () => {
    applyHostEnvironment(hostEnvironment(tidewellDocument()));
    expect(hostJourneyEnabled("registration")).toBe(true);
    expect(hostJourneyEnabled("transfer")).toBe(false);
    expect(hostFaceEnabled("tidewell-care")).toBe(true);
    expect(hostFaceEnabled("morrow-home")).toBe(false);
    // The registry holds only this host's face.
    expect(productFaceEntries().map((entry) => entry.slug)).toEqual([
      "tidewell-care",
    ]);
    expect(productFaceBinding("morrow-home")).toBeUndefined();

    const allowed = [
      "/inventory",
      "/settings",
      "/products",
      "/products/tidewell-care",
      "/products/tidewell-care/",
      "/products/tidewell-care/register",
      "/products/tidewell-care/register/result/op-1",
      "/products/tidewell-care/products",
      `/products/tidewell-care/products/${UNIT}/care`,
      "/products/tidewell-care/support",
      "/products/tidewell-care/ended",
      "/products/tidewell-care/handover",
    ];
    const refused = [
      // another face, even one in the same registry
      "/products/morrow-home",
      "/products/morrow-home/register",
      "/products/morrow-home/handover",
      // disabled journeys
      "/products/tidewell-care/service",
      "/products/tidewell-care/service/case-1",
      "/products/tidewell-care/accept",
      `/products/tidewell-care/products/${UNIT}/transfer`,
      // not a contract route
      "/products/tidewell-care/claims",
    ];
    for (const path of allowed)
      expect([path, hostPageAllowed(path)]).toEqual([path, true]);
    for (const path of refused)
      expect([path, hostPageAllowed(path)]).toEqual([path, false]);
  });

  it("a host without My products refuses the programme list", () => {
    const document = tidewellDocument();
    edit(document, "journeys.myProducts", false);
    edit(document, "navigation", ["settings"]);
    edit(document, "home.primaryJourney", "registration");
    applyHostEnvironment(hostEnvironment(document));
    expect(hostPageAllowed("/products")).toBe(false);
    expect(hostPageAllowed("/products/tidewell-care/products")).toBe(false);
    expect(hostPageAllowed("/products/tidewell-care/register")).toBe(true);
  });

  it("the handover entry needs registration or transfer", () => {
    const document = tidewellDocument();
    edit(document, "journeys.registration", false);
    applyHostEnvironment(hostEnvironment(document));
    expect(hostPageAllowed("/products/tidewell-care/handover")).toBe(false);
    expect(hostPageAllowed("/products/tidewell-care/register")).toBe(false);
  });

  it("an invalid configuration serves no journey and no face", () => {
    applyHostEnvironment({
      ...hostEnvironment(morrowDocument()),
      WALLET_HOST_CONFIGURATION_SHA256: "1".repeat(64),
    });
    expect(hostJourneyEnabled("registration")).toBe(false);
    expect(hostFaceEnabled("morrow-home")).toBe(false);
    expect(productFaceEntries()).toEqual([]);
    expect(hostHome()).toBeUndefined();
  });

  it("each host's home links its own journeys and navigation", () => {
    applyHostEnvironment(hostEnvironment(morrowDocument()));
    expect(hostLanding()).toBe("/");
    expect(hostHome()).toEqual({
      brand: {
        brand: { id: "morrow-home", name: "Morrow Home", shortName: "Morrow" },
        logo: { src: `/api/host/logo/${sha256(MORROW_LOGO)}` },
      },
      headline: "Your Morrow Home tools, registered and cared for.",
      introduction:
        "Register a new tool, follow a service and pass it on when you sell it.",
      primary: {
        journey: "registration",
        href: "/products/morrow-home/register",
      },
      journeys: [
        { journey: "myProducts", href: "/products/morrow-home/products" },
        { journey: "serviceProgress", href: "/products/morrow-home/service" },
        { journey: "quoteDecisions", href: "/products/morrow-home/service" },
        { journey: "transfer", href: "/products/morrow-home" },
      ],
      navigation: [
        { entry: "inventory", href: "/inventory" },
        { entry: "products", href: "/products" },
        { entry: "activity", href: "/activity" },
        { entry: "settings", href: "/settings" },
      ],
      // No Tickets journey: no Today section on this home.
      tickets: null,
      loyalty: null,
    });
    resetWalletHostCache();
    applyHostEnvironment(hostEnvironment(tidewellDocument()));
    expect(hostHome()).toMatchObject({
      headline: "Every Tidewell kettle you own, in one place.",
      primary: {
        journey: "myProducts",
        href: "/products/tidewell-care/products",
      },
      journeys: [
        { journey: "registration", href: "/products/tidewell-care/register" },
      ],
      navigation: [
        { entry: "products", href: "/products" },
        { entry: "settings", href: "/settings" },
      ],
    });
  });
});

describe("GET /api/host/configuration", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const BUILT = "3d23daf2c04c6e9ace6ab00f4fc3f5d7aab94a6f";
  const readback = async () => {
    const response = readbackGET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  };

  it("reads back an active host exactly, with the engine identity", async () => {
    applyHostEnvironment(
      hostEnvironment(morrowDocument(), { VERCEL_GIT_COMMIT_SHA: COMMIT }),
    );
    expect(await readback()).toEqual({
      schema: "dual-wallet-host-configuration-v1",
      brandId: "morrow-home",
      organizationId: MORROW_ORGANIZATION,
      origin: MORROW_ORIGIN,
      configurationSha256: sealHost(morrowDocument()).pin,
      configVersion: "1.0.0",
      engine: { version: packageJson.version, commit: COMMIT },
      journeys: {
        registration: true,
        myProducts: true,
        serviceProgress: true,
        quoteDecisions: true,
        transfer: true,
      },
      faces: ["morrow-home"],
      status: "active",
    });
  });

  it("reads back each brand host built from the same engine", async () => {
    applyHostEnvironment(
      hostEnvironment(tidewellDocument(), { VERCEL_GIT_COMMIT_SHA: COMMIT }),
    );
    const tidewell = await readback();
    expect(tidewell).toMatchObject({
      brandId: "tidewell",
      organizationId: "b2b2b2b2b2b2b2b2b2b2b2b2",
      origin: "https://wallet.tidewell.example",
      configurationSha256: sealHost(tidewellDocument()).pin,
      configVersion: "2.1.0",
      engine: { version: packageJson.version, commit: COMMIT },
      faces: ["tidewell-care"],
      status: "active",
    });
  });

  it("reads back the commit its build recorded when the platform supplies none at runtime", async () => {
    // A CLI or prebuilt deployment of a project not linked to the repository.
    applyHostEnvironment(
      hostEnvironment(tidewellDocument(), {
        WALLET_ENGINE_BUILD_COMMIT: BUILT,
      }),
    );
    expect((await readback()).engine).toEqual({
      version: packageJson.version,
      commit: BUILT,
    });
  });

  it("prefers the built commit to the runtime platform value, and falls back to it", async () => {
    applyHostEnvironment(
      hostEnvironment(tidewellDocument(), {
        WALLET_ENGINE_BUILD_COMMIT: BUILT,
        VERCEL_GIT_COMMIT_SHA: COMMIT,
      }),
    );
    expect((await readback()).engine.commit).toBe(BUILT);
    applyHostEnvironment(
      hostEnvironment(tidewellDocument(), {
        WALLET_ENGINE_BUILD_COMMIT: "",
        VERCEL_GIT_COMMIT_SHA: COMMIT,
      }),
    );
    expect((await readback()).engine.commit).toBe(COMMIT);
    applyHostEnvironment(
      hostEnvironment(tidewellDocument(), {
        WALLET_ENGINE_BUILD_COMMIT: "3d23daf",
        VERCEL_GIT_COMMIT_SHA: "not-a-commit",
      }),
    );
    expect((await readback()).engine.commit).toBeNull();
  });

  it("reads back an invalid configuration by status and hash only", async () => {
    const environment = hostEnvironment(morrowDocument(), {
      VERCEL_GIT_COMMIT_SHA: "not-a-commit",
    });
    applyHostEnvironment({
      ...environment,
      WALLET_HOST_CONFIGURATION_SHA256: "2".repeat(64),
    });
    expect(await readback()).toEqual({
      schema: "dual-wallet-host-configuration-v1",
      brandId: null,
      organizationId: null,
      origin: null,
      configurationSha256: sealHost(morrowDocument()).pin,
      configVersion: null,
      engine: { version: packageJson.version, commit: null },
      journeys: null,
      faces: null,
      status: "invalid",
    });
  });

  it("reads back the generic wallet as absent", async () => {
    applyHostEnvironment({});
    expect(await readback()).toEqual({
      schema: "dual-wallet-host-configuration-v1",
      brandId: null,
      organizationId: null,
      origin: null,
      configurationSha256: null,
      configVersion: null,
      engine: { version: packageJson.version, commit: null },
      journeys: null,
      faces: null,
      status: "absent",
    });
  });

  it("never reads back a secret, a logo or a colour", async () => {
    applyHostEnvironment({
      ...hostEnvironment(morrowDocument(), { VERCEL_GIT_COMMIT_SHA: COMMIT }),
    });
    // jest.setup.js provides an ephemeral session key.
    expect(process.env.SESSION_SECRET).toBeTruthy();
    const body = JSON.stringify(await readback());
    expect(body).not.toContain(process.env.SESSION_SECRET!);
    expect(body).not.toContain(MORROW_LOGO_BASE64);
    expect(body).not.toContain("#2f7d5b");
  });
});

describe("the public display proxy", () => {
  const display = () =>
    displayGET(
      new Request("https://wallet.example/api/public/objects/x/display/card"),
      {
        params: Promise.resolve({ objectId: UNIT, variant: "card" }),
      },
    );

  it("refuses while the configuration is invalid", async () => {
    applyHostEnvironment({
      ...hostEnvironment(morrowDocument()),
      WALLET_HOST_CONFIGURATION_SHA256: "3".repeat(64),
    });
    const response = await display();
    expect(response.status).toBe(503);
  });

  it("is unchanged for the generic wallet", async () => {
    const original = global.fetch;
    global.fetch = jest.fn(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    try {
      expect((await display()).status).toBe(404);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = original;
    }
  });
});

describe("the neutral notices", () => {
  it("name neither a brand nor the generic wallet, in the proxy or the layout", () => {
    for (const html of [
      hostNoticeHtml("setup"),
      renderToStaticMarkup(
        createElement(HostNoticeDocument, { kind: "setup" }),
      ),
    ]) {
      expect(html).toContain("This wallet is being set up");
      expect(html).toContain("data-wallet-host-notice");
      expect(html).not.toMatch(/Dual|Morrow|Tidewell|favicon|<script|<link/);
    }
    expect(hostNoticeHtml("misdirected")).toContain(
      "This wallet is not available at this address",
    );
  });
});
