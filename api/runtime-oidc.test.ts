/**
 * @jest-environment node
 */
// Workload OIDC for runtime calls (TIG_RUNTIME_OIDC_ORIGINS): the allowlist,
// the official helper's token and the runtime transport. Every token here is a
// FICTIONAL compact string shaped like a JWS; no real token exists in tests.
import { getVercelOidcToken } from "@vercel/oidc";
import {
  readRegistrationStatus,
  ticketRuntimeCall,
  trustedRuntimeRead,
} from "@/api/face-runtime";
import {
  runtimeOidcConfig,
  runtimeWorkloadAuth,
  TRUSTED_OIDC_HEADER,
} from "@/api/runtime-oidc";

jest.mock("@vercel/oidc", () => ({ getVercelOidcToken: jest.fn() }));
const platformToken = getVercelOidcToken as jest.MockedFunction<
  typeof getVercelOidcToken
>;

const FICTIONAL_TOKEN = [
  Buffer.from('{"alg":"none","fictional":true}').toString("base64url"),
  Buffer.from('{"sub":"fictional-workload"}').toString("base64url"),
  "ZmljdGlvbmFs",
].join(".");
const RUNTIME = "https://runtime.example";
const DUAL = "https://api.dual.example";

const env = (origins?: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  API_URL: DUAL,
  ...(origins === undefined ? {} : { TIG_RUNTIME_OIDC_ORIGINS: origins }),
});

beforeEach(() => {
  platformToken.mockReset().mockResolvedValue(FICTIONAL_TOKEN);
});

describe("the TIG_RUNTIME_OIDC_ORIGINS allowlist", () => {
  it("is off when absent or blank", () => {
    expect(runtimeOidcConfig(env())).toEqual({ status: "off" });
    expect(runtimeOidcConfig(env(""))).toEqual({ status: "off" });
    expect(runtimeOidcConfig(env("  "))).toEqual({ status: "off" });
  });

  it("names exact canonical https origins only", () => {
    const config = runtimeOidcConfig(
      env(`${RUNTIME}, https://second.example:8443`),
    );
    expect(config).toEqual({
      status: "on",
      origins: new Set([RUNTIME, "https://second.example:8443"]),
    });
  });

  it.each([
    ["plain http", "http://runtime.example"],
    ["a trailing slash", "https://runtime.example/"],
    ["a path", "https://runtime.example/api"],
    ["a query", "https://runtime.example?x=1"],
    ["credentials", "https://user@runtime.example"],
    ["an upper-case host", "https://Runtime.example"],
    ["an explicit default port", "https://runtime.example:443"],
    ["a wildcard", "https://*.example"],
    ["an empty entry", `${RUNTIME},,https://second.example`],
    ["not a URL", "runtime.example"],
    ["the Dual API itself", `${RUNTIME},${DUAL}`],
  ])("fails closed on %s", (_label, value) => {
    expect(runtimeOidcConfig(env(value))).toEqual({ status: "invalid" });
  });
});

describe("runtimeWorkloadAuth", () => {
  it("adds nothing, and never asks the platform, when off", async () => {
    expect(await runtimeWorkloadAuth(`${RUNTIME}/x`, env())).toEqual({
      ok: true,
      headers: {},
    });
    expect(platformToken).not.toHaveBeenCalled();
  });

  it("adds the platform token for exactly a listed origin", async () => {
    expect(await runtimeWorkloadAuth(`${RUNTIME}/x`, env(RUNTIME))).toEqual({
      ok: true,
      headers: { [TRUSTED_OIDC_HEADER]: FICTIONAL_TOKEN },
    });
    expect(platformToken).toHaveBeenCalledTimes(1);
    // Called with no options: the current function context's own token.
    expect(platformToken).toHaveBeenCalledWith();
  });

  it.each([
    ["another origin", "https://other.example/x"],
    ["a subdomain of the listed one", "https://a.runtime.example/x"],
    ["the same host over http", "http://runtime.example/x"],
    ["another port", "https://runtime.example:8443/x"],
    ["the Dual API", `${DUAL}/ebus/execute`],
  ])("adds nothing for %s", async (_label, url) => {
    expect(await runtimeWorkloadAuth(url, env(RUNTIME))).toEqual({
      ok: true,
      headers: {},
    });
    expect(platformToken).not.toHaveBeenCalled();
  });

  it("refuses everything while the list is invalid", async () => {
    expect(await runtimeWorkloadAuth(`${RUNTIME}/x`, env("http://x"))).toEqual({
      ok: false,
    });
    expect(platformToken).not.toHaveBeenCalled();
  });

  it.each([
    ["the helper fails", () => platformToken.mockRejectedValue(new Error("x"))],
    ["an empty token", () => platformToken.mockResolvedValue("")],
    ["a token that is not a JWS", () => platformToken.mockResolvedValue("a b")],
    [
      "an oversized token",
      () => platformToken.mockResolvedValue(`a.${"b".repeat(17_000)}.c`),
    ],
  ])("refuses a listed origin when %s", async (_label, arrange) => {
    arrange();
    expect(await runtimeWorkloadAuth(`${RUNTIME}/x`, env(RUNTIME))).toEqual({
      ok: false,
    });
  });
});

