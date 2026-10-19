import "server-only";

import type { Metadata } from "next";
import packageJson from "@/package.json";
import {
  bindingBacksJourney,
  evaluateHostConfiguration,
  type HostConfigurationInput,
  type HostConfigurationState,
  type WalletHostConfiguration,
} from "@/api/host-configuration";
import { isHandoverEntryPath } from "@/app/_domain/navigation";
import { taskPathFromPathname } from "@/app/_domain/product-face";
import {
  HOST_CONFIGURATION_SCHEMA,
  hostJourneys,
  hostJourneyTasks,
  hostNavigationHrefs,
  hostTokenCss,
  journeysOfTask,
  type HostHomeView,
  type HostJourney,
  type HostJourneys,
  type HostPresentation,
} from "@/app/_domain/wallet-host";

/**
 * The branded wallet host this deployment serves, from its environment only:
 * WALLET_HOST_CONFIGURATION and its pin WALLET_HOST_CONFIGURATION_SHA256,
 * checked against NEXT_PUBLIC_APP_URL, PRODUCT_FACE_APPLICATIONS and the
 * configuration the build rendered (WALLET_HOST_BUILD_CONFIGURATION_SHA256,
 * recorded by next.config.ts). Absent: the generic wallet, unchanged.
 * Invalid: every page and BFF route fails closed (see proxy.ts).
 */
let cached:
  { input: HostConfigurationInput; state: HostConfigurationState } | undefined;
let reported: string | undefined;

function currentInput(): HostConfigurationInput {
  return {
    raw: process.env.WALLET_HOST_CONFIGURATION,
    pin: process.env.WALLET_HOST_CONFIGURATION_SHA256,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    faceApplications: process.env.PRODUCT_FACE_APPLICATIONS,
    production: process.env.NODE_ENV === "production",
    buildSha256: process.env.WALLET_HOST_BUILD_CONFIGURATION_SHA256,
    buildFaceApplicationsSha256:
      process.env.WALLET_HOST_BUILD_FACE_APPLICATIONS_SHA256,
  };
}

function sameInput(a: HostConfigurationInput, b: HostConfigurationInput) {
  return (
    a.raw === b.raw &&
    a.pin === b.pin &&
    a.appUrl === b.appUrl &&
    a.faceApplications === b.faceApplications &&
    a.production === b.production &&
    a.buildSha256 === b.buildSha256 &&
    a.buildFaceApplicationsSha256 === b.buildFaceApplicationsSha256
  );
}

export function walletHost(): HostConfigurationState {
  const input = currentInput();
  if (cached && sameInput(cached.input, input)) return cached.state;
  const state = evaluateHostConfiguration(input);
  cached = { input, state };
  if (state.status === "invalid") {
    // The operator log names the problem, never the configuration's content.
    const problem = `${state.problem}:${state.configurationSha256 ?? ""}`;
    if (problem !== reported) {
      reported = problem;
      console.error(
        `WALLET_HOST_CONFIGURATION is not usable (${state.problem}); this wallet answers 503 until it is fixed.`,
      );
    }
  }
  return state;
}

/** The active configuration, or undefined (absent or invalid). */
export function activeHostConfiguration(): WalletHostConfiguration | undefined {
  const host = walletHost();
  return host.status === "active" ? host.configuration : undefined;
}

export const HOST_LOGO_ROUTE = "/api/host/logo";

/** The content-addressed logo URL: a new logo is a new URL. */
export function hostLogoSrc(configuration: WalletHostConfiguration) {
  return `${HOST_LOGO_ROUTE}/${configuration.identity.logo.sha256}`;
}

/** The pinned logo, only for its own sha256. */
export function hostLogo(sha256: string) {
  const host = walletHost();
  if (host.status !== "active") return undefined;
  const { logo } = host.configuration.identity;
  if (sha256 !== logo.sha256) return undefined;
  return { bytes: host.logo, mediaType: logo.mediaType, sha256: logo.sha256 };
}

/** What the browser shell may know: presentation only, no secret exists. */
export function hostPresentation(): HostPresentation | null {
  const configuration = activeHostConfiguration();
  if (!configuration) return null;
  const { brand, home, navigation, journeys } = configuration;
  return {
    brand: { id: brand.id, name: brand.name, shortName: brand.shortName },
    logo: { src: hostLogoSrc(configuration) },
    navigation: [...navigation],
    home: { headline: home.headline, introduction: home.introduction },
    journeys: { ...journeys },
  };
}

/** The host stylesheet: validated tokens and the bundled family only. */
export function hostStyle() {
  const configuration = activeHostConfiguration();
  if (!configuration) return undefined;
  const { colours, typography } = configuration.identity;
  return hostTokenCss(colours, typography.family);
}

