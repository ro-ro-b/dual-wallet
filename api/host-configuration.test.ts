/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";
import {
  approvedContentHash,
  evaluateHostConfiguration,
  MAX_LOGO_BYTES,
  type HostConfigurationInput,
} from "@/api/host-configuration";
import { canonicalJson } from "@/app/_domain/product-face";
import { edit, REMOVE, bindingInput } from "@/test/product-face-fixtures";
import {
  MORROW_ORGANIZATION,
  MORROW_ORIGIN,
  morrowBinding,
  morrowDocument,
  registryWithBothFaces,
  sealHost,
  tidewellBinding,
  tidewellDocument,
  TIDEWELL_ORIGIN,
  type HostDocument,
} from "@/test/wallet-host-fixtures";

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function inputFor(
  document: HostDocument,
  overrides: Partial<HostConfigurationInput> = {},
  { keepHash = false } = {},
): HostConfigurationInput {
  const { raw, pin } = sealHost(document, { keepHash });
  return {
    raw,
    pin,
    appUrl: (document.entrance as { origin?: string })?.origin ?? MORROW_ORIGIN,
    faceApplications: registryWithBothFaces(),
    production: true,
    ...overrides,
  };
}

/** The morrow document with one dotted path rewritten (or REMOVEd). */
function morrowWith(path: string, value: unknown) {
  const document = morrowDocument();
  edit(document, path, value);
  return document;
}

function problemOf(input: HostConfigurationInput) {
  const state = evaluateHostConfiguration(input);
  return state.status === "invalid" ? state.problem : state.status;
}

const problemFor = (path: string, value: unknown) =>
  problemOf(inputFor(morrowWith(path, value), { appUrl: MORROW_ORIGIN }));

describe("absent configuration", () => {
  it("is absent only when neither the configuration nor its pin is set", () => {
    for (const raw of [undefined, ""]) {
      for (const pin of [undefined, ""]) {
        expect(
          evaluateHostConfiguration({
            raw,
            pin,
            appUrl: "http://demo.localhost:3000",
            faceApplications: "[]",
            production: true,
          }),
        ).toEqual({ status: "absent" });
      }
    }
    // A build that recorded no configuration agrees.
    expect(
      evaluateHostConfiguration({
        raw: undefined,
        pin: undefined,
        appUrl: undefined,
        faceApplications: undefined,
        production: true,
        buildSha256: "",
      }),
    ).toEqual({ status: "absent" });
  });

  it("a pin without its configuration is invalid, not absent", () => {
    expect(
      evaluateHostConfiguration({
        raw: undefined,
        pin: "a".repeat(64),
        appUrl: MORROW_ORIGIN,
        faceApplications: "[]",
        production: true,
      }),
    ).toEqual({
      status: "invalid",
      problem: "configuration_missing",
      configurationSha256: null,
    });
  });

  it("a build that rendered a brand never serves the generic wallet", () => {
    expect(
      evaluateHostConfiguration({
        raw: undefined,
        pin: undefined,
        appUrl: MORROW_ORIGIN,
        faceApplications: "[]",
        production: true,
        buildSha256: "c".repeat(64),
      }),
    ).toEqual({
      status: "invalid",
      problem: "build_mismatch",
      configurationSha256: null,
    });
  });
});

