// Parser for a branded wallet host's configuration
// (WALLET_HOST_CONFIGURATION, pinned by WALLET_HOST_CONFIGURATION_SHA256).
// Pure: no environment access, so the server accessor, the request proxy and
// the tests share exactly one validation. It is exact and fails closed: an
// unknown or missing key, a wrong type, an out-of-range value, a non-canonical
// document or a pin mismatch makes the whole configuration invalid, never a
// partially applied one.
import { createHash } from "node:crypto";
import {
  parseProductFaceApplications,
  validFaceOrigin,
  type ProductFaceBinding,
} from "@/api/product-face-binding";
import { canonicalJson } from "@/app/_domain/product-face";
import {
  contrastFailures,
  HOST_CONFIGURATION_SCHEMA,
  hostColourKeys,
  hostJourneys,
  optionalHostJourneys,
  isHexColour,
  isHostFontFamily,
  isHostJourney,
  isHostNavigationEntry,
  requiredHostJourneys,
  type HostColours,
  type HostFontFamily,
  type HostJourney,
  type HostJourneys,
  type HostNavigationEntry,
} from "@/app/_domain/wallet-host";

/** Bound on the whole canonical document (UTF-8 bytes). */
export const MAX_HOST_CONFIGURATION_BYTES = 64 * 1024;
/** Bound on the decoded logo image. */
export const MAX_LOGO_BYTES = 32 * 1024;
const MAX_FACES = 32;

export const hostLogoMediaTypes = ["image/png", "image/webp"] as const;
export type HostLogoMediaType = (typeof hostLogoMediaTypes)[number];

export interface WalletHostConfiguration {
  schema: typeof HOST_CONFIGURATION_SCHEMA;
  brand: { id: string; name: string; shortName: string; description: string };
  entrance: { origin: string; organizationId: string };
  identity: {
    logo: { mediaType: HostLogoMediaType; sha256: string; dataBase64: string };
    colours: HostColours;
    typography: { family: HostFontFamily };
  };
  home: { headline: string; introduction: string; primaryJourney: HostJourney };
  navigation: HostNavigationEntry[];
  journeys: HostJourneys;
  faces: string[];
  release: {
    configVersion: string;
    approvedContentHash: string;
    studioVersionRef: string;
  };
}

/** Why a present configuration is invalid; for the operator log and tests. */
export type HostConfigurationProblem =
  | "build_mismatch"
  | "configuration_missing"
  | "pin_missing"
  | "pin_mismatch"
  | "too_large"
  | "not_json"
  | "not_canonical"
  | "shape"
  | "schema"
  | "brand"
  | "entrance"
  | "app_url_mismatch"
  | "logo"
  | "colours"
  | "contrast"
  | "typography"
  | "home"
  | "navigation"
  | "journeys"
  | "faces"
  | "journey_unbacked"
  | "release"
  | "approved_content_hash";

export type HostConfigurationState =
  | { status: "absent" }
  | {
      status: "invalid";
      problem: HostConfigurationProblem;
      /** sha256 hex of the configuration actually present, if any. */
      configurationSha256: string | null;
    }
  | {
      status: "active";
      configuration: WalletHostConfiguration;
      configurationSha256: string;
      /** The decoded, verified logo bytes. */
      logo: Uint8Array;
      /** This host's face bindings, in the configuration's order. */
      faces: ProductFaceBinding[];
    };

export interface HostConfigurationInput {
  /** WALLET_HOST_CONFIGURATION */
  raw: string | undefined;
  /** WALLET_HOST_CONFIGURATION_SHA256 */
  pin: string | undefined;
  /** NEXT_PUBLIC_APP_URL */
  appUrl: string | undefined;
  /** PRODUCT_FACE_APPLICATIONS */
  faceApplications: string | undefined;
  production: boolean;
  /**
   * sha256 hex of the configuration the build rendered its static pages with
   * ("" for none); undefined when no build recorded one (tests).
   */
  buildSha256?: string;
  /**
   * sha256 hex of the PRODUCT_FACE_APPLICATIONS the build validated a present
   * configuration against (its faces and journeys); checked only while a
   * configuration is present. Undefined when no build recorded one (tests).
   */
  buildFaceApplicationsSha256?: string;
}