describe("the runtime transport", () => {
  const binding = { origin: RUNTIME, applicationId: "fictional.tickets" };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, status: "none" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const original = global.fetch;
  const saved = { ...process.env };
  beforeEach(() => {
    calls.length = 0;
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.API_URL = DUAL;
  });
  afterEach(() => {
    global.fetch = original;
    process.env = { ...saved };
  });
  const tokenOf = (init: RequestInit) =>
    new Headers(init.headers).get(TRUSTED_OIDC_HEADER);
  const call = () =>
    ticketRuntimeCall(
      binding,
      {
        operation: "admission.pending.read",
        operationId: `adm-${"a".repeat(24)}`,
        target: { object_id: "7d00000000000000000000c1" },
        input: {},
      },
      "fictional.assertion.value",
    );

  it("sends the configured runtime exactly one token, with no cookies or redirects", async () => {
    process.env.TIG_RUNTIME_OIDC_ORIGINS = RUNTIME;
    expect(await call()).toEqual(expect.objectContaining({ ok: true }));
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get(TRUSTED_OIDC_HEADER)).toBe(FICTIONAL_TOKEN);
    expect(
      [...headers.keys()].filter((name) => name === TRUSTED_OIDC_HEADER),
    ).toHaveLength(1);
    expect(calls[0].init).toEqual(
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    // The holder's authority still travels as the face assertion.
    expect(JSON.parse(String(calls[0].init.body)).assertion).toBe(
      "fictional.assertion.value",
    );
  });

  it("covers the host's other runtime reads on the same transport", async () => {
    process.env.TIG_RUNTIME_OIDC_ORIGINS = RUNTIME;
    await trustedRuntimeRead(
      binding,
      {
        operation: "case.read",
        operationId: `op-${"b".repeat(24)}`,
        target: { object_id: "7d00000000000000000000c1" },
        input: {},
      },
      "fictional.assertion.value",
    );
    await readRegistrationStatus(
      binding,
      `op-${"c".repeat(24)}`,
      "fictional.assertion.value",
    );
    expect(calls).toHaveLength(2);
    for (const { init } of calls) expect(tokenOf(init)).toBe(FICTIONAL_TOKEN);
  });

  it("sends nothing extra when off or unconfigured, as before", async () => {
    await call();
    process.env.TIG_RUNTIME_OIDC_ORIGINS = "https://other.example";
    await call();
    expect(calls).toHaveLength(2);
    for (const { init } of calls) expect(tokenOf(init)).toBeNull();
    expect(platformToken).not.toHaveBeenCalled();
  });

  it("refuses without dispatch when the token is unavailable, and never repeats the helper's error", async () => {
    process.env.TIG_RUNTIME_OIDC_ORIGINS = RUNTIME;
    platformToken.mockRejectedValue(
      new Error(
        `token context fictional-sensitive-material ${FICTIONAL_TOKEN}`,
      ),
    );
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const warned = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await call();
    expect(result).toEqual({ ok: false, code: "runtime_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fictional-sensitive");
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
    logged.mockRestore();
    warned.mockRestore();
  });

  it("refuses without dispatch while the list is invalid", async () => {
    process.env.TIG_RUNTIME_OIDC_ORIGINS = "http://runtime.example";
    expect(await call()).toEqual({ ok: false, code: "runtime_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never echoes the token in a refusal the runtime returns", async () => {
    process.env.TIG_RUNTIME_OIDC_ORIGINS = RUNTIME;
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ ok: false, status: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await call();
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "runtime_refused" }),
    );
    expect(JSON.stringify(result)).not.toContain(FICTIONAL_TOKEN);
  });
});