describe("an active configuration", () => {
  it("parses the morrow fixture exactly, with its logo bytes and faces", () => {
    const input = inputFor(morrowDocument());
    const state = evaluateHostConfiguration(input);
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configurationSha256).toBe(sha256(input.raw!));
    // A configuration that does not mention Tickets parses with it off.
    const sealed = sealHost(morrowDocument()).document;
    expect(state.configuration).toEqual({
      ...sealed,
      journeys: { ...(sealed.journeys as object), tickets: false },
    });
    expect(Buffer.from(state.logo).toString("base64")).toBe(
      (morrowDocument().identity as { logo: { dataBase64: string } }).logo
        .dataBase64,
    );
    expect(state.faces.map((face) => face.slug)).toEqual(["morrow-home"]);
  });

  it("parses the tidewell fixture (WebP logo, serif family, fewer journeys)", () => {
    const state = evaluateHostConfiguration(
      inputFor(tidewellDocument(), { appUrl: TIDEWELL_ORIGIN }),
    );
    if (state.status !== "active") throw new Error(JSON.stringify(state));
    expect(state.configuration.identity.logo.mediaType).toBe("image/webp");
    expect(state.configuration.identity.typography.family).toBe("system-serif");
    expect(state.faces.map((face) => face.slug)).toEqual(["tidewell-care"]);
  });

  it("accepts a build that rendered the same configuration", () => {
    const input = inputFor(morrowDocument());
    expect(
      evaluateHostConfiguration({ ...input, buildSha256: sha256(input.raw!) })
        .status,
    ).toBe("active");
  });

  it("accepts loopback http entrances outside production only", () => {
    const document = morrowWith("entrance.origin", "http://localhost:3000");
    expect(
      problemOf(
        inputFor(document, {
          appUrl: "http://localhost:3000",
          production: false,
        }),
      ),
    ).toBe("active");
    expect(
      problemOf(inputFor(document, { appUrl: "http://localhost:3000" })),
    ).toBe("entrance");
  });

  it("compares NEXT_PUBLIC_APP_URL by origin", () => {
    expect(
      problemOf(
        inputFor(morrowDocument(), { appUrl: `${MORROW_ORIGIN}/wallet/` }),
      ),
    ).toBe("active");
  });
});