const TOP_KEYS = [
  "schema",
  "brand",
  "entrance",
  "identity",
  "home",
  "navigation",
  "journeys",
  "faces",
  "release",
] as const;

const BRAND_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FACE_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ORGANIZATION_ID = /^[0-9a-f]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function sha256Hex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Exactly these keys, every one present. */
function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const present = Object.keys(value);
  return (
    present.length === keys.length && present.every((key) => keys.includes(key))
  );
}

/** Trimmed, non-empty display text without control characters or markup. */
function displayText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f<>]/.test(value)
  );
}

/** PNG signature then IHDR, or a RIFF/WEBP container of exactly its size. */
function imageMatches(bytes: Uint8Array, mediaType: HostLogoMediaType) {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (mediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return (
      bytes.length > 16 &&
      signature.every((byte, index) => bytes[index] === byte) &&
      ascii(12, 16) === "IHDR"
    );
  }
  if (bytes.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") {
    return false;
  }
  const size =
    (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  return (
    size + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16))
  );
}

function parseLogo(value: unknown) {
  if (!exactKeys(value, ["mediaType", "sha256", "dataBase64"])) return;
  const { mediaType, sha256, dataBase64 } = value;
  if (
    !(hostLogoMediaTypes as readonly unknown[]).includes(mediaType) ||
    typeof sha256 !== "string" ||
    !SHA256_HEX.test(sha256) ||
    typeof dataBase64 !== "string" ||
    dataBase64.length === 0 ||
    !BASE64.test(dataBase64)
  ) {
    return undefined;
  }
  const bytes = new Uint8Array(Buffer.from(dataBase64, "base64"));
  // Canonical base64 only: one encoding per image.
  if (Buffer.from(bytes).toString("base64") !== dataBase64) return undefined;
  if (bytes.length > MAX_LOGO_BYTES) return undefined;
  if (!imageMatches(bytes, mediaType as HostLogoMediaType)) return undefined;
  if (sha256Hex(bytes) !== sha256) return undefined;
  return {
    logo: { mediaType: mediaType as HostLogoMediaType, sha256, dataBase64 },
    bytes,
  };
}

function parseColours(value: unknown): HostColours | undefined {
  if (!exactKeys(value, hostColourKeys)) return undefined;
  if (!hostColourKeys.every((key) => isHexColour(value[key]))) return;
  return Object.fromEntries(
    hostColourKeys.map((key) => [key, value[key] as string]),
  ) as HostColours;
}

function appOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** The binding capabilities each enabled journey needs from a host face. */
export function bindingBacksJourney(
  binding: ProductFaceBinding,
  journey: HostJourney,
) {
  switch (journey) {
    case "registration":
    case "myProducts":
      // Every binding carries canonical registration rules.
      return true;
    case "serviceProgress":
    case "quoteDecisions":
      // case.* go to the linked Warranty runtime (contract r10).
      return binding.linkedRuntimes.some(
        (runtime) => runtime.purpose === "claims-warranty",
      );
    case "tickets":
      // Tickets read the holder's own objects through the binding's declared
      // ticket rules; without them the face has no canonical projection.
      return binding.tickets !== null;
    case "loyalty":
      // loyalty-join-earn-v1: the programme's canonical membership and pass.
      return binding.loyalty !== null;
    case "transfer":
      // transfer.sign needs the request template; the recipient accepts
      // through the wallet's handover entry.
      return binding.transferRequest !== null && binding.handover.enabled;
  }
}

type Validation =
  | {
      ok: true;
      configuration: WalletHostConfiguration;
      logo: Uint8Array;
      faces: ProductFaceBinding[];
    }
  | { ok: false; problem: HostConfigurationProblem };

const invalid = (problem: HostConfigurationProblem): Validation => ({
  ok: false,
  problem,
});

