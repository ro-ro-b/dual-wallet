// The branded wallet host contract (dual-wallet-host-configuration-v1): the
// engine-owned allowlists, journey mapping, contrast rules and token
// serialization that every host configuration is checked and rendered against.
// Framework-free: the server parser, the request proxy and the shell share it.
import { isTaskPath, type RuntimeOperation } from "@/app/_domain/product-face";

export const HOST_CONFIGURATION_SCHEMA = "dual-wallet-host-configuration-v1";

/**
 * The journeys a host enables (the contract's order). `tickets` and
 * `loyalty` are opt-in: a configuration may omit their keys, which is the
 * same as false, so every configuration written before them keeps its
 * canonical bytes.
 */
export const hostJourneys = [
  "registration",
  "myProducts",
  "serviceProgress",
  "quoteDecisions",
  "transfer",
  "tickets",
  "loyalty",
] as const;
export type HostJourney = (typeof hostJourneys)[number];
export type HostJourneys = Record<HostJourney, boolean>;

/** The opt-in journeys: an absent key is false. */
export const optionalHostJourneys: readonly HostJourney[] = [
  "tickets",
  "loyalty",
];

/** The journeys every configuration states; the rest are opt-in keys. */
export const requiredHostJourneys: readonly HostJourney[] = hostJourneys.filter(
  (journey) => !optionalHostJourneys.includes(journey),
);

/**
 * The Dual actions that move an object's custody: hand it over (transfer),
 * leave it for anyone to take (drop) and take it (pickup), or claim it
 * (claim_ownership). A host without the transfer journey offers none of them,
 * natively or through a permit that delegates one.
 */
export const custodyActions = [
  "transfer",
  "drop",
  "pickup",
  "claim_ownership",
] as const;

export function isHostJourney(value: unknown): value is HostJourney {
  return (
    typeof value === "string" &&
    (hostJourneys as readonly string[]).includes(value)
  );
}

/** The engine's navigation allowlist; labels come from engine translations. */
export const hostNavigationEntries = [
  "inventory",
  "products",
  "activity",
  "settings",
] as const;
export type HostNavigationEntry = (typeof hostNavigationEntries)[number];

export function isHostNavigationEntry(
  value: unknown,
): value is HostNavigationEntry {
  return (
    typeof value === "string" &&
    (hostNavigationEntries as readonly string[]).includes(value)
  );
}

/**
 * The bundled families a host may select: the engine's own Satoshi files in
 * public/fonts and system stacks. No remote font is ever loaded.
 */
export const hostFontFamilies = {
  satoshi: '"Satoshi", ui-sans-serif, system-ui, sans-serif',
  "system-sans":
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "system-serif": 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  "system-rounded":
    'ui-rounded, "SF Pro Rounded", ui-sans-serif, system-ui, sans-serif',
} as const;
export type HostFontFamily = keyof typeof hostFontFamilies;

export function isHostFontFamily(value: unknown): value is HostFontFamily {
  return typeof value === "string" && Object.hasOwn(hostFontFamilies, value);
}

/** The configurable colours, each mapped to an existing semantic token. */
export const hostColourTokens = {
  brand: "--brand",
  brandStrong: "--brand-strong",
  brandSoft: "--brand-soft",
  ink: "--ink",
  muted: "--muted",
  actionPrimary: "--action-primary",
  actionPrimaryHover: "--action-primary-hover",
  onActionPrimary: "--on-action-primary",
  surface: "--surface",
  surfaceSubtle: "--surface-subtle",
  border: "--border",
} as const;
export type HostColourKey = keyof typeof hostColourTokens;
export type HostColours = Record<HostColourKey, string>;
export const hostColourKeys = Object.keys(hostColourTokens) as HostColourKey[];

/**
 * The engine's own light-theme values for the tokens a host does not
 * configure (statuses and control boundaries). A brand host renders one
 * validated palette, so these stay fixed in both theme states. Kept equal to
 * the :root block of app/globals.css by a test.
 */
export const engineLightTokens = {
  "--border-strong": "#799094",
  "--danger": "#ad3232",
  "--on-danger": "#ffffff",
  "--success": "#167a5a",
  "--warning": "#8f5300",
} as const;

const HEX_COLOUR = /^#[0-9a-f]{6}$/;

export function isHexColour(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOUR.test(value);
}

const channels = (hex: string) =>
  [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));

function luminance(hex: string) {
  return channels(hex)
    .map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0);
}

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
export function contrastRatio(foreground: string, background: string) {
  const [a, b] = [luminance(foreground), luminance(background)].sort(
    (x, y) => y - x,
  );
  return (a + 0.05) / (b + 0.05);
}