describe("pin and document integrity", () => {
  it("refuses a pin that names other bytes", () => {
    const input = inputFor(morrowDocument());
    const state = evaluateHostConfiguration({
      ...input,
      pin: sha256(`${input.raw} `),
    });
    expect(state).toEqual({
      status: "invalid",
      problem: "pin_mismatch",
      configurationSha256: sha256(input.raw!),
    });
    expect(problemOf({ ...input, pin: input.pin!.toUpperCase() })).toBe(
      "pin_mismatch",
    );
    expect(problemOf({ ...input, pin: undefined })).toBe("pin_missing");
    expect(problemOf({ ...input, pin: "" })).toBe("pin_missing");
  });

  it("refuses a face registry other than the one the build validated against", () => {
    const input = inputFor(morrowDocument());
    const built = sha256(input.faceApplications!);
    expect(problemOf({ ...input, buildFaceApplicationsSha256: built })).toBe(
      "active",
    );
    for (const faceApplications of [
      JSON.stringify([morrowBinding()]),
      undefined,
      `${input.faceApplications} `,
    ]) {
      expect(
        problemOf({
          ...input,
          faceApplications,
          buildFaceApplicationsSha256: built,
        }),
      ).toBe("build_mismatch");
    }
    // Never consulted for the generic wallet.
    expect(
      evaluateHostConfiguration({
        raw: undefined,
        pin: undefined,
        appUrl: undefined,
        faceApplications: "[]",
        production: true,
        buildSha256: "",
        buildFaceApplicationsSha256: "",
      }),
    ).toEqual({ status: "absent" });
  });

  it("refuses a runtime configuration other than the one the build rendered", () => {
    const input = inputFor(morrowDocument());
    expect(problemOf({ ...input, buildSha256: "" })).toBe("build_mismatch");
    expect(problemOf({ ...input, buildSha256: "d".repeat(64) })).toBe(
      "build_mismatch",
    );
  });

  it("refuses a document that is not exactly canonical JSON", () => {
    const { document } = sealHost(morrowDocument());
    for (const raw of [
      JSON.stringify(document, null, 2),
      JSON.stringify(document),
      `${canonicalJson(document)}\n`,
      // A duplicate key parses, but is not the canonical bytes.
      canonicalJson(document).replace('{"brand":', '{"brand":{},"brand":'),
    ]) {
      expect(
        problemOf({ ...inputFor(morrowDocument()), raw, pin: sha256(raw) }),
      ).toBe("not_canonical");
    }
    const broken = "{not json";
    expect(
      problemOf({
        ...inputFor(morrowDocument()),
        raw: broken,
        pin: sha256(broken),
      }),
    ).toBe("not_json");
  });

  it("refuses an oversized document before parsing it", () => {
    const raw = `"${"x".repeat(64 * 1024)}"`;
    expect(
      problemOf({ ...inputFor(morrowDocument()), raw, pin: sha256(raw) }),
    ).toBe("too_large");
  });

  it("refuses a stale approved content hash", () => {
    const document = morrowDocument();
    const { document: sealed } = sealHost(document);
    edit(sealed, "brand.name", "Morrow Home Ltd");
    expect(problemOf(inputFor(sealed, {}, { keepHash: true }))).toBe(
      "approved_content_hash",
    );
    expect(approvedContentHash(sealHost(morrowDocument()).document)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
});

describe("exact shape", () => {
  it("refuses an unknown or missing key at every level", () => {
    const top = morrowDocument();
    (top as Record<string, unknown>).theme = "dark";
    expect(problemOf(inputFor(top))).toBe("shape");
    expect(problemOf(inputFor(morrowWith("faces", REMOVE)))).toBe("shape");
    for (const [path, problem] of [
      ["brand.tagline", "brand"],
      ["entrance.host", "entrance"],
      ["identity.css", "shape"],
      ["identity.logo.url", "logo"],
      ["identity.colours.accent", "colours"],
      ["identity.typography.url", "typography"],
      ["home.cta", "home"],
      ["journeys.payments", "journeys"],
      ["release.notes", "release"],
    ] as const) {
      expect([path, problemFor(path, "x")]).toEqual([path, problem]);
    }
    for (const [path, problem] of [
      ["brand.description", "brand"],
      ["entrance.organizationId", "entrance"],
      ["identity.logo.sha256", "logo"],
      ["identity.colours.border", "colours"],
      ["home.primaryJourney", "home"],
      ["journeys.transfer", "journeys"],
      ["release.studioVersionRef", "release"],
    ] as const) {
      expect([path, problemFor(path, REMOVE)]).toEqual([path, problem]);
    }
  });

  it("refuses another schema", () => {
    expect(problemFor("schema", "dual-wallet-host-configuration-v2")).toBe(
      "schema",
    );
  });

  it("refuses a wrong type anywhere", () => {
    for (const [path, value, problem] of [
      ["brand", [], "brand"],
      ["brand.name", 7, "brand"],
      ["entrance.origin", ["https://x.example"], "entrance"],
      ["identity", "logo", "shape"],
      ["identity.colours.ink", 0x10261c, "colours"],
      ["home.headline", null, "home"],
      ["navigation", "inventory", "navigation"],
      ["journeys.registration", "true", "journeys"],
      ["journeys.myProducts", 1, "journeys"],
      ["faces", "morrow-home", "faces"],
      ["release.configVersion", 1, "release"],
    ] as const) {
      expect([path, problemFor(path, value)]).toEqual([path, problem]);
    }
  });
});

describe("brand", () => {
  it("bounds every field", () => {
    for (const [path, value] of [
      ["brand.id", "Morrow"],
      ["brand.id", "m"],
      ["brand.id", "morrow_home"],
      ["brand.name", "x".repeat(41)],
      ["brand.name", ""],
      ["brand.name", " Morrow"],
      ["brand.name", "<b>Morrow</b>"],
      ["brand.shortName", "x".repeat(17)],
      ["brand.description", "x".repeat(161)],
      ["brand.description", "line\nbreak"],
    ] as const) {
      expect([path, value, problemFor(path, value)]).toEqual([
        path,
        value,
        "brand",
      ]);
    }
    expect(problemFor("brand.name", "x".repeat(40))).toBe("active");
    expect(problemFor("brand.shortName", "x".repeat(16))).toBe("active");
  });
});

describe("entrance", () => {
  it("requires an exact https origin and a Dual organisation id", () => {
    for (const origin of [
      "http://wallet.morrow.example",
      "https://wallet.morrow.example/",
      "https://wallet.morrow.example/login",
      "https://*.morrow.example",
      "https://user@wallet.morrow.example",
      "wallet.morrow.example",
    ]) {
      expect([
        origin,
        problemOf(
          inputFor(morrowWith("entrance.origin", origin), { appUrl: origin }),
        ),
      ]).toEqual([origin, "entrance"]);
    }
    for (const organizationId of [
      MORROW_ORGANIZATION.toUpperCase(),
      MORROW_ORGANIZATION.slice(1),
      `${MORROW_ORGANIZATION}0`,
      "*",
    ]) {
      expect(problemFor("entrance.organizationId", organizationId)).toBe(
        "entrance",
      );
    }
  });

  it("must equal NEXT_PUBLIC_APP_URL", () => {
    for (const appUrl of [
      undefined,
      "",
      "not a url",
      TIDEWELL_ORIGIN,
      "http://wallet.morrow.example",
      "https://wallet.morrow.example:8443",
    ]) {
      expect(problemOf(inputFor(morrowDocument(), { appUrl }))).toBe(
        "app_url_mismatch",
      );
    }
  });
});

describe("logo", () => {
  const png = Buffer.from(
    (morrowDocument().identity as { logo: { dataBase64: string } }).logo
      .dataBase64,
    "base64",
  );
  const withLogo = (bytes: Buffer, mediaType = "image/png") =>
    morrowWith("identity.logo", {
      mediaType,
      sha256: sha256(bytes),
      dataBase64: bytes.toString("base64"),
    });

  it("refuses SVG and any other media type", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(problemOf(inputFor(withLogo(svg, "image/svg+xml")))).toBe("logo");
    expect(problemOf(inputFor(withLogo(png, "image/jpeg")))).toBe("logo");
    expect(problemOf(inputFor(withLogo(svg, "image/png")))).toBe("logo");
  });

  it("checks the magic bytes against the declared type", () => {
    expect(problemOf(inputFor(withLogo(png, "image/webp")))).toBe("logo");
    const tidewell = Buffer.from(
      (tidewellDocument().identity as { logo: { dataBase64: string } }).logo
        .dataBase64,
      "base64",
    );
    expect(problemOf(inputFor(withLogo(tidewell, "image/png")))).toBe("logo");
    expect(problemOf(inputFor(withLogo(tidewell, "image/webp")))).toBe(
      "active",
    );
    // A RIFF container whose size field lies is not accepted.
    const lying = Buffer.from(tidewell);
    lying.writeUInt32LE(lying.readUInt32LE(4) + 1, 4);
    expect(problemOf(inputFor(withLogo(lying, "image/webp")))).toBe("logo");
    // A PNG signature without its IHDR chunk is not accepted.
    const headless = Buffer.from(png);
    headless.write("XXXX", 12, "latin1");
    expect(problemOf(inputFor(withLogo(headless)))).toBe("logo");
  });

  it("caps the decoded image at 32 KiB", () => {
    const padded = (size: number) =>
      Buffer.concat([png, Buffer.alloc(size - png.length)]);
    expect(problemOf(inputFor(withLogo(padded(MAX_LOGO_BYTES))))).toBe(
      "active",
    );
    expect(problemOf(inputFor(withLogo(padded(MAX_LOGO_BYTES + 1))))).toBe(
      "logo",
    );
  });

  it("requires the sha256 of exactly the decoded bytes", () => {
    const document = withLogo(png);
    edit(
      document,
      "identity.logo.sha256",
      sha256(Buffer.concat([png, Buffer.from([0])])),
    );
    expect(problemOf(inputFor(document))).toBe("logo");
    edit(document, "identity.logo.sha256", sha256(png).toUpperCase());
    expect(problemOf(inputFor(document))).toBe("logo");
  });

  it("accepts canonical base64 only", () => {
    const base64 = png.toString("base64");
    expect(base64.endsWith("I=")).toBe(true);
    for (const dataBase64 of [
      "",
      base64.replace(/=+$/, ""),
      `${base64.slice(0, 20)}\n${base64.slice(20)}`,
      // URL-safe alphabet.
      `${base64.slice(0, 10)}-${base64.slice(11)}`,
      // Same bytes, non-zero padding bits.
      base64.replace(/I=$/, "J="),
    ]) {
      const document = withLogo(png);
      edit(document, "identity.logo.dataBase64", dataBase64);
      expect(problemOf(inputFor(document))).toBe("logo");
    }
  });
});

describe("colours", () => {
  it("accepts lowercase #rrggbb only", () => {
    for (const value of [
      "#FFFFFF",
      "#fff",
      "white",
      "#ffffff;",
      "rgb(0,0,0)",
      "#ffffff80",
    ]) {
      expect([value, problemFor("identity.colours.surface", value)]).toEqual([
        value,
        "colours",
      ]);
    }
  });

  it("refuses each listed pair under its WCAG minimum", () => {
    // ink on surface
    expect(problemFor("identity.colours.ink", "#9a9a9a")).toBe("contrast");
    // text on the primary action
    expect(problemFor("identity.colours.onActionPrimary", "#2f7d5b")).toBe(
      "contrast",
    );
    // the primary action on the surface
    expect(problemFor("identity.colours.actionPrimary", "#a8d5c0")).toBe(
      "contrast",
    );
    // the engine's own checks on the same tokens
    expect(problemFor("identity.colours.muted", "#a0a0a0")).toBe("contrast");
    expect(problemFor("identity.colours.brandSoft", "#1d5c41")).toBe(
      "contrast",
    );
    // a dark surface fails the engine's fixed status colours
    expect(
      problemOf(
        inputFor(
          (() => {
            const document = morrowDocument();
            edit(document, "identity.colours.surface", "#10261c");
            edit(document, "identity.colours.ink", "#ffffff");
            return document;
          })(),
        ),
      ),
    ).toBe("contrast");
  });
});

describe("typography", () => {
  it("selects only a bundled family", () => {
    for (const family of ["system-sans", "system-serif", "system-rounded"]) {
      expect(problemFor("identity.typography.family", family)).toBe("active");
    }
    for (const family of [
      "Inter",
      "https://fonts.example/brand.woff2",
      "Satoshi",
      "",
    ]) {
      expect(problemFor("identity.typography.family", family)).toBe(
        "typography",
      );
    }
  });
});

describe("home, navigation and journeys", () => {
  it("bounds the home copy and needs an enabled primary journey", () => {
    expect(problemFor("home.headline", "x".repeat(81))).toBe("home");
    expect(problemFor("home.introduction", "x".repeat(281))).toBe("home");
    expect(problemFor("home.primaryJourney", "payments")).toBe("home");
    const disabled = morrowDocument();
    edit(disabled, "journeys.transfer", false);
    edit(disabled, "home.primaryJourney", "transfer");
    expect(problemOf(inputFor(disabled))).toBe("home");
  });

  it("navigation is an ordered unique subset of the allowlist", () => {
    expect(problemFor("navigation", [])).toBe("active");
    expect(problemFor("navigation", ["settings", "inventory"])).toBe("active");
    for (const navigation of [
      ["inventory", "inventory"],
      ["inventory", "admin"],
      ["/inventory"],
      ["inventory", "products", "activity", "settings", "settings"],
    ]) {
      expect(problemFor("navigation", navigation)).toBe("navigation");
    }
    const noProducts = morrowDocument();
    edit(noProducts, "journeys.myProducts", false);
    expect(problemOf(inputFor(noProducts))).toBe("navigation");
    edit(noProducts, "navigation", ["inventory"]);
    expect(problemOf(inputFor(noProducts))).toBe("active");
  });

  it("quote decisions need service progress", () => {
    const document = morrowDocument();
    edit(document, "journeys.serviceProgress", false);
    expect(problemOf(inputFor(document))).toBe("journeys");
    edit(document, "journeys.quoteDecisions", false);
    expect(problemOf(inputFor(document))).toBe("active");
  });
});

describe("faces and journey backing", () => {
  it("every face must be a valid binding in PRODUCT_FACE_APPLICATIONS", () => {
    expect(problemFor("faces", [])).toBe("faces");
    expect(problemFor("faces", ["morrow-home", "morrow-home"])).toBe("faces");
    expect(problemFor("faces", ["unknown-face"])).toBe("faces");
    expect(problemFor("faces", ["Morrow"])).toBe("faces");
    // Present but dropped as invalid by the registry parser.
    expect(
      problemOf(
        inputFor(morrowDocument(), {
          faceApplications: JSON.stringify([
            { ...morrowBinding(), version: "latest" },
          ]),
        }),
      ),
    ).toBe("faces");
    expect(
      problemOf(inputFor(morrowDocument(), { faceApplications: undefined })),
    ).toBe("faces");
  });

  it("service and quote journeys need a face with a linked Warranty runtime", () => {
    const document = morrowWith("faces", ["tidewell-care"]);
    expect(problemOf(inputFor(document))).toBe("journey_unbacked");
    edit(document, "journeys.transfer", false);
    expect(problemOf(inputFor(document))).toBe("journey_unbacked");
    edit(document, "journeys.serviceProgress", false);
    edit(document, "journeys.quoteDecisions", false);
    expect(problemOf(inputFor(document))).toBe("active");
  });

  it("transfer needs a face with a transfer request template and handover", () => {
    const document = morrowDocument();
    for (const binding of [
      { ...morrowBinding(), transferRequest: null },
      { ...morrowBinding(), handover: { enabled: false } },
    ]) {
      expect(
        problemOf(
          inputFor(document, { faceApplications: JSON.stringify([binding]) }),
        ),
      ).toBe("journey_unbacked");
    }
  });

  it("a journey may be backed by any one of the host's faces", () => {
    const document = morrowWith("faces", ["tidewell-care", "morrow-home"]);
    expect(problemOf(inputFor(document))).toBe("active");
    // Registration alone is backed by every binding.
    const registrationOnly = tidewellDocument();
    edit(registrationOnly, "journeys.myProducts", false);
    edit(registrationOnly, "navigation", ["settings"]);
    edit(registrationOnly, "home.primaryJourney", "registration");
    expect(
      problemOf(
        inputFor(registrationOnly, {
          appUrl: TIDEWELL_ORIGIN,
          faceApplications: JSON.stringify([tidewellBinding(), bindingInput()]),
        }),
      ),
    ).toBe("active");
  });
});

describe("release", () => {
  it("needs a semver config version, a content hash and a Studio version ref", () => {
    for (const [path, value] of [
      ["release.configVersion", "1.0"],
      ["release.configVersion", "v1.0.0"],
      ["release.approvedContentHash", "a".repeat(64)],
      ["release.studioVersionRef", ""],
      ["release.studioVersionRef", "has space"],
      ["release.studioVersionRef", "x".repeat(129)],
    ] as const) {
      const document = morrowWith(path, value);
      expect([
        path,
        value,
        problemOf(
          inputFor(
            document,
            {},
            { keepHash: path === "release.approvedContentHash" },
          ),
        ),
      ]).toEqual([path, value, "release"]);
    }
    expect(problemFor("release.configVersion", "1.2.3-rc.1")).toBe("active");
  });
});