function validate(
  value: unknown,
  input: Pick<HostConfigurationInput, "appUrl" | "faceApplications"> & {
    production: boolean;
  },
): Validation {
  if (!exactKeys(value, TOP_KEYS)) return invalid("shape");
  if (value.schema !== HOST_CONFIGURATION_SCHEMA) return invalid("schema");

  const brand = value.brand;
  if (
    !exactKeys(brand, ["id", "name", "shortName", "description"]) ||
    typeof brand.id !== "string" ||
    !BRAND_ID.test(brand.id) ||
    !displayText(brand.name, 40) ||
    !displayText(brand.shortName, 16) ||
    !displayText(brand.description, 160)
  ) {
    return invalid("brand");
  }

  const entrance = value.entrance;
  if (
    !exactKeys(entrance, ["origin", "organizationId"]) ||
    typeof entrance.organizationId !== "string" ||
    !ORGANIZATION_ID.test(entrance.organizationId)
  ) {
    return invalid("entrance");
  }
  // Exact https origin (loopback http only outside production), the same
  // rule as a face origin: no wildcard, path, credentials or other host.
  const origin = validFaceOrigin(entrance.origin, input.production);
  if (!origin) return invalid("entrance");
  if (appOrigin(input.appUrl) !== origin) return invalid("app_url_mismatch");

  const identity = value.identity;
  if (!exactKeys(identity, ["logo", "colours", "typography"])) {
    return invalid("shape");
  }
  const logo = parseLogo(identity.logo);
  if (!logo) return invalid("logo");
  const colours = parseColours(identity.colours);
  if (!colours) return invalid("colours");
  if (contrastFailures(colours).length) return invalid("contrast");
  const typography = identity.typography;
  if (
    !exactKeys(typography, ["family"]) ||
    !isHostFontFamily(typography.family)
  ) {
    return invalid("typography");
  }

  const journeys = value.journeys;
  // The five original journeys are always stated; `tickets` and `loyalty`
  // are opt-in and an absent key is false (so older configurations stay
  // valid unchanged).
  if (
    !record(journeys) ||
    !Object.keys(journeys).every((key) => isHostJourney(key)) ||
    !requiredHostJourneys.every(
      (journey) => typeof journeys[journey] === "boolean",
    ) ||
    optionalHostJourneys.some(
      (journey) =>
        Object.hasOwn(journeys, journey) &&
        typeof journeys[journey] !== "boolean",
    )
  ) {
    return invalid("journeys");
  }
  const enabled = {
    ...(journeys as Partial<HostJourneys>),
    tickets: journeys.tickets === true,
    loyalty: journeys.loyalty === true,
  } as HostJourneys;
  // A quote decision is a decision on a service case.
  if (enabled.quoteDecisions && !enabled.serviceProgress) {
    return invalid("journeys");
  }

  const home = value.home;
  if (
    !exactKeys(home, ["headline", "introduction", "primaryJourney"]) ||
    !displayText(home.headline, 80) ||
    !displayText(home.introduction, 280) ||
    !isHostJourney(home.primaryJourney) ||
    !enabled[home.primaryJourney]
  ) {
    return invalid("home");
  }

  const navigation = value.navigation;
  if (
    !Array.isArray(navigation) ||
    navigation.length > 4 ||
    !navigation.every(isHostNavigationEntry) ||
    new Set(navigation).size !== navigation.length ||
    // The programme list is the My products journey's page.
    (navigation.includes("products") && !enabled.myProducts)
  ) {
    return invalid("navigation");
  }

  const faces = value.faces;
  if (
    !Array.isArray(faces) ||
    faces.length < 1 ||
    faces.length > MAX_FACES ||
    !faces.every((slug) => typeof slug === "string" && FACE_SLUG.test(slug)) ||
    new Set(faces).size !== faces.length
  ) {
    return invalid("faces");
  }
  const registry = parseProductFaceApplications(input.faceApplications, {
    production: input.production,
  });
  const bindings: ProductFaceBinding[] = [];
  for (const slug of faces as string[]) {
    const binding = registry.find((item) => item.slug === slug);
    if (!binding) return invalid("faces");
    bindings.push(binding);
  }
  for (const journey of hostJourneys) {
    if (
      enabled[journey] &&
      !bindings.some((binding) => bindingBacksJourney(binding, journey))
    ) {
      return invalid("journey_unbacked");
    }
  }

  const release = value.release;
  if (
    !exactKeys(release, [
      "configVersion",
      "approvedContentHash",
      "studioVersionRef",
    ]) ||
    typeof release.configVersion !== "string" ||
    !SEMVER.test(release.configVersion) ||
    typeof release.approvedContentHash !== "string" ||
    !CONTENT_HASH.test(release.approvedContentHash) ||
    typeof release.studioVersionRef !== "string" ||
    !VERSION_REF.test(release.studioVersionRef)
  ) {
    return invalid("release");
  }
  if (release.approvedContentHash !== approvedContentHash(value)) {
    return invalid("approved_content_hash");
  }

  return {
    ok: true,
    logo: logo.bytes,
    faces: bindings,
    configuration: {
      schema: HOST_CONFIGURATION_SCHEMA,
      brand: {
        id: brand.id,
        name: brand.name,
        shortName: brand.shortName,
        description: brand.description,
      },
      entrance: { origin, organizationId: entrance.organizationId },
      identity: {
        logo: logo.logo,
        colours,
        typography: { family: typography.family },
      },
      home: {
        headline: home.headline,
        introduction: home.introduction,
        primaryJourney: home.primaryJourney,
      },
      navigation: [...navigation],
      journeys: { ...enabled },
      faces: [...(faces as string[])],
      release: {
        configVersion: release.configVersion,
        approvedContentHash: release.approvedContentHash,
        studioVersionRef: release.studioVersionRef,
      },
    },
  };
}