/** The document metadata of the active host: name, description, icons. */
export function hostMetadata(): Metadata | undefined {
  const configuration = activeHostConfiguration();
  if (!configuration) return undefined;
  const { brand, entrance, identity } = configuration;
  const logo = hostLogoSrc(configuration);
  return {
    metadataBase: new URL(entrance.origin),
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: brand.description,
    applicationName: brand.shortName,
    appleWebApp: { title: brand.shortName },
    icons: {
      icon: [{ url: logo, type: identity.logo.mediaType }],
      shortcut: [logo],
      apple: [logo],
    },
    openGraph: {
      title: brand.name,
      description: brand.description,
      siteName: brand.name,
      images: [{ url: logo }],
    },
    twitter: { card: "summary", images: [logo] },
    robots: { index: false, follow: false },
  };
}

// ------------------------------------------------------------ journeys

/**
 * Whether this deployment serves a journey: always for the generic wallet,
 * never while the configuration is invalid, and as configured otherwise.
 */
export function hostJourneyEnabled(journey: HostJourney) {
  const host = walletHost();
  // Tickets and Loyalty are opt-in: the generic wallet never serves them.
  if (host.status === "absent") {
    return journey !== "tickets" && journey !== "loyalty";
  }
  return host.status === "active" && host.configuration.journeys[journey];
}

/** Whether a face binding belongs to this host (all of them, generically). */
export function hostFaceEnabled(slug: string) {
  const host = walletHost();
  if (host.status === "absent") return true;
  return host.status === "active" && host.configuration.faces.includes(slug);
}

/**
 * Whether this face serves Tickets here: a configured host that enabled the
 * journey, a face of that host, and a binding that declares ticket rules.
 */
export function ticketsServedBy(binding: { slug: string; tickets: unknown }) {
  return (
    hostJourneyEnabled("tickets") &&
    hostFaceEnabled(binding.slug) &&
    binding.tickets !== null
  );
}

/**
 * Whether this face serves Loyalty here: a configured host that enabled the
 * journey, a face of that host, and a binding with the loyalty block.
 */
export function loyaltyServedBy(binding: { slug: string; loyalty: unknown }) {
  return (
    hostJourneyEnabled("loyalty") &&
    hostFaceEnabled(binding.slug) &&
    binding.loyalty !== null
  );
}

/** Where a request for a page a configured host does not serve is sent. */
export const HOST_NOT_FOUND_PATH = "/_wallet-host/not-found";

const FACE_PAGE = /^\/products\/([^/]+)(?:\/.*)?$/;

/**
 * Whether a configured host serves this page. The programme list is the My
 * products journey's; a face page needs a face of this host and every journey
 * its task path needs (a task outside the contract's routes is not served);
 * the handover entry needs registration or transfer (its kind is in the
 * fragment, so the BFF checks that). Every other path, and every path of the
 * generic wallet, is unaffected.
 */
export function hostPageAllowed(pathname: string) {
  const host = walletHost();
  if (host.status !== "active") return true;
  const { journeys } = host.configuration;
  if (pathname === "/products" || pathname === "/products/") {
    return journeys.myProducts;
  }
  const face = FACE_PAGE.exec(pathname);
  if (!face) return true;
  if (!host.configuration.faces.includes(face[1])) return false;
  if (isHandoverEntryPath(pathname)) {
    return journeys.registration || journeys.transfer;
  }
  const task = taskPathFromPathname(pathname, face[1]);
  // Not a valid task path: the page itself sends it to the programme entry.
  if (task === undefined) return true;
  const needed = journeysOfTask(task);
  return needed !== undefined && needed.every((journey) => journeys[journey]);
}

/** Where a signed-in visitor lands when nothing else was asked for. */
export function hostLanding() {
  return walletHost().status === "active" ? "/" : "/inventory";
}

/** A journey's entry: its task in the first of this host's faces backing it. */
function journeyHref(
  host: Extract<HostConfigurationState, { status: "active" }>,
  journey: HostJourney,
) {
  const face = host.faces.find((binding) =>
    bindingBacksJourney(binding, journey),
  );
  if (!face) return undefined;
  const task = hostJourneyTasks[journey];
  return task === "/"
    ? `/products/${face.slug}`
    : `/products/${face.slug}${task}`;
}

