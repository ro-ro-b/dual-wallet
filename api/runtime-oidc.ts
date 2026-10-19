import "server-only";

// Workload authentication for the wallet's server-to-server runtime calls to a
// runtime behind Vercel Deployment Protection (Trusted Sources). It proves only
// WHICH deployment is calling, never the holder: the face assertion, request
// hash, jti and every object, holder, client and session binding still decide
// what a call may do.
//
// Default off. TIG_RUNTIME_OIDC_ORIGINS is a server-only, comma-separated list
// of exact canonical https origins. Only a runtime call to one of them carries
// the deployment's current OIDC token, read through the official
// `getVercelOidcToken` helper from the platform's own function context; the
// token is never read from an inbound request, and never sent to any other
// origin (Dual, a face, the browser), logged, returned or stored. A listed
// origin whose token is unavailable is refused before anything is sent.

export const TRUSTED_OIDC_HEADER = "x-vercel-trusted-oidc-idp-token";

export type RuntimeOidcConfig =
  | { status: "off" }
  | { status: "on"; origins: ReadonlySet<string> }
  | { status: "invalid" };

/** An exact canonical https origin: no path, query, credentials or wildcard. */
function canonicalHttpsOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // URL accepts characters such as `*` in a host; a listed origin is a plain
  // DNS name (or IPv4 address), nothing that could read as a pattern.
  return url.protocol === "https:" &&
    url.origin === value &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
    ? url.origin
    : undefined;
}

function upstreamOrigin(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return env.API_URL ? new URL(env.API_URL).origin : undefined;
  } catch {
    return undefined;
  }
}

export function runtimeOidcConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeOidcConfig {
  const raw = env.TIG_RUNTIME_OIDC_ORIGINS;
  if (raw === undefined || raw.trim() === "") return { status: "off" };
  const origins = new Set<string>();
  const dual = upstreamOrigin(env);
  for (const item of raw.split(",")) {
    const origin = canonicalHttpsOrigin(item.trim());
    // Any malformed entry, or the Dual API itself, fails every runtime call
    // closed rather than guess which destinations were meant.
    if (!origin || origin === dual) return { status: "invalid" };
    origins.add(origin);
  }
  return { status: "on", origins };
}

/** A three-part compact JWS, as the platform issues it; nothing else is sent. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 16 * 1024;

export type RuntimeWorkloadAuth =
  { ok: true; headers: Record<string, string> } | { ok: false };

/**
 * The headers that authenticate this deployment to `url`'s runtime: none when
 * the allowlist is off or does not name that exact origin; the platform OIDC
 * token when it does; a refusal when the list is invalid or the token is
 * unavailable. The helper's errors are dropped unread: they can carry the
 * token's context.
 */
export async function runtimeWorkloadAuth(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeWorkloadAuth> {
  const config = runtimeOidcConfig(env);
  if (config.status === "off") return { ok: true, headers: {} };
  if (config.status === "invalid") return { ok: false };
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ok: false };
  }
  if (!config.origins.has(origin)) return { ok: true, headers: {} };
  let token: unknown;
  try {
    // Loaded only for a configured destination: with the list off, legacy and
    // local fixtures never load it.
    const { getVercelOidcToken } = await import("@vercel/oidc");
    token = await getVercelOidcToken();
  } catch {
    return { ok: false };
  }
  if (
    typeof token !== "string" ||
    token.length > MAX_TOKEN_LENGTH ||
    !COMPACT_JWT.test(token)
  ) {
    return { ok: false };
  }
  return { ok: true, headers: { [TRUSTED_OIDC_HEADER]: token } };
}