/**
 * The content hash Studio approves: sha256 of the canonical JSON of the
 * configuration without its `release` block, as `sha256:<hex>`.
 */
export function approvedContentHash(configuration: Record<string, unknown>) {
  const content = Object.fromEntries(
    Object.entries(configuration).filter(([key]) => key !== "release"),
  );
  return `sha256:${sha256Hex(canonicalJson(content))}`;
}

const present = (value: string | undefined) =>
  value !== undefined && value !== "";

/**
 * The host state for one set of inputs. Absent only when neither the
 * configuration nor its pin is set and no build recorded one; anything else
 * present must be entirely valid to be active.
 */
export function evaluateHostConfiguration(
  input: HostConfigurationInput,
): HostConfigurationState {
  const { raw, pin, buildSha256 } = input;
  if (!present(raw) && !present(pin)) {
    // A build that rendered a brand never serves the generic wallet.
    return buildSha256
      ? {
          status: "invalid",
          problem: "build_mismatch",
          configurationSha256: null,
        }
      : { status: "absent" };
  }
  if (!present(raw)) {
    return {
      status: "invalid",
      problem: "configuration_missing",
      configurationSha256: null,
    };
  }
  const document = raw as string;
  const configurationSha256 = sha256Hex(document);
  const fail = (problem: HostConfigurationProblem): HostConfigurationState => ({
    status: "invalid",
    problem,
    configurationSha256,
  });
  if (Buffer.byteLength(document, "utf8") > MAX_HOST_CONFIGURATION_BYTES) {
    return fail("too_large");
  }
  if (buildSha256 !== undefined && buildSha256 !== configurationSha256) {
    return fail("build_mismatch");
  }
  // The faces and journeys a build rendered were checked against its own
  // registry: a different registry at runtime is another host.
  if (
    input.buildFaceApplicationsSha256 !== undefined &&
    input.buildFaceApplicationsSha256 !==
      sha256Hex(input.faceApplications ?? "")
  ) {
    return fail("build_mismatch");
  }
  if (!present(pin)) return fail("pin_missing");
  if (pin !== configurationSha256) return fail("pin_mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return fail("not_json");
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    return fail("not_canonical");
  }
  if (canonical !== document) return fail("not_canonical");
  const result = validate(parsed, input);
  if (!result.ok) return fail(result.problem);
  return {
    status: "active",
    configuration: result.configuration,
    configurationSha256,
    logo: result.logo,
    faces: result.faces,
  };
}