/** The configured home: copy, the primary journey and every other enabled one. */
export function hostHome(): HostHomeView | undefined {
  const host = walletHost();
  if (host.status !== "active") return undefined;
  const { configuration } = host;
  const entries = hostJourneys
    .filter((journey) => configuration.journeys[journey])
    .map((journey) => ({ journey, href: journeyHref(host, journey) }))
    .filter(
      (entry): entry is { journey: HostJourney; href: string } =>
        entry.href !== undefined,
    );
  const primary = entries.find(
    (entry) => entry.journey === configuration.home.primaryJourney,
  );
  // Validation guarantees an enabled, backed primary journey.
  if (!primary) return undefined;
  return {
    brand: {
      brand: {
        id: configuration.brand.id,
        name: configuration.brand.name,
        shortName: configuration.brand.shortName,
      },
      logo: { src: hostLogoSrc(configuration) },
    },
    headline: configuration.home.headline,
    introduction: configuration.home.introduction,
    primary,
    journeys: entries.filter((entry) => entry !== primary),
    navigation: configuration.navigation.map((entry) => ({
      entry,
      href: hostNavigationHrefs[entry],
    })),
    tickets: homeTickets(host),
    loyalty: homeLoyalty(host),
  };
}

/**
 * The face whose Tickets the home's Today section reads: exactly the face the
 * Tickets journey link names (the first of the host's faces backing it), and
 * only when the host enabled the journey. Never derived from a label, cookie
 * or request.
 */
function homeTickets(
  host: Extract<HostConfigurationState, { status: "active" }>,
): HostHomeView["tickets"] {
  if (!host.configuration.journeys.tickets) return null;
  const face = host.faces.find((binding) =>
    bindingBacksJourney(binding, "tickets"),
  );
  if (!face || !ticketsServedBy(face)) return null;
  return {
    slug: face.slug,
    href: `/products/${face.slug}${hostJourneyTasks.tickets}`,
  };
}

/** The face whose membership card the home shows, as for Tickets. */
function homeLoyalty(
  host: Extract<HostConfigurationState, { status: "active" }>,
): HostHomeView["loyalty"] {
  if (!host.configuration.journeys.loyalty) return null;
  const face = host.faces.find((binding) =>
    bindingBacksJourney(binding, "loyalty"),
  );
  if (!face || !loyaltyServedBy(face)) return null;
  return {
    slug: face.slug,
    href: `/products/${face.slug}${hostJourneyTasks.loyalty}`,
  };
}

// ------------------------------------------------------------ entrance

/** The host a request names: the first forwarded host, else its Host. */
export function requestHostOf(headers: Headers, fallback = "") {
  return (headers.get("x-forwarded-host") || headers.get("host") || fallback)
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
}

/**
 * Whether a request host is exactly the configured entrance (its default
 * port optional). No other host, subdomain or wildcard maps to a branded
 * host; the generic wallet keeps its own host resolution (api/tenant.ts).
 */
export function isEntranceHost(rawHost: string) {
  const configuration = activeHostConfiguration();
  if (!configuration) return false;
  const entrance = new URL(configuration.entrance.origin);
  const defaultPort = entrance.protocol === "https:" ? ":443" : ":80";
  const host = rawHost.split(",", 1)[0].trim().toLowerCase();
  const bare = host.endsWith(defaultPort)
    ? host.slice(0, -defaultPort.length)
    : host;
  return bare === entrance.host;
}

// ------------------------------------------------------------ readback

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The engine commit this deployment runs: the one its build recorded from the
 * source it built (WALLET_ENGINE_BUILD_COMMIT, inlined at build by
 * next.config.ts from api/engine-build-commit.ts), else the platform's runtime
 * VERCEL_GIT_COMMIT_SHA, else null. Never a value set on the deployment.
 */
function engineCommit(): string | null {
  for (const value of [
    process.env.WALLET_ENGINE_BUILD_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
  ]) {
    if (value && COMMIT.test(value)) return value;
  }
  return null;
}

function readbackJourneys({ tickets, loyalty, ...rest }: HostJourneys) {
  return {
    ...rest,
    ...(tickets ? { tickets } : {}),
    ...(loyalty ? { loyalty } : {}),
  };
}

/**
 * GET /api/host/configuration: what this deployment serves, for Studio and
 * Root to compare with the approved configuration and engine release. Public
 * and secret-free: identifiers, hashes and booleans only.
 */
export function hostReadback() {
  const host = walletHost();
  const configuration = host.status === "active" ? host.configuration : null;
  return {
    schema: HOST_CONFIGURATION_SCHEMA,
    brandId: configuration?.brand.id ?? null,
    organizationId: configuration?.entrance.organizationId ?? null,
    origin: configuration?.entrance.origin ?? null,
    configurationSha256:
      host.status === "absent" ? null : host.configurationSha256,
    configVersion: configuration?.release.configVersion ?? null,
    engine: { version: packageJson.version, commit: engineCommit() },
    // `tickets` and `loyalty` are reported only for a host that enabled
    // them, so the readback of every host that predates them is unchanged.
    journeys: configuration ? readbackJourneys(configuration.journeys) : null,
    faces: configuration ? [...configuration.faces] : null,
    status: host.status,
  };
}

/** Test seam: forget the cached evaluation and the reported problem. */
export function resetWalletHostCache() {
  cached = undefined;
  reported = undefined;
}