/** `color-mix(in srgb, <fg> <share>, <bg>)` flattened to #rrggbb. */
export function mixColours(
  foreground: string,
  background: string,
  share: number,
) {
  const [f, b] = [channels(foreground), channels(background)];
  return `#${f
    .map((value, i) =>
      Math.round(value * share + b[i] * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export interface HostContrastRule {
  id: string;
  minimum: number;
  pair: (colours: HostColours) => [foreground: string, background: string];
}

/**
 * The pairs a host palette must pass. The first three are the contract's
 * listed pairs; the rest are the checks the engine's own light palette
 * already passes (app/_components/design-system/contrast.test.ts) for the
 * places the engine shell puts these tokens, so a brand palette keeps the
 * shell at WCAG 2.2 AA.
 */
export const hostContrastRules: readonly HostContrastRule[] = [
  { id: "ink/surface", minimum: 4.5, pair: (c) => [c.ink, c.surface] },
  {
    id: "onActionPrimary/actionPrimary",
    minimum: 4.5,
    pair: (c) => [c.onActionPrimary, c.actionPrimary],
  },
  {
    id: "actionPrimary/surface",
    minimum: 4.5,
    pair: (c) => [c.actionPrimary, c.surface],
  },
  {
    id: "onActionPrimary/actionPrimaryHover",
    minimum: 4.5,
    pair: (c) => [c.onActionPrimary, c.actionPrimaryHover],
  },
  {
    id: "ink/surfaceSubtle",
    minimum: 4.5,
    pair: (c) => [c.ink, c.surfaceSubtle],
  },
  { id: "ink/brandSoft", minimum: 4.5, pair: (c) => [c.ink, c.brandSoft] },
  { id: "muted/surface", minimum: 4.5, pair: (c) => [c.muted, c.surface] },
  {
    id: "muted/surfaceSubtle",
    minimum: 4.5,
    pair: (c) => [c.muted, c.surfaceSubtle],
  },
  {
    id: "brandStrong/surface",
    minimum: 4.5,
    pair: (c) => [c.brandStrong, c.surface],
  },
  {
    id: "brandStrong/surfaceSubtle",
    minimum: 4.5,
    pair: (c) => [c.brandStrong, c.surfaceSubtle],
  },
  {
    id: "brandStrong/brandSoft",
    minimum: 4.5,
    pair: (c) => [c.brandStrong, c.brandSoft],
  },
  {
    id: "borderStrong/surface",
    minimum: 3,
    pair: (c) => [engineLightTokens["--border-strong"], c.surface],
  },
  {
    id: "success/surface",
    minimum: 4.5,
    pair: (c) => {
      const status = engineLightTokens["--success"];
      return [status, mixColours(status, c.surface, 0.1)];
    },
  },
  {
    id: "warning/surface",
    minimum: 4.5,
    pair: (c) => {
      const status = engineLightTokens["--warning"];
      return [status, mixColours(status, c.surface, 0.1)];
    },
  },
  {
    id: "danger/surface",
    minimum: 4.5,
    pair: (c) => {
      const status = engineLightTokens["--danger"];
      return [status, mixColours(status, c.surface, 0.09)];
    },
  },
  {
    // The avatar gradient runs to a stop mixed 78% with --ink.
    id: "onActionPrimary/avatar",
    minimum: 4.5,
    pair: (c) => [c.onActionPrimary, mixColours(c.actionPrimary, c.ink, 0.78)],
  },
];

/** The ids of every rule the palette fails; empty when it passes. */
export function contrastFailures(colours: HostColours) {
  return hostContrastRules
    .filter((rule) => {
      const [foreground, background] = rule.pair(colours);
      return contrastRatio(foreground, background) < rule.minimum;
    })
    .map((rule) => rule.id);
}

/**
 * The journey each runtime operation belongs to. A Record over every
 * operation name, so a new operation cannot be added without a journey.
 */
const operationJourneys: Record<RuntimeOperation, HostJourney> = {
  "registration.submit": "registration",
  "registration.status": "registration",
  "registration.settle.propose": "registration",
  "registration.settle.verify": "registration",
  "registration.settle.status": "registration",
  "registration.pending.read": "registration",
  "registration.settle.reserve": "registration",
  "products.private.read": "myProducts",
  "cases.list": "serviceProgress",
  "case.read": "serviceProgress",
  "case.open": "serviceProgress",
  "case.evidence.submit": "serviceProgress",
  "case.information.provide": "serviceProgress",
  "case.quote.approve": "quoteDecisions",
  "case.quote.decline": "quoteDecisions",
  "transfer.offer": "transfer",
  "transfer.offer.read": "transfer",
  "transfer.accept": "transfer",
  "transfer.read": "transfer",
  "transfer.cancel": "transfer",
  "transfer.propose": "transfer",
  "transfer.reserve": "transfer",
  "transfer.verify": "transfer",
  "transfer.status": "transfer",
  "transfer.acceptance.read": "transfer",
  // Host-only (proposed r20): never minted for a face, so never classified
  // from a face request; the host reads it only for an entry whose own
  // journey the request was already admitted for.
  "write.status": "serviceProgress",
  // Host-only (proposed r20): the host's own recovery listing and
  // acknowledgement, never minted for a face and never classified from a
  // face request. Each recovered item is gated by its OWN kind's journey.
  "recovery.list": "myProducts",
  "recovery.ack": "myProducts",
};

export function journeyOfOperation(operation: RuntimeOperation): HostJourney {
  return operationJourneys[operation];
}

/**
 * The journey of a face journal entry: registrations and their settle steps
 * are registration, holder-signed transfer steps are transfer, and a runtime
 * write belongs to its operation's journey.
 */
export function journeyOfJournalEntry(entry: {
  kind: string;
  operation?: string;
}): HostJourney | undefined {
  if (entry.kind === "registration" || entry.kind === "settle") {
    return "registration";
  }
  if (entry.kind === "transfer") return "transfer";
  // P4.3: an admission step belongs to the Tickets journey; no other flag.
  if (entry.kind === "admission") return "tickets";
  // loyalty-join-earn-v1: a member's activity submission.
  if (entry.kind === "loyalty") return "loyalty";
  if (
    entry.kind === "runtime" &&
    typeof entry.operation === "string" &&
    Object.hasOwn(operationJourneys, entry.operation)
  ) {
    return operationJourneys[entry.operation as RuntimeOperation];
  }
  return undefined;
}

/**
 * The journeys a face task path needs, by the contract's route names
 * (contracts/dual-product-face-v1.json taskPath.routes). Home, help and the
 * ended page need none; a product page's transfer section needs transfer as
 * well. Undefined: not a contract route, which a configured host refuses.
 */
export function journeysOfTask(task: string): HostJourney[] | undefined {
  if (!isTaskPath(task)) return undefined;
  const parts = task.split("/").filter(Boolean);
  switch (parts[0] ?? "home") {
    case "home":
    case "support":
    case "ended":
      return [];
    case "register":
      return ["registration"];
    case "products":
      return parts[2] === "transfer"
        ? ["myProducts", "transfer"]
        : ["myProducts"];
    case "service":
      return ["serviceProgress"];
    case "accept":
      return ["transfer"];
    case "tickets":
      return ["tickets"];
    case "loyalty":
      return ["loyalty"];
    default:
      return undefined;
  }
}

/** Where each journey starts inside a host face (a contract task path). */
export const hostJourneyTasks: Record<HostJourney, string> = {
  registration: "/register",
  myProducts: "/products",
  serviceProgress: "/service",
  quoteDecisions: "/service",
  transfer: "/",
  tickets: "/tickets",
  loyalty: "/loyalty",
};

export const hostNavigationHrefs: Record<HostNavigationEntry, string> = {
  inventory: "/inventory",
  products: "/products",
  activity: "/activity",
  settings: "/settings",
};

/**
 * The host stylesheet: the validated palette as the existing semantic tokens,
 * in both theme states (a brand host renders one checked palette), and the
 * selected bundled family. Every value is re-checked here; nothing else of
 * the configuration reaches CSS.
 */
export function hostTokenCss(colours: HostColours, family: HostFontFamily) {
  for (const key of hostColourKeys) {
    if (!isHexColour(colours[key])) throw new Error("invalid_host_colour");
  }
  if (!isHostFontFamily(family)) throw new Error("invalid_host_font");
  const declarations = [
    ...hostColourKeys.map((key) => `${hostColourTokens[key]}:${colours[key]}`),
    `--content-accent:${colours.brandStrong}`,
    `--surface-raised:${colours.surface}`,
    ...Object.entries(engineLightTokens).map(
      ([name, value]) => `${name}:${value}`,
    ),
  ];
  return `html[data-wallet-host],html[data-wallet-host].dark{${declarations.join(
    ";",
  )}}html[data-wallet-host] body{font-family:${hostFontFamilies[family]}}`;
}

/** What the browser shell may know about the host: presentation only. */
export interface HostPresentation {
  brand: { id: string; name: string; shortName: string };
  logo: { src: string };
  navigation: HostNavigationEntry[];
  home: { headline: string; introduction: string };
  journeys: HostJourneys;
}

/** The configured home page: copy, the primary journey and the others. */
export interface HostHomeView {
  brand: Pick<HostPresentation, "brand" | "logo">;
  headline: string;
  introduction: string;
  primary: { journey: HostJourney; href: string };
  journeys: Array<{ journey: HostJourney; href: string }>;
  navigation: Array<{ entry: HostNavigationEntry; href: string }>;
  /**
   * The Tickets face the signed-in home reads for Today (its slug and the
   * full list); null when the host does not serve Tickets.
   */
  tickets: { slug: string; href: string } | null;
  /**
   * The Loyalty face the signed-in home reads its membership card from;
   * null when the host does not serve Loyalty.
   */
  loyalty: { slug: string; href: string } | null;
}
